/**
 * The D1 schema gate (src/schemaGate.ts): scheduled work runs only once the
 * newest migration in this build is applied.
 *
 * Two things are pinned. The gate's own answers — including that `current`
 * is cached and `pending` is not, which is what lets ingest resume on the
 * first tick after a migration lands. And its PLACEMENT: the chain pass must
 * decline before it reaches the chain or the database's data tables, which a
 * test of the gate alone cannot establish.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import { createSchemaGate, schemaDeclineNotice } from '../src/schemaGate';
import { REQUIRED_D1_MIGRATIONS } from '../src/requiredMigrations';
import { runChainIndexerForChain } from '../src/chainIndexer';
import type { ChainConfig, Env } from '../src/env';

/** wrangler's own DDL for the migrations table. */
const MIGRATIONS_DDL = `CREATE TABLE d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

const applied = (...names: string[]) => {
  const h = createSqliteD1([MIGRATIONS_DDL]);
  for (const n of names) h.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(n);
  return h;
};

const GAP = ['0001_a.sql', '0002_b.sql', '0004_d.sql'];

describe('schema gate — answers', () => {
  it('is current when every required migration is recorded', async () => {
    const h = applied(...REQUIRED_D1_MIGRATIONS);
    expect(await createSchemaGate().check(h.d1 as never)).toEqual({ state: 'current' });
  });

  it('is pending, naming what is missing, when the newest is not recorded', async () => {
    const h = applied(...REQUIRED_D1_MIGRATIONS.slice(0, -1));
    expect(await createSchemaGate().check(h.d1 as never)).toEqual({
      state: 'pending',
      missing: [REQUIRED_D1_MIGRATIONS[REQUIRED_D1_MIGRATIONS.length - 1]],
    });
  });

  it('is pending when a GAP-FILLING migration is missing even though the newest is recorded (#2409 r1)', async () => {
    // 0003 is added later and sorts below 0004 — a newest-only check would
    // call this database current.
    const h = applied(...GAP);
    expect(await createSchemaGate([...GAP, '0003_c.sql'].sort()).check(h.d1 as never)).toEqual({
      state: 'pending',
      missing: ['0003_c.sql'],
    });
  });

  it('is unknown — not pending — when the migrations table cannot be read', async () => {
    // A database wrangler never migrated has no d1_migrations at all. The
    // gate must not claim a specific migration is missing when the probe
    // simply could not tell; it declines all the same.
    const h = createSqliteD1([]);
    expect(await createSchemaGate().check(h.d1 as never)).toEqual({ state: 'unknown' });
  });

  it('caches current, and re-asks after pending (ingest resumes without a redeploy)', async () => {
    const h = applied(...GAP.slice(0, 2));
    const gate = createSchemaGate(GAP);
    expect((await gate.check(h.d1 as never)).state).toBe('pending');
    // The operator applies the migration; the SAME isolate must see it.
    h.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run('0004_d.sql');
    expect((await gate.check(h.d1 as never)).state).toBe('current');
    // Once current, no further read: a migration does not un-apply.
    h.db.exec('DROP TABLE d1_migrations');
    expect((await gate.check(h.d1 as never)).state).toBe('current');
  });

  it('names the missing migrations and the remedy', () => {
    const one = schemaDeclineNotice('this tick', { state: 'pending', missing: ['0054_x.sql'] });
    expect(one).toContain('0054_x.sql');
    expect(one).toContain('d1 migrations apply');
    const many = schemaDeclineNotice('this tick', {
      state: 'pending',
      missing: ['a.sql', 'b.sql', 'c.sql', 'd.sql', 'e.sql'],
    });
    expect(many).toContain('and 2 more');
    expect(schemaDeclineNotice('this tick', { state: 'unknown' })).toContain('could not confirm');
  });
});

describe('schema gate — the chain pass declines before touching chain or data', () => {
  const chain = { id: 84532, rpc: 'https://rpc.invalid', diamond: '0x0' } as unknown as ChainConfig;

  it('returns schema-pending with no RPC request and no cursor read', async () => {
    // Only the migrations table exists: any read of a data table (the
    // cursor, the backfill flags) would throw `no such table`, and any RPC
    // would hit the spy. Either would mean the gate is placed too late.
    const h = applied('0001_init.sql');
    const fetchSpy = vi.fn(async () => {
      throw new Error('RPC reached before the schema gate');
    });
    const env = { DB: h.d1, fetchFn: fetchSpy } as unknown as Env;
    const r = await runChainIndexerForChain(env, chain);
    expect(r.skipped).toBe('schema-pending');
    expect(r.chainId).toBe(84532);
    expect(r.scannedTo).toBe(0n);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('schema gate — the cron tick declines before registering any pass', () => {
  it('registers no pass and resolves no secret while the migration is pending', async () => {
    const { default: worker } = await import('../src/index');
    const h = applied('0001_init.sql');
    const waitUntil = vi.fn();
    // A Secrets Store binding that records being read: the decline must come
    // before `resolveEnv` spends any of them.
    const secretRead = vi.fn(async () => 'https://rpc.invalid');
    const env = {
      DB: h.d1,
      RPC_BASE_SEPOLIA: { get: secretRead },
    } as never;
    await worker.scheduled(
      { scheduledTime: 0, cron: '* * * * *', noRetry() {} } as never,
      env,
      { waitUntil, passThroughOnException() {} } as never,
    );
    expect(waitUntil).not.toHaveBeenCalled();
    expect(secretRead).not.toHaveBeenCalled();
  });
});
