/**
 * Shared numeric-code tables mirroring the contracts' enums.
 * Const objects rather than `enum` — `erasableSyntaxOnly` rejects TS
 * enums but we still want one source of truth for the codes.
 */

export const AssetType = {
  ERC20: 0,
  ERC721: 1,
  ERC1155: 2,
} as const;
export type AssetType = (typeof AssetType)[keyof typeof AssetType];

export const LoanStatus = {
  Active: 0,
  Repaid: 1,
  Defaulted: 2,
  Settled: 3,
  FallbackPending: 4,
  InternalMatched: 5,
} as const;
export type LoanStatus = (typeof LoanStatus)[keyof typeof LoanStatus];

/** On-chain LoanStatus → the indexer-row status string it settles to.
 *  The chain has no separate "liquidated" value (Defaulted covers
 *  both), so the mapped string is the closest row equivalent. Used
 *  wherever a live read reconciles or substitutes for an indexer row
 *  (#988: PositionDetails action gate, on-chain claimables discovery). */
export const LIVE_STATUS_TO_INDEXED = {
  [LoanStatus.Active]: 'active',
  [LoanStatus.Repaid]: 'repaid',
  [LoanStatus.Defaulted]: 'defaulted',
  [LoanStatus.Settled]: 'settled',
  [LoanStatus.FallbackPending]: 'fallback_pending',
  [LoanStatus.InternalMatched]: 'internal_matched',
} as const;

/** The status an indexed row should be READ as, given the live chain
 *  status when one is in hand (OBS-2 #988). Overrides only toward MORE
 *  settled — with ONE deliberate exception: a live Active DOES override a
 *  `fallback_pending` row, because that state is REVERSIBLE (a borrower
 *  cure returns the loan to Active). A live Active never resurrects a row
 *  the indexer already closed (that direction is replica lag). An unknown
 *  future enum value yields no override rather than a lying type.
 *
 *  #2373 r4 — one rule for the page's action gate AND for the claim reads
 *  that feed its payout, so the payout is never composed from a status the
 *  page has already moved past. */
/** #2470 — the live status the page may reconcile with, or `undefined`.
 *
 *  Only a read that is RUNNING and HEALTHY counts. The page reads the live
 *  status only while the indexed row is still open (active or in the
 *  fallback); once the indexer catches up to a terminal status the query
 *  stops, and React Query keeps its last result — a pre-transition snapshot.
 *  Reconciling with that would map an old `Repaid` over an indexed `settled`
 *  and regress the page until a reload.
 *
 *  #2477 r1 — "healthy" is more than `!isError`. React Query keeps the last
 *  data, with `isError` still false, while a query is PAUSED (offline) and
 *  while a failed attempt waits for its retry (`failureCount > 0`). Both are
 *  the same stale snapshot, so both are refused. Same gate as the page's
 *  amount fold (#2461). */
export interface LiveReadState {
  enabled: boolean;
  isError: boolean;
  isPaused: boolean;
  failureCount: number;
}

/** Whether a live read's data describes the chain NOW: the query is
 *  running, and its last attempt neither failed, is retrying, nor is
 *  paused. The ONE predicate for every use of the page's live loan read —
 *  status reconciliation and the amount fold alike — so they cannot again
 *  disagree about when the cache is stale. */
export function isLiveReadUsable(read: LiveReadState): boolean {
  return read.enabled && !read.isError && !read.isPaused && read.failureCount === 0;
}

export function usableLiveStatus(read: LiveReadState & { status: number | undefined }): number | undefined {
  return isLiveReadUsable(read) ? read.status : undefined;
}

export function reconcileIndexedStatus<S extends string>(
  indexed: S,
  live: number | undefined,
): S | (typeof LIVE_STATUS_TO_INDEXED)[LoanStatus] {
  if (live === undefined) return indexed;
  if (live !== LoanStatus.Active) {
    return (
      (LIVE_STATUS_TO_INDEXED as Record<number, (typeof LIVE_STATUS_TO_INDEXED)[LoanStatus] | undefined>)[live] ??
      indexed
    );
  }
  return indexed === 'fallback_pending' ? 'active' : indexed;
}
