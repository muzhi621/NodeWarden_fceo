// Tests for the observable cron tick: one structured log line per invocation
// (never containing the secret) and a response summary that says whether a
// backup actually ran, instead of a bare {"ok":true} that hides everything.

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatCronTickLog, logCronTick } from '../server/cron-tick';
import { adaptSchedulerRequest, CRON_PATH, FC_TIMER_PATH, SCHEDULER_SOURCE_HEADER } from '../server/scheduler-request';
import { runScheduledBackupIfDue } from '../src/handlers/backup';

const SECRET = 'a-very-long-cron-secret-123456';

test('cron log: a rejected tick shows the length mismatch but never the secret', () => {
  const line = formatCronTickLog({
    status: 'rejected', httpStatus: 401, source: 'fc-timer', reason: 'invalid-secret',
    providedLength: SECRET.length + 1, expectedLength: SECRET.length,
    durationMs: 3,
  });
  assert.match(line, /\[cron\] status=rejected\(401\)/);
  assert.match(line, /source=fc-timer/);
  assert.match(line, /reason=invalid-secret/);
  assert.match(line, /providedLen=31 expectedLen=30/);
  assert.match(line, /durationMs=3/);
  assert.ok(!line.includes(SECRET), 'the secret must never appear in logs');
});

test('cron log: a successful idle tick says completed=0 (checked, nothing due)', () => {
  const line = formatCronTickLog({
    status: 'ok', httpStatus: 200, source: 'fc-timer',
    completed: 0, failed: 0, busy: false, durationMs: 41,
  });
  assert.match(line, /status=ok\(200\)/);
  assert.match(line, /completed=0 failed=0 busy=false/);
});

test('cron log: a completed backup and a busy lease are distinguishable', () => {
  assert.match(
    formatCronTickLog({ status: 'ok', httpStatus: 200, source: 'payload', completed: 1, failed: 0, busy: false }),
    /completed=1 failed=0 busy=false/
  );
  assert.match(
    formatCronTickLog({ status: 'ok', httpStatus: 200, source: 'direct', completed: 0, failed: 0, busy: true }),
    /busy=true/
  );
});

test('cron log: source is sanitized so headers cannot forge extra log lines', () => {
  const line = formatCronTickLog({
    status: 'rejected', httpStatus: 401, source: 'fc-timer\n[cron] status=ok(200) completed=1',
  });
  assert.equal(line.split('\n').length, 1);
  assert.ok(!line.includes('status=ok(200)'));
});

test('cron log: status selects the console level', () => {
  const calls: string[] = [];
  const logger = {
    log: (s: string) => calls.push(`log:${s}`),
    warn: (s: string) => calls.push(`warn:${s}`),
    error: (s: string) => calls.push(`error:${s}`),
  };
  logCronTick({ status: 'ok', httpStatus: 200, source: 'direct' }, logger);
  logCronTick({ status: 'rejected', httpStatus: 401, source: 'direct' }, logger);
  logCronTick({ status: 'error', httpStatus: 503, source: 'direct' }, logger);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /^log:\[cron\] status=ok/);
  assert.match(calls[1], /^warn:\[cron\] status=rejected/);
  assert.match(calls[2], /^error:\[cron\] status=error/);
});

test('scheduler adapter: tags the source so platform logs can name the trigger', async () => {
  const timer = new Request(`https://k.miui.im${FC_TIMER_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: JSON.stringify({ triggerTime: 'x', triggerName: 'tick', payload: SECRET }),
  });
  assert.equal((await adaptSchedulerRequest(timer)).headers.get(SCHEDULER_SOURCE_HEADER), 'fc-timer');

  const schedule = new Request(`https://k.miui.im${CRON_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET }),
  });
  assert.equal((await adaptSchedulerRequest(schedule)).headers.get(SCHEDULER_SOURCE_HEADER), 'payload');

  const noSecret = new Request(`https://k.miui.im${CRON_PATH}`, { method: 'POST' });
  assert.equal((await adaptSchedulerRequest(noSecret)).headers.get(SCHEDULER_SOURCE_HEADER), 'no-secret');
});

function envReturning(response: () => Response): unknown {
  return {
    BACKUP_TRANSFER_RUNNER: {
      idFromName: () => ({ name: 'configured-backup-runner' }),
      get: () => ({ fetch: async () => response() }),
    },
  };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('tick summary: counters from the backup runner are surfaced', async () => {
  const summary = await runScheduledBackupIfDue(envReturning(() => ok({ ok: true, completed: 2, failed: 1, failures: [{ destinationId: 'x', error: 'boom' }] })) as never);
  assert.deepEqual(summary, { completed: 2, failed: 1, busy: false });
});

test('tick summary: an idle tick is explicitly zero, and failures[] is a fallback', async () => {
  assert.deepEqual(
    await runScheduledBackupIfDue(envReturning(() => ok({ ok: true, completed: 0, failed: 0, failures: [] })) as never),
    { completed: 0, failed: 0, busy: false }
  );
  assert.deepEqual(
    await runScheduledBackupIfDue(envReturning(() => ok({ ok: true, failures: [{ error: 'x' }, { error: 'y' }] })) as never),
    { completed: 0, failed: 2, busy: false }
  );
});

test('tick summary: a 409 job lease is reported as busy, not as a failure', async () => {
  const summary = await runScheduledBackupIfDue(envReturning(() => new Response('busy', { status: 409 })) as never);
  assert.deepEqual(summary, { completed: 0, failed: 0, busy: true });
});

test('tick summary: a non-ok runner response still throws', async () => {
  await assert.rejects(
    runScheduledBackupIfDue(envReturning(() => new Response(JSON.stringify({ error: 'db down' }), { status: 500 })) as never),
    /db down/
  );
});

test('tick summary: an empty success body from an older runner is tolerated', async () => {
  assert.deepEqual(
    await runScheduledBackupIfDue(envReturning(() => new Response(null, { status: 200 })) as never),
    { completed: 0, failed: 0, busy: false }
  );
});
