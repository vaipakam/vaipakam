// apps/keeper/src/rewardCloseOut/plan.ts
//
// The close-out pass's pure rules: which days a run may try to prove closed,
// how a walk's remaining ids are paged, when a retired custody era may
// be finalized, and when a day's transport cursor has an exhausted epoch to
// pass. No reads and no sends: `index.ts` feeds these with what it read.

export { SIDE_BORROWER, SIDE_LENDER, conservationGap, covers, coveringEntries, type ScannedEntry, type Side } from '../rewardEntries';

/** The newest day a run may try to prove closed: elapsed (before `today`)
 *  and reached by both interest frontiers. Below 0 when no day qualifies. The
 *  days a run reads up to it rotate from the pass's stored closure floor
 *  (`scanCursors.rotatingWindow`). */
export function provableThrough(today: number, lenderFrontier: number, borrowerFrontier: number): number {
  return Math.max(-1, Math.min(today - 1, lenderFrontier, borrowerFrontier));
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
