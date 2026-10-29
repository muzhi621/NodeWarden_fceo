// Regression tests for the per-request env.DB attachment (db-lifecycle).
//
// Bug (Aliyun FC / Node runtime): `buildEnv()` creates a fresh env object per
// request with `DB: null`. The old ensureDatabaseInitialized() only swapped the
// resolved database in during the one-time schema init, so every request after
// the first ran with env.DB === null and crashed:
//   TypeError: Cannot read properties of null (reading 'prepare')
//     at getUserCount / RateLimitService.ensureStrictBudgetTable
// ("Internal server error" on account creation).
//
// Run: npx tsx --test scripts/db-lifecycle.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureDatabaseInitialized,
  getDbInitError,
  isDbInitialized,
  resetDbLifecycleForTests,
} from '../src/services/db-lifecycle';
import type { Env } from '../src/types';

interface MockDb {
  db: D1Database;
  sqls: string[];
}

function mockD1(): MockDb {
  const sqls: string[] = [];
  const statement = (sql: string) => ({
    bind(..._values: unknown[]) {
      return statement(sql);
    },
    async first<T>(): Promise<T | null> {
      sqls.push(`first:${sql}`);
      // Non-null row keeps push-relay's ensurePushInstallationCredentials from
      // calling the real Bitwarden push API (credentials look pre-configured).
      return { value: 'preset' } as unknown as T;
    },
    async run() {
      sqls.push(`run:${sql}`);
      return { success: true, results: [], meta: {} };
    },
    async all<T>(): Promise<{ results: T[]; meta: unknown }> {
      sqls.push(`all:${sql}`);
      return { results: [] as T[], meta: {} };
    },
  });
  const db = {
    prepare(sql: string) {
      sqls.push(`prepare:${sql}`);
      return statement(sql);
    },
    async batch(statements: unknown[]) {
      for (const _stmt of statements) sqls.push('run:batch');
      return [];
    },
  };
  return { db: db as unknown as D1Database, sqls };
}

function freshEnv(): Env {
  // Mirrors server/index.ts buildEnv(): every request starts with DB = null.
  return { DB: null as unknown as D1Database } as Env;
}

function countInitRuns(sqls: string[]): number {
  // ensureStorageSchema() emits this once per schema initialization.
  return sqls.filter((s) => s === 'run:PRAGMA foreign_keys = ON').length;
}

test('regression: second request with a fresh env still gets env.DB attached', async () => {
  resetDbLifecycleForTests();
  const mock = mockD1();
  const resolve = async () => mock.db;

  // Request #1 (e.g. web bootstrap) — the old code handled this one.
  const env1 = freshEnv();
  await ensureDatabaseInitialized(env1, resolve);
  assert.equal(env1.DB, mock.db, 'request 1: env.DB must be attached');

  // Request #2 (e.g. account creation) — crashed with null.prepare before.
  const env2 = freshEnv();
  await ensureDatabaseInitialized(env2, resolve);
  assert.equal(env2.DB, mock.db, 'request 2: env.DB must be re-attached on a fresh env');
  assert.equal(typeof env2.DB.prepare, 'function');
  assert.doesNotThrow(() => env2.DB.prepare('SELECT 1').bind(1));
  assert.equal(getDbInitError(), null);
});

test('schema initialization runs exactly once across requests', async () => {
  resetDbLifecycleForTests();
  const mock = mockD1();
  const resolve = async () => mock.db;

  await ensureDatabaseInitialized(freshEnv(), resolve);
  await ensureDatabaseInitialized(freshEnv(), resolve);
  await ensureDatabaseInitialized(freshEnv(), resolve);

  assert.equal(countInitRuns(mock.sqls), 1, 'CREATE TABLE config must run once');
  assert.ok(isDbInitialized());
});

test('concurrent first requests: all get DB attached, init runs once', async () => {
  resetDbLifecycleForTests();
  const mock = mockD1();
  const resolve = async () => mock.db;

  const envs = [freshEnv(), freshEnv(), freshEnv()];
  await Promise.all(envs.map((env) => ensureDatabaseInitialized(env, resolve)));

  for (const env of envs) {
    assert.equal(env.DB, mock.db);
  }
  assert.equal(countInitRuns(mock.sqls), 1);
});

test('init failure surfaces getDbInitError and recovers on retry', async () => {
  resetDbLifecycleForTests();
  const mock = mockD1();
  let fail = true;
  const resolve = async () => {
    if (fail) throw new Error('connect ECONNREFUSED 127.0.0.1:3306');
    return mock.db;
  };

  const env1 = freshEnv();
  await ensureDatabaseInitialized(env1, resolve);
  assert.ok(getDbInitError(), 'failure must be reported via getDbInitError()');
  assert.ok(!isDbInitialized());

  fail = false;
  const env2 = freshEnv();
  await ensureDatabaseInitialized(env2, resolve);
  assert.equal(getDbInitError(), null);
  assert.equal(env2.DB, mock.db);
  assert.ok(isDbInitialized());
});

test('new StorageService(env.DB).getUserCount works after attach (FC crash shape)', async () => {
  resetDbLifecycleForTests();
  const mock = mockD1();
  const resolve = async () => mock.db;

  // Two requests first — exactly the FC traffic pattern that crashed.
  await ensureDatabaseInitialized(freshEnv(), resolve);
  const env = freshEnv();
  await ensureDatabaseInitialized(env, resolve);

  // This is what the account-creation handler does; it used to throw
  // "Cannot read properties of null (reading 'prepare')".
  const { StorageService } = await import('../src/services/storage');
  const storage = new StorageService(env.DB);
  const count = await storage.getUserCount();
  assert.equal(typeof count, 'number');
});
