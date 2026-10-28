// Admin API for the BYO-DB (external MySQL) configuration.
//
//   GET  /api/admin/db-config        -> masked current config
//   POST /api/admin/db-config/test   -> test a candidate config (does not persist)
//   POST /api/admin/db-config        -> save config (encrypted), re-init schema
//   DELETE /api/admin/db-config      -> clear runtime config (back to D1 / env)

import type { Env, User } from '../types';
import { jsonResponse, errorResponse } from '../utils/response';
import {
  clearRuntimeConfig,
  hasConfigStore,
  loadRuntimeConfig,
  maskConfig,
  resolveDbConfig,
  resolveDbConfigFromEnv,
  saveRuntimeConfig,
  type DbRuntimeConfig,
} from '../services/db-config';
import { resetDatabaseCache, getDatabase } from '../services/storage-factory';
import { MySqlDatabase } from '../services/storage-mysql';
import { StorageService } from '../services/storage';

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeCandidate(body: Record<string, unknown>, fallback?: DbRuntimeConfig | null): {
  config: DbRuntimeConfig;
  error?: string;
} {
  const host = String(body.host ?? fallback?.host ?? '').trim();
  const user = String(body.user ?? fallback?.user ?? '').trim();
  const database = String(body.database ?? fallback?.database ?? '').trim();
  const passwordRaw = body.password;
  const password = typeof passwordRaw === 'string' && passwordRaw.length > 0
    ? passwordRaw
    : (fallback?.password ?? '');
  const port = Number(body.port ?? fallback?.port ?? 3306);
  const connectionLimit = Number(body.connectionLimit ?? fallback?.connectionLimit ?? 5);
  const ssl = body.ssl === undefined ? (fallback?.ssl !== false) : !!body.ssl;

  if (!host) return { config: fallback ?? { version: 1, mode: 'd1' }, error: 'host is required' };
  if (!user) return { config: fallback ?? { version: 1, mode: 'd1' }, error: 'user is required' };
  if (!database) return { config: fallback ?? { version: 1, mode: 'd1' }, error: 'database is required' };
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { config: fallback ?? { version: 1, mode: 'd1' }, error: 'invalid port' };
  }

  return {
    config: {
      version: 1,
      mode: 'mysql',
      host,
      port: Math.floor(port),
      user,
      password,
      database,
      ssl,
      connectionLimit: Number.isFinite(connectionLimit) && connectionLimit > 0 ? Math.floor(connectionLimit) : 5,
    },
  };
}

async function testMySqlConnection(config: DbRuntimeConfig): Promise<{
  ok: boolean;
  latencyMs: number;
  version?: string;
  schemaState?: string;
  error?: string;
}> {
  const startedAt = Date.now();
  const db = new MySqlDatabase({
    host: config.host || '',
    port: config.port || 3306,
    user: config.user || '',
    password: config.password || '',
    database: config.database || '',
    ssl: config.ssl !== false,
    connectionLimit: 1,
    connectTimeoutMs: 10_000,
  });
  try {
    const versionRow = await db.prepare('SELECT VERSION() AS version').first<{ version: string }>();
    let schemaState = 'empty';
    try {
      const tableRow = await db
        .prepare("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'")
        .first<{ n: number }>();
      schemaState = Number(tableRow?.n ?? 0) > 0 ? 'ready' : 'empty';
    } catch {
      schemaState = 'unknown';
    }
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      version: versionRow?.version,
      schemaState,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await db.close();
  }
}

export async function handleAdminGetDbConfig(request: Request, env: Env, actorUser: User): Promise<Response> {
  void request;
  void actorUser;
  const resolved = await resolveDbConfig(env);
  return jsonResponse({
    config: maskConfig(resolved),
    runtimeConfigStored: !!(await loadRuntimeConfig(env)),
    configStoreAvailable: hasConfigStore(env),
    envOverrideActive: !!resolveDbConfigFromEnv(env),
  });
}

export async function handleAdminTestDbConfig(request: Request, env: Env, actorUser: User): Promise<Response> {
  void actorUser;
  const body = await readJsonBody(request);
  const stored = await loadRuntimeConfig(env);
  const resolved = await resolveDbConfig(env);
  const fallback: DbRuntimeConfig | null = stored
    ?? (resolved.mode === 'mysql'
      ? {
          version: 1,
          mode: 'mysql',
          host: resolved.host,
          port: resolved.port,
          user: resolved.user,
          password: resolved.password,
          database: resolved.database,
          ssl: resolved.ssl,
          connectionLimit: resolved.connectionLimit,
        }
      : null);
  const { config, error } = normalizeCandidate(body, fallback);
  if (error) return errorResponse(error, 400);
  const result = await testMySqlConnection(config);
  return jsonResponse(result, result.ok ? 200 : 502);
}

export async function handleAdminSaveDbConfig(request: Request, env: Env, actorUser: User): Promise<Response> {
  void actorUser;
  const body = await readJsonBody(request);

  if (body.mode === 'd1') {
    await clearRuntimeConfig(env);
    await resetDatabaseCache();
    return jsonResponse({ ok: true, mode: 'd1' });
  }

  const stored = await loadRuntimeConfig(env);
  const { config, error } = normalizeCandidate(body, stored);
  if (error) return errorResponse(error, 400);

  const test = await testMySqlConnection(config);
  if (!test.ok) {
    return jsonResponse({ ok: false, error: test.error ?? 'connection test failed' }, 502);
  }

  const saved = await saveRuntimeConfig(env, config);
  if (!saved && !hasConfigStore(env)) {
    return errorResponse(
      'No config store available. Bind SETTINGS_KV (or ATTACHMENTS) or set DB_* environment variables instead.',
      400
    );
  }
  if (!saved) {
    return errorResponse('Failed to persist database config', 500);
  }

  // Rebuild the pool with the new settings and bootstrap the schema.
  await resetDatabaseCache();
  const db = await getDatabase(env);
  (env as { DB: D1Database }).DB = db;
  const storage = new StorageService(db);
  await storage.initializeDatabase();

  return jsonResponse({ ok: true, mode: 'mysql', schemaReady: true, latencyMs: test.latencyMs, version: test.version });
}

export async function handleAdminClearDbConfig(request: Request, env: Env, actorUser: User): Promise<Response> {
  void request;
  void actorUser;
  await clearRuntimeConfig(env);
  await resetDatabaseCache();
  return jsonResponse({ ok: true, mode: 'd1' });
}
