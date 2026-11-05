// Startup probe for the attachment disk.
//
// When ATTACHMENTS_DIR points at a bucket mount (ossfs / cosfs / rclone), the
// failure mode that hurts is not a crash: it is the mount not being there yet.
// The directory still exists (it is part of the image, or the app creates it),
// so every write silently lands on the container's own disk, the UI keeps saying
// uploads succeeded, and the files are gone after the next redeploy.
//
// This probe makes that state visible instead of silent: it reports whether the
// path is a separate mount, whether it accepts writes, and lets the caller wait
// for a mount that comes up a second after the process starts.

import fsp from 'node:fs/promises';
import path from 'node:path';

export type AttachmentsStatus = 'ok' | 'missing' | 'not-mounted' | 'unwritable';

export interface AttachmentsProbeResult {
  dir: string;
  status: AttachmentsStatus;
  detail?: string;
}

export interface AttachmentsProbeOptions {
  /** Warn when the directory shares a device with its parent (i.e. not a mount). */
  expectMount?: boolean;
  /** Number of probes before giving up; only "missing" is retried. */
  attempts?: number;
  delayMs?: number;
}

const PROBE_FILE = '.nodewarden-write-probe';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when `dir` lives on a different device than its parent, which is what a
 * bind mount or a FUSE mount looks like from `stat`. Returns null when the
 * platform does not report a usable device id.
 */
async function isSeparateMount(dir: string): Promise<boolean | null> {
  try {
    const [self, parent] = await Promise.all([fsp.stat(dir), fsp.stat(path.dirname(dir))]);
    if (!Number.isFinite(self.dev) || !Number.isFinite(parent.dev)) return null;
    return self.dev !== parent.dev;
  } catch {
    return null;
  }
}

async function probeOnce(dir: string, expectMount: boolean): Promise<AttachmentsProbeResult> {
  try {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) {
      return { dir, status: 'missing', detail: 'path exists but is not a directory' };
    }
    if (expectMount) {
      const separate = await isSeparateMount(dir);
      if (separate === false) {
        return {
          dir,
          status: 'not-mounted',
          detail: 'the directory is on the container filesystem, not on a mount',
        };
      }
    }
    const file = path.join(dir, `${PROBE_FILE}-${process.pid}`);
    const payload = `nodewarden ${Date.now()}`;
    await fsp.writeFile(file, payload);
    const echo = await fsp.readFile(file, 'utf8');
    await fsp.rm(file, { force: true });
    if (echo !== payload) {
      return { dir, status: 'unwritable', detail: 'wrote a probe file and read back different bytes' };
    }
    return { dir, status: 'ok' };
  } catch (error) {
    const code = String((error as { code?: string })?.code ?? '');
    if (code === 'ENOENT') return { dir, status: 'missing', detail: 'directory does not exist' };
    return { dir, status: 'unwritable', detail: messageOf(error) };
  }
}

/**
 * Probe the attachment disk, optionally waiting for a mount to appear.
 *
 * Only "missing" is retried: a directory that exists but is not a mount will not
 * become one by waiting, and neither will a read-only one.
 */
export async function probeAttachmentsDir(
  dir: string,
  options: AttachmentsProbeOptions = {}
): Promise<AttachmentsProbeResult> {
  const attempts = Math.max(1, options.attempts ?? 1);
  const delayMs = Math.max(0, options.delayMs ?? 0);
  let result = await probeOnce(dir, options.expectMount !== false);
  for (let attempt = 1; attempt < attempts && result.status === 'missing'; attempt += 1) {
    if (delayMs > 0) await sleep(delayMs);
    result = await probeOnce(dir, options.expectMount !== false);
  }
  return result;
}

/** One-line operator guidance for a probe result; null when everything is fine. */
export function describeAttachmentsProblem(result: AttachmentsProbeResult): string | null {
  switch (result.status) {
    case 'ok':
      return null;
    case 'missing':
      return (
        `ATTACHMENTS_DIR=${result.dir} is unusable (${result.detail || 'missing'}). ` +
        'Attachments will be stored on the container filesystem and lost on the next redeploy — ' +
        'mount the bucket (ossfs/cosfs/rclone) before starting the app, or unset ATTACHMENTS_DIR.'
      );
    case 'not-mounted':
      return (
        `ATTACHMENTS_DIR=${result.dir} exists but is not a mount point (${result.detail}). ` +
        'Either the object-store mount failed to come up, or ATTACHMENTS_DIR points at a plain ' +
        'directory: everything uploaded now lives on the container disk and disappears on redeploy.'
      );
    case 'unwritable':
      return (
        `ATTACHMENTS_DIR=${result.dir} rejected a write (${result.detail}). ` +
        'Check the mount permissions (ossfs/cosfs mounts are often read-only after a credential error).'
      );
    default:
      return `ATTACHMENTS_DIR=${result.dir} reported an unknown state.`;
  }
}
