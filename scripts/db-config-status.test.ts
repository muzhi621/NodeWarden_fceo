// Tests for what the database settings page is told about its own config.
// Run: npx tsx --test scripts/db-config-status.test.ts
//
// The failure this covers is a reporting one, but it reads as data loss: a
// cluster saved in the UI disappeared from the page after a reload, because
// `DB_HOST` was also set and the status endpoint only described the config *in
// effect* — the env node. The saved nodes were in the config store the whole
// time. `storedCluster` is what keeps them visible.

import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAdminGetDbConfig } from '../src/handlers/admin-db-config';
import { normalizeRuntimeConfig, saveRuntimeConfig, type DbRuntimeConfigV2 } from '../src/services/db-config';
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

function envWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { SETTINGS_KV: memoryKv(), DB_CONFIG_KEY: 'test-passphrase-for-db-config', DB: null, ...overrides };
}

const actor = { id: 'user-admin', email: 'admin@example.com' } as never;

function twoNodeCluster(): DbRuntimeConfigV2 {
  const config = normalizeRuntimeConfig({
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
    policy: { syncMode: 'write-through' },
  });
  assert.ok(config);
  return config;
}

async function readStatus(env: Record<string, unknown>) {
  const response = await handleAdminGetDbConfig(
    new Request('https://example.com/api/admin/db-config'),
    env as never,
    actor
  );
  assert.equal(response.status, 200);
  return (await response.json()) as {
    cluster: { source: string; nodes: Array<{ id: string; label: string; passwordSet: boolean }> };
    storedCluster: { source: string; nodes: Array<{ id: string }> } | null;
    storedClusterActive: boolean;
    envOverrideActive: boolean;
    runtimeConfigStored: boolean;
  };
}

test('a saved cluster is reported even when DB_* is what is in effect', async () => {
  const env = envWith({ DB_HOST: 'env.example.com', DB_USER: 'u', DB_NAME: 'd' });
  resetDbLifecycleForTests();
  await saveRuntimeConfig(env as never, twoNodeCluster());

  const status = await readStatus(env);

  // What is in effect: the env node, exactly as before.
  assert.equal(status.cluster.source, 'env');
  assert.equal(status.cluster.nodes.length, 1);
  assert.equal(status.envOverrideActive, true);
  assert.equal(status.storedClusterActive, false);

  // What the page must not lose: the two nodes the operator saved.
  assert.equal(status.storedCluster?.source, 'runtime');
  assert.deepEqual(
    status.storedCluster?.nodes.map((node) => node.id),
    ['a', 'b']
  );
  assert.equal(status.runtimeConfigStored, true);
});

test('the stored nodes are masked, never returned with a password', async () => {
  const env = envWith({ DB_HOST: 'env.example.com' });
  resetDbLifecycleForTests();
  await saveRuntimeConfig(env as never, twoNodeCluster());

  const status = await readStatus(env);
  for (const node of status.storedCluster?.nodes ?? []) {
    assert.equal('password' in node, false, 'a password must never be serialized');
  }
  assert.equal(status.storedCluster?.nodes.every((node) => (node as { passwordSet?: boolean }).passwordSet === true), true);
});

test('with no saved config the field is null, not an empty cluster', async () => {
  const env = envWith({ DB_HOST: 'env.example.com' });
  resetDbLifecycleForTests();

  const status = await readStatus(env);

  assert.equal(status.cluster.source, 'env');
  assert.equal(status.storedCluster, null);
  assert.equal(status.runtimeConfigStored, false);
});

test('when the stored config is the one in effect, it is not also shown as shadowed', async () => {
  const env = envWith();
  resetDbLifecycleForTests();
  await saveRuntimeConfig(env as never, twoNodeCluster());

  const status = await readStatus(env);

  assert.equal(status.cluster.source, 'runtime');
  assert.equal(status.storedClusterActive, true);
  assert.equal(status.envOverrideActive, false);
  assert.equal(status.storedCluster?.nodes.length, 2);
});
