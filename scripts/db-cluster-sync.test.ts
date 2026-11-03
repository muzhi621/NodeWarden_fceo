import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceSyncResume,
  countBaseTables,
  syncDatabase,
  syncTable,
  type ClusterSyncResult,
  type SyncDatabase,
  type SyncResumeSource,
} from '../src/services/db-cluster-sync';
import type { D1LikeResult, D1LikeStatement } from '../src/services/storage-mysql';

/**
 * Minimal stand-in for a MySQL node.
 *
 * It answers the shapes the sync service issues (information_schema tables /
 * columns / primary keys, keyset- or offset-paged SELECTs, COUNT) and records
 * the INSERTs, which is enough to assert paging, chunking, batching and the
 * upsert shape without a server.
 */
class FakeNode implements SyncDatabase {
  readonly inserts: Array<{ sql: string; params: unknown[] }> = [];
  readonly selects: string[] = [];
  failOnTable?: string;
  /** When false the inserts are recorded but not applied (count stays 0). */
  applyInserts = true;
  /** Runs once after the first data page is read (simulates concurrent writes). */
  afterFirstPage?: (node: FakeNode) => void;
  private pages = 0;

  readonly primaryKeys: Record<string, string[]>;

  /** `information_schema.TABLES.TABLE_ROWS`: undefined means "not available". */
  readonly estimates?: Record<string, number>;

  /**
   * Artificial round-trip delay per statement.
   *
   * A real node across the internet answers in ~100ms, and a slice copies
   * roughly six statements per table — so a 12s budget runs out part-way through
   * a 20-table schema. That is what made the "19/20" case reproducible at all.
   */
  latencyMs = 0;

  private async tick(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }

  constructor(
    readonly tables: string[],
    readonly columns: Record<string, string[]>,
    readonly rows: Record<string, Array<Record<string, unknown>>> = {},
    primaryKeys: Record<string, string[]> = {},
    estimates?: Record<string, number>
  ) {
    this.primaryKeys = {
      ...Object.fromEntries(
        Object.entries(columns).map(([table, cols]) => [table, cols.length > 0 ? [cols[0]] : []])
      ),
      ...primaryKeys,
    };
    this.estimates = estimates;
  }

  prepare(sql: string): D1LikeStatement {
    return new FakeStatement(sql, this);
  }

  nextPage(): number {
    this.pages += 1;
    return this.pages;
  }
}

class FakeStatement implements D1LikeStatement {
  private params: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly node: FakeNode
  ) {}

  bind(...params: unknown[]): D1LikeStatement {
    this.params = params;
    return this;
  }

  async run(): Promise<D1LikeResult> {
    await this.node.tick();
    const table = /INSERT INTO `([^`]+)`/.exec(this.sql)?.[1] ?? '';
    if (this.node.failOnTable === table) throw new Error('ER_NO_SUCH_TABLE');
    this.node.inserts.push({ sql: this.sql, params: this.params });
    if (this.node.applyInserts) this.apply();
    return { results: [], success: true, meta: { changes: 1, duration: 0 } } as D1LikeResult;
  }

  /** Apply the upsert to the in-memory rows so COUNT() reflects the copy. */
  private apply(): void {
    const match = /^INSERT INTO `([^`]+)` \(([^)]+)\) VALUES/.exec(this.sql);
    if (!match) return;
    const [, table, columnList] = match;
    const columns = columnList.split(',').map((entry) => entry.trim().replace(/`/g, ''));
    if (columns.length === 0) return;
    const list = this.node.rows[table] ?? (this.node.rows[table] = []);
    const key = this.node.primaryKeys[table]?.[0];
    for (let index = 0; index + columns.length <= this.params.length; index += columns.length) {
      const row: Record<string, unknown> = {};
      columns.forEach((column, offset) => {
        row[column] = this.params[index + offset];
      });
      const existing = key ? list.findIndex((entry) => String(entry[key]) === String(row[key])) : -1;
      if (existing >= 0) list[existing] = { ...list[existing], ...row };
      else list.push(row);
    }
  }

  async all<R = Record<string, unknown>>(): Promise<D1LikeResult<R>> {
    await this.node.tick();
    const sql = this.sql;
    const asResult = (rows: unknown[]): D1LikeResult<R> =>
      ({ results: rows as R[], success: true, meta: { changes: 0, last_row_id: 0 } }) as D1LikeResult<R>;

    if (sql.includes('information_schema.TABLES') && sql.includes('COUNT(*)')) {
      return asResult([{ n: this.node.tables.length }]);
    }
    if (sql.includes('information_schema.TABLES')) {
      return asResult(
        this.node.tables.map((name) => ({
          name,
          row_count: this.node.estimates?.[name],
        }))
      );
    }
    if (sql.includes('information_schema.COLUMNS')) {
      const table = String(this.params[this.params.length - 1] ?? '');
      return asResult((this.node.columns[table] ?? []).map((name) => ({ name })));
    }
    if (sql.includes('information_schema.KEY_COLUMN_USAGE')) {
      const table = String(this.params[this.params.length - 1] ?? '');
      return asResult((this.node.primaryKeys[table] ?? []).map((name) => ({ name })));
    }
    if (sql.includes('COUNT(*)')) {
      const table = /FROM `([^`]+)`/.exec(sql)?.[1] ?? '';
      return asResult([{ n: (this.node.rows[table] ?? []).length }]);
    }

    const table = /FROM `([^`]+)`/.exec(sql)?.[1] ?? '';
    if (this.node.failOnTable === table) throw new Error('ER_NO_SUCH_TABLE');
    this.node.selects.push(sql);

    let list = [...(this.node.rows[table] ?? [])];
    const keyset = /WHERE \(`([^`]+)`\) > \(\?\)/.exec(sql);
    if (keyset) {
      const key = keyset[1];
      const cursor = this.params[0];
      list = list.filter((row) => String(row[key]) > String(cursor));
    }
    const offset = /OFFSET (\d+)/.exec(sql);
    if (offset) list = list.slice(Number(offset[1]));
    const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 0);
    const page = list.slice(0, limit);

    if (this.node.nextPage() === 1 && this.node.afterFirstPage) this.node.afterFirstPage(this.node);
    return asResult(page);
  }

  async first<R = Record<string, unknown>>(): Promise<R | null> {
    const page = await this.all<R>();
    return page.results[0] ?? null;
  }
}

function sourceNode(): FakeNode {
  return new FakeNode(
    ['users', 'ciphers'],
    { users: ['id', 'email'], ciphers: ['id', 'user_id'] },
    {
      users: [
        { id: 'u1', email: 'a@example.com' },
        { id: 'u2', email: 'b@example.com' },
        { id: 'u3', email: 'c@example.com' },
        { id: 'u4', email: 'd@example.com' },
        { id: 'u5', email: 'e@example.com' },
      ],
      ciphers: [{ id: 'c1', user_id: 'u1' }],
    }
  );
}

test('copies every table from the primary into the standby', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  const result = await syncDatabase(source, target, { chunkSize: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.rowsRead, 6);
  assert.equal(result.rowsWritten, 6);
  assert.deepEqual(
    result.tables.map((table) => table.table),
    ['users', 'ciphers']
  );
  // Five user rows at two per round trip: 2 + 2 + 1.
  assert.equal(target.inserts.length, 4);
});

test('merge mode never overwrites an existing row', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  await syncDatabase(source, target, { chunkSize: 10 });

  const insert = target.inserts[0].sql;
  assert.match(insert, /^INSERT INTO `users` \(`id`, `email`\) VALUES \(\?, \?\)/);
  // B-2: copying from a stale node must not downgrade newer values.
  assert.match(insert, /ON DUPLICATE KEY UPDATE `id` = `id`$/);
  assert.deepEqual(target.inserts[0].params, [
    'u1',
    'a@example.com',
    'u2',
    'b@example.com',
    'u3',
    'c@example.com',
    'u4',
    'd@example.com',
    'u5',
    'e@example.com',
  ]);
});

test('overwrite mode replaces existing rows', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  await syncDatabase(source, target, { chunkSize: 10, mode: 'overwrite', tables: ['users'] });

  assert.match(target.inserts[0].sql, /ON DUPLICATE KEY UPDATE `id` = VALUES\(`id`\), `email` = VALUES\(`email`\)$/);
});

test('pages by primary key instead of LIMIT/OFFSET', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  await syncTable(source, target, 'users', { chunkSize: 3 });

  assert.deepEqual(source.selects, [
    'SELECT `id`, `email` FROM `users` ORDER BY `id` LIMIT 3',
    'SELECT `id`, `email` FROM `users` WHERE (`id`) > (?) ORDER BY `id` LIMIT 3',
  ]);
});

test('B-3: a table bigger than the row cap continues from the cursor', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  const first = await syncTable(source, target, 'users', { chunkSize: 2, maxRowsPerTable: 2 });
  assert.equal(first.truncated, true);
  assert.equal(first.rowsWritten, 2);
  assert.deepEqual(first.nextCursor, ['u2']);

  const second = await syncTable(source, target, 'users', {
    chunkSize: 2,
    maxRowsPerTable: 2,
    cursors: { users: first.nextCursor },
  });
  assert.deepEqual(second.nextCursor, ['u4']);

  const third = await syncTable(source, target, 'users', {
    chunkSize: 2,
    maxRowsPerTable: 2,
    cursors: { users: second.nextCursor },
  });
  assert.equal(third.truncated, false, 'the last page ends the table');
  assert.equal(third.nextCursor, undefined);

  const copied = target.inserts.flatMap((entry) => entry.params.filter((_, index) => index % 2 === 0));
  assert.deepEqual(copied, ['u1', 'u2', 'u3', 'u4', 'u5'], 'every row is copied exactly once across runs');
});

test('C-3: a row deleted on the source mid-copy does not shift the next page', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});
  // Delete u1 right after the first page (u1,u2) was read. With OFFSET the second
  // page would start at 2 and skip u3.
  source.afterFirstPage = (node) => {
    node.rows.users = node.rows.users.filter((row) => row.id !== 'u1');
  };

  const result = await syncTable(source, target, 'users', { chunkSize: 2 });

  const copied = target.inserts.flatMap((entry) => entry.params.filter((_, index) => index % 2 === 0));
  assert.deepEqual(copied, ['u1', 'u2', 'u3', 'u4', 'u5']);
  assert.equal(result.error, undefined);
});

test('stops at the row cap and reports truncation instead of failing', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  const result = await syncDatabase(source, target, { chunkSize: 2, maxRowsPerTable: 2, tables: ['users'] });

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.complete, false);
  assert.equal(result.rowsWritten, 2);
  assert.equal(result.tables[0].truncated, true);
  assert.equal(result.tables[0].nextCursor?.[0], 'u2');
  assert.deepEqual(result.cursors, { users: ['u2'] });
});

test('S1: row counts are compared once a table is fully copied', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});
  // Rows are pushed but never land (a silently failing target): rowsWritten says
  // 5, the counts say 0 vs 5 — which is the whole point of the check.
  target.applyInserts = false;

  const result = await syncTable(source, target, 'users', { chunkSize: 10 });

  assert.equal(result.rowsWritten, 5);
  assert.equal(result.sourceRows, 5);
  assert.equal(result.targetRows, 0);
  assert.equal(result.countMatches, false);
});

test('C-4: one deadline covers every table in the call', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  const startedAt = Date.now();
  const result = await syncDatabase(source, target, {
    chunkSize: 1,
    tables: ['users', 'ciphers'],
    // Already expired: no table may start a round trip.
    deadline: startedAt - 1,
    maxDurationMs: 45_000,
  });

  assert.equal(result.tables.every((table) => table.truncated), true);
  assert.equal(result.rowsWritten, 0);
  assert.ok(result.durationMs < 1_000, 'an expired budget must not spin');
});

test('a failing table does not abort the remaining tables', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});
  target.failOnTable = 'users';

  const result = await syncDatabase(source, target, { chunkSize: 10 });

  assert.equal(result.ok, false);
  const users = result.tables.find((table) => table.table === 'users');
  const ciphers = result.tables.find((table) => table.table === 'ciphers');
  assert.equal(users?.error, 'ER_NO_SUCH_TABLE');
  assert.equal(ciphers?.rowsWritten, 1);
  assert.equal(result.rowsWritten, 1);
});

test('an unreadable table list is reported once, not thrown', async () => {
  const target = new FakeNode([], {});
  // No information_schema answer for TABLES: simulate a permissions failure.
  const broken: SyncDatabase = {
    prepare() {
      throw new Error('SELECT command denied');
    },
  };

  const result = await syncDatabase(broken, target);
  assert.equal(result.ok, false);
  assert.equal(result.tables.length, 1);
  assert.match(result.tables[0].error ?? '', /denied/);
  assert.equal(result.rowsWritten, 0);
});

test('an empty table list is reported as a failure, not a successful no-op', async () => {
  // It used to return `ok`/`complete` because "every table succeeded" is
  // vacuously true for an empty list: the admin page then showed a finished
  // 0-row sync and the operator had no idea nothing was copied. A sync source
  // with no tables is always a misconfiguration (wrong schema name, an empty
  // standby picked as the source), so it must surface as an error.
  const source = new FakeNode([], {});
  const target = new FakeNode([], {});

  const result = await syncDatabase(source, target);
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.tables.length, 1);
  assert.match(result.tables[0].error ?? '', /没有/);
  assert.equal(target.inserts.length, 0);
});

test('a table without a primary key falls back to offset paging', async () => {
  const source = new FakeNode(
    ['events'],
    { events: ['at', 'kind'] },
    { events: [{ at: '1', kind: 'a' }, { at: '2', kind: 'b' }, { at: '3', kind: 'c' }] },
    { events: [] }
  );
  const target = new FakeNode([], {});

  const result = await syncTable(source, target, 'events', { chunkSize: 2 });

  assert.equal(result.paging, 'offset');
  assert.equal(result.rowsWritten, 3);
  assert.match(source.selects[1], /OFFSET 2/);
});

test('merge mode reports the rows it added, not the rows it re-sent', async () => {
  // The whole table is re-sent on every sync (that is how a repair works), so
  // "rows written" says nothing about progress. `rowsInserted` is measured from
  // the target's own count before and after.
  const columns = { t: ['id', 'v'] };
  const sourceRows = Array.from({ length: 5 }, (_, index) => ({ id: `k${index}`, v: 'src' }));
  const source = new FakeNode(['t'], columns, { t: sourceRows.map((row) => ({ ...row })) });
  const target = new FakeNode(['t'], columns, {
    t: sourceRows.slice(0, 3).map((row) => ({ ...row, v: 'target' })),
  });

  const result = await syncTable(source, target, 't');

  assert.equal(result.rowsWritten, 5, 'every row is pushed');
  assert.equal(result.rowsInserted, 2, 'only two of them were new');
  assert.equal(result.targetRows, 5);
  assert.equal(result.countMatches, true);
});

test('overwrite mode does not claim an inserted count (every row is rewritten)', async () => {
  const columns = { t: ['id', 'v'] };
  const sourceRows = Array.from({ length: 4 }, (_, index) => ({ id: `k${index}`, v: 'src' }));
  const source = new FakeNode(['t'], columns, { t: sourceRows.map((row) => ({ ...row })) });
  const target = new FakeNode(['t'], columns, {
    t: sourceRows.slice(0, 2).map((row) => ({ ...row, v: 'target' })),
  });

  const result = await syncTable(source, target, 't', { mode: 'overwrite' });

  assert.equal(result.rowsWritten, 4);
  assert.equal(result.rowsInserted, undefined);
});

test('a truncated table has no inserted count (the baseline would lie)', async () => {
  const columns = { t: ['id'] };
  const sourceRows = Array.from({ length: 6 }, (_, index) => ({ id: `k${index}` }));
  const source = new FakeNode(['t'], columns, { t: sourceRows.map((row) => ({ ...row })) });
  const target = new FakeNode([], {});

  const result = await syncTable(source, target, 't', { maxRowsPerTable: 2 });

  assert.equal(result.truncated, true);
  assert.equal(result.rowsInserted, undefined);
});

test('the cluster total adds up the per-table inserted counts', async () => {
  const columns = { a: ['id'], b: ['id'] };
  const source = new FakeNode(['a', 'b'], columns, {
    a: [{ id: '1' }, { id: '2' }],
    b: [{ id: '9' }],
  });
  const target = new FakeNode(['a', 'b'], columns, { a: [{ id: '1' }], b: [{ id: '9' }] });

  const result = await syncDatabase(source, target);

  assert.equal(result.rowsWritten, 3);
  assert.equal(result.rowsInserted, 1);
});

// ── Progress reporting ────────────────────────────────────────────────
//
// The admin page draws a bar from these numbers, so they have to mean what the
// bar claims: "tables done" out of "tables in scope", and an estimate that is
// labelled as an estimate.

test('a full run reports its table counts', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  const result = await syncDatabase(source, target, { chunkSize: 10 });

  assert.equal(result.tablesTotal, 2);
  assert.equal(result.tablesDone, 2);
  assert.deepEqual(result.skipped, []);
});

test('a run stopped by the row cap only counts the tables it finished', async () => {
  // Two rows per table and a cap of two: `users` (five rows) is cut short while
  // `ciphers` (one row) finishes, so the bar must say 1/2, not 2/2.
  const source = sourceNode();
  const target = new FakeNode([], {});

  const result = await syncDatabase(source, target, { chunkSize: 2, maxRowsPerTable: 2 });

  assert.equal(result.tablesTotal, 2);
  assert.equal(result.tablesDone, 1);
  assert.equal(result.truncated, true);
});

test('skipTables leaves a finished table alone instead of re-reading it', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  const first = await syncDatabase(source, target, { chunkSize: 10 });
  assert.equal(first.tablesDone, 2);

  const selectsBefore = source.selects.length;
  const second = await syncDatabase(source, target, { chunkSize: 10, skipTables: ['users', 'ciphers'] });

  assert.equal(source.selects.length, selectsBefore, 'no table is read again');
  assert.deepEqual(second.skipped, ['users', 'ciphers']);
  assert.equal(second.rowsRead, 0);
  assert.equal(second.tablesTotal, 2);
  assert.equal(second.tablesDone, 2);
  assert.equal(second.complete, true, 'nothing left to do is complete, not pending');
});

test('a partially skipped run only copies the tables that are left', async () => {
  const columns = { a: ['id'], b: ['id'], c: ['id'] };
  const source = new FakeNode(['a', 'b', 'c'], columns, {
    a: [{ id: '1' }],
    b: [{ id: '2' }],
    c: [{ id: '3' }],
  });
  const target = new FakeNode([], {});

  const result = await syncDatabase(source, target, { skipTables: ['a'] });

  assert.equal(result.tablesTotal, 3);
  assert.equal(result.tablesDone, 3, 'skipped ones count as done');
  assert.deepEqual(
    result.tables.map((entry) => entry.table),
    ['b', 'c'],
    'only the unfinished tables are walked'
  );
  assert.deepEqual(result.skipped, ['a']);
});

test('row estimates come from information_schema and are labelled as estimates', async () => {
  const columns = { a: ['id'], b: ['id'] };
  const source = new FakeNode(
    ['a', 'b'],
    columns,
    { a: [{ id: '1' }, { id: '2' }], b: [{ id: '3' }] },
    {},
    { a: 5_000, b: 20 }
  );
  const target = new FakeNode([], {});

  const result = await syncDatabase(source, target, { chunkSize: 10 });

  // Per-table, for the table list.
  assert.equal(result.tables.find((entry) => entry.table === 'a')?.rowsEstimate, 5_000);
  // Cluster total, for the bar.
  assert.equal(result.rowsEstimate, 5_020);
  // The exact counts stay separate: an estimate must never be used to verify.
  assert.equal(result.tables.find((entry) => entry.table === 'a')?.sourceRows, 2);
});

test('a schema without estimates degrades to table counts, not to NaN', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  const result = await syncDatabase(source, target, { chunkSize: 10 });

  assert.equal(result.rowsEstimate, 0);
  assert.equal(result.tablesDone, result.tablesTotal);
});

test('an empty source schema is a failure, not a finished sync', async () => {
  // The 0/?" progress bar came from exactly this: zero tables is vacuously
  // "every table succeeded", so the run claimed success and copied nothing.
  const empty = new FakeNode([], {});
  const target = new FakeNode([], {});

  const result = await syncDatabase(empty, target, { sourceSchema: 'nodewarden-bak' });

  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.tablesTotal, 0);
  assert.equal(target.inserts.length, 0);
  assert.match(result.tables[0].error ?? '', /nodewarden-bak/);
});

test('naming the source schema does not change a normal copy', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  const result = await syncDatabase(source, target, { chunkSize: 10, sourceSchema: 'nodewarden' });

  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.rowsWritten, 6);
});

test('countBaseTables reports how many tables a node actually has', async () => {
  const node = new FakeNode(['users', 'ciphers'], {});

  assert.equal(await countBaseTables(node), 2);
  assert.equal(await countBaseTables(new FakeNode([], {}), 'nodewarden-bak'), 0);
});

/* ── Chunked-run resume state ────────────────────────────────────────────────
 *
 * The "进度卡在 99%，数据表 19/20" report traced back to this function's
 * predecessor, which was three inline `const`s in the admin handler. Both bugs
 * only appear across slices, which is why it is tested here rather than through
 * a single call.
 */

/** A `ClusterSyncResult` for one slice: which tables it finished / reached. */
function fakeSlice(options: {
  finished?: string[];
  truncated?: string[];
  failed?: Array<{ table: string; error: string }>;
  cursors?: Record<string, Array<string | number | boolean | null>>;
}): ClusterSyncResult {
  const finished = options.finished ?? [];
  const truncated = options.truncated ?? [];
  const failed = options.failed ?? [];
  const tables = [
    ...finished.map((table) => ({ table, truncated: false, error: undefined as string | undefined })),
    ...truncated.map((table) => ({ table, truncated: true, error: undefined as string | undefined })),
    ...failed.map((entry) => ({ table: entry.table, truncated: false, error: entry.error })),
  ].map((entry) => ({
    table: entry.table,
    columns: 2,
    rowsRead: 3,
    rowsWritten: 3,
    truncated: entry.truncated,
    paging: 'keyset' as const,
    error: entry.error,
  }));
  return {
    ok: tables.every((table) => !table.error),
    complete: truncated.length === 0 && tables.every((table) => !table.error),
    tables,
    rowsRead: tables.length * 3,
    rowsWritten: tables.length * 3,
    truncated: truncated.length > 0,
    durationMs: 1,
    cursors: options.cursors ?? {},
    tablesTotal: tables.length,
    tablesDone: finished.length,
    rowsEstimate: 0,
    skipped: [],
  };
}

test('an interrupted repair run remembers the tables it already rewrote', () => {
  // This used to be recorded for `merge` only. An `overwrite` run therefore
  // re-copied the first N tables on every slice, spent its budget on table N+1
  // and stopped in exactly the same place: "数据表 19/20" at 99%, forever.
  const state = advanceSyncResume({
    result: fakeSlice({ finished: ['audit_logs', 'ciphers'], truncated: ['users'] }),
    complete: false,
  });

  assert.deepEqual(state.doneTables, ['audit_logs', 'ciphers']);
  assert.deepEqual(state.pendingTables, ['users']);
  assert.deepEqual(state.failedTables, []);
});

test('finished tables accumulate across slices until the run completes', () => {
  const first = advanceSyncResume({
    result: fakeSlice({ finished: ['a', 'b'], truncated: ['c', 'd'] }),
    complete: false,
  });
  const second = advanceSyncResume({
    previous: first,
    result: fakeSlice({ finished: ['c'], truncated: ['d'] }),
    complete: false,
    skipTables: first.doneTables,
  });
  const third = advanceSyncResume({
    previous: second,
    result: fakeSlice({ finished: ['d'] }),
    complete: true,
    skipTables: second.doneTables,
  });

  assert.deepEqual(first.doneTables, ['a', 'b']);
  assert.deepEqual(second.doneTables, ['a', 'b', 'c']);
  // A finished run carries no resume point: the next click is a fresh copy.
  assert.equal(third.doneTables, undefined);
  assert.equal(third.cursors, undefined);
});

test('a table this slice never reached keeps the cursor an earlier slice stored', () => {
  // Cursors used to be *replaced* by the slice's own map. A table the slice ran
  // out of budget before reaching has no cursor, so the stored position was
  // discarded and that table restarted from its first row on the next click.
  const state = advanceSyncResume({
    previous: { doneTables: ['a'], cursors: { users: ['u900'] } },
    result: fakeSlice({ finished: ['b'], truncated: ['users'] }),
    complete: false,
    skipTables: ['a'],
  });

  assert.deepEqual(state.cursors, { users: ['u900'] });
  assert.deepEqual(state.doneTables, ['a', 'b']);
  assert.deepEqual(state.pendingTables, ['users']);
});

test('the cursor of a table that finished is dropped', () => {
  const state = advanceSyncResume({
    previous: { cursors: { users: ['u5'], ciphers: ['c9'] } },
    result: fakeSlice({ finished: ['users'], truncated: ['ciphers'] }),
    complete: false,
  });

  // Keeping `users` would make a later copy of that table skip its first rows.
  assert.deepEqual(state.cursors, { ciphers: ['c9'] });
});

test('a table that raised an error is reported with its reason, not as pending', () => {
  const state = advanceSyncResume({
    result: fakeSlice({
      failed: [{ table: 'attachments', error: 'ER_DATA_TOO_LONG' }],
      truncated: ['users'],
    }),
    complete: false,
  });

  assert.deepEqual(state.failedTables, [{ table: 'attachments', error: 'ER_DATA_TOO_LONG' }]);
  assert.deepEqual(state.pendingTables, ['users']);
  assert.deepEqual(state.doneTables, []);
});

test('a run that copies five tables per slice converges instead of restarting', () => {
  const tables = Array.from({ length: 20 }, (_, index) => `t${String(index).padStart(2, '0')}`);
  let previous: SyncResumeSource | null = null;
  let rounds = 0;

  for (;;) {
    rounds += 1;
    assert.ok(rounds <= 10, 'the run must converge, not loop at 19/20');
    const skip = new Set(previous?.doneTables ?? []);
    const pending = tables.filter((table) => !skip.has(table));
    const finished = pending.slice(0, 5);
    const complete = pending.length <= 5;
    const state = advanceSyncResume({
      previous,
      result: fakeSlice({
        finished,
        truncated: complete ? [] : pending.slice(5, 6),
      }),
      complete,
      skipTables: [...skip],
    });
    if (complete) break;
    previous = state;
  }

  assert.equal(rounds, 4); // 20 tables at five per slice
});

test('a slice that cannot reach the last table still converges on the next one', async () => {
  // The reported case: 20 tables, one 12s slice only gets through 19 of them
  // (about six round trips per table), and the page shows "数据表 19/20 · 99%".
  // Before `advanceSyncResume`, every slice re-read the first tables from the
  // top and expired in the same place, so it never finished — clicking again
  // just repeated the same 19/20.
  const tables = Array.from({ length: 20 }, (_, index) => `t${String(index).padStart(2, '0')}`);
  const columns = Object.fromEntries(tables.map((table) => [table, ['id']]));
  const rows = Object.fromEntries(
    tables.map((table) => [table, Array.from({ length: 3 }, (_, index) => ({ id: `${table}-${index}` }))])
  );
  const source = new FakeNode(tables, columns, rows);
  source.latencyMs = 4;
  const target = new FakeNode([], {});
  target.latencyMs = 4;

  let previous: SyncResumeSource | null = null;
  let rounds = 0;
  let last: ClusterSyncResult | null = null;
  const donePerRound: number[] = [];

  for (;;) {
    rounds += 1;
    assert.ok(rounds <= 8, 'the run must converge, not loop at 19/20');
    const slice = await syncDatabase(source, target, {
      mode: 'overwrite',
      maxDurationMs: 250,
      skipTables: previous?.doneTables,
      cursors: previous?.cursors,
    });
    last = slice;
    donePerRound.push(slice.tablesDone);
    const complete = slice.ok && slice.complete;
    const state = advanceSyncResume({
      previous,
      result: slice,
      complete,
      skipTables: previous?.doneTables,
    });
    if (complete) break;
    previous = state;
  }

  assert.ok(rounds >= 2, 'the artificial latency should split the copy into slices');
  assert.equal(last?.complete, true);
  assert.equal(last?.tablesTotal, 20);
  // The bar must move forward. A restart would show up as a drop here.
  for (let index = 1; index < donePerRound.length; index += 1) {
    assert.ok(donePerRound[index] >= donePerRound[index - 1], `slice ${index} went backwards`);
  }
  for (const table of tables) {
    assert.equal((target.rows[table] ?? []).length, 3, `${table} was not copied`);
  }
});
