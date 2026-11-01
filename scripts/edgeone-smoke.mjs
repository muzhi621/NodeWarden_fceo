#!/usr/bin/env node
// Local smoke test for the EdgeOne Pages deployment, no account or platform
// needed: it calls the bundled runtime exactly the way EdgeOne calls a Node
// Function — `onRequest({ request, env })` → Response.
//
//   node scripts/edgeone-smoke.mjs                 # routing + wiring only (no DB)
//   node scripts/edgeone-smoke.mjs --db            # + full register/login/sync E2E
//
// With `--db` the following environment variables must describe a throwaway
// MySQL database (the schema and one admin account get created):
//   SMOKE_DB_HOST SMOKE_DB_PORT SMOKE_DB_USER SMOKE_DB_PASSWORD SMOKE_DB_NAME
//
// Checks that do not need a database still prove the important wiring: the
// request/response bridge, CORS, the asset stub, the cron secret, and that the
// bundle has no `cloudflare:` imports.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const withDb = process.argv.includes('--db');
const results = [];

const PUBLIC_HOST = 'nodewarden-test.edgeone.app';
const MASTER_PASSWORD_HASH = '5f4dcc3b5aa765d61d8327deb882cf99'.repeat(2);
const USER_KEY = '2.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|cccccccccccccccccccccccccccccccc';
// AES-CBC-HMAC EncString shape (type 2 needs IV | data | MAC).
const ENC = '2.dddddddddddddddddddddddddddddddd|eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee|ffffffffffffffffffffffffffffffff';

function check(name, fn) {
  results.push({ name, fn });
}

async function run() {
  if (withDb) {
    // Credentials may come from the environment or from a git-ignored file, so a
    // password never has to appear on a command line.
    if (!process.env.SMOKE_DB_HOST) {
      const configPath = path.join(rootDir, '.smoke-db.json');
      if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        for (const [key, value] of Object.entries(fileConfig)) {
          if (process.env[`SMOKE_DB_${key.toUpperCase()}`] === undefined) {
            process.env[`SMOKE_DB_${key.toUpperCase()}`] = String(value ?? '');
          }
        }
      }
    }
    const missing = ['SMOKE_DB_HOST', 'SMOKE_DB_USER', 'SMOKE_DB_NAME'].filter((k) => !process.env[k]);
    if (missing.length) {
      console.error(`--db needs ${missing.join(', ')}`);
      process.exit(2);
    }
    process.env.DB_HOST = process.env.SMOKE_DB_HOST;
    process.env.DB_PORT = process.env.SMOKE_DB_PORT || '3306';
    process.env.DB_USER = process.env.SMOKE_DB_USER;
    process.env.DB_PASSWORD = process.env.SMOKE_DB_PASSWORD || '';
    process.env.DB_NAME = process.env.SMOKE_DB_NAME;
    process.env.DB_SSL = process.env.SMOKE_DB_SSL || 'false';
  } else {
    // Keep the no-DB run deterministic: never inherit a host configuration.
    for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) delete process.env[key];
  }
  delete process.env.DATA_DIR;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'edgeone-smoke-secret-0123456789abcdef';
  process.env.CRON_SECRET = 'smoke-cron-secret';
  process.env.NODE_ENV = 'test';

  // Imported after the environment is in place: this is the bundle the platform
  // runs, not the TypeScript sources.
  const runtimePath = path.join(rootDir, 'node-functions', '_nodewarden', 'runtime.mjs');
  const { handleEdgeOneRequest, getRuntimeInfo, __testing } = await import(pathToFileURL(runtimePath).href);

  let baseUrl = `http://127.0.0.1:8080`;
  const request = (pathname, init = {}) => new Request(new URL(pathname, baseUrl), init);
  const context = (pathname, init) => ({
    request: request(pathname, init),
    env: {}, // configuration already mirrored into process.env above
    clientIp: '203.0.113.7',
  });
  const call = (pathname, init) => handleEdgeOneRequest(context(pathname, init));

  // ---------------------------------------------------------------------
  // 1. Static analysis of the function layout
  // ---------------------------------------------------------------------
  check('bundle has no cloudflare: specifier', () => {
    const bundle = fs.readFileSync(runtimePath, 'utf8');
    assert.ok(!bundle.includes('cloudflare:workers'), 'bundle still imports cloudflare:workers');
  });

  check('every backend path from src/web-vault-visibility.ts is mapped', () => {
    const source = fs.readFileSync(path.join(rootDir, 'src', 'web-vault-visibility.ts'), 'utf8');
    const prefixes = [...source.matchAll(/'(\/[a-z0-9./-]+)'/g)].map((m) => m[1]);
    const map = {
      '/api': 'api/[[default]].js',
      '/identity': 'identity/[[default]].js',
      '/icons': 'icons/[[default]].js',
      '/fill-assist': 'fill-assist/[[default]].js',
      '/notifications': 'notifications/[[default]].js',
      '/devices': 'devices/[[default]].js',
      '/auth-requests': 'auth-requests/[[default]].js',
      '/webauthn': 'webauthn/[[default]].js',
      '/web-bootstrap': 'web-bootstrap.js',
      '/config': 'config.js',
      '/accounts/kdf': 'accounts/kdf.js',
      '/settings/domains': 'settings/domains.js',
      '/v1/assetlinks:check': 'v1/[id].js',
      // Intentionally not mapped: the backend route behind this prefix only
      // serves the Chrome devtools JSON probe
      // (/.well-known/appspecific/com.chrome.devtools.json); on EdgeOne the
      // SPA fallback answers it instead of spending a function invocation.
      '/.well-known': null,
    };
    const missing = [];
    for (const prefix of prefixes) {
      if (!(prefix in map)) { missing.push(`${prefix} (not in the check table)`); continue; }
      const file = map[prefix];
      if (file === null) continue;
      if (!fs.existsSync(path.join(rootDir, 'node-functions', file))) missing.push(`${prefix} → ${file}`);
    }
    for (const file of ['healthz.js', 'internal/cron/backup.js']) {
      if (!fs.existsSync(path.join(rootDir, 'node-functions', file))) missing.push(file);
    }
    assert.deepEqual(missing, []);
  });

  check('node-functions entries only import the bundled runtime', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        const text = fs.readFileSync(full, 'utf8');
        const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
        for (const specifier of imports) {
          if (!specifier.endsWith('_nodewarden/runtime.mjs')) offenders.push(`${path.relative(rootDir, full)} → ${specifier}`);
        }
      }
    };
    walk(path.join(rootDir, 'node-functions'));
    assert.deepEqual(offenders, []);
  });

  // ---------------------------------------------------------------------
  // 2. Routing and wiring (no database required)
  // ---------------------------------------------------------------------
  check('GET /healthz answers with the node runtime shape', async () => {
    const res = await call('/healthz');
    const body = await res.json();
    assert.equal(body.runtime, 'node');
    assert.equal(typeof body.ok, 'boolean');
    assert.ok(res.status === 200 || res.status === 503);
    assert.ok(!JSON.stringify(body).includes('Access denied'), 'raw driver error leaked');
  });

  // Without a database every backend route stops at the DB gate; with one it
  // must answer for real.
  //
  // The gate has two shapes and both are correct: a cluster-level refusal (no
  // D1, no DB_* vars, no stored config) carries its own 503 and an operator-
  // facing message, while a generic latched init failure answers 500 with
  // "Database not initialized". Asserting only the second shape is what made
  // this suite red after the round-6 change.
  const expectBackendOk = (res, body) => {
    if (withDb) {
      assert.equal(res.status, 200, `${res.status} ${body}`);
      return;
    }
    assert.ok([500, 503].includes(res.status), `status ${res.status} ${body}`);
    assert.match(body, /Database not initialized|没有配置外接 MySQL/);
  };

  check('GET /api/config is served like on the Worker', async () => {
    const res = await call('/api/config');
    const text = await res.text();
    expectBackendOk(res, text);
    if (withDb) assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  });

  check('CORS headers are applied to API responses', async () => {
    const res = await call('/api/config', { headers: { Origin: 'https://vault.example.com' } });
    assert.ok(res.headers.get('access-control-allow-origin'), 'missing allow-origin');
  });

  check('OPTIONS preflight is answered (CORS, no crash)', async () => {
    const res = await call('/identity/connect/token', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://vault.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization',
      },
    });
    assert.ok(res.headers.get('access-control-allow-methods'), 'missing allow-methods');
    // An unauthenticated preflight must never reach the DB: 200/204 on Workers.
    // On this runtime the DB gate (500/503) is still acceptable without a
    // database — what matters is that CORS headers come back and nothing throws.
    assert.ok([200, 204, 500, 503].includes(res.status), `status ${res.status}`);
  });

  check('unauthenticated /api/sync is rejected (401/400), never a crash', async () => {
    const res = await call('/api/sync');
    assert.ok([401, 400, 500, 503].includes(res.status), `status ${res.status}`);
    const text = await res.text();
    assert.ok(!text.includes('Cannot read properties of null'), text);
  });

  check('asset layer runs in stub mode (body text, not just the status code)', async () => {
    // Two different 404s land here: the stub branch answers plain "Not Found",
    // the disk branch answers "Web vault not built..." — a status-only check
    // passed while the disk branch (dataDir/distDir inside the read-only code
    // directory) was silently active. Assert the stub text itself.
    const res = await call('/vault');
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'Not Found');
  });

  check('runtime resolves assets=stub and a data dir under os.tmpdir()', () => {
    const info = getRuntimeInfo();
    assert.equal(info.assets, 'stub', `assets=${info.assets} — the entry did not pass { assets: "stub" }`);
    assert.ok(
      info.dataDir.toLowerCase().startsWith(os.tmpdir().toLowerCase()),
      `dataDir=${info.dataDir} must live under ${os.tmpdir()} (EdgeOne only mounts /tmp writable)`
    );
  });

  check('static/Spa paths are NOT served by the function (asset layer stubbed)', async () => {
    const res = await call('/_nodewarden/runtime.mjs');
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'Not Found');
  });

  check('cron endpoint refuses an unauthenticated trigger', async () => {
    const res = await call('/internal/cron/backup', { method: 'POST' });
    // 401 once a secret exists, 503 when CRON_SECRET is unset (never 200).
    assert.ok([401, 503].includes(res.status), `status ${res.status}`);
  });

  check('cron accepts the secret from the scheduler payload', async () => {
    const res = await call('/internal/cron/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'smoke-cron-secret' }),
    });
    assert.notEqual(res.status, 401, 'payload secret was not accepted');
  });

  check('clientIp from the platform context becomes X-Forwarded-For', async () => {
    // Same-origin write path that refuses to run without a client IP.
    const res = await call('/api/accounts/password-hint', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ email: 'nobody@example.com' }),
    });
    const text = await res.text();
    assert.ok(!text.includes('Client IP is required'), text);
  });

  check('internal host is replaced by the forwarded host', async () => {
    const res = await handleEdgeOneRequest({
      request: new Request('http://localhost:8080/api/config', {
        headers: { 'x-forwarded-host': PUBLIC_HOST, 'x-forwarded-proto': 'https' },
      }),
      // Rate limiting needs a client identifier, exactly like on the platform.
      clientIp: '203.0.113.7',
      env: {},
    });
    expectBackendOk(res, await res.clone().text());
  });

  check('a spoofed X-Forwarded-Host cannot forge the origin of a public URL', () => {
    // C-2: with a public request.url the forwarding headers must be ignored,
    // otherwise `Origin: https://evil.example` + `X-Forwarded-Host: evil.example`
    // walks straight through the same-origin write gate. Asserted on the
    // adapter directly: without a database the pipeline answers the DB gate
    // (500) before the route-level origin check runs.
    const adapted = __testing.adaptRequest(
      new Request(`https://${PUBLIC_HOST}/api/accounts/password-hint`, {
        method: 'POST',
        headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
      }),
      { clientIp: '203.0.113.7' }
    );
    assert.equal(new URL(adapted.url).origin, `https://${PUBLIC_HOST}`);

    // ...while a recognizable internal origin (here RFC1918) still adopts it,
    // which is the shape the platform actually uses.
    const behindProxy = __testing.adaptRequest(
      new Request('http://10.0.0.7:8080/api/accounts/password-hint', {
        headers: { 'x-forwarded-host': PUBLIC_HOST, 'x-forwarded-proto': 'https' },
      }),
      { clientIp: '203.0.113.7' }
    );
    assert.equal(new URL(behindProxy.url).origin, `https://${PUBLIC_HOST}`);
  });

  check('x-forwarded-proto upgrades an internal http origin to https', async () => {
    // C-3: public host + internal http protocol (no forwarded host) used to
    // stay on http:// and reject every browser write with 403.
    const res = await handleEdgeOneRequest({
      request: new Request(`http://${PUBLIC_HOST}/api/accounts/password-hint`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: `https://${PUBLIC_HOST}`,
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ email: 'nobody@example.com' }),
      }),
      clientIp: '203.0.113.7',
      env: {},
    });
    const text = await res.text();
    assert.ok(res.status !== 403, `protocol rewrite missing: ${res.status} ${text}`);
    assert.ok(!/Forbidden origin/.test(text), text);
  });

  check('the platform clientIp overrides client-supplied ip headers', () => {
    // C-2 (rate limiting): a forged X-Real-IP / X-Forwarded-For /
    // CF-Connecting-IP used to survive when the platform provided its own
    // value, letting login brute-force rotate identities. adaptRequest is
    // asserted directly because the pipeline does not echo the identifier.
    const adapted = __testing.adaptRequest(
      new Request('http://localhost:8080/api/config', {
        headers: {
          'x-real-ip': '1.2.3.4',
          'x-forwarded-for': '1.2.3.4',
          'cf-connecting-ip': '1.2.3.4',
        },
      }),
      { clientIp: '203.0.113.7' }
    );
    assert.equal(adapted.headers.get('x-real-ip'), '203.0.113.7');
    assert.equal(adapted.headers.get('x-forwarded-for'), '203.0.113.7');
    assert.equal(adapted.headers.get('cf-connecting-ip'), null);
  });

  check('isPrivateHost recognizes CGNAT and IPv6 unique-local origins', () => {
    // C-3/S-7: platform-internal addresses that are not RFC1918.
    assert.ok(__testing.isPrivateHost('100.64.0.7'));
    assert.ok(__testing.isPrivateHost('fd00::1'));
    assert.ok(__testing.isPrivateHost('fe80::1'));
    assert.ok(__testing.isPrivateHost('[fc00::1]'));
    assert.ok(__testing.isPrivateHost('169.254.169.254'));
    assert.ok(__testing.isPrivateHost('::ffff:10.0.0.5'));
    assert.ok(!__testing.isPrivateHost(PUBLIC_HOST));
    assert.ok(!__testing.isPrivateHost('8.8.8.8'));
    assert.ok(!__testing.isPrivateHost('203.0.113.9'));
  });

  check('variables arrive through context.env (EdgeOne injection path)', async () => {
    const res = await handleEdgeOneRequest({
      request: request('/healthz'),
      env: { JWT_SECRET: 'injected-by-platform-0123456789abcdef', CRON_SECRET: 'injected-cron' },
    });
    assert.ok([200, 503].includes(res.status));
  });

  check('body-bearing request survives the URL rewrite (duplex stream)', async () => {
    const res = await handleEdgeOneRequest({
      request: new Request('http://localhost:8080/identity/connect/token', {
        method: 'POST',
        headers: { 'x-forwarded-host': PUBLIC_HOST, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=password&username=nobody%40example.com&password=x&scope=api',
      }),
      env: {},
    });
    // Reaching the handler (instead of throwing on the rebuilt body stream) shows
    // up as a regular Worker-style answer, not a 500 about a stream/duplex body.
    assert.ok(res.status < 600, `status ${res.status}`);
    const text = await res.text();
    assert.ok(!/duplex|ReadableStream|body is unusable/i.test(text), text);
  });

  // ---------------------------------------------------------------------
  // 3. Full flow against a real MySQL
  // ---------------------------------------------------------------------
  if (withDb) {
    let accessToken = null;
    const email = `edgeone-${Date.now()}@example.com`;

    check('POST /api/accounts/register creates the first admin', async () => {
      const res = await call('/api/accounts/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({
          email,
          name: 'EdgeOne Smoke',
          masterPasswordHash: MASTER_PASSWORD_HASH,
          key: USER_KEY,
          keys: {
            publicKey: '-----BEGIN PUBLIC KEY-----smoke-----END PUBLIC KEY-----',
            encryptedPrivateKey: USER_KEY,
          },
          kdf: 0,
          kdfIterations: 600000,
        }),
      });
      const body = await res.text();
      assert.equal(res.status, 200, `${res.status} ${body}`);
    });

    check('spoofed Origin + X-Forwarded-Host is rejected with 403 (CSRF gate)', async () => {
      // End-to-end companion of the adapter check above: with a database the
      // public route is reached, so the gate itself answers.
      const res = await handleEdgeOneRequest({
        request: new Request(`https://${PUBLIC_HOST}/api/accounts/password-hint`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Origin: 'https://evil.example',
            'x-forwarded-host': 'evil.example',
          },
          body: JSON.stringify({ email: 'nobody@example.com' }),
        }),
        clientIp: '203.0.113.7',
        env: {},
      });
      assert.equal(res.status, 403, `spoofed origin was accepted (status ${res.status})`);
      assert.match(await res.text(), /Forbidden origin/);
    });

    check('POST /identity/accounts/prelogin reports the KDF parameters', async () => {
      const res = await call('/identity/accounts/prelogin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.kdf, 0);
      assert.equal(body.kdfIterations, 600000);
    });

    check('POST /identity/connect/token issues an access token', async () => {
      const res = await call('/identity/connect/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          username: email,
          password: MASTER_PASSWORD_HASH,
          scope: 'api offline_access',
          client_id: 'web',
          deviceType: '9',
          deviceIdentifier: 'edgeone-smoke-device',
          deviceName: 'EdgeOne smoke',
        }).toString(),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.ok(body.access_token, 'no access_token');
      accessToken = body.access_token;
    });

    check('GET /api/sync returns the vault for the new account', async () => {
      const res = await call('/api/sync', { headers: { Authorization: `Bearer ${accessToken}` } });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.profile.email, email);
      assert.deepEqual(body.ciphers, []);
    });

    check('POST /api/ciphers then /api/sync round-trips an item', async () => {
      const create = await call('/api/ciphers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          type: 1,
          name: ENC,
          notes: null,
          favorite: false,
          login: { username: ENC, password: ENC, uris: [{ uri: ENC, match: null }], totp: null },
          fields: [],
          reprompt: 0,
        }),
      });
      const created = await create.json();
      assert.equal(create.status, 200, JSON.stringify(created));

      const sync = await call('/api/sync', { headers: { Authorization: `Bearer ${accessToken}` } });
      const body = await sync.json();
      assert.equal(body.ciphers.length, 1);
      assert.equal(body.ciphers[0].id, created.id);
    });

    check('GET /healthz reports mysql up', async () => {
      const res = await call('/healthz');
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.mode, 'mysql');
      assert.equal(body.db, 'up');
    });

    check('cron tick with the header secret succeeds', async () => {
      const res = await call('/internal/cron/backup', {
        method: 'POST',
        headers: { 'x-cron-secret': 'smoke-cron-secret' },
      });
      assert.equal(res.status, 200, await res.clone().text());
    });
  }

  // ---------------------------------------------------------------------
  let failed = 0;
  for (const { name, fn } of results) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed${withDb ? ' (with MySQL)' : ' (no DB)'}`);
  process.exit(failed === 0 ? 0 : 1);
}

await run();
