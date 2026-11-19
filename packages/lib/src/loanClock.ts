/**
 * The loan clock, off-chain (#2808) — ONE copy of the rule the contracts
 * apply in `LibLoanClock` (#668 / #935, owner decision D2), for the indexer,
 * agent, keeper and app.
 *
 * The time the protocol spends paused is added to every open loan's due date
 * and grace end, counted from the loan's start. On-chain the credit is
 * `pausedSecondsAt(now) - pausedSecondsAt(startTime)`, read from the
 * pause-interval log `AdminFacet.getPauseIntervals` pages. This module takes
 * that same log and answers the same questions, so no off-chain reader ever
 * recomputes a deadline as `startTime + durationDays * 1 day`: that figure is
 * the ORIGINAL due date, and after any pause it is early by the credit.
 *
 * What it moves and what it does not, as the contract does:
 *   - the due date, the grace end and a periodic-interest payment deadline
 *     MOVE by the credit;
 *   - interest accrual does NOT (it accrues by elapsed time, pause included),
 *     and the point a periodic payment pays the lender THROUGH does not
 *     either: that is the period's unmoved end, which is also the period's
 *     identity on-chain (`lastPeriodicInterestSettledAt` advances to it);
 *   - offer, intent and listing expiries are not loan deadlines.
 *
 * While a pause is in force the credit grows with the clock, so a deadline
 * read then is a moving target: the time LEFT to it is what stays fixed.
 * {@link pauseInForceAt} lets a caller that keys anything on a deadline (a
 * one-shot reminder, say) wait until the pause ends instead of keying on a
 * value that changes every second.
 *
 * Grace length lives here too ({@link graceSecondsFromBuckets}), because the
 * effective grace end is the moved due date plus it, and a deadline rule that
 * had to borrow its other half from each app would drift the first time one
 * copy did.
 */
import type { Address, PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { isFunctionDoesNotExistRevert } from './contractRevert';

const DAY = 86_400n;

/** One entry of the on-chain pause-interval log (`LibPausable.PauseInterval`). */
export interface PauseInterval {
  /** When the pause began. */
  start: bigint;
  /** When it ended, or {@link OPEN_PAUSE_END} while a manual pause is in
   *  force. An auto-pause carries its window's own end, which may still be
   *  in the future. */
  end: bigint;
  /** Total paused time of every earlier interval. */
  pausedBefore: bigint;
}

/** The pause log, oldest first, exactly as `getPauseIntervals` pages it.
 *  Intervals never overlap and are sorted by `start`. */
export type PauseLog = readonly PauseInterval[];

/** `LibPausable.OPEN_END` — the end of a manual pause still in force. */
export const OPEN_PAUSE_END = 2n ** 64n - 1n;

/**
 * Total time the protocol had been paused before `t` — the contract's
 * `pausedSecondsAt`: the last interval starting at or before `t`, plus the
 * part of it before `t`. An open interval counts up to `t`. Zero before the
 * first pause.
 */
export function pausedSecondsAt(log: PauseLog, t: bigint): bigint {
  let lo = 0;
  let hi = log.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (log[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0n;
  const iv = log[lo - 1];
  const end = iv.end < t ? iv.end : t;
  return iv.pausedBefore + (end - iv.start);
}

/** Paused time between `from` and `to`; zero when `to <= from`. */
export function pausedSecondsBetween(log: PauseLog, from: bigint, to: bigint): bigint {
  if (to <= from) return 0n;
  return pausedSecondsAt(log, to) - pausedSecondsAt(log, from);
}

/** Whether a pause (manual, or an auto-pause window) is in force at `t`. */
export function pauseInForceAt(log: PauseLog, t: bigint): boolean {
  for (let i = log.length - 1; i >= 0; i--) {
    const iv = log[i];
    if (iv.start > t) continue;
    return t < iv.end;
  }
  return false;
}

/** The compile-time grace schedule `LibVaipakam.gracePeriod` uses when
 *  governance has set no buckets. */
export function defaultGraceSeconds(durationDays: bigint): bigint {
  if (durationDays < 7n) return 3_600n;
  if (durationDays < 30n) return DAY;
  if (durationDays < 90n) return 3n * DAY;
  if (durationDays < 180n) return 7n * DAY;
  if (durationDays < 365n) return 14n * DAY;
  return 30n * DAY;
}

/** One governance grace bucket, as `ConfigFacet.getGraceBuckets` returns it. */
export interface GraceBucket {
  maxDurationDays: bigint;
  graceSeconds: bigint;
}

/**
 * The grace window for a duration, from the bucket set the chain publishes —
 * the contract's walk: the first bucket whose threshold strictly exceeds
 * `durationDays` wins, a trailing `maxDurationDays == 0` entry is the
 * catch-all, and a malformed set with no match falls back to the LAST entry.
 * An EMPTY set is the compile-time default schedule, which IS the live config
 * (the contract's own zero-bucket path), not a missing one.
 */
export function graceSecondsFromBuckets(
  buckets: readonly GraceBucket[],
  durationDays: bigint,
): bigint {
  if (buckets.length === 0) return defaultGraceSeconds(durationDays);
  for (const b of buckets) {
    if (b.maxDurationDays === 0n) return b.graceSeconds; // catch-all
    if (durationDays < b.maxDurationDays) return b.graceSeconds;
  }
  return buckets[buckets.length - 1].graceSeconds;
}

/**
 * #3410 / #3525 — the latest L2 sequencer outage and its recovery window, as
 * `LoanClockFacet.getSequencerOutageWindow` reports it. A grace end that falls
 * inside `[downAt, windowEnd)` moves to `windowEnd` on-chain, so a borrower
 * who could not send a repayment during the outage can still repay in the
 * recovery window. The due date does NOT move: an outage changes when a
 * deadline may be enforced, not the loan's term. Both are zero on a network
 * with no sequencer feed (an L1), where nothing moves.
 *
 * Off-chain readers take this window from the Diamond, never from the feed,
 * so the outage rule has one source: the contract's own read of it.
 */
export interface SequencerOutageWindow {
  /** When the latest outage began. */
  downAt: bigint;
  /** The end of its recovery window; in the future while the sequencer is
   *  down or recovering. */
  windowEnd: bigint;
}

/** No outage to account for: a network without a sequencer feed, or a
 *  Diamond that predates #3410. Moves nothing. */
export const NO_SEQUENCER_OUTAGE: SequencerOutageWindow = { downAt: 0n, windowEnd: 0n };

/** `LibLoanClock.outageMoved`: `deadline`, moved to the window's end when it
 *  falls inside the window; unchanged otherwise. */
export function outageMoved(deadline: bigint, w: SequencerOutageWindow): bigint {
  return deadline >= w.downAt && deadline < w.windowEnd ? w.windowEnd : deadline;
}

/** The deadlines an Active loan is held to at a given moment — the shape of
 *  `LoanClockFacet.getLoanDeadlines`. */
export interface LoanDeadlines {
  /** `startTime + durationDays` days, before any credit. The due date the
   *  loan was originated with, and the one `LoanInitiatedDetails` announced. */
  originalMaturity: bigint;
  /** Paused time between the loan's start and `at`. */
  pauseCredit: bigint;
  /** The effective due date: the late fee runs past it. */
  maturity: bigint;
  /** The effective grace end: past it the loan may be defaulted and may no
   *  longer be repaid. Moved by a sequencer outage window it falls in. */
  graceEnd: bigint;
  /** Whether a sequencer outage moved the grace end (#3525), so a surface
   *  can say why it is later than the due date plus the grace period. */
  graceEndMovedByOutage: boolean;
}

/**
 * A loan's deadlines as of `at` — `LibLoanClock.maturity` / `graceEnd`.
 *
 * `startTime` is the loan's CURRENT start: an in-place extension or an
 * obligation handover resets it on-chain, and the credit then counts only the
 * pauses after the new start. `graceSeconds` is the grace for the loan's
 * duration ({@link graceSecondsFromBuckets}). `outage` is the Diamond's
 * latest sequencer outage window (#3525): a caller that has none to apply
 * passes {@link NO_SEQUENCER_OUTAGE} and says so where it shows the date. It
 * is required, so no caller leaves it out by accident.
 */
export function loanDeadlines(
  loan: { startTime: bigint; durationDays: bigint },
  graceSeconds: bigint,
  log: PauseLog,
  at: bigint,
  outage: SequencerOutageWindow,
): LoanDeadlines {
  const originalMaturity = loan.startTime + loan.durationDays * DAY;
  const pauseCredit = pausedSecondsBetween(log, loan.startTime, at);
  const maturity = originalMaturity + pauseCredit;
  const unmoved = maturity + graceSeconds;
  const graceEnd = outageMoved(unmoved, outage);
  return { originalMaturity, pauseCredit, maturity, graceEnd, graceEndMovedByOutage: graceEnd !== unmoved };
}

/**
 * A loan's effective due date as of `at` — `LibLoanClock.maturity` alone,
 * for a caller that needs no grace end (the keeper's in-term test, its
 * pre-grace warning). The same rule as {@link loanDeadlines}, which it reads.
 */
export function loanMaturity(
  loan: { startTime: bigint; durationDays: bigint },
  log: PauseLog,
  at: bigint,
): bigint {
  // The due date never moves for an outage, so no window is needed here.
  return loanDeadlines(loan, 0n, log, at, NO_SEQUENCER_OUTAGE).maturity;
}

/** A periodic-interest period, as the contract tracks it. */
export interface PeriodicPeriod {
  /** The period's unmoved end, `lastPeriodicInterestSettledAt + interval`:
   *  what a full payment pays the lender THROUGH, and the value the chain's
   *  stamp advances to. The period's identity — key anything per-period on
   *  this, never on the deadline. */
  periodEnd: bigint;
  /** The payment deadline, `LibPeriodicInterest.periodEndAt`: the unmoved
   *  end plus the loan's pause credit. */
  deadline: bigint;
  /** The credit in `deadline`. */
  pauseCredit: bigint;
}

/**
 * The current periodic-interest period as of `at`. `intervalDays` is the
 * cadence's interval (`LibVaipakam.intervalDays`), which the caller resolves;
 * zero means the loan has no cadence and yields null.
 *
 * The credit is counted from the LOAN's start, not from the last settlement,
 * because that is what the contract does: the whole schedule moves together.
 */
export function periodicPeriod(
  loan: { startTime: bigint; lastPeriodicInterestSettledAt: bigint },
  intervalDays: bigint,
  log: PauseLog,
  at: bigint,
): PeriodicPeriod | null {
  if (intervalDays === 0n) return null;
  const periodEnd = loan.lastPeriodicInterestSettledAt + intervalDays * DAY;
  const pauseCredit = pausedSecondsBetween(log, loan.startTime, at);
  return { periodEnd, deadline: periodEnd + pauseCredit, pauseCredit };
}

/**
 * The end of a loan's interest term as of `at` — `LibLoanClock.interestTermEnd`:
 * the original maturity (`startTime + durationDays`) moved by the paused time
 * since the loan's start. The term a rate shortfall at a sale or an early
 * close is priced over. #3169: derived from the term to the second; a partial
 * re-stamps only the interest clock, never the term.
 */
export function interestTermEnd(
  loan: { startTime: bigint; durationDays: bigint },
  log: PauseLog,
  at: bigint,
): bigint {
  return loan.startTime + loan.durationDays * DAY + pausedSecondsBetween(log, loan.startTime, at);
}

/**
 * #3169 — the seconds of interest a full-term loan owes at least for its
 * current accrual segment — `LibLoanClock.minimumInterestSeconds`: from the
 * interest clock's start to the term's end as it stood at that start, so a
 * pause inside the segment does not raise it. `interestAccrualStart` is the
 * RESOLVED clock start (`interestAccrualStartOf`), not the raw field.
 */
export function minimumInterestSeconds(
  loan: { startTime: bigint; durationDays: bigint; interestAccrualStart: bigint },
  log: PauseLog,
): bigint {
  const end = interestTermEnd(loan, log, loan.interestAccrualStart);
  return end > loan.interestAccrualStart ? end - loan.interestAccrualStart : 0n;
}

/** `SECONDS_PER_YEAR * BASIS_POINTS`: the denominator of every interest figure. */
const YEAR_BPS = 365n * DAY * 10_000n;

/** #3169 — interest on `principal` at `rateBps` over `seconds`, rounded down
 *  once — `LibEntitlement.proRataInterestSeconds`. */
export function proRataInterestSeconds(principal: bigint, rateBps: bigint, seconds: bigint): bigint {
  return (principal * rateBps * seconds) / YEAR_BPS;
}

/**
 * #3169 — the gross interest an ERC-20 loan owes at settlement as of `at` —
 * `LibEntitlement.settlementInterest`: the seconds since the interest clock's
 * start, or the full-term minimum when the loan carries it and that is more,
 * at the loan's rate, rounded down once. Gross of `interestSettled`; a caller
 * that needs the net subtracts it (saturating at 0), as the contract does.
 */
export function settlementInterestAt(
  loan: {
    startTime: bigint;
    durationDays: bigint;
    interestAccrualStart: bigint;
    principal: bigint;
    interestRateBps: bigint;
    useFullTermInterest: boolean;
  },
  log: PauseLog,
  at: bigint,
): bigint {
  const elapsed = at > loan.interestAccrualStart ? at - loan.interestAccrualStart : 0n;
  const floor = loan.useFullTermInterest ? minimumInterestSeconds(loan, log) : 0n;
  return proRataInterestSeconds(loan.principal, loan.interestRateBps, elapsed > floor ? elapsed : floor);
}

/**
 * A credit in words, for copy that says how far a pause moved a date: whole
 * days, hours and minutes, largest first, zero parts left out — "2 days 3
 * hours", "45 minutes". Never rounded UP: a two-hour pause is "2 hours", not
 * "1 day", because the copy states the credit rather than a figure near it.
 * A credit under a minute is "under a minute"; zero is "no time".
 */
export function describePauseCredit(pauseCredit: bigint): string {
  if (pauseCredit <= 0n) return 'no time';
  const days = pauseCredit / DAY;
  const hours = (pauseCredit % DAY) / 3_600n;
  const minutes = (pauseCredit % 3_600n) / 60n;
  const parts: string[] = [];
  const unit = (n: bigint, word: string) => {
    if (n > 0n) parts.push(`${n} ${word}${n === 1n ? '' : 's'}`);
  };
  unit(days, 'day');
  unit(hours, 'hour');
  unit(minutes, 'minute');
  return parts.length === 0 ? 'under a minute' : parts.join(' ');
}

/** The log as stored and served off-chain: decimal strings, so it survives
 *  JSON without precision loss ({@link OPEN_PAUSE_END} exceeds 2^53). */
export type PauseLogJson = { start: string; end: string; pausedBefore: string }[];

export function pauseLogToJson(log: PauseLog): PauseLogJson {
  return log.map((iv) => ({
    start: iv.start.toString(),
    end: iv.end.toString(),
    pausedBefore: iv.pausedBefore.toString(),
  }));
}

/**
 * Parse a stored or served log. Returns null for anything that is not a
 * well-formed, sorted, non-overlapping log — a damaged log is unknown, and a
 * deadline computed from it would be a figure nobody can substantiate.
 */
export function pauseLogFromJson(json: unknown): PauseLog | null {
  if (!Array.isArray(json)) return null;
  const out: PauseInterval[] = [];
  for (const e of json) {
    if (typeof e !== 'object' || e === null) return null;
    const { start, end, pausedBefore } = e as Record<string, unknown>;
    if (![start, end, pausedBefore].every((v) => typeof v === 'string' && /^\d+$/.test(v))) {
      return null;
    }
    const iv = {
      start: BigInt(start as string),
      end: BigInt(end as string),
      pausedBefore: BigInt(pausedBefore as string),
    };
    if (iv.end < iv.start) return null;
    const prev = out[out.length - 1];
    if (prev && (iv.start < prev.end || iv.pausedBefore !== prev.pausedBefore + (prev.end - prev.start))) {
      return null;
    }
    if (!prev && iv.pausedBefore !== 0n) return null;
    out.push(iv);
  }
  return out;
}

/** Default page size for {@link readPauseLog}. The log grows by one entry
 *  per pause, so one page is the whole log in practice. */
const PAGE = 64n;

/**
 * The log is longer than the caller can afford to read. Thrown, never
 * truncated: a log cut short reads as fewer pauses, which shows an early
 * deadline as current.
 */
export class PauseLogTooLongError extends Error {
  override name = 'PauseLogTooLongError';
  /** How many entries the log has. */
  readonly total: bigint;
  /** How many the caller allowed. */
  readonly limit: bigint;
  // Plain fields, not parameter properties: the app compiles this source
  // under `erasableSyntaxOnly`, which refuses them.
  constructor(total: bigint, limit: bigint) {
    super(`the pause log has ${total} entries; this reader takes at most ${limit}`);
    this.total = total;
    this.limit = limit;
  }
}

/**
 * Read the whole pause log from a Diamond, every page at the same block.
 *
 * A Diamond that does not route `getPauseIntervals` predates the loan clock
 * (#668 / #935): it never moves a deadline, so its log is DEFINITIVELY empty
 * and this returns `[]` — the same reasoning the indexer applies to a
 * pre-getter grace schedule. Every other failure throws: "could not read" is
 * not "never paused", and a caller that turned it into an empty log would
 * show an early deadline as current.
 *
 * `maxPages` bounds the requests for a caller with a fixed request budget
 * (the agent's reminder lane): a log needing more throws
 * {@link PauseLogTooLongError} after the first page, which carries the total.
 */
export async function readPauseLog(opts: {
  client: PublicClient;
  diamond: Address;
  blockNumber?: bigint;
  pageSize?: bigint;
  maxPages?: number;
}): Promise<PauseLog> {
  const pageSize = opts.pageSize ?? PAGE;
  const log: PauseInterval[] = [];
  let from = 0n;
  for (;;) {
    let page: readonly PauseInterval[];
    let total: bigint;
    try {
      [page, total] = (await opts.client.readContract({
        address: opts.diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getPauseIntervals',
        args: [from, pageSize],
        blockNumber: opts.blockNumber,
      })) as readonly [readonly PauseInterval[], bigint];
    } catch (err) {
      if (from === 0n && isFunctionDoesNotExistRevert(err)) return [];
      throw err;
    }
    if (opts.maxPages !== undefined && total > pageSize * BigInt(opts.maxPages)) {
      throw new PauseLogTooLongError(total, pageSize * BigInt(opts.maxPages));
    }
    log.push(
      ...page.map((iv) => ({ start: iv.start, end: iv.end, pausedBefore: iv.pausedBefore })),
    );
    from += BigInt(page.length);
    if (page.length === 0 || from >= total) break;
  }
  return log;
}

/** The window as stored and served off-chain: decimal strings. */
export type SequencerOutageJson = { downAt: string; windowEnd: string };

export function outageWindowToJson(w: SequencerOutageWindow): SequencerOutageJson {
  return { downAt: w.downAt.toString(), windowEnd: w.windowEnd.toString() };
}

/** Parse a stored or served window; null for anything malformed (an unknown
 *  window, never "no outage"). */
export function outageWindowFromJson(json: unknown): SequencerOutageWindow | null {
  if (typeof json !== 'object' || json === null) return null;
  const { downAt, windowEnd } = json as Record<string, unknown>;
  if (![downAt, windowEnd].every((v) => typeof v === 'string' && /^\d+$/.test(v))) return null;
  return { downAt: BigInt(downAt as string), windowEnd: BigInt(windowEnd as string) };
}

/**
 * Read the Diamond's latest sequencer outage window (#3525). A Diamond that
 * does not route `getSequencerOutageWindow` predates #3410 and never moves a
 * grace end for an outage, so that is definitively {@link NO_SEQUENCER_OUTAGE}.
 * Every other failure throws: "could not read" is not "no outage", and a
 * caller that turned it into one would show a moved grace end as passed.
 */
export async function readSequencerOutageWindow(opts: {
  client: PublicClient;
  diamond: Address;
  blockNumber?: bigint;
}): Promise<SequencerOutageWindow> {
  try {
    const [downAt, windowEnd] = (await opts.client.readContract({
      address: opts.diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getSequencerOutageWindow',
      blockNumber: opts.blockNumber,
    })) as readonly [bigint, bigint];
    return { downAt, windowEnd };
  } catch (err) {
    if (isFunctionDoesNotExistRevert(err)) return NO_SEQUENCER_OUTAGE;
    throw err;
  }
}
