#!/usr/bin/env node
/**
 * scripts/db-env-check.mjs
 *
 * 离线复现 NodeWarden（阿里云 FC / http.Server 版）对 DB_* 环境变量的解析，
 * 用来定位副库 "connection failed (auth)" 时「客户端能连、服务端不能」的错配。
 * 配套教程见仓库根目录 DB-STANDBY-TUTORIAL.md 第八节。
 *
 * 用法：在与 FC 控制台相同的 DB_* 环境变量下运行，例如
 *
 *   DB_HOST=... DB_PASSWORD=... DB_STANDBY_NODES=... node scripts/db-env-check.mjs
 *
 * Windows PowerShell 可用 $env:DB_HOST="..." 逐个设置后运行。
 *
 * 安全：不发起任何网络连接，不打印密码的任何原始字符；只输出长度与
 *       首尾字符的类别（普通字符 / 空白 / 引号），足以定位空格与引号问题。
 * 依据：nodewarden-git/src/services/db-config.ts 的
 *       resolveDbConfigFromEnv / resolveStandbysFromEnv / parseStandbyUrl，
 *       以及 server/node-runtime.ts 的 buildNodeEnv() 白名单。
 */

const env = process.env;

// buildNodeEnv() 真正会读进 env 对象的 DB_* 键（白名单，拼错就完全不生效）
const READ_KEYS = [
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'DB_SSL', 'DB_CONN_LIMIT', 'DB_CONFIG_KEY',
  'DB_STANDBY_NODES', 'DB_STANDBYS', 'DB_STANDBY_NAME',
  'DB_STANDBY_HOST', 'DB_STANDBY_PORT', 'DB_STANDBY_USER',
  'DB_STANDBY_PASSWORD', 'DB_STANDBY_SSL', 'DB_STANDBY_CONN_LIMIT',
];
// 这些由 readEnv() 直读 process.env，不经过白名单
const DIRECT_KEYS = ['DB_SSL_INSECURE', 'DB_SSL_CA', 'DB_TIMEZONE', 'DB_HOST_ALLOWLIST'];

// Never emit any character of a credential: only its length and the *class* of
// the first/last character (a stray space or quote is the usual misconfig).
function characterClass(ch) {
  if (/\s/.test(ch)) return '空白';
  if (/["']/.test(ch)) return '引号';
  return '普通字符';
}
function brief(v) {
  if (v === undefined) return '未设置';
  if (v === '' || v === null) return '空字符串 —— 会被 || 回退，等同没设';
  const s = String(v);
  return `len=${s.length}  首=${characterClass(s[0])} 尾=${characterClass(s[s.length - 1])}`;
}
function flag(raw, fallback) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return !['false', '0', 'no', 'off'].includes(v);
}
function port(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function decode(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}
function line(k, v) { console.log(`  ${k.padEnd(26)} ${v}`); }
function rule() { console.log('─'.repeat(66)); }
// A standby entry may be a full mysql:// URL with an inline password. Print
// only protocol/host/path — never the userinfo — even when the URL is malformed.
function summarizeEntry(entry) {
  if (!entry.includes('://')) return entry;
  try {
    const url = new URL(entry);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(URL 无法解析，credentials 已隐藏)';
  }
}

console.log('\nNodeWarden FC 环境变量自检（离线，不连库，不打印明文密码）\n');
rule();
console.log('一、环境变量存在性（只看键名与脱敏摘要）');
rule();
for (const k of READ_KEYS) {
  if (env[k] !== undefined) line(k, brief(env[k]));
}
for (const k of DIRECT_KEYS) {
  if (env[k] !== undefined) line(`${k} *`, brief(env[k]));
}
console.log('  （* 表示由 readEnv() 直读 process.env，不受白名单限制）');

// 拼写检查：拼错的 DB_* 变量在 FC 上不会报任何错，只是被忽略
const allDbKeys = Object.keys(env).filter((k) => /^DB_/i.test(k));
const ignored = allDbKeys.filter((k) => !READ_KEYS.includes(k) && !DIRECT_KEYS.includes(k));
if (ignored.length > 0) {
  console.log('\n  ⚠ 以下 DB_* 变量不在 buildNodeEnv() 白名单 / readEnv() 已知清单里');
  console.log('     （拼错就完全不生效且不会报错；若是你有意设置的其他变量可忽略）：');
  for (const k of ignored) console.log(`      ${k} = ${brief(env[k])}`);
  console.log(`      可用名：${READ_KEYS.filter((k) => k.startsWith('DB_STANDBY')).join(', ')}`);
}

const primary = {
  host: (env.DB_HOST || '').trim(),
  port: port(env.DB_PORT, 3306),
  user: (env.DB_USER || '').trim(),
  password: env.DB_PASSWORD || '',
  database: (env.DB_NAME || '').trim(),
  ssl: flag(env.DB_SSL, true),
  connectionLimit: port(env.DB_CONN_LIMIT, 5),
};

rule();
console.log('二、主库（DB_*）');
rule();
if (!primary.host) {
  console.log('  ⚠ DB_HOST 未设置：数据库配置走的不是环境变量路径，');
  console.log('    请检查后台保存的集群配置是否被 /tmp 丢失（FC 无持久 KV）。');
} else {
  line('host:port/database', `${primary.host}:${primary.port}/${primary.database}`);
  line('user', primary.user || '(空)');
  line('DB_PASSWORD', brief(primary.password));
  line('ssl', String(primary.ssl));
  line('connectionLimit', String(primary.connectionLimit));
}

// ---- 复现 resolveStandbysFromEnv ----
const defaults = {
  ...primary,
  host: (env.DB_STANDBY_HOST || '').trim() || primary.host,
  port: port(env.DB_STANDBY_PORT ?? env.DB_PORT, primary.port),
  user: (env.DB_STANDBY_USER || '').trim() || primary.user,
  password: env.DB_STANDBY_PASSWORD || primary.password,
  ssl: flag(env.DB_STANDBY_SSL, primary.ssl),
  connectionLimit: port(env.DB_STANDBY_CONN_LIMIT, primary.connectionLimit),
};

const listVars = ['DB_STANDBY_NODES', 'DB_STANDBYS', 'DB_STANDBY_NAME'];
const entries = [];
for (const key of listVars) {
  const raw = env[key];
  if (typeof raw === 'string' && raw.trim()) {
    entries.push(...raw.split(/[,;\r\n]+/).map((s) => s.trim()).filter(Boolean));
  }
}

rule();
console.log('三、副库解析结果（复现 resolveStandbysFromEnv）');
rule();
if (entries.length === 0) {
  console.log('  未发现 DB_STANDBY_NODES / DB_STANDBYS / DB_STANDBY_NAME，环境变量集群只有主库一个节点。');
}

let riskCount = 0;
entries.forEach((entry, i) => {
  const n = i + 1;
  console.log(`\n  副库 ${n}  条目（凭据已隐藏）：${summarizeEntry(entry)}`);

  let parsed;
  let passwordSource;

  if (!entry.includes('://')) {
    parsed = { ...defaults, database: entry };
    passwordSource = env.DB_STANDBY_PASSWORD
      ? 'DB_STANDBY_PASSWORD（显式）'
      : '⚠ 继承主库 DB_PASSWORD';
  } else {
    let url;
    try { url = new URL(entry); }
    catch {
      console.log('    ✗ URL 无法解析，这一条会被跳过，启动日志有 [db-config] malformed 警告');
      riskCount++;
      return;
    }
    const proto = url.protocol.replace(/:$/, '').toLowerCase();
    if (!['mysql', 'mysqls', 'mariadb', 'mariadbs'].includes(proto)) {
      console.log(`    ✗ 协议 ${proto} 不被接受，这一条会被跳过`);
      riskCount++;
      return;
    }
    if (!url.hostname || !url.pathname.replace(/^\/+/, '')) {
      console.log('    ✗ 缺主机或缺库名，这一条会被跳过');
      riskCount++;
      return;
    }
    const sslParam = url.searchParams.get('ssl') ?? url.searchParams.get('tls');
    parsed = {
      ...defaults,
      host: url.hostname,
      port: url.port ? port(url.port, defaults.port) : defaults.port,
      user: url.username ? decode(url.username) : defaults.user,
      password: url.password ? decode(url.password) : defaults.password,
      database: decode(url.pathname.replace(/^\/+/, '')).trim(),
      ssl: sslParam === null ? defaults.ssl : flag(sslParam, defaults.ssl),
    };
    passwordSource = url.password
      ? 'URL 内嵌（已百分号解码）'
      : env.DB_STANDBY_PASSWORD
        ? 'DB_STANDBY_PASSWORD（显式）'
        : '⚠ 继承主库 DB_PASSWORD';

    // 未编码特殊字符的启发式检查
    const userinfo = entry.slice(entry.indexOf('//') + 2, entry.lastIndexOf('@'));
    const bad = ['#', '?', ' ', ',', ';'].filter((c) => userinfo.includes(c));
    if (bad.length > 0) {
      console.log(`    ⚠ userinfo 里出现未编码字符 ${bad.map((c) => JSON.stringify(c)).join(' ')}，`);
      console.log('      URL 解析会把它们当成分隔符，密码很可能已被截断 → 用 %XX 编码');
      riskCount++;
    }
  }

  line(`  host:port/database`, `${parsed.host}:${parsed.port}/${parsed.database}`);
  line(`  user`, parsed.user || '(空)');
  line(`  密码`, `${brief(parsed.password)}  来源：${passwordSource}`);
  line(`  ssl`, String(parsed.ssl));
  line(`  connectionLimit`, String(parsed.connectionLimit));

  const differentServer = parsed.host !== primary.host || parsed.port !== primary.port;
  if (differentServer && passwordSource.startsWith('⚠')) {
    console.log('\n    ⚠⚠ 高危：副库在另一台服务器，却沿用了主库密码。');
    console.log('        这正是「客户端能连、NodeWarden 报 connection failed (auth)」的典型原因。');
    console.log('        修法：显式设置 DB_STANDBY_PASSWORD（非空），或在 URL 里写全 用户:密码@。');
    riskCount++;
  }
  if (differentServer && parsed.password && parsed.password === primary.password) {
    console.log('\n    ⚠ 注意：副库密码与主库密码当前完全相同，请确认这在 SQLPub 上确实成立。');
  }
  if (!parsed.ssl) {
    console.log('\n    ⚠ 该节点 TLS 关闭。若服务端账号 REQUIRE SSL，MySQL 会返回');
    console.log('        "Access denied; SSL connection is required"，同样被归类为 (auth)。');
    console.log('        先试 DB_STANDBY_SSL=true（或 URL 加 ?ssl=true）；');
    console.log('        若转为 TLS 证书错误，再设 DB_SSL_INSECURE=1 或 DB_SSL_CA。');
  }
});

rule();
console.log('四、结论与下一步');
rule();
if (riskCount > 0) {
  console.log(`  发现 ${riskCount} 处可疑点，按上面的 ⚠ 逐条改。`);
} else {
  console.log('  未发现明显的凭据继承 / URL 截断问题。');
  console.log('  下一步查 FC 运行日志里的 [db-config] connection test failed 原始 message（含 1045/3118 与来源 IP）。');
}
console.log('\n  ⚠ buildNodeEnv() 有 sharedEnv 进程内缓存：改完 FC 环境变量必须重新部署，');
console.log('    并确认旧实例已回收（预留实例会一直用旧值），否则改了也不生效。');
console.log('  ⚠ 数据库密码不要贴给我或任何公开环境；本脚本只输出长度与首尾字符的类别，不输出任何原始字符。\n');
