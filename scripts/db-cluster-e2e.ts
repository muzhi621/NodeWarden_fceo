// Real-database E2E for the multi-node cluster: two throwaway schemas on the
// local MySQL, the real adapter, the real sync SQL. Creates and drops both.
import fs from 'node:fs';
import mysql from 'mysql2/promise';
import { MySqlClusterDatabase } from '../src/services/db-cluster';
import { syncDatabase } from '../src/services/db-cluster-sync';
import { MySqlDatabase } from '../src/services/storage-mysql';
import { StorageService } from '../src/services/storage';

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
