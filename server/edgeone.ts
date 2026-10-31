// Tencent EdgeOne Pages entry (Node Functions runtime).
//
// EdgeOne Pages runs `node-functions/**` as request-scoped Node handlers
// (`onRequest(context)` → Response) and serves `dist/` as static assets, with
// the SPA fallback declared in edgeone.json. That means:
//   - there is no socket to listen on, so `server/index.ts` (http.Server) cannot
//     be used here — this file wraps the shared pipeline instead;
//   - static assets never reach this code; only the backend path prefixes are
//     mapped to functions (see node-functions/**), so the asset layer is stubbed;
//   - configuration arrives as `context.env` rather than as process environment
//     variables, so it is mirrored into `process.env` before the env is built.
//
// Platform limits that shape the deployment (documented in EDGEONE-DEPLOY.md):
//   - request body ≤ 6 MB, single invocation ≤ 120 s (30 s by default),
//   - no persistent filesystem: only /tmp, recycled with the instance,
//   - KV storage is only offered to Edge Functions, not to Node Functions.

import { applyEnvFromRecord, handleNodeFetch } from './node-runtime';

export interface EdgeOneContext {
  request: Request;
  env?: Record<string, string | undefined>;
  params?: Record<string, string | string[]>;
  clientIp?: string;
  server?: { region?: string; requestId?: string };
  uuid?: string;
}

const CRON_PATH = '/internal/cron/backup';

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

/**
 * Adapt the platform request to what the shared pipeline expects.
 *
 * Two things have to be reconstructed, because the Worker runtime gets them from
 * Cloudflare for free:
 *   1. the public URL — `isSameOriginWriteRequest()` compares the `Origin` header
 *      against `new URL(request.url).origin`, so an internal host would make
 *      registration (and password hints) fail with 403 "Forbidden origin";
 *   2. the client IP — `getClientIdentifier()` reads CF-Connecting-IP /
 *      X-Real-IP / X-Forwarded-For and rate limiting rejects requests without one
 *      ("Client IP is required"). EdgeOne exposes it as `context.clientIp`.
 */
function adaptRequest(incoming: Request, context: EdgeOneContext): Request {
  const headers = new Headers(incoming.headers);
  let changed = false;

  if (!headers.get('cf-connecting-ip') && !headers.get('x-real-ip') && !headers.get('x-forwarded-for')) {
    const clientIp = String(context?.clientIp || '').trim();
    if (clientIp) {
      headers.set('x-forwarded-for', clientIp);
      changed = true;
    }
  }

  let url: URL | null = null;
  try {
    url = new URL(incoming.url);
  } catch {
    url = null;
  }

  if (url) {
    const forwardedHost = headers.get('x-forwarded-host');
    const hostHeader = forwardedHost || headers.get('host') || '';
    // Two shapes seen in the wild: a container-local URL (localhost/private IP)
    // and a platform-internal host that differs from the Host header. In both
    // cases the Host header is what the browser used.
    const shouldRewrite = forwardedHost
      ? forwardedHost !== url.host
      : isPrivateHost(url.hostname) && !!hostHeader;
    if (shouldRewrite) {
      url.host = hostHeader;
      const proto = headers.get('x-forwarded-proto') || '';
      if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`;
      changed = true;
    }
  }

  if (!changed) return incoming;

  const init: RequestInit = { method: incoming.method, headers };
  if (incoming.method !== 'GET' && incoming.method !== 'HEAD' && incoming.body) {
    init.body = incoming.body;
    // Node requires this whenever a Request is built from a stream body.
    (init as { duplex?: string }).duplex = 'half';
  }
  return new Request(url ? url.toString() : incoming.url, init);
}

/**
 * Platforms whose scheduler cannot set request headers may pass the shared
 * secret in the JSON payload instead (`edgeone.json` → `schedules[].payload`).
 * The header stays the primary mechanism; this only fills the gap.
 */
async function withSchedulerSecret(request: Request): Promise<Request> {
  if (request.method !== 'POST') return request;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname.replace(/\/+$/, '');
  } catch {
    return request;
  }
  if (pathname !== CRON_PATH) return request;
  if (request.headers.get('x-cron-secret')) return request;

  try {
    const payload = await request.clone().json() as { secret?: unknown };
    const secret = typeof payload?.secret === 'string' ? payload.secret : '';
    if (!secret) return request;
    const headers = new Headers(request.headers);
    headers.set('x-cron-secret', secret);
    const init: RequestInit = { method: request.method, headers };
    if (request.body) {
      init.body = request.body;
      (init as { duplex?: string }).duplex = 'half';
    }
    return new Request(request.url, init);
  } catch {
    return request;
  }
}

/**
 * The single entry point used by every `node-functions/**` file.
 * Exported as `default` as well, so a function file may simply re-export it.
 */
export async function handleEdgeOneRequest(context: EdgeOneContext): Promise<Response> {
  // EdgeOne Pages injects project variables here; the platform is the only
  // source of configuration on this host (no shell, no .env file).
  applyEnvFromRecord(context?.env);

  const incoming = context?.request;
  if (!incoming) {
    return new Response(JSON.stringify({ error: 'Bad Request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const request = await withSchedulerSecret(adaptRequest(incoming, context));
  return handleNodeFetch(request);
}

export default function onRequest(context: EdgeOneContext): Promise<Response> {
  return handleEdgeOneRequest(context);
}
