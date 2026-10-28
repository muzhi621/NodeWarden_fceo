// D1/SQLite -> MySQL data migration tool.
//
// Reads a SQL dump produced by `wrangler d1 export --local` / `--remote`
// (SQLite dialect: CREATE TABLE + INSERT statements), ensures the MySQL
// schema exists via the same translator used at runtime, then replays the
// data (INSERT/DML) through mysql-dialect.ts into the target MySQL.
//
// Usage:
//   npm run migrate:d1-to-mysql -- --file d1-dump.sql \
//     [--host db.example.com] [--port 3306] [--user u] [--password p] \
//     [--database nodewarden] [--ssl] [--truncate] [--dry-run]
//
// Connection values fall back to env vars: DB_HOST, DB_PORT, DB_USER,
// DB_PASSWORD, DB_NAME, DB_SSL.
//
// Notes:
// - Table/index DDL from the dump is skipped; the MySQL schema is created
//   by `ensureStorageSchema` (translated DDL) so it always matches runtime.
// - FOREIGN_KEY_CHECKS are disabled during import so dump order doesn't
//   matter, then re-enabled.
// - Statements are split on `;` while respecting '...' string literals
//   (SQLite '' escaping and X'..' blob literals).

import { readFileSync } from 'node:fs';
import { translateSql } from '../src/services/mysql-dialect';
import { MySqlDatabase, type MySqlConfig } from '../src/services/storage-mysql';
import { ensureStorageSchema } from '../src/services/storage-schema';

interface CliOptions {
  file: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  truncate: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const file = get('--file');
  if (!file) {
    console.error('Usage: migrate-d1-to-mysql --file <d1-dump.sql> [--host h] [--port p] [--user u] [--password pw] [--database db] [--ssl] [--truncate] [--dry-run]');
    process.exit(2);
  }
  return {
    file,
    host: get('--host') ?? process.env.DB_HOST ?? '127.0.0.1',
    port: Number(get('--port') ?? process.env.DB_PORT ?? 3306),
    user: get('--user') ?? process.env.DB_USER ?? 'root',
    password: get('--password') ?? process.env.DB_PASSWORD ?? '',
    database: get('--database') ?? process.env.DB_NAME ?? 'nodewarden',
    ssl: argv.includes('--ssl') || process.env.DB_SSL === 'true',
    truncate: argv.includes('--truncate'),
    dryRun: argv.includes('--dry-run'),
  };
}

/** Split a SQL dump into statements, honoring '...' literals (with '' escapes and X'..' blobs). */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        // '' escape: stay in string when doubled.
        if (sql[i + 1] === "'") {
          current += sql[i + 1];
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

function classifyStatement(sql: string): 'ddl' | 'dml' | 'pragma' | 'other' {
  const head = sql.trimStart().slice(0, 20).toUpperCase();
  if (head.startsWith('PRAGMA')) return 'pragma';
  if (/^(CREATE|DROP|ALTER)\b/.test(head)) return 'ddl';
  if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/.test(head)) return 'dml';
  return 'other';
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[migrate] reading dump: ${opts.file}`);
  const dump = readFileSync(opts.file, 'utf8');
  const statements = splitSqlStatements(dump);
  const dml: string[] = [];
  let skippedDdl = 0;
  let skippedPragma = 0;
  let skippedOther = 0;
  for (const stmt of statements) {
    const kind = classifyStatement(stmt);
    if (kind === 'dml') dml.push(stmt);
    else if (kind === 'ddl') skippedDdl += 1;
    else if (kind === 'pragma') skippedPragma += 1;
    else skippedOther += 1;
  }
  console.log(`[migrate] statements: ${statements.length} total, ${dml.length} DML to replay, ${skippedDdl} DDL skipped (schema ensured separately), ${skippedPragma} PRAGMA skipped, ${skippedOther} other skipped`);

  const config: MySqlConfig = {
    host: opts.host,
    port: opts.port,
    user: opts.user,
    password: opts.password,
    database: opts.database,
    ssl: opts.ssl,
    connectionLimit: 5,
    connectTimeoutMs: 10_000,
  };

  if (opts.dryRun) {
    console.log('[migrate] dry-run: not connecting. First 3 DML statements:');
    for (const stmt of dml.slice(0, 3)) {
      console.log(`  -> ${translateSql(stmt).slice(0, 160)}...`);
    }
    return;
  }

  const db = new MySqlDatabase(config);
  console.log(`[migrate] target: ${opts.user}@${opts.host}:${opts.port}/${opts.database} (ssl=${opts.ssl})`);

  // 1. Ensure MySQL schema (translated DDL, idempotent).
  console.log('[migrate] ensuring MySQL schema...');
  await ensureStorageSchema(db as never);
  console.log('[migrate] schema ready');

  // 2. Import data with FK checks off so dump order doesn't matter.
  await db.prepare('SET FOREIGN_KEY_CHECKS = 0').run();
  try {
    if (opts.truncate) {
      console.log('[migrate] --truncate: clearing existing rows (FK checks off)...');
      const tables = await db
        .prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'")
        .all<{ name: string }>();
      for (const t of tables.results) {
        await db.prepare(`DELETE FROM \`${t.name}\``).run();
      }
      console.log(`[migrate] truncated ${tables.results.length} tables`);
    }

    console.log(`[migrate] replaying ${dml.length} statements...`);
    const CHUNK = 50;
    let done = 0;
    for (let i = 0; i < dml.length; i += CHUNK) {
      const chunk = dml.slice(i, i + CHUNK).map((sql) => db.prepare(sql));
      await db.batch(chunk);
      done += chunk.length;
      if (done % 500 === 0 || done === dml.length) console.log(`[migrate]   ${done}/${dml.length}`);
    }
  } finally {
    await db.prepare('SET FOREIGN_KEY_CHECKS = 1').run();
  }

  // 3. Sanity check: report row counts per table.
  const counts = await db
    .prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name")
    .all<{ name: string }>();
  console.log('[migrate] done. Row counts:');
  for (const t of counts.results) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM \`${t.name}\``).first<{ n: number }>();
    console.log(`  ${t.name}: ${row?.n ?? '?'}`);
  }
}

main().catch((error: unknown) => {
  console.error('[migrate] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
