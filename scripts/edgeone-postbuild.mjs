#!/usr/bin/env node
// Post-build step for Tencent EdgeOne Pages: emit dist/404.html.
//
// Why: the web vault is a history-routed SPA (wouter), so a refresh on
// /vault, /admin/database… asks the host for a path that has no file behind it.
// EdgeOne's `edgeone.json → rewrites` explicitly does NOT support SPA route
// fallback (and a `/*` → `/index.html` rule would also swallow /assets/*), and
// EdgeOne Pages ignores Cloudflare-style `dist/_redirects`.
//
// Shipped behaviour of EdgeOne Pages static hosting is to fall back to
// index.html for unmatched paths, which already works. This copy is the safety
// net: if a deployment answers with the custom 404 page instead, the SPA still
// boots and the router takes over. index.html references only absolute URLs
// (`/assets/…`, `/favicon.ico`), so a copy at any depth resolves correctly.
//
// Runs on the platform as part of `npm run build:edgeone:pages`, and locally via
// `npm run build:edgeone`; it has no dependencies so the build image needs
// nothing beyond Node.

import { copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');
const indexPath = path.join(distDir, 'index.html');
const notFoundPath = path.join(distDir, '404.html');

try {
  await stat(indexPath);
} catch {
  console.error('✗ dist/index.html is missing — run: npm run build');
  process.exit(1);
}

await copyFile(indexPath, notFoundPath);
console.log('✓ dist/404.html (SPA fallback net for EdgeOne Pages)');
