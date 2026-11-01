import test from 'node:test';
import assert from 'node:assert/strict';

import { syncDatabase, syncTable, type SyncDatabase } from '../src/services/db-cluster-sync';
import type { D1LikeResult, D1LikeStatement } from '../src/services/storage-mysql';

/**
 * Minimal stand-in for a MySQL node.
 *
 * It answers the three shapes the sync service issues (information_schema
 * tables/columns and a paged SELECT) and records the INSERTs, which is enough to
 * assert chunking, batching and the upsert shape without a server.
 */
class FakeNode implements SyncDatabase {
  readonly inserts: Array<{ sql: string; params: unknown[] }> = [];
  readonly selects: string[] = [];
  failOnTable?: string;

  constructor(
    readonly tables: string[],
    readonly columns: Record<string, string[]>,
    readonly rows: Record<string, Array<Record<string, unknown>>> = {}
  ) {}

  prepare(sql: string): D1LikeStatement {
    return new FakeStatement(sql, this);
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
    return { results: [], success: true, meta: { changes: 1, duration: 0 } } as D1LikeResult;
  }

  async all<R = Record<string, unknown>>(): Promise<D1LikeResult<R>> {
    const sql = this.sql;
    if (sql.includes('information_schema.TABLES')) {
      return { results: this.node.tables.map((name) => ({ name })) as R[], success: true } as D1LikeResult<R>;
    }
    if (sql.includes('information_schema.COLUMNS')) {
      const table = String(this.params[0] ?? '');
      const cols = this.node.columns[table] ?? [];
      return { results: cols.map((name) => ({ name })) as R[], success: true } as D1LikeResult<R>;
    }
    const table = /FROM `([^`]+)`/.exec(sql)?.[1] ?? '';
    if (this.node.failOnTable === table) throw new Error('ER_NO_SUCH_TABLE');
    this.node.selects.push(sql);
    const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 0);
    const offset = Number(/OFFSET (\d+)/.exec(sql)?.[1] ?? 0);
    const rows = (this.node.rows[table] ?? []).slice(offset, offset + limit);
    return { results: rows as R[], success: true } as D1LikeResult<R>;
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
  assert.equal(result.rowsRead, 6);
  assert.equal(result.rowsWritten, 6);
  assert.deepEqual(
    result.tables.map((table) => table.table),
    ['users', 'ciphers']
  );
  // Five user rows at two per round trip: 2 + 2 + 1.
  assert.equal(target.inserts.length, 4);
});

test('the replayed write is an idempotent upsert, not a plain insert', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  await syncDatabase(source, target, { chunkSize: 10 });

  const insert = target.inserts[0].sql;
  assert.match(insert, /^INSERT INTO `users` \(`id`, `email`\) VALUES \(\?, \?\)/);
  assert.match(insert, /ON DUPLICATE KEY UPDATE `id` = VALUES\(`id`\), `email` = VALUES\(`email`\)$/);
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

test('paging reads in column order with inlined LIMIT/OFFSET', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  await syncTable(source, target, 'users', { chunkSize: 3 });

  assert.deepEqual(source.selects, [
    'SELECT `id`, `email` FROM `users` ORDER BY 1 LIMIT 3 OFFSET 0',
    'SELECT `id`, `email` FROM `users` ORDER BY 1 LIMIT 3 OFFSET 3',
  ]);
});

test('stops at the row cap and reports truncation instead of failing', async () => {
  const source = sourceNode();
  const target = new FakeNode([], {});

  const result = await syncDatabase(source, target, { chunkSize: 2, maxRowsPerTable: 2, tables: ['users'] });

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.rowsWritten, 2);
  assert.equal(result.tables[0].truncated, true);
  assert.equal(target.inserts.length, 1);
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
  assert.equal(result.tables.length, 0);
  assert.equal(target.inserts.length, 0);
});
