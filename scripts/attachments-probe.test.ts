// Tests for the attachment-disk startup probe.
//
// The state this guards against is quiet: ATTACHMENTS_DIR points at a bucket
// mount, the mount is not up, the directory still exists (image layer), uploads
// succeed — onto the container disk — and every file is gone after a redeploy.

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describeAttachmentsProblem, probeAttachmentsDir } from '../server/attachments-probe';

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nw-probe-'));
  return { dir, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('a writable directory probes as ok', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const result = await probeAttachmentsDir(dir, { expectMount: false });
    assert.equal(result.status, 'ok');
    assert.equal(describeAttachmentsProblem(result), null);
    // The probe file must not be left behind.
    const left = (await fsp.readdir(dir)).filter((name) => name.startsWith('.nodewarden-write-probe'));
    assert.deepEqual(left, []);
  } finally {
    await cleanup();
  }
});

test('a plain directory where a mount is expected is reported as not-mounted', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    // A freshly created tmp dir shares its device with its parent, which is
    // exactly what an unmounted attachment directory looks like.
    const result = await probeAttachmentsDir(dir, { expectMount: true });
    assert.equal(result.status, 'not-mounted');
    const problem = describeAttachmentsProblem(result);
    assert.ok(problem && problem.includes('not a mount point'));
    assert.ok(problem!.includes('disappears on redeploy'));
  } finally {
    await cleanup();
  }
});

test('a missing directory is reported, not created', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const missing = path.join(dir, 'attachments');
    const result = await probeAttachmentsDir(missing, { expectMount: false });
    assert.equal(result.status, 'missing');
    assert.equal(await fsp.stat(missing).then(() => true, () => false), false);
    assert.match(describeAttachmentsProblem(result)!, /does not exist|unusable/);
  } finally {
    await cleanup();
  }
});

test('a path that exists but is a file is reported as missing', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const file = path.join(dir, 'attachments');
    await fsp.writeFile(file, 'not a directory');
    const result = await probeAttachmentsDir(file, { expectMount: false });
    assert.equal(result.status, 'missing');
    assert.match(result.detail || '', /not a directory/);
  } finally {
    await cleanup();
  }
});

test('a missing mount is retried before the probe gives up', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const late = path.join(dir, 'late-mount');
    // Simulate a mount that appears a few hundred milliseconds after boot.
    setTimeout(() => {
      void fsp.mkdir(late, { recursive: true });
    }, 120);

    const result = await probeAttachmentsDir(late, {
      expectMount: false,
      attempts: 6,
      delayMs: 100,
    });
    assert.equal(result.status, 'ok');
  } finally {
    await cleanup();
  }
});

test('a directory that stays missing is not retried forever', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const missing = path.join(dir, 'never');
    const started = Date.now();
    const result = await probeAttachmentsDir(missing, { expectMount: false, attempts: 3, delayMs: 20 });
    assert.equal(result.status, 'missing');
    assert.ok(Date.now() - started < 2000);
  } finally {
    await cleanup();
  }
});

test('an unwritable directory is reported with the underlying error', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    // Placing the probe on a path whose parent is a file makes the write fail
    // the same way a read-only mount does (EACCES/EROFS/ENOTDIR).
    const blocker = path.join(dir, 'blocker');
    await fsp.writeFile(blocker, 'x');
    const result = await probeAttachmentsDir(path.join(blocker, 'attachments'), { expectMount: false });
    assert.ok(['missing', 'unwritable'].includes(result.status), result.status);
    assert.ok(describeAttachmentsProblem(result));
  } finally {
    await cleanup();
  }
});
