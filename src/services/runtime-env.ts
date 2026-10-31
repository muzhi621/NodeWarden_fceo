// Node-runtime environment access without pulling `node` typings into the
// Workers build (src/ is compiled without @types/node, and importing
// `process`/`node:fs` statically breaks the Worker bundle).
//
// On Cloudflare Workers there is no `process`, so every reader returns
// undefined and the defaults apply.

interface NodeProcessLike {
  env?: Record<string, string | undefined>;
}

function nodeProcess(): NodeProcessLike | undefined {
  return (globalThis as { process?: NodeProcessLike }).process;
}

export function readEnv(name: string): string | undefined {
  const value = nodeProcess()?.env?.[name];
  return value === undefined ? undefined : value;
}

const TRUTHY_FLAGS = new Set(['1', 'true', 'yes', 'on']);
const FALSY_FLAGS = new Set(['0', 'false', 'no', 'off', '']);

/**
 * Boolean env flag.
 *
 * Accepts the spellings people actually type (`1`, `true`, `yes`, `on`); an
 * explicit false value wins over the default, and anything unrecognised falls
 * back to it. Checking only `=== '1'` made `DB_SSL_INSECURE=true` silently do
 * nothing, which for a TLS switch is the wrong way to fail.
 */
export function readEnvFlag(name: string, defaultValue = false): boolean {
  const raw = readEnv(name);
  if (raw === undefined) return defaultValue;
  const value = raw.trim().toLowerCase();
  if (TRUTHY_FLAGS.has(value)) return true;
  if (FALSY_FLAGS.has(value)) return false;
  return defaultValue;
}

/** Positive integer env value; falls back when unset, empty or not a number. */
export function readEnvInt(name: string, defaultValue: number): number {
  const raw = readEnv(name);
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultValue;
}

/** Read a file path from env and return its contents, or undefined when unset/unreadable. */
export async function readEnvFile(name: string, label: string): Promise<string | undefined> {
  const filePath = readEnv(name);
  if (!filePath) return undefined;
  try {
    // Non-literal specifier: keeps `node:fs` out of the Workers bundle and out
    // of the type graph.
    const fsName = 'node:fs';
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(path: string, encoding: string): string };
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(`[runtime-env] failed to read ${label} (${filePath}):`, error);
    return undefined;
  }
}
