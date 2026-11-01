// Regression tests for the two failover gaps found in the sixth review (B1/B2).
//
// B1: the write watermark lived only in memory, so a restart reset every node to
//     "0 == 0, therefore caught up" and the next failover quietly lost the
//     writes the standby had missed.
// B2: markNodeSynced() advanced a node straight to the latest sequence, so a sync
//     that did not repair a row (the default `merge` mode never overwrites) was
//     reported as complete and the journal could no longer close the gap.
//
// Run: npx tsx --test scripts/db-cluster-restart.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MySqlClusterDatabase,
  type ClusterNodeSpec,
  type NodeDatabase,
} from '../src/services/db-cluster';
import type { ClusterWatermarkSnapshot, DbClusterPolicy } from '../src/services/db-config';

const POLICY: DbClusterPolicy = {
  readSplit: false,
  syncMode: 'write-through',
  syncAsync: false,
  failoverEnabled: true,
  failureThreshold: 5,
  cooldownMs: 30_000,
};

function downError(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' });
}

interface FakeNode {
  db: NodeDatabase;
  log: string[];
  setDown(value: boolean): void;
}

function fakeNode(initiallyDown = false): FakeNode {
  const log: string[] = [];
  let down = initiallyDown;
  const record = (sql: string) => {
    if (down) throw downError();
    log.push(sql);
  };
  const statement = (sql: string) => {
    const self = {
      bind: () => self,
      async run() {
        record(sql);
        return { results: [], success: true, meta: { changes: 1, last_row_id: 0 } };
      },
      async all() {
        record(sql);
        return { results: [], success: true, meta: { changes: 0, last_row_id: 0 } };
      },
      async first() {
        record(sql);
        return null;
      },
    };
    return self as never;
  };
  return {
    db: {
      prepare: (sql: string) => statement(sql),
      async batch(statements: unknown[]) {
        if (down) throw downError();
        log.push(`<batch:${statements.length}>`);
        return [];
      },
      async close() {},
    },
    log,
    setDown(value: boolean) {
      down = value;
    },
  };
}

function spec(id: string, role: 'primary' | 'replica', syncReady?: boolean): ClusterNodeSpec {
  return {
    id,
    label: id,
    role,
    priority: role === 'primary' ? 1 : 2,
    host: `host-${id}`,
    port: 3306,
    user: 'u',
    password: 'p',
    database: 'd',
    ssl: false,
    connectionLimit: 2,
    connectTimeoutMs: 1_000,
    syncReady,
  };
}

const SPECS = [spec('a', 'primary'), spec('b', 'replica')];

function build(
  nodes: { a: FakeNode; b: FakeNode },
  options: { policy?: Partial<DbClusterPolicy>; watermark?: ClusterWatermarkSnapshot | null } = {}
): MySqlClusterDatabase {
  return new MySqlClusterDatabase(
    SPECS,
    { ...POLICY, ...options.policy },
    (config) => (config.host === 'host-a' ? nodes.a.db : nodes.b.db),
    { watermark: options.watermark }
  );
}

const insert = (db: MySqlClusterDatabase, key: string) =>
  db.prepare('INSERT INTO probe (k) VALUES (?)').bind(key).run();

test('B1: a standby recorded as behind stays behind after a restart', async () => {
  const first = { a: fakeNode(), b: fakeNode() };
  const before = build(first);
  await insert(before, 'k1');
  await insert(before, 'k2');
  first.b.setDown(true);
  await insert(before, 'k3');

  const watermark = before.watermarkSnapshot();
  assert.equal(watermark.writeSeq, 3);
  assert.equal(watermark.nodes.a, 3);
  assert.equal(watermark.nodes.b, 2, 'the standby applied only two writes before it went away');

  // Restart: fresh adapter, same persisted watermark, both servers reachable.
  const second = { a: fakeNode(), b: fakeNode() };
  const after = build(second, { watermark });
  const standby = after.nodeHealth().find((node) => node.id === 'b');
  assert.equal(standby?.needsFullSync, true, 'the journal is gone, so the gap cannot be replayed');
  assert.equal(standby?.lag, 1);
  assert.equal(standby?.appliedSeq, 2);

  // Still serving writes from the node that has the data, and not pretending the
  // standby is a candidate.
  await insert(after, 'k4');
  assert.equal(second.a.log.length, 1);
  assert.equal(second.b.log.length, 0, 'a node awaiting a full sync must not receive writes');
  assert.equal(after.nodeHealth().find((node) => node.id === 'b')?.needsFullSync, true);
});

test('B1: a standby recorded as level stays usable after a restart', async () => {
  const nodes = { a: fakeNode(), b: fakeNode() };
  const db = build(nodes, { watermark: { writeSeq: 4, nodes: { a: 4, b: 4 } } });
  const standby = db.nodeHealth().find((node) => node.id === 'b');
  assert.equal(standby?.needsFullSync, false);
  assert.equal(standby?.lag, 0);

  await insert(db, 'k5');
  assert.equal(nodes.b.log.length, 1, 'a caught-up standby keeps receiving replays');
});

test('B1: no watermark means the pre-fix behaviour (nothing is assumed lost)', async () => {
  const nodes = { a: fakeNode(), b: fakeNode() };
  const db = build(nodes, { watermark: null });
  const standby = db.nodeHealth().find((node) => node.id === 'b');
  assert.equal(standby?.needsFullSync, false);
  assert.equal(standby?.writeBlocked, false);
});

test('B2: markNodeSynced only advances to the watermark captured before the copy', async () => {
  const nodes = { a: fakeNode(), b: fakeNode() };
  const db = build(nodes);
  await insert(db, 'k1');
  nodes.b.setDown(true);
  await insert(db, 'k2');
  nodes.b.setDown(false);

  // The admin sync started when the writer was at sequence 1; the write that
  // committed afterwards is still in the journal.
  db.markNodeSynced('b', 1);
  const standby = db.nodeHealth().find((node) => node.id === 'b');
  assert.equal(standby?.appliedSeq, 1);
  assert.equal(standby?.lag, 1, 'the sync did not cover the later write');
  assert.equal(standby?.needsFullSync, false, 'but the journal can still close the gap');
  assert.equal(standby?.syncReady, true);

  // The next write replays the missing entry instead of skipping it.
  const logBefore = nodes.b.log.length;
  await insert(db, 'k3');
  assert.ok(nodes.b.log.length > logBefore, 'the standby is caught up from the journal');
  assert.equal(db.nodeHealth().find((node) => node.id === 'b')?.lag, 0);
});

test('B2: a sync that covers everything still ends up level', async () => {
  const nodes = { a: fakeNode(), b: fakeNode() };
  const db = build(nodes);
  await insert(db, 'k1');
  db.markNodeSynced('b', db.writeWatermarks().writeSeq);
  const standby = db.nodeHealth().find((node) => node.id === 'b');
  assert.equal(standby?.lag, 0);
  assert.equal(standby?.needsFullSync, false);
});

test('S2: applySyncReadiness enables a node without rebuilding the adapter', async () => {
  const nodes = { a: fakeNode(), b: fakeNode() };
  const db = new MySqlClusterDatabase(
    [spec('a', 'primary'), spec('b', 'replica', false)],
    { ...POLICY, readSplit: true },
    (config) => (config.host === 'host-a' ? nodes.a.db : nodes.b.db)
  );
  await db.prepare('SELECT * FROM probe').all();
  assert.equal(nodes.b.log.length, 0, 'an unsynced standby is kept out of reads');

  db.applySyncReadiness(new Map([['b', true]]));
  assert.equal(db.nodeHealth().find((node) => node.id === 'b')?.syncReady, true);
  await db.prepare('SELECT * FROM probe').all();
  assert.equal(nodes.b.log.length, 1, 'and joins the rotation once it is synced');
});
