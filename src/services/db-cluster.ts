// Multi-node MySQL cluster adapter.
//
// The app talks to D1 (`prepare/bind/run|first|all` + `batch`). This adapter
// keeps that surface while spreading statements over several configured MySQL
// servers, which is what turns "one external database" into a cluster with a
// standby and/or a live copy:
//
//   • Writes  -> the node that currently holds *every* committed write; on a
//                connection-level failure the next enabled node takes over.
//   • Reads   -> that node, or replicas when `policy.readSplit` is on, with a
//                fallback if a replica fails.
//   • Replay  -> with `policy.syncMode === 'write-through'` every committed
//                statement is journalled and applied to the other nodes in
//                commit order, so a standby that takes over already holds it.
//
// Write watermark (why failover is not "point at the other server"):
//   A server that was down missed writes. Sending traffic back to it the moment
//   the cooldown expires leaves those rows only on the other node — the writes
//   are neither visible after the switch back nor reported anywhere. So every
//   committed write gets a sequence number, each node records the highest
//   sequence it has applied (`appliedSeq`), and:
//     - write candidates prefer nodes whose `appliedSeq` equals the latest
//       sequence (a recovered primary stays out of the write path until it is
//       caught up);
//     - a node that is behind is caught up by replaying the journal in order
//       before it is used (bounded: when the journal no longer covers the gap
//       the node is flagged `needsFullSync` and excluded until an admin sync);
//     - reads skip behind nodes as well, unless they are all we have.
//   In `native` mode the database replicates itself, so no journal is kept: the
//   standby already has the rows and the switch is immediate (that is the point
//   of native replication).
//
// Deliberate limits (also surfaced in the admin UI):
//   • A connection failure is a different thing from a SQL error: `ER_DUP_ENTRY`
//     or a syntax error must NOT move traffic to another server, otherwise a
//     bad statement would be applied twice.
//   • Not every transport failure is equal either: `ECONNREFUSED` proves the
//     statement never arrived, but `ECONNRESET` / `ETIMEDOUT` do not. Writes are
//     only replayed on the "never arrived" kind (C-2); the ambiguous ones are
//     surfaced so the caller can decide, because replaying them inserts a
//     second row.
//   • Cross-server writes are not atomic. The writing node commits first; if a
//     replica copy fails, its result still stands and the failure is recorded in
//     `nodeHealth()` and repaired by the journal or the admin sync.
//   • Health/watermark state is per process. A serverless deployment with
//     several instances keeps its own view; each instance only talks to the
//     servers it configured, and a failover is local.

import type { DbClusterPolicy } from './db-config';
import {
  MySqlDatabase,
  isReadOnlySql,
  type D1LikeDatabase,
  type D1LikeResult,
  type D1LikeStatement,
  type MySqlConfig,
} from './storage-mysql';

export interface ClusterNodeSpec extends MySqlConfig {
  /** Stable id from the stored config (also used in health output). */
  id: string;
  label: string;
  role: 'primary' | 'replica';
  priority: number;
  /**
   * Whether this node is known to hold a complete copy (persisted sync status).
   *
   * `undefined` means "unknown" (direct construction, tests) and is treated as
   * ready. The storage factory always passes a boolean in production, which is
   * what stops an empty standby from taking over: a node that has never been
   * synced is not a candidate for writes or reads.
   */
  syncReady?: boolean;
}

export interface NodeHealthSnapshot {
  id: string;
  label: string;
  role: 'primary' | 'replica';
  priority: number;
  /** Usable right now: not tripped, or the cooldown elapsed (S7: no longer
   *  conflated with `failoverEnabled` — a healthy replica is healthy). */
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
  /** Committed writes this node has not applied yet. */
  lag: number;
  /** Highest write sequence applied here. */
  appliedSeq: number;
  /** Writes that landed elsewhere while this node was unavailable. */
  missedWrites: number;
  /** Set when the node first fell behind; cleared once it catches up. */
  behindSince?: number;
  /** The write journal no longer covers the gap: a full sync is required. */
  needsFullSync: boolean;
  /** The server rejected a write as read-only (1290/1792). */
  writeBlocked: boolean;
  /** Persisted sync readiness, when known (write-through replicas). */
  syncReady?: boolean;
}

type StatementMode = 'run' | 'all' | 'first';

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

/**
 * Failures where the statement may already have been committed by the server
 * (the request was sent, the reply never arrived).
 *
 * Replaying one of these on another node runs the statement twice: UUID primary
 * keys turn into a duplicate-key error after the data is already in, and
 * `UPDATE x = x + 1` simply applies twice. `storage-mysql` already drew this
 * line for its own retry; the cluster keeps it (C-2).
 */
const AMBIGUOUS_WRITE_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'ER_CLIENT_INTERACTION_TIMEOUT',
  'ETIMEDOUT',
]);

const AMBIGUOUS_WRITE_ERRNOS = new Set([
  2006, // CR_SERVER_GONE_ERROR — the connection died at some point during the call
  2013, // CR_SERVER_LOST
]);

/** "This node is up but refuses writes" — a read-only replica, not an outage. */
const READ_ONLY_REJECTION_CODES = new Set([
  'ER_OPTION_PREVENTS_STATEMENT',
  'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
]);

const READ_ONLY_REJECTION_ERRNOS = new Set([1290, 1792]);

/** Bounded write journal. Beyond this a node needs a full sync instead. */
const WRITE_JOURNAL_MAX_ENTRIES = 2_000;
const WRITE_JOURNAL_MAX_BYTES = 2_000_000;
const JOURNAL_ENTRY_OVERHEAD = 96;

/**
 * Read-your-writes window: right after a commit, a standby may not have the row
 * yet (async replay), so reads stay on the writer briefly (C-5).
 */
const READ_YOUR_WRITES_MS = 1_000;

/** How long a node that answered 1290 stays out of the write candidates. */
const WRITE_BLOCKED_COOLDOWN_MS = 60_000;

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

/** The statement may have reached the server before the socket broke. */
export function isAmbiguousWriteFailure(error: unknown): boolean {
  const code = String((error as { code?: string })?.code ?? '');
  const errno = Number((error as { errno?: number })?.errno ?? 0);
  return AMBIGUOUS_WRITE_CODES.has(code) || AMBIGUOUS_WRITE_ERRNOS.has(errno);
}

/** The server is up but runs read-only (a native replica). */
export function isReadOnlyRejection(error: unknown): boolean {
  const code = String((error as { code?: string })?.code ?? '');
  const errno = Number((error as { errno?: number })?.errno ?? 0);
  if (READ_ONLY_REJECTION_CODES.has(code) || READ_ONLY_REJECTION_ERRNOS.has(errno)) return true;
  return /--read-only option|read[- ]only transaction|READ ONLY/i.test(nodeFailureMessage(error));
}

/** No node can take the write (all behind, all read-only, or all down). */
export class DbClusterUnavailableError extends Error {
  readonly code = 'ERR_DB_CLUSTER_UNAVAILABLE';
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = 'DbClusterUnavailableError';
  }
}

/**
 * The write was sent but its outcome is unknown. Deliberately not retried on
 * another node: see AMBIGUOUS_WRITE_CODES.
 */
export class DbClusterWriteUnconfirmedError extends Error {
  readonly code = 'ERR_DB_CLUSTER_WRITE_UNCONFIRMED';
  readonly status = 503;

  constructor(nodeLabel: string, cause: unknown) {
    super(
      `写入已发送到节点「${nodeLabel}」，但连接在返回结果前中断，无法确认是否已提交。` +
        '为避免重复写入，本次没有在其他节点重放；请稍后用相同主键重试或核对数据。'
    );
    this.name = 'DbClusterWriteUnconfirmedError';
    (this as { cause?: unknown }).cause = cause;
  }
}

interface JournalEntry {
  seq: number;
  statements: Array<{ sql: string; params: unknown[] }>;
  bytes: number;
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
  /** Highest write sequence applied to this node. */
  appliedSeq: number;
  /** Writes committed elsewhere that this node has not applied. */
  missedWrites: number;
  /** When the node first fell behind (cleared when it catches up). */
  behindSince?: number;
  /** The journal cannot bridge the gap any more. */
  needsFullSync: boolean;
  /** Read-only rejection cooldown (1290). */
  writeBlockedUntil: number;
  /**
   * Serialises replays into this node so statements land in commit order even
   * when `syncAsync` is on.
   */
  replayChain: Promise<void>;
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

function estimateBytes(statements: Array<{ sql: string; params: unknown[] }>): number {
  let total = 0;
  for (const statement of statements) {
    total += statement.sql.length + JOURNAL_ENTRY_OVERHEAD;
    for (const param of statement.params) {
      if (param === null || param === undefined) {
        total += 4;
      } else if (typeof param === 'string') {
        total += param.length + 8;
      } else if (param instanceof Uint8Array) {
        total += param.byteLength + 16;
      } else {
        total += 16;
      }
    }
  }
  return total;
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
  /** Sequence of the last committed write (0 = nothing written yet). */
  private writeSeq = 0;
  /** Committed writes, kept so a node that was down can be caught up. */
  private readonly journal = new Map<number, JournalEntry>();
  private journalBytes = 0;
  /** Node that currently holds the latest data (sticky across a failover). */
  private activeWriterId: string | null = null;
  private lastWriteAt = 0;

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
      appliedSeq: 0,
      missedWrites: 0,
      needsFullSync: false,
      writeBlockedUntil: 0,
      replayChain: Promise.resolve(),
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

  /**
   * Write watermarks, for the admin sync guard: syncing "backwards" (from a node
   * that missed writes into one that has them) would undo committed data (B-2).
   */
  writeWatermarks(): { writeSeq: number; nodes: Array<{ id: string; appliedSeq: number }> } {
    return {
      writeSeq: this.writeSeq,
      nodes: this.nodes.map((node) => ({ id: node.spec.id, appliedSeq: node.appliedSeq })),
    };
  }

  /**
   * Record that `id` now holds everything (the admin ran a complete sync).
   *
   * Also clears the journal gap flag: the operator just paid for a full copy, so
   * the node is usable again without a restart.
   */
  markNodeSynced(id: string): void {
    const node = this.nodes.find((entry) => entry.spec.id === id);
    if (!node) return;
    node.appliedSeq = this.writeSeq;
    node.needsFullSync = false;
    node.spec = { ...node.spec, syncReady: true };
    this.clearBehind(node);
  }

  nodeHealth(): NodeHealthSnapshot[] {
    const now = Date.now();
    return this.nodes.map((node) => ({
      id: node.spec.id,
      label: node.spec.label,
      role: node.spec.role,
      priority: node.spec.priority,
      available: node.downUntil <= now,
      failures: node.failures,
      lastError: node.lastError,
      lastOkAt: node.lastOkAt,
      lastFailureAt: node.lastFailureAt,
      downUntil: node.downUntil > now ? node.downUntil : undefined,
      syncErrors: node.syncErrors,
      lastSyncError: node.lastSyncError,
      lag: Math.max(0, this.writeSeq - node.appliedSeq),
      appliedSeq: node.appliedSeq,
      missedWrites: node.missedWrites,
      behindSince: node.behindSince,
      needsFullSync: node.needsFullSync,
      writeBlocked: node.writeBlockedUntil > now,
      syncReady: node.spec.syncReady,
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

  /** A read-only server is not failing — it just cannot be a write target. */
  private markWriteBlocked(node: NodeRuntime, error: unknown): void {
    const first = node.writeBlockedUntil <= Date.now();
    node.writeBlockedUntil = Date.now() + WRITE_BLOCKED_COOLDOWN_MS;
    node.lastError = nodeFailureMessage(error);
    if (first) {
      console.warn(
        `[db-cluster] node "${node.spec.label}" rejected a write as read-only; ` +
          `it stays out of the write candidates for ${WRITE_BLOCKED_COOLDOWN_MS}ms`
      );
    }
  }

  private markBehind(node: NodeRuntime): void {
    if (node.behindSince === undefined) node.behindSince = Date.now();
    node.missedWrites = Math.max(node.missedWrites, this.writeSeq - node.appliedSeq);
  }

  private clearBehind(node: NodeRuntime): void {
    node.behindSince = undefined;
    node.missedWrites = 0;
  }

  private markNeedsFullSync(node: NodeRuntime): void {
    this.markBehind(node);
    if (node.needsFullSync) return;
    node.needsFullSync = true;
    console.warn(
      `[db-cluster] node "${node.spec.label}" is ${this.writeSeq - node.appliedSeq} writes behind and the ` +
        'journal no longer covers the gap; it stays out of rotation until a full sync is run from the admin page.'
    );
  }

  private isCaughtUp(node: NodeRuntime): boolean {
    // Native replication keeps the copies in step on the server side; the app
    // has no watermark of its own and must not invent one.
    if (this.policy.syncMode !== 'write-through') return true;
    return node.appliedSeq >= this.writeSeq;
  }

  private canAcceptWrites(node: NodeRuntime): boolean {
    if (node.spec.syncReady === false) return false;
    if (node.needsFullSync) return false;
    return node.writeBlockedUntil <= Date.now();
  }

  /** Everything is down: retry the node whose cooldown ends first (half-open). */
  private availablePool(): NodeRuntime[] {
    const now = Date.now();
    const up = this.nodes.filter((node) => node.downUntil <= now);
    if (up.length > 0) return up;
    return [...this.nodes].sort((a, b) => a.downUntil - b.downUntil).slice(0, 1);
  }

  /**
   * Nodes to write through, best first.
   *
   * The primary is *not* automatically first: a primary that was down missed
   * writes and must not get traffic back until it has caught up (B-1). While it
   * is behind, the node that kept receiving writes stays the writer.
   */
  private writeCandidates(): NodeRuntime[] {
    if (!this.policy.failoverEnabled) return [this.primaryNode()];
    const pool = this.availablePool();
    const eligible = pool.filter((node) => this.canAcceptWrites(node));
    if (eligible.length === 0) {
      throw new DbClusterUnavailableError(
        '没有可写的数据库节点：所有节点都落后于最新写入或处于只读状态。' +
          '请先在 /admin/database 执行「同步数据」补齐落后的节点。'
      );
    }
    const caughtUp = eligible.filter((node) => this.isCaughtUp(node));
    return this.orderForWrite(caughtUp.length > 0 ? caughtUp : eligible);
  }

  private orderForWrite(list: NodeRuntime[]): NodeRuntime[] {
    const primary = this.primaryNode();
    // Stick to the node that holds the latest data while the primary is behind,
    // otherwise the very next write goes back to the stale server.
    const stickyId =
      this.activeWriterId && !this.isCaughtUp(primary) && list.some((node) => node.spec.id === this.activeWriterId)
        ? this.activeWriterId
        : null;
    return [...list].sort((a, b) => {
      if (stickyId) {
        if (a.spec.id === stickyId) return -1;
        if (b.spec.id === stickyId) return 1;
      }
      if (a.spec.role !== b.spec.role) return a.spec.role === 'primary' ? -1 : 1;
      return a.spec.priority - b.spec.priority;
    });
  }

  private readCandidates(): NodeRuntime[] {
    if (!this.policy.failoverEnabled) return [this.primaryNode()];
    const pool = this.availablePool();
    const ready = pool.filter((node) => node.spec.syncReady !== false);
    const base = ready.length > 0 ? ready : pool;
    // A node that is behind on the journal answers with stale rows (an item
    // created a minute ago is simply missing). Only fall back to it when it is
    // the last one standing — stale reads beat no service.
    const fresh = base.filter((node) => this.isCaughtUp(node));
    const candidates = fresh.length > 0 ? fresh : base;

    if (!this.policy.readSplit) {
      return [...candidates].sort((a, b) => (a.spec.role === b.spec.role ? 0 : a.spec.role === 'primary' ? -1 : 1));
    }

    // Read-your-writes: async replay may not have landed yet.
    if (Date.now() - this.lastWriteAt < READ_YOUR_WRITES_MS) {
      const writer = candidates.find((node) => node.spec.id === this.activeWriterId);
      if (writer) return [writer, ...candidates.filter((node) => node !== writer)];
    }

    const replicas = candidates.filter((node) => node.spec.role === 'replica');
    const primaries = candidates.filter((node) => node.spec.role === 'primary');
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

  private async applyEntry(node: NodeRuntime, entry: JournalEntry): Promise<void> {
    if (entry.statements.length === 1) {
      const [only] = entry.statements;
      await this.runOnNode(node, only.sql, only.params, 'run');
      return;
    }
    const local = entry.statements.map((statement) => {
      const prepared = node.db.prepare(statement.sql);
      if (statement.params.length > 0) prepared.bind(...statement.params);
      return prepared;
    });
    await node.db.batch(local);
  }

  /**
   * Bring `node` up to `targetSeq` by replaying the journal in commit order.
   *
   * Runs on the node's replay chain, so two concurrent requests cannot apply
   * sequence 7 before sequence 6. Returns false when the node cannot be caught
   * up (transport failure, or the journal no longer holds the missing entries).
   */
  private catchUp(node: NodeRuntime, targetSeq: number = this.writeSeq): Promise<boolean> {
    if (node.appliedSeq >= targetSeq) {
      if (node.needsFullSync) return Promise.resolve(false);
      this.clearBehind(node);
      return Promise.resolve(true);
    }
    const run = async (): Promise<boolean> => {
      while (node.appliedSeq < targetSeq) {
        const next = this.journal.get(node.appliedSeq + 1);
        if (!next) {
          this.markNeedsFullSync(node);
          return false;
        }
        try {
          await this.applyEntry(node, next);
        } catch (error) {
          // A duplicate key here means the row is already there (an earlier
          // attempt committed but its reply was lost) — the desired end state.
          if (isDuplicateKey(error)) {
            console.warn(
              `[db-cluster] node "${node.spec.label}" already had the row from write #${next.seq}; treating the replay as applied`
            );
          } else {
            node.syncErrors += 1;
            node.lastSyncError = nodeFailureMessage(error);
            if (isNodeLevelFailure(error)) this.markFailure(node, error);
            this.markBehind(node);
            console.warn(
              `[db-cluster] node "${node.spec.label}" could not be caught up (${nodeFailureMessage(error)}); ` +
                'it stays behind until the replay succeeds or the node is re-synced'
            );
            return false;
          }
        }
        node.appliedSeq = next.seq;
        if (this.isCaughtUp(node)) this.clearBehind(node);
      }
      return true;
    };
    const chained = node.replayChain.then(run, run);
    node.replayChain = chained.then(
      () => undefined,
      () => undefined
    );
    return chained;
  }

  /**
   * Append a committed write to the journal and advance the watermark.
   *
   * The sequence is assigned and the entry stored without an `await` in
   * between, so the journal is always dense (1..writeSeq) and two concurrent
   * requests cannot interleave their numbering.
   */
  private recordWrite(node: NodeRuntime, statements: Array<{ sql: string; params: unknown[] }>): number {
    this.activeWriterId = node.spec.id;
    this.lastWriteAt = Date.now();
    // Native replication has no journal: the database itself moves the rows, so
    // there is nothing to replay and no sequence to keep.
    if (this.policy.syncMode !== 'write-through') return 0;

    const seq = this.writeSeq + 1;
    this.writeSeq = seq;
    // The writer is by definition up to date — mark it before trimming so the
    // eviction sweep cannot flag it as needing a full sync.
    node.appliedSeq = seq;
    this.clearBehind(node);

    const bytes = estimateBytes(statements);
    this.journal.set(seq, { seq, statements, bytes });
    this.journalBytes += bytes;
    this.trimJournal();
    return seq;
  }

  private trimJournal(): void {
    while (this.journal.size > WRITE_JOURNAL_MAX_ENTRIES || this.journalBytes > WRITE_JOURNAL_MAX_BYTES) {
      const oldest = this.journal.keys().next();
      if (oldest.done) return;
      const entry = this.journal.get(oldest.value);
      if (!entry) return;
      this.journal.delete(oldest.value);
      this.journalBytes = Math.max(0, this.journalBytes - entry.bytes);
      for (const node of this.nodes) {
        if (node.appliedSeq < entry.seq) this.markNeedsFullSync(node);
      }
    }
  }

  /** Replay sequences up to `seq` on every other node (write-through only). */
  private async replicate(seq: number, source: NodeRuntime, failedThisRequest: Set<string>): Promise<void> {
    if (this.policy.syncMode !== 'write-through') return;
    const now = Date.now();
    // Nodes that just failed in this very request are skipped: replaying into a
    // server we know is down would add its connect timeout to the user's request
    // for nothing. A node that answered "read-only" is skipped for the same
    // reason — the replay cannot succeed there either.
    const targets = this.nodes.filter(
      (node) =>
        node !== source &&
        node.downUntil <= now &&
        node.writeBlockedUntil <= now &&
        !failedThisRequest.has(node.spec.id)
    );
    if (targets.length === 0) return;

    const runs = targets.map((node) => this.catchUp(node, seq));
    if (this.policy.syncAsync) {
      // Fire and forget: the request path must not wait for a standby write.
      void Promise.allSettled(runs);
      return;
    }
    await Promise.allSettled(runs);
  }

  async execute(sql: string, params: unknown[], mode: 'run' | 'all'): Promise<D1LikeResult>;
  async execute(sql: string, params: unknown[], mode: 'first'): Promise<Record<string, unknown> | null>;
  async execute(sql: string, params: unknown[], mode: StatementMode): Promise<unknown> {
    // Reads are only statements that are read-only *and* fetched through
    // all()/first(): a SELECT sent via run() keeps going to the writer, which is
    // the safe direction to be wrong in.
    const isRead = mode !== 'run' && isReadOnlySql(sql);
    return isRead ? this.executeRead(sql, params, mode) : this.executeWrite(sql, params, mode);
  }

  private async executeRead(sql: string, params: unknown[], mode: StatementMode): Promise<unknown> {
    const candidates = this.readCandidates();
    let lastError: unknown = null;

    for (const node of candidates) {
      try {
        const result = await this.runOnNode(node, sql, params, mode);
        this.markOk(node);
        return result;
      } catch (error) {
        lastError = error;
        if (!isNodeLevelFailure(error)) throw error; // a SQL error is not a node outage
        this.markFailure(node, error);
        console.warn(
          `[db-cluster] read on "${node.spec.label}" failed (${nodeFailureMessage(error)}); trying the next node`
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new DbClusterUnavailableError('所有数据库节点都无法响应读请求。');
  }

  private async executeWrite(sql: string, params: unknown[], mode: StatementMode): Promise<unknown> {
    const candidates = this.writeCandidates();
    let lastError: unknown = null;
    const failedThisRequest = new Set<string>();

    for (const node of candidates) {
      // Catch up first: running the statement on top of stale data could make it
      // a no-op (UPDATE of a row that only exists on the other node) — a silent
      // lost write.
      if (!(await this.catchUp(node))) {
        lastError = new DbClusterUnavailableError(
          `节点「${node.spec.label}」落后于最新写入且无法自动补齐，已跳过；请执行「同步数据」。`
        );
        continue;
      }
      try {
        const result = await this.runOnNode(node, sql, params, mode);
        this.markOk(node);
        const seq = this.recordWrite(node, [{ sql, params }]);
        await this.replicate(seq, node, failedThisRequest);
        return result;
      } catch (error) {
        lastError = error;
        if (isNodeLevelFailure(error)) failedThisRequest.add(node.spec.id);
        this.handleWriteFailure(node, error);
      }
    }

    throw this.finalWriteError(lastError);
  }

  /**
   * Turn whatever the last attempt produced into something the caller can act
   * on. A raw "The MySQL server is running with the --read-only option" tells the
   * user nothing about what to do (C-1).
   */
  private finalWriteError(lastError: unknown): Error {
    if (isReadOnlyRejection(lastError)) {
      return new DbClusterUnavailableError(
        '当前只能连到只读副本，无法写入：请确认主库在线并已恢复，' +
          '或把副库同步方式改为「应用层实时双写」后再做故障切换。'
      );
    }
    if (lastError instanceof Error) return lastError;
    return new DbClusterUnavailableError('所有数据库节点都无法接受写入。');
  }

  /**
   * Decide what a failed write means. May throw (SQL error, unconfirmed write).
   * Returning normally means "try the next node".
   */
  private handleWriteFailure(node: NodeRuntime, error: unknown): void {
    if (isReadOnlyRejection(error)) {
      // A replica of a native pair: healthy, just not writable.
      this.markWriteBlocked(node, error);
      console.warn(
        `[db-cluster] node "${node.spec.label}" is read-only; trying the next node for this write`
      );
      return;
    }
    if (!isNodeLevelFailure(error)) throw error; // a SQL error is not a node outage
    this.markFailure(node, error);
    if (isAmbiguousWriteFailure(error)) throw new DbClusterWriteUnconfirmedError(node.spec.label, error);
    console.warn(
      `[db-cluster] node "${node.spec.label}" failed (${nodeFailureMessage(error)}); trying the next node`
    );
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

    const candidates = this.writeCandidates();
    let lastError: unknown = null;
    const failedThisRequest = new Set<string>();

    for (const node of candidates) {
      if (!(await this.catchUp(node))) {
        lastError = new DbClusterUnavailableError(
          `节点「${node.spec.label}」落后于最新写入且无法自动补齐，已跳过；请执行「同步数据」。`
        );
        continue;
      }
      try {
        const local = entries.map((entry) => {
          const statement = node.db.prepare(entry.sql);
          if (entry.params.length > 0) statement.bind(...entry.params);
          return statement;
        });
        const results = await node.db.batch(local);
        this.markOk(node);
        const seq = this.recordWrite(node, entries);
        await this.replicate(seq, node, failedThisRequest);
        return results;
      } catch (error) {
        lastError = error;
        if (isNodeLevelFailure(error)) failedThisRequest.add(node.spec.id);
        this.handleWriteFailure(node, error);
      }
    }

    throw this.finalWriteError(lastError);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.nodes.map((node) => node.db.close()));
  }
}

function isDuplicateKey(error: unknown): boolean {
  const errno = Number((error as { errno?: number })?.errno ?? 0);
  const code = String((error as { code?: string })?.code ?? '');
  // When the driver reports a symbolic code, it wins: some adapters put 1062 in
  // `errno` for every server error, and treating ER_NO_SUCH_TABLE as "already
  // applied" would silently skip a replay.
  if (code) return code === 'ER_DUP_ENTRY';
  if (errno === 1062) return true;
  return /Duplicate entry .* for key|UNIQUE constraint failed/i.test(nodeFailureMessage(error));
}

export function isMySqlClusterDatabase(db: unknown): db is MySqlClusterDatabase {
  return !!db && typeof db === 'object' && (db as { clusterNodes?: unknown }).clusterNodes !== undefined;
}
