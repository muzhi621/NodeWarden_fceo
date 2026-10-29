// Regression tests: SQLite system-catalog queries translated to MySQL.
//
// Root cause of the Aliyun FC 1146 outage (2026-10-29): once the schema version
// marker was stored in `config`, every request entered
// StorageService.hasRequiredSchemaTables(), which runs
//   SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (...)
// MySQL rejects that with "Table 'nodewarden.sqlite_master' doesn't exist", so
// database initialization failed on every invocation (register returned 500).
//
// Run: npx tsx --test scripts/mysql-catalog.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import { translateSql, resetDialectTableCache } from '../src/services/mysql-dialect';

test('sqlite_master probe becomes an information_schema derived table', () => {
  const out = translateSql(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?)"
  );
  assert.doesNotMatch(out, /FROM\s+(?:main\.)?sqlite_(?:master|schema)\b/i);
  assert.match(out, /FROM \(SELECT TABLE_NAME AS name,/);
  assert.match(out, /information_schema\.TABLES/);
  assert.match(out, /TABLE_SCHEMA = DATABASE\(\)/);
  // Caller filters and bound parameters must survive untouched.
  assert.match(out, /AS sqlite_master WHERE type = 'table' AND name IN \(\?, \?, \?, \?\)$/);
});

test('sqlite_schema and main.sqlite_master are rewritten too', () => {
  for (const catalog of ['sqlite_schema', 'main.sqlite_master', 'MAIN.SQLITE_MASTER']) {
    const out = translateSql(`SELECT name FROM ${catalog}`);
    assert.match(out, /AS sqlite_master$/, `not rewritten: ${catalog} -> ${out}`);
    assert.doesNotMatch(out, /FROM\s+(?:main\.)?sqlite_(?:master|schema)\b/i, `catalog leaked: ${out}`);
  }
});

test('backup restore catalog query keeps its bound parameter', () => {
  const out = translateSql("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?");
  assert.match(out, /information_schema\.TABLES/);
  assert.match(out, /name = \?$/);
  // `sql` is reserved in MySQL 8: both the alias and the projection need ticks.
  assert.match(out, /^SELECT `sql` FROM /);
  assert.match(out, /NULL AS `sql`/);
});

test('string literals mentioning sqlite_master are never rewritten', () => {
  const out = translateSql("SELECT 'from sqlite_master' AS note FROM config");
  assert.match(out, /'from sqlite_master'/);
  assert.doesNotMatch(out, /information_schema/);
});

test('CREATE TABLE whose DDL already carries table options is not doubled', () => {
  resetDialectTableCache();
  // Shape produced by MySQL `SHOW CREATE TABLE` (backup shadow-table restore).
  const ddl =
    'CREATE TABLE "users" (\n  "id" varchar(512) NOT NULL,\n  PRIMARY KEY ("id")\n) ' +
    'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';
  const out = translateSql(ddl);
  assert.equal((out.match(/ENGINE=/g) || []).length, 1, out);
  assert.equal((out.match(/CHARSET=/g) || []).length, 1, out);
  assert.match(out, /`id` varchar\(512\) NOT NULL/);
});

// `key` is both a column name (ciphers.key, attachments.key, config.key) and an
// index keyword. Quoting the keyword breaks every restore: MySQL answered
// "syntax error near '`key` `user_id` (`user_id`)'" and the import aborted.
test('bare KEY index clauses keep the keyword unquoted', () => {
  resetDialectTableCache();
  const ddl =
    'CREATE TABLE "folders" (\n' +
    '  "id" varchar(512) NOT NULL,\n' +
    '  "user_id" varchar(512) NOT NULL,\n' +
    '  PRIMARY KEY ("id"),\n' +
    '  KEY "user_id" ("user_id"),\n' +
    '  UNIQUE KEY "idx_folders_name" ("user_id"(191))\n' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
  const out = translateSql(ddl);
  assert.match(out, /KEY `user_id` \(`user_id`\)/);
  assert.match(out, /UNIQUE KEY `idx_folders_name`/);
  assert.doesNotMatch(out, /`key`/i);
});

test('a column literally named key is still quoted', () => {
  resetDialectTableCache();
  const ddl = 'CREATE TABLE "attachments" (\n  "id" TEXT PRIMARY KEY,\n  key TEXT\n)';
  const out = translateSql(ddl);
  assert.match(out, /`key` TEXT/);
  assert.doesNotMatch(out, /\bKEY TEXT\b/);
});

test('a column named key with a sized type is still quoted', () => {
  resetDialectTableCache();
  const out = translateSql('CREATE TABLE "t" (id TEXT PRIMARY KEY, key VARCHAR(255))');
  assert.match(out, /`key` VARCHAR\(255\)/);
});
