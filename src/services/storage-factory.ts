// Chooses the storage backend for the current request lifecycle:
// D1 (default, Cloudflare Workers) or the BYO MySQL adapter (Node runtimes
// with an external database configured via env vars / admin UI).

import type { Env } from '../types';
import { resolveDbConfig } from './db-config';
import { MySqlDatabase, isMySqlDatabase } from './storage-mysql';

interface CachedDatabase {
  cacheKey: string;
  db: D1Database;
}

let cached: CachedDatabase | null = null;

function cacheKeyFor(config: {
  mode: string;
  host: string;
  port: number;
  user: string;
  database: string;
  ssl: boolean;
  connectionLimit: number;
  password: string;
}): string {
  // JSON.stringify (not a '|' join): the password may contain those
  // characters, making a joined key ambiguous. The credentials and pool size
  // are part of the key: a config change that bypasses the admin save path
  // (KV written directly) must produce a fresh pool, not a stale one that
  // keeps the old password (S-11 in the review notes).
  return JSON.stringify([
    config.mode,
    config.host,
    config.port,
    config.user,
    config.database,
    config.ssl,
    config.connectionLimit,
    config.password,
  ]);
}

export async function getDatabase(env: Env): Promise<D1Database> {
  const config = await resolveDbConfig(env);
  if (config.mode !== 'mysql') {
    return env.DB;
  }
  const cacheKey = cacheKeyFor(config);
  if (cached && cached.cacheKey === cacheKey) {
    return cached.db;
  }
  if (cached && isMySqlDatabase(cached.db)) {
    await cached.db.close();
  }
  const db = new MySqlDatabase({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
    connectionLimit: config.connectionLimit,
    connectTimeoutMs: 10_000,
  });
  cached = { cacheKey, db: db as unknown as D1Database };
  return cached.db;
}

/** Drop the cached pool so the next request reconnects with fresh settings. */
export async function resetDatabaseCache(): Promise<void> {
  if (cached && isMySqlDatabase(cached.db)) {
    await cached.db.close();
  }
  cached = null;
  statusCache = null;
}

/**
 * `/healthz` is unauthenticated and polled by monitoring; every call used to cost
 * a full MySQL round trip (`SELECT VERSION()`) on a pool of five connections, so
 * hammering the endpoint could starve real traffic. Results are cached briefly —
 * long enough to absorb polling, short enough that a real outage still shows up.
 */
const STATUS_CACHE_MS = 5_000;
let statusCache: { key: string; at: number; value: DatabaseStatus } | null = null;

export interface DatabaseStatus {
  mode: 'mysql' | 'd1';
  source: string;
  ok: boolean;
  error?: string;
  version?: string;
}

export async function getDatabaseStatus(env: Env): Promise<DatabaseStatus> {
  let mode: 'mysql' | 'd1' = 'd1';
  let source = 'd1';
  let cacheKey = 'd1';
  try {
    const config = await resolveDbConfig(env);
    mode = config.mode;
    source = config.source;
    cacheKey = [config.mode, config.host, config.port, config.database].join('|');

    if (statusCache && statusCache.key === cacheKey && Date.now() - statusCache.at < STATUS_CACHE_MS) {
      return statusCache.value;
    }

    if (config.mode === 'd1' && !env.DB) {
      const missing: DatabaseStatus = {
        mode: 'd1',
        source: 'd1',
        ok: false,
        error: 'D1 binding missing on this runtime. Configure an external MySQL (DB_* env vars or the admin UI at /admin/database).',
      };
      statusCache = { key: cacheKey, at: Date.now(), value: missing };
      return missing;
    }
    const db = await getDatabase(env);
    if (config.mode === 'mysql') {
      const row = await db.prepare('SELECT VERSION() AS version').first<{ version: string }>();
      const status: DatabaseStatus = { mode: 'mysql', source: config.source, ok: true, version: row?.version };
      statusCache = { key: cacheKey, at: Date.now(), value: status };
      return status;
    }
    await db.prepare('SELECT 1 AS ok').first();
    const status: DatabaseStatus = { mode: 'd1', source: 'd1', ok: true };
    statusCache = { key: cacheKey, at: Date.now(), value: status };
    return status;
  } catch (error) {
    // Keep the real mode: reporting `mode: 'd1'` for a broken MySQL made the
    // health output actively misleading for whoever reads the dashboard.
    return {
      mode,
      source,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
