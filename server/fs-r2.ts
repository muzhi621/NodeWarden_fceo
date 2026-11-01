// Filesystem-backed R2-compatible bucket for the Node runtime.
//
// This is the adapter behind "mount an object store as the attachment disk"
// (ossfs / cosfs / rclone, or a NAS / Docker volume). It is not a real R2: it
// stores objects as files plus a `<key>.meta.json` sidecar, which is what makes
// the two-object-per-attachment behaviour in DEPLOY.md true.
//
// Three properties matter more than speed here, because object-store mounts are
// network filesystems and can fail in the middle of a write:
//
//   1. A truncated upload must never be served as a valid attachment. The
//      sidecar is written *before* the bytes with an `incomplete` flag, and
//      rewritten at the end with the final size, so a reader that finds either
//      marker refuses the file instead of handing a corrupt blob to the client.
//   2. Uploads stream straight to the file. Buffering the body to learn its
//      length first cost the whole attachment in memory (100 MB per upload on a
//      0.5 GB FC instance), which is exactly what the `incomplete` marker above
//      makes unnecessary.
//   3. "File is gone" and "the mount is broken" are different answers. Only
//      ENOENT/ENOTDIR become `null` (a 404 upstream); an I/O or permission error
//      is rethrown, so the API answers 5xx instead of telling the user their
//      attachment no longer exists.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Mirrors the R2 `put` options the rest of the app passes (subset). */
export interface FsR2PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

/** Shape of the sidecar `<key>.meta.json`. */
interface FsR2Sidecar {
  contentType?: string;
  customMetadata?: Record<string, string> | null;
  /** Final object size; absent while an upload is in flight. */
  size?: number;
  /** Set only between "upload started" and "upload finished". */
  incomplete?: boolean;
}

export interface FsR2Object {
  body: ReadableStream;
  size: number;
  httpMetadata: { contentType: string };
  customMetadata: Record<string, string>;
}

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** 'missing' is a 404; 'fatal' means the storage itself is unhappy (5xx). */
export type ReadErrorKind = 'missing' | 'fatal';

export function classifyReadError(error: unknown): ReadErrorKind {
  const code = String((error as { code?: string })?.code ?? '');
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
  return 'fatal';
}

/**
 * Resolve an object key inside the bucket root.
 *
 * Containment is checked with `path.relative`: a plain startsWith() also accepts
 * sibling directories such as "/data/attachments-evil".
 */
export function resolveObjectPath(attachmentsDir: string, key: string): string {
  const normalized = String(key || '').replace(/^[/\\]+/, '');
  const full = path.resolve(attachmentsDir, normalized);
  const rel = path.relative(attachmentsDir, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Invalid object key');
  return full;
}

function sidecarPath(full: string): string {
  return `${full}.meta.json`;
}

async function writeSidecar(full: string, meta: FsR2Sidecar): Promise<void> {
  await fsp.writeFile(sidecarPath(full), JSON.stringify(meta));
}

/** Best-effort removal of a half-written object; never masks the original error. */
async function discard(full: string): Promise<void> {
  await Promise.all([
    fsp.rm(full, { force: true }).catch((error) => {
      console.warn('[attachments] could not remove a partial object:', full, error);
    }),
    fsp.rm(sidecarPath(full), { force: true }).catch((error) => {
      console.warn('[attachments] could not remove a partial sidecar:', sidecarPath(full), error);
    }),
  ]);
}

function toNodeReadable(value: unknown): Readable | null {
  if (value instanceof Readable) return value;
  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) {
    return Readable.fromWeb(value as Parameters<typeof Readable.fromWeb>[0]);
  }
  return null;
}

function toBytes(value: unknown): Uint8Array | null {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/**
 * Write the object body and return the number of bytes that actually landed.
 *
 * Streams are piped with backpressure to a file stream, so peak memory stays at
 * the high-water mark of the stream (64 KB) instead of the object size.
 */
async function writeBody(full: string, value: unknown): Promise<number> {
  const bytes = toBytes(value);
  if (bytes) {
    await fsp.writeFile(full, bytes);
    return bytes.byteLength;
  }

  const source = toNodeReadable(value);
  if (!source) {
    // Unknown body type: store an empty object rather than a file of garbage.
    await fsp.writeFile(full, new Uint8Array(0));
    return 0;
  }

  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(source, counter, fs.createWriteStream(full));
  return size;
}

export interface FsR2Bucket {
  put(key: string, value: unknown, options?: FsR2PutOptions): Promise<void>;
  get(key: string): Promise<FsR2Object | null>;
  delete(key: string): Promise<void>;
}

export function createFsR2(attachmentsDir: string): FsR2Bucket {
  return {
    async put(key, value, options) {
      const full = resolveObjectPath(attachmentsDir, key);
      const contentType = options?.httpMetadata?.contentType || DEFAULT_CONTENT_TYPE;
      const customMetadata = options?.customMetadata || {};
      await fsp.mkdir(path.dirname(full), { recursive: true });

      // Claim the key before the bytes land. If the process is recycled or the
      // mount drops mid-write, this marker stays behind and get() refuses the
      // file — the only way to tell "half an attachment" from "a whole one"
      // without buffering it in memory to measure it.
      await writeSidecar(full, { contentType, customMetadata, incomplete: true });

      try {
        const size = await writeBody(full, value);
        await writeSidecar(full, { contentType, customMetadata, size });
      } catch (error) {
        await discard(full);
        throw error;
      }
    },

    async get(key) {
      const full = resolveObjectPath(attachmentsDir, key);
      let stat: Awaited<ReturnType<typeof fsp.stat>>;
      try {
        stat = await fsp.stat(full);
      } catch (error) {
        if (classifyReadError(error) === 'missing') return null;
        console.error('[attachments] stat failed; the attachment disk may be unavailable:', error);
        throw error;
      }

      let meta: FsR2Sidecar = {};
      try {
        meta = JSON.parse(await fsp.readFile(sidecarPath(full), 'utf8')) as FsR2Sidecar;
      } catch (error) {
        if (classifyReadError(error) === 'fatal') {
          console.warn('[attachments] metadata for', key, 'is unreadable; continuing without it:', error);
        }
        // A missing sidecar means either an object written before this adapter
        // tracked sizes, or one restored by copying files. Serve it: the data
        // was written whole by whoever produced it.
      }

      if (meta.incomplete) {
        console.warn(`[attachments] refusing an unfinished object "${key}": the upload never completed`);
        return null;
      }

      // A size mismatch means the upload never completed (client aborted, the
      // instance was recycled, the mount dropped). Serving it would hand the
      // client a corrupt attachment that decrypts to garbage.
      if (typeof meta.size === 'number' && Number.isFinite(meta.size) && meta.size !== stat.size) {
        console.warn(
          `[attachments] refusing a truncated object "${key}": expected ${meta.size} bytes, found ${stat.size}`
        );
        return null;
      }

      // Stream, don't slurp: attachments can be large and FC instances are small
      // (0.5 GB). Reading the file into a Buffer first doubled peak memory.
      const stream = fs.createReadStream(full);
      return {
        body: Readable.toWeb(stream) as unknown as ReadableStream,
        size: stat.size,
        httpMetadata: { contentType: meta.contentType || DEFAULT_CONTENT_TYPE },
        customMetadata: (meta.customMetadata as Record<string, string>) || {},
      };
    },

    async delete(key) {
      const full = resolveObjectPath(attachmentsDir, key);
      await fsp.rm(full, { force: true });
      await fsp.rm(sidecarPath(full), { force: true });
    },
  };
}
