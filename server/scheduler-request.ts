// Platform scheduler adapters shared by every Node host.
//
// Schedulers that cannot set request headers must still authenticate against
// POST /internal/cron/backup, which starts backups and therefore requires the
// `x-cron-secret` header. Two shapes need adapting:
//
//   - Aliyun FC timer triggers: the platform routes event invocations to
//     `POST /invoke` with Content-Type application/octet-stream and a body of
//     {"triggerTime","triggerName","payload":"<触发消息>"}. The console's
//     "触发消息" is the only place a secret can be supplied.
//   - EdgeOne Pages `schedules`: POST /internal/cron/backup with a JSON body
//     {"secret": "..."} (the platform cannot attach custom headers either).
//
// Kept dependency-free so it can be unit-tested without booting the runtime,
// a database, or the cloudflare:workers stub.

export const CRON_PATH = '/internal/cron/backup';

/** Aliyun FC routes event invocations (timer triggers) to this path. */
export const FC_TIMER_PATH = '/invoke';

/**
 * Informational only: lets the cron log say which scheduler entry fired. The
 * adapter never uses this header for authorization — `x-cron-secret` still has
 * to match CRON_SECRET. Platform logs do not show request headers, so without
 * it every tick (timer, EdgeOne schedule, manual curl) looks identical.
 */
export const SCHEDULER_SOURCE_HEADER = 'x-nodewarden-scheduler';

/** FC allows a 128 KB trigger message; never buffer a real upload here. */
const MAX_PAYLOAD_BYTES = 128 * 1024;

function normalizePath(raw: string): string {
  return raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
}

/**
 * The trigger message is free-form text. Accept the bare secret, or a JSON
 * document with a `secret` field (the shape EdgeOne schedules already use), so
 * one value works on both hosts.
 */
function extractSecret(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { secret?: unknown };
      if (typeof parsed?.secret === 'string' && parsed.secret) return parsed.secret;
    } catch {
      // Not JSON: the whole string is the secret.
    }
  }
  return trimmed;
}

/**
 * Fill `x-cron-secret` from a scheduler payload and rewrite the FC event path
 * to the internal cron endpoint. Both scheduler paths become the same
 * authenticated tick downstream; `handleCronTick` itself stays header-only.
 *
 * Only small JSON/text bodies on those two paths are inspected. Every other
 * request is returned by identity, with its body stream untouched.
 */
export async function adaptSchedulerRequest(request: Request): Promise<Request> {
  if (request.method !== 'POST') return request;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return request;
  }
  const pathname = normalizePath(url.pathname);
  const isCronPath = pathname === CRON_PATH;
  const isTimerPath = pathname === FC_TIMER_PATH;
  if (!isCronPath && !isTimerPath) return request;
  // A real cron client (or an in-process tick) already supplied the header.
  if (request.headers.get('x-cron-secret')) return request;

  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_PAYLOAD_BYTES) return request;
  const contentType = request.headers.get('content-type') || '';
  // FC documents application/octet-stream for event invocations, but some
  // regions send application/json and the console test button sends no header.
  if (contentType && !/(application\/json|application\/octet-stream|text\/plain)/i.test(contentType)) {
    return request;
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return request;
  }

  let secret = '';
  if (raw.length <= MAX_PAYLOAD_BYTES) {
    try {
      const body = JSON.parse(raw) as Record<string, unknown>;
      secret = extractSecret(body?.payload) || extractSecret(body?.secret) || '';
      if (!secret && body?.payload && typeof body.payload === 'object') {
        secret = extractSecret((body.payload as { secret?: unknown }).secret);
      }
    } catch {
      // Some FC versions POST the trigger message verbatim instead of an event.
      secret = extractSecret(raw);
    }
  }

  // Always rebuild: reading the body consumed the stream, and an /invoke that
  // carries no usable secret should still reach the cron handler (and get a
  // clean 401) instead of falling through to an unrelated 404.
  const headers = new Headers(request.headers);
  if (secret) headers.set('x-cron-secret', secret);
  headers.set(
    SCHEDULER_SOURCE_HEADER,
    secret ? (isTimerPath ? 'fc-timer' : 'payload') : 'no-secret'
  );
  if (isTimerPath) url.pathname = CRON_PATH;
  return new Request(url.toString(), { method: request.method, headers, body: raw });
}
