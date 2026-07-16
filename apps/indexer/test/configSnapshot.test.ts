/**
 * RPC read-diet PR B — the config-snapshot refresh decision, pinned.
 * The explicit event allowlist and the backstop decide when the indexer
 * spends the two `eth_call`s that keep GET /config/:chainId current; a
 * miss means the apps' display config lags governance until the
 * backstop, an over-trigger burns a redundant read per scan.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import {
  isConfigEventName,
  maybeRefreshProtocolConfig,
  serializeTuple,
  shouldRefreshConfig,
} from '../src/configSnapshot';
import type { Env } from '../src/env';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATION_0039 = readFileSync(
  new URL('../migrations/0039_protocol_config_grace_buckets.sql', import.meta.url),
  'utf8',
);
const MIGRATION_0035 = readFileSync(
  new URL('../migrations/0035_protocol_config.sql', import.meta.url),
  'utf8',
);

/** Env + client stubs for the refresh path: real SQLite behind the D1
 *  shape (the upsert/stale-mark guards ARE SQL), canned reads. */
function refreshHarness(opts?: { graceRead?: () => Promise<unknown> }) {
  const { db, d1 } = createSqliteD1([MIGRATION_0035, MIGRATION_0039]);
  const reads: string[] = [];
  const client = {
    readContract: async (args: { functionName: string }) => {
      reads.push(args.functionName);
      if (args.functionName === 'getMasterFlags') return [true, true, false] as const;
      // #1213 PR 2 — the grace-bucket read rides the same refresh; the
      // retail default is an empty array (compile-time schedule).
      if (args.functionName === 'getGraceBuckets') {
        return opts?.graceRead ? opts.graceRead() : ([] as const);
      }
      return [100n, [1n, 2n, 3n, 4n]] as const;
    },
  } as unknown as PublicClient;
  const env = { DB: d1 } as unknown as Env;
  const row = () =>
    db
      .prepare(
        `SELECT source_block AS sb, updated_at AS ua, bundle_json AS bj,
                grace_buckets_json AS gb
         FROM protocol_config WHERE chain_id = 84532`,
      )
      .get() as { sb: number; ua: number; bj: string; gb: string | null } | undefined;
  return { db, env, client, reads, row };
}

const DIAMOND = '0x0000000000000000000000000000000000000d1a' as const;

describe('configSnapshot', () => {
  it('matches every governance setter shape (representatives)', () => {
    for (const name of [
      'FeesConfigSet',
      'RiskConfigSet',
      'MaxOfferDurationDaysSet',
      'PartialFillEnabledSet',
      'SanctionsOracleSet',
      'GraceBucketsUpdated',
      'AssetMinPartialBpsUpdated',
      'TierTableVersionBumped',
    ]) {
      expect(isConfigEventName(name), name).toBe(true);
    }
  });

  it('never matches domain lifecycle events', () => {
    for (const name of [
      'OfferCreated',
      'OfferAccepted',
      'OfferCanceled',
      'LoanInitiated',
      'LoanRepaid',
      'LoanDefaulted',
      'Transfer',
      'PartialRepaid',
      'InternalMatchExecuted',
      // Suffix-shaped lifecycle names the retired /(Set|Updated|Bumped)$/
      // rule wrongly matched (Codex #1231 r1) — pinned as negatives so
      // an allowlist regression can't silently re-trigger on them.
      'NFTStatusUpdated',
      'PrepayListingUpdated',
      // Per-user admin events — they never change the served bundle.
      'KYCTierUpdated',
      'KeeperAccessUpdated',
      'TradeAllowanceSet',
    ]) {
      expect(isConfigEventName(name), name).toBe(false);
    }
  });

  it('refreshes on config events, bootstrap, and the backstop — not otherwise', () => {
    const now = 1_000_000;
    // Config event in the scan → always refresh.
    expect(
      shouldRefreshConfig({ sawConfigEvent: true, rowUpdatedAt: now, nowSec: now }),
    ).toBe(true);
    // No row yet (bootstrap) → refresh.
    expect(
      shouldRefreshConfig({ sawConfigEvent: false, rowUpdatedAt: null, nowSec: now }),
    ).toBe(true);
    // Fresh row, quiet scan → skip (this is the steady state).
    expect(
      shouldRefreshConfig({
        sawConfigEvent: false,
        rowUpdatedAt: now - 60,
        nowSec: now,
      }),
    ).toBe(false);
    // Row older than the 6h backstop → refresh.
    expect(
      shouldRefreshConfig({
        sawConfigEvent: false,
        rowUpdatedAt: now - 7 * 3600,
        nowSec: now,
      }),
    ).toBe(true);
    // Stale-marked row (updated_at zeroed after a failed config-event
    // refresh) → the backstop math retries immediately.
    expect(
      shouldRefreshConfig({ sawConfigEvent: false, rowUpdatedAt: 0, nowSec: now }),
    ).toBe(true);
  });

  it('stale-marks (not refreshes) when a catch-up scan contains a config event', async () => {
    // Codex #1231 r2: dropping the signal here would let the pre-change
    // row serve as fresh through the whole backstop once caught up.
    const h = refreshHarness();
    h.db
      .prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, source_block, updated_at)
         VALUES (84532, '[]', '[]', 50, ?)`,
      )
      .run(Math.floor(Date.now() / 1000));
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: ['OfferCreated', 'FeesConfigSet'],
      blockNumber: 100n, // far behind…
      headBlock: 1_000n, // …the head → historic read, skip the eth_calls
    });
    expect(h.reads).toEqual([]);
    expect(h.row()?.ua).toBe(0); // …but the old row no longer looks fresh
  });

  it('lets a late older scan neither overwrite nor stale-mark a newer row', async () => {
    // Codex #1231 r2: the cursor advance is monotonic for overlapping
    // scans; the snapshot writes follow the same discipline.
    const h = refreshHarness();
    const freshAt = Math.floor(Date.now() / 1000);
    h.db
      .prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, source_block, updated_at)
         VALUES (84532, '["newer"]', '[]', 200, ?)`,
      )
      .run(freshAt);
    // Older scan, near head, saw a config event → reads happen, but the
    // guarded upsert must not replace the newer row.
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: ['FeesConfigSet'],
      blockNumber: 100n,
      headBlock: 110n,
    });
    expect(h.row()).toMatchObject({ sb: 200, bj: '["newer"]', ua: freshAt });
    // Same older scan during catch-up → the stale-mark is guarded too.
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: ['FeesConfigSet'],
      blockNumber: 100n,
      headBlock: 1_000n,
    });
    expect(h.row()?.ua).toBe(freshAt);
  });

  it('bootstraps the row from a near-head scan (happy path)', async () => {
    const h = refreshHarness();
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: [],
      blockNumber: 100n,
      headBlock: 110n,
    });
    expect(h.reads.sort()).toEqual([
      'getGraceBuckets',
      'getMasterFlags',
      'getProtocolConfigBundle',
    ]);
    expect(h.row()).toMatchObject({ sb: 100 });
    expect(JSON.parse(h.row()!.bj)).toEqual(['100', ['1', '2', '3', '4']]);
  });

  it("treats the Diamond's FunctionDoesNotExist revert as a definitive empty bucket set (Codex #1298 r4)", async () => {
    // A pre-getter diamond's fallback reverts `FunctionDoesNotExist()`
    // (selector 0xa9ad62f8). That must store '[]' — getter and setter
    // ship in the same facet cut, so no getter ⇒ no buckets — NOT fall
    // into the transient branch, which would leave the column NULL and
    // re-force the three config reads on every near-head scan forever.
    const h = refreshHarness({
      graceRead: async () => {
        throw new Error(
          'The contract function "getGraceBuckets" reverted. Error: FunctionDoesNotExist() (0xa9ad62f8)',
        );
      },
    });
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: [],
      blockNumber: 100n,
      headBlock: 110n,
    });
    expect(h.row()?.gb).toBe('[]');
  });

  it('preserves a snapshotted bucket set through a transient grace-read failure', async () => {
    // Codex #1298 r3: a transient RPC hiccup must not clobber real
    // governance buckets back to defaults — COALESCE keeps the column.
    const h = refreshHarness({
      graceRead: async () => {
        throw new Error('HTTP request failed: 503');
      },
    });
    h.db
      .prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, grace_buckets_json, source_block, updated_at)
         VALUES (84532, '[]', '[]', '[{"maxDurationDays":"0","graceSeconds":"3888000"}]', 50, 0)`,
      )
      .run();
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: [],
      blockNumber: 100n,
      headBlock: 110n,
    });
    // Bundle/flags refreshed (the isolated grace failure never sinks
    // them), buckets preserved.
    expect(h.row()).toMatchObject({
      sb: 100,
      gb: '[{"maxDurationDays":"0","graceSeconds":"3888000"}]',
    });
  });

  it('force-refreshes a populated row whose grace column is still NULL (Codex #1298 r3)', async () => {
    const h = refreshHarness();
    // Fresh pre-0039 row: updated_at is current, so the event/backstop
    // gates would skip — the NULL grace column alone must trigger.
    h.db
      .prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, source_block, updated_at)
         VALUES (84532, '[]', '[]', 50, ?)`,
      )
      .run(Math.floor(Date.now() / 1000));
    await maybeRefreshProtocolConfig({
      env: h.env,
      chainId: 84532,
      client: h.client,
      diamond: DIAMOND,
      scannedEventNames: [],
      blockNumber: 100n,
      headBlock: 110n,
    });
    expect(h.reads).toContain('getGraceBuckets');
    expect(h.row()?.gb).toBe('[]'); // populated — the force stops firing
  });

  it('serializes nested bigint arrays (the uint256[4] tier slots)', () => {
    // A top-level-only map left nested BigInts for JSON.stringify to
    // throw on, which fail-opened every refresh (Codex #1231 r1).
    const json = serializeTuple([
      100n,
      [1n, 2n, 3n, 4n],
      { threshold: 5_000_000_000_000_000_000n },
      true,
      'addr',
    ]);
    expect(JSON.parse(json)).toEqual([
      '100',
      ['1', '2', '3', '4'],
      { threshold: '5000000000000000000' },
      true,
      'addr',
    ]);
  });
});
