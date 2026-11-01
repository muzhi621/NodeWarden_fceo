// BYO-DB configuration: resolve MySQL connection settings from environment
// variables and/or an encrypted runtime config (settable from the admin UI).
//
// Resolution order:
//   1. env.DB_HOST / env.DB_MODE=mysql  -> env vars (source: 'env')
//   2. encrypted runtime config in SETTINGS_KV / R2 / ATTACHMENTS_KV (source: 'runtime')
//   3. otherwise D1 (source: 'd1')
//
// Runtime config is stored AES-256-GCM encrypted. The master key comes from
// env.DB_CONFIG_KEY (base64 32 bytes, or any passphrase — hashed with SHA-256).
//
// Config schema v2 (multi-node) replaces the single-connection v1 blob:
//   { version: 2, mode: 'mysql', nodes: [...], policy: {...} }
// Stored v1 payloads are upgraded in memory on read (see normalizeRuntimeConfig),
// so an existing deployment keeps working without a re-save.

import type { Env } from '../types';

/** Primary accepts writes; replica is a standby / read-only peer. */
export type DbNodeRole = 'primary' | 'replica';

/**
 * `native`      — the database itself replicates (MySQL binlog / managed
 *                 replica). The app only reads from it and may fail over to it.
 * `write-through` — the app replays every write on this node as well, which is
 *                 what makes a *standalone* second server a live copy. Do NOT
 *                 combine this with native replication: both would apply the
 *                 same INSERT and the copy would reject it as a duplicate.
 */
export type DbSyncMode = 'native' | 'write-through';

export interface DbNodeConfig {
  /** Stable identifier used by the admin UI to diff/keep passwords per node. */
  id: string;
  label: string;
  role: DbNodeRole;
  /** Failover order among nodes of the same role: lower wins. */
  priority: number;
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  connectionLimit: number;
}

export interface DbClusterPolicy {
  /** Send read-only statements to replicas when one is available. */
  readSplit: boolean;
  syncMode: DbSyncMode;
  /**
   * Only meaningful for `write-through`: fire the replica write without
   * awaiting it. Faster request path, but a failed replica write is then only
   * visible in the admin health panel.
   */
  syncAsync: boolean;
  failoverEnabled: boolean;
  /** Consecutive connection-level failures before a node is taken out. */
  failureThreshold: number;
  /** How long a tripped node stays out before a half-open retry. */
  cooldownMs: number;
}

export interface DbRuntimeConfigV2 {
  version: 2;
  mode: 'mysql';
  nodes: DbNodeConfig[];
  policy: DbClusterPolicy;
}

/** Legacy single-connection payload, still found in existing deployments. */
export interface DbLegacyConfigV1 {
  version?: 1;
  mode: 'mysql' | 'd1';
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  connectionLimit?: number;
}

export type DbRuntimeConfig = DbRuntimeConfigV2;

/** One resolved node, flattened with the config source for display. */
export interface ResolvedDbNode extends DbNodeConfig {
  source: 'env' | 'runtime';
  /** Persisted sync bookkeeping (write-through replicas). */
  syncStatus?: DbNodeSyncState;
  /**
   * Whether this node may be used at all. `false` means a write-through replica
   * that has never completed a sync — it is kept out of rotation instead of
   * taking over as an empty database. `undefined` means "not applicable"
   * (primary, native replication, env-only config).
   */
  syncReady?: boolean;
}

export interface ResolvedDbCluster {
  mode: 'mysql' | 'd1';
  source: 'env' | 'runtime' | 'd1';
  nodes: ResolvedDbNode[];
  policy: DbClusterPolicy;
  /**
   * Set when the cluster is unusable *while* a config exists: every node is
   * disabled, or a stored config resolved to nothing.
   *
   * Falling back to D1 silently is the dangerous part — on a Node runtime there
   * is no D1 binding, so the app dies on `undefined.prepare()` with no hint
   * about what the operator changed; on Workers it would quietly start using a
   * different database. The storage factory turns this into an actionable 503.
   */
  unavailableReason?: string;
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

export interface MaskedDbCluster {
  mode: 'mysql' | 'd1';
  source: 'env' | 'runtime' | 'd1';
  nodes: MaskedDbNode[];
  policy: DbClusterPolicy;
  /** Config exists but nothing is usable — see `ResolvedDbCluster`. */
  unavailableReason?: string;
}

/**
 * Kept for the older single-connection call sites (health checks, audit
 * metadata). Derived from the cluster's primary node.
 */
export interface ResolvedDbConfig {
  mode: 'mysql' | 'd1';
  source: 'env' | 'runtime' | 'd1';
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  connectionLimit: number;
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

const CONFIG_OBJECT_KEY = '__system__/db-config.json';
const CONFIG_KV_KEY = 'db-config:v1';

/**
 * Per-node sync bookkeeping lives in its own object: it is written by the sync
 * endpoint, has no secrets, and must survive a process restart — a standby that
 * was synced once stays usable, and one that never was stays out of rotation
 * (B-4: "can this node take over?" has to be an answerable question).
 */
const SYNC_STATUS_OBJECT_KEY = '__system__/db-sync-status.json';
const SYNC_STATUS_KV_KEY = 'db-sync-status:v1';

/**
 * Write watermark, persisted so a restart does not silently un-flag a standby
 * that was behind (B1).
 *
 * Only the *relationship* is meaningful: `writeSeq` and each node's
 * `appliedSeq` compared against it. The absolute numbers can be stale — after a
 * restart the counters simply continue from the stored `writeSeq`, and nodes
 * that were level stay level. The journal itself is not persisted, so a node
 * that was behind keeps `needsFullSync` until an admin sync.
 */
const WATERMARK_OBJECT_KEY = '__system__/db-watermark.json';
const WATERMARK_KV_KEY = 'db-watermark:v1';

/** Shape stored by MySqlClusterDatabase.watermarkSnapshot(). */
export interface ClusterWatermarkSnapshot {
  writeSeq: number;
  nodes: Record<string, number>;
}

interface StoreKeys {
  kv: string;
  object: string;
}

const CONFIG_KEYS: StoreKeys = { kv: CONFIG_KV_KEY, object: CONFIG_OBJECT_KEY };
const SYNC_STATUS_KEYS: StoreKeys = { kv: SYNC_STATUS_KV_KEY, object: SYNC_STATUS_OBJECT_KEY };
const WATERMARK_KEYS: StoreKeys = { kv: WATERMARK_KV_KEY, object: WATERMARK_OBJECT_KEY };

/** What the admin page needs to answer "is this standby ready?". */
export interface DbNodeSyncState {
  /** When the last sync run finished. */
  at: number;
  /** Walked every table to the end and the row counts matched. */
  complete: boolean;
  /**
   * Which database the row counts referred to: `host|port|database`.
   *
   * Sync bookkeeping is keyed by node id, and the admin UI keeps that id when a
   * node is edited (it is how the stored password is preserved). Without a
   * fingerprint, pointing an already-synced node at a brand-new empty database
   * left it marked ready and eligible to take over (B4).
   */
  fingerprint?: string;
  /** Hit a row cap / the time budget: more runs are needed. */
  truncated: boolean;
  rowsWritten: number;
  tables: number;
  /** Node the rows were copied from (cursors are only valid for that source). */
  sourceId?: string;
  /** Resume positions for the tables that were cut short (B-3). */
  cursors?: Record<string, Array<string | number | boolean | null>>;
}

export type DbSyncStates = Record<string, DbNodeSyncState>;

/** Identity of the database a node points at (not of the node entry itself). */
export function nodeFingerprint(node: { host: string; port: number; database: string }): string {
  return `${node.host}|${node.port}|${node.database}`;
}

/**
 * Safe defaults. `native` is deliberate: two nodes configured against a real
 * MySQL primary/replica pair already share writes, and replaying them from the
 * app would collide on primary keys. Intercepting writes is opt-in.
 */
export const DEFAULT_CLUSTER_POLICY: DbClusterPolicy = {
  readSplit: false,
  syncMode: 'native',
  syncAsync: false,
  failoverEnabled: true,
  failureThreshold: 3,
  cooldownMs: 30_000,
};

export const CLUSTER_LIMITS = {
  maxNodes: 8,
  minConnectionLimit: 1,
  maxConnectionLimit: 64,
  minFailureThreshold: 1,
  maxFailureThreshold: 10,
  minCooldownMs: 5_000,
  maxCooldownMs: 10 * 60_000,
} as const;

interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function asKvLike(value: unknown): KvLike | null {
  if (!value || typeof value !== 'object') return null;
  const kv = value as Partial<KvLike>;
  if (typeof kv.get !== 'function' || typeof kv.put !== 'function') return null;
  return {
    get: (key: string) => Promise.resolve(kv.get!.call(value, key) as Promise<string | null>),
    put: (key: string, val: string) => Promise.resolve(kv.put!.call(value, key, val) as Promise<void>),
    delete: (key: string) => Promise.resolve((kv.delete as (k: string) => Promise<void>)?.call(value, key)),
  };
}

function getConfigStore(env: Env): 'kv' | 'r2' | 'attachment-kv' | null {
  if (asKvLike(env.SETTINGS_KV)) return 'kv';
  if (env.ATTACHMENTS) return 'r2';
  if (asKvLike(env.ATTACHMENTS_KV)) return 'attachment-kv';
  return null;
}

async function deriveKey(env: Env): Promise<CryptoKey | null> {
  const raw = (env.DB_CONFIG_KEY || '').trim();
  if (!raw) return null;
  const subtle = crypto.subtle;
  let keyBytes: ArrayBuffer | null = null;
  try {
    const b64 = atob(raw.trim());
    if (b64.length === 32) {
      const bytes = new Uint8Array(b64.length);
      for (let i = 0; i < b64.length; i += 1) bytes[i] = b64.charCodeAt(i);
      keyBytes = bytes.buffer;
    }
  } catch {
    // not base64 — fall through to hash
  }
  if (!keyBytes) {
    keyBytes = await subtle.digest('SHA-256', new TextEncoder().encode(raw));
  }
  return subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptJson(env: Env, data: DbRuntimeConfig): Promise<string | null> {
  const key = await deriveKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('nodewarden-db-config:v1') },
    key,
    plaintext
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  let binary = '';
  combined.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return `v1:${btoa(binary)}`;
}

async function decryptJson(env: Env, payload: string): Promise<unknown | null> {
  const key = await deriveKey(env);
  if (!key) return null;
  if (!payload.startsWith('v1:')) return null;
  try {
    const binary = atob(payload.slice(3));
    const combined = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) combined[i] = binary.charCodeAt(i);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('nodewarden-db-config:v1') },
      key,
      ciphertext
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  } catch {
    return null;
  }
}

async function readStoredText(env: Env, keys: StoreKeys): Promise<string | null> {
  const store = getConfigStore(env);
  if (store === 'kv') {
    return await asKvLike(env.SETTINGS_KV)!.get(keys.kv);
  }
  if (store === 'attachment-kv') {
    return await asKvLike(env.ATTACHMENTS_KV)!.get(keys.kv);
  }
  if (store === 'r2') {
    const object = await env.ATTACHMENTS!.get(keys.object);
    if (!object) return null;
    return await new Response(object.body as ReadableStream).text();
  }
  return null;
}

async function writeStoredText(env: Env, keys: StoreKeys, payload: string | null): Promise<boolean> {
  const store = getConfigStore(env);
  if (!store) return false;
  if (store === 'kv') {
    const kv = asKvLike(env.SETTINGS_KV)!;
    if (payload) await kv.put(keys.kv, payload);
    else await kv.delete(keys.kv);
    return true;
  }
  if (store === 'attachment-kv') {
    const kv = asKvLike(env.ATTACHMENTS_KV)!;
    if (payload) await kv.put(keys.kv, payload);
    else await kv.delete(keys.kv);
    return true;
  }
  if (store === 'r2') {
    if (payload) {
      await env.ATTACHMENTS!.put(keys.object, payload, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: {
          purpose:
            keys.object === SYNC_STATUS_OBJECT_KEY
              ? 'db-sync-status'
              : keys.object === WATERMARK_OBJECT_KEY
                ? 'db-watermark'
                : 'db-config',
        },
      });
    } else {
      await env.ATTACHMENTS!.delete(keys.object);
    }
    return true;
  }
  return false;
}

async function readStoredPayload(env: Env): Promise<string | null> {
  return readStoredText(env, CONFIG_KEYS);
}

async function writeStoredPayload(env: Env, payload: string | null): Promise<boolean> {
  return writeStoredText(env, CONFIG_KEYS, payload);
}

// Reading the stored payload costs a KV/R2 round trip + an AES-GCM decrypt, and
// resolveDbConfig() runs on EVERY request (db-lifecycle re-attaches env.DB per
// request). Caching it means steady state costs one read per TTL instead of one
// per request; write paths refresh the cache so a save takes effect immediately.
//
// The cache is keyed by the *store object itself* (SETTINGS_KV /
// ATTACHMENTS_KV / ATTACHMENTS): a module-level singleton would let two
// environments — consecutive test cases, or a self-hosted process serving more
// than one env — read each other's encrypted payload within the TTL window
// (C-6 in the review notes). Entries are invalidated wholesale by bumping the
// epoch; a WeakMap cannot be cleared, and dropping the ref is not enough
// because the same env object outlives a reset in tests.
const CONFIG_CACHE_TTL_MS = 30_000;
const payloadCache = new WeakMap<object, { epoch: number; payload: string | null; at: number }>();
let cacheEpoch = 0;

/** Test/reset hook: invalidate every cached payload without touching the stores. */
export function clearDbConfigCache(): void {
  cacheEpoch += 1;
}

function cacheStoreRef(env: Env): object | null {
  const store = getConfigStore(env);
  if (store === 'kv') return (env.SETTINGS_KV as unknown as object | undefined) ?? null;
  if (store === 'attachment-kv') return (env.ATTACHMENTS_KV as unknown as object | undefined) ?? null;
  if (store === 'r2') return (env.ATTACHMENTS as unknown as object | undefined) ?? null;
  return null;
}

async function readStoredPayloadCached(env: Env): Promise<string | null> {
  const ref = cacheStoreRef(env);
  const now = Date.now();
  if (ref) {
    const hit = payloadCache.get(ref);
    if (hit && hit.epoch === cacheEpoch && now - hit.at < CONFIG_CACHE_TTL_MS) return hit.payload;
  }
  const payload = await readStoredPayload(env);
  if (ref) payloadCache.set(ref, { epoch: cacheEpoch, payload, at: now });
  return payload;
}

// Sync bookkeeping is read on every request (the cluster needs it to decide
// whether a standby may take over), so it is cached separately with a shorter
// TTL: a sync pressed in the admin page must show up almost immediately.
const SYNC_CACHE_TTL_MS = 5_000;
const syncCache = new WeakMap<object, { epoch: number; at: number; value: DbSyncStates }>();

function normalizeSyncState(raw: unknown): DbNodeSyncState | null {
  const input = asRecord(raw);
  if (!input) return null;
  const at = Number(input.at ?? 0);
  if (!Number.isFinite(at) || at <= 0) return null;
  const cursors = asRecord(input.cursors);
  const normalizedCursors: Record<string, Array<string | number | boolean | null>> = {};
  if (cursors) {
    for (const [table, cursor] of Object.entries(cursors)) {
      if (!Array.isArray(cursor)) continue;
      const values = cursor.filter(
        (value): value is string | number | boolean | null =>
          value === null || ['string', 'number', 'boolean'].includes(typeof value)
      );
      if (values.length === cursor.length && values.length > 0) normalizedCursors[table] = values;
    }
  }
  return {
    at,
    complete: input.complete === true,
    fingerprint: typeof input.fingerprint === 'string' && input.fingerprint ? input.fingerprint : undefined,
    truncated: input.truncated === true,
    rowsWritten: Number(input.rowsWritten ?? 0) || 0,
    tables: Number(input.tables ?? 0) || 0,
    sourceId: typeof input.sourceId === 'string' && input.sourceId ? input.sourceId : undefined,
    cursors: Object.keys(normalizedCursors).length > 0 ? normalizedCursors : undefined,
  };
}

export async function readSyncStates(env: Env): Promise<DbSyncStates> {
  const ref = cacheStoreRef(env);
  const now = Date.now();
  if (ref) {
    const hit = syncCache.get(ref);
    if (hit && hit.epoch === cacheEpoch && now - hit.at < SYNC_CACHE_TTL_MS) return hit.value;
  }
  const raw = await readStoredText(env, SYNC_STATUS_KEYS).catch(() => null);
  const states: DbSyncStates = {};
  if (raw) {
    try {
      const parsed = asRecord(JSON.parse(raw));
      if (parsed) {
        for (const [id, value] of Object.entries(parsed)) {
          const state = normalizeSyncState(value);
          if (state) states[id] = state;
        }
      }
    } catch {
      // A corrupt status blob must not break database resolution: an unreadable
      // record simply means "no node is known to be synced".
      console.warn('[db-config] sync status payload is not valid JSON; ignoring it');
    }
  }
  if (ref) syncCache.set(ref, { epoch: cacheEpoch, at: now, value: states });
  return states;
}

/** Record the outcome of a sync run for one node. */
export async function saveNodeSyncState(env: Env, nodeId: string, state: DbNodeSyncState): Promise<boolean> {
  const current = await readSyncStates(env);
  const next: DbSyncStates = { ...current, [nodeId]: state };
  const saved = await writeStoredText(env, SYNC_STATUS_KEYS, JSON.stringify(next));
  const ref = cacheStoreRef(env);
  if (saved && ref) syncCache.set(ref, { epoch: cacheEpoch, at: Date.now(), value: next });
  return saved;
}

/** Drop the sync record of specific nodes (they point at another database now). */
export async function deleteNodeSyncStates(env: Env, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const current = await readSyncStates(env);
  const next: DbSyncStates = { ...current };
  let changed = false;
  for (const id of ids) {
    if (!(id in next)) continue;
    delete next[id];
    changed = true;
  }
  if (!changed) return;
  await writeStoredText(env, SYNC_STATUS_KEYS, JSON.stringify(next));
  const ref = cacheStoreRef(env);
  if (ref) syncCache.set(ref, { epoch: cacheEpoch, at: Date.now(), value: next });
}

/** Drop every node's sync record (used when the cluster config is cleared). */
export async function clearSyncStates(env: Env): Promise<void> {
  await writeStoredText(env, SYNC_STATUS_KEYS, null).catch(() => false);
  const ref = cacheStoreRef(env);
  if (ref) syncCache.set(ref, { epoch: cacheEpoch, at: Date.now(), value: {} });
  // The watermark describes nodes that no longer exist.
  await clearClusterWatermark(env);
}

/** Persisted write watermark, or null when none was ever recorded. */
export async function readClusterWatermark(env: Env): Promise<ClusterWatermarkSnapshot | null> {
  try {
    const raw = await readStoredText(env, WATERMARK_KEYS);
    if (!raw) return null;
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return null;
    const writeSeq = Number(parsed.writeSeq);
    if (!Number.isFinite(writeSeq) || writeSeq <= 0) return null;
    const nodes: Record<string, number> = {};
    const rawNodes = asRecord(parsed.nodes);
    if (rawNodes) {
      for (const [id, value] of Object.entries(rawNodes)) {
        const seq = Number(value);
        if (Number.isFinite(seq) && seq >= 0) nodes[id] = Math.floor(seq);
      }
    }
    return { writeSeq: Math.floor(writeSeq), nodes };
  } catch {
    // A corrupt watermark must not stop the app from booting: without it the
    // adapter just starts from zero, which is the pre-fix behaviour.
    return null;
  }
}

export async function saveClusterWatermark(env: Env, snapshot: ClusterWatermarkSnapshot): Promise<boolean> {
  return writeStoredText(env, WATERMARK_KEYS, JSON.stringify(snapshot)).catch(() => false);
}

export async function clearClusterWatermark(env: Env): Promise<void> {
  await writeStoredText(env, WATERMARK_KEYS, null).catch(() => false);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parsePort(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : fallback;
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function normalizePolicy(raw: unknown): DbClusterPolicy {
  const input = asRecord(raw) ?? {};
  const syncMode: DbSyncMode = input.syncMode === 'write-through' ? 'write-through' : 'native';
  return {
    readSplit: input.readSplit === true,
    syncMode,
    // Async only makes sense for an app-level replay; ignore it otherwise so a
    // stale flag cannot silently downgrade a native pair.
    syncAsync: syncMode === 'write-through' && input.syncAsync === true,
    failoverEnabled: input.failoverEnabled !== false,
    failureThreshold: clampInt(
      input.failureThreshold,
      DEFAULT_CLUSTER_POLICY.failureThreshold,
      CLUSTER_LIMITS.minFailureThreshold,
      CLUSTER_LIMITS.maxFailureThreshold
    ),
    cooldownMs: clampInt(
      input.cooldownMs,
      DEFAULT_CLUSTER_POLICY.cooldownMs,
      CLUSTER_LIMITS.minCooldownMs,
      CLUSTER_LIMITS.maxCooldownMs
    ),
  };
}

function normalizeNode(raw: unknown, index: number): DbNodeConfig | null {
  const input = asRecord(raw);
  if (!input) return null;
  const host = String(input.host ?? '').trim();
  if (!host) return null;
  const id = String(input.id ?? '').trim() || `node-${index + 1}`;
  return {
    id,
    label: String(input.label ?? '').trim() || (index === 0 ? '主库' : `节点 ${index + 1}`),
    role: input.role === 'replica' ? 'replica' : 'primary',
    priority: clampInt(input.priority, index + 1, 1, 99),
    enabled: input.enabled !== false,
    host,
    port: parsePort(input.port, 3306),
    user: String(input.user ?? '').trim(),
    password: typeof input.password === 'string' ? input.password : '',
    database: String(input.database ?? '').trim(),
    ssl: input.ssl !== false,
    connectionLimit: clampInt(
      input.connectionLimit,
      5,
      CLUSTER_LIMITS.minConnectionLimit,
      CLUSTER_LIMITS.maxConnectionLimit
    ),
  };
}

/**
 * Accept whatever is on disk and return a v2 config.
 *
 * A v1 payload (single `host`/`user`/`password`) becomes a one-node cluster, so
 * upgrading the app never silently drops a working configuration. Returns null
 * for payloads that carry no usable node.
 */
export function normalizeRuntimeConfig(raw: unknown): DbRuntimeConfigV2 | null {
  const input = asRecord(raw);
  if (!input) return null;

  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  const nodes = rawNodes
    .map((node, index) => normalizeNode(node, index))
    .filter((node): node is DbNodeConfig => node !== null)
    .slice(0, CLUSTER_LIMITS.maxNodes);

  if (nodes.length === 0) {
    // v1 fallback: the old shape kept one connection at the top level.
    const legacy = normalizeNode(
      {
        id: 'node-1',
        label: '主库',
        role: 'primary',
        priority: 1,
        enabled: true,
        host: input.host,
        port: input.port,
        user: input.user,
        password: input.password,
        database: input.database,
        ssl: input.ssl,
        connectionLimit: input.connectionLimit,
      },
      0
    );
    if (!legacy) return null;
    nodes.push(legacy);
  }

  // Exactly one active primary: keep the highest-priority candidate, demote the
  // rest. A hand-edited payload with two primaries must not produce two writers.
  const activePrimaries = nodes.filter((node) => node.role === 'primary' && node.enabled);
  if (activePrimaries.length > 1) {
    activePrimaries
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .slice(1)
      .forEach((node) => {
        node.role = 'replica';
      });
  }

  return {
    version: 2,
    mode: 'mysql',
    nodes,
    policy: normalizePolicy(input.policy),
  };
}

export async function loadRuntimeConfig(env: Env): Promise<DbRuntimeConfigV2 | null> {
  const payload = await readStoredPayloadCached(env);
  if (!payload) return null;
  const decrypted = await decryptJson(env, payload);
  return normalizeRuntimeConfig(decrypted);
}

export async function saveRuntimeConfig(env: Env, config: DbRuntimeConfigV2): Promise<boolean> {
  const payload = await encryptJson(env, config);
  if (!payload) return false;
  const saved = await writeStoredPayload(env, payload);
  if (saved) {
    const ref = cacheStoreRef(env);
    if (ref) payloadCache.set(ref, { epoch: cacheEpoch, payload, at: Date.now() });
  }
  return saved;
}

export async function clearRuntimeConfig(env: Env): Promise<boolean> {
  const saved = await writeStoredPayload(env, null);
  if (saved) {
    const ref = cacheStoreRef(env);
    if (ref) payloadCache.set(ref, { epoch: cacheEpoch, payload: null, at: Date.now() });
  }
  return saved;
}

/**
 * env-var driven cluster: a single primary node.
 *
 * Multi-node configuration lives in the admin UI (it needs encrypted storage);
 * DB_HOST stays the "infrastructure as code" path and always wins over it.
 */
export function resolveDbConfigFromEnv(env: Env): ResolvedDbConfig | null {
  const host = (env.DB_HOST || '').trim();
  if (!host) return null;
  return {
    mode: 'mysql',
    source: 'env',
    host,
    port: parsePort(env.DB_PORT, 3306),
    user: (env.DB_USER || '').trim(),
    password: env.DB_PASSWORD || '',
    database: (env.DB_NAME || '').trim(),
    ssl: (env.DB_SSL || '').toLowerCase() !== 'false' && (env.DB_SSL || '') !== '0',
    connectionLimit: parsePort(env.DB_CONN_LIMIT, 5),
  };
}

function toResolvedNodes(config: DbRuntimeConfigV2, syncStates: DbSyncStates): ResolvedDbNode[] {
  const writeThrough = config.policy.syncMode === 'write-through';
  return config.nodes
    .filter((node) => node.enabled)
    .map((node) => {
      const recorded = syncStates[node.id];
      // A record made for a different database proves nothing about this one:
      // the node was repointed (a migration, a new empty server), so its old
      // "complete" must not survive (B4). Records without a fingerprint predate
      // the check and are trusted, which keeps upgrades from disabling a working
      // standby until it is synced again.
      const syncStatus =
        recorded && recorded.fingerprint && recorded.fingerprint !== nodeFingerprint(node) ? undefined : recorded;
      return {
        ...node,
        source: 'runtime' as const,
        syncStatus,
        // In native mode the database replicates itself: whether a standby is
        // filled is not something the app can judge. In write-through it is, and
        // a replica that never completed a sync must not become a failover
        // target (B-4).
        syncReady: node.role === 'primary' || !writeThrough ? undefined : syncStatus?.complete === true,
      };
    })
    .sort((a, b) => {
      // Primary first, then the configured failover order.
      if (a.role !== b.role) return a.role === 'primary' ? -1 : 1;
      return a.priority - b.priority;
    });
}

export async function resolveDbCluster(env: Env): Promise<ResolvedDbCluster> {
  const fromEnv = resolveDbConfigFromEnv(env);
  if (fromEnv) {
    return {
      mode: 'mysql',
      source: 'env',
      nodes: [
        {
          id: 'env-primary',
          label: '环境变量主库',
          role: 'primary',
          priority: 1,
          enabled: true,
          host: fromEnv.host,
          port: fromEnv.port,
          user: fromEnv.user,
          password: fromEnv.password,
          database: fromEnv.database,
          ssl: fromEnv.ssl,
          connectionLimit: fromEnv.connectionLimit,
          source: 'env',
        },
      ],
      policy: { ...DEFAULT_CLUSTER_POLICY },
    };
  }

  const runtime = await loadRuntimeConfig(env);
  if (runtime) {
    const syncStates = runtime.policy.syncMode === 'write-through' ? await readSyncStates(env) : {};
    const nodes = toResolvedNodes(runtime, syncStates);
    if (nodes.length > 0) {
      return { mode: 'mysql', source: 'runtime', nodes, policy: runtime.policy };
    }
    // A stored config whose every node is disabled (KV edited by hand, an old
    // version, or a node list that no longer resolves) is not "no config".
    // Saying so explicitly is what stops the silent switch to D1.
    return {
      mode: 'd1',
      source: 'd1',
      nodes: [],
      policy: runtime.policy,
      unavailableReason:
        runtime.nodes.length > 0
          ? `已保存的 MySQL 集群配置中有 ${runtime.nodes.length} 个节点，但全部处于「停用」状态`
          : '已保存的 MySQL 集群配置里没有任何节点',
    };
  }

  return { mode: 'd1', source: 'd1', nodes: [], policy: { ...DEFAULT_CLUSTER_POLICY } };
}

/** Primary node of the cluster, or null when the cluster is not MySQL-backed. */
export function primaryNodeOf(cluster: ResolvedDbCluster): ResolvedDbNode | null {
  return cluster.nodes.find((node) => node.role === 'primary') ?? cluster.nodes[0] ?? null;
}

export async function resolveDbConfig(env: Env): Promise<ResolvedDbConfig> {
  const cluster = await resolveDbCluster(env);
  const primary = primaryNodeOf(cluster);
  if (cluster.mode === 'mysql' && primary) {
    return {
      mode: 'mysql',
      source: cluster.source,
      host: primary.host,
      port: primary.port,
      user: primary.user,
      password: primary.password,
      database: primary.database,
      ssl: primary.ssl,
      connectionLimit: primary.connectionLimit,
    };
  }

  return {
    mode: 'd1',
    source: 'd1',
    host: '',
    port: 3306,
    user: '',
    password: '',
    database: '',
    ssl: false,
    connectionLimit: 5,
  };
}

export function maskNode(node: DbNodeConfig & { syncStatus?: DbNodeSyncState; syncReady?: boolean }): MaskedDbNode {
  return {
    id: node.id,
    label: node.label,
    role: node.role,
    priority: node.priority,
    enabled: node.enabled,
    host: node.host,
    port: node.port,
    user: node.user,
    database: node.database,
    ssl: node.ssl,
    connectionLimit: node.connectionLimit,
    passwordSet: !!node.password,
    syncStatus: node.syncStatus,
    syncReady: node.syncReady,
  };
}

export function maskCluster(cluster: ResolvedDbCluster): MaskedDbCluster {
  return {
    mode: cluster.mode,
    source: cluster.source,
    nodes: cluster.nodes.map(maskNode),
    policy: cluster.policy,
    unavailableReason: cluster.unavailableReason,
  };
}

export function maskConfig(config: ResolvedDbConfig): MaskedDbConfig {
  return {
    mode: config.mode,
    source: config.source,
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    ssl: config.ssl,
    connectionLimit: config.connectionLimit,
    passwordSet: !!config.password,
  };
}

export function hasConfigStore(env: Env): boolean {
  return getConfigStore(env) !== null;
}
