// Filesystem-backed R2-compatible bucket for the Node runtime.
//
// This is the adapter behind "mount an object store as the attachment disk"
// (ossfs / cosfs / rclone, or a NAS / Docker volume). It is not a real R2: it
// stores objects as files plus a `<key>.meta.json` sidecar, which is what makes
// the two-object-per-attachment behaviour in DEPLOY.md true.
//
// Two properties matter more than speed here, because object-store mounts are
// network filesystems and can fail in the middle of a write:
//
//   1. A truncated upload must never be served as a valid attachment. The
//      sidecar carries the expected byte count and is written *before* the data,
//      so a reader that finds a short file refuses it instead of handing a
//      corrupt blob to the client.
//   2. "File is gone" and "the mount is broken" are different answers. Only
//      ENOENT/ENOTDIR become `null` (a 404 upstream); an I/O or permission error
//      is rethrown, so the API answers 5xx instead of telling the user their
//      attachment no longer exists.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

/** Mirrors the R2 `put` options the rest of the app passes (subset). */
export interface FsR2PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

/** Shape of the sidecar `<key>.meta.json`. */
interface FsR2Sidecar {
  contentType?: string;
  customMetadata?: Record<string, string> | null;
  /** Expected object size, used to detect a truncated write. */
  size?: number;
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

function toBytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === 'string') return Promise.resolve(new TextEncoder().encode(value));
  if (value instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return Promise.resolve(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (value instanceof ReadableStream) {
    // Buffered on purpose: the sidecar has to know the exact size before the
    // data lands. Streaming here would mean writing the size afterwards, which
    // reopens the truncated-file window this module exists to close.
    return new Response(value).arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return Promise.resolve(new Uint8Array(0));
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
      const bytes = await toBytes(value);
      await fsp.mkdir(path.dirname(full), { recursive: true });

      // Metadata first: if the process dies while the data is being written, the
      // sidecar is already there with the expected size and get() will reject
      // the partial file. The reverse order would leave a short file that looks
      // perfectly valid.
      const meta: Required<Pick<FsR2Sidecar, 'contentType' | 'customMetadata' | 'size'>> = {
        contentType: options?.httpMetadata?.contentType || DEFAULT_CONTENT_TYPE,
        customMetadata: options?.customMetadata || {},
        size: bytes.byteLength,
      };
      await fsp.writeFile(`${full}.meta.json`, JSON.stringify(meta));
      await fsp.writeFile(full, bytes);
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
        meta = JSON.parse(await fsp.readFile(`${full}.meta.json`, 'utf8')) as FsR2Sidecar;
      } catch (error) {
        if (classifyReadError(error) === 'fatal') {
          console.warn('[attachments] metadata for', key, 'is unreadable; continuing without it:', error);
        }
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
      await fsp.rm(`${full}.meta.json`, { force: true });
    },
  };
}
