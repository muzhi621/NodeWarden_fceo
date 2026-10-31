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

function isPrivateIpv4Literal(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return (
    a === 0 || // "this network", resolves to localhost on Linux
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local, includes 169.254.169.254 metadata
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT (100.64.0.0/10)
    a >= 224 // multicast + reserved + broadcast
  );
}

/**
 * Recognize the "internal origin" shape of `request.url` on the platform:
 * loopback, RFC1918, link-local, CGNAT, IPv6 unique-local/link-local/multicast.
 * The address arithmetic mirrors the (complete) implementation in
 * src/handlers/admin-db-config.ts rather than a shorter regex list, because
 * platforms commonly hand functions CGNAT or IPv6 ULA addresses.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '::') return true;
  if (host.startsWith('::ffff:')) return isPrivateHost(host.slice('::ffff:'.length));
  if (host.includes(':')) {
    // IPv6 unique-local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8).
    return /^(fc|fd|fe[89ab]|ff)/.test(host);
  }
  return isPrivateIpv4Literal(host);
}

/**
 * Split `host[:port]` (IPv6 literals keep their brackets).
 *
 * Needed because the URL `host` setter keeps the *previous* port when the new
 * authority has none: assigning a bare public host to an internal
 * `http://10.0.0.7:8080/...` URL used to leave `:8080` on the public origin,
 * which then never matches the browser's `Origin` (403 on every write).
 */
function splitAuthority(authority: string): [hostname: string, port: string] {
  const value = authority.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end !== -1) return [value.slice(0, end + 1), value.slice(end + 2)];
  }
  const colon = value.lastIndexOf(':');
  if (colon > 0 && value.indexOf(':') === colon) {
    return [value.slice(0, colon), value.slice(colon + 1)];
  }
  return [value, ''];
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

  // The platform-supplied client IP is the only client identifier that cannot
  // be spoofed from the outside: X-Real-IP / X-Forwarded-For / CF-Connecting-IP
  // all pass through the edge, where the client controls their values.
  // getClientIdentifier() trusts that header chain for login rate limiting, so
  // the platform value overrides every copy whenever it is available.
  const clientIp = String(context?.clientIp || '').trim();
  if (clientIp) {
    headers.set('x-real-ip', clientIp);
    headers.set('x-forwarded-for', clientIp);
    headers.delete('cf-connecting-ip');
    changed = true;
  }

  let url: URL | null = null;
  try {
    url = new URL(incoming.url);
  } catch {
    url = null;
  }

  if (url) {
    // Adopt the forwarded host ONLY when the function is reached through an
    // internal origin shape (loopback / private / CGNAT / ULA). With a public
    // request.url the platform already built the correct public URL, and a
    // client-supplied X-Forwarded-Host must not be able to forge the origin
    // that isSameOriginWriteRequest() compares the Origin header against
    // (the CSRF gate for registration and password hints).
    const forwardedHost = headers.get('x-forwarded-host') || '';
    const hostHeader = headers.get('host') || '';
    const hostTarget = forwardedHost || hostHeader;
    if (isPrivateHost(url.hostname) && hostTarget && url.host !== hostTarget) {
      const [hostname, port] = splitAuthority(hostTarget);
      if (hostname) {
        url.hostname = hostname;
        url.port = port;
        changed = true;
      }
    }
    // Even when the host is already public, the platform may hand the function
    // an http:// URL for an https:// site (internal back-reference). The
    // protocol follows x-forwarded-proto unconditionally: a spoofed value can
    // only produce an origin *mismatch* (403), never a bypass.
    const proto = headers.get('x-forwarded-proto') || '';
    if ((proto === 'https' || proto === 'http') && url.protocol !== `${proto}:`) {
      url.protocol = `${proto}:`;
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
  // A scheduler payload is a tiny JSON document; anything else is a regular
  // client body and must not be slurped just to look for a secret (EdgeOne
  // allows up to 6 MB — cloning it used to hold two copies in memory).
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) return request;

  // Read the original body once and rebuild the request from the buffered
  // text: reusing the original stream on top of the parse would keep both the
  // platform's buffer and ours alive for the whole request.
  const raw = await request.text();
  let secret = '';
  try {
    const payload = JSON.parse(raw) as { secret?: unknown };
    secret = typeof payload?.secret === 'string' ? payload.secret : '';
  } catch {
    secret = '';
  }
  const headers = new Headers(request.headers);
  if (secret) headers.set('x-cron-secret', secret);
  return new Request(request.url, { method: request.method, headers, body: raw });
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
  // The asset layer MUST be stubbed here: the platform serves dist/ itself and
  // node-functions/ is read-only, so a disk-mode fallback would point dataDir
  // and distDir into the code directory (review notes O-1/C-5).
  return handleNodeFetch(request, { assets: 'stub' });
}

export default function onRequest(context: EdgeOneContext): Promise<Response> {
  return handleEdgeOneRequest(context);
}

// Re-exported for scripts/edgeone-smoke.mjs: the bundle entry is this file, so
// this is the only way the test can observe the resolved runtime state.
export { getRuntimeInfo } from './node-runtime';

/** Test surface for the smoke test: pure adapters, no secrets involved. */
export const __testing = { isPrivateHost, adaptRequest };
