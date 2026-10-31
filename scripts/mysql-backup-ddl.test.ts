// Regression tests: MySQL shadow-table DDL used by the backup restore path.
//
// Root cause of the Aliyun FC restore failure (2026-10-29): the import creates
// `__restore` shadow tables from `SHOW CREATE TABLE` output. MySQL scopes named
// foreign keys to the *schema*, so copying `CONSTRAINT "domain_settings_ibfk_1"`
// failed with "Duplicate foreign key constraint name".
//
// Run: npx tsx --test scripts/mysql-backup-ddl.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShadowTableCreateSql, normalizeMysqlIdentifiers } from '../src/services/backup-import';

const LIVE_DDL =
  'CREATE TABLE "domain_settings" (\n' +
  '  "user_id" varchar(512) NOT NULL,\n' +
  '  "updated_at" longtext NOT NULL,\n' +
  '  PRIMARY KEY ("user_id"),\n' +
  '  CONSTRAINT "domain_settings_ibfk_1" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE\n' +
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

test('shadow DDL renames the table and its self-references', () => {
  const out = buildShadowTableCreateSql(LIVE_DDL, 'domain_settings', true);
  assert.match(out, /^CREATE TABLE "domain_settings__restore"/);
  assert.doesNotMatch(out, /\(\s*"user_id" varchar\(512\)[^)]*\)\s*ENGINE/);
});

test('MySQL shadow DDL drops named foreign keys (schema-wide name collisions)', () => {
  const out = buildShadowTableCreateSql(LIVE_DDL, 'domain_settings', true);
  assert.doesNotMatch(out, /CONSTRAINT/i, out);
  assert.doesNotMatch(out, /FOREIGN KEY/i, out);
  assert.doesNotMatch(out, /REFERENCES/i, out);
  // The remaining elements must stay well-formed: no dangling comma before `)`.
  assert.doesNotMatch(out, /,\s*\)/, out);
  assert.match(out, /PRIMARY KEY \("user_id"\)\s*\)\s*ENGINE=InnoDB/);
});

test('SQLite shadow DDL keeps its constraints untouched', () => {
  const sqliteDdl =
    'CREATE TABLE "domain_settings" ("user_id" TEXT PRIMARY KEY, "updated_at" TEXT NOT NULL)';
  const out = buildShadowTableCreateSql(sqliteDdl, 'domain_settings', false);
  assert.match(out, /^CREATE TABLE "domain_settings__restore" \(/);
  assert.match(out, /"user_id" TEXT PRIMARY KEY/);
});

test('removing a middle constraint keeps the other index clauses', () => {
  const ddl =
    'CREATE TABLE "webauthn_credentials" (\n' +
    '  "id" varchar(512) NOT NULL,\n' +
    '  "user_id" varchar(512) NOT NULL,\n' +
    '  PRIMARY KEY ("id"),\n' +
    '  UNIQUE KEY "idx_cred" ("id"(191)),\n' +
    '  KEY "user_id" ("user_id"),\n' +
    '  CONSTRAINT "webauthn_credentials_ibfk_1" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE\n' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';
  const out = buildShadowTableCreateSql(ddl, 'webauthn_credentials', true);
  assert.match(out, /UNIQUE KEY "idx_cred"/);
  assert.match(out, /KEY "user_id" \("user_id"\)/);
  assert.doesNotMatch(out, /CONSTRAINT/i, out);
});

// --- regression: identifier translation must not touch string literals (S-1) ---

test('S-1: backticks inside string literals survive identifier normalization', () => {
  const ddl =
    'CREATE TABLE `users` (\n' +
    '  `id` varchar(32) NOT NULL,\n' +
    "  `note` varchar(16) DEFAULT 'a`b',\n" +
    '  PRIMARY KEY (`id`)\n' +
    ') ENGINE=InnoDB';
  const out = normalizeMysqlIdentifiers(ddl);
  assert.match(out, /CREATE TABLE "users"/);
  assert.match(out, /"note" varchar\(16\)/);
  assert.match(out, /DEFAULT 'a`b'/, 'a backtick inside a string literal must stay byte for byte');
});

test('S-1: escaped identifiers and comments are handled', () => {
  const ddl =
    'CREATE TABLE `we``ird` (\n' +
    '  -- keep `this` comment as is\n' +
    '  `id` int NOT NULL,\n' +
    '  PRIMARY KEY (`id`)\n' +
    ')';
  const out = normalizeMysqlIdentifiers(ddl);
  assert.match(out, /CREATE TABLE "we`ird"/, 'a doubled backtick is one literal backtick');
  assert.match(out, /-- keep `this` comment as is/, 'line comments are copied verbatim');
});

test('S-1: normalized DDL feeds the shadow-table rewrite', () => {
  const ddl =
    'CREATE TABLE `domain_settings` (\n' +
    '  `user_id` varchar(512) NOT NULL,\n' +
    "  `note` longtext DEFAULT 'x`y',\n" +
    '  PRIMARY KEY (`user_id`)\n' +
    ') ENGINE=InnoDB';
  const out = buildShadowTableCreateSql(normalizeMysqlIdentifiers(ddl), 'domain_settings', true);
  assert.match(out, /^CREATE TABLE "domain_settings__restore"/);
  assert.match(out, /'x`y'/);
});
