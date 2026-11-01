// Real-database E2E for the multi-node cluster: two throwaway schemas on the
// local MySQL, the real adapter, the real sync SQL. Creates and drops both.
import fs from 'node:fs';
import mysql from 'mysql2/promise';
import { MySqlClusterDatabase } from '../src/services/db-cluster';
import { syncDatabase } from '../src/services/db-cluster-sync';
import { MySqlDatabase } from '../src/services/storage-mysql';
import { StorageService } from '../src/services/storage';
import { handleAdminPromoteDbNode } from '../src/handlers/admin-db-config';
import {
  deleteNodeSyncStates,
  loadRuntimeConfig,
  nodeFingerprint,
  saveNodeSyncState,
  saveRuntimeConfig,
  type DbRuntimeConfigV2,
} from '../src/services/db-config';
import { getDatabase, resetDatabaseCache } from '../src/services/storage-factory';
import { resetDbLifecycle } from '../src/services/db-lifecycle';

if (!fs.existsSync('.smoke-db.json')) {
  console.error(
    '缺少 .smoke-db.json：本脚本会在该实例上临时创建并删除两个库（nw_ha_e2e_a / nw_ha_e2e_b）。\n' +
      '文件格式：{"host":"127.0.0.1","port":3306,"user":"root","password":""}'
  );
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync('.smoke-db.json', 'utf8')) as {
  host: string;
  port?: number;
  user: string;
  password?: string;
};

const DB_A = 'nw_ha_e2e_a';
const DB_B = 'nw_ha_e2e_b';

const base = {
  host: cfg.host,
  port: cfg.port ?? 3306,
  user: cfg.user,
  password: cfg.password ?? '',
  ssl: false,
  connectionLimit: 4,
  connectTimeoutMs: 10_000,
};

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const admin = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port ?? 3306,
    user: cfg.user,
    password: cfg.password ?? '',
    ssl: false,
  });
  for (const name of [DB_A, DB_B]) {
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  }

  const dbA = new MySqlDatabase({ ...base, database: DB_A });
  const dbB = new MySqlDatabase({ ...base, database: DB_B });
  try {
    await new StorageService(dbA as never).initializeDatabase();
    await new StorageService(dbB as never).initializeDatabase();

    // 300 simple rows so the row cap and the cursor get exercised for real.
    for (let i = 0; i < 300; i += 1) {
      const key = `cfg-${String(i).padStart(3, '0')}`;
      await dbA.prepare('INSERT INTO config (key, value) VALUES (?, ?)').bind(key, 'v').run();
    }

    console.log('\n== B-3/C-4: cursor paging across calls (real SQL) ==');
    const first = await syncDatabase(dbA as never, dbB as never, { chunkSize: 100, maxRowsPerTable: 200 });
    check('first run stops at the cap', first.truncated === true, `rows=${first.rowsWritten}`);
    check('a cursor is returned', typeof first.cursors.config?.[0] === 'string', JSON.stringify(first.cursors.config));
    const bAfterFirst = await dbB.prepare('SELECT COUNT(*) AS n FROM config').first<{ n: number }>();
    // 200 rows at the cap plus whatever the schema seeded on the target.
    check(
      'the cap is honoured on the target',
      first.rowsWritten === 200 && Number(bAfterFirst?.n) >= 200,
      `written=${first.rowsWritten} target config rows=${bAfterFirst?.n}`
    );

    const second = await syncDatabase(dbA as never, dbB as never, {
      chunkSize: 100,
      maxRowsPerTable: 500,
      cursors: first.cursors,
    });
    check('the resume run finishes the table', second.truncated === false && second.complete === true);
    check('counts match afterwards', second.tables.every((t) => t.countMatches !== false), JSON.stringify(second.tables.map((t) => [t.table, t.sourceRows, t.targetRows])));
    const aTotal = await dbA.prepare('SELECT COUNT(*) AS n FROM config').first<{ n: number }>();
    const bTotal = await dbB.prepare('SELECT COUNT(*) AS n FROM config').first<{ n: number }>();
    check('every row arrived', Number(bTotal?.n) === Number(aTotal?.n), `source=${aTotal?.n} target=${bTotal?.n}`);

    console.log('\n== B-2: merge never downgrades, overwrite does ==');
    await dbB.prepare("UPDATE config SET value = 'NEW' WHERE key = 'cfg-000'").run();
    await syncDatabase(dbA as never, dbB as never, { mode: 'merge' });
    const afterMerge = await dbB.prepare("SELECT value FROM config WHERE key = 'cfg-000'").first<{ value: string }>();
    check('merge keeps the newer target value', afterMerge?.value === 'NEW', `value=${afterMerge?.value}`);

    await syncDatabase(dbA as never, dbB as never, { mode: 'overwrite' });
    const afterOverwrite = await dbB.prepare("SELECT value FROM config WHERE key = 'cfg-000'").first<{ value: string }>();
    check('overwrite replaces it with the source value', afterOverwrite?.value === 'v', `value=${afterOverwrite?.value}`);

    console.log('\n== write-through on a real cluster ==');
    const cluster = new MySqlClusterDatabase(
      [
        { ...base, database: DB_A, id: 'a', label: 'primary', role: 'primary', priority: 1 },
        { ...base, database: DB_B, id: 'b', label: 'replica', role: 'replica', priority: 2, syncReady: true },
      ],
      {
        readSplit: false,
        syncMode: 'write-through',
        syncAsync: false,
        failoverEnabled: true,
        failureThreshold: 3,
        cooldownMs: 30_000,
      }
    );
    try {
      await cluster.prepare('INSERT INTO config (key, value) VALUES (?, ?)').bind('cfg-wt', 'both').run();
      const inA = await dbA.prepare("SELECT value FROM config WHERE key = 'cfg-wt'").first<{ value: string }>();
      const inB = await dbB.prepare("SELECT value FROM config WHERE key = 'cfg-wt'").first<{ value: string }>();
      check('the write landed on the primary', inA?.value === 'both');
      check('and was replayed on the standby', inB?.value === 'both');
      const health = cluster.nodeHealth();
      check('no node is behind after the write', health.every((node) => node.lag === 0), JSON.stringify(health.map((n) => [n.id, n.lag, n.missedWrites])));
    } finally {
      await cluster.close();
    }

    await promoteSection(dbA, dbB);
  } finally {
    await dbA.close();
    await dbB.close();
    for (const name of [DB_A, DB_B]) {
      await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    }
    await admin.end();
    console.log('\ncleaned up both schemas');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
/**
 * End-to-end "switch the writer" against two real schemas.
 *
 * The admin endpoint persists a config, so this drives it exactly as the page
 * does: a memory KV as the config store, the real handler, the real pools. The
 * proof that the switch worked is not the HTTP status — it is that the *next*
 * write lands on the other database and is replayed back to the old one.
 */
async function promoteSection(dbA: MySqlDatabase, dbB: MySqlDatabase): Promise<void> {
  console.log('\n== promote: switching the writer (real databases) ==');
  // Loopback is blocked by the SSRF policy unless the operator opts in; that is
  // the documented escape hatch for "my MySQL is in the same VPC".
  process.env.DB_HOST_ALLOWLIST = cfg.host;
  for (const key of ['DB_HOST', 'DB_USER', 'DB_NAME', 'DB_PASSWORD']) delete process.env[key];

  const entries = new Map<string, string>();
  const env = {
    SETTINGS_KV: {
      get: async (key: string) => entries.get(key) ?? null,
      put: async (key: string, value: string) => {
        entries.set(key, value);
      },
      delete: async (key: string) => {
        entries.delete(key);
      },
    },
    DB_CONFIG_KEY: 'e2e-passphrase-for-db-config',
    DB: null,
  } as unknown as Record<string, unknown>;

  const nodeA = {
    id: 'a',
    label: '主库A',
    role: 'primary' as const,
    priority: 1,
    enabled: true,
    host: cfg.host,
    port: cfg.port ?? 3306,
    user: cfg.user,
    password: cfg.password ?? '',
    database: DB_A,
    ssl: false,
    connectionLimit: 4,
  };
  const nodeB = {
    ...nodeA,
    id: 'b',
    label: '副库B',
    role: 'replica' as const,
    priority: 2,
    database: DB_B,
  };
  const stored: DbRuntimeConfigV2 = {
    version: 2,
    mode: 'mysql',
    nodes: [nodeA, nodeB],
    policy: {
      readSplit: false,
      syncMode: 'write-through',
      syncAsync: false,
      failoverEnabled: true,
      failureThreshold: 3,
      cooldownMs: 30_000,
    },
  };

  const actor = { id: 'e2e-admin', email: 'admin@example.com' } as never;
  const promote = (nodeId: string, force = false) =>
    handleAdminPromoteDbNode(
      new Request(`https://example.com/api/admin/db-config/promote${force ? '?force=1' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId, force }),
      }),
      env as never,
      actor
    );

  try {
    await saveRuntimeConfig(env as never, stored);
    // B was backfilled, so it may take over. The record is what the gate reads.
    await saveNodeSyncState(env as never, 'b', {
      at: Date.now(),
      complete: true,
      truncated: false,
      rowsWritten: 0,
      tables: 0,
      sourceId: 'a',
      fingerprint: nodeFingerprint(nodeB),
    });

    const response = await promote('b');
    const body = (await response.json()) as {
      ok?: boolean;
      promoted?: { id: string };
      demoted?: { id: string } | null;
      forced?: boolean;
      error?: string;
    };
    check('a synced, level standby is promoted', response.status === 200 && body.ok === true, body.error ?? '');
    check('the response names both nodes', body.promoted?.id === 'b' && body.demoted?.id === 'a');
    check('it was not a forced switch', body.forced === false);

    const reloaded = await loadRuntimeConfig(env as never);
    const roleOf = (id: string) => reloaded?.nodes.find((node) => node.id === id)?.role;
    check('the stored config swapped the roles', roleOf('b') === 'primary' && roleOf('a') === 'replica');
    check(
      'priorities are dense and the new primary is first',
      reloaded?.nodes[0].id === 'b' && reloaded?.nodes[0].priority === 1 && reloaded?.nodes[1].priority === 2,
      JSON.stringify(reloaded?.nodes.map((node) => [node.id, node.role, node.priority]))
    );

    await resetDatabaseCache();
    resetDbLifecycle();
    const db = await getDatabase(env as never);
    await db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').bind('cfg-promoted', 'after-switch').run();
    const inB = await dbB.prepare("SELECT value FROM config WHERE key = 'cfg-promoted'").first<{ value: string }>();
    const inA = await dbA.prepare("SELECT value FROM config WHERE key = 'cfg-promoted'").first<{ value: string }>();
    check('the next write landed on the new primary', inB?.value === 'after-switch', `B=${inB?.value}`);
    check('and was replayed to the demoted node', inA?.value === 'after-switch', `A=${inA?.value}`);

    // A was level when it was demoted, so it must still be usable — the switch
    // may not quietly turn the old primary into dead weight.
    const backToA = await promote('a');
    check('the demoted node can be promoted back', backToA.status === 200, `status=${backToA.status}`);

    // A replica that never completed a sync must not be allowed to take over.
    await deleteNodeSyncStates(env as never, ['b']);
    await resetDatabaseCache();
    resetDbLifecycle();
    const blocked = await promote('b');
    const blockedBody = (await blocked.json()) as { blocked?: boolean; reasons?: string[]; error?: string };
    check('an unsynced standby is refused with 409', blocked.status === 409 && blockedBody.blocked === true);
    check(
      'the refusal names the missing sync',
      (blockedBody.reasons ?? []).some((reason) => reason.includes('同步')),
      JSON.stringify(blockedBody.reasons)
    );
    check(
      'the refused switch did not touch the config',
      (await loadRuntimeConfig(env as never))?.nodes.find((node) => node.id === 'a')?.role === 'primary'
    );

    const forced = await promote('b', true);
    const forcedBody = (await forced.json()) as { ok?: boolean; forced?: boolean; warning?: string };
    check('force overrides the gate', forced.status === 200 && forcedBody.ok === true);
    check('and the response says what will be missing', (forcedBody.warning ?? '').includes('原主库'), forcedBody.warning ?? '');
  } catch (error) {
    check('promote section ran without throwing', false, error instanceof Error ? error.message : String(error));
  } finally {
    await resetDatabaseCache();
    resetDbLifecycle();
    delete process.env.DB_HOST_ALLOWLIST;
  }
}
