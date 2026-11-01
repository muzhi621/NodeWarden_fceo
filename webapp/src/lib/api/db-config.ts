import type { AuthedFetch } from './shared';
import { parseJson } from './shared';

export type DbNodeRole = 'primary' | 'replica';
export type DbSyncMode = 'native' | 'write-through';

export interface DbNodeSyncState {
  /** When the last sync run finished. */
  at: number;
  /** Every table was walked to the end and the row counts matched. */
  complete: boolean;
  /** Hit a row cap / the time budget: run it again to continue. */
  truncated: boolean;
  rowsWritten: number;
  tables: number;
  /** Node the rows were copied from. */
  sourceId?: string;
}

export interface MaskedDbNode {
  id: string;
  label: string;
  role: DbNodeRole;
  priority: number;
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  database: string;
  ssl: boolean;
  connectionLimit: number;
  passwordSet: boolean;
  /** Last sync run for this node, when one is recorded. */
  syncStatus?: DbNodeSyncState;
  /** False: a write-through replica that has never completed a sync. */
  syncReady?: boolean;
}

export interface MaskedDbConfig {
  mode: 'mysql' | 'd1';
  source: 'env' | 'runtime' | 'd1';
  host: string;
  port: number;
  user: string;
  database: string;
  ssl: boolean;
  connectionLimit: number;
  passwordSet: boolean;
}

export interface DbClusterPolicy {
  readSplit: boolean;
  syncMode: DbSyncMode;
  syncAsync: boolean;
  failoverEnabled: boolean;
  failureThreshold: number;
  cooldownMs: number;
}

export interface MaskedDbCluster {
  mode: 'mysql' | 'd1';
  source: 'env' | 'runtime' | 'd1';
  nodes: MaskedDbNode[];
  policy: DbClusterPolicy;
}

export interface NodeHealthSnapshot {
  id: string;
  label: string;
  role: DbNodeRole;
  priority: number;
  available: boolean;
  failures: number;
  lastError?: string;
  lastOkAt?: number;
  lastFailureAt?: number;
  downUntil?: number;
  syncErrors: number;
  lastSyncError?: string;
  /** Committed writes this node has not applied yet. */
  lag?: number;
  appliedSeq?: number;
  missedWrites?: number;
  behindSince?: number;
  /** The write journal no longer covers the gap: a full sync is required. */
  needsFullSync?: boolean;
  /** The server rejected a write as read-only (1290/1792). */
  writeBlocked?: boolean;
  syncReady?: boolean;
}

export interface DbClusterLimits {
  maxNodes: number;
  minConnectionLimit: number;
  maxConnectionLimit: number;
  minFailureThreshold: number;
  maxFailureThreshold: number;
  minCooldownMs: number;
  maxCooldownMs: number;
}

export interface DbConfigStatus {
  cluster: MaskedDbCluster;
  /** Compatibility mirror of the primary node. */
  config: MaskedDbConfig;
  health: NodeHealthSnapshot[];
  runtimeConfigStored: boolean;
  configStoreAvailable: boolean;
  envOverrideActive: boolean;
  limits?: DbClusterLimits;
  defaultPolicy?: DbClusterPolicy;
}

export interface DbNodeInput {
  id?: string;
  label?: string;
  role?: DbNodeRole;
  priority?: number;
  enabled?: boolean;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  /** Explicitly store an empty password (the input never echoes the saved one). */
  clearPassword?: boolean;
  database?: string;
  ssl?: boolean;
  connectionLimit?: number;
}

export interface NodeProbeResult {
  id: string;
  label: string;
  role: DbNodeRole;
  ok: boolean;
  latencyMs: number;
  version?: string;
  schemaState?: string;
  error?: string;
  errorKind?: string;
}

export interface DbConfigSaveResult {
  ok: boolean;
  saved?: boolean;
  error?: string;
  /** Detail of a failed schema bootstrap (the config is then NOT saved). */
  schemaError?: string;
  errorKind?: string;
  latencyMs?: number;
  version?: string;
  effective?: boolean;
  schemaReady?: boolean;
  warning?: string;
  nodes?: NodeProbeResult[];
}

export interface DbClusterSaveInput {
  mode?: 'mysql' | 'd1';
  nodes?: DbNodeInput[];
  policy?: DbClusterPolicy;
}

export const DEFAULT_CLUSTER_POLICY: DbClusterPolicy = {
  readSplit: false,
  syncMode: 'native',
  syncAsync: false,
  failoverEnabled: true,
  failureThreshold: 3,
  cooldownMs: 30_000,
};

export async function getDbConfigStatus(authedFetch: AuthedFetch): Promise<DbConfigStatus> {
  const resp = await authedFetch('/api/admin/db-config');
  if (!resp.ok) throw new Error('Failed to load database config');
  const body = await parseJson<DbConfigStatus>(resp);
  if (!body?.config || !body.cluster) throw new Error('Invalid database config response');
  return body;
}

export async function testDbNode(authedFetch: AuthedFetch, node: DbNodeInput): Promise<NodeProbeResult> {
  const resp = await authedFetch('/api/admin/db-config/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ node }),
  });
  const body = await parseJson<NodeProbeResult>(resp);
  return body ?? { id: node.id ?? '', label: node.label ?? '', role: 'primary', ok: false, latencyMs: 0, error: `HTTP ${resp.status}` };
}

export async function probeDbNodes(
  authedFetch: AuthedFetch,
  nodes: DbNodeInput[]
): Promise<{ ok: boolean; results: NodeProbeResult[] }> {
  const resp = await authedFetch('/api/admin/db-config/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes }),
  });
  const body = await parseJson<{ ok?: boolean; results?: NodeProbeResult[]; error?: string }>(resp);
  if (!body?.results) {
    throw new Error(body?.error || `HTTP ${resp.status}`);
  }
  return { ok: body.ok === true, results: body.results };
}

export async function saveDbConfig(authedFetch: AuthedFetch, input: DbClusterSaveInput): Promise<DbConfigSaveResult> {
  const resp = await authedFetch('/api/admin/db-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await parseJson<DbConfigSaveResult>(resp);
  if (!body) return { ok: false, error: `HTTP ${resp.status}` };
  return body;
}

export interface DbTableSyncResult {
  table: string;
  columns: number;
  rowsRead: number;
  rowsWritten: number;
  truncated: boolean;
  /** Resume position for the next run. */
  nextCursor?: Array<string | number | boolean | null>;
  paging?: 'keyset' | 'offset';
  sourceRows?: number;
  targetRows?: number;
  countMatches?: boolean;
  orphanRows?: number;
  error?: string;
}

export interface DbTargetSyncReport {
  id: string;
  label: string;
  ok: boolean;
  /** Every table finished and the row counts agreed. */
  complete: boolean;
  rowsRead: number;
  rowsWritten: number;
  truncated: boolean;
  durationMs: number;
  tables: DbTableSyncResult[];
  countsMismatch?: string[];
  orphanRows?: number;
  error?: string;
}

export interface DbSyncResult {
  ok: boolean;
  complete: boolean;
  targets: DbTargetSyncReport[];
  rowsWritten: number;
  truncated: boolean;
  source?: { id: string; label: string };
  mode?: DbSyncCopyMode;
}

export type DbSyncCopyMode = 'merge' | 'overwrite';

export interface DbSyncOptions {
  targetIds?: string[];
  /** Node to read from; defaults to the primary. */
  sourceId?: string;
  /** `merge` (default) only inserts missing rows; `overwrite` replaces them. */
  mode?: DbSyncCopyMode;
  force?: boolean;
}

export async function syncDbCluster(
  authedFetch: AuthedFetch,
  options: DbSyncOptions = {}
): Promise<DbSyncResult> {
  const body: Record<string, unknown> = {};
  if (options.targetIds && options.targetIds.length > 0) body.targetIds = options.targetIds;
  if (options.sourceId) body.sourceId = options.sourceId;
  if (options.mode) body.mode = options.mode;
  if (options.force) body.force = true;

  const resp = await authedFetch('/api/admin/db-config/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await parseJson<DbSyncResult & { error?: string; targets?: DbTargetSyncReport[] }>(resp);
  if (!payload?.targets) {
    throw new Error(payload?.error || `Failed to sync database nodes (HTTP ${resp.status})`);
  }
  return {
    ok: payload.ok === true,
    complete: payload.complete === true,
    targets: payload.targets,
    rowsWritten: payload.rowsWritten ?? 0,
    truncated: payload.truncated === true,
    source: payload.source,
    mode: payload.mode,
  };
}

export async function clearDbConfig(authedFetch: AuthedFetch): Promise<{ ok: boolean }> {
  const resp = await authedFetch('/api/admin/db-config', { method: 'DELETE' });
  const body = await parseJson<{ ok: boolean; error?: string }>(resp);
  // The server refuses to clear a config that would leave the app without any
  // database (409); showing "cleared" in that case would be a lie.
  if (!resp.ok || !body?.ok) {
    throw new Error(body?.error || `Failed to clear database config (HTTP ${resp.status})`);
  }
  return body;
}
