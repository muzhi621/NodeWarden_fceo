// SQLite (D1) -> MySQL translation layer for the BYO-DB MySQL adapter.
//
// Every SQL statement that NodeWarden prepares is passed through translateSql()
// before being executed against MySQL. This keeps the 190+ repository queries
// untouched while supporting MySQL/TiDB backends.
//
// Covered dialect differences:
// - ON CONFLICT ... DO UPDATE SET / DO NOTHING  -> ON DUPLICATE KEY UPDATE
// - INSERT OR IGNORE / INSERT OR REPLACE        -> INSERT IGNORE / REPLACE
// - json_extract / json_valid                   -> JSON_UNQUOTE(JSON_EXTRACT) / JSON_VALID
// - strftime('%s','now') / CAST(... AS INTEGER) * 1000 -> UNIX_TIMESTAMP()
// - PRAGMA table_info(t)                        -> information_schema.COLUMNS
// - PRAGMA foreign_keys = ON                    -> SELECT 1 (InnoDB enforces FKs)
// - TEXT PRIMARY KEY / TEXT UNIQUE              -> VARCHAR(512) (indexable)
// - TEXT / INTEGER in DDL                       -> LONGTEXT / BIGINT
// - TEXT column DEFAULT '...'                   -> dropped (MySQL forbids defaults on TEXT)
// - CREATE INDEX IF NOT EXISTS                  -> CREATE INDEX (duplicate errors swallowed by adapter)
// - identifier "name" (double quotes)           -> `name`
// - reserved word `key` as column               -> `key`
// - TEXT column in FOREIGN KEY (col)            -> VARCHAR(512) (FK requires exact type/length match)
// - composite PRIMARY KEY text columns          -> VARCHAR(512) for FK members, VARCHAR(255) for others
//   (InnoDB index key budget is 3072 bytes: 512+255 utf8mb4 chars = 3068 bytes)
// - SELECT ... FROM sqlite_master / sqlite_schema -> derived information_schema.TABLES
//   (MySQL has no sqlite_master: error 1146 "Table 'db.sqlite_master' doesn't exist"
//    used to break EVERY request once the schema version marker was stored, because
//    StorageService.hasRequiredSchemaTables() always queries that catalog first.)

const STRING_INDEX_COLUMNS = new Set([
  'id', 'user_id', 'cipher_id', 'folder_id', 'device_identifier', 'request_device_identifier',
  'response_device_identifier', 'token', 'code', 'ip', 'jti', 'challenge_hash', 'credential_id',
  'bucket_key', 'email', 'status', 'scope', 'category', 'level', 'created_by', 'used_by',
  'actor_user_id', 'security_stamp', 'device_session_stamp', 'client_type', 'role', 'purpose',
  'revision_date', 'updated_at', 'created_at', 'deleted_at', 'archived_at', 'banned_at',
  'last_seen_at', 'creation_date', 'response_date', 'authentication_date', 'deletion_date',
  'expiration_date', 'expires_at',
]);

// Recorded from CREATE TABLE translations: table -> column -> kind.
const tableColumnKinds = new Map<string, Map<string, 'text' | 'int'>>();

export function resetDialectTableCache(): void {
  tableColumnKinds.clear();
}

function recordColumn(table: string, column: string, kind: 'text' | 'int'): void {
  let cols = tableColumnKinds.get(table);
  if (!cols) {
    cols = new Map();
    tableColumnKinds.set(table, cols);
  }
  cols.set(column, kind);
}

function columnIsText(table: string, column: string): boolean {
  const cols = tableColumnKinds.get(table);
  const kind = cols?.get(column);
  if (kind) return kind === 'text';
  return STRING_INDEX_COLUMNS.has(column);
}

function maskLiterals(sql: string): { masked: string; literals: string[] } {
  const literals: string[] = [];
  const masked = sql.replace(/'(?:[^']|'')*'/g, (match) => {
    literals.push(match);
    return `\u0000${literals.length - 1}\u0000`;
  });
  return { masked, literals };
}

function unmaskLiterals(sql: string, literals: string[]): string {
  return sql.replace(/\u0000(\d+)\u0000/g, (_, idx) => literals[Number(idx)] ?? '');
}

function maskToLiteral(index: number): string {
  return `\u0000${index}\u0000`;
}

/** Replace `json_extract(expr, 'path')` with `JSON_UNQUOTE(JSON_EXTRACT(expr, 'path'))` using paren matching. */
function rewriteJsonExtract(sql: string): string {
  const callRe = /\bjson_extract\s*\(/gi;
  let result = sql;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(result)) !== null) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = findMatchingParen(result, openParen);
    if (closeParen < 0) break;
    const inner = result.slice(openParen + 1, closeParen);
    const replacement = `JSON_UNQUOTE(JSON_EXTRACT(${inner}))`;
    result = result.slice(0, match.index) + replacement + result.slice(closeParen + 1);
    callRe.lastIndex = match.index + replacement.length;
  }
  return result;
}

function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function rewriteOnConflict(sql: string): string {
  const conflictRe = /\bON\s+CONFLICT\s*\(([^)]*)\)\s*DO\s+(NOTHING|UPDATE\s+SET\s+([\s\S]*))$/i;
  const match = sql.match(conflictRe);
  if (!match) return sql;

  const head = sql.slice(0, match.index);
  const action = (match[2] || '').toUpperCase();

  if (action.startsWith('NOTHING')) {
    const conflictCols = (match[1] || '').split(',').map((c) => c.trim()).filter(Boolean);
    const firstCol = conflictCols[0] || 'id';
    return `${head}ON DUPLICATE KEY UPDATE ${quoteIdentifier(firstCol)}=${quoteIdentifier(firstCol)}`;
  }

  let setTail = match[3] || '';
  let whereCond = '';
  const whereMatch = setTail.match(/\s+WHERE\s+([\s\S]+)$/i);
  if (whereMatch) {
    whereCond = whereMatch[1].trim();
    setTail = setTail.slice(0, whereMatch.index);
  }

  const items = setTail.split(',').map((s) => s.trim()).filter(Boolean);
  const assignments: string[] = [];
  for (const item of items) {
    const itemMatch = item.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*excluded\.([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (!itemMatch) {
      // Fallback: plain value replacement without conditional wrapper.
      assignments.push(item.replace(/\bexcluded\.([A-Za-z_][A-Za-z0-9_]*)/gi, 'VALUES($1)'));
      continue;
    }
    const targetCol = quoteIdentifier(itemMatch[1]);
    const valueExpr = `VALUES(${quoteIdentifier(itemMatch[2])})`;
    if (whereCond) {
      const cond = whereCond.replace(/\bexcluded\.([A-Za-z_][A-Za-z0-9_]*)/gi, 'VALUES($1)');
      assignments.push(`${targetCol}=IF(${cond}, ${valueExpr}, ${targetCol})`);
    } else {
      assignments.push(`${targetCol}=${valueExpr}`);
    }
  }

  return `${head}ON DUPLICATE KEY UPDATE ${assignments.join(', ')}`;
}

function quoteIdentifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : name;
}

// Column types that may follow a column literally named `key` (`key TEXT`).
// Anything else followed by `(` is an index clause such as
// `KEY `user_id` (`user_id`)` in DDL copied from SHOW CREATE TABLE.
const KEY_COLUMN_TYPE_TOKENS = new Set([
  'text', 'tinytext', 'mediumtext', 'longtext',
  'char', 'varchar', 'nchar', 'nvarchar',
  'blob', 'tinyblob', 'mediumblob', 'longblob', 'binary', 'varbinary',
  'int', 'integer', 'tinyint', 'smallint', 'mediumint', 'bigint',
  'real', 'double', 'float', 'decimal', 'numeric', 'number',
  'boolean', 'bool', 'bit', 'serial', 'uuid', 'json', 'jsonb',
  'date', 'datetime', 'timestamp', 'time', 'year',
  'enum', 'set', 'clob',
]);

/** Quote the reserved word `key` when used as an identifier (not PRIMARY KEY / FOREIGN KEY / DUPLICATE KEY / string). */
function quoteKeyIdentifier(sql: string): string {
  // `key` is a column name in several tables but a keyword in index clauses.
  // Index clauses (`KEY name (cols)`, `UNIQUE KEY ...`, `FULLTEXT KEY ...`) only
  // show up in MySQL-sourced DDL, e.g. SHOW CREATE TABLE during a backup
  // restore; quoting the keyword there produces `` `key` `col` (...) `` and a
  // 1064 error.
  return sql.replace(
    /(?<!\w)(?<!PRIMARY\s)(?<!FOREIGN\s)(?<!UNIQUE\s)(?<!DUPLICATE\s)(?<!FULLTEXT\s)(?<!SPATIAL\s)(?<!`)key(?!\w)(?!`)/gi,
    (match, offset, whole: string) => {
      const before = whole.slice(Math.max(0, offset - 16), offset).toUpperCase();
      if (/(PRIMARY|FOREIGN|UNIQUE|DUPLICATE|FULLTEXT|SPATIAL)\s+$/.test(before)) return match;
      if (isKeyIndexClause(whole.slice(offset + match.length))) return match;
      return '`key`';
    }
  );
}

/** True when the text right after `key` starts an index column list. */
function isKeyIndexClause(after: string): boolean {
  // `KEY (col)` — unnamed index.
  if (/^\s*\(/.test(after)) return true;
  const tokenMatch = after.match(/^\s*("([^"]*)"|`([^`]*)`|([A-Za-z_][A-Za-z0-9_$]*))/);
  if (!tokenMatch) return false;
  if (!/^\s*\(/.test(after.slice(tokenMatch[0].length))) return false;
  // A quoted name is always an index name; a bare word is only an index name if
  // it is not a column type (which would mean this is the `key` column).
  if (tokenMatch[1].startsWith('"') || tokenMatch[1].startsWith('`')) return true;
  return !KEY_COLUMN_TYPE_TOKENS.has(String(tokenMatch[4] || '').toLowerCase());
}

function translateColumnDef(def: string, table: string): string {
  let out = def;
  const nameMatch = out.match(/^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s+/);
  const columnName = nameMatch ? nameMatch[1] : '';

  if (/\bTEXT\s+PRIMARY\s+KEY\b/i.test(out)) {
    out = out.replace(/\bTEXT(\s+PRIMARY\s+KEY)/i, 'VARCHAR(512)$1');
    if (columnName) recordColumn(table, columnName, 'text');
    return out;
  }
  if (/\bTEXT\b[^,]*\bUNIQUE\b/i.test(out)) {
    out = out.replace(/\bTEXT\b/i, 'VARCHAR(512)');
    if (columnName) recordColumn(table, columnName, 'text');
    return out;
  }
  if (/\bTEXT\b/i.test(out)) {
    if (/\bDEFAULT\b/i.test(out)) {
      // MySQL forbids DEFAULT on TEXT/LONGTEXT. Bounded VARCHAR keeps the
      // default (role/status/level/'[]' JSON columns are small).
      out = out.replace(/\bTEXT\b/i, 'VARCHAR(2048)');
    } else {
      out = out.replace(/\bTEXT\b/i, 'LONGTEXT');
    }
    if (columnName) recordColumn(table, columnName, 'text');
    return out;
  }
  if (/\bINTEGER\b/i.test(out)) {
    out = out.replace(/\bINTEGER\b/i, 'BIGINT');
    if (columnName) recordColumn(table, columnName, 'int');
    return out;
  }
  return out;
}

function translateCreateTable(sql: string): string {
  const headerMatch = sql.match(/^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)([A-Za-z_"][A-Za-z0-9_"]*)\s*\(/i);
  if (!headerMatch) return sql;

  const table = headerMatch[2].replace(/"/g, '');
  const bodyStart = headerMatch[0].length;
  const bodyEnd = sql.lastIndexOf(')');
  if (bodyEnd < bodyStart) return sql;

  const body = sql.slice(bodyStart, bodyEnd);
  const tail = sql.slice(bodyEnd); // includes closing ')' and anything after

  // Collect composite PRIMARY KEY columns so we can make them indexable.
  const pkMatch = body.match(/PRIMARY\s+KEY\s*\(([^)]*)\)/i);
  const pkCols = pkMatch
    ? pkMatch[1].split(',').map((c) => c.trim().replace(/"/g, '')).filter(Boolean)
    : [];

  // Collect FOREIGN KEY referencing columns: MySQL requires them to have the
  // exact type/length of the referenced key column (error 3780 otherwise).
  const fkCols = new Set<string>();
  for (const fk of body.matchAll(/FOREIGN\s+KEY\s*\(([^)]*)\)/gi)) {
    for (const raw of fk[1].split(',')) {
      const name = raw.trim().replace(/"/g, '');
      if (name) fkCols.add(name);
    }
  }

  // Split body on top-level commas.
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);

  const translatedParts = parts.map((rawPart) => {
    const part = rawPart.trim();
    if (!part) return part;
    if (/^(PRIMARY|FOREIGN|UNIQUE|CONSTRAINT|CHECK)\b/i.test(part)) {
      // Composite PK: record member columns as text so indexes get prefixes.
      if (/^PRIMARY\s+KEY\s*\(/i.test(part)) {
        for (const col of pkCols) recordColumn(table, col, 'text');
      }
      return part.replace(/PRIMARY\s+KEY\s*\(/i, 'PRIMARY KEY (');
    }
    const colDef = translateColumnDef(part, table);
    const nameMatch = colDef.match(/^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s+/);
    const colName = nameMatch ? nameMatch[1] : '';
    if (colName && (/LONGTEXT/i.test(colDef) || /VARCHAR\(2048\)/i.test(colDef))) {
      if (pkCols.includes(colName)) {
        // Key columns must be bounded VARCHAR to be indexable. FK members keep
        // VARCHAR(512) to match the referenced key; other composite PK members
        // shrink to VARCHAR(255) so 512+255 chars fit InnoDB's 3072-byte key
        // budget. A single-column PK keeps the full VARCHAR(512).
        const size = pkCols.length === 1 || fkCols.has(colName) ? 512 : 255;
        recordColumn(table, colName, 'text');
        return colDef.replace(/\bLONGTEXT\b/i, `VARCHAR(${size})`).replace(/\bVARCHAR\(2048\)/i, `VARCHAR(${size})`);
      }
      if (fkCols.has(colName)) {
        // FK columns must have the exact type/length of the referenced key.
        recordColumn(table, colName, 'text');
        return colDef.replace(/\bLONGTEXT\b/i, 'VARCHAR(512)').replace(/\bVARCHAR\(2048\)/i, 'VARCHAR(512)');
      }
    }
    return colDef;
  });

  let translated = `${headerMatch[1]}${table} (${translatedParts.join(', ')}`;
  // Table options must come AFTER the column definitions' closing paren (MySQL grammar).
  const engineClause = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';
  // DDL that already carries table options (MySQL SHOW CREATE TABLE output, used
  // by the shadow-table restore path) must not get a second ENGINE clause.
  const closing = /\bENGINE\s*=/i.test(tail) ? tail : tail.replace(/^\)/, `)${engineClause}`);
  translated = translated + closing;
  return translated;
}

function translateCreateIndex(sql: string): string {
  // Drop IF NOT EXISTS (MySQL lacks it; adapter swallows duplicate-key errors).
  let out = sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, '');
  // Add prefix lengths to text columns in the column list.
  out = out.replace(/(\bON\s+[A-Za-z_"][A-Za-z0-9_"]*\s*)\(([^)]*)\)/i, (full, head: string, cols: string) => {
    const tableMatch = head.match(/ON\s+([A-Za-z_"][A-Za-z0-9_"]*)/i);
    const table = (tableMatch ? tableMatch[1] : '').replace(/"/g, '');
    const translatedCols = cols.split(',').map((rawCol) => {
      const col = rawCol.trim();
      const plain = col.replace(/\s*\(\d+\)\s*$/, '');
      if (/\(\d+\)\s*$/.test(col)) return col;
      if (columnIsText(table, plain)) return `${plain}(191)`;
      return col;
    });
    return `${head}(${translatedCols.join(', ')})`;
  });
  return out;
}

function translateAlterTable(sql: string): string {
  let out = sql;
  const addMatch = out.match(/(\bADD\s+COLUMN\s+)([A-Za-z_"][A-Za-z0-9_"]*\s+[\s\S]+)$/i);
  if (addMatch) {
    const tableNameMatch = out.match(/ALTER\s+TABLE\s+([A-Za-z_"][A-Za-z0-9_"]*)/i);
    const table = (tableNameMatch ? tableNameMatch[1] : '').replace(/"/g, '');
    const colDef = translateColumnDef(addMatch[2], table);
    out = out.slice(0, addMatch.index) + addMatch[1] + colDef;
  }
  return out;
}

function translatePragma(sql: string): string {
  const tableInfo = sql.match(/^\s*PRAGMA\s+table_info\s*\(\s*([A-Za-z_"][A-Za-z0-9_"]*)\s*\)/i);
  if (tableInfo) {
    const table = tableInfo[1].replace(/"/g, '');
    return `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`;
  }
  return 'SELECT 1';
}

// MySQL has no SQLite system catalog. NodeWarden reads table metadata from
// `sqlite_master` (schema self-check, backup shadow-table restore), so the
// catalog is replaced with a derived table exposing the same column names
// (name / type / sql) — the surrounding WHERE clauses keep working verbatim.
//
// The `sql` column stays NULL on purpose: MySQL DDL is fetched with
// SHOW CREATE TABLE by the caller (see backup-import.getTableCreateSql).
// Called on *masked* SQL (string literals replaced by \u0000N\u0000 markers) so the
// word sqlite_master inside a literal is never rewritten; the mock `type`
// value is injected through the same mask so `type = 'table'` filters match.
function rewriteSqliteCatalog(sql: string, literals: string[]): string {
  if (!/\bsqlite_(?:master|schema)\b/i.test(sql)) return sql;
  const tableLiteral = maskToLiteral(literals.length);
  literals.push("'table'");
  // `sql` is a reserved word in MySQL 8 — the alias (and the caller's
  // `SELECT sql` projection) must be backticked or MySQL answers ER_PARSE_ERROR.
  const catalog =
    `(SELECT TABLE_NAME AS name, ${tableLiteral} AS type, NULL AS \`sql\` ` +
    'FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE())';
  // `SELECT sql FROM sqlite_master WHERE ...` (backup shadow-table restore).
  const projected = sql.replace(/^(\s*SELECT\s+)sql\b/i, '$1`sql`');
  return projected.replace(
    /\b(?:main\.)?sqlite_(?:master|schema)\b/gi,
    `${catalog} AS sqlite_master`
  );
}

export function translateSql(input: string): string {
  let sql = input.trim();
  if (!sql) return sql;

  if (/^\s*PRAGMA\b/i.test(sql)) {
    return translatePragma(sql);
  }

  // Function rewrites that involve literal strings run before masking.
  sql = sql.replace(
    /CAST\s*\(\s*strftime\s*\(\s*'%s'\s*,\s*'now'\s*\)\s+AS\s+INTEGER\s*\)\s*\*\s*1000/gi,
    '(UNIX_TIMESTAMP() * 1000)'
  );
  sql = sql.replace(/strftime\s*\(\s*'%s'\s*,\s*'now'\s*\)/gi, 'UNIX_TIMESTAMP()');
  sql = rewriteJsonExtract(sql);
  sql = sql.replace(/\bjson_valid\s*\(/gi, 'JSON_VALID(');

  const { masked, literals } = maskLiterals(sql);
  let out = masked;

  // Double-quoted identifiers -> backticks (shadow-table restore rewrites use them).
  out = out.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '`$1`');

  // Upserts and insert variants.
  out = rewriteOnConflict(out);
  out = out.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT IGNORE');
  out = out.replace(/\bINSERT\s+OR\s+REPLACE\b/gi, 'REPLACE');

  // DDL.
  if (/^\s*CREATE\s+TABLE\b/i.test(out)) {
    out = translateCreateTable(out);
  } else if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(out)) {
    out = translateCreateIndex(out);
  } else if (/^\s*ALTER\s+TABLE\b/i.test(out)) {
    out = translateAlterTable(out);
  }

  // Reserved word `key` as identifier.
  out = quoteKeyIdentifier(out);

  // Catalog rewrite runs while literals are still masked: it must not touch the
  // word sqlite_master inside string literals, and it injects its own literal
  // through the same mask.
  return unmaskLiterals(rewriteSqliteCatalog(out, literals), literals);
}

export const __testing = { maskLiterals, unmaskLiterals, translateCreateTable, translateCreateIndex, maskToLiteral };
