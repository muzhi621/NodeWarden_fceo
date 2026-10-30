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
import { writeAuditEvent } from '../services/audit-events';
import { readEnv } from '../services/runtime-env';

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Reject targets that turn the admin "test connection" form into an internal
 * network probe. A serverless function usually sits inside a VPC where private
 * ranges, link-local metadata endpoints and localhost are reachable; letting an
 * admin (or a stolen admin token) dial arbitrary host:port pairs exposes them.
 * DB_HOST_ALLOWLIST lets a self-hosted-in-VPC deployment opt back in.
 *
 * Implemented with plain string checks on purpose: this module is bundled for
 * Cloudflare Workers too, where `node:net` is not available.
 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) // link-local, includes 169.254.169.254 metadata
  );
}

function assertHostAllowed(host: string): string | null {
  const allowlist = (readEnv('DB_HOST_ALLOWLIST') || '')
    .split(',')
    .map((entry: string) => entry.trim())
    .filter(Boolean);
  if (allowlist.includes(host)) return null;

  const lowered = host.toLowerCase();
  if (lowered === 'localhost' || lowered.endsWith('.local') || lowered.endsWith('.internal')) {
    return 'host not allowed';
  }
  if (isPrivateIpv4(lowered)) return 'host not allowed';
  // IPv6 literals: block loopback / unique-local / link-local.
  if (lowered.includes(':') && /^(::1$|::ffff:|fc|fd|fe80)/i.test(lowered)) return 'host not allowed';
  return null;
}

/** Coarse failure class: useful for an admin, useless for a port scanner. */
function classifyConnectionError(error: unknown): string {
  const code = String((error as { code?: string })?.code ?? '');
  const msg = error instanceof Error ? error.message : String(error);
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return 'refused';
  if (code === 'ETIMEDOUT' || /ETIMEDOUT|timeout/i.test(msg)) return 'timeout';
  if (code === 'ENOTFOUND' || /ENOTFOUND/.test(msg)) return 'dns';
  if (/Access denied/i.test(msg)) return 'auth';
  if (/certificate|TLS|SSL|self[- ]signed/i.test(msg)) return 'tls';
  if (/Unknown database/i.test(msg)) return 'database';
  return 'unknown';
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
  errorKind?: string;
}> {
  const blocked = assertHostAllowed(config.host || '');
  if (blocked) {
    // Same shape as a failed connection so the response cannot be used to tell
    // "blocked by policy" apart from "host does not exist".
    return { ok: false, latencyMs: 0, error: blocked, errorKind: 'blocked' };
  }
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
    const kind = classifyConnectionError(error);
    console.error('[db-config] connection test failed', {
      host: config.host,
      port: config.port,
      kind,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: `connection failed (${kind})`,
      errorKind: kind,
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
  const body = await readJsonBody(request);

  if (body.mode === 'd1') {
    await clearRuntimeConfig(env);
    await resetDatabaseCache();
    await auditDbConfigChange(env, actorUser, 'admin.db_config.cleared', null);
    return jsonResponse({ ok: true, mode: 'd1', effective: true });
  }

  const stored = await loadRuntimeConfig(env);
  const { config, error } = normalizeCandidate(body, stored);
  if (error) return errorResponse(error, 400);

  const test = await testMySqlConnection(config);
  if (!test.ok) {
    return jsonResponse({ ok: false, error: test.error ?? 'connection test failed', errorKind: test.errorKind }, 502);
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

  // Rebuild the pool with the new settings and bootstrap the schema. The schema
  // step is keyed by the target database, so a freshly configured MySQL really
  // gets its tables (a process-wide "already initialized" flag used to skip it).
  await resetDatabaseCache();
  const db = await getDatabase(env);
  (env as { DB: D1Database }).DB = db;
  const storage = new StorageService(db);
  let schemaReady = false;
  let schemaError: string | undefined;
  try {
    await storage.initializeDatabase();
    schemaReady = true;
  } catch (initError) {
    schemaError = initError instanceof Error ? initError.message : String(initError);
    console.error('[db-config] schema bootstrap failed after save:', initError);
  }

  // Env vars win over the runtime config (see resolveDbConfig), so "saved" must
  // not be reported as "in effect" when DB_* is set.
  const envOverride = !!resolveDbConfigFromEnv(env);
  await auditDbConfigChange(env, actorUser, 'admin.db_config.saved', config);

  return jsonResponse({
    ok: true,
    mode: 'mysql',
    saved: true,
    effective: !envOverride && schemaReady,
    warning: envOverride
      ? 'DB_* 环境变量优先于运行时配置：配置已保存，但当前生效的仍是环境变量指向的数据库。'
      : schemaError
        ? `配置已保存，但建表失败：${schemaError}`
        : undefined,
    schemaReady,
    latencyMs: test.latencyMs,
    version: test.version,
  });
}

export async function handleAdminClearDbConfig(request: Request, env: Env, actorUser: User): Promise<Response> {
  void request;
  await clearRuntimeConfig(env);
  await resetDatabaseCache();
  await auditDbConfigChange(env, actorUser, 'admin.db_config.cleared', null);
  return jsonResponse({ ok: true, mode: 'd1' });
}

/** Changing where the database lives is a high-privilege action: keep a trail. */
async function auditDbConfigChange(
  env: Env,
  actorUser: User,
  action: string,
  config: DbRuntimeConfig | null
): Promise<void> {
  if (!env.DB) return;
  const target = config ? `${config.host}:${config.port ?? 3306}/${config.database ?? ''}` : 'd1';
  try {
    await writeAuditEvent(new StorageService(env.DB), {
      actorUserId: actorUser.id,
      action,
      category: 'system',
      level: 'security',
      targetType: 'database',
      targetId: target,
      metadata: { destinationName: target, destinationType: config ? 'mysql' : 'd1', status: 'ok' },
    });
  } catch (error) {
    // Auditing must never break the config change itself.
    console.error('[db-config] audit write failed:', error);
  }
}
