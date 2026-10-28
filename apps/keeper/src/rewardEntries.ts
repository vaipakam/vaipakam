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
 * A scan's persisted starting point (Codex #2993 r1): every entry below `id`
 * ends on or before `day`, so a later scan whose oldest day is at least `day`
 * can start at `id`. It moves forward only as the oldest day a pass still
 * works moves forward, so what a scan reads is bounded by the entries live
 * across the days it works, never by every entry the chain has made.
 */
export interface EntryFloor {
  id: bigint;
  day: number;
}

/** A floor as a scan cursor stores it (`scanCursors.ts`). */
export function encodeEntryFloor(f: EntryFloor): string {
  return `${f.id}:${f.day}`;
}

/** A stored floor, or null when there is none or it cannot be read. */
export function decodeEntryFloor(raw: string | undefined): EntryFloor | null {
  const m = raw === undefined ? null : /^(\d+):(\d+)$/.exec(raw);
  return m === null ? null : { id: BigInt(m[1]), day: Number(m[2]) };
}

/** What one bounded scan read. */
export interface EntryScan {
  /** The entries read that end after the scan's first day, ascending. */
  entries: ScannedEntry[];
  /** Every entry starting on or before this day was read, so each day up to
   *  it has all its covering entries in `entries`. Below the scan's first day
   *  when not even that day's could be read within the page budget. */
  completeThrough: number;
  /** Where the next scan starts, valid for any first day at or after this
   *  scan's. */
  floor: EntryFloor;
}

/**
 * The reward-entry sequence from `floor` (id 1 when there is none, or when it
 * was recorded for a later first day than `firstDay`) up to the first entry
 * starting after `lastDay`, keeping only entries that end after `firstDay`.
 * `readPage(from, n)` is `getRewardEntriesRange`. At most `maxPages` pages are
 * read; when they run out first, `completeThrough` says which days the scan
 * still covers whole, since `startDay` never decreases along the ids. A walk
 * on a day past it would open on a partial reading, so the caller starts none.
 */
export async function scanEntries(
  readPage: (from: bigint, n: bigint) => Promise<readonly EntryRow[]>,
  firstDay: number,
  lastDay: number,
  maxPages: number,
  floor: EntryFloor | null,
): Promise<EntryScan> {
  const out: ScannedEntry[] = [];
  let next = floor !== null && floor.id > 1n && floor.day <= firstDay ? floor.id : 1n;
  const done = (): EntryScan => ({ entries: out, completeThrough: lastDay, floor: { id: out[0]?.id ?? next, day: firstDay } });
  let lastFirst = firstDay;
  for (let page = 0; page < maxPages; page++) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await readPage(next, ENTRY_PAGE);
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i];
      // A zeroed slot is past the end of the allocated sequence.
      if (e.user === zeroAddress && Number(e.endDay) === 0 && e.perDayNumeraire18 === 0n) {
        next += BigInt(i);
        return done();
      }
      const first = Number(e.startDay) === 0 ? 1 : Number(e.startDay);
      if (first > lastDay) {
        next += BigInt(i);
        return done();
      }
      lastFirst = first;
      if (Number(e.endDay) > firstDay) {
        out.push({ id: next + BigInt(i), side: Number(e.side), first, endDay: Number(e.endDay), perDayNumeraire18: e.perDayNumeraire18 });
      }
    }
    next += BigInt(rows.length);
    if (rows.length < Number(ENTRY_PAGE)) return done();
  }
  // The pages ran out: an entry not yet read may still start on `lastFirst`.
  return { entries: out, completeThrough: lastFirst - 1, floor: { id: out[0]?.id ?? next, day: firstDay } };
}
