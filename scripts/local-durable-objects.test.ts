// Regression tests: the in-process Durable Object runtime used by the Node build.
//
// Before this existed, every DO call answered HTTP 501
// (`durable-objects-unavailable`), which broke the backup centre (manual run,
// scheduled run, remote restore, attachment sync) and left `/notifications/...`
// negotiate returning 500 "Failed to issue websocket connection token".
//
// Run: node --import ./server/register-cf-stub.mjs --import tsx --test scripts/local-durable-objects.test.ts
// (the `cloudflare:workers` stub loader is required: the real DO classes import
//  `DurableObject` from it.)

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalDurableObjectNamespace } from '../server/local-durable-objects';
import type { Env } from '../src/types';

interface ProbeObject {
  fetch(request: Request): Promise<Response>;
}

function createProbeNamespace() {
  const created: string[] = [];
  const namespace = createLocalDurableObjectNamespace(
    'PROBE',
    (ctx, _env) => {
      const state = ctx as {
        storage: {
          get<T>(key: string): Promise<T | undefined>;
          put<T>(key: string, value: T): Promise<void>;
          delete(key: string): Promise<boolean>;
          list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
          transaction<T>(closure: (txn: unknown) => Promise<T>): Promise<T>;
          setAlarm(at: number): Promise<void>;
          getAlarm(): Promise<number | null>;
        };
      };
      created.push('created');
      return {
        async fetch(request: Request): Promise<Response> {
          const url = new URL(request.url);
          if (url.pathname === '/echo') {
            const body = (await request.json()) as { key?: string; value?: string };
            if (body.key) await state.storage.put(body.key, body.value ?? '');
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          if (url.pathname === '/read') {
            const key = url.searchParams.get('key') || '';
            return new Response(JSON.stringify({ value: (await state.storage.get(key)) ?? null }));
          }
          if (url.pathname === '/list') {
            const entries = await state.storage.list<string>({ prefix: 'k' });
            return new Response(JSON.stringify({ entries: Array.from(entries.entries()) }));
          }
          if (url.pathname === '/transaction') {
            const value = await state.storage.transaction(async (txn) => {
              const typed = txn as { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, v: T): Promise<void> };
              await typed.put('txn', 'done');
              return typed.get<string>('txn');
            });
            return new Response(JSON.stringify({ value }));
          }
          if (url.pathname === '/alarm') {
            await state.storage.setAlarm(1234);
            return new Response(JSON.stringify({ alarm: await state.storage.getAlarm() }));
          }
          return new Response('Not found', { status: 404 });
        },
      } satisfies ProbeObject;
    },
    () => ({}) as Env
  );
  return { namespace, created };
}

test('stub resolves object names lazily and reuses the instance', async () => {
  const { namespace, created } = createProbeNamespace();
  const id = namespace.idFromName('alpha');
  assert.equal(created.length, 0, 'instances must be created on first fetch');

  const stub = namespace.get(id);
  const first = await stub.fetch('https://probe/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'k1', value: 'v1' }),
  });
  assert.equal(first.status, 200);
  assert.equal(created.length, 1);

  // A second stub for the same name shares the instance and its storage.
  const read = await namespace.get(namespace.idFromName('alpha')).fetch('https://probe/read?key=k1');
  assert.deepEqual(await read.json(), { value: 'v1' });
  assert.equal(created.length, 1);

  // A different name gets its own instance and empty storage.
  const otherRead = await namespace.get(namespace.idFromName('beta')).fetch('https://probe/read?key=k1');
  assert.deepEqual(await otherRead.json(), { value: null });
  assert.equal(created.length, 2);
});

test('memory storage supports list, transactions and alarms', async () => {
  const { namespace } = createProbeNamespace();
  const stub = namespace.get(namespace.idFromName('storage'));
  await stub.fetch('https://probe/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'k2', value: 'v2' }),
  });
  await stub.fetch('https://probe/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'other', value: 'ignored' }),
  });

  const listed = await stub.fetch('https://probe/list');
  assert.deepEqual(await listed.json(), { entries: [['k2', 'v2']] });

  const txn = await stub.fetch('https://probe/transaction');
  assert.deepEqual(await txn.json(), { value: 'done' });

  const alarm = await stub.fetch('https://probe/alarm');
  assert.deepEqual(await alarm.json(), { alarm: 1234 });
});

test('websocket upgrades degrade with a clear 501 instead of throwing', async () => {
  const { namespace, created } = createProbeNamespace();
  const response = await namespace.get(namespace.idFromName('ws')).fetch('https://probe/hub', {
    headers: { Upgrade: 'websocket' },
  });
  assert.equal(response.status, 501);
  assert.match(await response.text(), /does not support WebSocket upgrades/);
  assert.equal(created.length, 0, 'upgrade rejection must not construct the object');
});

test('a failing constructor is reported as 500 and can be retried', async () => {
  let attempts = 0;
  const namespace = createLocalDurableObjectNamespace(
    'FLAKY',
    () => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
      return { async fetch(): Promise<Response> { return new Response('ok'); } };
    },
    () => ({}) as Env
  );

  const first = await namespace.get(namespace.idFromName('x')).fetch('https://flaky/');
  assert.equal(first.status, 500);
  assert.match(await first.text(), /FLAKY failed to start: boom/);

  const second = await namespace.get(namespace.idFromName('x')).fetch('https://flaky/');
  assert.equal(second.status, 200);
  assert.equal(attempts, 2);
});
