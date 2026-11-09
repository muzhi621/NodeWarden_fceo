// Unit tests for the platform scheduler adapter.
//
// Aliyun FC timer triggers cannot attach request headers: the platform POSTs
// the trigger event to /invoke with Content-Type application/octet-stream and
// {"triggerTime","triggerName","payload":"<触发消息>"}. These tests verify that
// the payload is mapped onto the authenticated cron endpoint, and that no other
// request ever has its body consumed by the adapter.

import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptSchedulerRequest, CRON_PATH, FC_TIMER_PATH } from '../server/scheduler-request';

const BASE = 'https://k.miui.im';
const SECRET = 'a-very-long-cron-secret-123456';

function fcTimerEvent(payload: unknown, headers: Record<string, string> = {}): Request {
  const body = JSON.stringify({
    triggerTime: '2026-11-09T00:35:00Z',
    triggerName: 'nodewarden-backup-tick',
    payload,
  });
  return new Request(`${BASE}${FC_TIMER_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...headers },
    body,
  });
}

test('FC timer: bare secret in 触发消息 becomes the cron header and rewrites /invoke', async () => {
  const adapted = await adaptSchedulerRequest(fcTimerEvent(SECRET));
  assert.equal(adapted.headers.get('x-cron-secret'), SECRET);
  assert.equal(new URL(adapted.url).pathname, CRON_PATH);
  const body = (await adapted.json()) as { triggerName?: string; payload?: string };
  assert.equal(body.triggerName, 'nodewarden-backup-tick');
  assert.equal(body.payload, SECRET);
});

test('FC timer: JSON-string payload {"secret": ...} also works', async () => {
  const adapted = await adaptSchedulerRequest(fcTimerEvent(JSON.stringify({ secret: SECRET })));
  assert.equal(adapted.headers.get('x-cron-secret'), SECRET);
  assert.equal(new URL(adapted.url).pathname, CRON_PATH);
});

test('FC timer: payload object with a secret field also works', async () => {
  const adapted = await adaptSchedulerRequest(fcTimerEvent({ secret: SECRET }));
  assert.equal(adapted.headers.get('x-cron-secret'), SECRET);
});

test('FC timer: application/json and a missing Content-Type are both accepted', async () => {
  for (const contentType of ['application/json', '', 'text/plain']) {
    const headers: Record<string, string> = contentType ? { 'content-type': contentType } : {};
    const raw = JSON.stringify({ payload: SECRET, triggerName: 'tick', triggerTime: 'x' });
    const request = new Request(`${BASE}${FC_TIMER_PATH}`, { method: 'POST', headers, body: raw });
    if (!contentType) request.headers.delete('content-type');
    const adapted = await adaptSchedulerRequest(request);
    assert.equal(adapted.headers.get('x-cron-secret'), SECRET, `content-type=${contentType || '(none)'}`);
  }
});

test('FC timer: a verbatim (non-JSON) trigger message is accepted', async () => {
  const request = new Request(`${BASE}${FC_TIMER_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: SECRET,
  });
  const adapted = await adaptSchedulerRequest(request);
  assert.equal(adapted.headers.get('x-cron-secret'), SECRET);
  assert.equal(await adapted.text(), SECRET);
});

test('FC timer: any trigger message is passed through and checked by the cron handler', async () => {
  const adapted = await adaptSchedulerRequest(fcTimerEvent('awesome-fc'));
  assert.equal(new URL(adapted.url).pathname, CRON_PATH);
  // 'awesome-fc' is the console example, not the real CRON_SECRET. It becomes
  // the candidate header and is rejected with 401 by handleCronTick — the
  // adapter never decides what is a valid secret.
  assert.equal(adapted.headers.get('x-cron-secret'), 'awesome-fc');
});

test('EdgeOne schedules: {"secret": ...} on the cron path is supported too', async () => {
  const request = new Request(`${BASE}${CRON_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET }),
  });
  const adapted = await adaptSchedulerRequest(request);
  assert.equal(adapted.headers.get('x-cron-secret'), SECRET);
  assert.equal(new URL(adapted.url).pathname, CRON_PATH);
  assert.deepEqual(await adapted.json(), { secret: SECRET });
});

test('an existing x-cron-secret header wins and the body is left untouched', async () => {
  const request = new Request(`${BASE}${FC_TIMER_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-cron-secret': SECRET },
    body: 'whatever',
  });
  const adapted = await adaptSchedulerRequest(request);
  assert.equal(adapted, request, 'the request must be returned by identity');
  assert.equal(adapted.bodyUsed, false);
});

test('unrelated paths, methods, media types and oversized payloads are untouched', async () => {
  const cases: Request[] = [
    new Request(`${BASE}/api/admin/backup/run`, { method: 'POST', body: '{}' }),
    new Request(`${BASE}${CRON_PATH}`, { method: 'GET' }),
    new Request(`${BASE}${FC_TIMER_PATH}/extra`, { method: 'POST', body: '{}' }),
    new Request(`${BASE}${FC_TIMER_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: '{}',
    }),
    new Request(`${BASE}${FC_TIMER_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': '999999' },
      body: '{}',
    }),
  ];
  for (const request of cases) {
    const adapted = await adaptSchedulerRequest(request);
    assert.equal(adapted, request, `${request.method} ${new URL(request.url).pathname}`);
    assert.equal(adapted.bodyUsed, false);
  }
});

test('an oversized trigger body is never scanned for a secret, but the body survives', async () => {
  const big = `{"payload":"${'x'.repeat(129 * 1024)}"}`;
  const request = new Request(`${BASE}${FC_TIMER_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: big,
  });
  const adapted = await adaptSchedulerRequest(request);
  assert.equal(adapted.headers.get('x-cron-secret'), null);
  assert.equal(new URL(adapted.url).pathname, CRON_PATH);
  assert.equal(await adapted.text(), big);
});

test('a header-less empty cron request does not throw', async () => {
  const request = new Request(`${BASE}${CRON_PATH}`, { method: 'POST' });
  const adapted = await adaptSchedulerRequest(request);
  assert.equal(adapted.headers.get('x-cron-secret'), null);
  assert.equal(new URL(adapted.url).pathname, CRON_PATH);
});
