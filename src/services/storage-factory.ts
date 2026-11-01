// Chooses the storage backend for the current request lifecycle:
// D1 (default, Cloudflare Workers) or the BYO MySQL adapter (Node runtimes
// with one or more external databases configured via env vars / admin UI).
//
// A single MySQL server and a multi-node cluster use the same adapter: the
// cluster with one node behaves exactly like the previous single-connection
// implementation, so there is only one code path in production.

import type { Env } from '../types';
import { resolveDbCluster, type ResolvedDbCluster } from './db-config';
import { MySqlClusterDatabase, type ClusterNodeSpec, type NodeHealthSnapshot } from './db-cluster';
import { isMySqlDatabase } from './storage-mysql';

interface CachedDatabase {
  cacheKey: string;
  db: D1Database;
}

let cached: CachedDatabase | null = null;

/**
 * Fingerprint of the whole cluster.
 *
 * JSON.stringify (not a '|' join): the password may contain those characters,
 * making a joined key ambiguous. Credentials, roles, priorities and the policy
 * are all part of the key: a config change that bypasses the admin save path
 * (KV written directly) must produce fresh pools and fresh routing state, not a
 * stale pool that keeps the old password.
 */
function cacheKeyFor(cluster: ResolvedDbCluster): string {
  return JSON.stringify([
    cluster.source,
    cluster.nodes.map((node) => [
      node.id,
      node.role,
      node.priority,
      node.host,
      node.port,
      node.user,
      node.database,
      node.ssl,
      node.connectionLimit,
      node.password,
    ]),
    cluster.policy,
  ]);
}

function toSpecs(cluster: ResolvedDbCluster): ClusterNodeSpec[] {
  return cluster.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    role: node.role,
    priority: node.priority,
    host: node.host,
    port: node.port,
    user: node.user,
    password: node.password,
    database: node.database,
    ssl: node.ssl,
    connectionLimit: node.connectionLimit,
    connectTimeoutMs: 10_000,
  }));
}

export async function getDatabase(env: Env): Promise<D1Database> {
  const cluster = await resolveDbCluster(env);
  if (cluster.mode !== 'mysql' || cluster.nodes.length === 0) {
    return env.DB;
  }
  const cacheKey = cacheKeyFor(cluster);
  if (cached && cached.cacheKey === cacheKey) {
    return cached.db;
  }
  if (cached && isMySqlDatabase(cached.db)) {
    await (cached.db as unknown as { close(): Promise<void> }).close();
  }
  const db = new MySqlClusterDatabase(toSpecs(cluster), cluster.policy);
  cached = { cacheKey, db: db as unknown as D1Database };
  return cached.db;
}

/** Drop the cached pools so the next request reconnects with fresh settings. */
export async function resetDatabaseCache(): Promise<void> {
  if (cached && isMySqlDatabase(cached.db)) {
    await (cached.db as unknown as { close(): Promise<void> }).close();
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
  /** Per-node health snapshot, only populated for a MySQL cluster. */
  nodes?: NodeHealthSnapshot[];
  /** True when the primary node answered but a replica replay is failing. */
  degraded?: boolean;
}

export async function getDatabaseStatus(env: Env): Promise<DatabaseStatus> {
  let mode: 'mysql' | 'd1' = 'd1';
  let source = 'd1';
  let cacheKey = 'd1';
  try {
    const cluster = await resolveDbCluster(env);
    mode = cluster.mode;
    source = cluster.source;
    cacheKey = [
      cluster.mode,
      cluster.source,
      cluster.nodes.map((node) => `${node.id}:${node.host}:${node.port}/${node.database}`).join(','),
    ].join('|');

    if (statusCache && statusCache.key === cacheKey && Date.now() - statusCache.at < STATUS_CACHE_MS) {
      return statusCache.value;
    }

    if (cluster.mode === 'd1' && !env.DB) {
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
    if (cluster.mode === 'mysql') {
      const row = await db.prepare('SELECT VERSION() AS version').first<{ version: string }>();
      const nodes = (db as unknown as { nodeHealth?: () => NodeHealthSnapshot[] }).nodeHealth?.();
      // A replica that cannot keep up with replayed writes is not a reason to
      // report the whole database as down — but it must be visible.
      const degraded = !!nodes?.some((node) => node.role !== 'primary' && node.syncErrors > 0);
      const status: DatabaseStatus = {
        mode: 'mysql',
        source: cluster.source,
        ok: true,
        version: row?.version,
        nodes,
        degraded,
      };
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

/** Health of the configured nodes without issuing a probe query. */
export function peekClusterHealth(): NodeHealthSnapshot[] | null {
  const db = cached?.db as unknown as { nodeHealth?: () => NodeHealthSnapshot[] } | undefined;
  return db?.nodeHealth?.() ?? null;
}
