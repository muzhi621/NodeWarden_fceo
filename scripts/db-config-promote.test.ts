// Guards for POST /api/admin/db-config/promote (review round 6, S5).
// Run: npx tsx --test scripts/db-config-promote.test.ts
//
// The promote endpoint is the one an operator reaches for *during* an incident,
// so every refusal has to happen before the config is written. These cases all
// run without a MySQL server: they assert that the handler stops at the right
// gate and that the stored config is byte-for-byte unchanged afterwards.

import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAdminPromoteDbNode } from '../src/handlers/admin-db-config';
import {
  loadRuntimeConfig,
  saveRuntimeConfig,
  type DbRuntimeConfigV2,
} from '../src/services/db-config';
import { resetDatabaseCache } from '../src/services/storage-factory';
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

function freshEnv(overrides: Record<string, unknown> = {}): { env: Record<string, unknown>; kv: MemoryKv } {
  // A new KV per test keeps the payload cache (keyed by store object) isolated.
  const kv = memoryKv();
  const env = { SETTINGS_KV: kv, DB_CONFIG_KEY: 'test-passphrase-for-db-config', DB: null, ...overrides };
  return { env, kv };
}

const actor = { id: 'user-admin', email: 'admin@example.com' } as never;

function cluster(overrides: Partial<DbRuntimeConfigV2> = {}): DbRuntimeConfigV2 {
  return {
    version: 2,
    mode: 'mysql',
    nodes: [
      {
        id: 'a',
        label: '主库A',
        role: 'primary',
        priority: 1,
        enabled: true,
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
        enabled: true,
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
      syncMode: 'write-through',
      syncAsync: false,
      failoverEnabled: true,
      failureThreshold: 3,
      cooldownMs: 30_000,
    },
    ...overrides,
  };
}

function promoteRequest(body: Record<string, unknown>, search = ''): Request {
  return new Request(`https://example.com/api/admin/db-config/promote${search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The stored config must be untouched after a refused promote. */
async function assertUnchanged(env: Record<string, unknown>, before: DbRuntimeConfigV2): Promise<void> {
  const after = await loadRuntimeConfig(env as never);
  assert.deepEqual(after, before, 'a refused promote must not rewrite the stored config');
}

test('a request without nodeId is rejected before anything else', async () => {
  const { env } = freshEnv();
  const stored = cluster();
  await saveRuntimeConfig(env as never, stored);

  const response = await handleAdminPromoteDbNode(promoteRequest({}), env as never, actor);

  assert.equal(response.status, 400);
  await assertUnchanged(env, stored);
});

test('an unknown node is a 404, not a silent no-op', async () => {
  const { env } = freshEnv();
  const stored = cluster();
  await saveRuntimeConfig(env as never, stored);

  const response = await handleAdminPromoteDbNode(promoteRequest({ nodeId: 'nope' }), env as never, actor);

  assert.equal(response.status, 404);
  await assertUnchanged(env, stored);
});

test('a disabled node cannot take over: it would not be in rotation at all', async () => {
  const { env } = freshEnv();
  const stored = cluster();
  stored.nodes[1].enabled = false;
  await saveRuntimeConfig(env as never, stored);

  const response = await handleAdminPromoteDbNode(promoteRequest({ nodeId: 'b' }), env as never, actor);

  assert.equal(response.status, 409);
  assert.match(String(((await response.json()) as { error?: string }).error), /停用/);
  await assertUnchanged(env, stored);
});

test('promoting the current primary is a no-op, not a role flip', async () => {
  const { env } = freshEnv();
  const stored = cluster();
  await saveRuntimeConfig(env as never, stored);

  const response = await handleAdminPromoteDbNode(promoteRequest({ nodeId: 'a' }), env as never, actor);

  assert.equal(response.status, 400);
  await assertUnchanged(env, stored);
});

test('DB_* environment variables win: the switch would be a lie', async () => {
  const { env } = freshEnv({ DB_HOST: 'env-db.example.com', DB_USER: 'u', DB_NAME: 'nw' });
  const stored = cluster();
  await saveRuntimeConfig(env as never, stored);

  const response = await handleAdminPromoteDbNode(promoteRequest({ nodeId: 'b' }), env as never, actor);

  assert.equal(response.status, 409);
  assert.match(String(((await response.json()) as { error?: string }).error), /环境变量/);
  await assertUnchanged(env, stored);
});

test('an unreachable target is refused and nothing is written', async () => {
  const { env } = freshEnv();
  const stored = cluster();
  // Loopback is rejected by the host policy before a socket is opened, which is
  // the same outcome as a refused connection: the target cannot be used.
  stored.nodes[1] = { ...stored.nodes[1], host: '127.0.0.1', port: 9 };
  await saveRuntimeConfig(env as never, stored);
  delete process.env.DB_HOST_ALLOWLIST;

  const response = await handleAdminPromoteDbNode(promoteRequest({ nodeId: 'b' }), env as never, actor);

  assert.equal(response.status, 502);
  await assertUnchanged(env, stored);
});

test('no stored config means there is nothing to switch', async () => {
  const { env } = freshEnv();
  const response = await handleAdminPromoteDbNode(promoteRequest({ nodeId: 'b' }), env as never, actor);
  assert.equal(response.status, 400);
});

// Keep the module-level pool/cache state from leaking between cases.
test.after(async () => {
  await resetDatabaseCache();
  resetDbLifecycleForTests();
});
