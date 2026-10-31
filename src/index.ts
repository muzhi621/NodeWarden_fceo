import { Env } from './types';
import { NotificationsHub } from './durable/notifications-hub';
import { BackupTransferRunner } from './durable/backup-transfer-runner';
import { handleRequest } from './router';
import { ensureDatabaseInitialized, getDbInitError } from './services/db-lifecycle';
import { getDatabaseStatus } from './services/storage-factory';
import { applyCors, jsonResponse } from './utils/response';
import { runScheduledBackupIfDue } from './handlers/backup';
import {
  isBackendRequestPath,
  isWebVaultHidden,
  webVaultNotFoundResponse,
} from './web-vault-visibility';

function normalizeRequestUrl(request: Request): Request {
  const url = new URL(request.url);
  const normalizedPathname = url.pathname.length <= 1 ? url.pathname : url.pathname.replace(/\/+$/, '');
  if (normalizedPathname === url.pathname) return request;

  url.pathname = normalizedPathname;
  return new Request(url.toString(), request);
}

function addSearchIndexHeaders(request: Request, response: Response): Response {
  const url = new URL(request.url);
  const contentType = String(response.headers.get('Content-Type') || '').toLowerCase();
  const shouldNoIndex =
    url.pathname === '/robots.txt' ||
    contentType.includes('text/html');

  if (!shouldNoIndex) return response;

  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function maybeServeAsset(request: Request, env: Env): Promise<Response | null> {
  if (!env.ASSETS) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  if (isBackendRequestPath(url.pathname)) return null;

  const response = await env.ASSETS.fetch(request);
  return addSearchIndexHeaders(request, response);
}

async function handleHealthz(env: Env): Promise<Response> {
  const status = await getDatabaseStatus(env);
  if (status.error) {
    // Unauthenticated endpoint: raw MySQL errors leak the DB user, egress IP and
    // schema names. Keep the detail in the logs, expose only the shape.
    console.error('[healthz] database unavailable:', status.error);
  }
  return jsonResponse(
    { ok: status.ok, db: status.ok ? 'up' : 'down', mode: status.mode, source: status.source },
    status.ok ? 200 : 503
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const normalizedRequest = normalizeRequestUrl(request);
    const requestPath = new URL(normalizedRequest.url).pathname;

    if (isWebVaultHidden(env) && !isBackendRequestPath(requestPath)) {
      return webVaultNotFoundResponse(normalizedRequest);
    }

    const assetResponse = await maybeServeAsset(normalizedRequest, env);
    if (assetResponse) {
      return applyCors(normalizedRequest, assetResponse, env);
    }

    if (requestPath === '/healthz' || requestPath === '/api/healthz') {
      return applyCors(normalizedRequest, await handleHealthz(env), env);
    }

    await ensureDatabaseInitialized(env);
    const dbInitError = getDbInitError();
    if (dbInitError) {
      // Log full error server-side, return generic message to client.
      console.error('DB init error (not forwarded to client):', dbInitError);
      const resp = jsonResponse(
        {
          error: 'Database not initialized',
          error_description: 'Database initialization failed. Check server logs for details.',
          ErrorModel: {
            Message: 'Service temporarily unavailable',
            Object: 'error',
          },
        },
        500
      );
      return applyCors(normalizedRequest, resp, env);
    }

    const resp = await handleRequest(normalizedRequest, env);
    return applyCors(normalizedRequest, resp, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    void controller;
    await ensureDatabaseInitialized(env);
    const dbInitError = getDbInitError();
    if (dbInitError) {
      console.error('Skipping scheduled backup because DB init failed:', dbInitError);
      return;
    }
    ctx.waitUntil(runScheduledBackupIfDue(env).catch((error) => {
      console.error('Scheduled backup failed:', error);
    }));
  },
};

export { NotificationsHub };
export { BackupTransferRunner };
