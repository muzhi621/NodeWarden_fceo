// The attachment path as the app actually uses it: blob-store -> the Node
// runtime's filesystem bucket. This is the wiring behind "point DATA_DIR /
// ATTACHMENTS_DIR at a mounted OSS/COS bucket".

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Must be set before the runtime is configured for the first time (lazily, on
// the first buildNodeEnv() call). A temp dir keeps the repository clean.
const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-runtime-'));
const attachmentsDir = path.join(dataDir, 'attachments');
process.env.DATA_DIR = dataDir;
process.env.ATTACHMENTS_DIR = attachmentsDir;

const { buildNodeEnv } = await import('../server/node-runtime');
const { putBlobObject, getBlobObject, deleteBlobObject, getBlobStorageKind, getAttachmentObjectKey, getSendFileObjectKey } =
  await import('../src/services/blob-store');

test('the Node runtime exposes a filesystem-backed attachment bucket', () => {
  const env = buildNodeEnv();
  assert.equal(getBlobStorageKind(env), 'r2');
  assert.ok(env.ATTACHMENTS, 'ATTACHMENTS binding should be present');
});

test('an attachment survives a round trip through blob-store', async () => {
  const env = buildNodeEnv();
  const key = getAttachmentObjectKey('cipher-aaa', 'attachment-bbb');
  const bytes = new TextEncoder().encode('sealed attachment ciphertext');

  await putBlobObject(env, key, bytes, {
    size: bytes.byteLength,
    contentType: 'application/octet-stream',
    customMetadata: { cipherId: 'cipher-aaa', attachmentId: 'attachment-bbb' },
  });

  // On disk, in the documented layout.
  assert.equal(key, 'cipher-aaa/attachment-bbb');
  const stat = await fsp.stat(path.join(attachmentsDir, key));
  assert.equal(stat.size, bytes.byteLength);

  const object = await getBlobObject(env, key);
  assert.ok(object);
  assert.equal(object!.size, bytes.byteLength);
  assert.equal(object!.contentType, 'application/octet-stream');
  assert.equal(await new Response(object!.body).text(), 'sealed attachment ciphertext');

  await deleteBlobObject(env, key);
  assert.equal(await getBlobObject(env, key), null);
});

test('send files share the same bucket under their own prefix', async () => {
  const env = buildNodeEnv();
  const key = getSendFileObjectKey('send-1', 'file-1');
  assert.equal(key, 'sends/send-1/file-1');

  const bytes = new TextEncoder().encode('send payload');
  await putBlobObject(env, key, bytes, { size: bytes.byteLength, contentType: 'text/plain' });
  const object = await getBlobObject(env, key);
  assert.equal(await new Response(object!.body).text(), 'send payload');
  assert.equal(object!.contentType, 'text/plain');
});

test('a Stream body is stored with its real length', async () => {
  const env = buildNodeEnv();
  const key = getAttachmentObjectKey('cipher-stream', 'attachment-1');
  const stream = new Response(new TextEncoder().encode('streamed')).body!;

  await putBlobObject(env, key, stream, { size: 8 });
  const object = await getBlobObject(env, key);
  assert.equal(object!.size, 8);
  assert.equal(await new Response(object!.body).text(), 'streamed');
});
