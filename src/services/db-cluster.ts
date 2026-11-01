// Multi-node MySQL cluster adapter.
//
// The app talks to D1 (`prepare/bind/run|first|all` + `batch`). This adapter
// keeps that surface while spreading statements over several configured MySQL
// servers, which is what turns "one external database" into a cluster with a
// standby and/or a live copy:
//
//   • Writes  -> the active primary; on a *connection-level* failure the next
//                enabled node (by role/priority) takes over transparently.
//   • Reads   -> the primary, or replicas when `policy.readSplit` is on, with a
//                fallback to the primary if a replica fails.
//   • Replay  -> with `policy.syncMode === 'write-through'` every statement that
//                wrote successfully is applied to the other nodes as well, so a
//                standby that takes over already holds the data.
//
// Deliberate limits (also surfaced in the admin UI):
//   • A connection failure is a different thing from a SQL error: `ER_DUP_ENTRY`
//     or a syntax error must NOT move traffic to another server, otherwise a
//     bad statement would be applied twice. Only transport-level failures
//     (refused/timeout/reset/unknown host/pool cap) trigger failover.
//   • Cross-server writes are not atomic. The primary commits first; if a
//     replica copy fails, the primary's result still stands and the failure is
//     recorded in `nodeHealth()` for the admin to see and repair.
//   • Health/circuit state is per process. A serverless deployment with several
//     instances keeps its own view; that is acceptable because each instance
//     only ever talks to the servers it configured, and a failover is local.

import type { DbClusterPolicy } from './db-config';
import { MySqlDatabase, type D1LikeDatabase, type D1LikeResult, type D1LikeStatement, type MySqlConfig } from './storage-mysql';

export interface ClusterNodeSpec extends MySqlConfig {
  /** Stable id from the stored config (also used in health output). */
  id: string;
  label: string;
  role: 'primary' | 'replica';
  priority: number;
}

export interface NodeHealthSnapshot {
  id: string;
  label: string;
  role: 'primary' | 'replica';
  priority: number;
  /** Usable right now (not tripped, or the cooldown elapsed). */
  available: boolean;
  failures: number;
  lastError?: string;
  lastOkAt?: number;
  lastFailureAt?: number;
  /** Timestamp until which the node is skipped after tripping the breaker. */
  downUntil?: number;
  /** Failed replica replays (write-through only). */
  syncErrors: number;
  lastSyncError?: string;
}

type StatementMode = 'run' | 'all' | 'first';

/**
 * Statements with no side effects. Replicas may serve these; anything else is a
 * write and has to be ordered through the primary.
 */
const READ_ONLY_SQL = /^\s*(?:SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH\s+RECURSIVE)\b/i;

/**
 * Transport failures. These mean "this server/pool cannot be used right now",
 * which is exactly when moving to the next node helps.
 */
const NODE_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_CLIENT_INTERACTION_TIMEOUT',
  // The server refused a *new* connection because of max_connections: the node
  // is saturated, so spilling over is the right call.
  'ER_CON_COUNT_ERROR',
]);

const NODE_FAILURE_ERRNOS = new Set([
  1040, // ER_CON_COUNT_ERROR
  2002, // CR_CONN_HOST_ERROR
  2003, // CR_CONNECTION_ERROR
  2006, // CR_SERVER_GONE_ERROR
  2013, // CR_SERVER_LOST
]);

function nodeFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isNodeLevelFailure(error: unknown): boolean {
  const code = String((error as { code?: string })?.code ?? '');
  const errno = Number((error as { errno?: number })?.errno ?? 0);
  if (NODE_FAILURE_CODES.has(code) || NODE_FAILURE_ERRNOS.has(errno)) return true;
  const message = nodeFailureMessage(error);
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|PROTOCOL_CONNECTION_LOST|Connection lost|connect timeout|Connection refused/i.test(
    message
  );
}

interface NodeRuntime {
  spec: ClusterNodeSpec;
  db: NodeDatabase;
  failures: number;
  downUntil: number;
  lastError?: string;
  lastOkAt?: number;
  lastFailureAt?: number;
  syncErrors: number;
  lastSyncError?: string;
}

/** The surface the cluster needs from one node (MySqlDatabase satisfies it). */
export interface NodeDatabase {
  prepare(sql: string): D1LikeStatement;
  batch(statements: D1LikeStatement[]): Promise<D1LikeResult[]>;
  close(): Promise<void>;
}

export type NodeDatabaseFactory = (config: MySqlConfig) => NodeDatabase;

function defaultNodeFactory(config: MySqlConfig): NodeDatabase {
  return new MySqlDatabase(config);
}

class ClusterStatement implements D1LikeStatement {
  private params: unknown[] = [];

  constructor(
    private readonly cluster: MySqlClusterDatabase,
    private readonly sql: string
  ) {}

  bind(...params: unknown[]): D1LikeStatement {
    // Keep the raw values: each underlying MySqlStatement normalizes them
    // (undefined -> null, booleans -> 0/1) on its own bind().
    this.params = params;
    return this;
  }

  getSql(): string {
    return this.sql;
  }

  getParams(): unknown[] {
    return this.params;
  }

  run(): Promise<D1LikeResult> {
    return this.cluster.execute(this.sql, this.params, 'run');
  }

  all<R = Record<string, unknown>>(): Promise<D1LikeResult<R>> {
    return this.cluster.execute(this.sql, this.params, 'all') as Promise<D1LikeResult<R>>;
  }

  first<R = Record<string, unknown>>(): Promise<R | null> {
    return this.cluster.execute(this.sql, this.params, 'first') as Promise<R | null>;
  }
}

export class MySqlClusterDatabase implements D1LikeDatabase {
  /** Lets the storage layer recognize the adapter (see isMySqlDatabase). */
  readonly dialect = 'mysql';
  /** Marker so callers can tell a cluster from a single-node adapter. */
  readonly clusterNodes = true;
  private readonly nodes: NodeRuntime[];
  private readonly policy: DbClusterPolicy;
  private readCursor = 0;

  constructor(specs: ClusterNodeSpec[], policy: DbClusterPolicy, createDb: NodeDatabaseFactory = defaultNodeFactory) {
    this.policy = policy;
    // Primary first, then by the operator-configured failover order. Ties keep
    // the stored order so the behaviour is predictable.
    const ordered = [...specs].sort((a, b) => {
      if (a.role !== b.role) return a.role === 'primary' ? -1 : 1;
      return a.priority - b.priority;
    });
    this.nodes = ordered.map((spec) => ({
      spec,
      db: createDb({
        host: spec.host,
        port: spec.port,
        user: spec.user,
        password: spec.password,
        database: spec.database,
        ssl: spec.ssl,
        connectionLimit: spec.connectionLimit,
        connectTimeoutMs: spec.connectTimeoutMs ?? 10_000,
      }),
      failures: 0,
      downUntil: 0,
      syncErrors: 0,
    }));
  }

  getPolicy(): DbClusterPolicy {
    return this.policy;
  }

  /** Schema key helper: the primary's identity (see StorageService.schemaKeyFor). */
  getConfig(): { host: string; port: number; database: string } {
    const primary = this.primaryNode();
    return { host: primary.spec.host, port: primary.spec.port, database: primary.spec.database };
  }

  /** Every node's database handle, for per-node schema bootstrap. */
  nodeDatabases(): Array<{ id: string; db: NodeDatabase }> {
    return this.nodes.map((node) => ({ id: node.spec.id, db: node.db }));
  }

  nodeHealth(): NodeHealthSnapshot[] {
    const now = Date.now();
    return this.nodes.map((node) => ({
      id: node.spec.id,
      label: node.spec.label,
      role: node.spec.role,
      priority: node.spec.priority,
      available: this.policy.failoverEnabled ? node.downUntil <= now : node.spec.role === 'primary',
      failures: node.failures,
      lastError: node.lastError,
      lastOkAt: node.lastOkAt,
      lastFailureAt: node.lastFailureAt,
      downUntil: node.downUntil > now ? node.downUntil : undefined,
      syncErrors: node.syncErrors,
      lastSyncError: node.lastSyncError,
    }));
  }

  private primaryNode(): NodeRuntime {
    return this.nodes.find((node) => node.spec.role === 'primary') ?? this.nodes[0];
  }

  private markOk(node: NodeRuntime): void {
    node.failures = 0;
    node.downUntil = 0;
    node.lastOkAt = Date.now();
  }

  private markFailure(node: NodeRuntime, error: unknown): void {
    node.failures += 1;
    node.lastError = nodeFailureMessage(error);
    node.lastFailureAt = Date.now();
    if (node.failures >= this.policy.failureThreshold) {
      node.downUntil = Date.now() + this.policy.cooldownMs;
      console.warn(
        `[db-cluster] node "${node.spec.label}" tripped after ${node.failures} failures; ` +
          `skipping it for ${this.policy.cooldownMs}ms`
      );
    }
  }

  /**
   * Nodes to try, best first.
   *
   * When everything is tripped the list is *not* empty: the node whose cooldown
   * ends first is retried anyway (half-open). Returning an empty list would turn
   * one bad minute into a permanently failed instance.
   */
  private candidates(kind: 'read' | 'write'): NodeRuntime[] {
    if (!this.policy.failoverEnabled) {
      return [this.primaryNode()];
    }
    const now = Date.now();
    const isAvailable = (node: NodeRuntime) => node.downUntil <= now;
    const healthy = this.nodes.filter(isAvailable);
    const pool = healthy.length > 0 ? healthy : [...this.nodes].sort((a, b) => a.downUntil - b.downUntil).slice(0, 1);

    if (kind === 'write') return pool;

    // Read: when splitting is on, start at a replica and rotate. The primary
    // stays in the list as the last resort.
    if (!this.policy.readSplit) {
      return pool.sort((a, b) => (a.spec.role === b.spec.role ? 0 : a.spec.role === 'primary' ? -1 : 1));
    }
    const replicas = pool.filter((node) => node.spec.role === 'replica');
    const primaries = pool.filter((node) => node.spec.role === 'primary');
    if (replicas.length === 0) return primaries;
    const start = this.readCursor % replicas.length;
    this.readCursor += 1;
    return [...replicas.slice(start), ...replicas.slice(0, start), ...primaries];
  }

  private async runOnNode(
    node: NodeRuntime,
    sql: string,
    params: unknown[],
    mode: StatementMode
  ): Promise<unknown> {
    const statement = node.db.prepare(sql);
    if (params.length > 0) statement.bind(...params);
    // Each node builds its own statement: the adapter keeps the per-node pool,
    // dialect translation and DDL re-run tolerance that MySqlDatabase already
    // implements, so nothing is lost by routing here.
    if (mode === 'run') return statement.run();
    if (mode === 'all') return statement.all();
    return statement.first();
  }

  async execute(sql: string, params: unknown[], mode: 'run' | 'all'): Promise<D1LikeResult>;
  async execute(sql: string, params: unknown[], mode: 'first'): Promise<Record<string, unknown> | null>;
  async execute(sql: string, params: unknown[], mode: StatementMode): Promise<unknown> {
    const isRead = mode !== 'run' && READ_ONLY_SQL.test(sql);
    const candidates = this.candidates(isRead ? 'read' : 'write');
    let lastError: unknown = null;
    /** Nodes that already failed in *this* request (see replicate()). */
    const failedThisRequest = new Set<string>();

    for (const node of candidates) {
      try {
        const result = await this.runOnNode(node, sql, params, mode);
        this.markOk(node);
        if (!isRead) await this.replicate(sql, params, node, failedThisRequest);
        return result;
      } catch (error) {
        lastError = error;
        if (!isNodeLevelFailure(error)) throw error; // a SQL error is not a node outage
        this.markFailure(node, error);
        failedThisRequest.add(node.spec.id);
        console.warn(
          `[db-cluster] node "${node.spec.label}" failed (${nodeFailureMessage(error)}); trying the next node`
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('[db-cluster] every configured database node failed');
  }

  /**
   * Replay a committed write on the other nodes.
   *
   * Failures never surface to the caller: the primary already committed, so
   * throwing here would report a failure for a write that actually happened.
   * They are recorded per node and shown in the admin health panel instead.
   */
  private async replicate(
    sql: string,
    params: unknown[],
    source: NodeRuntime,
    failedThisRequest: Set<string>
  ): Promise<void> {
    if (this.policy.syncMode !== 'write-through') return;
    // Skip nodes the breaker already took out, and nodes that just failed in
    // this very request: replaying into a server we know is down would add its
    // connect timeout to the user's request for nothing.
    const targets = this.nodes.filter(
      (node) => node !== source && node.downUntil <= Date.now() && !failedThisRequest.has(node.spec.id)
    );
    if (targets.length === 0) return;

    const apply = async (node: NodeRuntime) => {
      try {
        await this.runOnNode(node, sql, params, 'run');
        this.markOk(node);
      } catch (error) {
        node.syncErrors += 1;
        node.lastSyncError = nodeFailureMessage(error);
        if (isNodeLevelFailure(error)) this.markFailure(node, error);
        console.warn(
          `[db-cluster] replica "${node.spec.label}" fell behind (${nodeFailureMessage(error)}). ` +
            'The primary write is kept; re-sync this node from the primary.'
        );
      }
    };

    if (this.policy.syncAsync) {
      // Fire and forget: the request path must not wait for a standby write.
      void Promise.allSettled(targets.map(apply));
      return;
    }
    await Promise.allSettled(targets.map(apply));
  }

  prepare(sql: string): D1LikeStatement {
    return new ClusterStatement(this, sql);
  }

  async batch(statements: D1LikeStatement[]): Promise<D1LikeResult[]> {
    const entries = statements.map((statement) => {
      const clusterStatement = statement as ClusterStatement;
      if (typeof clusterStatement.getSql !== 'function') {
        throw new Error('[db-cluster] batch() received a statement that was not created by this adapter');
      }
      return { sql: clusterStatement.getSql(), params: clusterStatement.getParams() };
    });

    const candidates = this.candidates('write');
    let lastError: unknown = null;
    const failedThisRequest = new Set<string>();

    for (const node of candidates) {
      try {
        const local = entries.map((entry) => {
          const statement = node.db.prepare(entry.sql);
          if (entry.params.length > 0) statement.bind(...entry.params);
          return statement;
        });
        const results = await node.db.batch(local);
        this.markOk(node);
        await this.replicateBatch(entries, node, failedThisRequest);
        return results;
      } catch (error) {
        lastError = error;
        if (!isNodeLevelFailure(error)) throw error;
        this.markFailure(node, error);
        failedThisRequest.add(node.spec.id);
        console.warn(`[db-cluster] batch on "${node.spec.label}" failed; trying the next node`);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('[db-cluster] every configured database node failed');
  }

  /** Same contract as replicate(), for a transactional batch. */
  private async replicateBatch(
    entries: Array<{ sql: string; params: unknown[] }>,
    source: NodeRuntime,
    failedThisRequest: Set<string>
  ): Promise<void> {
    if (this.policy.syncMode !== 'write-through') return;
    const targets = this.nodes.filter(
      (node) => node !== source && node.downUntil <= Date.now() && !failedThisRequest.has(node.spec.id)
    );
    if (targets.length === 0) return;

    const apply = async (node: NodeRuntime) => {
      try {
        const local = entries.map((entry) => {
          const statement = node.db.prepare(entry.sql);
          if (entry.params.length > 0) statement.bind(...entry.params);
          return statement;
        });
        await node.db.batch(local);
        this.markOk(node);
      } catch (error) {
        node.syncErrors += 1;
        node.lastSyncError = nodeFailureMessage(error);
        if (isNodeLevelFailure(error)) this.markFailure(node, error);
        console.warn(
          `[db-cluster] replica "${node.spec.label}" rejected a replayed batch (${nodeFailureMessage(error)})`
        );
      }
    };

    if (this.policy.syncAsync) {
      void Promise.allSettled(targets.map(apply));
      return;
    }
    await Promise.allSettled(targets.map(apply));
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.nodes.map((node) => node.db.close()));
  }
}

export function isMySqlClusterDatabase(db: unknown): db is MySqlClusterDatabase {
  return !!db && typeof db === 'object' && (db as { clusterNodes?: unknown }).clusterNodes !== undefined;
}
