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

let initializedKey: string | null = null;
let dbInitError: string | null = null;
/** In-flight schema init per database target (see S-1 in the review notes). */
const initPromises = new Map<string, Promise<void>>();

export function getDbInitError(): string | null {
  return dbInitError;
}

export function isDbInitialized(): boolean {
  return initializedKey !== null;
}

/** Forget the "already initialized" state so the next call re-runs the schema. */
export function resetDbLifecycle(): void {
  initializedKey = null;
  dbInitError = null;
  initPromises.clear();
}

/** Test hook: clear module state between test cases. */
export function resetDbLifecycleForTests(): void {
  resetDbLifecycle();
  // StorageService caches verified databases; clear it so tests can observe
  // initialization independently.
  StorageService.invalidateSchemaCache();
}

function attachDatabase(env: Env, db: D1Database): void {
  (env as { DB: D1Database }).DB = db;
}

/**
 * Resolve the storage backend, attach it to `env.DB` for this request, and
 * (once per database target) create/migrate the schema.
 *
 * The schema step is keyed by the resolved database (D1 vs a specific MySQL
 * host/database) instead of a process-wide boolean: pointing the app at another
 * database at runtime must run the schema again, otherwise the new database is
 * used without any tables.
 *
 * `resolve` is injectable for tests; production callers use getDatabase().
 */
export async function ensureDatabaseInitialized(
  env: Env,
  resolve: DbResolver = getDatabase
): Promise<void> {
  let db: D1Database | null = null;
  try {
    // getDatabase() is cached, so this is a no-op lookup in the steady state.
    db = await resolve(env);
  } catch (error) {
    dbInitError = error instanceof Error ? error.message : String(error);
    console.error('Failed to resolve database for request env:', error);
    return;
  }

  if (!db) {
    // Node runtime without DB_* env vars and without a stored config: the D1
    // binding does not exist here, so there is nothing to talk to. Report it as
    // an init error (controlled 500) instead of crashing on null.prepare later.
    dbInitError = 'No database configured: set DB_* env vars or use /admin/database.';
    console.error(dbInitError);
    return;
  }

  // See the module doc comment: the Node runtime hands each request a fresh env
  // with DB = null, so the attachment has to happen on every call.
  attachDatabase(env, db);

  const schemaKey = StorageService.schemaKeyFor(db);
  if (initializedKey === schemaKey) return;

  // One promise *per database*, not one per process: while the schema for the
  // old database is still being created, a request that already sees the new
  // config must not await that promise and then run on tables that do not exist
  // yet. The window is only a few hundred ms, but it is exactly when the admin
  // page and its polling are hammering the server.
  let pending = initPromises.get(schemaKey);
  if (!pending) {
    pending = (async () => {
      await new StorageService(db).initializeDatabase();
      initializedKey = schemaKey;
      dbInitError = null;
    })()
      .catch((error: unknown) => {
        dbInitError = error instanceof Error ? error.message : String(error);
        console.error('Database initialization failed:', error);
      })
      .finally(() => {
        initPromises.delete(schemaKey);
      });
    initPromises.set(schemaKey, pending);
  }
  await pending;
}
