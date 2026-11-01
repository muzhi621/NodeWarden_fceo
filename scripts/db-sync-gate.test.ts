// Tests for the persisted sync bookkeeping and the standby readiness gate (B-4).
// Run: npx tsx --test scripts/db-sync-gate.test.ts
//
// The dangerous failure mode this covers: a write-through standby that has never
// been synced still gets picked on failover, comes up empty, and every account
// "disappears". Readiness therefore has to be a persisted fact, not a guess.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearSyncStates,
  normalizeRuntimeConfig,
  readSyncStates,
  resolveDbCluster,
  saveNodeSyncState,
  saveRuntimeConfig,
  type DbRuntimeConfigV2,
} from '../src/services/db-config';
import { resetDbLifecycleForTests } from '../src/services/db-lifecycle';

interface MemoryKv {
  readonly entries: Map<string, string>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function memoryKv(): MemoryKv {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key: string) => entries.get(key) ?? null,
    put: async (key: string, value: string) => {
      entries.set(key, value);
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
  };
}

function envWith(): { env: Record<string, unknown>; kv: MemoryKv } {
  const kv = memoryKv();
  // No DB_HOST: the runtime config must be the one that resolves.
  delete process.env.DB_HOST;
  return { env: { SETTINGS_KV: kv, DB_CONFIG_KEY: 'test-passphrase-for-db-config', DB: null }, kv };
}

function clusterConfig(syncMode: 'native' | 'write-through'): DbRuntimeConfigV2 {
  const config = normalizeRuntimeConfig({
    version: 2,
    mode: 'mysql',
    nodes: [
      {
        id: 'a',
        label: '主库',
        role: 'primary',
        priority: 1,
        host: 'primary.example.com',
        user: 'u',
        password: 'p',
        database: 'd',
      },
      {
        id: 'b',
        label: '副库',
        role: 'replica',
        priority: 2,
        host: 'replica.example.com',
        user: 'u',
        password: 'p',
        database: 'd',
      },
    ],
    policy: { syncMode },
  });
  assert.ok(config);
  return config;
}

test('sync state round-trips through the config store', async () => {
  const { env } = envWith();
  resetDbLifecycleForTests();

  assert.deepEqual(await readSyncStates(env as never), {});

  await saveNodeSyncState(env as never, 'b', {
    at: Date.now(),
    complete: false,
    truncated: true,
    rowsWritten: 120,
    tables: 19,
    sourceId: 'a',
    cursors: { config: ['cfg-199'] },
  });

  const states = await readSyncStates(env as never);
  assert.equal(states.b.truncated, true);
  assert.equal(states.b.complete, false);
  assert.equal(states.b.sourceId, 'a');
  assert.deepEqual(states.b.cursors, { config: ['cfg-199'] });

  await clearSyncStates(env as never);
  assert.deepEqual(await readSyncStates(env as never), {});
});

test('an unsynced write-through standby is not marked ready', async () => {
  const { env } = envWith();
  resetDbLifecycleForTests();
  await saveRuntimeConfig(env as never, clusterConfig('write-through'));

  const before = await resolveDbCluster(env as never);
  const replica = before.nodes.find((node) => node.role === 'replica');
  assert.equal(replica?.syncReady, false, 'never synced = cannot take over');
  assert.equal(before.nodes.find((node) => node.role === 'primary')?.syncReady, undefined);

  await saveNodeSyncState(env as never, 'b', {
    at: Date.now(),
    complete: true,
    truncated: false,
    rowsWritten: 500,
    tables: 19,
  });

  const after = await resolveDbCluster(env as never);
  assert.equal(after.nodes.find((node) => node.role === 'replica')?.syncReady, true);
  assert.equal(after.nodes.find((node) => node.role === 'replica')?.syncStatus?.complete, true);
});

test('native replication does not gate readiness on app-level sync', async () => {
  const { env } = envWith();
  resetDbLifecycleForTests();
  await saveRuntimeConfig(env as never, clusterConfig('native'));

  const cluster = await resolveDbCluster(env as never);
  const replica = cluster.nodes.find((node) => node.role === 'replica');
  // The database replicates itself: whether it is filled is not the app's call.
  assert.equal(replica?.syncReady, undefined);
});

test('an incomplete sync does not make the standby ready', async () => {
  const { env } = envWith();
  resetDbLifecycleForTests();
  await saveRuntimeConfig(env as never, clusterConfig('write-through'));
  await saveNodeSyncState(env as never, 'b', {
    at: Date.now(),
    complete: false,
    truncated: true,
    rowsWritten: 10,
    tables: 19,
    cursors: { config: ['cfg-009'] },
  });

  const cluster = await resolveDbCluster(env as never);
  assert.equal(cluster.nodes.find((node) => node.role === 'replica')?.syncReady, false);
});
