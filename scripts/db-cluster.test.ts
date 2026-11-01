// Tests for the multi-node MySQL cluster adapter.
// Run: npx tsx --test scripts/db-cluster.test.ts
//
// These cover the behaviours the admin UI promises: failover on a connection
// failure, read splitting, write replay, breaker/cooldown, and — just as
// important — that a *SQL* error never moves traffic to another node (which
// would run the same statement twice).

import assert from 'node:assert/strict';
import test from 'node:test';
import { MySqlClusterDatabase, isNodeLevelFailure, type ClusterNodeSpec, type NodeDatabase } from '../src/services/db-cluster';
import type { DbClusterPolicy } from '../src/services/db-config';

const POLICY: DbClusterPolicy = {
  readSplit: false,
  syncMode: 'native',
  syncAsync: false,
  failoverEnabled: true,
  failureThreshold: 3,
  cooldownMs: 30_000,
};

interface LogEntry {
  sql: string;
  params: unknown[];
  mode: string;
}

interface FakeNode {
  db: NodeDatabase;
  log: LogEntry[];
}

/**
 * Minimal D1-like node. `fail` decides per statement whether the node is down
 * (transport error) or rejects the statement (SQL error).
 */
function fakeNode(options: { fail?: (sql: string) => Error | null; rows?: Record<string, unknown>[] } = {}): FakeNode {
  const log: LogEntry[] = [];

  const record = (sql: string, params: unknown[], mode: string) => {
    log.push({ sql, params, mode });
    const failure = options.fail?.(sql);
    if (failure) throw failure;
    if (mode === 'first') return (options.rows ?? [{ ok: 1 }])[0] ?? null;
    if (mode === 'all') {
      return { results: options.rows ?? [], success: true, meta: { changes: 0, last_row_id: 0 } };
    }
    return { results: [], success: true, meta: { changes: 1, last_row_id: 0 } };
  };

  const db: NodeDatabase = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          params = next;
          return statement;
        },
        run: async () => record(sql, params, 'run'),
        all: async () => record(sql, params, 'all'),
        first: async () => record(sql, params, 'first'),
      };
      return statement as never;
    },
    async batch(statements: unknown[]) {
      log.push({ sql: `<batch:${statements.length}>`, params: [], mode: 'batch' });
      const failure = options.fail?.('<batch>');
      if (failure) throw failure;
      return [];
    },
    async close() {},
  };

  return { db, log };
}

function spec(overrides: Partial<ClusterNodeSpec> & { id: string; host: string }): ClusterNodeSpec {
  return {
    label: overrides.id,
    role: 'primary',
    priority: 1,
    port: 3306,
    user: 'u',
    password: 'p',
    database: 'd',
    ssl: false,
    connectionLimit: 2,
    connectTimeoutMs: 1_000,
    ...overrides,
  };
}

function connectionError(code = 'ECONNREFUSED'): Error {
  const error = new Error(`${code}: connection failed`) as Error & { code: string };
  error.code = code;
  return error;
}

function sqlError(code = 'ER_DUP_ENTRY'): Error {
  const error = new Error(`${code}: duplicate entry`) as Error & { code: string; errno: number };
  error.code = code;
  error.errno = 1062;
  return error;
}

function cluster(
  primary: FakeNode,
  replica: FakeNode,
  policy: Partial<DbClusterPolicy> = {}
): MySqlClusterDatabase {
  const primarySpec = spec({ id: 'primary', host: 'primary.db', role: 'primary', priority: 1 });
  const replicaSpec = spec({ id: 'replica', host: 'replica.db', role: 'replica', priority: 2 });
  return new MySqlClusterDatabase([primarySpec, replicaSpec], { ...POLICY, ...policy }, (config) =>
    config.host === 'primary.db' ? primary.db : replica.db
  );
}

test('a write falls over to the standby when the primary cannot be reached', async () => {
  const primary = fakeNode({ fail: () => connectionError() });
  const replica = fakeNode();
  const db = cluster(primary, replica);

  await db.prepare('INSERT INTO users (id) VALUES (?)').bind('1').run();

  assert.equal(primary.log.length, 1, 'the primary was tried first');
  assert.equal(replica.log.length, 1, 'the standby executed the write');
  assert.match(replica.log[0].sql, /INSERT INTO users/);
  assert.deepEqual(replica.log[0].params, ['1']);
});

test('a SQL error is not a node outage: nothing is replayed elsewhere', async () => {
  const primary = fakeNode({ fail: () => sqlError() });
  const replica = fakeNode();
  const db = cluster(primary, replica);

  await assert.rejects(() => db.prepare('INSERT INTO users (id) VALUES (?)').bind('1').run(), /ER_DUP_ENTRY/);

  assert.equal(primary.log.length, 1);
  assert.equal(replica.log.length, 0, 'a duplicate key must not be retried on another node');
});

test('write-through replays the statement on every other node', async () => {
  const primary = fakeNode();
  const replica = fakeNode();
  const db = cluster(primary, replica, { syncMode: 'write-through' });

  await db.prepare('UPDATE users SET name = ? WHERE id = ?').bind('n', '1').run();

  assert.equal(primary.log.length, 1);
  assert.equal(replica.log.length, 1, 'the standby received the same write');
  assert.match(replica.log[0].sql, /UPDATE users/);
  assert.deepEqual(replica.log[0].params, ['n', '1']);
});

test('native replication mode never double-writes', async () => {
  const primary = fakeNode();
  const replica = fakeNode();
  const db = cluster(primary, replica, { syncMode: 'native' });

  await db.prepare('INSERT INTO users (id) VALUES (?)').bind('1').run();

  assert.equal(replica.log.length, 0, 'the database itself replicates; the app must not replay');
});

test('read splitting sends SELECTs to a replica and keeps writes on the primary', async () => {
  const primary = fakeNode();
  const replica = fakeNode();
  const db = cluster(primary, replica, { readSplit: true });

  await db.prepare('SELECT * FROM users WHERE id = ?').bind('1').all();
  assert.equal(replica.log.length, 1, 'the read went to the replica');
  assert.equal(primary.log.length, 0);

  await db.prepare('DELETE FROM users WHERE id = ?').bind('1').run();
  assert.equal(primary.log.length, 1, 'the write stayed on the primary');
  assert.equal(replica.log.length, 1);
});

test('a failing replica read falls back to the primary', async () => {
  const primary = fakeNode({ rows: [{ ok: 1 }] });
  const replica = fakeNode({ fail: () => connectionError('ETIMEDOUT') });
  const db = cluster(primary, replica, { readSplit: true });

  const result = await db.prepare('SELECT 1 AS ok').all();

  assert.equal(replica.log.length, 1);
  assert.equal(primary.log.length, 1);
  assert.deepEqual(result.results, [{ ok: 1 }]);
});

test('the breaker takes a failing node out and honours the cooldown', async () => {
  let down = true;
  const primary = fakeNode({ fail: () => (down ? connectionError() : null) });
  const replica = fakeNode();
  const db = cluster(primary, replica, { failureThreshold: 2, cooldownMs: 40 });

  await db.prepare('INSERT INTO t (id) VALUES (?)').bind('1').run();
  await db.prepare('INSERT INTO t (id) VALUES (?)').bind('2').run();
  assert.equal(primary.log.length, 2, 'both requests tried the primary');
  assert.equal(db.nodeHealth().find((node) => node.id === 'primary')?.available, false);

  // Tripped: the next write skips the primary entirely.
  await db.prepare('INSERT INTO t (id) VALUES (?)').bind('3').run();
  assert.equal(primary.log.length, 2, 'no more traffic to the tripped node');
  assert.equal(replica.log.length, 3);

  // After the cooldown the node is retried (half-open) and recovers.
  down = false;
  await new Promise((resolve) => setTimeout(resolve, 60));
  await db.prepare('INSERT INTO t (id) VALUES (?)').bind('4').run();

  assert.equal(primary.log.length, 3, 'half-open retry reached the primary again');
  const health = db.nodeHealth().find((node) => node.id === 'primary');
  assert.equal(health?.available, true);
  assert.equal(health?.failures, 0, 'a successful probe resets the failure count');
});

test('failover can be disabled: the primary is the only writer', async () => {
  const primary = fakeNode({ fail: () => connectionError() });
  const replica = fakeNode();
  const db = cluster(primary, replica, { failoverEnabled: false });

  await assert.rejects(() => db.prepare('INSERT INTO t (id) VALUES (?)').bind('1').run(), /ECONNREFUSED/);
  assert.equal(primary.log.length, 1);
  assert.equal(replica.log.length, 0, 'explicitly disabled: no standby takeover');
});

test('a replayed write that fails is recorded without failing the request', async () => {
  const primary = fakeNode();
  const replica = fakeNode({ fail: () => sqlError('ER_NO_SUCH_TABLE') });
  const db = cluster(primary, replica, { syncMode: 'write-through' });

  // The primary committed, so the caller must see success.
  await db.prepare('INSERT INTO t (id) VALUES (?)').bind('1').run();

  const health = db.nodeHealth().find((node) => node.id === 'replica');
  assert.equal(health?.syncErrors, 1);
  assert.match(String(health?.lastSyncError), /ER_NO_SUCH_TABLE/);
});

test('a batch falls over to the standby exactly once', async () => {
  const primary = fakeNode({ fail: () => connectionError() });
  const replica = fakeNode();
  const db = cluster(primary, replica, { syncMode: 'write-through' });

  await db.batch([
    db.prepare('INSERT INTO t (id) VALUES (?)').bind('1'),
    db.prepare('INSERT INTO t (id) VALUES (?)').bind('2'),
  ]);

  assert.equal(primary.log.filter((entry) => entry.mode === 'batch').length, 1);
  assert.equal(
    replica.log.filter((entry) => entry.mode === 'batch').length,
    1,
    'the batch ran once on the standby and was not replayed back into the dead primary'
  );
});

test('isNodeLevelFailure separates transport failures from SQL rejections', () => {
  assert.equal(isNodeLevelFailure(connectionError('ECONNRESET')), true);
  assert.equal(isNodeLevelFailure({ errno: 2013 }), true);
  assert.equal(isNodeLevelFailure(sqlError('ER_DUP_ENTRY')), false);
  assert.equal(isNodeLevelFailure(new Error('You have an error in your SQL syntax')), false);
});
