/**
 * Auto-lend per-slot history — the figures one slot's card shows, computed
 * once here and served as they are; the app renders them and never
 * recomputes. Every figure is about PAST loans and is labelled so: it is not
 * a forecast, and nothing here suggests a rate to the slot's owner.
 *
 * Two parts:
 *
 * - **The slot's terms**, read from the ledger of decoded events
 *   (`activity_events`): its latest `LenderIntentSet` and whether a
 *   `LenderIntentCancelled` came after it. `termsSince` is when the terms in
 *   force were first set: a re-set with the same terms does not move it, a
 *   change to any term does, and a set after a cancel starts again.
 *
 * - **The rate comparison**: loans opened on the same pair over the last 30
 *   days that the slot could have made, stated as a range — the lowest rate,
 *   the highest, and the rate below which half the amount opened — with the
 *   loan count and the slot's own minimum beside them. A loan is comparable
 *   when its agreed terms are confirmed (`marketPlacement.ts`'s rule), its
 *   principal is confirmed, both legs are ERC-20, it is not a sale vehicle's
 *   bookkeeping loan, its term is one the slot accepts (at most the slot's
 *   longest), its amount is at least the slot's smallest fill, and its lender
 *   and borrower at opening were different wallets (read from that loan's
 *   `LoanInitiated`; a loan whose opening event the ledger does not hold is
 *   counted and left out). Fewer than `MIN_COMPARABLE_LOANS` loans, or fewer
 *   than `MIN_COMPARABLE_BORROWERS` borrowers, states "not enough" and no
 *   figure at all.
 *
 * - **The share of time lent**: the slot's principal out on loan divided by
 *   the money behind it, by money × time, over the last 30 days or since the
 *   terms in force were set, whichever is later. It reads `SlotLedgerSet`,
 *   which the ledger host emits on every move of a slot's figures (a fill,
 *   an instant fill, a takeover in or out, a repayment, a write-off, a
 *   release, a set, a fund or a withdrawal) with the slot's live principal
 *   and its unlent capital after the move. The money behind the slot at any
 *   moment is live + capital, capped at the slot's largest exposure; time
 *   with nothing behind it counts for nothing (it is left out of both sides,
 *   never read as zero). The share needs the slot's state at the start of
 *   the period, so it is served only when the ledger holds a `SlotLedgerSet`
 *   at or before that start: on a chain whose build predates the event, or a
 *   slot whose record does not reach back that far, it is `available: false`
 *   with its reason, never an estimate.
 */

/** The look-back of both figures, in days. */
export const SLOT_HISTORY_WINDOW_DAYS = 30;
/** Below this many comparable loans, no figure is shown. */
export const MIN_COMPARABLE_LOANS = 5;
/** Below this many distinct borrowers among them, no figure is shown. */
export const MIN_COMPARABLE_BORROWERS = 3;
/** The most comparable loans one response reads; past it the newest are
 *  kept and `truncated` says so. */
export const COMPARABLE_SCAN_CAP = 5_000;
/** The most of one slot's ledger moves one response reads for the period. */
export const SLOT_LEDGER_SCAN_CAP = 5_000;
/** The most of one slot's set / cancel events one response reads. */
export const SLOT_EVENT_SCAN_CAP = 500;

/** The two event kinds that write a slot's terms. Spelled exactly as the
 *  partial index's condition (migration 0114), so the planner can use it. */
/** The ledger host's per-move record of a slot's figures. */
export const SLOT_LEDGER_KIND = 'SlotLedgerSet';

export const SLOT_TERMS_KINDS_SQL = "kind IN ('LenderIntentSet', 'LenderIntentCancelled')";

/** One slot, as the route names it. Addresses lower-cased. */
export interface SlotKey {
  owner: string;
  lendingAsset: string;
  collateralAsset: string;
  slot: number;
}

/** One `LenderIntentSet` / `LenderIntentCancelled` row from the ledger. */
export interface SlotEventRow {
  kind: string;
  block_number: number;
  log_index: number;
  block_at: number;
  args_json: string;
}

/** The slot's terms in force, as its last set stated them. Amounts are
 *  decimal strings in the lending asset's smallest unit. */
export interface SlotTerms {
  state: 'open' | 'cancelled';
  minRateBps: number;
  maxDurationDays: number;
  minFillAmount: string;
  maxExposure: string;
  maxInitLtvBps: number;
  lendUntil: number;
  /** When the terms in force were first set (unix seconds). */
  termsSince: number;
  /** When the slot's last set or cancel landed (unix seconds). */
  lastChangedAt: number;
}

const TERM_FIELDS = [
  'maxExposure',
  'minRateBps',
  'maxInitLtvBps',
  'maxDurationDays',
  'minFillAmount',
  'requiresKeeperAuth',
  'lendUntil',
  'acceptsProRata',
] as const;

function termsKey(args: Record<string, unknown>): string {
  return JSON.stringify(TERM_FIELDS.map((f) => String(args[f])));
}

function safeInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

function amount(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  return typeof v === 'string' && /^\d+$/.test(v) ? v : null;
}

/**
 * Fold one slot's set / cancel events (any order) into its terms in force.
 * Null when the ledger holds no set for the slot, or the last set cannot be
 * read: the terms are then unknown, never guessed.
 */
export function slotTermsFrom(rows: readonly SlotEventRow[]): SlotTerms | null {
  const ordered = [...rows].sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);
  let last: Record<string, unknown> | null = null;
  let lastKey: string | null = null;
  let termsSince = 0;
  let lastChangedAt = 0;
  let cancelled = false;
  for (const row of ordered) {
    lastChangedAt = row.block_at;
    if (row.kind === 'LenderIntentCancelled') {
      cancelled = true;
      lastKey = null; // a set after a cancel starts the record again
      continue;
    }
    if (row.kind !== 'LenderIntentSet') continue;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(row.args_json) as Record<string, unknown>;
    } catch {
      return null;
    }
    const key = termsKey(args);
    if (key !== lastKey) termsSince = row.block_at;
    last = args;
    lastKey = key;
    cancelled = false;
  }
  if (!last) return null;
  const minRateBps = safeInt(last.minRateBps);
  const maxDurationDays = safeInt(last.maxDurationDays);
  const maxInitLtvBps = safeInt(last.maxInitLtvBps);
  const lendUntil = safeInt(last.lendUntil);
  const minFillAmount = amount(last.minFillAmount);
  const maxExposure = amount(last.maxExposure);
  if (
    minRateBps === null ||
    maxDurationDays === null ||
    maxInitLtvBps === null ||
    lendUntil === null ||
    minFillAmount === null ||
    maxExposure === null
  ) {
    return null;
  }
  return {
    state: cancelled ? 'cancelled' : 'open',
    minRateBps,
    maxDurationDays,
    minFillAmount,
    maxExposure,
    maxInitLtvBps,
    lendUntil,
    termsSince,
    lastChangedAt,
  };
}

/** One candidate loan: the loans row's confirmed opening terms and the
 *  parties its `LoanInitiated` named (null when the ledger holds none). */
export interface ComparableCandidate {
  loan_id: number;
  init_rate_bps: number;
  init_principal: string;
  init_lender: string | null;
  init_borrower: string | null;
}

/** The rate comparison as served. `enough: false` carries no figure. */
export type RateComparison =
  | {
      enough: true;
      loanCount: number;
      borrowerCount: number;
      lowestBps: number;
      highestBps: number;
      /** The rate below which half the amount opened: the lowest rate at
       *  which the amount opened at or below it reaches half the total. */
      halfAmountBps: number;
    }
  | { enough: false };

/** What was left out of the comparison and why. */
export interface ComparisonExclusions {
  /** Lender and borrower were the same wallet at opening. */
  selfLoans: number;
  /** Below the slot's smallest fill. */
  belowMinimumFill: number;
  /** The ledger holds no opening event naming the parties. */
  partiesUnknown: number;
}

/**
 * Apply the per-loan rules (self loans, the smallest fill, unknown parties)
 * the SQL cannot, and compute the range. Pure, so the route and the tests
 * share one rule.
 */
export function compareRates(
  candidates: readonly ComparableCandidate[],
  minFillAmount: string,
): { comparison: RateComparison; excluded: ComparisonExclusions } {
  const minFill = BigInt(minFillAmount);
  const excluded: ComparisonExclusions = { selfLoans: 0, belowMinimumFill: 0, partiesUnknown: 0 };
  const kept: Array<{ rate: number; principal: bigint; borrower: string }> = [];
  for (const c of candidates) {
    if (!c.init_lender || !c.init_borrower) {
      excluded.partiesUnknown += 1;
      continue;
    }
    const lender = c.init_lender.toLowerCase();
    const borrower = c.init_borrower.toLowerCase();
    if (lender === borrower) {
      excluded.selfLoans += 1;
      continue;
    }
    if (!/^\d+$/.test(c.init_principal)) {
      excluded.partiesUnknown += 1;
      continue;
    }
    const principal = BigInt(c.init_principal);
    if (principal < minFill) {
      excluded.belowMinimumFill += 1;
      continue;
    }
    kept.push({ rate: c.init_rate_bps, principal, borrower });
  }
  const borrowers = new Set(kept.map((k) => k.borrower));
  if (kept.length < MIN_COMPARABLE_LOANS || borrowers.size < MIN_COMPARABLE_BORROWERS) {
    return { comparison: { enough: false }, excluded };
  }
  kept.sort((a, b) => a.rate - b.rate);
  const total = kept.reduce((sum, k) => sum + k.principal, 0n);
  let running = 0n;
  let halfAmountBps = kept[kept.length - 1]!.rate;
  for (const k of kept) {
    running += k.principal;
    // `running * 2 >= total` — half the amount opened at or below this rate.
    if (running * 2n >= total) {
      halfAmountBps = k.rate;
      break;
    }
  }
  return {
    comparison: {
      enough: true,
      loanCount: kept.length,
      borrowerCount: borrowers.size,
      lowestBps: kept[0]!.rate,
      highestBps: kept[kept.length - 1]!.rate,
      halfAmountBps,
    },
    excluded,
  };
}

/** The period the share of time lent would cover: the last 30 days, or since
 *  the terms in force were set when that is later. */
export function lentSharePeriod(terms: SlotTerms, nowSec: number): { periodStart: number; periodEnd: number; daysOfRecord: number } {
  const periodStart = Math.max(nowSec - SLOT_HISTORY_WINDOW_DAYS * 86_400, terms.termsSince);
  return {
    periodStart,
    periodEnd: nowSec,
    daysOfRecord: Math.max(0, Math.floor((nowSec - periodStart) / 86_400)),
  };
}

/** One `SlotLedgerSet` row: the slot's live principal and unlent capital
 *  after a move. Amounts are decimal strings. */
export interface SlotLedgerRow {
  block_number: number;
  log_index: number;
  block_at: number;
  args_json: string;
}

/** The share of time lent as served. */
export type LentShare =
  | {
      available: true;
      periodStart: number;
      periodEnd: number;
      daysOfRecord: number;
      /** Live principal × time over money behind the slot × time, in basis
       *  points (0–10,000), over the part of the period with money behind
       *  it. Null when nothing was behind the slot for the whole period. */
      shareBps: number | null;
      /** Seconds of the period with money behind the slot. */
      fundedSeconds: number;
    }
  | {
      available: false;
      periodStart: number;
      periodEnd: number;
      daysOfRecord: number;
      /** `no-record-at-period-start`: the ledger holds no `SlotLedgerSet` for
       *  the slot at or before the period's start (the chain's build predates
       *  the event, or the slot's record does not reach back that far).
       *  `unreadable-record`: a record could not be read.
       *  `record-too-long`: the period holds more moves than one response
       *  reads (`SLOT_LEDGER_SCAN_CAP`). */
      reason: 'no-record-at-period-start' | 'unreadable-record' | 'record-too-long';
    };

function ledgerPoint(row: SlotLedgerRow): { at: number; live: bigint; capital: bigint } | null {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(row.args_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const live = amount(args.live);
  const capital = amount(args.capital);
  if (live === null || capital === null) return null;
  return { at: row.block_at, live: BigInt(live), capital: BigInt(capital) };
}

/**
 * The share of time lent over `[periodStart, periodEnd]`. `before` is the
 * slot's last `SlotLedgerSet` at or before `periodStart` (its state when the
 * period opens), `within` every later one up to `periodEnd`, in chain order.
 */
export function lentShareFrom(
  terms: SlotTerms,
  before: SlotLedgerRow | null,
  within: readonly SlotLedgerRow[],
  nowSec: number,
): LentShare {
  const period = lentSharePeriod(terms, nowSec);
  if (!before) return { available: false, ...period, reason: 'no-record-at-period-start' };
  const start = ledgerPoint(before);
  if (!start) return { available: false, ...period, reason: 'unreadable-record' };
  const points: Array<{ at: number; live: bigint; capital: bigint }> = [{ ...start, at: period.periodStart }];
  const ordered = [...within].sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);
  for (const row of ordered) {
    const p = ledgerPoint(row);
    if (!p) return { available: false, ...period, reason: 'unreadable-record' };
    points.push({ ...p, at: Math.min(Math.max(p.at, period.periodStart), period.periodEnd) });
  }
  const cap = BigInt(terms.maxExposure);
  let lentTime = 0n;
  let backedTime = 0n;
  let fundedSeconds = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const until = i + 1 < points.length ? points[i + 1]!.at : period.periodEnd;
    const dt = until - p.at;
    if (dt <= 0) continue;
    const behindUncapped = p.live + p.capital;
    const behind = behindUncapped < cap ? behindUncapped : cap;
    if (behind === 0n) continue; // nothing behind the slot: counts for nothing
    const live = p.live < behind ? p.live : behind;
    lentTime += live * BigInt(dt);
    backedTime += behind * BigInt(dt);
    fundedSeconds += dt;
  }
  return {
    available: true,
    ...period,
    shareBps: backedTime === 0n ? null : Number((lentTime * 10_000n) / backedTime),
    fundedSeconds,
  };
}

