// Admin API for the BYO-DB (external MySQL) configuration.
//
//   GET  /api/admin/db-config        -> masked cluster config + node health
//   POST /api/admin/db-config/test   -> test one node or probe every node
//   POST /api/admin/db-config        -> save the cluster (encrypted), migrate every node
//   DELETE /api/admin/db-config      -> clear runtime config (back to D1 / env)
//
// The cluster is saved as a whole: validation, connection tests and schema
// bootstrap run against *all* enabled nodes first, and nothing is persisted
// unless every one of them passed. Saving first and discovering on the next
// boot that a standby had no tables (or no CREATE rights) is exactly the
// lock-out this ordering prevents.

import type { Env, User } from '../types';
import { jsonResponse, errorResponse } from '../utils/response';
import {
  CLUSTER_LIMITS,
  DEFAULT_CLUSTER_POLICY,
  clearRuntimeConfig,
  hasConfigStore,
  loadRuntimeConfig,
  maskCluster,
  maskConfig,
  normalizePolicy,
  maskNode,
  primaryNodeOf,
  resolveDbCluster,
  resolveDbConfig,
  resolveDbConfigFromEnv,
  saveRuntimeConfig,
  readSyncStates,
  saveNodeSyncState,
  clearSyncStates,
  type DbClusterPolicy,
  type DbNodeConfig,
  type DbRuntimeConfigV2,
  type DbSyncStates,
} from '../services/db-config';
import { resetDatabaseCache, getDatabase, peekClusterHealth } from '../services/storage-factory';
import { isMySqlClusterDatabase } from '../services/db-cluster';
import { syncDatabase, type ClusterSyncResult } from '../services/db-cluster-sync';
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function newId(): string {
  return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Build a node from the request body, falling back to the stored node with the
 * same id.
 *
 * The admin UI never echoes a stored password, so an empty input normally means
 * "keep the saved one". Clearing it must be an explicit flag (S-9): without one,
 * an empty MySQL password can never be configured.
 */
function normalizeNodeCandidate(
  body: Record<string, unknown>,
  fallback?: DbNodeConfig | null,
  index = 0
): { node: DbNodeConfig; error?: string } {
  const host = String(body.host ?? fallback?.host ?? '').trim();
  const user = String(body.user ?? fallback?.user ?? '').trim();
  const database = String(body.database ?? fallback?.database ?? '').trim();
  const passwordRaw = body.password;
  const clearPassword = body.clearPassword === true;
  const password = clearPassword
    ? ''
    : typeof passwordRaw === 'string' && passwordRaw.length > 0
      ? passwordRaw
      : (fallback?.password ?? '');
  const port = Number(body.port ?? fallback?.port ?? 3306);
  const id = String(body.id ?? fallback?.id ?? '').trim() || newId();
  const role = body.role === 'replica' ? 'replica' : body.role === 'primary' ? 'primary' : (fallback?.role ?? 'primary');

  const empty: DbNodeConfig = {
    id,
    label: String(body.label ?? fallback?.label ?? (index === 0 ? '主库' : `节点 ${index + 1}`)).trim(),
    role,
    priority: clampInt(body.priority ?? fallback?.priority, index + 1, 1, 99),
    enabled: body.enabled === undefined ? (fallback?.enabled ?? true) : body.enabled !== false,
    host,
    port: Number.isFinite(port) ? Math.floor(port) : 3306,
    user,
    password,
    database,
    ssl: body.ssl === undefined ? (fallback?.ssl !== false) : !!body.ssl,
    connectionLimit: clampInt(
      body.connectionLimit ?? fallback?.connectionLimit,
      5,
      CLUSTER_LIMITS.minConnectionLimit,
      CLUSTER_LIMITS.maxConnectionLimit
    ),
  };

  if (!host && empty.enabled) return { node: empty, error: `节点 ${index + 1}：host is required` };
  if (empty.enabled && !user) return { node: empty, error: `节点 ${index + 1}：user is required` };
  if (empty.enabled && !database) return { node: empty, error: `节点 ${index + 1}：database is required` };
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { node: empty, error: `节点 ${index + 1}：invalid port` };
  }
  return { node: empty };
}

/** Legacy request bodies carry a single connection at the top level. */
function looksLikeLegacyBody(body: Record<string, unknown>): boolean {
  return !Array.isArray(body.nodes) && typeof body.host === 'string';
}

function normalizeClusterCandidate(
  body: Record<string, unknown>,
  stored: DbRuntimeConfigV2 | null
): { cluster: DbRuntimeConfigV2; error?: string } {
  const fallbackNodes = stored?.nodes ?? [];
  const rawNodes = looksLikeLegacyBody(body) ? [body] : body.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    return {
      cluster: { version: 2, mode: 'mysql', nodes: [], policy: { ...DEFAULT_CLUSTER_POLICY } },
      error: 'at least one database node is required',
    };
  }
  if (rawNodes.length > CLUSTER_LIMITS.maxNodes) {
    return {
      cluster: { version: 2, mode: 'mysql', nodes: [], policy: { ...DEFAULT_CLUSTER_POLICY } },
      error: `at most ${CLUSTER_LIMITS.maxNodes} database nodes are supported`,
    };
  }

  const nodes: DbNodeConfig[] = [];
  const seenIds = new Set<string>();
  for (const [index, rawNode] of rawNodes.entries()) {
    const record = asRecord(rawNode) ?? {};
    const id = String(record.id ?? '').trim();
    const fallback = id
      ? fallbackNodes.find((node) => node.id === id)
      : looksLikeLegacyBody(body)
        ? fallbackNodes[0]
        : undefined;
    const { node, error } = normalizeNodeCandidate(record, fallback, index);
    if (error) {
      return {
        cluster: { version: 2, mode: 'mysql', nodes: [], policy: { ...DEFAULT_CLUSTER_POLICY } },
        error,
      };
    }
    if (seenIds.has(node.id)) {
      return {
        cluster: { version: 2, mode: 'mysql', nodes: [], policy: { ...DEFAULT_CLUSTER_POLICY } },
        error: `duplicate node id: ${node.id}`,
      };
    }
    seenIds.add(node.id);
    nodes.push(node);
  }

  const enabled = nodes.filter((node) => node.enabled);
  if (enabled.length === 0) {
    return {
      cluster: { version: 2, mode: 'mysql', nodes: [], policy: { ...DEFAULT_CLUSTER_POLICY } },
      error: 'at least one node must be enabled',
    };
  }
  const primaries = enabled.filter((node) => node.role === 'primary');
  if (primaries.length === 0) {
    return {
      cluster: { version: 2, mode: 'mysql', nodes: [], policy: { ...DEFAULT_CLUSTER_POLICY } },
      error: 'one node must be the primary',
    };
  }
  if (primaries.length > 1) {
    return {
      cluster: { version: 2, mode: 'mysql', nodes: [], policy: { ...DEFAULT_CLUSTER_POLICY } },
      error: 'only one node may be the primary',
    };
  }

  const policy: DbClusterPolicy = body.policy === undefined && stored
    ? stored.policy
    : normalizePolicy(body.policy);

  return { cluster: { version: 2, mode: 'mysql', nodes, policy } };
}

interface NodeProbeResult {
  id: string;
  label: string;
  role: DbNodeConfig['role'];
  ok: boolean;
  latencyMs: number;
  version?: string;
  schemaState?: string;
  error?: string;
  errorKind?: string;
}

async function probeNode(node: DbNodeConfig, env: unknown): Promise<NodeProbeResult> {
  const result = await testMySqlConnection(node, env);
  return {
    id: node.id,
    label: node.label,
    role: node.role,
    ok: result.ok,
    latencyMs: result.latencyMs,
    version: result.version,
    schemaState: result.schemaState,
    error: result.error,
    errorKind: result.errorKind,
  };
}

async function testMySqlConnection(
  config: DbNodeConfig,
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
  const cluster = await resolveDbCluster(env);
  const resolved = await resolveDbConfig(env);
  const health = peekClusterHealth();
  return jsonResponse({
    cluster: maskCluster(cluster),
    // Compatibility: the previous UI read `config` for a single connection.
    config: maskConfig(resolved),
    health: health ?? [],
    runtimeConfigStored: !!(await loadRuntimeConfig(env)),
    configStoreAvailable: hasConfigStore(env),
    envOverrideActive: !!resolveDbConfigFromEnv(env),
    limits: CLUSTER_LIMITS,
    defaultPolicy: DEFAULT_CLUSTER_POLICY,
  });
}

/**
 * Test one candidate node, or probe every configured node.
 *
 * `body.node`  -> a single node (used by the per-node "test" button)
 * `body.nodes` -> a list of nodes (used by "test all")
 * otherwise    -> the legacy flat body, treated as one node
 */
export async function handleAdminTestDbConfig(request: Request, env: Env, actorUser: User): Promise<Response> {
  void actorUser;
  const body = await readJsonBody(request);
  const stored = await loadRuntimeConfig(env);
  const resolved = await resolveDbCluster(env);

  const storedFallbackFor = (id: string | undefined) =>
    (id ? stored?.nodes.find((node) => node.id === id) : undefined) ??
    (resolved.nodes[0]
      ? {
          ...resolved.nodes[0],
          id: resolved.nodes[0].id,
        }
      : null);

  const single = asRecord(body.node);
  const list = Array.isArray(body.nodes) ? body.nodes : null;

  if (single) {
    const id = typeof single.id === 'string' ? single.id : undefined;
    const { node, error } = normalizeNodeCandidate(single, storedFallbackFor(id), 0);
    if (error) return errorResponse(error, 400);
    const result = await probeNode(node, env);
    return jsonResponse({ ...result, ok: result.ok }, result.ok ? 200 : 502);
  }

  if (list && list.length > 0) {
    const candidates = list.map((raw, index) => {
      const record = asRecord(raw) ?? {};
      const id = typeof record.id === 'string' ? record.id : undefined;
      return normalizeNodeCandidate(record, storedFallbackFor(id), index);
    });
    const invalid = candidates.find((entry) => entry.error);
    if (invalid) return errorResponse(invalid.error ?? 'invalid node', 400);
    const results = await Promise.all(candidates.map((entry) => probeNode(entry.node, env)));
    return jsonResponse({ ok: results.every((result) => result.ok), results }, results.every((r) => r.ok) ? 200 : 502);
  }

  // Legacy flat body.
  const { node, error } = normalizeNodeCandidate(body, storedFallbackFor(undefined), 0);
  if (error) return errorResponse(error, 400);
  const result = await probeNode(node, env);
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
async function bootstrapSchemaOnCandidate(config: DbNodeConfig): Promise<{ ok: boolean; error?: string }> {
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
    // Sync records describe nodes that no longer exist.
    await clearSyncStates(env);
    await auditDbConfigChange(env, actorUser, 'admin.db_config.cleared', null);
    return jsonResponse({ ok: true, mode: 'd1', effective: true });
  }

  const stored = await loadRuntimeConfig(env);
  const { cluster, error } = normalizeClusterCandidate(body, stored);
  if (error) return errorResponse(error, 400);

  const enabled = cluster.nodes.filter((node) => node.enabled);

  // 1) Connectivity + SSRF policy for every enabled node, in parallel: one
  //    unreachable standby must not be saved silently, because it would only
  //    surface the day it is promoted.
  const probes = await Promise.all(enabled.map((node) => probeNode(node, env)));
  const failedProbe = probes.find((result) => !result.ok);
  if (failedProbe) {
    return jsonResponse(
      {
        ok: false,
        saved: false,
        error: `节点「${failedProbe.label}」连接失败：${failedProbe.error ?? 'unknown error'}`,
        errorKind: failedProbe.errorKind ?? 'connection',
        nodes: probes,
      },
      502
    );
  }

  // 2) DDL rights on each candidate *before* persisting: a database that can be
  //    read but not migrated must not become part of the cluster.
  const bootstraps = await Promise.all(
    enabled.map(async (node) => {
      const probe = probes.find((result) => result.id === node.id);
      if (probe?.schemaState === 'ready') return { id: node.id, label: node.label, ok: true as const };
      const result = await bootstrapSchemaOnCandidate(node);
      return { id: node.id, label: node.label, ok: result.ok, error: result.error };
    })
  );
  const failedBootstrap = bootstraps.find((result) => !result.ok);
  if (failedBootstrap) {
    return jsonResponse(
      {
        ok: false,
        saved: false,
        error:
          `节点「${failedBootstrap.label}」连接成功，但建表失败，配置未保存，当前数据库仍在正常使用。` +
          '请为该库账号授予 CREATE/ALTER/INDEX 权限（或手动导入表结构）后重试。',
        schemaError: failedBootstrap.error,
        errorKind: 'schema',
        nodes: probes,
      },
      502
    );
  }

  const saved = await saveRuntimeConfig(env, cluster);
  if (!saved && !hasConfigStore(env)) {
    return errorResponse(
      'No config store available. Bind SETTINGS_KV (or ATTACHMENTS) or set DB_* environment variables instead.',
      400
    );
  }
  if (!saved) {
    return errorResponse('Failed to persist database config', 500);
  }

  // Rebuild the pools with the new settings and run the schema step against the
  // real cluster. It is keyed by target database, so a freshly configured MySQL
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
  await auditDbConfigChange(env, actorUser, 'admin.db_config.saved', cluster);

  // A write-through replica that never completed a sync is not a failover
  // target (B-4). Saying so here is the only chance to warn *before* the day it
  // matters; the standalone sync panel would never be opened otherwise.
  let syncPending: string[] = [];
  if (cluster.policy.syncMode === 'write-through') {
    const states = await readSyncStates(env);
    syncPending = cluster.nodes
      .filter((node) => node.enabled && node.role === 'replica' && states[node.id]?.complete !== true)
      .map((node) => node.id);
  }
  const syncWarning =
    syncPending.length > 0
      ? `${syncPending.length} 个副库尚未完成同步，故障切换前请先点「同步数据到副库」，否则接管时会缺少历史数据。`
      : undefined;
  const warning = [envOverride ? 'DB_* 环境变量优先于运行时配置：配置已保存，但当前生效的仍是环境变量指向的数据库。' : null,
    schemaError ? `配置已保存，但建表失败：${schemaError}` : null,
    syncWarning]
    .filter((entry): entry is string => !!entry)
    .join(' ');

  return jsonResponse({
    ok: true,
    mode: 'mysql',
    saved: true,
    effective: !envOverride && schemaReady,
    warning: warning || undefined,
    schemaReady,
    syncPending: syncPending.length > 0 ? syncPending : undefined,
    latencyMs: Math.max(...probes.map((result) => result.latencyMs), 0),
    version: probes.find((result) => result.role === 'primary')?.version,
    nodes: probes,
    cluster: maskCluster({
      mode: 'mysql',
      source: 'runtime',
      nodes: cluster.nodes.map((node) => ({ ...node, source: 'runtime' as const, syncStatus: undefined })),
      policy: cluster.policy,
    }),
  });
}

interface TargetSyncReport {
  id: string;
  label: string;
  ok: boolean;
  /** Every table walked to the end and the row counts agreed. */
  complete: boolean;
  rowsRead: number;
  rowsWritten: number;
  truncated: boolean;
  durationMs: number;
  tables: ClusterSyncResult['tables'];
  /** Tables whose row count differs between source and target (S1). */
  countsMismatch?: string[];
  /** Rows present on the target but not on the source (S2). */
  orphanRows?: number;
  error?: string;
}

/**
 * Copy rows from one node onto the others (backfill / repair).
 *
 * Write-through replication starts at the moment the cluster is configured, so
 * a node added to a deployment that already holds data would come up empty and
 * take over with no accounts in it. This is the backfill/repair step the admin
 * runs right after adding a replica (and again if the health panel shows replay
 * failures).
 *
 * Only meaningful for `write-through`: a native MySQL replica is read-only and
 * already filled by the server, so writing to it would just fail.
 *
 * `sourceId` picks the node the rows are read *from*. It defaults to the
 * primary, which is wrong the moment a failover happened: the standby then holds
 * writes the primary never saw, and copying primary → standby would rewrite the
 * newer rows with older ones (B-2). Callers can point the copy at the node that
 * actually received the writes, and the default `merge` mode never overwrites an
 * existing row at all.
 */
export async function handleAdminSyncDbCluster(request: Request, env: Env, actorUser: User): Promise<Response> {
  const body = await readJsonBody(request);
  const requested = Array.isArray(body.targetIds) ? body.targetIds.map((id) => String(id)) : null;
  const requestedSource = typeof body.sourceId === 'string' && body.sourceId.trim() ? body.sourceId.trim() : null;
  // 'merge' (default) only inserts missing rows; 'overwrite' is the explicit
  // repair path that replaces existing values.
  const mode = body.mode === 'overwrite' ? 'overwrite' : 'merge';
  const forced = wantsForce(request) || body.force === true;

  const cluster = await resolveDbCluster(env);
  if (cluster.mode !== 'mysql' || cluster.nodes.length === 0) {
    return errorResponse('当前没有配置外接 MySQL 节点，无需同步。', 400);
  }
  if (cluster.policy.syncMode !== 'write-through') {
    return errorResponse(
      '当前副库同步方式是「数据库自身复制」，数据由数据库负责，应用层不需要也不应该写入副库。' +
        '如需应用层双写，请先切换到「应用层实时双写」并保存。',
      400
    );
  }

  const db = await getDatabase(env);
  if (!isMySqlClusterDatabase(db)) {
    return errorResponse('当前数据库不是 MySQL 集群，无法同步。', 400);
  }

  const handles = db.nodeDatabases();
  const primaryId = primaryNodeOf(cluster)?.id;
  const primaryHandle = handles.find((node) => node.id === primaryId) ?? handles[0];
  if (!primaryHandle) return errorResponse('找不到主库节点。', 400);

  const sourceId = requestedSource ?? primaryHandle.id;
  const source = handles.find((node) => node.id === sourceId);
  if (!source) {
    return errorResponse(`未知的同步源节点：${sourceId}`, 400);
  }
  const sourceSpec = cluster.nodes.find((node) => node.id === source.id);
  if (sourceSpec && sourceSpec.enabled === false) {
    return errorResponse(`同步源节点「${sourceSpec.label}」已停用。`, 400);
  }

  const targets = handles.filter(
    (node) => node.id !== source.id && (!requested || requested.includes(node.id))
  );
  if (targets.length === 0) {
    return errorResponse('没有可同步的目标节点（源节点不能同时作为目标，请先添加并启用副库）。', 400);
  }

  // Writing "backwards" (from a node that missed writes into the one that has
  // them) is the destructive case. In `merge` mode an existing row is never
  // touched, so it cannot lose data; `overwrite` can, hence the guard.
  const watermarks = db.writeWatermarks();
  const appliedOf = (id: string) => watermarks.nodes.find((node) => node.id === id)?.appliedSeq ?? 0;
  const sourceSeq = appliedOf(source.id);
  if (mode === 'overwrite' && !forced) {
    const newer = targets.find((target) => appliedOf(target.id) > sourceSeq);
    if (newer) {
      const newerLabel = cluster.nodes.find((node) => node.id === newer.id)?.label ?? newer.id;
      const sourceLabel = sourceSpec?.label ?? source.id;
      return errorResponse(
        `目标节点「${newerLabel}」比源节点「${sourceLabel}」更新：它已经接收了源节点没有的写入。` +
          '用「覆盖已有行」会把较新的数据改回旧值。请改用默认的「只补缺失行」，' +
          '或把同步源改成「' + newerLabel + '」，确认无误后再加 ?force=1 强制覆盖。',
        409
      );
    }
  }

  const storedStates = await readSyncStates(env);
  // Sequential, with a shared budget: parallel copies would multiply the load on
  // the source and could push the request past the platform timeout.
  const deadline = Date.now() + 90_000;
  const reports: TargetSyncReport[] = [];
  for (const target of targets) {
    const spec = cluster.nodes.find((node) => node.id === target.id);
    const remaining = deadline - Date.now();
    if (remaining < 3_000) {
      reports.push({
        id: target.id,
        label: spec?.label ?? target.id,
        ok: false,
        complete: false,
        rowsRead: 0,
        rowsWritten: 0,
        truncated: false,
        durationMs: 0,
        tables: [],
        error: '时间预算已用完，该节点本次未同步，请稍后单独重试。',
      });
      continue;
    }

    // Resume only when the previous run copied from the same source: a cursor is
    // a position in *that* node's key space.
    const previous = storedStates[target.id];
    const cursors = previous && previous.sourceId === source.id ? previous.cursors : undefined;
    const result = await syncDatabase(source.db, target.db, {
      maxDurationMs: Math.min(45_000, remaining),
      deadline,
      mode,
      cursors,
    });

    const complete = result.ok && result.complete;
    const countsMismatch = result.tables
      .filter((table) => table.countMatches === false)
      .map((table) => table.table);
    const orphanRows = result.tables.reduce((sum, table) => sum + (table.orphanRows ?? 0), 0);

    // Persist the outcome so "is this standby ready?" survives a restart and can
    // be shown before the next failover (B-4).
    await saveNodeSyncState(env, target.id, {
      at: Date.now(),
      complete,
      truncated: result.truncated,
      rowsWritten: result.rowsWritten,
      tables: result.tables.length,
      sourceId: source.id,
      cursors: complete ? undefined : result.cursors,
    });
    if (complete) db.markNodeSynced(target.id);

    reports.push({
      id: target.id,
      label: spec?.label ?? target.id,
      ok: result.ok,
      complete,
      rowsRead: result.rowsRead,
      rowsWritten: result.rowsWritten,
      truncated: result.truncated,
      durationMs: result.durationMs,
      tables: result.tables,
      countsMismatch: countsMismatch.length > 0 ? countsMismatch : undefined,
      orphanRows: orphanRows > 0 ? orphanRows : undefined,
    });
  }

  const ok = reports.every((report) => report.ok);
  await auditDbConfigChange(env, actorUser, 'admin.db_config.synced', {
    version: 2,
    mode: 'mysql',
    nodes: cluster.nodes.map((node) => ({ ...node })),
    policy: cluster.policy,
  });

  return jsonResponse(
    {
      ok,
      source: { id: source.id, label: sourceSpec?.label ?? source.id },
      mode,
      complete: reports.every((report) => report.complete),
      targets: reports,
      rowsWritten: reports.reduce((sum, report) => sum + report.rowsWritten, 0),
      truncated: reports.some((report) => report.truncated),
    },
    ok ? 200 : 502
  );
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
  await clearSyncStates(env);
  await auditDbConfigChange(env, actorUser, 'admin.db_config.cleared', null);
  return jsonResponse({ ok: true, mode: 'd1' });
}

/** Changing where the database lives is a high-privilege action: keep a trail. */
async function auditDbConfigChange(
  env: Env,
  actorUser: User,
  action: string,
  cluster: DbRuntimeConfigV2 | null
): Promise<void> {
  if (!env.DB) return;
  const primary = cluster?.nodes.find((node) => node.role === 'primary' && node.enabled);
  const target = primary
    ? `${primary.host}:${primary.port}/${primary.database}${cluster!.nodes.length > 1 ? ` (+${cluster!.nodes.length - 1})` : ''}`
    : 'd1';
  try {
    await writeAuditEvent(new StorageService(env.DB), {
      actorUserId: actorUser.id,
      action,
      category: 'system',
      level: 'security',
      targetType: 'database',
      targetId: target,
      metadata: {
        destinationName: target,
        destinationType: cluster ? 'mysql' : 'd1',
        status: 'ok',
        nodeCount: cluster?.nodes.length ?? 0,
        syncMode: cluster?.policy.syncMode,
      },
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
  normalizeClusterCandidate,
  maskNode,
};
