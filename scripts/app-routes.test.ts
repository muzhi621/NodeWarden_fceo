// Contract test: every SPA route declared in AppMainRoutes must also appear in
// App.tsx's APP_ROUTE_PATHS allowlist.
//
// Why this exists: App.tsx decides whether a path is a "known app route" before
// the router runs, and renders a full-page 404 for anything else. Adding a
// <Route> without adding it to the allowlist therefore produces a route that
// exists in the router but is unreachable — exactly what happened to
// /admin/database, which 404'd for every admin.
//
// Run: npx tsx --test scripts/app-routes.test.ts

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(here, '../webapp/src/App.tsx'), 'utf8');
const routesSource = fs.readFileSync(path.join(here, '../webapp/src/components/AppMainRoutes.tsx'), 'utf8');

/** Resolve `const NAME = '/literal'` and `const NAME = ['/a', '/b'] as const`. */
function resolveArrayItem(token: string): string[] {
  if (token.startsWith("'") || token.startsWith('"')) {
    const literal = token.match(/^['"]([^'"]+)['"]$/);
    return literal ? [literal[1]] : [];
  }
  if (token.startsWith('...')) {
    const name = token.slice(3).trim();
    const arrayMatch = appSource.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`));
    return arrayMatch ? [...arrayMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]) : [];
  }
  const constMatch = appSource.match(new RegExp(`const ${token} = ['"]([^'"]+)['"];`));
  return constMatch ? [constMatch[1]] : [];
}

function readAllowlist(): Set<string> {
  const block = appSource.match(/const APP_ROUTE_PATHS = \[([\s\S]*?)\] as const;/);
  assert.ok(block, 'APP_ROUTE_PATHS not found in App.tsx');
  const entries = new Set<string>();
  for (const rawLine of block[1].split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim().replace(/,$/, '');
    if (!line) continue;
    for (const item of resolveArrayItem(line)) entries.add(item);
  }
  return entries;
}

function readDeclaredRoutes(): string[] {
  return [...routesSource.matchAll(/path="(\/[^"]*)"/g)].map((m) => m[1]);
}

test('every route declared in AppMainRoutes is in the App.tsx allowlist', () => {
  const allowlist = readAllowlist();
  const declared = readDeclaredRoutes();
  assert.ok(declared.length >= 10, `expected to find the static routes, got ${declared.length}`);
  const missing = declared.filter((route) => !allowlist.has(route));
  assert.deepEqual(
    missing,
    [],
    `routes rendered by the router but missing from APP_ROUTE_PATHS (they would 404): ${missing.join(', ')}`
  );
});

test('the admin database settings route is reachable', () => {
  const allowlist = readAllowlist();
  assert.ok(allowlist.has('/admin/database'), '/admin/database must be an allowed app route');
  assert.ok(readDeclaredRoutes().includes('/admin/database'), 'AppMainRoutes must declare /admin/database');
});
