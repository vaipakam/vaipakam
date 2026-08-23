/**
 * The keeper's ten passes, as data (#1896).
 *
 * ── Why a table ──────────────────────────────────────────────────────
 *
 * `scheduled()` used to be ten hand-written blocks, each repeating the
 * same four concerns: wrap in `ctx.waitUntil`, attach a `.catch` so one
 * failure cannot wedge the next, name the pass in the error, and — once
 * this change lands — decide the cadence and time the run. Four things
 * remembered ten times is the shape that produced this card: every pass
 * fires every minute because firing every minute is what you get when
 * nobody writes down how often a pass actually needs to run.
 *
 * Written down here, each concern is applied by construction. A new
 * pass cannot forget its `.catch` or its timer, because it does not
 * write either.
 *
 * ── Cadences are derived, not chosen ─────────────────────────────────
 *
 * Every cadence below comes from a timing assumption the pass already
 * documents in its own file, not from taste. The three latency-
 * sensitive passes stay on every tick deliberately: `watcher` and
 * `liquidator` are protocol-safety functions, and `matcher` is the one
 * users feel. Those three are also the two the card names as
 * structurally expensive — which is exactly why they are left alone
 * until there is a profile. Slowing an expensive pass without measuring
 * it is how you find out later that it was not the expensive one.
 */
import type { Env } from './env';
import { isTickDue, isWithinUtcMinuteWindow } from '@vaipakam/lib/cronCadence';

import { runWatcher } from './watcher';
import { runDailyOracleSnapshot } from './dailyOracleSnapshot';
import { runMatcher } from './matcher';
import { runLiquidityConfidence } from './liquidityConfidence';
import { runLiquidator } from './liquidator';
import { runAutoLifecycle } from './autoLifecycle';
import { runPreGraceWatcher } from './preGraceWatcher';
import { runRewardBudgetRemit } from './rewardBudgetRemit';
import { runCommitmentReport } from './commitmentReport';
import { runRemitAck } from './remitAck';

/** The UTC hour `dailyOracleSnapshot` acts in, and how long it stays
 *  open — mirroring the window that pass already self-checks against.
 *  Wider than the snapshot needs so a few missed ticks cannot skip a
 *  day; the pass's own guard still decides whether it acts. */
export const DAILY_SNAPSHOT_HOUR_UTC = 0;
export const DAILY_SNAPSHOT_WINDOW_MINUTES = 10;

export interface KeeperPass {
  /** Matches the name the pass passes to `passIsArmed`, so a cadence
   *  skip and an arming skip read as lines about the same thing. */
  readonly name: string;
  /** Act when the scheduled UTC minute divides by this. */
  readonly cadenceMinutes: number;
  /** Which minute inside each cadence window to act on. Distinct
   *  offsets are what keep the staggered passes off each other's ticks
   *  — see the peak-tick note in the header. */
  readonly offsetMinutes?: number;
  /** Extra gate for a pass that only acts inside a daily window. */
  readonly dailyWindow?: boolean;
  /** One line, for the log, on why this cadence and not every tick. */
  readonly why: string;
  readonly run: (env: Env) => Promise<void>;
}

export const KEEPER_PASSES: readonly KeeperPass[] = [
  {
    name: 'watcher',
    cadenceMinutes: 1,
    why: 'health-factor band notifications — safety, every tick',
    run: runWatcher,
  },
  {
    name: 'liquidator',
    cadenceMinutes: 1,
    why: 'autonomous liquidation — protocol safety, every tick',
    run: runLiquidator,
  },
  {
    name: 'matcher',
    cadenceMinutes: 1,
    why: 'match latency is user-visible; left every tick pending a profile',
    run: runMatcher,
  },
  {
    name: 'dailyOracleSnapshot',
    cadenceMinutes: 1,
    dailyWindow: true,
    why: 'acts once per UTC day inside a fixed window; ~99% of ticks were overhead',
    run: runDailyOracleSnapshot,
  },
  {
    name: 'liquidityConfidence',
    // EVERY TICK, and the first cut of this table had it at 30m on a
    // misreading (Codex #1913 r1 P1). The 1h TTL that was derived from
    // covers only the off-chain ADVISORY caches, which gate a Tier-3
    // PROMOTION. Demotion is a different path entirely: it re-quotes
    // 0x/1inch fresh on every invocation and lowers `keeperTier` the
    // moment realized liquidity degrades, with no window at all — the
    // file calls it the fail-safe direction.
    //
    // A 30-minute cadence therefore delayed a safety demotion by up to
    // 29 minutes, and while the on-chain single-hop approximation stayed
    // optimistic, new loans could originate at an LTV the relay exists
    // to revoke. That is a safety regression, not a saving.
    //
    // Splitting the cached promotion advisory from the per-tick demotion
    // check is the better answer and would recover most of this CPU. It
    // is deliberately NOT done here: it changes the pass's internals and
    // deserves its own measurement, and growing this diff to reach it is
    // how a scheduling change turns into a liquidity-relay change.
    cadenceMinutes: 1,
    why: 'demotion re-quotes fresh each tick and is the fail-safe direction',
    run: runLiquidityConfidence,
  },
  {
    name: 'autoLifecycle',
    // EVERY TICK (Codex #1913 r2, by the same discriminator as the two
    // below). It stops after MAX_EXTENDS_PER_TICK submissions and
    // re-scans from zero next tick, and it does NOT order candidates by
    // urgency — so a backlog drains at a fixed rate in scan order, and
    // slowing the tick slows the drain proportionally against deadlines
    // measured in days but enforced to the second. The liquidator's
    // per-tick cap is safe because it sorts most-at-risk first; this
    // one has no such ordering.
    cadenceMinutes: 1,
    why: 'bounded per-tick drain with no urgency ordering — slowing it slows the drain',
    run: runAutoLifecycle,
  },
  {
    name: 'preGraceWatcher',
    // Warns on loans within 24h of their grace boundary, and throttles
    // repeat warnings on the same loan.
    cadenceMinutes: 15,
    offsetMinutes: 4,
    why: 'warns inside a 24h window with a repeat throttle — minutes are not material',
    run: runPreGraceWatcher,
  },
  {
    name: 'rewardBudgetRemit',
    cadenceMinutes: 5,
    offsetMinutes: 2,
    why: 'funds budgets on demand over a multi-day window',
    run: runRewardBudgetRemit,
  },
  {
    name: 'remitAck',
    // EVERY TICK (Codex #1913 r2 P2). The 15-minute backoff I derived a
    // 5m cadence from is an ATTEMPT backoff governing re-sends. First
    // discovery has no prior attempt, so nothing bounds it but this
    // cadence: a delivery landing just after the offset stayed Pending
    // on Base for the rest of the window.
    cadenceMinutes: 1,
    why: 'first-receipt discovery is unbounded by the re-send backoff',
    run: runRemitAck,
  },
  {
    name: 'commitmentReport',
    // EVERY TICK (Codex #1913 r2 P1). It pauses after 20 pages or 8
    // batches and resumes from a D1-persisted frontier on the NEXT
    // tick, so a historical gap needs several invocations to drain. A
    // 30-minute cadence turned each continuation from a one-minute wait
    // into a thirty-minute one — and Base gates that chain's ShareOfPool
    // remittance until the report completes.
    //
    // I derived the cadence from "reports are keyed by day", which is
    // true and irrelevant: what matters is that the pass carries
    // persisted work whose drain rate IS the tick rate.
    cadenceMinutes: 1,
    why: 'resumes a persisted frontier — the drain rate is the tick rate',
    run: runCommitmentReport,
  },
];

/**
 * Is this pass due on this tick, and why not if it is not?
 *
 * Returns `null` when due, or the reason to log when skipped. The
 * reason is returned rather than logged here so the caller emits
 * exactly one line per pass per tick — the contract `passIsArmed`
 * (#1475) established for the arming dimension, extended to cadence
 * rather than duplicated beside it.
 */
export function cadenceSkipReason(
  pass: KeeperPass,
  scheduledTimeMs: number | undefined,
): string | null {
  if (
    pass.dailyWindow === true &&
    !isWithinUtcMinuteWindow(
      scheduledTimeMs,
      DAILY_SNAPSHOT_HOUR_UTC,
      DAILY_SNAPSHOT_WINDOW_MINUTES,
    )
  ) {
    return (
      `outside its ${String(DAILY_SNAPSHOT_HOUR_UTC).padStart(2, '0')}:00–` +
      `${String(DAILY_SNAPSHOT_HOUR_UTC).padStart(2, '0')}:` +
      `${String(DAILY_SNAPSHOT_WINDOW_MINUTES).padStart(2, '0')} UTC window ` +
      `(${pass.why})`
    );
  }
  if (!isTickDue(scheduledTimeMs, pass.cadenceMinutes, pass.offsetMinutes ?? 0)) {
    return (
      `not this tick — cadence ${pass.cadenceMinutes}m` +
      `@:${String(pass.offsetMinutes ?? 0).padStart(2, '0')} (${pass.why})`
    );
  }
  return null;
}
