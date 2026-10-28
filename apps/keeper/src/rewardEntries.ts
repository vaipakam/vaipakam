// apps/keeper/src/rewardEntries.ts
//
// The chain's reward-entry sequence, read the way every walk over a day's
// entries reads it. Two on-chain walks take a day's covering entries in
// ascending id order, per side, and complete a side only when the per-day
// figures they visited sum exactly to the day's folded total: the closure
// proof (`RewardClosureFacet`, the close-out pass) and a zeroed day's
// compensation quote (`accumulateCompQuoteBatch`, the zeroed-day pass). Both
// passes find those entries here, and check the sum here before sending
// anything, so a walk is never opened on a reading that could not finish it.
//
// Entry ids are creation-ordered and `startDay` never decreases along them,
// so a scan for days up to D stops at the first entry starting after D.

import { zeroAddress, type Address } from 'viem';

/** Reward sides, as `LibVaipakam.RewardSide` numbers them. */
export const SIDE_LENDER = 0;
export const SIDE_BORROWER = 1;
export type Side = typeof SIDE_LENDER | typeof SIDE_BORROWER;

/** One reward entry, reduced to what a walk over its day reads. */
export interface ScannedEntry {
  id: bigint;
  side: number;
  /** The first day the entry covers, read as every walk reads it: a
   *  `startDay` of 0 counts from day 1. */
  first: number;
  /** Exclusive. */
  endDay: number;
  perDayNumeraire18: bigint;
}

/** Whether `e` covers `day`, as every walk checks it. */
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
 * Every walk over a day's covering entries (the closure proof, a zeroed day's
 * compensation quote) completes a side only when the per-day figures it
 * visited sum to exactly that total, so a walk started on a scan that does
 * not would open, page, and never close. Null when both sides balance;
 * otherwise what is off, for the log.
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


/** `getRewardEntriesRange` page size (the view clamps at 500). */
export const ENTRY_PAGE = 500n;

/** One row of `getRewardEntriesRange`, the fields read here. */
export interface EntryRow {
  user: Address;
  startDay: number;
  endDay: number;
  side: number;
  perDayNumeraire18: bigint;
}

/**
 * The reward-entry sequence from id 1 up to the first entry starting after
 * `lastDay`, keeping only entries that end after `firstDay`. `readPage(from,
 * n)` is `getRewardEntriesRange`. Null when `maxPages` ran out first: a walk
 * on a partial scan cannot close, so the caller starts none.
 */
export async function scanEntries(
  readPage: (from: bigint, n: bigint) => Promise<readonly EntryRow[]>,
  firstDay: number,
  lastDay: number,
  maxPages: number,
): Promise<ScannedEntry[] | null> {
  const out: ScannedEntry[] = [];
  let next = 1n;
  for (let page = 0; page < maxPages; page++) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await readPage(next, ENTRY_PAGE);
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i];
      // A zeroed slot is past the end of the allocated sequence.
      if (e.user === zeroAddress && Number(e.endDay) === 0 && e.perDayNumeraire18 === 0n) return out;
      const first = Number(e.startDay) === 0 ? 1 : Number(e.startDay);
      if (first > lastDay) return out;
      if (Number(e.endDay) > firstDay) {
        out.push({ id: next + BigInt(i), side: Number(e.side), first, endDay: Number(e.endDay), perDayNumeraire18: e.perDayNumeraire18 });
      }
    }
    next += BigInt(rows.length);
    if (rows.length < Number(ENTRY_PAGE)) return out;
  }
  return null;
}
