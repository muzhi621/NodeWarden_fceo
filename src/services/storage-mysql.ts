// MySQL adapter exposing the D1 database surface used by NodeWarden's repos
// (prepare().bind().run/first/all + batch). Every statement is translated from
// SQLite/D1 dialect to MySQL via mysql-dialect.ts.
//
// This adapter is intended for Node.js runtimes (EdgeOne Pages Cloud Functions,
// Aliyun FC / Tencent SCF, local `npm run start:node`). On Cloudflare Workers,
// keep using D1 (the default) — mysql2 requires Node TCP sockets.

import { translateSql } from './mysql-dialect';

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
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes('duplicate column name') ||
    msg.includes('duplicate key name') ||
    msg.includes('already exists') ||
    msg.includes('duplicate entry')
  );
}

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

  getParams(): unknown[] {
    return this.params;
  }
}

export class MySqlDatabase implements D1LikeDatabase {
  readonly dialect = 'mysql';
  private pool: MySqlPool | null = null;
  private poolPromise: Promise<MySqlPool> | null = null;

  constructor(private readonly config: MySqlConfig) {}

  getConfig(): MySqlConfig {
    return this.config;
  }

  private async getPool(): Promise<MySqlPool> {
    if (this.pool) return this.pool;
    if (!this.poolPromise) {
      this.poolPromise = (async () => {
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
          timezone: '+08:00',
          enableKeepAlive: true,
          keepAliveInitialDelay: 10_000,
          multipleStatements: false,
          ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
          typeCast: (field: { type: string; string(): string | null }, next: () => unknown) => {
            if (field.type === 'LONGLONG' || field.type === 'NEWDECIMAL') {
              const raw = field.string();
              return raw === null ? null : Number(raw);
            }
            return next();
          },
        });
        this.pool = pool;
        return pool;
      })();
    }
    return this.poolPromise;
  }

  /** Raw query used by the statement wrapper (and health checks). */
  async query(sql: string, params: unknown[]): Promise<[unknown, unknown]> {
    const pool = await this.getPool();
    try {
      return await pool.query(sql, params);
    } catch (error) {
      const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
      if (msg.includes('connection') && (msg.includes('lost') || msg.includes('closed') || msg.includes('reset'))) {
        // One retry after forcing a fresh pool.
        await this.close();
        const fresh = await this.getPool();
        return await fresh.query(sql, params);
      }
      throw error;
    }
  }

  prepare(sql: string): D1LikeStatement {
    return new MySqlStatement(this, translateSql(sql), sql);
  }

  async batch(statements: D1LikeStatement[]): Promise<D1LikeResult[]> {
    const pool = await this.getPool();
    const conn = await pool.getConnection();
    const results: D1LikeResult[] = [];
    try {
      await conn.beginTransaction();
      for (const statement of statements) {
        const stmt = statement as MySqlStatement;
        const sql = typeof stmt.getSql === 'function' ? stmt.getSql() : translateSql('');
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
          const original = (statement as unknown as { originalSql?: string }).originalSql ?? '';
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

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    this.poolPromise = null;
    if (pool) {
      try {
        await pool.end();
      } catch {
        // ignore
      }
    }
  }
}

export function isMySqlDatabase(db: unknown): db is MySqlDatabase {
  return !!db && typeof db === 'object' && (db as { dialect?: string }).dialect === 'mysql';
}
