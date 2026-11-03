// Tests for the env-declared standby (DB_STANDBY_*).
// Run: npx tsx --test scripts/db-config-env-standby.test.ts
//
// Why this exists: a DB_* deployment could not sync at all. The effective
// cluster was a single node, so "sync to standby" had no target, while the
// admin-saved cluster was shadowed *and* — on FC — stored in /tmp, i.e. gone on
// the next cold start. `DB_STANDBY_NAME` makes the standby part of the env
// config, which is the one form of configuration that survives a restart.

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDbCluster, resolveDbConfigFromEnv, resolveStandbyFromEnv } from '../src/services/db-config';
import type { Env } from '../src/types';

const base = {
  DB_HOST: 'mysql.example.com',
  DB_PORT: '3307',
  DB_USER: 'nodewarden',
  DB_PASSWORD: 'secret',
  DB_NAME: 'nodewarden',
};

const asEnv = (overrides: Record<string, unknown> = {}) => ({ ...base, ...overrides }) as unknown as Env;

test('without DB_STANDBY_NAME the cluster stays a single node', async () => {
  const cluster = await resolveDbCluster(asEnv());
  assert.equal(cluster.mode, 'mysql');
  assert.equal(cluster.source, 'env');
  assert.equal(cluster.nodes.length, 1);
  assert.equal(cluster.nodes[0].id, 'env-primary');
  // Nothing changed for existing deployments: failover is still on.
  assert.equal(cluster.policy.failoverEnabled, true);
});

test('DB_STANDBY_NAME adds a standby schema that inherits the primary connection', async () => {
  const env = asEnv({ DB_STANDBY_NAME: 'nodewarden-bak' });
  const standby = resolveStandbyFromEnv(env);
  assert.ok(standby, 'expected a standby');
  assert.equal(standby?.database, 'nodewarden-bak');
  // Everything not given explicitly comes from DB_*: one variable is enough for
  // the common "two schemas, one instance" layout.
  assert.equal(standby?.host, 'mysql.example.com');
  assert.equal(standby?.port, 3307);
  assert.equal(standby?.user, 'nodewarden');
  assert.equal(standby?.password, 'secret');

  const cluster = await resolveDbCluster(env);
  assert.equal(cluster.nodes.length, 2);
  assert.equal(cluster.nodes[1].id, 'env-standby');
  assert.equal(cluster.nodes[1].role, 'replica');
  assert.equal(cluster.nodes[1].database, 'nodewarden-bak');
});

test('an env standby never takes over automatically', async () => {
  // This is the safety property that makes the manual copy usable: in `native`
  // mode the app cannot tell a synced standby from an empty schema, so an
  // automatic promotion after a brief primary hiccup would serve an empty
  // `users` table and lock everyone out.
  const cluster = await resolveDbCluster(asEnv({ DB_STANDBY_NAME: 'nodewarden-bak' }));
  assert.equal(cluster.policy.failoverEnabled, false);
  assert.equal(cluster.policy.readSplit, false);
  assert.equal(cluster.policy.syncMode, 'native');
});

test('a standby pointing at the primary schema is ignored, not treated as a copy target', async () => {
  const env = asEnv({ DB_STANDBY_NAME: 'nodewarden' });
  assert.equal(resolveStandbyFromEnv(env), null);
  const cluster = await resolveDbCluster(env);
  assert.equal(cluster.nodes.length, 1);
});

test('a standby may live on another host and override each setting', async () => {
  const env = asEnv({
    DB_STANDBY_NAME: 'nw_standby',
    DB_STANDBY_HOST: 'mysql-2.example.com',
    DB_STANDBY_PORT: '3308',
    DB_STANDBY_USER: 'standby_reader',
    DB_STANDBY_PASSWORD: 'other',
    DB_STANDBY_SSL: 'false',
    DB_STANDBY_CONN_LIMIT: '3',
  });
  const standby = resolveStandbyFromEnv(env);
  assert.ok(standby);
  assert.equal(standby?.host, 'mysql-2.example.com');
  assert.equal(standby?.port, 3308);
  assert.equal(standby?.user, 'standby_reader');
  assert.equal(standby?.password, 'other');
  assert.equal(standby?.ssl, false);
  assert.equal(standby?.connectionLimit, 3);
});

test('the standby inherits DB_SSL and the pool size when it does not set them', async () => {
  const env = asEnv({ DB_SSL: 'false', DB_CONN_LIMIT: '7', DB_STANDBY_NAME: 'nodewarden-bak' });
  const standby = resolveStandbyFromEnv(env);
  assert.equal(standby?.ssl, false);
  assert.equal(standby?.connectionLimit, 7);
});

test('DB_STANDBY_* without DB_HOST describes nothing', () => {
  assert.equal(resolveDbConfigFromEnv({ DB_STANDBY_NAME: 'x' } as unknown as Env), null);
  assert.equal(resolveStandbyFromEnv({ DB_STANDBY_NAME: 'x' } as unknown as Env), null);
});

test('an empty DB_STANDBY_NAME is the same as not setting it', () => {
  assert.equal(resolveStandbyFromEnv(asEnv({ DB_STANDBY_NAME: '   ' })), null);
});
