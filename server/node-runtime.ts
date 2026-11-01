// Platform-neutral Node runtime for NodeWarden (BYO-DB edition).
//
// One request pipeline, three hosts:
//   - Aliyun FC / Tencent SCF / self-hosting → `server/index.ts` wraps this in an
//     http.Server (`npm run start:node`, `node server/index.mjs`).
//   - Tencent EdgeOne Pages Node Functions → `server/edgeone.ts` calls
//     `handleNodeFetch()` from an `onRequest(context)` handler; the platform
//     serves `dist/` itself, so the asset layer is stubbed there.
//
// Everything host-specific (sockets, body buffering, port) stays in the entry
// files; what lives here is: env assembly, the filesystem-backed KV / R2 shims,
// the `caches` shim, the in-process Durable Objects, and the request pipeline
// that mirrors `src/index.ts` (the Worker entry).
//
// Degraded on Node (documented in the porting report):
//   - Durable Objects run in-process with in-memory state (see
//     ./local-durable-objects.ts): the backup runner and the notification hub
//     keep working, but state is per-process / lost on cold start and
//     WebSocket upgrades are rejected (clients fall back to polling).
//   - caches.default is an in-memory cache (per instance).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleRequest } from '../src/router';
import { ensureDatabaseInitialized, getDbInitError, getDbInitFailure } from '../src/services/db-lifecycle';
import { getDatabaseStatus } from '../src/services/storage-factory';
import { clearDbConfigCache } from '../src/services/db-config';
import { applyCors, jsonResponse } from '../src/utils/response';
import { isBackendRequestPath, isWebVaultHidden, webVaultNotFoundResponse } from '../src/web-vault-visibility';
import type { Env } from '../src/types';
import {
  createLocalBackupRunnerNamespace,
  createLocalNotificationsHubNamespace,
  installDurableObjectGlobals,
} from './local-durable-objects';
// The filesystem-backed attachment bucket lives in its own module so it can be
// unit-tested without booting the whole runtime.
import { createFsR2 } from './fs-r2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * How the host serves the built web vault.
 *   - `disk`: read `dist/` from the filesystem (FC / self-hosted Node).
 *   - `stub`: the platform (EdgeOne Pages) serves static assets and SPA
 *     fallback itself; the function only ever sees backend paths, so any
 *     non-backend GET that still lands here is answered with a 404 instead of
 *     touching a filesystem that does not contain `dist/`.
 */
export type AssetsMode = 'disk' | 'stub';

export interface NodeRuntimeOptions {
  assets?: AssetsMode;
  /** Overrides `DATA_DIR`; defaults to `$DATA_DIR`, then `<repo>/data`. */
  dataDir?: string;
}

interface RuntimeState {
  assets: AssetsMode;
  dataDir: string;
  attachmentsDir: string;
  distDir: string;
}

let state: RuntimeState | null = null;
let sharedEnv: Env | null = null;

// ---------------------------------------------------------------------------
// Environment plumbing
// ---------------------------------------------------------------------------

/**
 * Copy platform-provided variables into `process.env`.
 *
 * Aliyn FC injects configuration as real process environment variables, but
 * EdgeOne Pages hands them to the function as `context.env`. The shared code
 * (and mysql2's own connection handling) reads `process.env`, so the platform
 * values are mirrored once, without ever overwriting a value that is already
 * set — that keeps shell overrides working for local runs.
 */
export function applyEnvFromRecord(source: Record<string, unknown> | undefined | null): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

function isInsideDirectory(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveState(options: NodeRuntimeOptions): RuntimeState {
  const assets = options.assets || 'disk';
  let dataDir = path.resolve(
    options.dataDir || process.env.DATA_DIR || defaultDataDir(assets)
  );
  if (assets === 'stub' && !isInsideDirectory(dataDir, os.tmpdir())) {
    // EdgeOne Node Functions only mount /tmp writable; the code directory is
    // read-only and recycled with the instance. A DATA_DIR override pointing
    // elsewhere would fail every request at mkdirSync (EROFS/EACCES) or lose
    // the stored config on the next cold start, so stub mode forces /tmp.
    dataDir = path.join(os.tmpdir(), 'nodewarden');
  }
  return {
    assets,
    dataDir,
    attachmentsDir: path.resolve(process.env.ATTACHMENTS_DIR || path.join(dataDir, 'attachments')),
    distDir: path.resolve(process.env.DIST_DIR || path.join(__dirname, '..', 'dist')),
  };
}

/**
 * Functions-as-a-service only give us a writable `/tmp`; the code directory is
 * read-only and is recycled, so writing next to the sources fails outright.
 */
function defaultDataDir(assets: AssetsMode | undefined): string {
  if (assets === 'stub') return path.join(os.tmpdir(), 'nodewarden');
  return path.join(__dirname, '..', 'data');
}

/**
 * Idempotent, lazily executed setup: directories, `caches` shim, Durable
 * Object globals. Safe to call from every request.
 *
 * First call wins by design: the host entry must be the first to configure
 * the runtime — `server/index.ts` passes `{ assets: 'disk' }` at module
 * scope, and `server/edgeone.ts` reaches here first through
 * `handleNodeFetch(request, { assets: 'stub' })`. Any later call that tries
 * to change the mode means something raced ahead of the entry (the review
 * notes call this the structural cause of the EdgeOne stub bug), so make the
 * mismatch visible in the logs instead of silently ignoring it.
 */
export function configureNodeRuntime(options: NodeRuntimeOptions = {}): RuntimeState {
  if (state) {
    if (options.assets && options.assets !== state.assets) {
      console.warn(
        `[node-runtime] ignored late configureNodeRuntime({ assets: '${options.assets}' }): ` +
          `the runtime was already configured with assets: '${state.assets}' by an earlier call.`
      );
    }
    return state;
  }
  state = resolveState(options);
  fs.mkdirSync(state.dataDir, { recursive: true });
  fs.mkdirSync(state.attachmentsDir, { recursive: true });
  (globalThis as { caches?: unknown }).caches = cachesShim;
  installDurableObjectGlobals();
  return state;
}

export function getRuntimeInfo(): RuntimeState {
  return configureNodeRuntime();
}

// ---------------------------------------------------------------------------
// File-backed KV (encrypted runtime DB config + misc settings)
// ---------------------------------------------------------------------------

function readKvFile(kvFile: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(kvFile, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeKvFile(kvFile: string, data: Record<string, string>): void {
  fs.writeFileSync(kvFile, JSON.stringify(data), 'utf8');
}

function createFileKv(dataDir: string) {
  const kvFile = path.join(dataDir, 'kv-store.json');
  return {
    async get(key: string): Promise<string | null> {
      const data = readKvFile(kvFile);
      return data[key] ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      const data = readKvFile(kvFile);
      data[key] = value;
      writeKvFile(kvFile, data);
    },
    async delete(key: string): Promise<void> {
      const data = readKvFile(kvFile);
      delete data[key];
      writeKvFile(kvFile, data);
    },
  };
}

// ---------------------------------------------------------------------------
// Filesystem-backed R2-compatible bucket (attachments / send files)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// caches.* shim (in-memory)
// ---------------------------------------------------------------------------

type CacheEntry = { status: number; statusText: string; headers: [string, string][]; body: string };
const memoryCache = new Map<string, CacheEntry>();

function cacheKey(request: RequestInfo | URL): string {
  const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
  return url;
}

const cachesShim = {
  default: {
    async match(request: RequestInfo | URL): Promise<Response | undefined> {
      const entry = memoryCache.get(cacheKey(request));
      if (!entry) return undefined;
      return new Response(entry.body, { status: entry.status, statusText: entry.statusText, headers: new Headers(entry.headers) });
    },
    async put(request: RequestInfo | URL, response: Response): Promise<void> {
      const clone = response.clone();
      const body = await clone.text();
      memoryCache.set(cacheKey(request), {
        status: clone.status,
        statusText: clone.statusText,
        headers: [...clone.headers.entries()],
        body,
      });
    },
  },
  async open(_name: string): Promise<typeof cachesShim.default> {
    return cachesShim.default;
  },
};

// ---------------------------------------------------------------------------
// ASSETS shim (serves the Vite build from ./dist)
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function notFoundAssetResponse(reason: string): Response {
  return new Response(reason, {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function serveAssets(request: Request): Promise<Response> {
  const runtime = configureNodeRuntime();
  if (runtime.assets === 'stub') {
    // Should not happen: the platform only routes backend prefixes here.
    return notFoundAssetResponse('Not Found');
  }
  const url = new URL(request.url);
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return new Response('Bad Request', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.resolve(runtime.distDir, rel.replace(/^[/\\]+/, ''));
  const contained = path.relative(runtime.distDir, full);
  if (!contained || contained.startsWith('..') || path.isAbsolute(contained)) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const bytes = await fsp.readFile(full);
    const ext = path.extname(full).toLowerCase();
    return new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' },
    });
  } catch {
    // SPA fallback
    try {
      const index = await fsp.readFile(path.join(runtime.distDir, 'index.html'));
      return new Response(index, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
    } catch {
      return new Response('Web vault not built. Run `npm run build` first.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  }
}

// ---------------------------------------------------------------------------
// Env assembly
// ---------------------------------------------------------------------------

function toRequest(input: RequestInfo | URL): Request {
  if (input instanceof Request) return input;
  return new Request(typeof input === 'string' ? input : input.href);
}

/**
 * Build the `Env` once and share it: Durable Object instances are constructed
 * lazily from it, so they must see the same `DB` handle that the request
 * pipeline attaches (db-lifecycle re-attaches it on every request).
 */
export function buildNodeEnv(): Env {
  const runtime = configureNodeRuntime();
  if (sharedEnv) return sharedEnv;
  const env = {
    DB: null as unknown as D1Database,
    NOTIFICATIONS_HUB: createLocalNotificationsHubNamespace(() =>
      buildNodeEnv()
    ) as unknown as DurableObjectNamespace,
    BACKUP_TRANSFER_RUNNER: createLocalBackupRunnerNamespace(() =>
      buildNodeEnv()
    ) as unknown as DurableObjectNamespace,
    ASSETS: { fetch: (input: RequestInfo | URL) => serveAssets(toRequest(input)) },
    ATTACHMENTS: createFsR2(runtime.attachmentsDir) as unknown as R2Bucket,
    SETTINGS_KV: createFileKv(runtime.dataDir) as unknown as KVNamespace,
    JWT_SECRET: process.env.JWT_SECRET || '',
    HIDE_WEB_VAULT: process.env.HIDE_WEB_VAULT,
    WEBAUTHN_RP_ID: process.env.WEBAUTHN_RP_ID,
    WEBAUTHN_RP_NAME: process.env.WEBAUTHN_RP_NAME,
    WEBAUTHN_ALLOWED_ORIGINS: process.env.WEBAUTHN_ALLOWED_ORIGINS,
    YUBICO_VALIDATION_URLS: process.env.YUBICO_VALIDATION_URLS,
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL,
    DB_CONN_LIMIT: process.env.DB_CONN_LIMIT,
    DB_CONFIG_KEY: process.env.DB_CONFIG_KEY,
  };
  sharedEnv = env as unknown as Env;
  return sharedEnv;
}

/** Test hook: forget the cached env (used by scripts/edgeone-smoke.mjs). */
export function resetNodeEnvForTests(): void {
  sharedEnv = null;
  // The DB-config payload cache is keyed per store object; consecutive test
  // cases swap stores, so a stale entry would leak the previous config.
  clearDbConfigCache();
}

// ---------------------------------------------------------------------------
// Request pipeline (mirrors src/index.ts fetch())
// ---------------------------------------------------------------------------
// Database resolution + per-request env.DB attachment + one-time schema init
// live in src/services/db-lifecycle (shared with the Worker entry). The Node
// runtime builds a fresh env per request (DB starts null), so the lifecycle
// module re-attaches the resolved DB on every call.

async function handleHealthz(env: Env): Promise<Response> {
  const status = await getDatabaseStatus(env);
  if (status.error) {
    // Public endpoint: never echo raw driver errors (host, user, schema names).
    console.error('[healthz] database unavailable:', status.error);
  }
  return jsonResponse(
    { ok: status.ok, db: status.ok ? 'up' : 'down', mode: status.mode, source: status.source, runtime: 'node' },
    status.ok ? 200 : 503
  );
}

export async function pipeline(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let pathname = url.pathname;
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');

  if (pathname === '/internal/cron/backup' && request.method === 'POST') {
    return handleCronTick(request, env);
  }

  if (isWebVaultHidden(env) && !isBackendRequestPath(pathname)) {
    return webVaultNotFoundResponse(request);
  }

  if (pathname === '/healthz' || pathname === '/api/healthz') {
    return applyCors(request, await handleHealthz(env), env);
  }

  if (!isBackendRequestPath(pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
    return applyCors(request, await serveAssets(request), env);
  }

  await ensureDatabaseInitialized(env);
  const dbFailure = dbInitFailureResponse();
  if (dbFailure) return applyCors(request, dbFailure, env);

  const resp = await handleRequest(request, env);
  return applyCors(request, resp, env);
}

/**
 * Translate a latched DB init failure into a response.
 *
 * Cluster-level refusals ("every node is disabled", "no database configured")
 * are written for the operator and carry their own status, so they are passed
 * through. Everything else stays behind the generic message: on this runtime the
 * message can end up in a browser, and a raw driver error names hosts and
 * credentials.
 */
function dbInitFailureResponse(): Response | null {
  const failure = getDbInitFailure();
  if (!failure) return null;
  console.error('DB init error:', failure.message);
  if (failure.status) {
    return jsonResponse(
      {
        error: failure.message,
        error_description: failure.message,
        ErrorModel: { Message: failure.message, Object: 'error' },
      },
      failure.status
    );
  }
  return jsonResponse(
    {
      error: 'Database not initialized',
      error_description: 'Database initialization failed. Check server logs for details.',
      ErrorModel: { Message: 'Service temporarily unavailable', Object: 'error' },
    },
    500
  );
}

/**
 * Single entry point for hosts that hand over a WHATWG `Request`
 * (EdgeOne Pages Node Functions). Sets the runtime up on first use.
 *
 * `options` MUST come from the host entry (not from defaults): the EdgeOne
 * entry passes `{ assets: 'stub' }` so the asset layer is stubbed and the
 * data dir lands under /tmp (see NodeRuntimeOptions). Throwing from an
 * unexpected place would otherwise surface as the platform's own HTML error
 * page — no CORS headers, no JSON body — which the web vault can only show
 * as an opaque network error, so it is caught and translated here.
 */
export async function handleNodeFetch(
  request: Request,
  options: NodeRuntimeOptions = {}
): Promise<Response> {
  try {
    configureNodeRuntime(options);
    return await pipeline(request, buildNodeEnv());
  } catch (error) {
    console.error('Unhandled request error:', error);
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        ErrorModel: { Message: 'Internal server error', Object: 'error' },
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Scheduled backup tick
// ---------------------------------------------------------------------------
// Driven by the platform (Aliyun FC timer trigger / EdgeOne cron / external
// cron) hitting POST /internal/cron/backup with the shared secret. An in-process
// setInterval was wrong for serverless: it never fires while the instance is
// scaled to zero, it lets every instance run its own copy (duplicated WebDAV
// uploads, since the 10-minute job lease lives in per-process memory), and it
// prevents idle recycling. Set INPROCESS_CRON=1 only for a single long-lived
// self-hosted node.
// Read on every tick, not at import: EdgeOne Pages injects variables on the
// first request (after this module is evaluated), so a module-level constant
// would stay empty and the endpoint would answer 503 forever.
export function getCronSecret(): string {
  return process.env.CRON_SECRET || '';
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleCronTick(request: Request, env: Env): Promise<Response> {
  const cronSecret = getCronSecret();
  if (!cronSecret) {
    // Refuse to run an unauthenticated trigger: this endpoint starts backups.
    return jsonResponse({ error: 'cron trigger not configured (set CRON_SECRET)' }, 503);
  }
  const provided = request.headers.get('x-cron-secret') || '';
  if (!timingSafeEqual(provided, cronSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  await ensureDatabaseInitialized(env);
  const dbInitError = getDbInitError();
  if (dbInitError) {
    console.error('Skipping scheduled backup because DB init failed:', dbInitError);
    return jsonResponse({ ok: false, error: 'database unavailable' }, 503);
  }
  const { runScheduledBackupIfDue } = await import('../src/handlers/backup');
  await runScheduledBackupIfDue(env);
  return jsonResponse({ ok: true });
}
