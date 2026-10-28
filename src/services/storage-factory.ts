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
}): string {
  return [config.mode, config.host, config.port, config.user, config.database, config.ssl].join('|');
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
}

export async function getDatabaseStatus(env: Env): Promise<{ mode: 'mysql' | 'd1'; source: string; ok: boolean; error?: string; version?: string }> {
  try {
    const config = await resolveDbConfig(env);
    if (config.mode === 'd1' && !env.DB) {
      return {
        mode: 'd1',
        source: 'd1',
        ok: false,
        error: 'D1 binding missing on this runtime. Configure an external MySQL (DB_* env vars or the admin UI at /admin/database).',
      };
    }
    const db = await getDatabase(env);
    if (config.mode === 'mysql') {
      const row = await db.prepare('SELECT VERSION() AS version').first<{ version: string }>();
      return { mode: 'mysql', source: config.source, ok: true, version: row?.version };
    }
    await db.prepare('SELECT 1 AS ok').first();
    return { mode: 'd1', source: 'd1', ok: true };
  } catch (error) {
    return {
      mode: 'd1',
      source: 'd1',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
