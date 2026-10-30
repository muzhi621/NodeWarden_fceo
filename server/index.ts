// Node.js server entry for NodeWarden (BYO-DB edition).
//
// Runs the exact same request pipeline as the Cloudflare Worker on plain Node:
//   - EdgeOne Pages Cloud Functions (Node runtime) / Aliyun FC / Tencent SCF
//   - Local development & self-hosting: `npm run start:node`
//
// Storage: D1 is unavailable here, so an external MySQL is used. Configure via
// DB_* environment variables and/or the admin UI (encrypted runtime config).
//
// Degraded on Node (documented in the porting report):
//   - Durable Objects run in-process with in-memory state (see
//     ./local-durable-objects.ts): the backup runner and the notification hub
//     keep working, but state is per-process / lost on cold start and
//     WebSocket upgrades are rejected (clients fall back to polling).
//   - caches.default is an in-memory cache (per instance).

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';

import { handleRequest } from '../src/router';
import { ensureDatabaseInitialized, getDbInitError } from '../src/services/db-lifecycle';
import { getDatabaseStatus } from '../src/services/storage-factory';
import { applyCors, jsonResponse } from '../src/utils/response';
import { isBackendRequestPath, isWebVaultHidden, webVaultNotFoundResponse } from '../src/web-vault-visibility';
import type { Env } from '../src/types';
import {
  createLocalBackupRunnerNamespace,
  createLocalNotificationsHubNamespace,
  installDurableObjectGlobals,
} from './local-durable-objects';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
const ATTACHMENTS_DIR = path.resolve(process.env.ATTACHMENTS_DIR || path.join(DATA_DIR, 'attachments'));
const DIST_DIR = path.resolve(process.env.DIST_DIR || path.join(ROOT_DIR, 'dist'));
const PORT = Number(process.env.PORT || 8787);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// File-backed KV (encrypted runtime DB config + misc settings)
// ---------------------------------------------------------------------------

const KV_FILE = path.join(DATA_DIR, 'kv-store.json');

function readKvFile(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(KV_FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeKvFile(data: Record<string, string>): void {
  fs.writeFileSync(KV_FILE, JSON.stringify(data), 'utf8');
}

const fileKv = {
  async get(key: string): Promise<string | null> {
    const data = readKvFile();
    return data[key] ?? null;
  },
  async put(key: string, value: string): Promise<void> {
    const data = readKvFile();
    data[key] = value;
    writeKvFile(data);
  },
  async delete(key: string): Promise<void> {
    const data = readKvFile();
    delete data[key];
    writeKvFile(data);
  },
};

// ---------------------------------------------------------------------------
// Filesystem-backed R2-compatible bucket (attachments / send files)
// ---------------------------------------------------------------------------

function safeObjectPath(key: string): string {
  // Containment check via path.relative: a plain startsWith() also accepts
  // sibling directories such as "/data/attachments-evil".
  const normalized = key.replace(/^[/\\]+/, '');
  const full = path.resolve(ATTACHMENTS_DIR, normalized);
  const rel = path.relative(ATTACHMENTS_DIR, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Invalid object key');
  return full;
}

const fsR2 = {
  async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<void> {
    const full = safeObjectPath(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    let bytes: Uint8Array;
    if (typeof value === 'string') bytes = new TextEncoder().encode(value);
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else if (value instanceof ReadableStream) {
      const buf = await new Response(value).arrayBuffer();
      bytes = new Uint8Array(buf);
    } else {
      bytes = new Uint8Array(0);
    }
    await fsp.writeFile(full, bytes);
    const meta = {
      contentType: options?.httpMetadata?.contentType || 'application/octet-stream',
      customMetadata: options?.customMetadata || {},
    };
    await fsp.writeFile(`${full}.meta.json`, JSON.stringify(meta));
  },
  async get(key: string): Promise<{ body: ReadableStream; size: number; httpMetadata: { contentType: string }; customMetadata: Record<string, string> } | null> {
    const full = safeObjectPath(key);
    try {
      // Stream, don't slurp: attachments can be large and FC instances are small
      // (0.5 GB). Reading the file into a Buffer first doubled peak memory.
      const stat = await fsp.stat(full);
      let meta: { contentType?: string; customMetadata?: Record<string, string> } = {};
      try {
        meta = JSON.parse(await fsp.readFile(`${full}.meta.json`, 'utf8'));
      } catch {
        // no meta
      }
      const stream = fs.createReadStream(full);
      return {
        body: Readable.toWeb(stream) as unknown as ReadableStream,
        size: stat.size,
        httpMetadata: { contentType: meta.contentType || 'application/octet-stream' },
        customMetadata: meta.customMetadata || {},
      };
    } catch {
      return null;
    }
  },
  async delete(key: string): Promise<void> {
    const full = safeObjectPath(key);
    await fsp.rm(full, { force: true });
    await fsp.rm(`${full}.meta.json`, { force: true });
  },
};

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

(globalThis as { caches?: unknown }).caches = cachesShim;

// ---------------------------------------------------------------------------
// Durable Objects: real in-process implementations (see local-durable-objects)
// ---------------------------------------------------------------------------

installDurableObjectGlobals();

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

async function serveAssets(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return new Response('Bad Request', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.resolve(DIST_DIR, rel.replace(/^[/\\]+/, ''));
  const contained = path.relative(DIST_DIR, full);
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
      const index = await fsp.readFile(path.join(DIST_DIR, 'index.html'));
      return new Response(index, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
    } catch {
      return new Response('Web vault not built. Run `npm run build` first.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  }
}

// ---------------------------------------------------------------------------
// Env assembly
// ---------------------------------------------------------------------------

// The env object is created once and shared: Durable Object instances are
// constructed lazily from it, so they must see the same `DB` handle that the
// request pipeline attaches (db-lifecycle re-attaches it on every request).
let sharedEnv: Env | null = null;

function buildEnv(): Env {
  if (sharedEnv) return sharedEnv;
  const env = {
    DB: null as unknown as D1Database,
    NOTIFICATIONS_HUB: createLocalNotificationsHubNamespace(() =>
      buildEnv()
    ) as unknown as DurableObjectNamespace,
    BACKUP_TRANSFER_RUNNER: createLocalBackupRunnerNamespace(() =>
      buildEnv()
    ) as unknown as DurableObjectNamespace,
    ASSETS: { fetch: (input: RequestInfo | URL) => serveAssets(toRequest(input)) },
    ATTACHMENTS: fsR2 as unknown as R2Bucket,
    SETTINGS_KV: fileKv as unknown as KVNamespace,
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

function toRequest(input: RequestInfo | URL): Request {
  if (input instanceof Request) return input;
  return new Request(typeof input === 'string' ? input : input.href);
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

async function pipeline(request: Request, env: Env): Promise<Response> {
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
  const dbInitError = getDbInitError();
  if (dbInitError) {
    const resp = jsonResponse(
      {
        error: 'Database not initialized',
        error_description: 'Database initialization failed. Check server logs for details.',
        ErrorModel: { Message: 'Service temporarily unavailable', Object: 'error' },
      },
      500
    );
    return applyCors(request, resp, env);
  }

  const resp = await handleRequest(request, env);
  return applyCors(request, resp, env);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function nodeRequestToRequest(req: http.IncomingMessage, body: Buffer): Request {
  const protocol = (req.headers['x-forwarded-proto'] as string) || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || `localhost:${PORT}`;
  const url = `${protocol}://${host}${req.url || '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else headers.set(key, value);
  }
  const method = (req.method || 'GET').toUpperCase();
  const init: RequestInit = { method, headers };
  if (!['GET', 'HEAD'].includes(method) && body.length > 0) {
    init.body = body;
  }
  return new Request(url, init);
}

async function writeResponse(res: http.ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    // Node decides framing for a streamed body; forwarding these two would either
    // be wrong (content-length after re-chunking) or rejected by writeHead.
    if (key === 'content-length' || key === 'transfer-encoding') return;
    const existing = headers[key];
    if (existing === undefined) headers[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[key] = [existing, value];
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  // Stream with backpressure: buffering the whole body (arrayBuffer) doubled peak
  // memory and OOMed small FC instances on large attachment downloads.
  const nodeStream = Readable.fromWeb(response.body as unknown as NodeWebReadableStream);
  nodeStream.on('error', () => res.destroy());
  nodeStream.pipe(res);
}

const MAX_BODY_BYTES = Math.max(1, Number(process.env.MAX_BODY_MB || 100)) * 1024 * 1024;

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  let received = 0;
  let rejected = false;
  req.on('data', (chunk: Buffer) => {
    if (rejected) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      rejected = true;
      // Unbounded buffering is a memory DoS on a self-hosted instance.
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (rejected) return;
    void (async () => {
      try {
        const env = buildEnv();
        const body = Buffer.concat(chunks);
        const request = nodeRequestToRequest(req, body);
        const response = await pipeline(request, env);
        await writeResponse(res, response);
      } catch (error) {
        console.error('Unhandled request error:', error);
        try {
          await writeResponse(res, jsonResponse({ error: 'Internal server error' }, 500));
        } catch {
          res.destroy();
        }
      }
    })();
  });
  req.on('error', (error) => {
    console.error('Request stream error:', error);
    res.destroy();
  });
});

server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 300_000);
server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 60_000);
server.keepAliveTimeout = Number(process.env.KEEPALIVE_TIMEOUT_MS || 65_000);
server.on('error', (error: { code?: string; message?: string }) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT to a free port.`);
  } else {
    console.error('Server error:', error);
  }
  process.exitCode = 1;
});

// WebSocket upgrade (notifications hub) is unavailable on this runtime.
server.on('upgrade', (_req, socket) => {
  socket.write('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n');
  socket.destroy();
});

// ---------------------------------------------------------------------------
// Scheduled backup tick
// ---------------------------------------------------------------------------
// Driven by the platform (Aliyun FC timer trigger / EdgeOne cron) hitting
// POST /internal/cron/backup with the shared secret. An in-process setInterval
// was wrong for serverless: it never fires while the instance is scaled to zero,
// it lets every instance run its own copy (duplicated WebDAV uploads, since the
// 10-minute job lease lives in per-process memory), and it prevents idle
// recycling. Set INPROCESS_CRON=1 only for a single long-lived self-hosted node.
const CRON_SECRET = process.env.CRON_SECRET || '';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleCronTick(request: Request, env: Env): Promise<Response> {
  if (!CRON_SECRET) {
    // Refuse to run an unauthenticated trigger: this endpoint starts backups.
    return jsonResponse({ error: 'cron trigger not configured (set CRON_SECRET)' }, 503);
  }
  const provided = request.headers.get('x-cron-secret') || '';
  if (!timingSafeEqual(provided, CRON_SECRET)) {
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

if (process.env.INPROCESS_CRON === '1') {
  const intervalMs = Number(process.env.INPROCESS_CRON_INTERVAL_MS || 5 * 60 * 1000);
  const timer = setInterval(() => {
    void handleCronTick(
      new Request(`http://localhost/internal/cron/backup`, {
        method: 'POST',
        headers: { 'x-cron-secret': CRON_SECRET },
      }),
      buildEnv()
    ).catch((error: unknown) => console.error('Scheduled backup tick failed:', error));
  }, intervalMs);
  timer.unref?.();
  console.log(`  cron:           in-process every ${Math.round(intervalMs / 1000)}s (INPROCESS_CRON=1)`);
}

server.listen(PORT, () => {
  console.log(`NodeWarden (Node runtime / BYO-DB) listening on http://localhost:${PORT}`);
  console.log(`  data dir:       ${DATA_DIR}`);
  console.log(`  attachments:    ${ATTACHMENTS_DIR}`);
  console.log(`  web vault:      ${DIST_DIR}`);
  console.log(`  database:       ${process.env.DB_HOST ? `MySQL ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME || ''}` : 'configured via env DB_* or admin UI (/admin/database)'}`);
  console.log(`  cron:           POST /internal/cron/backup (x-cron-secret)${CRON_SECRET ? '' : ' — CRON_SECRET not set, endpoint disabled'}`);
});
