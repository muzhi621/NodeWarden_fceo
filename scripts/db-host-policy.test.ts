// Tests for the BYO-DB "test connection" host policy (review round 2, B-2).
// Run: npx tsx --test scripts/db-host-policy.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import { __testing } from '../src/handlers/admin-db-config';

const { isPrivateAddress, matchesCidr, allowlistAllowsHost, checkHostPolicy } = __testing;

// The policy reads DB_HOST_ALLOWLIST from the process env as well as the binding.
delete process.env.DB_HOST_ALLOWLIST;

test('private / loopback / link-local addresses are recognised', () => {
  const blocked = [
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata service
    '100.64.0.1', // carrier-grade NAT
    '224.0.0.1',
    '::1',
    '[::1]',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
  ];
  for (const address of blocked) {
    assert.equal(isPrivateAddress(address), true, `${address} should be private`);
  }
  const allowed = ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700::1111'];
  for (const address of allowed) {
    assert.equal(isPrivateAddress(address), false, `${address} should be public`);
  }
});

test('CIDR entries match by network, not by prefix string', () => {
  assert.equal(matchesCidr('10.1.2.3', '10.0.0.0/8'), true);
  assert.equal(matchesCidr('11.1.2.3', '10.0.0.0/8'), false);
  assert.equal(matchesCidr('192.168.5.5', '192.168.0.0/16'), true);
  assert.equal(matchesCidr('192.169.5.5', '192.168.0.0/16'), false);
  assert.equal(matchesCidr('8.8.8.8', 'not-a-cidr'), false);
});

test('allowlist supports exact hosts, wildcards and CIDRs', () => {
  assert.equal(allowlistAllowsHost(['db.corp.example'], 'db.corp.example'), true);
  assert.equal(allowlistAllowsHost(['*.corp.example'], 'db.corp.example'), true);
  assert.equal(allowlistAllowsHost(['*.corp.example'], 'corp.example.evil.test'), false);
  assert.equal(allowlistAllowsHost(['10.0.0.0/8'], '10.1.2.3'), true);
  assert.equal(allowlistAllowsHost(['10.0.0.0/8'], '11.1.2.3'), false);
});

test('loopback, metadata and internal suffixes are rejected before connecting', async () => {
  const hosts = ['localhost', '127.0.0.1', '169.254.169.254', '[::1]', 'db.local', 'db.internal'];
  for (const host of hosts) {
    const result = await checkHostPolicy(host, {});
    assert.equal(result.ok, false, `${host} must be rejected`);
    assert.equal(result.ok === false && result.kind, 'blocked', `${host} should be blocked, not dns`);
  }
});

test('a public IP literal is allowed (no DNS needed)', async () => {
  const result = await checkHostPolicy('8.8.8.8', {});
  assert.deepEqual(result, { ok: true });
});

test('a public name that resolves to loopback is rejected (DNS, not string matching)', async () => {
  // localtest.me / 127.0.0.1.nip.io / lvh.me all publish A records pointing at
  // 127.0.0.1 and none of them looks like an internal name.
  for (const host of ['localtest.me', '127.0.0.1.nip.io', 'lvh.me']) {
    const result = await checkHostPolicy(host, {});
    assert.equal(result.ok, false, `${host} must not be reachable`);
    // Offline the resolver fails first; either way it must never reach "ok".
    assert.ok(result.ok === false && (result.kind === 'blocked' || result.kind === 'dns'), host);
  }
});

test('DB_HOST_ALLOWLIST is an explicit opt-in for private targets', async () => {
  const result = await checkHostPolicy('127.0.0.1', { DB_HOST_ALLOWLIST: '127.0.0.1' });
  assert.deepEqual(result, { ok: true });
  const viaCidr = await checkHostPolicy('10.1.2.3', { DB_HOST_ALLOWLIST: '10.0.0.0/8' });
  assert.deepEqual(viaCidr, { ok: true });
});
