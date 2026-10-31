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
import { resetDbLifecycle } from '../services/db-lifecycle';
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
 * Two layers, because string matching alone is not a security boundary:
 *   1. Before connecting: resolve the name and reject if ANY answer is private
 *      (a plain string check misses `localtest.me`, `127.0.0.1.nip.io`, `lvh.me`
 *      and any other public DNS record that points at 127.0.0.1 / 10.x / the
 *      169.254.169.254 metadata endpoint).
 *   2. After connecting: compare the socket's remote address, which is the only
 *      value that cannot lie — it catches DNS rebinding (public on the first
 *      lookup, loopback on the second).
 *
 * The IP checks themselves are plain string arithmetic on purpose: this module is
 * bundled for Cloudflare Workers too, where `node:net` does not exist.
 */
function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return (
    a === 0 || // "this network", resolves to localhost on Linux
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local, includes 169.254.169.254 metadata
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast + reserved + broadcast
  );
}

function isPrivateIpv6(raw: string): boolean {
  // `[::1]` from a URL-style host must be unwrapped first, otherwise none of the
  // prefix tests below match.
  const address = raw.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!address.includes(':')) return false;
  if (address === '::1' || address === '::') return true;
  if (address.startsWith('::ffff:')) return isPrivateIpv4(address.slice(7));
  return /^(fc|fd|fe80|ff)/.test(address); // unique-local, link-local, multicast
}

function isPrivateAddress(address: string): boolean {
  const clean = address.trim().replace(/^\[|\]$/g, '');
  return clean.includes(':') ? isPrivateIpv6(clean) : isPrivateIpv4(clean);
}

/** `10.0.0.0/8` style entries, for deployments whose VPC range is not a single host. */
function matchesCidr(address: string, entry: string): boolean {
  const [network, bitsRaw] = entry.split('/');
  const bits = Number(bitsRaw);
  if (!network || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ip = ipv4ToInt(address);
  const base = ipv4ToInt(network);
  if (ip === null || base === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

/**
 * `DB_HOST_ALLOWLIST` from either the process env (Node) or the binding (Workers).
 *
 * `env` is typed `unknown` on purpose: the Workers `Env` interface has no index
 * signature, and a structural `{ DB_HOST_ALLOWLIST?: string }` parameter is
 * rejected by the weak-type check.
 */
function hostAllowlist(env: unknown): string[] {
  const fromProcess = readEnv('DB_HOST_ALLOWLIST') ?? '';
  const bound = (env as { DB_HOST_ALLOWLIST?: unknown } | null | undefined)?.DB_HOST_ALLOWLIST;
  const fromBinding = typeof bound === 'string' ? bound : '';
  return `${fromProcess},${fromBinding}`
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function allowlistAllowsHost(entries: string[], host: string): boolean {
  const lowered = host.toLowerCase();
  return entries.some((entry) => {
    if (entry === lowered) return true;
    if (entry.startsWith('*.') && lowered.endsWith(entry.slice(1))) return true;
    if (entry.includes('/') && matchesCidr(lowered, entry)) return true;
    return false;
  });
}

function allowlistAllowsAddress(entries: string[], address: string): boolean {
  const clean = address.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return entries.some((entry) => {
    if (entry === clean) return true;
    if (entry.includes('/') && matchesCidr(clean, entry)) return true;
    return false;
  });
}

type HostPolicyResult = { ok: true } | { ok: false; error: string; kind: 'blocked' | 'dns' };

interface ResolvedAddress {
  address: string;
  family: number;
}

/**
 * Resolve a hostname through Node's resolver.
 *
 * Returns `null` when the module is unavailable (Cloudflare Workers), which means
 * "cannot check here" rather than "denied" — on that runtime there is no TCP
 * socket to abuse anyway. A thrown lookup error is reported separately because
 * "does not resolve" is a different answer from "private".
 */
async function resolveHost(host: string): Promise<ResolvedAddress[] | 'unavailable' | 'unresolvable'> {
  try {
    const dnsName = 'node:dns';
    const dns = (await import(/* @vite-ignore */ dnsName)) as {
      promises: { lookup(h: string, o: { all: true }): Promise<ResolvedAddress[]> };
    };
    const rows = await dns.promises.lookup(host, { all: true });
    return rows.length > 0 ? rows : 'unresolvable';
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      return 'unavailable';
    }
    return 'unresolvable';
  }
}

async function checkHostPolicy(host: string, env: unknown): Promise<HostPolicyResult> {
  const entries = hostAllowlist(env);
  // An explicit allowlist entry is an opt-in by the operator: skip the private
  // range checks for it (that is the whole point of the escape hatch), but still
  // refuse a name that does not resolve at all.
  const explicitlyAllowed = allowlistAllowsHost(entries, host);

  const lowered = host.toLowerCase();
  if (!explicitlyAllowed) {
    if (lowered === 'localhost' || lowered.endsWith('.local') || lowered.endsWith('.internal')) {
      return { ok: false, error: 'host not allowed', kind: 'blocked' };
    }
    if (isPrivateAddress(lowered)) return { ok: false, error: 'host not allowed', kind: 'blocked' };
  }

  const resolved = await resolveHost(host);
  if (resolved === 'unavailable') return { ok: true }; // no TCP on this runtime
  if (resolved === 'unresolvable') {
    return { ok: false, error: 'connection failed (dns)', kind: 'dns' };
  }
  if (!explicitlyAllowed) {
    // Every answer must be public: a name with one public and one loopback A
    // record would otherwise pass and connect to whatever the resolver returns
    // first.
    for (const entry of resolved) {
      if (isPrivateAddress(entry.address) && !allowlistAllowsAddress(entries, entry.address)) {
        return { ok: false, error: 'host not allowed', kind: 'blocked' };
      }
    }
  }
  return { ok: true };
}

/** Second layer: the socket's peer address, which DNS rebinding cannot fake. */
function checkPeerAddress(peer: string, env: unknown): boolean {
  if (!isPrivateAddress(peer)) return true;
  return allowlistAllowsAddress(hostAllowlist(env), peer);
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
  // The admin UI never echoes the stored password, so an empty input normally
  // means "keep the saved one". Clearing it must be an explicit flag (S-9):
  // without one, an empty MySQL password can never be configured.
  const clearPassword = body.clearPassword === true;
  const password = clearPassword
    ? ''
    : typeof passwordRaw === 'string' && passwordRaw.length > 0
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

async function testMySqlConnection(
  config: DbRuntimeConfig,
  env: unknown
): Promise<{
  ok: boolean;
  latencyMs: number;
  version?: string;
  schemaState?: string;
  error?: string;
  errorKind?: string;
}> {
  const policy = await checkHostPolicy(config.host || '', env);
  if (!policy.ok) {
    // The endpoint is admin-only and an operator needs to know *why* nothing
    // happened, so the message is explicit. What stays hidden is the resolved
    // address list and any topology behind it.
    console.error('[db-config] host rejected by policy', { host: config.host, kind: policy.kind });
    return { ok: false, latencyMs: 0, error: policy.error, errorKind: policy.kind };
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
    // The pool is capped at one connection, so this reads the very socket the
    // query above used.
    const peer = await db.peerAddress();
    if (peer && !checkPeerAddress(peer, env)) {
      console.error('[db-config] connection peer is a private address, refusing', { host: config.host });
      return { ok: false, latencyMs: Date.now() - startedAt, error: 'host not allowed', errorKind: 'blocked' };
    }
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
  const result = await testMySqlConnection(config, env);
  return jsonResponse(result, result.ok ? 200 : 502);
}

/**
 * Create/migrate the schema through a throwaway connection to the *candidate*
 * settings, before anything is persisted.
 *
 * Persisting first is what used to be able to lock the deployment out: if the
 * account can connect but lacks CREATE privileges, the config was already
 * stored and the next boot ran without tables — and since `/admin/database`
 * itself needs a working `users` table, the UI to roll back was gone too.
 */
async function bootstrapSchemaOnCandidate(config: DbRuntimeConfig): Promise<{ ok: boolean; error?: string }> {
  const probe = new MySqlDatabase({
    host: config.host || '',
    port: config.port || 3306,
    user: config.user || '',
    password: config.password || '',
    database: config.database || '',
    ssl: config.ssl !== false,
    connectionLimit: 1,
    connectTimeoutMs: 15_000,
  });
  try {
    await new StorageService(probe as unknown as D1Database).initializeDatabase();
    return { ok: true };
  } catch (initError) {
    const message = initError instanceof Error ? initError.message : String(initError);
    console.error('[db-config] schema bootstrap on candidate database failed:', initError);
    return { ok: false, error: message };
  } finally {
    await probe.close();
  }
}

/** Clearing the runtime config falls back to env config or D1 — neither may exist here. */
function clearingWouldLeaveNoDatabase(env: Env): boolean {
  return !resolveDbConfigFromEnv(env) && !env.DB;
}

function wantsForce(request: Request): boolean {
  try {
    return new URL(request.url).searchParams.get('force') === '1';
  } catch {
    return false;
  }
}

export async function handleAdminSaveDbConfig(request: Request, env: Env, actorUser: User): Promise<Response> {
  const body = await readJsonBody(request);

  if (body.mode === 'd1') {
    if (clearingWouldLeaveNoDatabase(env) && !wantsForce(request)) {
      return errorResponse(
        'This runtime has no D1 binding and no DB_* environment variables: clearing the runtime config ' +
          'would leave the app without any database and lock you out of this page. Pass ?force=1 to clear anyway.',
        409
      );
    }
    await clearRuntimeConfig(env);
    await resetDatabaseCache();
    // Drop a possibly latched dbInitError with the config: the next request
    // re-resolves from env/D1 and must not inherit the old failure (C-1).
    resetDbLifecycle();
    await auditDbConfigChange(env, actorUser, 'admin.db_config.cleared', null);
    return jsonResponse({ ok: true, mode: 'd1', effective: true });
  }

  const stored = await loadRuntimeConfig(env);
  const { config, error } = normalizeCandidate(body, stored);
  if (error) return errorResponse(error, 400);

  const test = await testMySqlConnection(config, env);
  if (!test.ok) {
    return jsonResponse({ ok: false, error: test.error ?? 'connection test failed', errorKind: test.errorKind }, 502);
  }

  // Verify DDL rights on the candidate *before* persisting: a database that can
  // be read but not migrated must not become the configured one.
  if (test.schemaState !== 'ready') {
    const bootstrap = await bootstrapSchemaOnCandidate(config);
    if (!bootstrap.ok) {
      return jsonResponse(
        {
          ok: false,
          saved: false,
          error:
            'Connected, but creating the schema failed, so the configuration was NOT saved and the current ' +
            `database is still in use. Grant CREATE/ALTER/INDEX on this schema (or import the schema manually).`,
          schemaError: bootstrap.error,
          errorKind: 'schema',
        },
        502
      );
    }
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

  // Rebuild the pool with the new settings and run the schema step against the
  // real pool. It is keyed by the target database, so a freshly configured MySQL
  // really gets its tables (a process-wide "already initialized" flag used to
  // skip it). The candidate bootstrap above normally made this a no-op.
  await resetDatabaseCache();
  // Clear any latched init error (and the per-target keys) so a previously
  // failing deployment heals on save instead of 500-ing until recycle (C-1).
  resetDbLifecycle();
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
  if (clearingWouldLeaveNoDatabase(env) && !wantsForce(request)) {
    return errorResponse(
      'This runtime has no D1 binding and no DB_* environment variables: clearing the runtime config would ' +
        'leave the app without any database and lock you out of this page. Pass ?force=1 to clear anyway.',
      409
    );
  }
  await clearRuntimeConfig(env);
  await resetDatabaseCache();
  // Same as in the save path: a latched init error must not survive the
  // operator's "go back to D1/env" action (C-1).
  resetDbLifecycle();
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

/**
 * Test-only surface for the host policy. These helpers are pure (the address
 * arithmetic) or read the process env, so they can be exercised without a MySQL
 * server — which matters, because a security check nobody can unit-test tends to
 * rot.
 */
export const __testing = {
  isPrivateAddress,
  matchesCidr,
  allowlistAllowsHost,
  allowlistAllowsAddress,
  checkHostPolicy,
  checkPeerAddress,
};
