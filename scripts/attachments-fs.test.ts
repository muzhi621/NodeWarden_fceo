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
