// apps/keeper/src/rewardEntries.ts
//
// The chain's reward-entry sequence, read the way every walk over a day's
// entries reads it. Two on-chain walks take a day's covering entries in
// ascending id order, per side, and complete a side only when the per-day
// figures they visited sum exactly to the day's folded total: the closure
// proof (`RewardClosureFacet`, the close-out pass) and a zeroed day's
// compensation quote (`accumulateCompQuoteBatch`, the zeroed-day pass). Both
// passes read those entries here, and check the sum here before sending
// anything, so a walk is never opened on a reading that could not finish it.
//
// Entry ids are creation-ordered and `startDay` never decreases along them,
// so a day's covering entries end at the first entry starting after it.
//
// Every read here resumes (#3014). A day may be covered by more entries than
// one run can read, so nothing here holds an entry list across runs:
//   - the conservation check is a running sum per day (`DaySums`), stored as a
//     scan cursor and continued from where the last run stopped;
//   - the walks are fed from the chain's own cursors (`readFeed`): each run
//     reads the covering ids past what the walk has already taken, and the
//     walk itself is the record of what was submitted; a mark (`FeedMark`)
//     carries the read past stretches holding no covering entry;
//   - the floor below which every entry has ended (`EntryFloor`) only moves
//     forward, a few pages a run.
// All three read through one run's pages (`EntryPages`), aligned and read at
// most once, so the days of a run share their reads, what a run reads stays
// bounded however busy a day was, and what it read is kept.

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

/** `getRewardEntriesRange(from, n)`. */
export type ReadEntryPage = (from: bigint, n: bigint) => Promise<readonly EntryRow[]>;

/**
 * The entry sequence as one run reads it: in pages aligned on `ENTRY_PAGE`
 * (ids 1..500, 501..1000, ...), each read from the chain at most once a run
 * and at most `left` of them in all. Every read here goes through it, so the
 * days of a run share what any of them read, and the budget bounds the run's
 * RPC reads rather than its days.
 */
export class EntryPages {
  private readonly cache = new Map<bigint, readonly EntryRow[]>();

  constructor(
    private readonly readPage: ReadEntryPage,
    /** Pages the run may still read from the chain. */
    public left: number,
  ) {}

  /** The rows from `from` to the end of its page, and whether the page was
   *  full (a short one ends the allocated sequence); null when the page is not
   *  read yet and the budget is spent. */
  async from(from: bigint): Promise<{ rows: readonly EntryRow[]; full: boolean } | null> {
    const id = from < 1n ? 1n : from;
    const base = ((id - 1n) / ENTRY_PAGE) * ENTRY_PAGE + 1n;
    let page = this.cache.get(base);
    if (page === undefined) {
      if (this.left <= 0) return null;
      this.left -= 1;
      page = await this.readPage(base, ENTRY_PAGE);
      this.cache.set(base, page);
    }
    return { rows: page.slice(Number(id - base)), full: page.length >= Number(ENTRY_PAGE) };
  }
}

/** A zeroed slot is past the end of the allocated sequence. */
function unallocated(e: EntryRow): boolean {
  return e.user === zeroAddress && Number(e.endDay) === 0 && e.perDayNumeraire18 === 0n;
}

function toEntry(e: EntryRow, id: bigint): ScannedEntry {
  return { id, side: Number(e.side), first: Number(e.startDay) === 0 ? 1 : Number(e.startDay), endDay: Number(e.endDay), perDayNumeraire18: e.perDayNumeraire18 };
}

/** What one bounded read of a day's covering entries found. */
export interface CoveringRead {
  /** The entries read that cover the day, ascending. */
  entries: ScannedEntry[];
  /** Where the next read resumes. */
  next: bigint;
  /** Every covering entry from the read's start is in `entries`: the read
   *  reached the first entry starting after the day, or the end of the
   *  sequence. */
  exhausted: boolean;
}

/**
 * The entries covering `day` from id `from` on, a page at a time while the
 * run's pages last (and at most `maxPages`). It stops at the first entry
 * starting after `day`, since none past it can cover the day.
 */
export async function readCovering(pages: EntryPages, day: number, from: bigint, maxPages = Number.POSITIVE_INFINITY): Promise<CoveringRead> {
  const entries: ScannedEntry[] = [];
  let next = from < 1n ? 1n : from;
  for (let n = 0; n < maxPages; n++) {
    // eslint-disable-next-line no-await-in-loop
    const page = await pages.from(next);
    if (page === null) break;
    for (let i = 0; i < page.rows.length; i++) {
      const e = toEntry(page.rows[i], next + BigInt(i));
      if (unallocated(page.rows[i]) || e.first > day) return { entries, next: e.id, exhausted: true };
      if (covers(e, day)) entries.push(e);
    }
    next += BigInt(page.rows.length);
    if (!page.full) return { entries, next, exhausted: true };
  }
  return { entries, next, exhausted: false };
}

/**
 * A stored floor (Codex #2993 r1): every entry below `id` ends on or before
 * `day`, so no day at or after `day` has a covering entry below it, and a read
 * for such a day can start at `id`. It is a reading hint only: every decision
 * is still made on what the entries say.
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

/** Where a read for `day` may start: the floor when it was recorded for that
 *  day or an earlier one, else id 1. */
export function floorFor(floor: EntryFloor | null, day: number): bigint {
  return floor !== null && floor.day <= day && floor.id > 1n ? floor.id : 1n;
}

/**
 * Moves the floor for `oldestDay`, the oldest day a pass may still work, past
 * the entries that ended by it, a page at a time while `maxPages` and the
 * run's pages last. A floor recorded for a later day restarts from id 1. It stops
 * at the first entry still live after `oldestDay` (an entry starting after it
 * is such an entry), so it never moves past one; what it read is kept.
 */
export async function advanceEntryFloor(pages: EntryPages, stored: EntryFloor | null, oldestDay: number, maxPages: number): Promise<EntryFloor> {
  let id = floorFor(stored, oldestDay);
  for (let n = 0; n < maxPages; n++) {
    // eslint-disable-next-line no-await-in-loop
    const page = await pages.from(id);
    if (page === null) break;
    for (let i = 0; i < page.rows.length; i++) {
      if (unallocated(page.rows[i]) || Number(page.rows[i].endDay) > oldestDay) return { id: id + BigInt(i), day: oldestDay };
    }
    id += BigInt(page.rows.length);
    if (!page.full) break;
  }
  return { id, day: oldestDay };
}

/**
 * A day's running conservation sum: the per-day figures of every covering
 * entry below `next`, per side. `complete` once the read has passed the day's
 * last covering entry. A day's coverage does not change once it has elapsed
 * (entries are never added to an elapsed day and an entry's figure is fixed),
 * so the sum is continued across runs rather than read again.
 */
export interface DaySums {
  next: bigint;
  lender: bigint;
  borrower: bigint;
  complete: boolean;
}

/** Sums as a scan cursor stores them. */
export function encodeDaySums(x: DaySums): string {
  return `${x.next}:${x.lender}:${x.borrower}:${x.complete ? 'c' : 'p'}`;
}

/** Stored sums, or null when there are none or they cannot be read. */
export function decodeDaySums(raw: string | undefined): DaySums | null {
  const m = raw === undefined ? null : /^(\d+):(\d+):(\d+):([cp])$/.exec(raw);
  return m === null ? null : { next: BigInt(m[1]), lender: BigInt(m[2]), borrower: BigInt(m[3]), complete: m[4] === 'c' };
}

/**
 * Continues `day`'s sums from where `stored` stopped (or from `start`, a valid
 * floor for the day, when there is none), while the run's pages last. Entries
 * between a stored position and a later floor end before the day, so the read
 * skips to the floor.
 */
export async function continueDaySums(pages: EntryPages, day: number, stored: DaySums | null, start: bigint): Promise<DaySums> {
  if (stored?.complete) return stored;
  const from = stored !== null && stored.next > start ? stored.next : start;
  const read = await readCovering(pages, day, from);
  let lender = stored?.lender ?? 0n;
  let borrower = stored?.borrower ?? 0n;
  for (const e of read.entries) {
    if (e.side === SIDE_LENDER) lender += e.perDayNumeraire18;
    else if (e.side === SIDE_BORROWER) borrower += e.perDayNumeraire18;
  }
  return { next: read.next, lender, borrower, complete: read.exhausted };
}

/**
 * Whether a day's complete sums account for each side's whole folded total.
 * Every walk over a day's covering entries completes a side only when the
 * per-day figures it visited sum to exactly that total, so a walk started on
 * sums that do not would open, page, and never close. Null when both sides
 * balance; otherwise what is off, for the log.
 */
export function daySumsGap(sums: Pick<DaySums, 'lender' | 'borrower'>, totals: { lender: bigint; borrower: bigint }): string | null {
  const gaps: string[] = [];
  if (sums.lender !== totals.lender) gaps.push(`lender entries sum to ${sums.lender} of a ${totals.lender} total`);
  if (sums.borrower !== totals.borrower) gaps.push(`borrower entries sum to ${sums.borrower} of a ${totals.borrower} total`);
  return gaps.length === 0 ? null : gaps.join('; ');
}

/** What a walk is fed next, per side. */
export interface Feed {
  lender: ScannedEntry[];
  borrower: ScannedEntry[];
  /** Where the read stopped: every covering entry below it, past each side's
   *  cursor, is in the lists. */
  next: bigint;
  /** No covering entry is left past `next`. */
  exhausted: boolean;
}

/**
 * Where a walk's feed was read to, against the walk and cursors it was read
 * for. Covering entries are not contiguous (between two of them may lie many
 * entries that ended before the day), so a walk's cursor alone would send each
 * run back to read the same stretch; the mark carries the read past it. It is
 * stored only once everything read before it has landed, and is used only
 * while the walk and its cursors are still the ones it was recorded with, so a
 * cursor that moved, a reset, or another walk all start again from the cursor.
 */
export interface FeedMark {
  /** The walk it was read for (a closure walk's nonce; 0 for an accumulation,
   *  which has one per day). */
  walk: bigint;
  next: bigint;
  lender: bigint;
  borrower: bigint;
}

/** A mark as a scan cursor stores it. */
export function encodeFeedMark(m: FeedMark): string {
  return `${m.walk}:${m.next}:${m.lender}:${m.borrower}`;
}

/** A stored mark, or null when there is none or it cannot be read. */
export function decodeFeedMark(raw: string | undefined): FeedMark | null {
  const m = raw === undefined ? null : /^(\d+):(\d+):(\d+):(\d+)$/.exec(raw);
  return m === null ? null : { walk: BigInt(m[1]), next: BigInt(m[2]), lender: BigInt(m[3]), borrower: BigInt(m[4]) };
}

/** Where a walk's feed reads from: past both cursors and at or above `start`
 *  (a valid floor for the day), and past a mark recorded for this very walk
 *  and these very cursors. */
export function feedFrom(mark: FeedMark | null, walk: bigint, cursors: { lender: bigint; borrower: bigint }, start: bigint): bigint {
  const low = (cursors.lender < cursors.borrower ? cursors.lender : cursors.borrower) + 1n;
  let from = low > start ? low : start;
  if (mark !== null && mark.walk === walk && mark.lender === cursors.lender && mark.borrower === cursors.borrower && mark.next > from) from = mark.next;
  return from;
}

/**
 * The covering entries of `day` from `from` (`feedFrom`), past each side's
 * on-chain walk cursor, ascending, while the run's pages last. The walk's cursor
 * is the record of what it has taken, so a read that runs out of pages loses
 * nothing: the next run reads on from wherever the walk then stands.
 */
export async function readFeed(pages: EntryPages, day: number, cursors: { lender: bigint; borrower: bigint }, from: bigint): Promise<Feed> {
  const read = await readCovering(pages, day, from);
  return {
    lender: read.entries.filter((e) => e.side === SIDE_LENDER && e.id > cursors.lender),
    borrower: read.entries.filter((e) => e.side === SIDE_BORROWER && e.id > cursors.borrower),
    next: read.next,
    exhausted: read.exhausted,
  };
}
