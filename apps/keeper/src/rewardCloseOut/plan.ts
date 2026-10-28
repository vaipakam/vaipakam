// apps/keeper/src/rewardCloseOut/plan.ts
//
// The close-out pass's pure rules: which days a run may try to prove closed,
// which reward entries cover a day, whether a scan accounts for a day's whole
// total, how a walk's remaining ids are paged, when a retired custody era may
// be finalized, and when a day's transport cursor has an exhausted epoch to
// pass. No reads and no sends: `index.ts` feeds these with what it read.

/** Reward sides, as `LibVaipakam.RewardSide` numbers them. */
export const SIDE_LENDER = 0;
export const SIDE_BORROWER = 1;
export type Side = typeof SIDE_LENDER | typeof SIDE_BORROWER;

/** One reward entry, reduced to what the closure proof reads. */
export interface ScannedEntry {
  id: bigint;
  side: number;
  /** The first day the entry covers, read as the proof reads it: a
   *  `startDay` of 0 counts from day 1. */
  first: number;
  /** Exclusive. */
  endDay: number;
  perDayNumeraire18: bigint;
}

/** The days a run may try to prove closed: elapsed (before `today`), reached
 *  by both interest frontiers, and no older than the lookback. Null when no
 *  day qualifies. */
export function closureWindow(
  today: number,
  lenderFrontier: number,
  borrowerFrontier: number,
  lookbackDays: number,
): { from: number; upTo: number } | null {
  const upTo = Math.min(today - 1, lenderFrontier, borrowerFrontier);
  if (upTo < 0) return null;
  const from = Math.max(0, upTo - lookbackDays + 1);
  return { from, upTo };
}

/** Whether `e` covers `day`, as the proof checks it. */
export function covers(e: ScannedEntry, day: number): boolean {
  return day >= e.first && day < e.endDay;
}

/** The entries covering `day`, per side, in ascending id order. */
export function coveringEntries(entries: readonly ScannedEntry[], day: number): { lender: ScannedEntry[]; borrower: ScannedEntry[] } {
  const lender: ScannedEntry[] = [];
  const borrower: ScannedEntry[] = [];
  for (const e of entries) {
    if (!covers(e, day)) continue;
    if (e.side === SIDE_LENDER) lender.push(e);
    else if (e.side === SIDE_BORROWER) borrower.push(e);
  }
  const asc = (a: ScannedEntry, b: ScannedEntry) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { lender: lender.sort(asc), borrower: borrower.sort(asc) };
}

/**
 * Whether the scanned entries account for each side's whole folded total.
 * The proof completes a side only when the per-day figures it visited sum to
 * exactly that total, so a walk started on a scan that does not would open,
 * page, and never close. Null when both sides balance; otherwise what is off,
 * for the log.
 */
export function conservationGap(
  cover: { lender: readonly ScannedEntry[]; borrower: readonly ScannedEntry[] },
  totals: { lender: bigint; borrower: bigint },
): string | null {
  const sum = (xs: readonly ScannedEntry[]) => xs.reduce((a, e) => a + e.perDayNumeraire18, 0n);
  const gaps: string[] = [];
  const l = sum(cover.lender);
  const b = sum(cover.borrower);
  if (l !== totals.lender) gaps.push(`lender entries sum to ${l} of a ${totals.lender} total`);
  if (b !== totals.borrower) gaps.push(`borrower entries sum to ${b} of a ${totals.borrower} total`);
  return gaps.length === 0 ? null : gaps.join('; ');
}

/** The ids past `cursor`, ascending, in pages of at most `pageSize`. */
export function pagesAfter(ids: readonly bigint[], cursor: bigint, pageSize: number): bigint[][] {
  const rest = ids.filter((id) => id > cursor);
  const pages: bigint[][] = [];
  for (let i = 0; i < rest.length; i += pageSize) pages.push(rest.slice(i, i + pageSize));
  return pages;
}

/** One custody era's record, as `getCustodyEra` returns the fields read here. */
export interface EraRecord {
  daysClosed: bigint;
  boundaryDay: bigint;
  terminal: boolean;
  stagedFresh: bigint;
}

/**
 * Whether a RETIRED era may be finalized now, the contract's own rule: every
 * day of its span (its boundary day to the next era's) proven closed and no
 * staging hold on its row. A string says why not, for the log; null means
 * finalized already.
 */
export function eraReadiness(era: EraRecord, nextBoundaryDay: bigint): 'ready' | null | string {
  if (era.terminal) return null;
  const span = nextBoundaryDay - era.boundaryDay;
  if (era.daysClosed < span) return `${era.daysClosed} of its ${span} days proven closed`;
  if (era.stagedFresh !== 0n) return `${era.stagedFresh} of its row held by staging`;
  return 'ready';
}

/** One transport epoch, reduced to what the prune check reads. */
export interface EpochState {
  exists: boolean;
  balance: bigint;
  dayCount: number;
  indexedDays: number;
  references: bigint;
}

/**
 * Whether the epoch after a day's cursor can be passed by a prune. Only the
 * case this pass can tell for certain counts: the epoch exists, is fully
 * indexed, has nothing left and no staging record references it. An epoch
 * whose balance is not zero but whose rooms under its attested caps are (the
 * contract's other exhausted case) is NOT detected here and is left for the
 * next draw on the day, which prunes it in passing.
 */
export function epochPrunable(e: EpochState): boolean {
  return e.exists && e.indexedDays === e.dayCount && e.balance === 0n && e.references === 0n;
}
