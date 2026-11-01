// Database lifecycle shared by the Cloudflare Worker entry (src/index.ts) and
// the Node runtime entry (server/index.ts).
//
// Responsibilities:
//   1. Resolve the storage backend (D1 or the BYO MySQL cluster) via
//      storage-factory.getDatabase — cached after the first connect.
//   2. Attach it to `env.DB` for **every** request.
//   3. Run the idempotent schema creation exactly once per **node**.
//
// Why (2) is not folded into (3): the Node runtime (server/index.ts) builds a
// fresh env object per request (`buildEnv()` starts with `DB: null`). If the
// resolved database is only swapped in during the one-time schema init, every
// request after the first sees `env.DB === null` and each
// `new StorageService(env.DB)` crashes on `null.prepare(...)` (FC log:
// "Cannot read properties of null (reading 'prepare')" on account creation).
// Re-attaching per request is cheap: getDatabase() returns the cached pool.
//
// Why (3) is per node: a cluster whose standby has no tables would accept the
// traffic failover sends it and answer every request with "table not found".
// Each node is migrated independently, so a standby that is merely unreachable
// does not block the primary.

import type { Env } from '../types';
import { clearDbConfigCache } from './db-config';
import { isMySqlClusterDatabase } from './db-cluster';
import { StorageService } from './storage';
import { getDatabase } from './storage-factory';

export type DbResolver = (env: Env) => Promise<D1Database>;

/** Schema keys already migrated in this process. */
const initializedKeys = new Set<string>();
let dbInitError: string | null = null;
/** In-flight schema init per database target (see S-1 in the review notes). */
const initPromises = new Map<string, Promise<void>>();

export function getDbInitError(): string | null {
  return dbInitError;
}

export function isDbInitialized(): boolean {
  return initializedKeys.size > 0;
}

/** Forget the "already initialized" state so the next call re-runs the schema. */
export function resetDbLifecycle(): void {
  initializedKeys.clear();
  dbInitError = null;
  initPromises.clear();
}

/** Test hook: clear module state between test cases. */
export function resetDbLifecycleForTests(): void {
  resetDbLifecycle();
  // The DB-config payload cache is keyed per store object; consecutive test
  // cases swap stores, so a stale entry would leak the previous config.
  clearDbConfigCache();
  // StorageService caches verified databases; clear it so tests can observe
  // initialization independently.
  StorageService.invalidateSchemaCache();
}

function attachDatabase(env: Env, db: D1Database): void {
  (env as { DB: D1Database }).DB = db;
}

interface SchemaTarget {
  key: string;
  db: D1Database;
  /** The primary is the only node whose failure makes the app unusable. */
  isPrimary: boolean;
}

function schemaTargets(db: D1Database): SchemaTarget[] {
  if (isMySqlClusterDatabase(db)) {
    return db.nodeDatabases().map((node, index) => ({
      key: StorageService.schemaKeyFor(node.db as unknown as D1Database),
      db: node.db as unknown as D1Database,
      isPrimary: index === 0,
    }));
  }
  return [{ key: StorageService.schemaKeyFor(db), db, isPrimary: true }];
}

async function initializeTarget(target: SchemaTarget): Promise<void> {
  if (initializedKeys.has(target.key)) return;

  let pending = initPromises.get(target.key);
  if (!pending) {
    pending = (async () => {
      await new StorageService(target.db).initializeDatabase();
      initializedKeys.add(target.key);
      if (target.isPrimary) dbInitError = null;
    })()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // A standby that cannot be migrated is reported (it would fail the
        // moment it takes over) but must not take the running primary down.
        if (target.isPrimary) dbInitError = message;
        console.error(
          `[db-lifecycle] schema init failed for ${target.key}${target.isPrimary ? ' (primary)' : ' (standby)'}:`,
          error
        );
      })
      .finally(() => {
        initPromises.delete(target.key);
      });
    initPromises.set(target.key, pending);
  }
  await pending;
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

  const targets = schemaTargets(db);
  const alreadyInitialized = targets.every((target) => initializedKeys.has(target.key));
  if (alreadyInitialized) {
    // This database was fully initialized at some point, but a later request
    // hit a transient failure (KV/R2 read timeout, pool creation error) that
    // latched dbInitError. This request resolved and attached the same
    // databases fine, so the error is stale: clear it instead of failing every
    // request until the process is recycled (C-1 in the review notes — the
    // admin "save config" path only resets the storage cache, not this latch).
    if (dbInitError) {
      dbInitError = null;
      console.warn('[db-lifecycle] cleared a stale database init error: the same database resolved successfully again.');
    }
    return;
  }

  // The primary is awaited so the request never runs on half-created tables.
  // Standbys are migrated in the same pass; their failures are logged, not fatal.
  await Promise.all(targets.map((target) => initializeTarget(target)));
}
