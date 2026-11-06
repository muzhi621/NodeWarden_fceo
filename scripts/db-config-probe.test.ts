// Regression tests for connection-probe classification.
//
// A TiDB Cloud Starter cluster accepts connections on its default `sys`
// schema, so `SELECT VERSION()` succeeds and the admin "test" button used to
// show a green node. The application then died at startup on its first
// `CREATE TABLE config` with "CREATE command denied", which contains neither
// "Access denied" nor "Unknown database" and therefore landed in the useless
// `unknown` bucket. Run: npx tsx --test scripts/db-config-probe.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import { __testing } from '../src/handlers/admin-db-config';

const { classifyConnectionError, connectionHint, SYSTEM_SCHEMAS } = __testing;

test('classifyConnectionError keeps the known buckets intact', () => {
  const cases: Array<[string, string]> = [
    ['connect ECONNREFUSED 10.0.0.1:3306', 'refused'],
    ['connect ETIMEDOUT', 'timeout'],
    ['getaddrinfo ENOTFOUND bad.host', 'dns'],
    ["Access denied for user 'u'@'ip' (using password: YES)", 'auth'],
    ['self-signed certificate in certificate chain', 'tls'],
    ["Unknown database 'nw_bak'", 'database'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(classifyConnectionError(new Error(message)), expected, message);
  }
});

test('DDL refusal on a system schema is classified as permission, not unknown', () => {
  const raw = "CREATE command denied to user 'ZzHnNXSa5Mdgw8v.root'@'%' for table 'config'";
  assert.equal(classifyConnectionError(new Error(raw)), 'permission');
  assert.equal(classifyConnectionError(new Error("ALTER command denied to user 'u'@'%' for table 't'")), 'permission');
  assert.equal(classifyConnectionError(new Error("DROP command denied to user 'u'@'%' for table 't'")), 'permission');
  assert.equal(classifyConnectionError(new Error('permission denied for table users')), 'permission');
});

test('permission hint names the system schema, the SQL to run and the env var', () => {
  const hint = connectionHint('permission', 'env', { ssl: true } as never) ?? '';
  assert.match(hint, /系统库/);
  assert.match(hint, /CREATE DATABASE/);
  assert.match(hint, /DB_NAME/);
  assert.match(hint, /sys/);
});

test('the probe rejects every read-only system schema', () => {
  for (const name of ['sys', 'mysql', 'information_schema', 'performance_schema', 'metrics_schema']) {
    // The probe lower-cases DATABASE() before looking it up.
    assert.ok(SYSTEM_SCHEMAS.has(name.toLowerCase()), `missing ${name}`);
  }
  assert.equal(SYSTEM_SCHEMAS.has('nodewarden'), false);
  assert.equal(SYSTEM_SCHEMAS.has('test'), false);
  assert.equal(SYSTEM_SCHEMAS.has('nw_bak'), false);
});

test('unknown stays the last-resort bucket for genuinely unrecognised errors', () => {
  assert.equal(classifyConnectionError(new Error('read ECONNRESET')), 'unknown');
  assert.equal(classifyConnectionError(new Error('PROTOCOL_CONNECTION_LOST')), 'unknown');
  assert.equal(classifyConnectionError(new Error('ERROR 1105 (HY000): context deadline exceeded')), 'unknown');
  assert.equal(connectionHint('unknown', 'env', { ssl: true } as never), undefined);
});
