/**
 * The one-runner lease (#2503), against the real migration DDL on SQLite:
 * the claim is one upsert whose WHERE decides who may hold the row, so the
 * behaviour IS the SQL and is tested on a real engine. Since #1722 the DDL is
 * the keeper's PRIVATE migration, the only database the lease is claimed in.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { claimRunnerLease, LEASE_MAX_TERM_MS, LEASE_TTL_MS } from '../src/runnerLease';
import { runKeeperTick } from '../src/tick';
import { createTickRunner } from '../host/scheduler';
import { buildHostEnv } from '../host/hostEnv';
import { createSqliteD1 } from './helpers/sqliteD1';

const DDL = readFileSync(
  new URL('../migrations/0009_keeper_runner_lease.sql', import.meta.url),
  'utf8',
);

function fresh() {
  const { d1, db } = createSqliteD1([DDL]);
  return { db: d1 as D1Database, raw: db };
}

const T0 = 1_760_000_000_000;

/** Ages the lease row by `ms`, as if that much time passed on the database's clock. */
function age(raw: ReturnType<typeof fresh>['raw'], ms: number) {
  raw.prepare('UPDATE keeper_runner_lease SET acquired_at = acquired_at - ?1, renewed_at = renewed_at - ?1, expires_at = expires_at - ?1').run(ms);
}

describe('claimRunnerLease', () => {
  it('lets the first runner acquire, and renews for the same runner', async () => {
    const { db, raw } = fresh();
    const before = Date.now();
    expect(await claimRunnerLease(db, 'host:a')).toEqual({ held: true, acquired: true });
    const first = raw.prepare('SELECT acquired_at, renewed_at, expires_at FROM keeper_runner_lease').get() as Record<string, number>;
    // The time is the database's own clock (here the same machine's, so it
    // brackets this test's), and the expiry is that time plus the TTL.
    expect(first.acquired_at).toBeGreaterThanOrEqual(before - 1000);
    expect(first.acquired_at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(first.expires_at).toBe(first.renewed_at + LEASE_TTL_MS);
    age(raw, 60_000);
    expect(await claimRunnerLease(db, 'host:a')).toEqual({ held: true, acquired: false });
    const second = raw.prepare('SELECT acquired_at, renewed_at, expires_at FROM keeper_runner_lease').get() as Record<string, number>;
    expect(second.acquired_at).toBe(first.acquired_at - 60_000);
    expect(second.expires_at).toBe(second.renewed_at + LEASE_TTL_MS);
  });

  it('refuses another runner while the lease is live, and names the holder', async () => {
    const { db, raw } = fresh();
    await claimRunnerLease(db, 'host:a');
    age(raw, LEASE_TTL_MS - 60_000);
    const claim = await claimRunnerLease(db, 'cloudflare-worker');
    expect(claim.held).toBe(false);
    expect(claim.held === false && claim.reason).toContain('"host:a" holds the one-runner lease until');
    expect(raw.prepare('SELECT holder FROM keeper_runner_lease').get()).toEqual({ holder: 'host:a' });
  });

  it('hands over once the holder stops renewing', async () => {
    const { db, raw } = fresh();
    await claimRunnerLease(db, 'host:a');
    age(raw, LEASE_TTL_MS);
    expect(await claimRunnerLease(db, 'host:b')).toEqual({ held: true, acquired: true });
    expect(raw.prepare('SELECT holder FROM keeper_runner_lease').get()).toEqual({ holder: 'host:b' });
    // The old holder, coming back, is now the one refused.
    expect((await claimRunnerLease(db, 'host:a')).held).toBe(false);
  });

  it('takes a lease whose expiry lies past the maximum term, whoever wrote it (#1722)', async () => {
    const { db, raw } = fresh();
    // A row no keeper claim produces: held by another name until far beyond
    // any renewal. Honouring it would idle the keeper until then.
    raw
      .prepare("INSERT INTO keeper_runner_lease VALUES ('keeper', 'squatter', 0, 0, ?1)")
      .run(Date.now() + 365 * 24 * 3_600_000);
    expect(await claimRunnerLease(db, 'host:a')).toEqual({ held: true, acquired: true });
    const row = raw.prepare('SELECT holder, renewed_at, expires_at FROM keeper_runner_lease').get() as Record<string, unknown>;
    expect(row.holder).toBe('host:a');
    expect(row.expires_at).toBe((row.renewed_at as number) + LEASE_TTL_MS);
  });

  it('still honours a live lease at exactly the maximum term', async () => {
    const { db, raw } = fresh();
    await claimRunnerLease(db, 'host:a');
    // Fresh claim: expiry = now + TTL = now + max term, the edge that must hold.
    expect(LEASE_MAX_TERM_MS).toBe(LEASE_TTL_MS);
    expect((await claimRunnerLease(db, 'host:b')).held).toBe(false);
    expect(raw.prepare('SELECT holder FROM keeper_runner_lease').get()).toEqual({ holder: 'host:a' });
  });

  it('declines with no runner id rather than guessing one', async () => {
    const { db, raw } = fresh();
    for (const id of [undefined, '', '  ']) {
      const claim = await claimRunnerLease(db, id);
      expect(claim.held === false && claim.reason).toContain('KEEPER_RUNNER_ID is not set');
    }
    expect(raw.prepare('SELECT COUNT(*) AS n FROM keeper_runner_lease').get()).toEqual({ n: 0 });
  });

  it('declines, without throwing, when the table is missing', async () => {
    const { d1 } = createSqliteD1([]);
    const claim = await claimRunnerLease(d1 as D1Database, 'host:a');
    expect(claim.held).toBe(false);
    expect(claim.held === false && claim.reason).toContain('could not claim the one-runner lease');
  });
});

describe('the tick and the lease', () => {
  it('launches no pass while another runner holds the lease in the private database', async () => {
    const { db } = fresh();
    await claimRunnerLease(db, 'host:a');
    const launched: string[] = [];
    // Both bindings, so the tick reaches the lease rather than declining for
    // an unbound database; the shared one has no lease table at all, so a
    // claim made there would fail and say so instead of naming the holder.
    const { d1: shared } = createSqliteD1([]);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => warnings.push(String(line));
    try {
      const env = { DB: shared, KEEPER_DB: db, KEEPER_RUNNER_ID: 'cloudflare-worker' } as unknown as WorkerEnv;
      await runKeeperTick(env, Date.now(), (name) => launched.push(name));
    } finally {
      console.warn = warn;
    }
    expect(warnings.some((w) => w.includes('"host:a" holds the one-runner lease'))).toBe(true);
    expect(launched).toEqual([]);
  });

  it('renews on a minute skipped for a still-running tick', async () => {
    let release!: () => void;
    const skips: number[] = [];
    const runner = createTickRunner({
      runTick: () => new Promise<void>((r) => (release = r)),
      log: () => {},
      onSkip: async (t) => {
        skips.push(t);
      },
    });
    expect(runner.fire(T0)).toBe(true);
    expect(runner.fire(T0 + 60_000)).toBe(false);
    expect(skips).toEqual([T0 + 60_000]);
    release();
    await runner.idle();
  });
});

describe('a machine\'s runner id', () => {
  it('defaults to host:<host name>, so an env file without one still claims the lease', () => {
    expect(buildHostEnv({}, undefined, () => 'keeper-vm').env.KEEPER_RUNNER_ID).toBe('host:keeper-vm');
    expect(buildHostEnv({ KEEPER_RUNNER_ID: '' }, undefined, () => 'keeper-vm').env.KEEPER_RUNNER_ID).toBe('host:keeper-vm');
  });

  it('keeps one the env file sets', () => {
    expect(buildHostEnv({ KEEPER_RUNNER_ID: 'host:custom' }, undefined, () => 'keeper-vm').env.KEEPER_RUNNER_ID).toBe('host:custom');
  });
});
