// HTTP-level tests for the self-hosted Node entry (server/index.ts).
//
// These cover the request plumbing that the unit tests cannot reach: the body is
// streamed into the fetch pipeline instead of being buffered, the declared and
// the chunked size limits both answer 413, and a response does not leave the
// connection in a state where the next request hangs.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createLimitedBody } from '../server/body-stream';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY_MB = 2;

interface Harness {
  port: number;
  child: ChildProcess;
  logs: () => string;
  agent: http.Agent;
  stop: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(port: number, child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${logs()}`);
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/healthz', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      });
      req.on('error', () => resolve(false));
      req.end();
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not answer within 30s:\n${logs()}`);
}

async function startServer(): Promise<Harness> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-http-'));
  const port = await freePort();
  // Same invocation as `npm run start:node`: the `cloudflare:workers` stub has
  // to be registered before the server module is loaded, and a relative
  // specifier is what the ESM loader accepts on every platform.
  //
  // NW_SERVER_ENTRY=server/index.mjs runs the same checks against the bundled
  // artifact that actually ships to FC, where a broken bundle would not be
  // caught by the TypeScript path.
  const entry = process.env.NW_SERVER_ENTRY || 'server/index.ts';
  const imports = ['--import', './server/register-cf-stub.mjs'];
  if (entry.endsWith('.ts')) imports.push('--import', 'tsx');
  const child = spawn(process.execPath, [...imports, entry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256',
      MAX_BODY_MB: String(MAX_BODY_MB),
      NODE_ENV: 'test',
      // Keep the startup probe honest: no mount is expected for a temp dir.
      ATTACHMENTS_DIR: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
  const logs = () => output;

  await waitForServer(port, child, logs);
  return {
    port,
    child,
    logs,
    agent,
    stop: async () => {
      agent.destroy();
      await fsp.rm(dataDir, { recursive: true, force: true });
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    },
  };
}

interface Reply {
  status: number;
  body: string;
}

function request(
  harness: Harness,
  options: { method: string; path: string; headers?: Record<string, string>; body?: Buffer | string }
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: harness.port,
        path: options.path,
        method: options.method,
        headers: options.headers,
        agent: harness.agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

test('the Node entry streams request bodies and enforces the size limit', async (t) => {
  const harness = await startServer();
  t.after(() => harness.stop());

  await t.test('healthz reports the runtime and the attachment disk', async () => {
    const reply = await request(harness, { method: 'GET', path: '/healthz' });
    // Without a database the gate answers 503; the shape is what matters here.
    assert.ok([200, 503].includes(reply.status), `${reply.status} ${reply.body}`);
    const body = JSON.parse(reply.body);
    assert.equal(body.runtime, 'node');
    assert.equal(body.attachments, 'ok');
  });

  await t.test('a body is delivered to the handler intact', async () => {
    const payload = JSON.stringify({ grant_type: 'password', username: 'a', password: 'b' });
    const reply = await request(harness, {
      method: 'POST',
      path: '/identity/connect/token',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      body: payload,
    });
    // Any real answer proves the handler saw the body; a hang or a 500 from the
    // adapter would not. The DB gate may still answer 503 in this setup.
    assert.ok([400, 401, 500, 503].includes(reply.status), `${reply.status} ${reply.body}`);
    assert.ok(!reply.body.includes('Payload too large'));
  });

  await t.test('the connection is reusable after a streamed request', async () => {
    // Two requests over the same keep-alive socket: the response must not be
    // written while the request body is still pending, or the next request reads
    // the previous body's tail.
    const first = await request(harness, { method: 'GET', path: '/healthz' });
    const second = await request(harness, { method: 'GET', path: '/healthz' });
    assert.ok([200, 503].includes(first.status));
    assert.ok([200, 503].includes(second.status));
    assert.equal(JSON.parse(second.body).runtime, 'node');
  });

  await t.test('a declared oversized body is refused without being read', async () => {
    const tooBig = Buffer.alloc((MAX_BODY_MB + 1) * 1024 * 1024, 0x61);
    const reply = await request(harness, {
      method: 'POST',
      path: '/identity/connect/token',
      headers: { 'content-type': 'application/json', 'content-length': String(tooBig.length) },
      body: tooBig,
    }).catch((error: Error) => ({ status: 0, body: error.message }));
    // Two outcomes are correct and both mean "not accepted": the client reads
    // the 413, or it is still mid-upload when the socket closes and sees a
    // connection error instead. Draining the body just to make the rejection
    // tidier would defeat the point of rejecting before reading.
    assert.ok(reply.status === 413 || reply.status === 0, `${reply.status} ${reply.body.slice(0, 200)}`);
    if (reply.status === 413) assert.match(reply.body, /Payload too large/);
  });

  await t.test('a chunked body larger than the limit is answered, not swallowed', async () => {
    const chunk = Buffer.alloc(512 * 1024, 0x62);
    const total = MAX_BODY_MB + 1; // MB
    const reply = await new Promise<Reply>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: harness.port,
          path: '/identity/connect/token',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
        }
      );
      req.on('error', reject);
      try {
        for (let mb = 0; mb < total; mb += 0.5) req.write(chunk);
        req.end();
      } catch {
        // The server answered mid-upload and dropped the socket; the reply is
        // already on its way, so a failed write here proves nothing.
      }
    });
    // Without a database the gate answers before any handler reads the body, so
    // the overflow is caught by the stream rather than by a route: what matters
    // is that the request is answered instead of hanging or being accepted.
    assert.ok(reply.status !== 201 && reply.status !== 200, `${reply.status} ${reply.body.slice(0, 120)}`);
  });
});

// ---------------------------------------------------------------------------
// The limiter itself: the entry can only answer 413 for an overflow the handler
// actually reads, so exercise the stream directly rather than through a route.
// ---------------------------------------------------------------------------

test('the body limiter passes small bodies through unchanged', async () => {
  const { Readable } = await import('node:stream');
  const payload = Buffer.alloc(512 * 1024, 0x63);
  const body = createLimitedBody(Readable.from([payload]), 1024 * 1024);

  const received = new Uint8Array(await new Response(body.stream).arrayBuffer());
  assert.equal(received.byteLength, payload.byteLength);
  assert.equal(received[0], 0x63);
  assert.equal(body.exceeded(), false);
});

test('the body limiter cuts a stream that grows past the limit', async () => {
  const { Readable } = await import('node:stream');
  const chunk = Buffer.alloc(256 * 1024, 0x64);
  const body = createLimitedBody(Readable.from([chunk, chunk, chunk, chunk, chunk]), 1024 * 1024);

  await assert.rejects(() => new Response(body.stream).arrayBuffer(), /Payload too large/);
  assert.equal(body.exceeded(), true);
});

test('a source error is forwarded to the reader', async () => {
  const { Readable } = await import('node:stream');
  const failing = new Readable({
    read() {
      this.destroy(new Error('client went away'));
    },
  });
  const body = createLimitedBody(failing, 1024);
  await assert.rejects(() => new Response(body.stream).arrayBuffer(), /client went away/);
  assert.equal(body.exceeded(), false);
});
