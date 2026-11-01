// End-to-end tests for the S3-compatible backup destination (used for R2,
// MinIO, AWS S3 — and, via their S3-compatible API, Alibaba Cloud OSS and
// Tencent Cloud COS).
//
// The peer is scripts/s3-test-server.ts, which *verifies* the AWS Signature V4
// on every request with its own implementation. That is the point: it catches
// canonicalization mistakes (path encoding, query encoding, sort order) that a
// mock `fetch` would happily accept.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRemoteBackupTransferSession,
  deleteRemoteBackupFile,
  downloadRemoteBackupFile,
  listRemoteBackupEntries,
  pruneRemoteBackupArchives,
  remoteBackupFileExists,
  uploadBackupArchive,
  uploadRemoteBackupFile,
} from '../src/services/backup-uploader';
import type { BackupDestinationRecord } from '../src/services/backup-config';
import { startS3Server, type S3TestServer } from './s3-test-server';

const ACCESS_KEY = 'AKIDEXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

// The endpoint policy refuses loopback unless the operator opts in; the test
// server listens on 127.0.0.1, so opt in for this process only.
process.env.BACKUP_ENDPOINT_ALLOWLIST = '127.0.0.1';

function destination(endpoint: string, overrides: Record<string, unknown> = {}): BackupDestinationRecord {
  return {
    id: 'dest-1',
    name: 'test',
    type: 's3',
    includeAttachments: true,
    destination: {
      endpoint,
      bucket: 'nw-bucket',
      addressingStyle: 'path-style',
      region: 'oss-cn-hangzhou',
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      rootPath: 'nodewarden',
      ...overrides,
    },
    schedule: { enabled: false, timezone: 'UTC' } as never,
    runtime: {} as never,
  };
}

async function withServer(
  run: (server: S3TestServer) => Promise<void>,
  options: { seed?: Record<string, string>; pageSize?: number } = {}
): Promise<void> {
  const server = await startS3Server({
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    region: 'oss-cn-hangzhou',
    seed: options.seed,
    pageSize: options.pageSize,
  });
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

test('upload, download, stat and delete round-trip against a signature-verifying server', async () => {
  await withServer(async (server) => {
    const dest = destination(server.endpoint);
    const payload = new TextEncoder().encode('PK\u0003\u0004 fake backup archive');

    const result = await uploadBackupArchive(dest, payload, 'backup-2026-11-01.zip');
    assert.equal(result.provider, 's3');
    assert.equal(result.remotePath, 'nodewarden/backup-2026-11-01.zip');

    const stored = server.objects.get('nodewarden/backup-2026-11-01.zip');
    assert.ok(stored, 'the object should exist on the server');
    assert.deepEqual(new Uint8Array(stored!.body), payload);
    assert.equal(stored!.contentType, 'application/zip');

    assert.equal(await remoteBackupFileExists(dest, 'backup-2026-11-01.zip'), true);

    const downloaded = await downloadRemoteBackupFile(dest, 'backup-2026-11-01.zip');
    assert.deepEqual(downloaded.bytes, payload);
    assert.equal(downloaded.fileName, 'backup-2026-11-01.zip');
    assert.equal(downloaded.contentType, 'application/zip');

    await deleteRemoteBackupFile(dest, 'backup-2026-11-01.zip');
    assert.equal(server.objects.has('nodewarden/backup-2026-11-01.zip'), false);
  });
});

test('a missing object is reported as false, not as an error', async () => {
  await withServer(async (server) => {
    const dest = destination(server.endpoint);
    assert.equal(await remoteBackupFileExists(dest, 'nope.zip'), false);
  });
});

test('listing works when the root path and object names contain spaces and non-ASCII', async () => {
  // A prefix with a space is the classic SigV4 trap: URLSearchParams encodes it
  // as '+', which does not match the '%20' the canonical query must contain.
  await withServer(
    async (server) => {
      const dest = destination(server.endpoint, { rootPath: '我的 备份' });
      const session = createRemoteBackupTransferSession(dest);
      await session.putFile('每日 备份.zip', new TextEncoder().encode('x'));

      const listing = await listRemoteBackupEntries(dest, '');
      const names = listing.items.map((item) => item.name);
      assert.deepEqual(names, ['每日 备份.zip']);
      assert.equal(listing.items[0].size, 1);
    },
    { seed: { '我的 备份/每日 备份.zip': 'x' } }
  );
});

test('keys containing XML metacharacters survive the listing', async () => {
  // Without encoding-type=url the response carries a raw '&' or '<' inside
  // <Key>; a tag-based parser then truncates the name at that point, so the
  // file is listed under a name that does not exist and cannot be downloaded
  // or deleted. The listing is requested with encoding-type=url and decoded.
  await withServer(
    async (server) => {
      const dest = destination(server.endpoint);
      const listing = await listRemoteBackupEntries(dest, '');
      const names = listing.items.map((item) => item.name).sort();
      assert.deepEqual(names, ['a&b<c>.zip', 'rock&roll.zip']);

      const downloaded = await downloadRemoteBackupFile(dest, 'a&b<c>.zip');
      assert.equal(new TextDecoder().decode(downloaded.bytes), 'x');
    },
    { seed: { 'nodewarden/a&b<c>.zip': 'x', 'nodewarden/rock&roll.zip': 'y' } }
  );
});

test('listing follows continuation tokens', async () => {
  await withServer(
    async (server) => {
      const dest = destination(server.endpoint);
      const listing = await listRemoteBackupEntries(dest, '');
      const names = listing.items.map((item) => item.name).sort();
      assert.deepEqual(names, ['a.zip', 'b.zip', 'c.zip']);
    },
    {
      pageSize: 2,
      seed: {
        'nodewarden/a.zip': 'a',
        'nodewarden/b.zip': 'b',
        'nodewarden/c.zip': 'c',
      },
    }
  );
});

test('sub-prefixes are returned as directories, not flattened into files', async () => {
  await withServer(
    async (server) => {
      const dest = destination(server.endpoint);
      const listing = await listRemoteBackupEntries(dest, '');
      const entry = listing.items.find((item) => item.name === 'attachments');
      assert.ok(entry, 'attachments/ should be listed');
      assert.equal(entry!.isDirectory, true);
    },
    { seed: { 'nodewarden/attachments/1/2': 'binary', 'nodewarden/root.zip': 'z' } }
  );
});

test('retention pruning keeps the newest archives and deletes the rest', async () => {
  await withServer(
    async (server) => {
      const dest = destination(server.endpoint);
      // Every seeded object carries the same Last-Modified, so the tie is broken
      // by name (descending) — the newest-first contract of compareBackupItemsByRecency.
      const deleted = await pruneRemoteBackupArchives(dest, 2);
      assert.equal(deleted, 1);
      const remaining = [...server.objects.keys()].filter((key) => key.startsWith('nodewarden/')).sort();
      // Equal timestamps: the tie-break keeps the alphabetically-later names.
      // The non-archive is never pruned.
      assert.deepEqual(remaining, ['nodewarden/b.zip', 'nodewarden/c.zip', 'nodewarden/notes.txt']);
    },
    {
      seed: {
        'nodewarden/a.zip': 'a',
        'nodewarden/b.zip': 'b',
        'nodewarden/c.zip': 'c',
        'nodewarden/notes.txt': 'not an archive',
      },
    }
  );
});

test('a wrong secret surfaces the provider error instead of a bare status code', async () => {
  await withServer(async (server) => {
    const dest = destination(server.endpoint, { secretAccessKey: 'wrong-secret' });
    await assert.rejects(
      () => uploadBackupArchive(dest, new TextEncoder().encode('x'), 'backup.zip'),
      (error: Error) => {
        assert.match(error.message, /403/);
        assert.match(error.message, /SignatureDoesNotMatch/);
        return true;
      }
    );
  });
});

test('objects are addressed path-style under the configured bucket', async () => {
  await withServer(async (server) => {
    const dest = destination(server.endpoint);
    await uploadRemoteBackupFile(dest, 'sub/dir/file.bin', new Uint8Array([1, 2, 3]));
    const request = server.requests.find((entry) => entry.method === 'PUT');
    assert.ok(request);
    assert.equal(request!.url, '/nw-bucket/nodewarden/sub/dir/file.bin');
    assert.equal(server.objects.get('nodewarden/sub/dir/file.bin')?.body.byteLength, 3);
  });
});

test('Aliyun OSS rejects path-style addressing, so the client says so up front', async () => {
  const dest = destination('https://oss-cn-hangzhou.aliyuncs.com', {
    addressingStyle: 'path-style',
    bucket: 'my-bucket',
  });
  await assert.rejects(
    () => uploadBackupArchive(dest, new TextEncoder().encode('x'), 'backup.zip'),
    /virtual-hosted/i
  );
});
