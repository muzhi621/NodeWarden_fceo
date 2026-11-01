import test from 'node:test';
import assert from 'node:assert/strict';

import { syncDatabase, syncTable, type SyncDatabase } from '../src/services/db-cluster-sync';
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

  constructor(
    readonly tables: string[],
    readonly columns: Record<string, string[]>,
    readonly rows: Record<string, Array<Record<string, unknown>>> = {},
    primaryKeys: Record<string, string[]> = {}
  ) {
    this.primaryKeys = {
      ...Object.fromEntries(
        Object.entries(columns).map(([table, cols]) => [table, cols.length > 0 ? [cols[0]] : []])
      ),
      ...primaryKeys,
    };
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
    const sql = this.sql;
    const asResult = (rows: unknown[]): D1LikeResult<R> =>
      ({ results: rows as R[], success: true, meta: { changes: 0, last_row_id: 0 } }) as D1LikeResult<R>;

    if (sql.includes('information_schema.TABLES')) {
      return asResult(this.node.tables.map((name) => ({ name })));
    }
    if (sql.includes('information_schema.COLUMNS')) {
      const table = String(this.params[0] ?? '');
      return asResult((this.node.columns[table] ?? []).map((name) => ({ name })));
    }
    if (sql.includes('information_schema.KEY_COLUMN_USAGE')) {
      const table = String(this.params[0] ?? '');
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

test('an empty table list is a successful no-op', async () => {
  const source = new FakeNode([], {});
  const target = new FakeNode([], {});

  const result = await syncDatabase(source, target);
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.tables.length, 0);
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
