// Copy the primary's rows onto a standby node.
//
// Write-through replication only covers writes that happen *while the cluster is
// running*. Attaching a second database to a deployment that already holds data
// therefore leaves an empty standby — the day it takes over, every account is
// gone. This module is the backfill step: it walks the primary table by table
// and replays the rows into the target with an upsert, so it is idempotent and
// safe to re-run after an interrupted sync.
//
// Deliberate design points:
//   • `INSERT ... ON DUPLICATE KEY UPDATE` (not TRUNCATE + INSERT): the target
//     may be serving reads in read-split mode, so it must never be empty.
//   • Chunked with a row cap and a time budget: an admin request runs inside a
//     request timeout (EdgeOne: 120s), and `audit_logs` can be large. Hitting a
//     cap reports `truncated` instead of failing the whole operation.
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
  error?: string;
}

export interface ClusterSyncResult {
  ok: boolean;
  tables: TableSyncResult[];
  rowsRead: number;
  rowsWritten: number;
  truncated: boolean;
  durationMs: number;
}

export interface SyncOptions {
  /** Rows per round trip. */
  chunkSize?: number;
  /** Stop after this many rows in one table. */
  maxRowsPerTable?: number;
  /** Stop starting new chunks after this budget. */
  maxDurationMs?: number;
  /** Explicit table list; discovered from information_schema when omitted. */
  tables?: string[];
}

export const SYNC_DEFAULTS = {
  chunkSize: 200,
  maxRowsPerTable: 20_000,
  maxDurationMs: 45_000,
} as const;

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function buildUpsertSql(table: string, columns: string[], rowCount: number): string {
  const columnList = columns.map(quoteIdent).join(', ');
  const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;
  const values = Array.from({ length: rowCount }, () => rowPlaceholder).join(', ');
  // `col = VALUES(col)` keeps working on MySQL 5.7/8.x and TiDB. The 8.0.20
  // deprecation warning is harmless; the alias form would break older servers.
  const updates = columns.map((column) => `${quoteIdent(column)} = VALUES(${quoteIdent(column)})`).join(', ');
  return `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES ${values} ON DUPLICATE KEY UPDATE ${updates}`;
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
  const maxDurationMs = Math.max(1_000, options.maxDurationMs ?? SYNC_DEFAULTS.maxDurationMs);

  const result: TableSyncResult = { table, columns: 0, rowsRead: 0, rowsWritten: 0, truncated: false };

  try {
    const columns = await discoverColumns(source, table);
    if (columns.length === 0) {
      result.error = 'no readable columns (table missing on the source?)';
      return result;
    }
    result.columns = columns.length;

    const selectList = columns.map(quoteIdent).join(', ');
    let offset = 0;
    for (;;) {
      if (result.rowsRead >= maxRows) {
        result.truncated = true;
        return result;
      }
      if (Date.now() - startedAt > maxDurationMs) {
        result.truncated = true;
        return result;
      }
      const limit = Math.min(chunkSize, maxRows - result.rowsRead);
      // LIMIT/OFFSET are inlined integers, not parameters: they come from our
      // own arithmetic, and older MySQL protocol paths do not accept bound
      // placeholders in LIMIT.
      const rows = await source
        .prepare(`SELECT ${selectList} FROM ${quoteIdent(table)} ORDER BY 1 LIMIT ${limit} OFFSET ${offset}`)
        .all<Record<string, unknown>>();
      const batch = rows.results ?? [];
      if (batch.length === 0) return result;

      const params: unknown[] = [];
      for (const row of batch) {
        for (const column of columns) params.push(row[column] ?? null);
      }
      await target.prepare(buildUpsertSql(table, columns, batch.length)).bind(...params).run();

      result.rowsRead += batch.length;
      result.rowsWritten += batch.length;
      offset += batch.length;
      if (batch.length < limit) return result;
    }
  } catch (error) {
    result.error = errorMessage(error);
    return result;
  }
}

/**
 * Copy every table from `source` (the primary) into `target` (a standby).
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
  let tables: string[];
  try {
    tables = options.tables ?? (await discoverTables(source));
  } catch (error) {
    return {
      ok: false,
      tables: [{ table: '*', columns: 0, rowsRead: 0, rowsWritten: 0, truncated: false, error: errorMessage(error) }],
      rowsRead: 0,
      rowsWritten: 0,
      truncated: false,
      durationMs: Date.now() - startedAt,
    };
  }

  const results: TableSyncResult[] = [];
  for (const table of tables) {
    // Each table gets its own budget so a huge table cannot starve the rest.
    results.push(await syncTable(source, target, table, options, Date.now()));
  }

  const rowsRead = results.reduce((sum, entry) => sum + entry.rowsRead, 0);
  const rowsWritten = results.reduce((sum, entry) => sum + entry.rowsWritten, 0);
  return {
    ok: results.every((entry) => !entry.error),
    tables: results,
    rowsRead,
    rowsWritten,
    truncated: results.some((entry) => entry.truncated),
    durationMs: Date.now() - startedAt,
  };
}
