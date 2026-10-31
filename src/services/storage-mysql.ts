// MySQL adapter exposing the D1 database surface used by NodeWarden's repos
// (prepare().bind().run/first/all + batch). Every statement is translated from
// SQLite/D1 dialect to MySQL via mysql-dialect.ts.
//
// This adapter is intended for Node.js runtimes (EdgeOne Pages Cloud Functions,
// Aliyun FC / Tencent SCF, local `npm run start:node`). On Cloudflare Workers,
// keep using D1 (the default) — mysql2 requires Node TCP sockets.

import { translateSql } from './mysql-dialect';
import { readEnv, readEnvFile, readEnvFlag } from './runtime-env';

export interface MySqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  connectionLimit: number;
  connectTimeoutMs: number;
}

export interface D1LikeMeta {
  changes: number;
  last_row_id: number;
}

export interface D1LikeResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1LikeMeta;
}

export interface D1LikeStatement<T = Record<string, unknown>> {
  bind(...params: unknown[]): D1LikeStatement<T>;
  run(): Promise<D1LikeResult<T>>;
  first<R = T>(): Promise<R | null>;
  all<R = T>(): Promise<D1LikeResult<R>>;
}

export interface D1LikeDatabase {
  prepare(sql: string): D1LikeStatement;
  batch(statements: D1LikeStatement[]): Promise<D1LikeResult[]>;
}

type MySqlPool = {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  getConnection(): Promise<MySqlPoolConnection>;
  end(): Promise<void>;
};

type MySqlPoolConnection = {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
};

function normalizeParams(params: unknown[]): unknown[] {
  return params.map((value) => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === undefined) return null;
    return value;
  });
}

function isDuplicateDdlError(error: unknown): boolean {
  const errno = Number((error as { errno?: number })?.errno ?? 0);
  const code = String((error as { code?: string })?.code ?? '');
  // Only "object already exists" is ignorable for re-runnable DDL. Matching on
  // message substrings used to swallow ER_DUP_ENTRY (1062) as well, so a UNIQUE
  // index that failed because of dirty data looked like a success and the
  // constraint silently never existed.
  if (IGNORABLE_DDL_ERRNOS.has(errno) || IGNORABLE_DDL_CODES.has(code)) return true;
  if (errno === 1062 || code === 'ER_DUP_ENTRY') {
    console.error(
      '[mysql] DDL rejected due to duplicate data — the index/constraint was NOT created:',
      error instanceof Error ? error.message : String(error)
    );
  }
  return false;
}

const IGNORABLE_DDL_ERRNOS = new Set([1050, 1060, 1061]);
const IGNORABLE_DDL_CODES = new Set(['ER_TABLE_EXISTS_ERROR', 'ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME']);

/**
 * Failures that mean the connection died *after* the statement was sent.
 *
 * The server may well have executed the statement before the socket broke, so
 * retrying an INSERT here duplicates rows (audit_logs has no unique key to save
 * us). These are only retried for read-only statements.
 */
const RETRYABLE_CONN_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'ER_CLIENT_INTERACTION_TIMEOUT',
  // The server dropped the idle connection out from under mysql2: the statement
  // never started, so even a write can be replayed safely.
  'PROTOCOL_SEQUENCE_TIMEOUT',
]);

/** Failures that happen before any statement reaches the server: always safe to retry. */
const RETRYABLE_PRECONNECT_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  // 'ER_CON_COUNT_ERROR' is handled separately in query(): the server refused
  // a new connection because of its max_connections cap — the pool itself is
  // healthy, so the generic path (destroy + rebuild) would kill every
  // in-flight query just to free one slot.
]);

/**
 * How long to wait before replaying a statement that ran into the server's
 * connection cap: another connection may free up within that window, and the
 * statement never reached the server, so even writes can be replayed safely.
 */
const CON_CAP_RETRY_DELAY_MS = 200;

/** Statements with no side effects — the only ones worth replaying after a reset. */
const READ_ONLY_SQL = /^\s*(?:SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;

function isDdlStatement(sql: string): boolean {
  return /^\s*(CREATE|ALTER|DROP)\b/i.test(sql);
}

function toResult(rows: unknown, affectedRows?: number, insertId?: number): D1LikeResult {
  const list = Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
  return {
    results: list,
    success: true,
    meta: {
      changes: Number(affectedRows ?? list.length ?? 0),
      last_row_id: Number(insertId ?? 0),
    },
  };
}

class MySqlStatement implements D1LikeStatement {
  private params: unknown[] = [];

  constructor(
    private readonly db: MySqlDatabase,
    private readonly translatedSql: string,
    private readonly originalSql: string
  ) {}

  bind(...params: unknown[]): D1LikeStatement {
    this.params = normalizeParams(params);
    return this;
  }

  async run(): Promise<D1LikeResult> {
    try {
      const [rawResult] = await this.db.query(this.translatedSql, this.params);
      const result = rawResult as { affectedRows?: number; insertId?: number };
      return toResult([], result?.affectedRows ?? 0, result?.insertId ?? 0);
    } catch (error) {
      if (isDdlStatement(this.originalSql) && isDuplicateDdlError(error)) {
        return toResult([], 0, 0);
      }
      throw error;
    }
  }

  async first<R = Record<string, unknown>>(): Promise<R | null> {
    const all = await this.all<R>();
    return all.results[0] ?? null;
  }

  async all<R = Record<string, unknown>>(): Promise<D1LikeResult<R>> {
    try {
      const [rows, fields] = await this.db.query(this.translatedSql, this.params);
      const list = Array.isArray(rows) ? rows as R[] : [];
      const affected = Array.isArray(rows) ? undefined : (rows as { affectedRows?: number })?.affectedRows;
      void fields;
      return toResult(list, affected ?? list.length) as unknown as D1LikeResult<R>;
    } catch (error) {
      if (isDdlStatement(this.originalSql) && isDuplicateDdlError(error)) {
        return toResult([]) as unknown as D1LikeResult<R>;
      }
      throw error;
    }
  }

  getSql(): string {
    return this.translatedSql;
  }

  getOriginalSql(): string {
    return this.originalSql;
  }

  getParams(): unknown[] {
    return this.params;
  }
}

export class MySqlDatabase implements D1LikeDatabase {
  readonly dialect = 'mysql';
  private pool: MySqlPool | null = null;
  private poolPromise: Promise<MySqlPool> | null = null;
  /** Bumped by close() so an in-flight getPool() cannot resurrect a dead pool. */
  private generation = 0;

  constructor(private readonly config: MySqlConfig) {}

  getConfig(): MySqlConfig {
    return this.config;
  }

  private async sslOptions(): Promise<Record<string, unknown> | undefined> {
    if (!this.config.ssl) return undefined;
    // Secure by default: the connection carries the database password, so an
    // unverified certificate means anyone on the path can complete the handshake.
    // DB_SSL_INSECURE=1 is the explicit escape hatch for self-signed servers;
    // DB_SSL_CA points at a PEM file (the correct fix for private CAs).
    const ca = await readEnvFile('DB_SSL_CA', 'DB_SSL_CA');
    return { rejectUnauthorized: !readEnvFlag('DB_SSL_INSECURE'), ...(ca ? { ca } : {}) };
  }

  private async getPool(): Promise<MySqlPool> {
    if (this.pool) return this.pool;
    if (!this.poolPromise) {
      const generation = this.generation;
      const pending = (async () => {
        // Lazy, non-literal dynamic import so Workers bundling never pulls in mysql2.
        const moduleName = 'mysql2/promise';
        const mysql = (await import(/* @vite-ignore */ moduleName)) as {
          createPool(options: Record<string, unknown>): MySqlPool;
        };
        const pool = mysql.createPool({
          host: this.config.host,
          port: this.config.port,
          user: this.config.user,
          password: this.config.password,
          database: this.config.database,
          waitForConnections: true,
          connectionLimit: this.config.connectionLimit,
          connectTimeout: this.config.connectTimeoutMs,
          charset: 'utf8mb4',
          timezone: readEnv('DB_TIMEZONE') || 'Z',
          enableKeepAlive: true,
          keepAliveInitialDelay: 10_000,
          multipleStatements: false,
          // SQLite/D1 report `changes` as MATCHED rows; MySQL reports CHANGED rows
          // by default. Without FOUND_ROWS every `meta.changes > 0` guard (40+
          // call sites) turns into a false "not found" when a column is set to a
          // value it already had.
          flags: ['FOUND_ROWS'],
          ssl: await this.sslOptions(),
          typeCast: (field: { type: string; string(): string | null }, next: () => unknown) => {
            if (field.type === 'LONGLONG' || field.type === 'NEWDECIMAL') {
              const raw = field.string();
              if (raw === null) return null;
              const numeric = Number(raw);
              if (!Number.isFinite(numeric)) return raw;
              if (field.type === 'LONGLONG') {
                // BIGINT above 2^53 turns into a wrong number silently (ids,
                // counters). Keep the exact digits instead.
                return Number.isSafeInteger(numeric) ? numeric : raw;
              }
              // DECIMAL: only convert when the double holds every significant
              // digit; SUM()/COUNT() results are small, money is not.
              const digits = raw.replace(/[-.]/g, '').replace(/^0+/, '').length;
              return digits <= 15 ? numeric : raw;
            }
            return next();
          },
        });
        // A close() that happened while we were connecting wins: don't resurrect.
        if (generation === this.generation) this.pool = pool;
        return pool;
      })();

      this.poolPromise = pending
        .catch((error: unknown) => {
          // Never cache a rejected promise: the pool must be retryable.
          this.poolPromise = null;
          throw error;
        })
        .finally(() => {
          if (generation === this.generation) this.poolPromise = null;
        }) as Promise<MySqlPool>;
    }
    return this.poolPromise;
  }

  /** Raw query used by the statement wrapper (and health checks). */
  async query(sql: string, params: unknown[]): Promise<[unknown, unknown]> {
    const pool = await this.getPool();
    try {
      return await pool.query(sql, params);
    } catch (error) {
      const code = String((error as { code?: string })?.code ?? '');
      // The server refused a NEW connection because of its max_connections
      // cap: the pool is healthy and in-flight queries must not be torn down
      // (S-4). The statement never reached the server, so replaying it — even
      // a write — is safe; a second failure propagates to the caller.
      if (code === 'ER_CON_COUNT_ERROR') {
        await new Promise((resolve) => setTimeout(resolve, CON_CAP_RETRY_DELAY_MS));
        return await pool.query(sql, params);
      }
      // A dead socket is only replayable when the statement had no side effects;
      // otherwise the retry can insert a second row. "Never connected" failures
      // are safe for anything.
      const retryable =
        RETRYABLE_PRECONNECT_CODES.has(code) ||
        (RETRYABLE_CONN_CODES.has(code) && READ_ONLY_SQL.test(sql));
      if (retryable) {
        // One retry after forcing a fresh pool.
        await this.close();
        return await (await this.getPool()).query(sql, params);
      }
      throw error;
    }
  }

  prepare(sql: string): D1LikeStatement {
    return new MySqlStatement(this, translateSql(sql), sql);
  }

  /**
   * Remote address the pool actually connected to, or null when it cannot be read.
   *
   * mysql2 exposes the underlying `net.Socket` on the core (non-promise)
   * connection. The admin "test connection" endpoint uses this as the second
   * half of its SSRF guard: the address handed out by the resolver can differ
   * from the one the socket landed on (DNS rebinding), and only the socket knows.
   */
  async peerAddress(): Promise<string | null> {
    const pool = await this.getPool();
    const conn = await pool.getConnection();
    try {
      const core = (conn as unknown as { connection?: { stream?: { remoteAddress?: string } } }).connection;
      return core?.stream?.remoteAddress ?? null;
    } catch {
      return null;
    } finally {
      conn.release();
    }
  }

  async batch(statements: D1LikeStatement[]): Promise<D1LikeResult[]> {
    const pool = await this.getPool();
    const conn = await pool.getConnection();
    const results: D1LikeResult[] = [];
    // NOTE: MySQL DDL is implicitly committing, so a batch that mixes DDL with
    // DML cannot be rolled back as a unit. Schema statements are idempotent, so a
    // partial DDL run is harmless; data batches (the interesting case) do roll
    // back atomically.
    try {
      await conn.beginTransaction();
      for (const statement of statements) {
        const stmt = statement as MySqlStatement;
        // D1 statements are opaque; anything that is not ours cannot be executed
        // here. The old fallback sent `translateSql('')` — an empty query — which
        // surfaced as a confusing 1054/1064 far from the actual mistake.
        if (typeof stmt.getSql !== 'function') {
          throw new Error('[mysql] batch() received a statement that was not created by this database adapter');
        }
        const sql = stmt.getSql();
        const params = typeof stmt.getParams === 'function' ? stmt.getParams() : [];
        try {
          const [rawResult] = await conn.query(sql, params);
          const result = rawResult as { affectedRows?: number; insertId?: number } | unknown[];
          if (Array.isArray(result)) {
            results.push(toResult(result));
          } else {
            results.push(toResult([], result?.affectedRows ?? 0, result?.insertId ?? 0));
          }
        } catch (error) {
          const original = typeof stmt.getOriginalSql === 'function' ? stmt.getOriginalSql() : '';
          if (isDdlStatement(original) && isDuplicateDdlError(error)) {
            results.push(toResult([], 0, 0));
            continue;
          }
          throw error;
        }
      }
      await conn.commit();
      return results;
    } catch (error) {
      try {
        await conn.rollback();
      } catch {
        // ignore rollback failures
      }
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * Retire the current pool.
   *
   * `end()` waits for open queries, so closing synchronously on a config change
   * would fail every request that is mid-flight. Instead we bump the generation
   * (so a concurrent getPool() cannot publish the pool we are dropping) and give
   * in-flight statements a short grace period before the sockets are closed.
   */
  async close(): Promise<void> {
    this.generation += 1;
    const pool = this.pool;
    this.pool = null;
    this.poolPromise = null;
    if (!pool) return;
    const timer = setTimeout(() => {
      void pool.end().catch(() => {
        // ignore: the pool is already gone
      });
    }, 5_000);
    (timer as unknown as { unref?: () => void }).unref?.();
  }
}

export function isMySqlDatabase(db: unknown): db is MySqlDatabase {
  return !!db && typeof db === 'object' && (db as { dialect?: string }).dialect === 'mysql';
}
