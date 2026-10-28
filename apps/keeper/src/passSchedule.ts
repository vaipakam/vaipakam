/**
 * The keeper's passes, as data (#1896).
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
import { RUN_DEADLINE_MARGIN_MS } from './runWindow';

import { runWatcher } from './watcher';
import { runDailyOracleSnapshot } from './dailyOracleSnapshot';
import { runMatcher } from './matcher';
import { runLiquidityConfidence } from './liquidityConfidence';
import { runLiquidator } from './liquidator';
import { runAutoLifecycle } from './autoLifecycle';
import { runPreGraceWatcher } from './preGraceWatcher';
import { runRewardBudgetRemit } from './rewardBudgetRemit';
import { PASS_CADENCE_SEC as SANCTIONS_HOLD_CADENCE_SEC, runRewardSanctionsHold } from './rewardSanctionsHold';
import { PASS_CADENCE_SEC as HORIZON_HEARTBEAT_CADENCE_SEC, runRewardHorizonHeartbeat } from './rewardHorizonHeartbeat';
import { runCommitmentReport } from './commitmentReport';
import { runRemitAck } from './remitAck';
import { runGraceDefault } from './graceDefault';
import { PASS_CADENCE_SEC as PERIODIC_SETTLE_CADENCE_SEC, runPeriodicSettle } from './periodicSettle';
import { PASS_CADENCE_SEC as DAY_CLOSE_CADENCE_SEC, runRewardDayClose } from './rewardDayClose';
import { PASS_CADENCE_SEC as CLOSE_OUT_CADENCE_SEC, runRewardCloseOut } from './rewardCloseOut';
import { PASS_CADENCE_SEC as ZEROED_DAY_CADENCE_SEC, runRewardZeroedDay } from './rewardZeroedDay';
import { PASS_CADENCE_SEC as RETURN_TRANSPORT_CADENCE_SEC, runRewardReturnTransport } from './rewardReturnTransport';
import { PASS_CADENCE_SEC as PROTOCOL_UPKEEP_CADENCE_SEC, runProtocolUpkeep } from './protocolUpkeep';
import { PASS_CADENCE_SEC as PREPAY_AUTO_LIST_CADENCE_SEC, runPrepayAutoList } from './prepayAutoList';

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
  /** Act when the scheduled UTC minute divides by this. A pass whose own
   *  bounds are derived from its cadence (an alert aged in scans, say) exports
   *  that cadence and is scheduled FROM it, so the two cannot drift (#2775). */
  readonly cadenceMinutes: number;
  /** Which minute inside each cadence window to act on. Distinct
   *  offsets are what keep the staggered passes off each other's ticks
   *  — see the peak-tick note in the header. */
  readonly offsetMinutes?: number;
  /** Extra gate for a pass that only acts inside a daily window. */
  readonly dailyWindow?: boolean;
  /** One line, for the log, on why this cadence and not every tick. */
  readonly why: string;
  readonly run: (env: Env, tick: PassTick) => Promise<void>;
}

/** What a pass knows about the tick that launched it. */
export interface PassTick {
  /** The tick's SCHEDULED epoch (`controller.scheduledTime`), so a pass that
   *  derives anything from the tick — a rotation, a window — agrees with the
   *  cadence gate on which tick this is even when delivery is late.
   *  Undefined only for an invocation that is not a cron tick. */
  readonly scheduledTimeMs: number | undefined;
  /** When this run must have finished: its scheduled minute plus its own
   *  cadence, less a margin (#2497 r18). The host never relaunches a pass whose
   *  previous run is still going, so a run past this costs the pass its next
   *  run. A pass doing unbounded work checks it in its read AND send loops and
   *  leaves the rest for the next run. */
  readonly deadlineMs: number;
}

// Lives in the leaf module `runWindow.ts`, which passes import without a cycle.
export { RUN_DEADLINE_MARGIN_MS } from './runWindow';

/** The deadline of one run of `pass` launched for `scheduledTimeMs`. Pure. */
export function runDeadline(pass: Pick<KeeperPass, 'cadenceMinutes'>, scheduledTimeMs: number | undefined, nowMs: number = Date.now()): number {
  return (scheduledTimeMs ?? nowMs) + pass.cadenceMinutes * 60_000 - RUN_DEADLINE_MARGIN_MS;
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
    name: 'graceDefault',
    // Every loan it acts on is already past a grace period measured in
    // days, so a few minutes' delay changes nothing material, and each
    // candidate costs a quote round, an eth_simulateV1 and a send. The cap is
    // one chain, one bounded scan window and one attempt per run — the
    // invocation's subrequest allowance is shared — rotated rather than
    // urgency-ordered (graceDefault.ts): twelve attempts an hour across all
    // chains, which a testnet backlog never strains; revisit cadence and cap
    // together if a mainnet one does.
    cadenceMinutes: 5,
    offsetMinutes: 3,
    why: 'acts on loans already days past grace; each attempt costs quotes and a simulation',
    run: runGraceDefault,
  },
  {
    name: 'periodicSettle',
    // Settles a periodic-interest period already past its grace window,
    // which is measured in days. Same bounds as graceDefault: one chain, one
    // scan window and one attempt per run, each costing a quote round, a
    // simulation and a send. :05/:20/:35/:50 — clear of every staggered
    // pass (the 5-minute ones sit on :02–:03 modulo 5, the :04-modulo-5
    // minutes are preGraceWatcher's, rewardSanctionsHold's and the
    // heartbeat's, and rewardDayClose has :10/:25/:40/:55).
    cadenceMinutes: PERIODIC_SETTLE_CADENCE_SEC / 60,
    offsetMinutes: 5,
    why: 'acts on periods already days past grace; each attempt costs quotes and a simulation',
    run: runPeriodicSettle,
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
  {
    name: 'rewardSanctionsHold',
    cadenceMinutes: SANCTIONS_HOLD_CADENCE_SEC / 60,
    // :14, not :13 — graceDefault (#2483, 5-minute cadence from :03) took
    // :13 when the two branches met; the stagger test pins one pass a minute.
    offsetMinutes: 14,
    why: 'observes a held claimant every 6 h inside a 24 h gap; hourly keeps each alert within one cadence (#2450)',
    run: runRewardSanctionsHold,
  },
  {
    name: 'rewardHorizonHeartbeat',
    cadenceMinutes: HORIZON_HEARTBEAT_CADENCE_SEC / 60,
    // :44 — clear of every staggered pass (the 5-minute ones sit on :02–:03
    // modulo 5, preGraceWatcher on :04/:19/:34/:49, rewardSanctionsHold on :14).
    offsetMinutes: 44,
    why: 'touches every live reward entry about every 12 h, far inside the 7-day observation gap; hourly spreads the batches and retries a failed touch within the hour (#2517)',
    run: runRewardHorizonHeartbeat,
  },
  {
    name: 'rewardDayClose',
    cadenceMinutes: DAY_CLOSE_CADENCE_SEC / 60,
    // :10/:25/:40/:55 — clear of every staggered pass (the 5-minute ones sit on
    // :02–:03 modulo 5, preGraceWatcher on :04/:19/:34/:49, the hourly ones on
    // :14 and :44).
    offsetMinutes: 10,
    why: 'a reward day closes once a day, then waits on CCIP and a 4 h grace; a quarter-hour keeps each step within minutes of becoming possible (#2612)',
    run: runRewardDayClose,
  },
  {
    name: 'rewardCloseOut',
    cadenceMinutes: CLOSE_OUT_CADENCE_SEC / 60,
    // :00/:15/:30/:45 — clear of every staggered pass (the 5-minute ones sit
    // on :02–:03 modulo 5, the 15-minute ones on :04, :05, :09 and :10
    // modulo 15, the hourly ones on :14 and :44).
    offsetMinutes: 0,
    why: 'proves finished reward days closed and releases what they held; a day proven closed stays closed, so minutes are not material (#2984)',
    run: runRewardCloseOut,
  },
  {
    name: 'rewardZeroedDay',
    cadenceMinutes: ZEROED_DAY_CADENCE_SEC / 60,
    // :09/:24/:39/:54 — the one quarter-hour offset still clear of every
    // staggered pass (the 5-minute ones sit on :02–:03 modulo 5, the
    // 15-minute ones on :00, :04, :05 and :10 modulo 15, the hourly ones on
    // :14 and :44).
    offsetMinutes: 9,
    why: 'quotes a zeroed reward day so Base can compensate it before its lapse, and lapses it once the frozen window passes; a lapse window is days long (#2984)',
    run: runRewardZeroedDay,
  },
  {
    name: 'rewardReturnTransport',
    cadenceMinutes: RETURN_TRANSPORT_CADENCE_SEC / 60,
    // :29 — clear of every staggered pass (the 5-minute ones sit on :02–:03
    // modulo 5, the 15-minute ones on :00, :04, :05, :09 and :10 modulo 15,
    // the hourly ones on :14 and :44).
    offsetMinutes: 29,
    why: 'sends reward VPFI home and the messages that release Base\'s reservations; each waits on CCIP for minutes to hours, and each send pays a CCIP fee (#2984)',
    run: runRewardReturnTransport,
  },
  {
    name: 'protocolUpkeep',
    cadenceMinutes: PROTOCOL_UPKEEP_CADENCE_SEC / 60,
    // :59 — the last hourly minute clear of every staggered pass (the
    // 5-minute ones sit on :02–:03 modulo 5, the 15-minute ones on :00, :04,
    // :05, :09 and :10 modulo 15, the hourly ones on :14, :29 and :44).
    offsetMinutes: 59,
    why: 'rolls back expired buyback intents and keeps the tier LTV cache from lapsing; an expired intent and a 14-day cache wait hours without harm (#2984)',
    run: runProtocolUpkeep,
  },
  {
    name: 'prepayAutoList',
    cadenceMinutes: PREPAY_AUTO_LIST_CADENCE_SEC / 60,
    why: 'lists NFT collateral at the floor during grace; the shortest grace is one hour, and every unlisted minute is one a buyer at the floor cannot take it (#2984)',
    run: runPrepayAutoList,
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
