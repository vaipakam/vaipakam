/**
 * RL-2 (#1303) — reward loop-closure ledger + /metrics/loop-closure
 * (docs/DesignsAndPlans/VpfiRecyclingLoopClosureDesign.md §6 RL-2).
 *
 * Runs against the REAL migrated schema (0042). Covers the design's
 * load-bearing rules: retention credits/min-clamped debits
 * (rewards-spent-first, never re-inflated), exactly-once replay safety,
 * per-user same-day netting (the 200%-day and mixed-user-day cases), the
 * zero-distribution `null` convention, and the cumulative stock ratio.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
  applyRewardLoopLedger,
  type RewardLoopLog,
} from '../src/rewardLoopLedger';
import { handleLoopClosure } from '../src/rewardRoutes';
import { _stampIngestedBeforeTime } from '../src/chainIndexer';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const ALICE = '0x00000000000000000000000000000000000000aa';
const BOB = '0x00000000000000000000000000000000000000bb';
const ZERO = '0x0000000000000000000000000000000000000000';

// Fixed "today" so day bucketing is deterministic: the route computes
// todayId from Date.now(), so anchor test blocks to the CURRENT epoch-day.
const NOW = Math.floor(Date.now() / 1000);
const TODAY = Math.floor(NOW / 86400);
const TODAY_TS = TODAY * 86400 + 3600; // 01:00 UTC today
// The route publishes a day's figures as FINAL only once the day has ended
// and the ingest's time watermark has passed it (#1349 M5) — today is always
// in progress. So the route cases put their events on YESTERDAY and stamp
// the watermark into today, through the real caught-up stamp.
const CLOSED = TODAY - 1;
const CLOSED_TS = CLOSED * 86400 + 3600; // 01:00 UTC yesterday

/** Record "every claim before 00:01 UTC today is ingested", as a caught-up
 *  pass would, so yesterday reads as complete. */
async function recordThroughYesterday(env: Env) {
  await _stampIngestedBeforeTime(env, CHAIN, BigInt(TODAY * 86400 + 60));
}

function makeHarness() {
  const h: SqliteD1 = createSqliteD1(ALL_MIGRATIONS);
  const env = { DB: h.d1 } as unknown as Env;
  return { h, env };
}

let logCounter = 0;
function log(
  eventName: string,
  user: string,
  amount: bigint,
  blockNumber = 100n,
  extra: Record<string, unknown> = {},
): RewardLoopLog {
  return {
    eventName,
    args: { user, amount, ...extra },
    blockNumber,
    transactionHash: `0x${(++logCounter).toString(16).padStart(64, '0')}`,
    logIndex: logCounter,
  };
}

function ts(blocks: Array<[bigint, number]>): Map<bigint, number> {
  return new Map(blocks);
}

async function retained(h: SqliteD1, user: string): Promise<string> {
  const row = h.db
    .prepare(
      `SELECT retained FROM reward_retention WHERE chain_id = ? AND user = ?`,
    )
    .get(CHAIN, user) as { retained: string } | undefined;
  return row?.retained ?? '0';
}

describe('applyRewardLoopLedger', () => {
  it('credits retention on vault delivery and records the day flow', async () => {
    const { h, env } = makeHarness();
    const applied = await applyRewardLoopLedger(
      [
        log('InteractionRewardsClaimed', ALICE, 100n),
        log('RewardDeliveredToVault', ALICE, 100n, 100n, { claimDayId: 5n }),
      ],
      env,
      CHAIN,
      ts([[100n, TODAY_TS]]),
    );
    expect(applied).toBe(2);
    expect(await retained(h, ALICE)).toBe('100');

    const day = h.db
      .prepare(
        `SELECT distributed, vault_delivered, reward_funded_debits
           FROM reward_day_user WHERE chain_id = ? AND user = ?`,
      )
      .get(CHAIN, ALICE) as Record<string, string>;
    expect(day.distributed).toBe('100');
    expect(day.vault_delivered).toBe('100');
    expect(day.reward_funded_debits).toBe('0');
  });

  it('min-clamps debits: rewards spent first, never negative, personal deposits never re-inflate', async () => {
    const { h, env } = makeHarness();
    await applyRewardLoopLedger(
      [
        log('RewardDeliveredToVault', ALICE, 60n),
        // Debit 100 > retained 60 → ledger drops to 0, clamp records 60.
        log('VaultVpfiDebited', ALICE, 100n, 100n, { recipient: ALICE }),
        // A further debit with zero retained is a no-op on the ledger.
        log('VaultVpfiDebited', ALICE, 50n, 100n, { recipient: ALICE }),
      ],
      env,
      CHAIN,
      ts([[100n, TODAY_TS]]),
    );
    expect(await retained(h, ALICE)).toBe('0');
    const day = h.db
      .prepare(
        `SELECT reward_funded_debits FROM reward_day_user
          WHERE chain_id = ? AND user = ?`,
      )
      .get(CHAIN, ALICE) as { reward_funded_debits: string };
    // Only the CLAMPED decrement counts (60, not 150) — a naive raw sum
    // would understate closure on mixed-fund days.
    expect(day.reward_funded_debits).toBe('60');
  });

  it('is exactly-once: replaying the same logs changes nothing', async () => {
    const { h, env } = makeHarness();
    const logs = [
      log('RewardDeliveredToVault', ALICE, 40n),
      log('InteractionRewardsClaimed', ALICE, 40n),
    ];
    const first = await applyRewardLoopLedger(
      logs,
      env,
      CHAIN,
      ts([[100n, TODAY_TS]]),
    );
    const replay = await applyRewardLoopLedger(
      logs,
      env,
      CHAIN,
      ts([[100n, TODAY_TS]]),
    );
    expect(first).toBe(2);
    expect(replay).toBe(0);
    expect(await retained(h, ALICE)).toBe('40');
    const totals = h.db
      .prepare(
        `SELECT cum_distributed, retained_stock FROM reward_loop_totals
          WHERE chain_id = ?`,
      )
      .get(CHAIN) as Record<string, string>;
    expect(totals.cum_distributed).toBe('40');
    expect(totals.retained_stock).toBe('40');
  });
});

describe('GET /metrics/loop-closure', () => {
  async function fetchMetric(env: Env) {
    await recordThroughYesterday(env);
    const res = await handleLoopClosure(
      new Request(
        `http://indexer.local/metrics/loop-closure?chainId=${CHAIN}&days=7`,
      ),
      env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      daily: Array<{
        dayId: number;
        distributed: string;
        netVaultDelivered: string;
        ratio: number | null;
      }>;
      cumulative: {
        cumDistributed: string;
        retainedStock: string;
        ratio: number | null;
      };
    };
  }

  it('same-day claim-and-spend counts once, never 200% (pre-governor: reads as 0, the conservative lower bound)', async () => {
    const { env } = makeHarness();
    // Alice claims 100 to the vault and spends the same 100 the same day.
    await applyRewardLoopLedger(
      [
        log('InteractionRewardsClaimed', ALICE, 100n),
        log('RewardDeliveredToVault', ALICE, 100n),
        log('VaultVpfiDebited', ALICE, 100n, 100n, { recipient: ALICE }),
      ],
      env,
      CHAIN,
      ts([[100n, CLOSED_TS]]),
    );
    const body = await fetchMetric(env);
    // Dense series: every day in the 7-day window gets a bucket.
    expect(body.daily).toHaveLength(7);
    const day = body.daily.find((d) => d.dayId === CLOSED)!;
    // net = max(0, 100 − 100) = 0; with absorbed still 0 (pre-PR-3a) the
    // day reads 0.0 — the tokens re-entered as a tariff the ledger can't
    // yet see, and the metric may NEVER overstate closure.
    expect(day.netVaultDelivered).toBe('0');
    expect(day.ratio).toBe(0);
    // Quiet RECORDED days are explicit null-ratio buckets, not missing
    // entries — a zero there is a fact, because the record covers the day.
    const quiet = body.daily.find((d) => d.dayId === CLOSED - 3)!;
    expect(quiet.distributed).toBe('0');
    expect(quiet.ratio).toBeNull();
  });

  it('nets PER USER: Bob spending old rewards cannot cancel Alice’s same-day delivery', async () => {
    const { env } = makeHarness();
    await applyRewardLoopLedger(
      // The day before: Bob earned 50 into his vault.
      [log('RewardDeliveredToVault', BOB, 50n, 90n)],
      env,
      CHAIN,
      ts([[90n, CLOSED_TS - 86400]]),
    );
    await applyRewardLoopLedger(
      [
        // The closed day: Alice claims 100 to vault and keeps it; Bob spends his 50.
        log('InteractionRewardsClaimed', ALICE, 100n),
        log('RewardDeliveredToVault', ALICE, 100n),
        log('VaultVpfiDebited', BOB, 50n, 100n, { recipient: BOB }),
      ],
      env,
      CHAIN,
      ts([[100n, CLOSED_TS]]),
    );
    const body = await fetchMetric(env);
    const day = body.daily.find((d) => d.dayId === CLOSED);
    // Aggregate netting would report 100 − 50 = 50; per-user netting keeps
    // Alice's full 100 (Bob's row nets max(0, 0 − 50) = 0).
    expect(day?.netVaultDelivered).toBe('100');
    expect(day?.ratio).toBe(1);
  });

  it('reports null (not 0/NaN/∞) on zero-distribution days and serves the cumulative stock ratio', async () => {
    const { env } = makeHarness();
    // A delivery-only day (no InteractionRewardsClaimed row — synthetic,
    // but exercises the convention directly).
    await applyRewardLoopLedger(
      [log('RewardDeliveredToVault', ALICE, 70n)],
      env,
      CHAIN,
      ts([[100n, CLOSED_TS]]),
    );
    const body = await fetchMetric(env);
    const day = body.daily.find((d) => d.dayId === CLOSED)!;
    expect(day.ratio).toBeNull();
    expect(body.cumulative.cumDistributed).toBe('0');
    expect(body.cumulative.retainedStock).toBe('70');
    expect(body.cumulative.ratio).toBeNull();
  });
});

describe('GET /metrics/loop-closure — which days are known (#1349 M5)', () => {
  type Day = {
    dayId: number;
    status: string;
    distributed: string | null;
    netVaultDelivered: string | null;
    absorbed: string | null;
    ratio: number | null;
  };
  async function body(env: Env) {
    const res = await handleLoopClosure(
      new Request(`http://indexer.local/metrics/loop-closure?chainId=${CHAIN}&days=7`),
      env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { recordedBefore: string | null; daily: Day[] };
  }
  async function claimOn(env: Env, at: number) {
    await applyRewardLoopLedger(
      [log('InteractionRewardsClaimed', ALICE, 100n), log('RewardDeliveredToVault', ALICE, 100n)],
      env,
      CHAIN,
      ts([[100n, at]]),
    );
  }

  it('with no watermark, NO day is known: every day unrecorded, amounts null — never zero', async () => {
    const { env } = makeHarness();
    // A real claim exists, but nothing says how far the record reaches.
    await claimOn(env, CLOSED_TS);
    const b = await body(env);
    expect(b.recordedBefore).toBeNull();
    expect(b.daily).toHaveLength(7);
    for (const d of b.daily) {
      expect(d).toMatchObject({
        status: 'unrecorded',
        distributed: null,
        netVaultDelivered: null,
        absorbed: null,
        ratio: null,
      });
    }
  });

  it('the day in progress is partial — its amounts so far, and NO ratio', async () => {
    const { env } = makeHarness();
    await claimOn(env, TODAY_TS);
    await recordThroughYesterday(env);
    // Advance the record past the claim: still partial, because the day
    // has not ended — a part-day ratio is not a lower bound on the final.
    await _stampIngestedBeforeTime(env, CHAIN, BigInt(TODAY_TS + 60));
    const b = await body(env);
    expect(b.recordedBefore).toBe(new Date((TODAY_TS + 60) * 1000).toISOString());
    expect(b.daily.find((d) => d.dayId === TODAY)).toMatchObject({
      status: 'partial',
      distributed: '100',
      netVaultDelivered: '100',
      ratio: null,
    });
    // Straddle partner: the closed day before it is complete, zero and all.
    expect(b.daily.find((d) => d.dayId === CLOSED)).toMatchObject({
      status: 'complete',
      distributed: '0',
      ratio: null,
    });
  });

  it('a LAGGING record: the day it stops in is partial, the days after it unrecorded', async () => {
    const { env } = makeHarness();
    // The record reaches only to 06:00 three days ago.
    const stoppedAt = (TODAY - 3) * 86400 + 6 * 3600;
    await _stampIngestedBeforeTime(env, CHAIN, BigInt(stoppedAt));
    const b = await body(env);
    const st = (id: number) => b.daily.find((d) => d.dayId === id)!;
    expect(st(TODAY - 4).status).toBe('complete');
    expect(st(TODAY - 4).distributed).toBe('0');
    expect(st(TODAY - 3)).toMatchObject({ status: 'partial', distributed: '0', ratio: null });
    for (const id of [TODAY - 2, TODAY - 1, TODAY]) {
      expect(st(id)).toMatchObject({ status: 'unrecorded', distributed: null, ratio: null });
    }
  });

  it('the stamp is monotonic: a regressed head never moves the record back', async () => {
    const { env } = makeHarness();
    await _stampIngestedBeforeTime(env, CHAIN, BigInt(TODAY * 86400 + 60));
    await _stampIngestedBeforeTime(env, CHAIN, BigInt((TODAY - 2) * 86400));
    const b = await body(env);
    expect(b.recordedBefore).toBe(new Date((TODAY * 86400 + 60) * 1000).toISOString());
    expect(b.daily.find((d) => d.dayId === CLOSED)!.status).toBe('complete');
  });

  it('the stamp writes the time row ALONE — the notified watermark has its own stamp', async () => {
    // The notified watermark carries the replay planning of Codex #2489 and
    // is stamped separately; this stamp must never touch it.
    const { h, env } = makeHarness();
    await _stampIngestedBeforeTime(env, CHAIN, BigInt(TODAY * 86400 + 60));
    await _stampIngestedBeforeTime(env, CHAIN, BigInt((TODAY - 2) * 86400));
    const rows = h.db
      .prepare(`SELECT kind, last_block FROM indexer_cursor WHERE chain_id = ? ORDER BY kind`)
      .all(CHAIN) as Array<{ kind: string; last_block: number }>;
    expect(rows).toEqual([{ kind: 'ingested-before-time', last_block: TODAY * 86400 + 60 }]);
  });
});

describe('robustness (Codex #1310 round 1)', () => {
  it('retries sentinel block timestamps in place, and THROWS (failing the scan) when unrecoverable', async () => {
    const { h, env } = makeHarness();
    const l = log('RewardDeliveredToVault', ALICE, 30n, 100n);
    // Retry also fails → the ledger must throw so the ingest scan fails
    // and the cursor never advances past the reward event (the cron path
    // has no guaranteed overlapping scan — a silent skip loses it).
    await expect(
      applyRewardLoopLedger(
        [l],
        env,
        CHAIN,
        ts([[100n, TODAY_TS]]),
        new Set([100n]),
        async () => null,
      ),
    ).rejects.toThrow(/unrecoverable block timestamp/);
    expect(await retained(h, ALICE)).toBe('0');
    // Same log, retry now returns the real chain timestamp → applied
    // under the true day (no dedup row was written by the failed pass).
    const applied = await applyRewardLoopLedger(
      [l],
      env,
      CHAIN,
      ts([[100n, TODAY_TS]]),
      new Set([100n]),
      async () => TODAY_TS,
    );
    expect(applied).toBe(1);
    expect(await retained(h, ALICE)).toBe('30');
  });

  it('backfill replays pre-boundary VPFIWithdrawnFromVault as debits, excludes post-boundary ones', async () => {
    const { h, env } = makeHarness();
    const seedActivity = (
      block: number,
      logIndex: number,
      kind: string,
      args: Record<string, string>,
      blockAt: number,
    ) =>
      h.db
        .prepare(
          `INSERT INTO activity_events
             (chain_id, block_number, log_index, tx_hash, kind,
              loan_id, offer_id, actor, args_json, block_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          CHAIN,
          block,
          logIndex,
          `0x${block.toString(16).padStart(64, '0')}`,
          kind,
          ALICE,
          JSON.stringify(args),
          blockAt,
        );

    const t0 = TODAY_TS - 3 * 86400;
    // Historical: delivery 100, then an unstake of 40 observable only as
    // VPFIWithdrawnFromVault (pre-VaultVpfiDebited era).
    seedActivity(10, 0, 'RewardDeliveredToVault', { user: ALICE, amount: '100' }, t0);
    seedActivity(20, 0, 'VPFIWithdrawnFromVault', { user: ALICE, amount: '40', newVaultBalance: '60' }, t0 + 3600);
    // Boundary: the first VaultVpfiDebited row (both events fire in the
    // same unstake tx from here on — replaying the withdraw twin would
    // double-decrement).
    seedActivity(30, 0, 'VaultVpfiDebited', { user: ALICE, amount: '10', recipient: ALICE }, t0 + 7200);
    seedActivity(30, 1, 'VPFIWithdrawnFromVault', { user: ALICE, amount: '10', newVaultBalance: '50' }, t0 + 7200);

    await applyRewardLoopLedger([], env, CHAIN, ts([]));

    // 100 delivered − 40 (pre-boundary withdraw) − 10 (boundary debit,
    // counted ONCE despite its withdraw twin) = 50.
    expect(await retained(h, ALICE)).toBe('50');
  });

  it('backfill with NO VaultVpfiDebited rows treats every withdraw as pre-boundary', async () => {
    const { h, env } = makeHarness();
    const seed = (block: number, kind: string, args: Record<string, string>) =>
      h.db
        .prepare(
          `INSERT INTO activity_events
             (chain_id, block_number, log_index, tx_hash, kind,
              loan_id, offer_id, actor, args_json, block_at)
           VALUES (?, ?, 0, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          CHAIN,
          block,
          `0x${block.toString(16).padStart(64, '0')}`,
          kind,
          ALICE,
          JSON.stringify(args),
          TODAY_TS - 2 * 86400,
        );

    // Right-after-migration state: deliveries + a reward-funded unstake,
    // but the VaultVpfiDebited event has never fired on this chain yet.
    seed(10, 'RewardDeliveredToVault', { user: ALICE, amount: '100' });
    seed(20, 'VPFIWithdrawnFromVault', {
      user: ALICE,
      amount: '60',
      newVaultBalance: '40',
    });

    await applyRewardLoopLedger([], env, CHAIN, ts([]));

    // A null boundary must mean "replay ALL withdraws", not "skip all"
    // (Codex #1310 r3): 100 − 60 = 40; skipping would overstate at 100.
    expect(await retained(h, ALICE)).toBe('40');
  });

  it('VpfiRecycled feeds the absorption term: daily absorbed + cumulative + ratio', async () => {
    const { env } = makeHarness();
    await applyRewardLoopLedger(
      [
        log('InteractionRewardsClaimed', ALICE, 100n),
        // A forfeit recycled into the bucket the same day (PR-3a feed).
        // VpfiRecycled carries no user arg — day-aggregate only.
        {
          eventName: 'VpfiRecycled',
          args: { source: 0, refId: 42n, amount: 60n, dayId: 5n },
          blockNumber: 100n,
          transactionHash: `0x${'cd'.repeat(32)}`,
          logIndex: 999,
        },
      ],
      env,
      CHAIN,
      ts([[100n, CLOSED_TS]]),
    );
    await recordThroughYesterday(env);
    const res = await handleLoopClosure(
      new Request(
        `http://indexer.local/metrics/loop-closure?chainId=${CHAIN}&days=7`,
      ),
      env,
    );
    const body = (await res.json()) as {
      daily: Array<{ dayId: number; absorbed: string; ratio: number | null }>;
      cumulative: { cumAbsorbed: string; ratio: number | null };
    };
    const day = body.daily.find((d) => d.dayId === CLOSED)!;
    expect(day.absorbed).toBe('60');
    // (net 0 + absorbed 60) / distributed 100 = 0.6
    expect(day.ratio).toBe(0.6);
    expect(body.cumulative.cumAbsorbed).toBe('60');
  });

  it('VpfiRecycledPreLaunch feeds absorption too — this ratio is not day-scoped', async () => {
    const { env } = makeHarness();
    // #1504 split pre-launch absorption onto its own event so the RECYCLING
    // day series would stop filing it under day 0. RL-2's ratio is a
    // different metric: it buckets by the UTC BLOCK day and asks whether
    // value came back into the sink, not which programme day earned it.
    // Dropping the new event here would have made `absorbed`, `cum_absorbed`
    // and both ratios permanently undercount — a fix for one metric
    // silently breaking another (Codex #1508 r1 P2).
    await applyRewardLoopLedger(
      [
        log('InteractionRewardsClaimed', ALICE, 100n),
        {
          // No dayId at all: the event deliberately names no day.
          eventName: 'VpfiRecycledPreLaunch',
          args: { source: 0, refId: 7n, amount: 40n },
          blockNumber: 100n,
          transactionHash: `0x${'ef'.repeat(32)}`,
          logIndex: 998,
        },
      ],
      env,
      CHAIN,
      ts([[100n, CLOSED_TS]]),
    );
    await recordThroughYesterday(env);
    const res = await handleLoopClosure(
      new Request(
        `http://indexer.local/metrics/loop-closure?chainId=${CHAIN}&days=7`,
      ),
      env,
    );
    const body = (await res.json()) as {
      daily: Array<{ dayId: number; absorbed: string; ratio: number | null }>;
      cumulative: { cumAbsorbed: string };
    };
    const day = body.daily.find((d) => d.dayId === CLOSED)!;
    expect(day.absorbed).toBe('40');
    expect(day.ratio).toBe(0.4);
    expect(body.cumulative.cumAbsorbed).toBe('40');
  });

  it('backfill replays historical fee debits (NotificationFeeBilled / VPFIDiscountApplied) pre-boundary, with (block, log_index) precision', async () => {
    const { h, env } = makeHarness();
    const seed = (
      block: number,
      logIndex: number,
      kind: string,
      args: Record<string, unknown>,
    ) =>
      h.db
        .prepare(
          `INSERT INTO activity_events
             (chain_id, block_number, log_index, tx_hash, kind,
              loan_id, offer_id, actor, args_json, block_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          CHAIN,
          block,
          logIndex,
          `0x${(block * 1000 + logIndex).toString(16).padStart(64, '0')}`,
          kind,
          ALICE,
          JSON.stringify(args),
          TODAY_TS - 86400,
        );

    seed(10, 0, 'RewardDeliveredToVault', { user: ALICE, amount: '100' });
    // Historical fee debits, only observable via their own events then:
    seed(20, 0, 'NotificationFeeBilled', {
      loanId: '1',
      isLenderSide: true,
      payer: ALICE,
      vpfiAmount: '15',
      configuredFeeVpfi1e18: '15',
    });
    seed(21, 0, 'VPFIDiscountApplied', {
      loanId: '2',
      borrower: ALICE,
      lendingAsset: ZERO,
      vpfiDeducted: '25',
    });
    // Upgrade block 30: an old-facet withdraw at log_index 1 (BEFORE the
    // first debit at log_index 5) must replay; the fee twin AFTER it must
    // not.
    seed(30, 1, 'VPFIWithdrawnFromVault', {
      user: ALICE,
      amount: '10',
      newVaultBalance: '50',
    });
    seed(30, 5, 'VaultVpfiDebited', {
      user: ALICE,
      amount: '20',
      recipient: ALICE,
    });
    seed(30, 6, 'NotificationFeeBilled', {
      loanId: '3',
      isLenderSide: false,
      payer: ALICE,
      vpfiAmount: '20',
      configuredFeeVpfi1e18: '20',
    });

    await applyRewardLoopLedger([], env, CHAIN, ts([]));

    // 100 − 15 (fee) − 25 (discount) − 10 (same-block pre-boundary
    // withdraw) − 20 (canonical debit; its fee twin skipped) = 30.
    expect(await retained(h, ALICE)).toBe('30');
  });

  it('backfills historical reward events from activity_events once, dedup-safe against live replay', async () => {
    const { h, env } = makeHarness();
    // A historical wallet-paid claim the ingest cursor already passed —
    // present only in activity_events.
    h.db
      .prepare(
        `INSERT INTO activity_events
           (chain_id, block_number, log_index, tx_hash, kind,
            loan_id, offer_id, actor, args_json, block_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        CHAIN,
        50,
        7,
        '0x' + 'ab'.repeat(32),
        'InteractionRewardsClaimed',
        ALICE,
        JSON.stringify({ user: ALICE, fromDay: '1', toDay: '2', amount: '80' }),
        TODAY_TS - 86400,
      );

    // First ledger invocation (empty live logs) runs the backfill.
    await applyRewardLoopLedger([], env, CHAIN, ts([]));
    let totals = h.db
      .prepare(
        `SELECT cum_distributed, backfill_done FROM reward_loop_totals
          WHERE chain_id = ?`,
      )
      .get(CHAIN) as { cum_distributed: string; backfill_done: number };
    expect(totals.cum_distributed).toBe('80');
    expect(totals.backfill_done).toBe(1);

    // A live re-delivery of the SAME log (overlap) must not double-count,
    // and the backfill must not re-run.
    await applyRewardLoopLedger(
      [
        {
          eventName: 'InteractionRewardsClaimed',
          args: { user: ALICE, amount: 80n },
          blockNumber: 50n,
          transactionHash: '0x' + 'ab'.repeat(32),
          logIndex: 7,
        },
      ],
      env,
      CHAIN,
      ts([[50n, TODAY_TS - 86400]]),
    );
    totals = h.db
      .prepare(
        `SELECT cum_distributed, backfill_done FROM reward_loop_totals
          WHERE chain_id = ?`,
      )
      .get(CHAIN) as { cum_distributed: string; backfill_done: number };
    expect(totals.cum_distributed).toBe('80');
  });
});
