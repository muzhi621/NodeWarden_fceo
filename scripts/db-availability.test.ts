// "There is no database" must be an answer, not a crash (review round 6).
// Run: npx tsx --test scripts/db-availability.test.ts
//
// Before this, a config whose every node was disabled resolved to "mode: d1"
// and the factory returned `env.DB` — which does not exist on the Node runtime,
// so every request died on `undefined.prepare(...)`. On Workers it silently
// pointed the app at a completely different database. Both are now a 503 whose
// message names the thing the operator changed.

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDbCluster, saveRuntimeConfig, type DbRuntimeConfigV2 } from '../src/services/db-config';
import { getDatabase, getDatabaseStatus, resetDatabaseCache } from '../src/services/storage-factory';
import { resetDbLifecycleForTests } from '../src/services/db-lifecycle';

function memoryKv() {
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

function envWith(overrides: Record<string, unknown> = {}) {
  const kv = memoryKv();
  return { SETTINGS_KV: kv, DB_CONFIG_KEY: 'test-passphrase-for-db-config', DB: null, ...overrides } as Record<
    string,
    unknown
  >;
}

function disabledCluster(): DbRuntimeConfigV2 {
  return {
    version: 2,
    mode: 'mysql',
    nodes: [
      {
        id: 'a',
        label: '主库A',
        role: 'primary',
        priority: 1,
        enabled: false,
        host: 'db-a.example.com',
        port: 3306,
        user: 'u',
        password: 'p',
        database: 'nw',
        ssl: false,
        connectionLimit: 5,
      },
      {
        id: 'b',
        label: '副库B',
        role: 'replica',
        priority: 2,
        enabled: false,
        host: 'db-b.example.com',
        port: 3306,
        user: 'u',
        password: 'p',
        database: 'nw',
        ssl: false,
        connectionLimit: 5,
      },
    ],
    policy: {
      readSplit: false,
      syncMode: 'native',
      syncAsync: false,
      failoverEnabled: true,
      failureThreshold: 3,
      cooldownMs: 30_000,
    },
  };
}

test.afterEach(async () => {
  await resetDatabaseCache();
  resetDbLifecycleForTests();
});

test('a config with every node disabled resolves as unusable, not as "no config"', async () => {
  const env = envWith();
  await saveRuntimeConfig(env as never, disabledCluster());

  const cluster = await resolveDbCluster(env as never);

  assert.equal(cluster.mode, 'd1');
  assert.equal(cluster.nodes.length, 0);
  assert.match(String(cluster.unavailableReason), /2 个节点/);
  assert.match(String(cluster.unavailableReason), /停用/);
});

test('getDatabase refuses with an actionable 503 instead of returning undefined', async () => {
  const env = envWith();
  await saveRuntimeConfig(env as never, disabledCluster());

  await assert.rejects(
    () => getDatabase(env as never),
    (error: Error & { status?: number; code?: string }) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'ERR_DB_CLUSTER_UNAVAILABLE');
      assert.match(error.message, /启用至少一个节点/);
      return true;
    }
  );
});

test('healthz reports the reason instead of "ok: true"', async () => {
  const env = envWith();
  await saveRuntimeConfig(env as never, disabledCluster());

  const status = await getDatabaseStatus(env as never);

  assert.equal(status.ok, false);
  assert.match(String(status.error), /停用/);
});

test('no config and no D1 binding is its own message (Node runtime)', async () => {
  const env = envWith();

  await assert.rejects(
    () => getDatabase(env as never),
    (error: Error & { status?: number }) => {
      assert.equal(error.status, 503);
      assert.match(error.message, /没有内置数据库/);
      return true;
    }
  );
});

test('a real D1 binding is still used when nothing else is configured', async () => {
  const sentinel = { prepare: () => ({}) };
  const env = envWith({ DB: sentinel });

  const db = await getDatabase(env as never);

  assert.equal(db, sentinel);
});
