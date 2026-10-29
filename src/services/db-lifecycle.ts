// Database lifecycle shared by the Cloudflare Worker entry (src/index.ts) and
// the Node runtime entry (server/index.ts).
//
// Responsibilities:
//   1. Resolve the storage backend (D1 or the BYO MySQL adapter) via
//      storage-factory.getDatabase — cached after the first connect.
//   2. Attach it to `env.DB` for **every** request.
//   3. Run the idempotent schema creation exactly once per process.
//
// Why (2) is not folded into (3): the Node runtime (server/index.ts) builds a
// fresh env object per request (`buildEnv()` starts with `DB: null`). If the
// resolved database is only swapped in during the one-time schema init, every
// request after the first sees `env.DB === null` and each
// `new StorageService(env.DB)` crashes on `null.prepare(...)` (FC log:
// "Cannot read properties of null (reading 'prepare')" on account creation).
// Re-attaching per request is cheap: getDatabase() returns the cached pool.

import type { Env } from '../types';
import { StorageService } from './storage';
import { getDatabase } from './storage-factory';

export type DbResolver = (env: Env) => Promise<D1Database>;

let dbInitialized = false;
let dbInitError: string | null = null;
let dbInitPromise: Promise<void> | null = null;

export function getDbInitError(): string | null {
  return dbInitError;
}

export function isDbInitialized(): boolean {
  return dbInitialized;
}

/** Test hook: clear module state between test cases. */
export function resetDbLifecycleForTests(): void {
  dbInitialized = false;
  dbInitError = null;
  dbInitPromise = null;
  // StorageService gates schema creation on a static flag; reset it too so
  // tests can observe initialization independently.
  (StorageService as unknown as { schemaVerified: boolean }).schemaVerified = false;
}

function attachDatabase(env: Env, db: D1Database): void {
  (env as { DB: D1Database }).DB = db;
}

/**
 * Resolve the storage backend, attach it to `env.DB` for this request, and
 * (once per process) create/migrate the schema.
 *
 * `resolve` is injectable for tests; production callers use getDatabase().
 */
export async function ensureDatabaseInitialized(
  env: Env,
  resolve: DbResolver = getDatabase
): Promise<void> {
  if (!dbInitialized && !dbInitPromise) {
    dbInitPromise = (async () => {
      const db = await resolve(env);
      attachDatabase(env, db);
      const storage = new StorageService(db);
      await storage.initializeDatabase();
      dbInitialized = true;
    })()
      .catch((error: unknown) => {
        dbInitError = error instanceof Error ? error.message : String(error);
        console.error('Database initialization failed:', error);
      })
      .finally(() => {
        dbInitPromise = null;
      });
  }
  if (dbInitPromise) await dbInitPromise;

  // Always (re)attach the resolved DB to *this* request's env — see the module
  // doc comment. The Node runtime hands each request a fresh env with DB=null.
  if (dbInitialized) {
    try {
      attachDatabase(env, await resolve(env));
      dbInitError = null;
    } catch (error) {
      dbInitError = error instanceof Error ? error.message : String(error);
      console.error('Failed to resolve database for request env:', error);
    }
  }
}
