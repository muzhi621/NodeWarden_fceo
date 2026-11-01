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
//     pushed", not "the two sides now agree" (S1).
//   • Generated columns are skipped — MySQL rejects writes to them.
//   • One failing table does not abort the others; the per-table error is
//     returned to the admin.

import type { D1LikeStatement } from './storage-mysql';

/** The subset of a database handle this module needs — keeps it unit-testable. */
export interface SyncDatabase {
  prepare(sql: string): D1LikeStatement;
}

export interface TableSyncResult {
  table: string;
  columns: number;
  rowsRead: number;
  rowsWritten: number;
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
  error?: string;
}

export interface ClusterSyncResult {
  ok: boolean;
  /** Every table walked to the end and the counts agree. */
  complete: boolean;
  tables: TableSyncResult[];
  rowsRead: number;
  rowsWritten: number;
  truncated: boolean;
  durationMs: number;
  /** Resume cursors for tables that hit the row cap. */
  cursors: Record<string, Array<string | number | boolean | null>>;
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
  /** Compare row counts after each table (default true). */
  verifyCounts?: boolean;
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

/** Base tables in the connection's own schema. */
async function discoverTables(db: SyncDatabase): Promise<string[]> {
  const result = await db
    .prepare(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
    )
    .all<{ name: string }>();
  return (result.results ?? [])
    .map((row) => String(row.name ?? ''))
    .filter((name) => name.length > 0);
}

/**
 * Column names in ordinal order.
 *
 * Generated columns are excluded: they are computed by the server, and listing
 * them in an INSERT makes MySQL reject the statement.
 */
async function discoverColumns(db: SyncDatabase, table: string): Promise<string[]> {
  const result = await db
    .prepare(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS ' +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND (EXTRA IS NULL OR EXTRA NOT LIKE '%GENERATED%') " +
        'ORDER BY ORDINAL_POSITION'
    )
    .bind(table)
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
async function discoverPrimaryKey(db: SyncDatabase, table: string): Promise<string[]> {
  try {
    const result = await db
      .prepare(
        'SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE ' +
          "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' " +
          'ORDER BY ORDINAL_POSITION'
      )
      .bind(table)
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

  try {
    const columns = await discoverColumns(source, table);
    if (columns.length === 0) {
      result.error = 'no readable columns (table missing on the source?)';
      return result;
    }
    result.columns = columns.length;

    const keys = await discoverPrimaryKey(source, table);
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
  try {
    tables = options.tables ?? (await discoverTables(source));
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
    };
  }

  const results: TableSyncResult[] = [];
  for (const table of tables) {
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
    results.push(
      await syncTable(source, target, table, { ...options, deadline }, Date.now())
    );
  }

  const rowsRead = results.reduce((sum, entry) => sum + entry.rowsRead, 0);
  const rowsWritten = results.reduce((sum, entry) => sum + entry.rowsWritten, 0);
  const cursors: Record<string, Array<string | number | boolean | null>> = {};
  for (const entry of results) {
    if (entry.nextCursor) cursors[entry.table] = entry.nextCursor;
  }
  const ok = results.every((entry) => !entry.error);
  return {
    ok,
    complete: ok && results.every((entry) => !entry.truncated && entry.countMatches !== false),
    tables: results,
    rowsRead,
    rowsWritten,
    truncated: results.some((entry) => entry.truncated),
    durationMs: Date.now() - startedAt,
    cursors,
  };
}
