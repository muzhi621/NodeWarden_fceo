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

import type { Env } from '../types';

export interface DbRuntimeConfig {
  version: 1;
  mode: 'mysql' | 'd1';
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  connectionLimit?: number;
}

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

async function decryptJson(env: Env, payload: string): Promise<DbRuntimeConfig | null> {
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
    return JSON.parse(new TextDecoder().decode(plaintext)) as DbRuntimeConfig;
  } catch {
    return null;
  }
}

async function readStoredPayload(env: Env): Promise<string | null> {
  const store = getConfigStore(env);
  if (store === 'kv') {
    return await asKvLike(env.SETTINGS_KV)!.get(CONFIG_KV_KEY);
  }
  if (store === 'attachment-kv') {
    return await asKvLike(env.ATTACHMENTS_KV)!.get(CONFIG_KV_KEY);
  }
  if (store === 'r2') {
    const object = await env.ATTACHMENTS!.get(CONFIG_OBJECT_KEY);
    if (!object) return null;
    const text = await new Response(object.body as ReadableStream).text();
    return text;
  }
  return null;
}

async function writeStoredPayload(env: Env, payload: string | null): Promise<boolean> {
  const store = getConfigStore(env);
  if (!store) return false;
  if (store === 'kv') {
    const kv = asKvLike(env.SETTINGS_KV)!;
    if (payload) await kv.put(CONFIG_KV_KEY, payload);
    else await kv.delete(CONFIG_KV_KEY);
    return true;
  }
  if (store === 'attachment-kv') {
    const kv = asKvLike(env.ATTACHMENTS_KV)!;
    if (payload) await kv.put(CONFIG_KV_KEY, payload);
    else await kv.delete(CONFIG_KV_KEY);
    return true;
  }
  if (store === 'r2') {
    if (payload) {
      await env.ATTACHMENTS!.put(CONFIG_OBJECT_KEY, payload, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { purpose: 'db-config' },
      });
    } else {
      await env.ATTACHMENTS!.delete(CONFIG_OBJECT_KEY);
    }
    return true;
  }
  return false;
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

export async function loadRuntimeConfig(env: Env): Promise<DbRuntimeConfig | null> {
  const payload = await readStoredPayloadCached(env);
  if (!payload) return null;
  return decryptJson(env, payload);
}

export async function saveRuntimeConfig(env: Env, config: DbRuntimeConfig): Promise<boolean> {
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

function parsePort(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

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

export async function resolveDbConfig(env: Env): Promise<ResolvedDbConfig> {
  const fromEnv = resolveDbConfigFromEnv(env);
  if (fromEnv) return fromEnv;

  const runtime = await loadRuntimeConfig(env);
  if (runtime && runtime.mode === 'mysql' && runtime.host) {
    return {
      mode: 'mysql',
      source: 'runtime',
      host: runtime.host,
      port: runtime.port || 3306,
      user: runtime.user || '',
      password: runtime.password || '',
      database: runtime.database || '',
      ssl: runtime.ssl !== false,
      connectionLimit: runtime.connectionLimit || 5,
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
