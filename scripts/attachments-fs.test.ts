// Tests for the filesystem-backed attachment bucket ("mount OSS/COS/NAS as the
// attachment disk"). The semantics here are dictated by object-store mounts:
// writes can be interrupted, and "missing" must not be confused with "the mount
// is broken".

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { classifyReadError, createFsR2, resolveObjectPath } from '../server/fs-r2';

async function tempBucket(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-attachments-'));
  return { dir, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('put then get round-trips bytes, content type and custom metadata', async () => {
  const { dir, cleanup } = await tempBucket();
  try {
    const bucket = createFsR2(dir);
    const payload = new TextEncoder().encode('attachment bytes');
    await bucket.put('cipher-1/att-1', payload, {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { cipherId: 'cipher-1', attachmentId: 'att-1' },
    });

    const object = await bucket.get('cipher-1/att-1');
    assert.ok(object);
    assert.equal(object!.size, payload.byteLength);
    assert.equal(object!.httpMetadata.contentType, 'image/png');
    assert.deepEqual(object!.customMetadata, { cipherId: 'cipher-1', attachmentId: 'att-1' });
    assert.equal(await new Response(object!.body).text(), 'attachment bytes');

    // The documented two-objects-per-attachment behaviour (DEPLOY.md 3.6).
    assert.ok(fs.existsSync(path.join(dir, 'cipher-1', 'att-1')));
    assert.ok(fs.existsSync(path.join(dir, 'cipher-1', 'att-1.meta.json')));
  } finally {
    await cleanup();
  }
});

test('a missing object returns null so the handler can answer 404', async () => {
  const { dir, cleanup } = await tempBucket();
  try {
    const bucket = createFsR2(dir);
    assert.equal(await bucket.get('cipher-1/nope'), null);
  } finally {
    await cleanup();
  }
});

test('a truncated object is refused instead of served', async () => {
  const { dir, cleanup } = await tempBucket();
  try {
    const bucket = createFsR2(dir);
    await bucket.put('cipher-1/att-1', new TextEncoder().encode('0123456789'));
    // Simulate a write that was cut short: the sidecar still says 10 bytes.
    const file = path.join(dir, 'cipher-1', 'att-1');
    await fsp.writeFile(file, new TextEncoder().encode('012'));

    assert.equal(await bucket.get('cipher-1/att-1'), null);
  } finally {
    await cleanup();
  }
});

test('an interrupted first upload leaves no readable object at all', async () => {
  const { dir, cleanup } = await tempBucket();
  try {
    const bucket = createFsR2(dir);
    // Metadata is written before the data, so a crash between the two leaves an
    // expected size that the (absent) file cannot match.
    await fsp.mkdir(path.join(dir, 'cipher-1'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'cipher-1', 'att-1.meta.json'), JSON.stringify({ size: 10 }));
    assert.equal(await bucket.get('cipher-1/att-1'), null);
  } finally {
    await cleanup();
  }
});

test('overwriting an object updates both the bytes and the recorded size', async () => {
  const { dir, cleanup } = await tempBucket();
  try {
    const bucket = createFsR2(dir);
    await bucket.put('cipher/att', new TextEncoder().encode('first version'));
    await bucket.put('cipher/att', new TextEncoder().encode('v2'));

    const object = await bucket.get('cipher/att');
    assert.ok(object);
    assert.equal(object!.size, 2);
    assert.equal(await new Response(object!.body).text(), 'v2');
  } finally {
    await cleanup();
  }
});

test('delete removes the object and its sidecar', async () => {
  const { dir, cleanup } = await tempBucket();
  try {
    const bucket = createFsR2(dir);
    await bucket.put('cipher/att', new TextEncoder().encode('x'));
    await bucket.delete('cipher/att');

    assert.equal(await bucket.get('cipher/att'), null);
    assert.equal(fs.existsSync(path.join(dir, 'cipher', 'att.meta.json')), false);
    // Deleting again is a no-op, not an error.
    await bucket.delete('cipher/att');
  } finally {
    await cleanup();
  }
});

test('object keys with spaces and non-ASCII names survive the filesystem', async () => {
  const { dir, cleanup } = await tempBucket();
  try {
    const bucket = createFsR2(dir);
    await bucket.put('密码/附件 一.pdf', new TextEncoder().encode('pdf'));
    const object = await bucket.get('密码/附件 一.pdf');
    assert.ok(object);
    assert.equal(await new Response(object!.body).text(), 'pdf');
  } finally {
    await cleanup();
  }
});

test('keys that escape the bucket root are rejected', async () => {
  const { dir, cleanup } = await tempBucket();
  try {
    const bucket = createFsR2(dir);
    for (const key of ['../escape', 'a/../../escape', '..', '']) {
      await assert.rejects(
        () => bucket.put(key, new TextEncoder().encode('x')),
        /Invalid object key/,
        `expected ${JSON.stringify(key)} to be rejected`
      );
    }
    assert.equal(fs.existsSync(path.join(dir, '..', 'escape')), false);

    // An absolute key is not an escape: leading slashes are stripped, so it
    // lands inside the bucket instead of at the filesystem root.
    await bucket.put('/etc/passwd', new TextEncoder().encode('contained'));
    assert.equal(await new Response((await bucket.get('/etc/passwd'))!.body).text(), 'contained');
    assert.equal(fs.existsSync(path.join(dir, 'etc', 'passwd')), true);
  } finally {
    await cleanup();
  }
});

test('resolveObjectPath keeps leading slashes inside the bucket', () => {
  const root = path.resolve(os.tmpdir(), 'nw-root');
  assert.equal(resolveObjectPath(root, '/cipher/att'), path.join(root, 'cipher', 'att'));
  assert.throws(() => resolveObjectPath(root, '../x'), /Invalid object key/);
});

test('read errors are classified as missing vs fatal', () => {
  assert.equal(classifyReadError(Object.assign(new Error('nope'), { code: 'ENOENT' })), 'missing');
  assert.equal(classifyReadError(Object.assign(new Error('not a dir'), { code: 'ENOTDIR' })), 'missing');
  // A broken or unreachable mount must not be reported as "deleted".
  assert.equal(classifyReadError(Object.assign(new Error('io'), { code: 'EIO' })), 'fatal');
  assert.equal(classifyReadError(Object.assign(new Error('perm'), { code: 'EACCES' })), 'fatal');
  assert.equal(classifyReadError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 'fatal');
  assert.equal(classifyReadError(Object.assign(new Error('not connected'), { code: 'ENOTCONN' })), 'fatal');
  assert.equal(classifyReadError(new Error('unknown')), 'fatal');
});

// ---------------------------------------------------------------------------
// Streaming writes
//
// The upload path hands over a ReadableStream (the request body). Buffering it
// to learn the length put a whole attachment in memory — 100 MB per upload on a
// 0.5 GB FC instance. These tests pin the streaming behaviour and the marker
// that replaces the length-first trick.
// ---------------------------------------------------------------------------

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test('a streamed upload is written whole and reports the real size', async () => {
  const { dir, cleanup } = await tempBucket();
  try {
    const bucket = createFsR2(dir);
    const chunk = new Uint8Array(64 * 1024).fill(7);
    const chunks = Array.from({ length: 32 }, () => chunk); // 2 MB
    await bucket.put('cipher/big', streamOf(chunks), { httpMetadata: { contentType: 'video/mp4' } });

    const object = await bucket.get('cipher/big');
    assert.ok(object);
    assert.equal(object!.size, 2 * 1024 * 1024);
    const round = new Uint8Array(await new Response(object!.body).arrayBuffer());
    assert.equal(round.byteLength, 2 * 1024 * 1024);
    assert.equal(round[0], 7);
    assert.equal(round[round.byteLength - 1], 7);

    // The sidecar carries the size that was counted while streaming.
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'cipher', 'big.meta.json'), 'utf8'));
    assert.equal(meta.size, 2 * 1024 * 1024);
    assert.equal(meta.incomplete, undefined);
  } finally {
    await cleanup();
  }
});

test('a stream that dies mid-upload leaves nothing servable', async () => {
  const { dir, cleanup } = await tempBucket();
  try {
    const bucket = createFsR2(dir);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled <= 2) controller.enqueue(new Uint8Array(1024).fill(1));
        else controller.error(new Error('client went away'));
      },
    });

    await assert.rejects(() => bucket.put('cipher/broken', body), /client went away/);
    assert.equal(await bucket.get('cipher/broken'), null);
    // The partial file and its marker are cleaned up, so a retry starts fresh.
    assert.equal(fs.existsSync(path.join(dir, 'cipher', 'broken')), false);
    assert.equal(fs.existsSync(path.join(dir, 'cipher', 'broken.meta.json')), false);
  } finally {
    await cleanup();
  }
});

test('an object still marked incomplete is never served, even if the size matches', async () => {
  const { dir, cleanup } = await tempBucket();
  try {
    const bucket = createFsR2(dir);
    await fsp.mkdir(path.join(dir, 'cipher'), { recursive: true });
    // This is what a crash between "marker written" and "bytes written" (or a
    // recycled instance) looks like: bytes on disk, upload never finished.
    await fsp.writeFile(path.join(dir, 'cipher', 'att'), new TextEncoder().encode('0123456789'));
    await fsp.writeFile(
      path.join(dir, 'cipher', 'att.meta.json'),
      JSON.stringify({ contentType: 'application/octet-stream', incomplete: true })
    );

    assert.equal(await bucket.get('cipher/att'), null);

    // Re-uploading overwrites the marker and makes the object readable again.
    await bucket.put('cipher/att', new TextEncoder().encode('done'));
    const object = await bucket.get('cipher/att');
    assert.ok(object);
    assert.equal(await new Response(object!.body).text(), 'done');
  } finally {
    await cleanup();
  }
});

test('an object without a sidecar is still served (files restored by copy)', async () => {
  const { dir, cleanup } = await tempBucket();
  try {
    const bucket = createFsR2(dir);
    await fsp.mkdir(path.join(dir, 'cipher'), { recursive: true });
    // Restoring a bucket by copying files only is a normal migration step; a
    // missing sidecar must not turn the whole archive into 404s.
    await fsp.writeFile(path.join(dir, 'cipher', 'att'), new TextEncoder().encode('legacy'));

    const object = await bucket.get('cipher/att');
    assert.ok(object);
    assert.equal(await new Response(object!.body).text(), 'legacy');
    assert.equal(object!.httpMetadata.contentType, 'application/octet-stream');
  } finally {
    await cleanup();
  }
});

test('a Node Readable body is accepted as well as a web stream', async () => {
  const { dir, cleanup } = await tempBucket();
  try {
    const bucket = createFsR2(dir);
    const { Readable } = await import('node:stream');
    await bucket.put('cipher/node-stream', Readable.from([Buffer.from('a'), Buffer.from('b')]));

    const object = await bucket.get('cipher/node-stream');
    assert.ok(object);
    assert.equal(object!.size, 2);
    assert.equal(await new Response(object!.body).text(), 'ab');
  } finally {
    await cleanup();
  }
});

