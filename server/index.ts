// Node.js HTTP server entry for NodeWarden (BYO-DB edition).
//
// Used by:
//   - Aliyun FC "Web 函数" (`node fc-entry.mjs` → imports ./index.mjs)
//   - Tencent SCF / any container or VPS
//   - local development: `npm run start:node`
//
// The request pipeline, env assembly and storage shims live in
// ./node-runtime.ts, shared with the EdgeOne Pages entry (./edgeone.ts) — a
// function-as-a-service host gets a `Request` per call and has no socket to
// listen on, so only the socket plumbing is duplicated here.
//
// Storage: D1 is unavailable, so an external MySQL is used. Configure via DB_*
// environment variables and/or the admin UI (encrypted runtime config).

import http from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import { jsonResponse } from '../src/utils/response';
import {
  buildNodeEnv,
  configureNodeRuntime,
  getCronSecret,
  handleCronTick,
  pipeline,
} from './node-runtime';

const runtime = configureNodeRuntime({ assets: 'disk' });
const PORT = Number(process.env.PORT || 8787);

// ---------------------------------------------------------------------------
// http <-> fetch bridging
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

async function writeResponse(res: http.ServerResponse, response: Response, requestMethod = 'GET'): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  // Bodies are not written for HEAD or for status codes that forbid one, and in
  // those cases the length header is the only information the client gets.
  const bodyless = requestMethod === 'HEAD' || response.status === 204 || response.status === 304;
  response.headers.forEach((value, key) => {
    // Node decides framing for a streamed body; forwarding these two would either
    // be wrong (content-length after re-chunking) or rejected by writeHead.
    if (key === 'transfer-encoding') return;
    if (key === 'content-length' && !bodyless) return;
    const existing = headers[key];
    if (existing === undefined) headers[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[key] = [existing, value];
  });
  res.writeHead(response.status, headers);
  if (bodyless || !response.body) {
    res.end();
    return;
  }
  // Stream with backpressure: buffering the whole body (arrayBuffer) doubled peak
  // memory and OOMed small FC instances on large attachment downloads.
  const nodeStream = Readable.fromWeb(response.body as unknown as NodeWebReadableStream);
  nodeStream.on('error', () => res.destroy());
  // Client aborted mid-download (or the connection died): destroy the source too,
  // otherwise an R2/file stream stays open until GC and leaks a file descriptor
  // on a long-running instance.
  res.on('close', () => nodeStream.destroy());
  nodeStream.pipe(res);
}

/**
 * Body-size ceiling in bytes.
 *
 * `Number('abc')` is NaN, and every `received > NaN` comparison is false — a typo
 * in MAX_BODY_MB used to disable the limit silently instead of falling back.
 */
const MAX_BODY_BYTES = ((): number => {
  const raw = process.env.MAX_BODY_MB;
  if (raw === undefined || raw.trim() === '') return 100 * 1024 * 1024;
  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    console.warn(`[server] MAX_BODY_MB="${raw}" is not a positive number, using 100 MB`);
    return 100 * 1024 * 1024;
  }
  return Math.floor(megabytes * 1024 * 1024);
})();

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
        const env = buildNodeEnv();
        const body = Buffer.concat(chunks);
        const request = nodeRequestToRequest(req, body);
        const response = await pipeline(request, env);
        await writeResponse(res, response, request.method);
      } catch (error) {
        console.error('Unhandled request error:', error);
        try {
          await writeResponse(res, jsonResponse({ error: 'Internal server error' }, 500), req.method || 'GET');
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
// Optional in-process scheduled backup (self-hosted single instance only)
// ---------------------------------------------------------------------------

if (process.env.INPROCESS_CRON === '1') {
  const intervalMs = Number(process.env.INPROCESS_CRON_INTERVAL_MS || 5 * 60 * 1000);
  const timer = setInterval(() => {
    void handleCronTick(
      new Request(`http://localhost/internal/cron/backup`, {
        method: 'POST',
        headers: { 'x-cron-secret': getCronSecret() },
      }),
      buildNodeEnv()
    ).catch((error: unknown) => console.error('Scheduled backup tick failed:', error));
  }, intervalMs);
  timer.unref?.();
  console.log(`  cron:           in-process every ${Math.round(intervalMs / 1000)}s (INPROCESS_CRON=1)`);
}

server.listen(PORT, () => {
  const cronSecret = getCronSecret();
  console.log(`NodeWarden (Node runtime / BYO-DB) listening on http://localhost:${PORT}`);
  console.log(`  data dir:       ${runtime.dataDir}`);
  console.log(`  attachments:    ${runtime.attachmentsDir}`);
  console.log(`  web vault:      ${runtime.distDir}`);
  console.log(`  database:       ${process.env.DB_HOST ? `MySQL ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME || ''}` : 'configured via env DB_* or admin UI (/admin/database)'}`);
  console.log(`  cron:           POST /internal/cron/backup (x-cron-secret)${cronSecret ? '' : ' — CRON_SECRET not set, endpoint disabled'}`);
});
