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
    // Its own advisory caches carry a 1h TTL, so a tick inside that hour
    // re-reads the same cached answer and can change nothing.
    cadenceMinutes: 30,
    offsetMinutes: 9,
    why: 'advisory caches hold a 1h TTL — a finer cadence re-reads the same answer',
    run: runLiquidityConfidence,
  },
  {
    name: 'autoLifecycle',
    // Auto-extend windows are measured in days and the pass carries a
    // soft per-tick cap, so minute granularity buys nothing.
    cadenceMinutes: 5,
    offsetMinutes: 1,
    why: 'extension windows are day-scale; per-tick cap makes minute granularity moot',
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
    // Acks retry on a 15-minute backoff, so scanning every minute
    // cannot make an ack land sooner than that backoff allows.
    cadenceMinutes: 5,
    offsetMinutes: 3,
    why: 'ack retries use a 15m backoff; a finer scan cannot land one sooner',
    run: runRemitAck,
  },
  {
    name: 'commitmentReport',
    // Reports per armed DAY, over a bounded recent-day window.
    cadenceMinutes: 30,
    offsetMinutes: 14,
    why: 'reports per armed day over a bounded window',
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
