import type { AuthedFetch } from './shared';
import { parseJson } from './shared';

export type DbNodeRole = 'primary' | 'replica';
export type DbSyncMode = 'native' | 'write-through';

export interface DbNodeSyncState {
  /** When the last sync run finished. */
  at: number;
  /** Every table was walked to the end and the row counts matched. */
  complete: boolean;
  /**
   * `host|port|database` the record refers to. A record for another database is
   * ignored by the server, so "complete" never outlives the node it describes.
   */
  fingerprint?: string;
  /** Hit a row cap / the time budget: run it again to continue. */
  truncated: boolean;
  rowsWritten: number;
  tables: number;
  /** Node the rows were copied from. */
  sourceId?: string;
  /** Copy mode of that run. */
  mode?: DbSyncCopyMode;
  /** Tables it already finished (a resumed run skips them). */
  doneTables?: string[];
  /** How far it got, so an interrupted run shows a position instead of a spinner. */
  progress?: DbSyncProgress;
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
  /** Env standby silently inherited the primary's DB_PASSWORD. */
  passwordInherited?: boolean;
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
  /**
   * A config exists but nothing in it is usable (every node disabled). The app
   * has no database in that state, so it must be shown, not silently ignored.
   */
  unavailableReason?: string;
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
  /**
   * The persisted cluster, returned even when `DB_*` environment variables
   * shadow it. `null` means nothing is stored.
   */
  storedCluster?: MaskedDbCluster | null;
  /** True when `cluster` *is* the stored config (no env override in the way). */
  storedClusterActive?: boolean;
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
  /** Actionable explanation for the coarse error label. */
  hint?: string;
  /** Which credential was used (never the value). */
  passwordSource?: string;
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
  /** Replicas that still need a sync before they may take over. */
  syncPending?: string[];
  /** Native-mode standbys holding no accounts while the primary does. */
  emptyStandbys?: string[];
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
  /** Rows pushed; in merge mode this includes rows the target already had. */
  rowsWritten: number;
  /** Rows that were actually new on the target, when measured. */
  rowsInserted?: number;
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
  /** Every table walked to the end; row counts are reported separately. */
  complete: boolean;
  rowsRead: number;
  rowsWritten: number;
  /** Rows that were actually new on this target. */
  rowsInserted?: number;
  truncated: boolean;
  durationMs: number;
  tables: DbTableSyncResult[];
  /** Tables that raised an error, with the reason. */
  failedTables?: Array<{ table: string; error: string }>;
  /** Tables this slice did not reach; the next slice continues with them. */
  pendingTables?: string[];
  /** Tables the standby was missing and the server created before copying. */
  createdTables?: string[];
  countsMismatch?: string[];
  /** Rows on the source that the copy has not reached yet (it kept growing). */
  behindRows?: number;
  orphanRows?: number;
  /** How far the run got on this node, including earlier chunks. */
  progress?: DbSyncProgress;
  error?: string;
}

/**
 * Progress of a chunked sync run.
 *
 * `percent` is already capped by the server: the row estimate behind it comes
 * from `information_schema.TABLE_ROWS`, so it is never allowed to claim "done"
 * on its own — only a completed run reports 100.
 */
export interface DbSyncProgress {
  startedAt: number;
  percent: number;
  /** The run finished: every table walked and the counts agreed. */
  done: boolean;
  tablesTotal: number;
  tablesDone: number;
  rowsCopied: number;
  rowsEstimate: number;
}

export interface DbSyncResult {
  ok: boolean;
  complete: boolean;
  targets: DbTargetSyncReport[];
  rowsWritten: number;
  rowsInserted?: number;
  truncated: boolean;
  source?: { id: string; label: string };
  mode?: DbSyncCopyMode;
  /** Aggregate across targets, for one bar. */
  progress?: DbSyncProgress;
}

export type DbSyncCopyMode = 'merge' | 'overwrite';

export interface DbSyncOptions {
  targetIds?: string[];
  /** Node to read from; defaults to the primary. */
  sourceId?: string;
  /** `merge` (default) only inserts missing rows; `overwrite` replaces them. */
  mode?: DbSyncCopyMode;
  force?: boolean;
  /**
   * Time budget for this call (ms). Setting it opts into chunked mode: the
   * server copies for roughly that long, reports progress and returns, and the
   * caller comes back for the next slice.
   */
  budgetMs?: number;
  /**
   * Forget the resume point of an unfinished run and start from the first table.
   *
   * A cursor is a position in the source's key space: after rows are edited or
   * deleted upstream, continuing from it would permanently skip everything
   * before it, so the operator needs a way to say "start over".
   */
  restart?: boolean;
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
  if (options.budgetMs) body.budgetMs = options.budgetMs;
  if (options.restart) body.restart = true;

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
    rowsInserted: payload.rowsInserted,
    truncated: payload.truncated === true,
    source: payload.source,
    mode: payload.mode,
    progress: payload.progress,
  };
}

export interface DbPromoteResult {
  ok: boolean;
  promoted?: { id: string; label: string };
  demoted?: { id: string; label: string } | null;
  syncMode?: DbSyncMode;
  /** Writes the new primary had not seen when it was promoted. */
  lagAtPromote?: number;
  forced?: boolean;
  schemaReady?: boolean;
  warning?: string;
  error?: string;
  /** Reasons the switch was refused (409). */
  reasons?: string[];
  /** A gate refused the switch; retrying with `force` would override it. */
  blocked?: boolean;
}

/**
 * Switch which node receives writes.
 *
 * Throws for a refused switch (409/502) with the server's own explanation — the
 * text names what is missing ("落后 12 条写入", "只读副本") and is the only thing
 * that makes the force option an informed decision.
 */
export async function promoteDbNode(
  authedFetch: AuthedFetch,
  nodeId: string,
  force = false
): Promise<DbPromoteResult> {
  const resp = await authedFetch(`/api/admin/db-config/promote${force ? '?force=1' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, force }),
  });
  const payload = await parseJson<DbPromoteResult>(resp);
  if (!resp.ok || !payload?.ok) {
    const error = new Error(payload?.error || `切换主库失败（HTTP ${resp.status}）`);
    (error as Error & { blocked?: boolean; status?: number }).blocked = payload?.blocked === true;
    (error as Error & { blocked?: boolean; status?: number }).status = resp.status;
    throw error;
  }
  return payload;
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
