// Tests for env-declared standbys (DB_STANDBY_NODES and its aliases).
// Run: npx tsx --test scripts/db-config-env-standby.test.ts
//
// Why this exists: a DB_* deployment could not sync at all. The effective
// cluster was a single node, so "sync to standby" had no target, while the
// admin-saved cluster was shadowed *and* — on FC — stored in /tmp, i.e. gone on
// the next cold start. The standby list makes those nodes part of the env
// config, which is the one form of configuration that survives a restart.
//
// The list is a list, not a single name: how many standbys exist, what they are
// called and where they live are all deployment decisions, so nothing here may
// assume "one standby called nodewarden-bak".

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveDbCluster,
  resolveDbConfigFromEnv,
  resolveStandbysFromEnv,
} from '../src/services/db-config';
import { passwordSourceOf, resolveNodeFallback } from '../src/handlers/admin-db-config';
import type { Env } from '../src/types';

const base = {
  DB_HOST: 'mysql.example.com',
  DB_PORT: '3307',
  DB_USER: 'nodewarden',
  DB_PASSWORD: 'secret',
  DB_NAME: 'nodewarden',
};

const asEnv = (overrides: Record<string, unknown> = {}) => ({ ...base, ...overrides }) as unknown as Env;

// Regression: the per-node "test" button resolved an untouched password field
// against `stored` only, then fell back to `nodes[0]` — the primary. On FC a
// DB_*-described cluster has no stored config, so an env standby on another
// server was always probed with the primary password and reported
// `connection failed (auth)` even when its URL was correct.
test('the test button inherits the env standby password, not the primary one', async () => {
  const env = asEnv({
    DB_STANDBY_NODES: 'mysql://standbyuser:standbypass@other.example.com:3306/nw_bak?ssl=true&conn=2',
  });
  const cluster = await resolveDbCluster(env);
  const primary = cluster.nodes.find((node) => node.id === 'env-primary');
  const standby = cluster.nodes.find((node) => node.id === 'env-standby-1');
  assert.ok(primary && standby);
  assert.equal(primary.password, 'secret');
  assert.equal(standby.password, 'standbypass');
  assert.equal(standby.passwordInherited, false);

  const fallback = resolveNodeFallback('env-standby-1', null, cluster.nodes);
  assert.equal(fallback?.id, 'env-standby-1');
  assert.equal(fallback?.password, 'standbypass', 'must not inherit the primary password');
  assert.equal(passwordSourceOf({}, fallback), 'env');
});

test('a different-server standby without its own password is flagged as inherited', async () => {
  const env = asEnv({ DB_STANDBY_NODES: 'mysql://standbyuser@other.example.com:3306/nw_bak' });
  const cluster = await resolveDbCluster(env);
  const standby = cluster.nodes.find((node) => node.id === 'env-standby-1');
  assert.ok(standby);
  assert.equal(standby.password, 'secret');
  assert.equal(standby.passwordInherited, true);
  const fallback = resolveNodeFallback('env-standby-1', null, cluster.nodes);
  assert.equal(passwordSourceOf({}, fallback), 'inherited-primary');
});

test('a same-server schema correctly inherits the primary account without a warning', async () => {
  const cluster = await resolveDbCluster(asEnv({ DB_STANDBY_NODES: 'nw_bak' }));
  const standby = cluster.nodes.find((node) => node.id === 'env-standby-1');
  assert.ok(standby);
  assert.equal(standby.password, 'secret');
  assert.equal(standby.passwordInherited, false, 'same server/account is an intentional inheritance');
});

test('DB_STANDBY_PASSWORD counts as the standby own credential', async () => {
  const env = asEnv({ DB_STANDBY_NODES: 'nw_bak', DB_STANDBY_PASSWORD: 'ownpass' });
  const cluster = await resolveDbCluster(env);
  const standby = cluster.nodes.find((node) => node.id === 'env-standby-1');
  assert.ok(standby);
  assert.equal(standby.password, 'ownpass');
  assert.equal(standby.passwordInherited, false);
});

test('a stale saved node never overrides the effective env credential', async () => {
  const env = asEnv({ DB_STANDBY_NODES: 'mysql://standbyuser:standbypass@other.example.com:3306/nw_bak' });
  const cluster = await resolveDbCluster(env);
  const stale = {
    version: 2,
    mode: 'mysql',
    nodes: [{ ...cluster.nodes[1], password: '' }],
    policy: cluster.policy,
  };
  const fallback = resolveNodeFallback('env-standby-1', stale as never, cluster.nodes);
  assert.equal(fallback?.password, 'standbypass');
});

test('a typed password wins and an unknown id falls back to the primary', async () => {
  const cluster = await resolveDbCluster(asEnv({ DB_STANDBY_NODES: 'nw_bak' }));
  const fallback = resolveNodeFallback('env-standby-1', null, cluster.nodes);
  assert.equal(passwordSourceOf({ password: 'typed' }, fallback), 'form');
  assert.equal(passwordSourceOf({ clearPassword: true }, fallback), 'cleared');
  assert.equal(passwordSourceOf({}, null), 'unset');
  assert.equal(resolveNodeFallback('does-not-exist', null, cluster.nodes)?.id, 'env-primary');
});

test('without a standby list the cluster stays a single node', async () => {
  const cluster = await resolveDbCluster(asEnv());
  assert.equal(cluster.mode, 'mysql');
  assert.equal(cluster.source, 'env');
  assert.equal(cluster.nodes.length, 1);
  assert.equal(cluster.nodes[0].id, 'env-primary');
  // Nothing changed for existing deployments: failover is still on.
  assert.equal(cluster.policy.failoverEnabled, true);
});

test('a bare schema name inherits the primary connection', async () => {
  const env = asEnv({ DB_STANDBY_NODES: 'nw_bak_2024' });
  const standbys = resolveStandbysFromEnv(env);
  assert.equal(standbys.length, 1);
  // Everything not given explicitly comes from DB_*: one variable is enough for
  // the common "several schemas, one instance" layout.
  assert.equal(standbys[0].database, 'nw_bak_2024');
  assert.equal(standbys[0].host, 'mysql.example.com');
  assert.equal(standbys[0].port, 3307);
  assert.equal(standbys[0].user, 'nodewarden');
  assert.equal(standbys[0].password, 'secret');

  const cluster = await resolveDbCluster(env);
  assert.equal(cluster.nodes.length, 2);
  assert.equal(cluster.nodes[1].id, 'env-standby-1');
  assert.equal(cluster.nodes[1].role, 'replica');
  assert.equal(cluster.nodes[1].database, 'nw_bak_2024');
  assert.match(cluster.nodes[1].label, /nw_bak_2024/);
});

test('the list holds as many standbys as the deployment has, in order', async () => {
  const env = asEnv({ DB_STANDBY_NODES: 'alpha, beta;gamma' });
  const standbys = resolveStandbysFromEnv(env);
  assert.deepEqual(
    standbys.map((node) => node.database),
    ['alpha', 'beta', 'gamma']
  );

  const cluster = await resolveDbCluster(env);
  assert.equal(cluster.nodes.length, 4);
  assert.deepEqual(
    cluster.nodes.map((node) => node.id),
    ['env-primary', 'env-standby-1', 'env-standby-2', 'env-standby-3']
  );
  assert.deepEqual(
    cluster.nodes.map((node) => node.priority),
    [1, 2, 3, 4]
  );
});

test('a standby entry may be a full URL on another server', async () => {
  const env = asEnv({
    DB_STANDBY_NODES:
      'mysql://dr_user:p%40ss@10.0.0.5:3308/nw_dr?ssl=false&conn=3, same_instance_copy',
  });
  const standbys = resolveStandbysFromEnv(env);
  assert.equal(standbys.length, 2);

  const [url, bare] = standbys;
  assert.equal(url.host, '10.0.0.5');
  assert.equal(url.port, 3308);
  assert.equal(url.user, 'dr_user');
  assert.equal(url.password, 'p@ss');
  assert.equal(url.database, 'nw_dr');
  assert.equal(url.ssl, false);
  assert.equal(url.connectionLimit, 3);

  // The bare entry next to it still inherits the primary, not the URL above.
  assert.equal(bare.host, 'mysql.example.com');
  assert.equal(bare.database, 'same_instance_copy');
});

test('a URL without credentials falls back to the primary account', async () => {
  const env = asEnv({ DB_STANDBY_NODES: 'mysql://10.0.0.9/nw_dr' });
  const standby = resolveStandbysFromEnv(env)[0];
  assert.ok(standby);
  assert.equal(standby.host, '10.0.0.9');
  assert.equal(standby.port, 3307);
  assert.equal(standby.user, 'nodewarden');
  assert.equal(standby.password, 'secret');
  assert.equal(standby.ssl, true);
});

test('an env standby never takes over automatically', async () => {
  // This is the safety property that makes the manual copy usable: in `native`
  // mode the app cannot tell a synced standby from an empty schema, so an
  // automatic promotion after a brief primary hiccup would serve an empty
  // `users` table and lock everyone out.
  const cluster = await resolveDbCluster(asEnv({ DB_STANDBY_NODES: 'a,b' }));
  assert.equal(cluster.policy.failoverEnabled, false);
  assert.equal(cluster.policy.readSplit, false);
  assert.equal(cluster.policy.syncMode, 'native');
});

test('a standby pointing at the primary schema is ignored, not treated as a copy target', async () => {
  const env = asEnv({ DB_STANDBY_NODES: 'nodewarden,real_copy' });
  const standbys = resolveStandbysFromEnv(env);
  assert.deepEqual(
    standbys.map((node) => node.database),
    ['real_copy']
  );
  const cluster = await resolveDbCluster(asEnv({ DB_STANDBY_NODES: 'nodewarden' }));
  assert.equal(cluster.nodes.length, 1);
});

test('the same schema listed twice is copied once', () => {
  const standbys = resolveStandbysFromEnv(asEnv({ DB_STANDBY_NODES: 'dup,dup,mysql://mysql.example.com:3307/dup' }));
  assert.deepEqual(
    standbys.map((node) => node.database),
    ['dup']
  );
});

test('the legacy DB_STANDBY_* defaults still apply to bare entries', async () => {
  const env = asEnv({
    DB_STANDBY_NODES: 'nw_standby',
    DB_STANDBY_HOST: 'mysql-2.example.com',
    DB_STANDBY_PORT: '3308',
    DB_STANDBY_USER: 'standby_reader',
    DB_STANDBY_PASSWORD: 'other',
    DB_STANDBY_SSL: 'false',
    DB_STANDBY_CONN_LIMIT: '3',
  });
  const standby = resolveStandbysFromEnv(env)[0];
  assert.ok(standby);
  assert.equal(standby.host, 'mysql-2.example.com');
  assert.equal(standby.port, 3308);
  assert.equal(standby.user, 'standby_reader');
  assert.equal(standby.password, 'other');
  assert.equal(standby.ssl, false);
  assert.equal(standby.connectionLimit, 3);
});

test('the singular variable shipped in v1.8.11 is still read', async () => {
  for (const name of ['DB_STANDBY_NAME', 'DB_STANDBYS']) {
    const cluster = await resolveDbCluster(asEnv({ [name]: 'old_style' }));
    assert.equal(cluster.nodes.length, 2, `${name} should still add a standby`);
    assert.equal(cluster.nodes[1].database, 'old_style');
  }
});

test('all three spellings accumulate into one list', () => {
  const standbys = resolveStandbysFromEnv(
    asEnv({ DB_STANDBY_NODES: 'from_list', DB_STANDBYS: 'from_plural', DB_STANDBY_NAME: 'from_singular' })
  );
  assert.deepEqual(
    standbys.map((node) => node.database),
    ['from_list', 'from_plural', 'from_singular']
  );
});

test('the standby inherits DB_SSL and the pool size when it does not set them', async () => {
  const env = asEnv({ DB_SSL: 'false', DB_CONN_LIMIT: '7', DB_STANDBY_NODES: 'nw_bak' });
  const standby = resolveStandbysFromEnv(env)[0];
  assert.equal(standby?.ssl, false);
  assert.equal(standby?.connectionLimit, 7);
});

test('no standby list is read without DB_HOST', () => {
  assert.equal(resolveDbConfigFromEnv({ DB_STANDBY_NODES: 'x' } as unknown as Env), null);
  assert.equal(resolveStandbysFromEnv({ DB_STANDBY_NODES: 'x' } as unknown as Env).length, 0);
});

test('an empty list is the same as not setting it', () => {
  assert.equal(resolveStandbysFromEnv(asEnv({ DB_STANDBY_NODES: '  ,  ; ' })).length, 0);
});

test('malformed entries are skipped without losing the valid ones', () => {
  const standbys = resolveStandbysFromEnv(
    asEnv({ DB_STANDBY_NODES: 'mysql:///no-database, https://example.com/x, good_one' })
  );
  // Neither a schemaless URL nor a non-MySQL protocol may abort the list: the
  // valid entry after them must still be copied into.
  assert.deepEqual(
    standbys.map((node) => node.database),
    ['good_one']
  );
});

test('standbys are capped at the cluster node limit', () => {
  const standbys = resolveStandbysFromEnv(asEnv({ DB_STANDBY_NODES: 'a,b,c,d,e,f,g,h,i,j' }));
  assert.equal(standbys.length, 7);
});

test('a dropped entry never prints its password', () => {
  // Every message that quotes an entry ends up in the platform log, and a URL
  // entry carries credentials. A typo — or a standby that turns out to be the
  // primary — must not turn the database password into a log line.
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void seen.push(args.map(String).join(' '));
  try {
    resolveStandbysFromEnv(
      asEnv({
        DB_NAME: 'nodewarden-bak',
        DB_STANDBY_NODES: 'mysql://bak_user:liwu1454994390@mysql.example.com:3307/nodewarden-bak',
      })
    );
  } finally {
    console.warn = original;
  }
  const text = seen.join('\n');
  assert.match(text, /nodewarden-bak/, 'the host and schema must stay readable');
  assert.ok(text.includes('bak_user:***@'), 'the account must stay readable; only the secret is removed');
  assert.doesNotMatch(text, /liwu1454994390/, 'the password must not reach the log');
});
