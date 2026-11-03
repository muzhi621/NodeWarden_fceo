// Copy rows from one node onto another (backfill / repair).
//
// Write-through replication only covers writes that happen *while the cluster is
// running*. Attaching a second database to a deployment that already holds data
// therefore leaves an empty standby — the day it takes over, every account is
// gone. This module is the backfill step: it walks the source table by table and
// replays the rows into the target, so it is idempotent and safe to re-run after
// an interrupted sync.
//
// Deliberate design points:
//   • Keyset pagination (`WHERE pk > (…) ORDER BY pk LIMIT n`), not
//     LIMIT/OFFSET. With OFFSET, a row deleted on the source while the copy is
//     running shifts every later page and one row is silently skipped (C-3).
//     Keyset also makes the position a *value*, so a run that hits the row cap
//     can resume exactly where it stopped instead of starting over (B-3).
//   • `INSERT ... ON DUPLICATE KEY UPDATE` (not TRUNCATE + INSERT): the target
//     may be serving reads in read-split mode, so it must never be empty.
//   • `mode: 'merge'` (the default) never overwrites an existing row: a sync
//     used to "repair" a standby that took over during an outage would otherwise
//     copy the *older* values from the stale primary back over the newer ones
//     (B-2). `mode: 'overwrite'` is the explicit repair path.
//   • Chunked with a row cap and a **shared** deadline: an admin request runs
//     inside a request timeout (EdgeOne: 120s), and `audit_logs` can be large.
//     The budget used to restart per table, so 19 tables × 45s could run for
//     fifteen minutes inside a 120s request (C-4).
//   • Row counts are compared afterwards, because `rowsWritten` only says "rows
//     pushed", not "the two sides now agree" (S1). In `merge` mode a pushed row
//     is usually one the target already had, so `rowsInserted` is measured from
//     the target's own count before/after instead of being inferred from the
//     upsert's affected rows (which `FOUND_ROWS` makes ambiguous).
//   • Generated columns are skipped — MySQL rejects writes to them.
//   • One failing table does not abort the others; the per-table error is
//     returned to the admin.
//   • Progress is reported, not imagined: `tablesTotal` / `tablesDone` are exact,
//     `rowsEstimate` comes from `information_schema.TABLES.TABLE_ROWS` and is
//     explicitly an estimate. A chunked run therefore hands the caller enough to
//     draw a bar without pretending it knows the exact row count of a table it
//     has not finished reading.
//   • `skipTables` lets a resumed run leave finished tables alone. Every call
//     used to re-walk every table from the first row — correct (the upsert is a
//     no-op on rows that already exist) but quadratic in the number of rounds,
//     which is exactly the case a progress bar is for.

import type { D1LikeStatement } from './storage-mysql';

/** The subset of a database handle this module needs — keeps it unit-testable. */
export interface SyncDatabase {
  prepare(sql: string): D1LikeStatement;
}

export interface TableSyncResult {
  table: string;
  columns: number;
  rowsRead: number;
  /**
   * Rows pushed to the target. In `merge` mode most of them are usually rows the
   * target already had (the statement is `ON DUPLICATE KEY UPDATE pk = pk`), so
   * this is "rows processed", not "rows added" — see `rowsInserted`.
   */
  rowsWritten: number;
  /**
   * Rows that were genuinely new on the target.
   *
   * Copied rows always go through one upsert, and MySQL reports "inserted" and
   * "duplicate, no change" as the same affected-row count once `FOUND_ROWS` is
   * set (which `storage-mysql` needs so D1's `meta.changes` stays right). The
   * only honest source is the target's own row count before and after, so this
   * is measured rather than derived — and only in `merge` mode, where the two
   * numbers actually differ. `undefined` means "not measured" (truncated table,
   * counts unavailable, or `overwrite` mode where every row is rewritten).
   */
  rowsInserted?: number;
  /** Stopped early because a row cap or the time budget was reached. */
  truncated: boolean;
  /** Last copied key; feed back as `cursors[table]` to continue (B-3). */
  nextCursor?: Array<string | number | boolean | null>;
  /** `keyset` is immune to concurrent deletes; `offset` is best-effort. */
  paging: 'keyset' | 'offset';
  /** Row counts on both sides once the table is fully walked (S1). */
  sourceRows?: number;
  targetRows?: number;
  countMatches?: boolean;
  /** Rows on the target that no longer exist on the source (S2). */
  orphanRows?: number;
  /**
   * Approximate source row count from `information_schema.TABLES.TABLE_ROWS`.
   * Only used to draw progress; undefined when the estimate is unavailable.
   */
  rowsEstimate?: number;
  error?: string;
}

export interface ClusterSyncResult {
  ok: boolean;
  /** Every table walked to the end and the counts agree. */
  complete: boolean;
  tables: TableSyncResult[];
  rowsRead: number;
  /** Rows pushed (see `TableSyncResult.rowsWritten`). */
  rowsWritten: number;
  /** Rows that were new on the target, when measured. */
  rowsInserted?: number;
  truncated: boolean;
  durationMs: number;
  /** Resume cursors for tables that hit the row cap. */
  cursors: Record<string, Array<string | number | boolean | null>>;
  /** Tables in scope for this run, including the ones skipped as already done. */
  tablesTotal: number;
  /** Tables walked to the end without an error, including skipped ones. */
  tablesDone: number;
  /** Sum of the per-table estimates; 0 when `information_schema` is unreadable. */
  rowsEstimate: number;
  /** Tables left alone because an earlier run of the same copy completed them. */
  skipped: string[];
  /** Tables that did not exist on the target and were created from the source DDL. */
  createdTables: string[];
}

export type SyncCopyMode = 'merge' | 'overwrite';

export interface SyncOptions {
  /** Rows per round trip. */
  chunkSize?: number;
  /** Stop after this many rows in one table (per call). */
  maxRowsPerTable?: number;
  /** Stop starting new chunks after this budget. */
  maxDurationMs?: number;
  /** Absolute deadline (epoch ms) shared by every table (C-4). */
  deadline?: number;
  /** Explicit table list; discovered from information_schema when omitted. */
  tables?: string[];
  /**
   * `merge` inserts missing rows only (never downgrades data);
   * `overwrite` replaces existing rows with the source's values.
   */
  mode?: SyncCopyMode;
  /** Cursor per table from a previous run, to resume. */
  cursors?: Record<string, unknown[]>;
  /**
   * Tables a previous chunked run already finished. They are not re-copied.
   *
   * Only safe for `merge` (the caller decides): a repair run has to rewrite
   * every row, so it passes nothing here.
   */
  skipTables?: string[];
  /** Compare row counts after each table (default true). */
  verifyCounts?: boolean;
  /**
   * Schema the source tables live in.
   *
   * Discovery used to ask `information_schema … WHERE TABLE_SCHEMA =
   * DATABASE()`. When the connection has no default database (an empty
   * database field on the node, or a driver that connected without one) that
   * predicate matches nothing, the table list comes back empty, and the run
   * reported success while copying zero rows — the "sync stuck at 0/?" case.
   * The caller knows the configured name, so pass it and let the query be
   * explicit; omitting it keeps the old `DATABASE()` behaviour.
   */
  sourceSchema?: string;
  /**
   * Schema the *target* tables live in, for the same reason as `sourceSchema`.
   *
   * Used by `createMissingTables`: a standby is a plain MySQL schema nothing else
   * ever maintains, so the tables the application creates lazily at runtime
   * (`rate_limit_buckets` is the one that bites) simply do not exist there, and
   * every copy of them fails with 1146 — see `createMissingTables`.
   */
  targetSchema?: string;
}

/**
 * `TABLE_SCHEMA` predicate plus its bind parameters.
 *
 * Kept as one helper so every `information_schema` lookup agrees on which
 * schema it is talking about.
 */
function schemaFilter(schema?: string): { sql: string; bind: string[] } {
  const name = (schema ?? '').trim();
  return name ? { sql: 'TABLE_SCHEMA = ?', bind: [name] } : { sql: 'TABLE_SCHEMA = DATABASE()', bind: [] };
}

/** Run a statement, binding only when there is something to bind. */
function bindAll(statement: D1LikeStatement, params: string[]): D1LikeStatement {
  return params.length > 0 ? statement.bind(...params) : statement;
}

export const SYNC_DEFAULTS = {
  chunkSize: 200,
  maxRowsPerTable: 20_000,
  maxDurationMs: 45_000,
} as const;

/** Smallest slice of the budget worth starting a round trip for. */
const MIN_BUDGET_MS = 250;

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** MySQL: ER_NET_PACKET_TOO_LARGE / 1153. */
function isPacketTooLarge(error: unknown): boolean {
  const errno = Number((error as { errno?: number })?.errno ?? 0);
  const code = String((error as { code?: string })?.code ?? '');
  if (errno === 1153 || code === 'ER_NET_PACKET_TOO_LARGE') return true;
  return /max_allowed_packet|Packet for query is too large/i.test(errorMessage(error));
}

/** Base tables in the connection's own schema (or the one the caller named). */
async function discoverTables(db: SyncDatabase, schema?: string): Promise<string[]> {
  const filter = schemaFilter(schema);
  const result = await bindAll(
    db.prepare(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES " +
        `WHERE ${filter.sql} AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`
    ),
    filter.bind
  ).all<{ name: string }>();
  return (result.results ?? [])
    .map((row) => String(row.name ?? ''))
    .filter((name) => name.length > 0);
}

/**
 * How many base tables a node's schema actually has.
 *
 * Used before a copy to tell "the standby was never created" from "the standby
 * is empty": the first needs a schema bootstrap, the second just needs rows.
 */
export async function countBaseTables(db: SyncDatabase, schema?: string): Promise<number | null> {
  try {
    const filter = schemaFilter(schema);
    const row = await bindAll(
      db.prepare(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE ${filter.sql} AND TABLE_TYPE = 'BASE TABLE'`
      ),
      filter.bind
    ).first<{ n: unknown }>();
    if (!row) return null;
    const value = Number(row.n);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * `SHOW CREATE TABLE` → the exact DDL the source uses, or null when unavailable.
 *
 * The column position is not fixed across servers (`Table` / `Create Table`), so
 * the statement is picked by shape rather than by index.
 */
async function readCreateTable(db: SyncDatabase, table: string): Promise<string | null> {
  try {
    const result = await db.prepare(`SHOW CREATE TABLE ${quoteIdent(table)}`).all<Record<string, unknown>>();
    const row = (result.results ?? [])[0];
    if (!row) return null;
    for (const value of Object.values(row)) {
      if (typeof value === 'string' && /^CREATE TABLE/i.test(value.trim())) return value.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export interface MissingTableFix {
  /** Tables created on the target from the source's own DDL. */
  created: string[];
  /** Tables that are missing *and* could not be created, with the reason. */
  failed: Array<{ table: string; error: string }>;
}

/**
 * Create, on the target, every table the source has and the target does not.
 *
 * This exists because a standby is not a database the application has ever run
 * against: the schema is whatever a `CREATE TABLE IF NOT EXISTS` bootstrap made
 * at the time it was attached, and the application also creates a few tables
 * *lazily* the first time it needs them (`rate_limit_buckets`). Those exist on
 * the primary because the app ran there; on the standby nobody ever runs, so the
 * table is absent forever, every copy of it answers `1146 Table doesn't exist`,
 * and the run ends "19/20 · 99%" every single time — the standby can never be
 * finished, and the one table it is missing is never mentioned.
 *
 * Building the table from the source's own DDL (rather than from this build's
 * idea of the schema) keeps the two sides in step even when the source has
 * columns a newer or older release does not know about. `IF NOT EXISTS` plus a
 * final `IF NOT EXISTS` in the statement make the whole step idempotent: the
 * common case costs one `information_schema` query and nothing else.
 */
export async function createMissingTables(
  source: SyncDatabase,
  target: SyncDatabase,
  tables: string[],
  schemas: { sourceSchema?: string; targetSchema?: string } = {}
): Promise<MissingTableFix> {
  let targetTables: string[];
  try {
    targetTables = await discoverTables(target, schemas.targetSchema);
  } catch (error) {
    // Cannot tell what is there, so do not guess: the copy itself will report the
    // per-table failure, which is more useful than a blind `CREATE`.
    return { created: [], failed: [] };
  }
  const present = new Set(targetTables);
  const missing = tables.filter((table) => !present.has(table));
  if (missing.length === 0) return { created: [], failed: [] };

  const created: string[] = [];
  const failed: Array<{ table: string; error: string }> = [];
  for (const table of missing) {
    const ddl = await readCreateTable(source, table);
    if (!ddl) {
      failed.push({ table, error: '主库没有返回该表的建表语句（SHOW CREATE TABLE 失败），无法在副库自动建表。' });
      continue;
    }
    const statement = ddl.replace(/^CREATE\s+TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ');
    try {
      await target.prepare(statement).run();
      created.push(table);
    } catch (error) {
      failed.push({ table, error: errorMessage(error) });
    }
  }
  return { created, failed };
}

/**
 * Column names in ordinal order.
 *
 * Generated columns are excluded: they are computed by the server, and listing
 * them in an INSERT makes MySQL reject the statement.
 */
async function discoverColumns(db: SyncDatabase, table: string, schema?: string): Promise<string[]> {
  const filter = schemaFilter(schema);
  const result = await db
    .prepare(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS ' +
        `WHERE ${filter.sql} AND TABLE_NAME = ? AND (EXTRA IS NULL OR EXTRA NOT LIKE '%GENERATED%') ` +
        'ORDER BY ORDINAL_POSITION'
    )
    .bind(...filter.bind, table)
    .all<{ name: string }>();
  return (result.results ?? []).map((row) => String(row.name ?? '')).filter((name) => name.length > 0);
}

/**
 * Primary key columns, in key order.
 *
 * Empty means the table has no primary key: paging falls back to OFFSET, which
 * still copies everything but can miss a row if the source is being written to
 * during the copy.
 */
async function discoverPrimaryKey(db: SyncDatabase, table: string, schema?: string): Promise<string[]> {
  try {
    const filter = schemaFilter(schema);
    const result = await db
      .prepare(
        'SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE ' +
          `WHERE ${filter.sql} AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ` +
          'ORDER BY ORDINAL_POSITION'
      )
      .bind(...filter.bind, table)
      .all<{ name: string }>();
    return (result.results ?? []).map((row) => String(row.name ?? '')).filter((name) => name.length > 0);
  } catch {
    // information_schema may be restricted; OFFSET paging still works.
    return [];
  }
}

function buildUpsertSql(table: string, columns: string[], rowCount: number, mode: SyncCopyMode): string {
  const columnList = columns.map(quoteIdent).join(', ');
  const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;
  const values = Array.from({ length: rowCount }, () => rowPlaceholder).join(', ');
  // `col = VALUES(col)` keeps working on MySQL 5.7/8.x and TiDB. The 8.0.20
  // deprecation warning is harmless; the alias form would break older servers.
  const updates =
    mode === 'overwrite'
      ? columns.map((column) => `${quoteIdent(column)} = VALUES(${quoteIdent(column)})`).join(', ')
      : // No-op update: keeps the existing row untouched. `col = col` is valid in
        // ON DUPLICATE KEY UPDATE and refers to the stored value.
        `${quoteIdent(columns[0])} = ${quoteIdent(columns[0])}`;
  return `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES ${values} ON DUPLICATE KEY UPDATE ${updates}`;
}

function isCursorScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

async function countRows(db: SyncDatabase, table: string): Promise<number | null> {
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).first<{ n: unknown }>();
    if (!row) return null;
    const value = Number(row.n);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Approximate row count per table, straight from `information_schema`.
 *
 * `TABLE_ROWS` is what the optimiser believes; for InnoDB it is an estimate that
 * can be off by tens of percent and is 0 for a table that was never analysed.
 * That is fine for a progress bar and useless for verification, which is why the
 * exact counts in `sourceRows` / `targetRows` stay separate. Returns an empty
 * record when the schema is unreadable — callers fall back to table counts.
 */
async function readTableEstimates(db: SyncDatabase, schema?: string): Promise<Record<string, number>> {
  try {
    const filter = schemaFilter(schema);
    const result = await bindAll(
      db.prepare(
        'SELECT TABLE_NAME AS name, TABLE_ROWS AS row_count FROM information_schema.TABLES ' +
          `WHERE ${filter.sql} AND TABLE_TYPE = 'BASE TABLE'`
      ),
      filter.bind
    ).all<{ name: string; row_count: unknown }>();
    const estimates: Record<string, number> = {};
    for (const row of result.results ?? []) {
      const name = String(row.name ?? '');
      const value = Number(row.row_count);
      if (name && Number.isFinite(value) && value > 0) estimates[name] = value;
    }
    return estimates;
  } catch {
    return {};
  }
}

/** One table, chunk by chunk. */
export async function syncTable(
  source: SyncDatabase,
  target: SyncDatabase,
  table: string,
  options: SyncOptions = {},
  startedAt = Date.now()
): Promise<TableSyncResult> {
  const chunkSize = Math.max(1, options.chunkSize ?? SYNC_DEFAULTS.chunkSize);
  const maxRows = Math.max(1, options.maxRowsPerTable ?? SYNC_DEFAULTS.maxRowsPerTable);
  const requestedMs = Math.max(MIN_BUDGET_MS, options.maxDurationMs ?? SYNC_DEFAULTS.maxDurationMs);
  const budgetEnd = Math.min(startedAt + requestedMs, options.deadline ?? Number.POSITIVE_INFINITY);
  const mode: SyncCopyMode = options.mode === 'overwrite' ? 'overwrite' : 'merge';
  const verifyCounts = options.verifyCounts !== false;

  const result: TableSyncResult = {
    table,
    columns: 0,
    rowsRead: 0,
    rowsWritten: 0,
    truncated: false,
    paging: 'keyset',
  };

  // Baseline for `rowsInserted`. Only `merge` needs it: `overwrite` rewrites
  // every row it touches, so `rowsWritten` is already the number of rows changed.
  let targetRowsBefore: number | null = null;

  try {
    const columns = await discoverColumns(source, table, options.sourceSchema);
    if (columns.length === 0) {
      result.error = `no readable columns (table missing on the source${options.sourceSchema ? ` ${options.sourceSchema}` : ''}?)`;
      return result;
    }
    result.columns = columns.length;

    const keys = await discoverPrimaryKey(source, table, options.sourceSchema);
    if (keys.length === 0) result.paging = 'offset';

    const selectList = columns.map(quoteIdent).join(', ');
    const keyList = keys.map(quoteIdent).join(', ');
    const keyParams = keys.map(() => '?').join(', ');

    const savedCursor = options.cursors?.[table];
    let cursor: unknown[] | null = null;
    let offset = 0;
    if (Array.isArray(savedCursor) && savedCursor.length > 0) {
      if (result.paging === 'keyset' && savedCursor.length === keys.length) cursor = savedCursor;
      else if (result.paging === 'offset') offset = Number(savedCursor[0]) || 0;
    }

    let limit = Math.min(chunkSize, maxRows);
    let cursorOut: Array<string | number | boolean | null> | undefined;
    // Taken before the first chunk: the delta is the only way to tell "inserted"
    // from "already there" (see `rowsInserted`).
    if (mode === 'merge' && verifyCounts) {
      targetRowsBefore = await countRows(target, table);
    }
    for (;;) {
      if (result.rowsRead >= maxRows) {
        result.truncated = true;
        break;
      }
      if (Date.now() > budgetEnd) {
        result.truncated = true;
        break;
      }
      limit = Math.max(1, Math.min(limit, chunkSize, maxRows - result.rowsRead));

      const where = cursor ? `WHERE (${keyList}) > (${keyParams})` : '';
      const orderBy = result.paging === 'keyset' ? `ORDER BY ${keyList}` : 'ORDER BY 1';
      const tail = result.paging === 'offset' ? ` OFFSET ${offset}` : '';
      // LIMIT/OFFSET are inlined integers, not parameters: they come from our
      // own arithmetic, and older MySQL protocol paths do not accept bound
      // placeholders in LIMIT.
      const statement = source.prepare(
        `SELECT ${selectList} FROM ${quoteIdent(table)}${where ? ` ${where}` : ''} ${orderBy} LIMIT ${limit}${tail}`
      );
      if (where) statement.bind(...(cursor as unknown[]));
      const rows = await statement.all<Record<string, unknown>>();
      const batch = rows.results ?? [];
      if (batch.length === 0) break;

      const params: unknown[] = [];
      for (const row of batch) {
        for (const column of columns) params.push(row[column] ?? null);
      }

      try {
        await target.prepare(buildUpsertSql(table, columns, batch.length, mode)).bind(...params).run();
      } catch (error) {
        // A chunk of LONGTEXT rows can exceed max_allowed_packet. Halving the
        // window and retrying the same position beats failing the whole table.
        if (isPacketTooLarge(error) && limit > 1) {
          limit = Math.max(1, Math.floor(limit / 2));
          continue;
        }
        throw error;
      }

      result.rowsRead += batch.length;
      result.rowsWritten += batch.length;

      if (result.paging === 'keyset') {
        const last = batch[batch.length - 1];
        const next = keys.map((key) => last[key] ?? null);
        // In-memory paging always works; a cursor is only *persistable* when its
        // values are scalars (a Date would come back from JSON as a different
        // string and the comparison would skip rows).
        cursor = next;
        cursorOut = next.every(isCursorScalar) ? next : undefined;
      } else {
        offset += batch.length;
        cursorOut = [offset];
      }

      if (batch.length < limit) break;
    }

    // Only a cut-short table leaves a resume point: reporting one for a finished
    // table would make the caller pass a cursor that means nothing.
    if (result.truncated) result.nextCursor = cursorOut;

    if (!result.truncated && verifyCounts) {
      const sourceRows = await countRows(source, table);
      const targetRows = await countRows(target, table);
      if (sourceRows !== null) result.sourceRows = sourceRows;
      if (targetRows !== null) result.targetRows = targetRows;
      if (sourceRows !== null && targetRows !== null) {
        result.countMatches = sourceRows === targetRows;
        // Extra rows on the target are never deleted by an upsert copy (S2):
        // report them so the operator can reconcile instead of assuming parity.
        if (targetRows > sourceRows) result.orphanRows = targetRows - sourceRows;
      }
      if (mode === 'merge' && targetRowsBefore !== null && targetRows !== null) {
        // Concurrent writes on the target can skew this by a row or two; it is a
        // magnitude, not an audit number. Negative is clamped because a delete
        // on the target between the two counts is not "minus 3 inserts".
        result.rowsInserted = Math.max(0, targetRows - targetRowsBefore);
      }
    }
    return result;
  } catch (error) {
    result.error = errorMessage(error);
    return result;
  }
}

/**
 * Copy every table from `source` into `target`.
 *
 * Never throws for a table-level failure: the caller reports per-table results
 * so one unreadable table does not hide the twenty that succeeded.
 */
export async function syncDatabase(
  source: SyncDatabase,
  target: SyncDatabase,
  options: SyncOptions = {}
): Promise<ClusterSyncResult> {
  const startedAt = Date.now();
  const requestedMs = Math.max(MIN_BUDGET_MS, options.maxDurationMs ?? SYNC_DEFAULTS.maxDurationMs);
  // One budget for the whole call: `syncTable` used to restart its clock per
  // table, so the caller's deadline meant nothing (C-4).
  const deadline = Math.min(startedAt + requestedMs, options.deadline ?? Number.POSITIVE_INFINITY);

  let tables: string[];
  let estimates: Record<string, number>;
  try {
    tables = options.tables ?? (await discoverTables(source, options.sourceSchema));
    estimates = await readTableEstimates(source, options.sourceSchema);
  } catch (error) {
    return {
      ok: false,
      complete: false,
      tables: [
        {
          table: '*',
          columns: 0,
          rowsRead: 0,
          rowsWritten: 0,
          truncated: false,
          paging: 'keyset',
          error: errorMessage(error),
        },
      ],
      rowsRead: 0,
      rowsWritten: 0,
      truncated: false,
      durationMs: Date.now() - startedAt,
      cursors: {},
      tablesTotal: 0,
      tablesDone: 0,
      rowsEstimate: 0,
      skipped: [],
      createdTables: [],
    };
  }

  // An empty table list is not a completed sync. It used to fall through to the
  // loop below, where "every table succeeded" is vacuously true for zero
  // tables: the run reported `ok`/`complete` with 0 rows while the UI sat at
  // "数据表 0/?" forever. Whatever the cause (wrong schema name, a standby
  // picked as the source, a schema with no tables yet), say it out loud.
  if (tables.length === 0) {
    const label = options.sourceSchema ? `源库「${options.sourceSchema}」` : '源库';
    return {
      ok: false,
      complete: false,
      tables: [
        {
          table: '*',
          columns: 0,
          rowsRead: 0,
          rowsWritten: 0,
          truncated: false,
          paging: 'keyset',
          error:
            `${label}里没有任何基础表（Base Table），没有可复制的内容：` +
            '请确认节点配置里的库名是否正确、该库是否已经建表。副库为空时，先在后台保存一次集群配置让系统建表。',
        },
      ],
      rowsRead: 0,
      rowsWritten: 0,
      truncated: false,
      durationMs: Date.now() - startedAt,
      cursors: {},
      tablesTotal: 0,
      tablesDone: 0,
      rowsEstimate: 0,
      skipped: [],
      createdTables: [],
    };
  }
  // Tables a previous round already finished. Skipping them keeps a chunked run
  // linear: without this every round re-reads every table from its first row,
  // which is both slow and makes a progress bar meaningless (it would restart).
  const skip = new Set(options.skipTables ?? []);
  const skipped = tables.filter((table) => skip.has(table));
  const pending = tables.filter((table) => !skip.has(table));

  // Before copying anything: a table the standby does not have cannot be written
  // to, and the run would end on a per-table 1146 that reads like a data problem.
  // Checked even for skipped tables — the list is what the *run* is meant to
  // cover, and a missing table is missing whether or not its rows were copied in
  // an earlier slice.
  const schemaFix = await createMissingTables(source, target, tables, {
    sourceSchema: options.sourceSchema,
    targetSchema: options.targetSchema,
  });
  // A table whose creation failed is still attempted: the copy either works
  // anyway (the table exists with a different definition) or it reports its own,
  // more specific error. The DDL failure is appended to that error instead of
  // replacing it, so the operator sees both halves of the story.
  const createError = new Map(schemaFix.failed.map((entry) => [entry.table, entry.error]));

  const results: TableSyncResult[] = [];
  for (const table of pending) {
    if (Date.now() >= deadline) {
      // Out of budget before this table started: leave it pending rather than
      // opening a round trip that the platform will kill mid-flight.
      results.push({
        table,
        columns: 0,
        rowsRead: 0,
        rowsWritten: 0,
        truncated: true,
        paging: 'keyset',
      });
      continue;
    }
    const tableResult = await syncTable(source, target, table, { ...options, deadline }, Date.now());
    const estimate = estimates[table];
    if (estimate !== undefined) tableResult.rowsEstimate = estimate;
    const ddlError = createError.get(table);
    // Only when the copy failed too: if the rows landed, the table was there
    // after all (a `CREATE` denied by privileges on an existing table) and the
    // run must not be reported as broken.
    if (ddlError && tableResult.error) {
      tableResult.error = `${tableResult.error}；副库缺少该表且自动建表失败：${ddlError}`;
    }
    results.push(tableResult);
  }

  const rowsRead = results.reduce((sum, entry) => sum + entry.rowsRead, 0);
  const rowsWritten = results.reduce((sum, entry) => sum + entry.rowsWritten, 0);
  const measured = results.filter((entry) => entry.rowsInserted !== undefined);
  const rowsInserted = measured.length > 0 ? measured.reduce((sum, entry) => sum + (entry.rowsInserted ?? 0), 0) : undefined;
  const cursors: Record<string, Array<string | number | boolean | null>> = {};
  for (const entry of results) {
    if (entry.nextCursor) cursors[entry.table] = entry.nextCursor;
  }
  const ok = results.every((entry) => !entry.error);
  // A skipped table was verified by the round that finished it, so it counts as
  // done here; re-verifying it would defeat the point of skipping.
  const tablesDone = skipped.length + results.filter((entry) => !entry.truncated && !entry.error).length;
  const rowsEstimate = tables.reduce((sum, table) => sum + (estimates[table] ?? 0), 0);
  // "Every table was walked to the end, and every row we pushed is there."
  //
  // It is deliberately *not* "the two sides have the same number of rows". That
  // was the old rule, and against a live source it is unattainable: this run
  // itself writes an audit row on the primary the moment it finishes, and any
  // sign-in during the copy adds more, so a run that had genuinely finished
  // reported `complete: false` forever and the page sat at 99% with 20/20
  // tables. Parity is still measured and reported per table (`countMatches`,
  // `sourceRows`, `targetRows`).
  //
  // What *is* a failure is the opposite gap: the target holding fewer rows than
  // were pushed to it — that is a silently dropped write, not a source that kept
  // growing, and it must keep the run unfinished.
  const droppedRows = results.filter(
    (entry) =>
      !entry.truncated &&
      !entry.error &&
      entry.targetRows !== undefined &&
      entry.targetRows < entry.rowsWritten
  );
  const complete = ok && results.every((entry) => !entry.truncated) && droppedRows.length === 0;
  return {
    ok,
    complete,
    tables: results,
    rowsRead,
    rowsWritten,
    rowsInserted,
    truncated: results.some((entry) => entry.truncated),
    durationMs: Date.now() - startedAt,
    cursors,
    tablesTotal: tables.length,
    tablesDone,
    rowsEstimate,
    skipped,
    createdTables: schemaFix.created,
  };
}

/** What a previous store-backed run left behind, as far as resuming cares. */
export interface SyncResumeSource {
  doneTables?: string[];
  cursors?: Record<string, Array<string | number | boolean | null>>;
}

/** The resume point after one slice, plus what is still outstanding. */
export interface SyncResumeState {
  /** Tables the run has finished; fed back as `skipTables`. */
  doneTables?: string[];
  /** Positions to continue from; fed back as `cursors`. */
  cursors?: Record<string, Array<string | number | boolean | null>>;
  /** Tables this slice did not reach (out of budget). */
  pendingTables: string[];
  /** Tables that raised an error, with the reason. */
  failedTables: Array<{ table: string; error: string }>;
}

/**
 * Advance the resume point of a chunked sync run by one slice.
 *
 * This was inlined in the admin handler, and two bugs lived in it:
 *
 *   • `doneTables` was recorded for `merge` only. A repair (`overwrite`) run
 *     therefore forgot everything it had copied: each slice re-read the first N
 *     tables from the top, ran out of budget on table N+1, and stopped at the
 *     same place — "数据表 19/20" forever, at 99%, because the row-based
 *     fraction was already maxed out by the repeated copies.
 *   • `cursors` were *replaced* by the slice's own map. A table that the slice
 *     did not reach has no cursor of its own, so writing that (near-empty) map
 *     over the stored one discarded the position an earlier slice had reached,
 *     and the table restarted from its first row on the next click.
 *
 * Both are only visible across slices, which is exactly why this belongs in a
 * function with a test rather than three inline `const`s.
 *
 * `previous` must be `null` when the caller is deliberately not resuming (a
 * different source, a different copy mode, or an explicit restart): its cursors
 * describe a key space the new run is not walking.
 */
export function advanceSyncResume(input: {
  previous?: SyncResumeSource | null;
  result: ClusterSyncResult;
  /** The whole run finished; nothing needs to be resumed. */
  complete: boolean;
  /** Tables this slice was told to leave alone. */
  skipTables?: string[];
}): SyncResumeState {
  const { result, complete } = input;
  const previous = input.previous ?? null;
  const finishedNow = result.tables
    .filter((table) => !table.truncated && !table.error)
    .map((table) => table.table);

  const doneTables = complete
    ? undefined
    : [...new Set([...(previous?.doneTables ?? []), ...finishedNow])];

  const cursors: Record<string, Array<string | number | boolean | null>> = {
    ...(previous?.cursors ?? {}),
    ...result.cursors,
  };
  // A finished table's position means nothing (the caller must start from the
  // top if it ever copies that table again), and a skipped table's cursor is
  // stale by definition.
  for (const table of [...finishedNow, ...(input.skipTables ?? [])]) delete cursors[table];

  return {
    doneTables,
    cursors: complete || Object.keys(cursors).length === 0 ? undefined : cursors,
    pendingTables: result.tables.filter((table) => table.truncated).map((table) => table.table),
    failedTables: result.tables
      .filter((table) => !!table.error)
      .map((table) => ({ table: table.table, error: table.error as string })),
  };
}
