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

export function readEnvFlag(name: string): boolean {
  return readEnv(name) === '1';
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
