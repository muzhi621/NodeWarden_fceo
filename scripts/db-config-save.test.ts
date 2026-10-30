// Tests for the admin db-config save/clear flow (review round 2, B-3).
// Run: npx tsx --test scripts/db-config-save.test.ts
//
// These cover the two ways the previous order (persist first, validate later)
// could lock the deployment out of its own admin page.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleAdminClearDbConfig,
  handleAdminSaveDbConfig,
} from '../src/handlers/admin-db-config';

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

function envWith(overrides: Record<string, unknown> = {}): { env: Record<string, unknown>; kv: MemoryKv } {
  const kv = memoryKv();
  const env = { SETTINGS_KV: kv, DB_CONFIG_KEY: 'test-passphrase-for-db-config', DB: null, ...overrides };
  return { env, kv };
}

const actor = { id: 'user-admin', email: 'admin@example.com' } as never;

function saveRequest(body: Record<string, unknown>, search = ''): Request {
  return new Request(`https://example.com/api/admin/db-config${search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('a host rejected by policy is never persisted (B-3)', async () => {
  const { env, kv } = envWith();
  delete process.env.DB_HOST_ALLOWLIST;
  const response = await handleAdminSaveDbConfig(
    saveRequest({ host: 'localtest.me', user: 'u', password: 'p', database: 'd' }),
    env as never,
    actor
  );
  assert.equal(response.status, 502);
  const body = (await response.json()) as { errorKind?: string; saved?: boolean };
  assert.equal(body.errorKind, 'blocked');
  assert.equal(body.saved, undefined);
  assert.equal(kv.entries.size, 0, 'the config store must stay empty when the save is rejected');
});

test('clearing the config is refused when it would leave no database at all (B-3)', async () => {
  const { env } = envWith();
  const response = await handleAdminClearDbConfig(
    new Request('https://example.com/api/admin/db-config', { method: 'DELETE' }),
    env as never,
    actor
  );
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error?: string };
  assert.match(String(body.error), /force=1/);
});

test('clearing the config stays possible when env vars still point at a database (B-3)', async () => {
  const { env, kv } = envWith({ DB_HOST: 'db.example.com', DB_USER: 'u', DB_NAME: 'd' });
  await kv.put('db-config:v1', 'sentinel');
  const response = await handleAdminClearDbConfig(
    new Request('https://example.com/api/admin/db-config', { method: 'DELETE' }),
    env as never,
    actor
  );
  assert.equal(response.status, 200);
  assert.equal(kv.entries.has('db-config:v1'), false, 'the stored runtime config must be gone');
});

test('force=1 allows clearing even without a fallback database (B-3)', async () => {
  const { env } = envWith();
  const response = await handleAdminClearDbConfig(
    new Request('https://example.com/api/admin/db-config?force=1', { method: 'DELETE' }),
    env as never,
    actor
  );
  assert.equal(response.status, 200);
});
