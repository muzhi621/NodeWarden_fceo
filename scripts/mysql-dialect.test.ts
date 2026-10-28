// Unit tests for the SQLite->MySQL dialect translator.
// Run: npx tsx --test scripts/mysql-dialect.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import { translateSql, resetDialectTableCache } from '../src/services/mysql-dialect';

test('upsert: ON CONFLICT DO UPDATE SET with excluded values', () => {
  const out = translateSql(
    "INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  assert.match(out, /ON DUPLICATE KEY UPDATE value=VALUES\(value\)/);
  assert.doesNotMatch(out, /ON CONFLICT/);
  assert.match(out, /`key`/);
  assert.doesNotMatch(out, /PRIMARY `KEY`|DUPLICATE `KEY`/);
});

test('upsert: ON CONFLICT DO NOTHING becomes no-op duplicate update', () => {
  const out = translateSql('INSERT INTO t(a, b) VALUES(?, ?) ON CONFLICT(user_id) DO NOTHING');
  assert.match(out, /ON DUPLICATE KEY UPDATE user_id=user_id/);
});

test('upsert: composite conflict DO NOTHING', () => {
  const out = translateSql('INSERT INTO totp_login_replays VALUES(?, ?, ?) ON CONFLICT(user_id, time_counter) DO NOTHING');
  assert.match(out, /ON DUPLICATE KEY UPDATE user_id=user_id/);
});

test('upsert: DO UPDATE with trailing WHERE becomes conditional assignments', () => {
  const out = translateSql(
    'UPDATE t SET a=1 WHERE 0; INSERT INTO devices(user_id, name) VALUES(?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at WHERE user_id=excluded.user_id'
  );
  assert.match(out, /name=IF\(user_id=VALUES\(user_id\), VALUES\(name\), name\)/);
  assert.match(out, /updated_at=IF\(user_id=VALUES\(user_id\), VALUES\(updated_at\), updated_at\)/);
  assert.doesNotMatch(out, /excluded\./);
});

test('INSERT OR IGNORE / OR REPLACE', () => {
  assert.match(translateSql('INSERT OR IGNORE INTO t(a) VALUES(?)'), /^INSERT IGNORE INTO/);
  assert.match(translateSql('INSERT OR REPLACE INTO t(a) VALUES(?)'), /^REPLACE INTO/);
});

test('json_extract becomes JSON_UNQUOTE(JSON_EXTRACT(...))', () => {
  const out = translateSql("SELECT * FROM ciphers WHERE json_extract(data, '$.folderId') = ? OR json_extract(data, '$.folder_id') IS NULL");
  assert.equal((out.match(/JSON_UNQUOTE\(JSON_EXTRACT\(/g) || []).length, 2);
  assert.doesNotMatch(out, /json_extract\(/); // lowercase form must be gone
  assert.match(out, /'\$\.folderId'/); // literals preserved
});

test('json_valid becomes JSON_VALID', () => {
  const out = translateSql('UPDATE audit_logs SET category = json_extract(metadata, \'$.category\') WHERE json_valid(metadata)');
  assert.match(out, /JSON_VALID\(metadata\)/);
  assert.match(out, /JSON_UNQUOTE\(JSON_EXTRACT\(metadata, '\$\.category'\)\)/);
});

test('strftime now() conversions', () => {
  const out = translateSql("UPDATE refresh_tokens SET created_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE created_at IS NULL");
  assert.match(out, /\(UNIX_TIMESTAMP\(\) \* 1000\)/);
  assert.doesNotMatch(out, /strftime/);
});

test('PRAGMA table_info maps to information_schema', () => {
  const out = translateSql('PRAGMA table_info(users)');
  assert.match(out, /information_schema\.COLUMNS/);
  assert.match(out, /TABLE_NAME = 'users'/);
  assert.match(out, /AS name/);
});

test('PRAGMA foreign_keys becomes harmless select', () => {
  assert.equal(translateSql('PRAGMA foreign_keys = ON'), 'SELECT 1');
});

test('CREATE TABLE: TEXT PRIMARY KEY / INTEGER / defaults / engine', () => {
  resetDialectTableCache();
  const out = translateSql(
    "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
  );
  assert.match(out, /`key` VARCHAR\(512\) PRIMARY KEY/);
  assert.match(out, /value LONGTEXT NOT NULL/);
  assert.match(out, /ENGINE=InnoDB/);
  assert.match(out, /utf8mb4/);
});

test('CREATE TABLE: composite PRIMARY KEY columns become VARCHAR(512)', () => {
  resetDialectTableCache();
  const out = translateSql(
    'CREATE TABLE IF NOT EXISTS devices (user_id TEXT NOT NULL, device_identifier TEXT NOT NULL, ' +
    'banned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, device_identifier))'
  );
  assert.match(out, /user_id VARCHAR\(512\) NOT NULL/);
  assert.match(out, /device_identifier VARCHAR\(512\) NOT NULL/);
  assert.match(out, /banned BIGINT NOT NULL DEFAULT 0/);
  assert.match(out, /PRIMARY KEY \(user_id, device_identifier\)/);
});

test('CREATE TABLE: TEXT DEFAULT becomes VARCHAR with default kept', () => {
  resetDialectTableCache();
  const out = translateSql(
    "CREATE TABLE IF NOT EXISTS domain_settings (user_id TEXT PRIMARY KEY, equivalent_domains TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL)"
  );
  assert.match(out, /equivalent_domains VARCHAR\(2048\) NOT NULL DEFAULT '\[\]'/);
});

test('CREATE TABLE: users table keeps UNIQUE email indexable', () => {
  resetDialectTableCache();
  const out = translateSql(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, key TEXT NOT NULL, kdf_type INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'user')"
  );
  assert.match(out, /id VARCHAR\(512\) PRIMARY KEY/);
  assert.match(out, /email VARCHAR\(512\) NOT NULL UNIQUE/);
  assert.match(out, /`key` LONGTEXT NOT NULL/);
  assert.match(out, /kdf_type BIGINT NOT NULL/);
  assert.match(out, /role VARCHAR\(2048\) NOT NULL DEFAULT 'user'/);
});

test('CREATE INDEX: IF NOT EXISTS dropped, text columns get prefix', () => {
  resetDialectTableCache();
  translateSql("CREATE TABLE IF NOT EXISTS ciphers (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, updated_at TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0)");
  const out = translateSql('CREATE INDEX IF NOT EXISTS idx_ciphers_user_updated ON ciphers(user_id, updated_at)');
  assert.doesNotMatch(out, /IF NOT EXISTS/);
  assert.match(out, /ON ciphers\(user_id\(191\), updated_at\(191\)\)/);

  const outInt = translateSql('CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expires ON rate_limit_buckets(expires_at)');
  // expires_at not yet known -> heuristic decides; ensure we at least produce valid syntax.
  assert.match(outInt, /ON rate_limit_buckets\(expires_at(\(191\))?\)/);
});

test('CREATE INDEX: numeric column of known table is not prefixed', () => {
  resetDialectTableCache();
  translateSql('CREATE TABLE IF NOT EXISTS t2 (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  const out = translateSql('CREATE INDEX IF NOT EXISTS idx_t2_expires ON t2(expires_at)');
  assert.match(out, /ON t2\(expires_at\)$/);
});

test('ALTER TABLE ADD COLUMN translates types and strips TEXT defaults', () => {
  resetDialectTableCache();
  const out = translateSql("ALTER TABLE users ADD COLUMN yubikey_nfc INTEGER NOT NULL DEFAULT 0");
  assert.match(out, /ADD COLUMN yubikey_nfc BIGINT NOT NULL DEFAULT 0/);
  const out2 = translateSql("ALTER TABLE domain_settings ADD COLUMN custom_equivalent_domains TEXT NOT NULL DEFAULT '[]'");
  assert.match(out2, /ADD COLUMN custom_equivalent_domains VARCHAR\(2048\) NOT NULL DEFAULT '\[\]'/);
});

test('double-quoted identifiers become backticks', () => {
  const out = translateSql('DROP TABLE IF EXISTS "_shadow_users"');
  assert.match(out, /`_shadow_users`/);
});

test('string literals are never rewritten', () => {
  const out = translateSql("UPDATE config SET value = 'key = excluded.value ON CONFLICT(x) DO NOTHING' WHERE key = ?");
  assert.match(out, /'key = excluded\.value ON CONFLICT\(x\) DO NOTHING'/);
  assert.match(out, /WHERE `key` = \?/);
});

test('UPPERCASE KEY keywords survive', () => {
  const out = translateSql('SELECT * FROM config WHERE key = ?');
  assert.match(out, /WHERE `key` = \?/);
  const pk = translateSql('CREATE TABLE IF NOT EXISTS a (id TEXT PRIMARY KEY)');
  assert.doesNotMatch(pk, /`KEY`/);
  assert.match(pk, /PRIMARY KEY/);
});

test('real repository statement: refresh token upsert', () => {
  resetDialectTableCache();
  const out = translateSql(
    'INSERT INTO refresh_tokens(token, user_id, expires_at) VALUES(?, ?, ?) ' +
    'ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id, expires_at=excluded.expires_at'
  );
  assert.match(out, /ON DUPLICATE KEY UPDATE user_id=VALUES\(user_id\), expires_at=VALUES\(expires_at\)/);
});

test('real repository statement: insert or ignore rate bucket', () => {
  const out = translateSql(
    'INSERT OR IGNORE INTO rate_limit_buckets(bucket_key, count, expires_at, updated_at) VALUES(?, 0, ?, ?)'
  );
  assert.match(out, /^INSERT IGNORE INTO rate_limit_buckets\(bucket_key/);
});
