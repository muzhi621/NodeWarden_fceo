// Unit tests for the SQLite->MySQL dialect translator.
// Run: npx tsx --test scripts/mysql-dialect.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import { translateSql, resetDialectTableCache } from '../src/services/mysql-dialect';
import { SCHEMA_STATEMENTS } from '../src/services/storage-schema';

test('upsert: ON CONFLICT DO UPDATE SET with excluded values', () => {
  const out = translateSql(
    "INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  // MySQL cannot express the conflict target, so every assignment is guarded:
  // a conflict on another unique key must not touch the row.
  assert.match(out, /ON DUPLICATE KEY UPDATE value=IF\(`key`=VALUES\(`key`\), VALUES\(value\), value\)/);
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
  assert.match(out, /name=IF\(id=VALUES\(id\) AND user_id=VALUES\(user_id\), VALUES\(name\), name\)/);
  assert.match(out, /updated_at=IF\(id=VALUES\(id\) AND user_id=VALUES\(user_id\), VALUES\(updated_at\), updated_at\)/);
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

test('CREATE TABLE: composite PRIMARY KEY fits the 3072-byte key budget', () => {
  resetDialectTableCache();
  // Real devices shape: user_id is an FK column and must stay VARCHAR(512) to
  // match users.id; device_identifier shrinks to VARCHAR(255) so 512+255 chars
  // (3068 bytes utf8mb4) fit InnoDB's 3072-byte index key limit.
  const out = translateSql(
    'CREATE TABLE IF NOT EXISTS devices (user_id TEXT NOT NULL, device_identifier TEXT NOT NULL, ' +
    'banned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, device_identifier), ' +
    'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)'
  );
  assert.match(out, /user_id VARCHAR\(512\) NOT NULL/);
  assert.match(out, /device_identifier VARCHAR\(255\) NOT NULL/);
  assert.match(out, /banned BIGINT NOT NULL DEFAULT 0/);
  assert.match(out, /PRIMARY KEY \(user_id, device_identifier\)/);
  assert.match(out, /FOREIGN KEY \(user_id\) REFERENCES users\(id\)/);

  // Without FK members both composite PK columns shrink and the budget holds.
  resetDialectTableCache();
  const bare = translateSql(
    'CREATE TABLE IF NOT EXISTS pair (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b))'
  );
  assert.match(bare, /a VARCHAR\(255\) NOT NULL/);
  assert.match(bare, /b VARCHAR\(255\) NOT NULL/);
});

test('CREATE TABLE: FK TEXT columns match the referenced key type', () => {
  resetDialectTableCache();
  const out = translateSql(
    'CREATE TABLE IF NOT EXISTS ciphers (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data TEXT NOT NULL, ' +
    'folder_id TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)'
  );
  assert.match(out, /id VARCHAR\(512\) PRIMARY KEY/);
  // FK column must be VARCHAR(512) (same type/length as users.id) — LONGTEXT
  // here makes MySQL reject the constraint with error 3780.
  assert.match(out, /user_id VARCHAR\(512\) NOT NULL/);
  assert.doesNotMatch(out, /user_id LONGTEXT/);
  // Non-key text stays LONGTEXT (row-size friendly).
  assert.match(out, /data LONGTEXT NOT NULL/);
  assert.match(out, /FOREIGN KEY \(user_id\) REFERENCES users\(id\)/);
});

test('CREATE TABLE: TEXT DEFAULT becomes VARCHAR with default kept', () => {
  resetDialectTableCache();
  const out = translateSql(
    "CREATE TABLE IF NOT EXISTS domain_settings (user_id TEXT PRIMARY KEY, equivalent_domains TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL)"
  );
  // JSON seed defaults must stay a LOB (they grow): the default is dropped rather
  // than capping the column at a VARCHAR bound.
  assert.match(out, /equivalent_domains LONGTEXT NOT NULL/);
  assert.doesNotMatch(out, /equivalent_domains VARCHAR/);
  assert.doesNotMatch(out, /equivalent_domains LONGTEXT NOT NULL DEFAULT/);
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
  assert.match(out, /role VARCHAR\(255\) NOT NULL DEFAULT 'user'/);
});

test('CREATE TABLE: table options ENGINE/CHARSET/COLLATE after closing paren (regression)', () => {
  resetDialectTableCache();
  // Covers every CREATE TABLE shape from storage-schema.ts: inline PK, reserved
  // word `key`, composite PK, FOREIGN KEY constraint, TEXT DEFAULT.
  const statements = [
    'CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS devices (user_id TEXT NOT NULL, device_identifier TEXT NOT NULL, banned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, device_identifier))',
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, key TEXT NOT NULL, kdf_type INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'user')",
    "CREATE TABLE IF NOT EXISTS domain_settings (user_id TEXT PRIMARY KEY, equivalent_domains TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)",
    'CREATE TABLE IF NOT EXISTS webauthn_challenges (challenge_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, user_id TEXT, expires_at INTEGER NOT NULL, used_at TEXT, created_at INTEGER NOT NULL)',
  ];
  for (const stmt of statements) {
    const out = translateSql(stmt);
    // Table options must come after the column-definition closing paren.
    assert.match(out, /\)\s*ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci\s*$/, `bad tail: ${out}`);
    // And must not leak inside the parenthesized column definitions.
    const openIdx = out.indexOf('(');
    const closeIdx = out.lastIndexOf(')');
    const columnDefs = out.slice(openIdx + 1, closeIdx);
    assert.doesNotMatch(columnDefs, /ENGINE=/i, `ENGINE= inside parens: ${out}`);
    assert.doesNotMatch(columnDefs, /CHARSET=/i, `CHARSET= inside parens: ${out}`);
    assert.doesNotMatch(columnDefs, /COLLATE=/i, `COLLATE= inside parens: ${out}`);
  }
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
  assert.match(out2, /ADD COLUMN custom_equivalent_domains LONGTEXT NOT NULL/);
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
  assert.match(
    out,
    /ON DUPLICATE KEY UPDATE user_id=IF\(token=VALUES\(token\), VALUES\(user_id\), user_id\), expires_at=IF\(token=VALUES\(token\), VALUES\(expires_at\), expires_at\)/
  );
});

test('real repository statement: insert or ignore rate bucket', () => {
  const out = translateSql(
    'INSERT OR IGNORE INTO rate_limit_buckets(bucket_key, count, expires_at, updated_at) VALUES(?, 0, ?, ?)'
  );
  assert.match(out, /^INSERT IGNORE INTO rate_limit_buckets\(bucket_key/);
});

test('schema-wide: every CREATE TABLE fits MySQL key/type constraints', () => {
  // config is created outside SCHEMA_STATEMENTS (ensureStorageSchema prologue).
  const creates = [
    'CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ...SCHEMA_STATEMENTS.filter((s) => /^\s*CREATE\s+TABLE/i.test(s)),
  ];
  for (const stmt of creates) {
    resetDialectTableCache();
    const out = translateSql(stmt);
    const body = out.slice(out.indexOf('(') + 1, out.lastIndexOf(')'));

    // 1) FK columns must be VARCHAR(512) — same type/length as the referenced
    //    TEXT PRIMARY KEY, or InnoDB rejects the constraint (error 3780).
    for (const fk of body.matchAll(/FOREIGN\s+KEY\s*\(([^)]*)\)/gi)) {
      for (const raw of fk[1].split(',')) {
        const col = raw.trim().replace(/[`"]/g, '');
        const def = body.match(new RegExp('(?:^|[\\s(,`"])' + col + '[`"]?\\s+([A-Za-z]+(?:\\(\\d+\\))?)', 'i'));
        assert.ok(def, `FK column ${col} not found in: ${out}`);
        assert.equal(def![1].toUpperCase(), 'VARCHAR(512)', `FK column ${col} must be VARCHAR(512): ${out}`);
      }
    }

    // 2) PRIMARY KEY must fit InnoDB's 3072-byte index key budget
    //    (utf8mb4 VARCHAR(n) costs 4n bytes, BIGINT 8 bytes).
    const pkMatch = body.match(/PRIMARY\s+KEY\s*\(([^)]*)\)/i);
    const pkCols = pkMatch ? pkMatch[1].split(',').map((c) => c.trim().replace(/[`"]/g, '')) : [];
    const inlinePk = body.match(/([A-Za-z_][A-Za-z0-9_]*)\s+VARCHAR\((\d+)\)\s+PRIMARY\s+KEY/i);
    const members: Array<{ col: string; size?: string }> = pkCols.length
      ? pkCols.map((col) => ({ col }))
      : inlinePk
        ? [{ col: inlinePk[1], size: `VARCHAR(${inlinePk[2]})` }]
        : [];
    if (members.length) {
      let pkBytes = 0;
      for (const member of members) {
        const def = member.size
          ? [null, member.size, member.size.match(/\((\d+)\)/)![1]]
          : body.match(new RegExp('(?:^|[\\s(,`"])' + member.col + '[`"]?\\s+(VARCHAR\\((\\d+)\\)|BIGINT|LONGTEXT)', 'i'));
        assert.ok(def, `PK column ${member.col} not found in: ${out}`);
        const type = (def![1] || '').toUpperCase();
        if (type.startsWith('VARCHAR')) pkBytes += Number(def![2]) * 4;
        else if (type === 'BIGINT') pkBytes += 8;
        else pkBytes += 100000; // LONGTEXT in a PK is always a failure
      }
      assert.ok(pkBytes <= 3072, `PK key budget ${pkBytes} bytes exceeds 3072: ${out}`);
    }

    // 3) Inline UNIQUE columns must be bounded VARCHAR (indexable).
    for (const bad of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s+LONGTEXT\b[^,]*\bUNIQUE\b/gi)) {
      assert.fail(`UNIQUE on LONGTEXT column ${bad[1]} is not indexable: ${out}`);
    }
  }
});

// --- regression: cross-row overwrite via ON DUPLICATE KEY (C-1) -------------

test('upsert guard: assignment never fires when a DIFFERENT unique key conflicts', () => {
  resetDialectTableCache();
  // users has id PK + email UNIQUE. SQLite raises on the email collision; MySQL
  // must at least leave the other account untouched (guard evaluates to false).
  const out = translateSql(
    'INSERT INTO users(id, email, master_password_hash) VALUES(?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET email=excluded.email, master_password_hash=excluded.master_password_hash'
  );
  assert.match(out, /email=IF\(id=VALUES\(id\), VALUES\(email\), email\)/);
  assert.match(out, /master_password_hash=IF\(id=VALUES\(id\), VALUES\(master_password_hash\), master_password_hash\)/);
  // No bare assignment may survive: `col=VALUES(col)` would update whatever row
  // conflicted, which for users/webauthn_credentials is a different account.
  assert.doesNotMatch(out, /email=VALUES\(email\)/);
});

test('upsert guard: expression assignments are guarded too', () => {
  const out = translateSql(
    'INSERT INTO rate_limit_buckets(ip, attempts, updated_at) VALUES(?, 1, ?) ' +
    'ON CONFLICT(ip) DO UPDATE SET attempts = attempts + 1, updated_at = excluded.updated_at'
  );
  assert.match(out, /attempts=IF\(ip=VALUES\(ip\), attempts \+ 1, attempts\)/);
});

// --- regression: unique index prefix (M-3) ---------------------------------

test('CREATE UNIQUE INDEX: no prefix on a known bounded VARCHAR column', () => {
  resetDialectTableCache();
  translateSql(
    'CREATE TABLE IF NOT EXISTS webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, credential_id TEXT NOT NULL)'
  );
  const out = translateSql(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_webauthn_credentials_credential_id ON webauthn_credentials(credential_id)'
  );
  // A prefixed UNIQUE index only enforces uniqueness on the first 191 chars and
  // rejects long (but valid) WebAuthn credential ids as duplicates.
  assert.match(out, /ON webauthn_credentials\(credential_id\)$/);
  assert.doesNotMatch(out, /credential_id\(191\)/);
  // The column itself must be bounded, or MySQL rejects the index (1170).
  const create = translateSql('CREATE TABLE IF NOT EXISTS t3 (credential_id TEXT NOT NULL)');
  assert.match(create, /credential_id VARCHAR\(512\) NOT NULL/);
});

test('CREATE UNIQUE INDEX: unknown/LOB column keeps a prefix (still valid SQL)', () => {
  resetDialectTableCache();
  const out = translateSql('CREATE UNIQUE INDEX IF NOT EXISTS idx_x ON unknown_tbl(some_col)');
  assert.match(out, /ON unknown_tbl\(some_col(\(191\))?\)/);
});

// --- regression: LIMIT -1 (C-3) --------------------------------------------

test('LIMIT -1 becomes a valid MySQL limit that still works with OFFSET', () => {
  const out = translateSql(
    'SELECT id FROM audit_logs ORDER BY created_at DESC LIMIT -1 OFFSET ?'
  );
  assert.doesNotMatch(out, /LIMIT -1/);
  assert.match(out, /LIMIT 18446744073709551615 OFFSET \?/);
});

test('LIMIT -1 inside a string literal is untouched', () => {
  const out = translateSql("UPDATE config SET value = 'LIMIT -1 OFFSET 3' WHERE key = ?");
  assert.match(out, /'LIMIT -1 OFFSET 3'/);
});

// --- regression: portable audit prune (C-3, MySQL error 1093) --------------

test('audit prune SQL is executable on both dialects', () => {
  // Mirrors pruneAuditLogsToMax: no LIMIT -1, and the same-table subquery is
  // wrapped in a derived table so MySQL accepts it (ER_UPDATE_TABLE_USED).
  const out = translateSql(
    'DELETE FROM audit_logs WHERE id NOT IN (' +
      'SELECT id FROM (SELECT id FROM audit_logs ORDER BY created_at DESC LIMIT ?) AS keep)'
  );
  assert.doesNotMatch(out, /LIMIT -1/);
  assert.match(out, /AS keep\)/);
});

// --- guard: no SQLite-only syntax survives translation ---------------------

test('translated output never contains SQLite-only syntax', () => {
  const sqliteOnly = [
    /\bON\s+CONFLICT\b/i,
    /\bINSERT\s+OR\s+(IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\b/i,
    /\bFROM\s+(?:main\.)?sqlite_(?:master|schema)\b/i,
    /\bAUTOINCREMENT\b/i,
    /\bLIMIT\s+-1\b/i,
    /\bstrftime\s*\(/i,
    /\bPRAGMA\b/i,
  ];
  const statements = [
    "INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    'INSERT OR IGNORE INTO config(key, value) VALUES(?, ?)',
    "SELECT name FROM sqlite_master WHERE type = 'table'",
    "UPDATE t SET a = CAST(strftime('%s','now') AS INTEGER) * 1000",
    'SELECT id FROM t LIMIT -1 OFFSET ?',
    'CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)',
  ];
  for (const stmt of statements) {
    resetDialectTableCache();
    const out = translateSql(stmt);
    for (const re of sqliteOnly) {
      assert.doesNotMatch(out, re, `${re} survived translation of: ${stmt} -> ${out}`);
    }
  }
});

// --- review round 2: B-1 / S-2 / S-9 --------------------------------------

test('guarded upsert keeps function calls with commas intact (B-1)', () => {
  const out = translateSql(
    'INSERT INTO users(id, name) VALUES(?, ?) ' +
      "ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, 'x'), updated_at = excluded.updated_at"
  );
  // The literal must stay where it was written (2nd argument of COALESCE), not
  // become the ELSE branch of the guard — that used to write 'x' into the row
  // when a different unique key conflicted.
  assert.match(out, /name=IF\(id=VALUES\(id\), COALESCE\(VALUES\(name\), 'x'\), name\)/);
  assert.match(out, /updated_at=IF\(id=VALUES\(id\), VALUES\(updated_at\), updated_at\)/);
  assert.doesNotMatch(out, /, name\), 'x'\)/);
  // Exactly one IF per assignment: a mis-split produced a second one.
  assert.equal((out.match(/\bIF\(/g) || []).length, 2, out);
});

test('guarded upsert keeps JSON_SET arguments intact (B-1)', () => {
  const out = translateSql(
    'INSERT INTO t(id, doc) VALUES(?, ?) ' +
      "ON CONFLICT(id) DO UPDATE SET doc = JSON_SET(excluded.doc, '$.a', 1), updated_at = excluded.updated_at"
  );
  assert.match(out, /doc=IF\(id=VALUES\(id\), JSON_SET\(VALUES\(doc\), '\$\.a', 1\), doc\)/);
  assert.match(out, /updated_at=IF\(id=VALUES\(id\), VALUES\(updated_at\), updated_at\)/);
});

test('WHERE inside a SET subquery is not mistaken for the guard clause (S-2)', () => {
  const out = translateSql(
    'INSERT INTO t(id, a) VALUES(?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET a=(SELECT v FROM u WHERE u.id=t.id), b=excluded.b'
  );
  assert.match(out, /a=IF\(id=VALUES\(id\), \(SELECT v FROM u WHERE u\.id=t\.id\), a\)/);
  assert.match(out, /b=IF\(id=VALUES\(id\), VALUES\(b\), b\)/);
});

test('ON CONFLICT without a target maps to a no-op duplicate update (S-2)', () => {
  const out = translateSql('INSERT INTO t(a, b) VALUES(?, ?) ON CONFLICT DO NOTHING');
  // No target means "ignore any conflict"; the first inserted column is the only
  // one we can prove exists, and `a=a` changes nothing whatever key was hit.
  assert.match(out, /ON DUPLICATE KEY UPDATE a=a/);
  assert.doesNotMatch(out, /ON CONFLICT/);
});

test('ON CONFLICT without a target or column list falls back to INSERT IGNORE (S-2)', () => {
  const out = translateSql('INSERT INTO t VALUES(1) ON CONFLICT DO NOTHING');
  assert.match(out, /^INSERT IGNORE INTO t VALUES\(1\)$/);
});

test('a trailing semicolon is stripped before translation (S-2)', () => {
  const out = translateSql('INSERT INTO t(a, b) VALUES(?, ?) ON CONFLICT(a) DO UPDATE SET b=excluded.b;');
  assert.doesNotMatch(out, /;/);
  assert.match(out, /b=IF\(a=VALUES\(a\), VALUES\(b\), b\)$/);
});

test('UNIQUE index on a LONGTEXT column keeps a prefix and warns (S-9)', () => {
  resetDialectTableCache();
  // `doc` is not in STRING_INDEX_COLUMNS and has no default, so it stays LONGTEXT.
  translateSql('CREATE TABLE t (id TEXT PRIMARY KEY, doc TEXT)');
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => {
    warnings.push(String(message));
  };
  try {
    const out = translateSql('CREATE UNIQUE INDEX idx ON t(doc)');
    // MySQL cannot index a LOB without a prefix (1170); the non-equivalence is
    // documented and logged instead of silently degrading.
    assert.match(out, /\(doc\(191\)\)/);
    assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
    assert.match(warnings[0], /UNIQUE index on LONGTEXT column t\.doc/);
  } finally {
    console.warn = originalWarn;
  }
});
