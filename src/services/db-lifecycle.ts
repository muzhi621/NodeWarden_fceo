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
/**
 * Latched init failure.
 *
 * `status` is only set for failures whose message was written for a human (the
 * cluster adapter's "no node can take the write" / "no database configured"
 * errors). Those are answered with their own status and text instead of the
 * generic 500, which used to tell an operator nothing at all — on a Node runtime
 * they may not even have access to the logs.
 */
interface DbInitFailure {
  message: string;
  status?: number;
}
let dbInitFailure: DbInitFailure | null = null;
/** In-flight schema init per database target (see S-1 in the review notes). */
const initPromises = new Map<string, Promise<void>>();

/**
 * Backoff for a target whose schema init failed.
 *
 * A standby that is unreachable used to be retried by *every* request, and the
 * init is awaited on the request path: with a 10s connect timeout a hung standby
 * added 10 seconds to each request while the primary was perfectly healthy (S1).
 * The failure is not permanent, so the target is retried after a growing delay
 * instead of being dropped.
 */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
const retryAfter = new Map<string, number>();
const failureCounts = new Map<string, number>();

export function getDbInitError(): string | null {
  return dbInitFailure?.message ?? null;
}

/**
 * The latched failure together with the status it was raised with (if any).
 *
 * Only messages that were authored for the operator carry a status; anything
 * else is a raw driver error and must keep the generic "check the logs" answer.
 */
export function getDbInitFailure(): DbInitFailure | null {
  return dbInitFailure;
}

export function isDbInitialized(): boolean {
  return initializedKeys.size > 0;
}

/** Forget the "already initialized" state so the next call re-runs the schema. */
export function resetDbLifecycle(): void {
  initializedKeys.clear();
  dbInitFailure = null;
  initPromises.clear();
  retryAfter.clear();
  failureCounts.clear();
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

  // Skipping inside the backoff window is the whole point: the request must not
  // pay for a standby that was unreachable a moment ago (S1).
  const retryAt = retryAfter.get(target.key);
  if (retryAt !== undefined && Date.now() < retryAt) return;

  let pending = initPromises.get(target.key);
  if (!pending) {
    pending = (async () => {
      await new StorageService(target.db).initializeDatabase();
      initializedKeys.add(target.key);
      retryAfter.delete(target.key);
      failureCounts.delete(target.key);
      if (target.isPrimary) dbInitFailure = null;
    })()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const previous = failureCounts.get(target.key) ?? 0;
        failureCounts.set(target.key, previous + 1);
        const delay = Math.min(RETRY_BASE_MS * 2 ** previous, RETRY_MAX_MS);
        retryAfter.set(target.key, Date.now() + delay);
        // A standby that cannot be migrated is reported (it would fail the
        // moment it takes over) but must not take the running primary down.
        if (target.isPrimary) dbInitFailure = { message };
        console.error(
          `[db-lifecycle] schema init failed for ${target.key}${target.isPrimary ? ' (primary)' : ' (standby)'}; ` +
            `retrying in ${Math.round(delay / 1000)}s:`,
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
    const message = error instanceof Error ? error.message : String(error);
    // A cluster-level refusal ("every node is disabled", "no database is
    // configured") explains itself, so it is passed through to the client with
    // its own status. Everything else stays behind the generic 500.
    const status = Number((error as { status?: unknown })?.status ?? 0);
    dbInitFailure =
      status === 503 && error instanceof Error && error.name === 'DbClusterUnavailableError'
        ? { message, status }
        : { message };
    console.error('Failed to resolve database for request env:', error);
    return;
  }

  if (!db) {
    // Node runtime without DB_* env vars and without a stored config: the D1
    // binding does not exist here, so there is nothing to talk to. Report it as
    // an init error (controlled 500) instead of crashing on null.prepare later.
    dbInitFailure = { message: 'No database configured: set DB_* env vars or use /admin/database.' };
    console.error(dbInitFailure.message);
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
    if (dbInitFailure) {
      dbInitFailure = null;
      console.warn('[db-lifecycle] cleared a stale database init error: the same database resolved successfully again.');
    }
    return;
  }

  // The primary is awaited so the request never runs on half-created tables.
  // Standbys are migrated in the same pass; their failures are logged, not fatal.
  await Promise.all(targets.map((target) => initializeTarget(target)));
}
