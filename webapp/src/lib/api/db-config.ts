import type { AuthedFetch } from './shared';
import { parseJson } from './shared';

export interface MaskedDbConfig {
  mode: 'mysql' | 'd1';
  source: 'env' | 'runtime' | 'd1';
  host: string;
  port: number;
  user: string;
  database: string;
  ssl: boolean;
  connectionLimit: number;
  passwordSet: boolean;
}

export interface DbConfigStatus {
  config: MaskedDbConfig;
  runtimeConfigStored: boolean;
  configStoreAvailable: boolean;
  envOverrideActive: boolean;
}

export interface DbConfigTestResult {
  ok: boolean;
  latencyMs: number;
  version?: string;
  schemaState?: string;
  error?: string;
}

export interface DbConfigInput {
  mode?: 'mysql' | 'd1';
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  connectionLimit?: number;
}

export async function getDbConfigStatus(authedFetch: AuthedFetch): Promise<DbConfigStatus> {
  const resp = await authedFetch('/api/admin/db-config');
  if (!resp.ok) throw new Error('Failed to load database config');
  const body = await parseJson<DbConfigStatus>(resp);
  if (!body?.config) throw new Error('Invalid database config response');
  return body;
}

export async function testDbConfig(authedFetch: AuthedFetch, input: DbConfigInput): Promise<DbConfigTestResult> {
  const resp = await authedFetch('/api/admin/db-config/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await parseJson<DbConfigTestResult>(resp);
  return body ?? { ok: false, latencyMs: 0, error: `HTTP ${resp.status}` };
}

export async function saveDbConfig(authedFetch: AuthedFetch, input: DbConfigInput): Promise<{ ok: boolean; error?: string; latencyMs?: number; version?: string; effective?: boolean; schemaReady?: boolean; warning?: string }> {
  const resp = await authedFetch('/api/admin/db-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await parseJson<{ ok: boolean; error?: string; latencyMs?: number; version?: string; effective?: boolean; schemaReady?: boolean; warning?: string }>(resp);
  if (!body) return { ok: false, error: `HTTP ${resp.status}` };
  return body;
}

export async function clearDbConfig(authedFetch: AuthedFetch): Promise<{ ok: boolean }> {
  const resp = await authedFetch('/api/admin/db-config', { method: 'DELETE' });
  const body = await parseJson<{ ok: boolean }>(resp);
  return body ?? { ok: false };
}
