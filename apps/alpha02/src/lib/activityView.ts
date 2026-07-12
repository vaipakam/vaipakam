/**
 * UX-008 — turn the raw indexer event stream into a readable activity
 * feed. The old page leaked camelCase event names ("Nftminted"),
 * exploded each transaction into 3–6 near-duplicate rows, and carried
 * no plain-language description. This module is the pure core:
 *
 *   - ACTIVITY_LABELS maps every known contract event kind to a
 *     plain-language line and a coalescing priority;
 *   - humanizeKind is the fallback for an unmapped kind, handling
 *     ALL-CAPS acronyms (NFT/LTV/VPFI) the naive regex mangled;
 *   - coalesceByTx collapses one on-chain transaction's many events
 *     into ONE representative row (the highest-priority event), with a
 *     count of how many sub-events it hid.
 *
 * Kept framework-free and pure so it is unit-tested directly (the live
 * feed's honesty rules — truncation, participant filter — stay in the
 * page).
 */
import type { IndexedActivityEvent } from '../data/indexer';

export type ActivityCategory =
  | 'offer'
  | 'loan-open'
  | 'loan-repay'
  | 'loan-close'
  | 'loan-default'
  | 'loan-modify'
  | 'collateral'
  | 'other';

interface ActivityLabel {
  /** Plain-language line, e.g. "Offer created". */
  label: string;
  category: ActivityCategory;
  /** Higher wins when several events share one transaction — the
   *  user-meaningful outcome should represent the row, not a
   *  book-keeping sub-event (Transfer, *Details). */
  priority: number;
}

/**
 * Known contract event kinds → readable label. Sourced from the
 * indexer's `log.eventName` handlers (apps/indexer/src/chainIndexer.ts).
 * A `*Details` companion event or a raw `Transfer` deliberately gets a
 * LOW priority so it never represents a transaction that also emitted
 * the real action.
 */
export const ACTIVITY_LABELS: Record<string, ActivityLabel> = {
  // Offers
  OfferCreated: { label: 'Offer created', category: 'offer', priority: 50 },
  OfferAccepted: { label: 'Offer accepted', category: 'loan-open', priority: 80 },
  OfferCanceled: { label: 'Offer cancelled', category: 'offer', priority: 60 },
  OfferClosed: { label: 'Offer closed', category: 'offer', priority: 40 },
  OfferModified: { label: 'Offer amended', category: 'offer', priority: 55 },
  OfferMatched: { label: 'Offers matched', category: 'loan-open', priority: 80 },
  OfferConsumedBySale: { label: 'Offer used for a sale', category: 'offer', priority: 45 },
  // Loan lifecycle
  LoanInitiated: { label: 'Loan started', category: 'loan-open', priority: 90 },
  LoanInitiatedDetails: { label: 'Loan started', category: 'loan-open', priority: 10 },
  LoanRepaid: { label: 'Loan repaid', category: 'loan-repay', priority: 90 },
  PartialRepaid: { label: 'Partial repayment', category: 'loan-repay', priority: 70 },
  LoanSettled: { label: 'Loan settled', category: 'loan-close', priority: 85 },
  LoanDefaulted: { label: 'Loan defaulted', category: 'loan-default', priority: 90 },
  LoanLiquidated: { label: 'Loan liquidated', category: 'loan-default', priority: 90 },
  BackstopAbsorbedLoan: { label: 'Loan absorbed by backstop', category: 'loan-default', priority: 88 },
  LoanExtended: { label: 'Loan extended', category: 'loan-modify', priority: 75 },
  LoanRefinanced: { label: 'Loan refinanced', category: 'loan-modify', priority: 85 },
  LoanPreclosedDirect: { label: 'Loan closed early', category: 'loan-close', priority: 85 },
  OffsetCompleted: { label: 'Loan offset', category: 'loan-close', priority: 80 },
  OffsetOfferCreated: { label: 'Offset offer created', category: 'offer', priority: 50 },
  LoanSold: { label: 'Loan sold', category: 'loan-modify', priority: 80 },
  LoanSaleCompleted: { label: 'Loan sale completed', category: 'loan-modify', priority: 82 },
  LoanSaleOfferLinked: { label: 'Loan listed for sale', category: 'loan-modify', priority: 60 },
  LoanObligationTransferred: { label: 'Loan position transferred', category: 'loan-modify', priority: 70 },
  CollateralAdded: { label: 'Collateral added', category: 'collateral', priority: 75 },
  InternalMatchExecuted: { label: 'Loan matched internally', category: 'loan-open', priority: 82 },
  // Prepay collateral-sale listings (the borrower's parallel-sale exit).
  PrepayListingPosted: { label: 'Collateral listed for sale', category: 'loan-modify', priority: 55 },
  PrepayListingMatched: { label: 'Collateral sale matched', category: 'loan-modify', priority: 78 },
  PrepayListingUpdated: { label: 'Collateral listing updated', category: 'loan-modify', priority: 50 },
  PrepayListingCanceled: { label: 'Collateral listing cancelled', category: 'loan-modify', priority: 45 },
  PrepayCollateralSaleSettled: { label: 'Collateral sale settled', category: 'loan-close', priority: 80 },
  // Swap-to-repay
  SwapToRepayExecuted: { label: 'Repaid via collateral swap', category: 'loan-repay', priority: 88 },
  SwapToRepayPartialExecuted: { label: 'Partial repay via swap', category: 'loan-repay', priority: 70 },
  SwapToRepayIntentCommitted: { label: 'Swap-to-repay set up', category: 'loan-repay', priority: 40 },
  SwapToRepayIntentFilled: { label: 'Swap-to-repay filled', category: 'loan-repay', priority: 78 },
  SwapToRepayIntentCancelled: { label: 'Swap-to-repay cancelled', category: 'loan-repay', priority: 40 },
  SwapToRepayIntentForceCancelled: { label: 'Swap-to-repay cancelled', category: 'loan-repay', priority: 40 },
  // Periodic interest
  PeriodicInterestSettled: { label: 'Interest settled', category: 'loan-repay', priority: 50 },
  PeriodicInterestAutoLiquidated: { label: 'Auto-liquidated for interest', category: 'loan-default', priority: 85 },
  RepayPartialPeriodAdvanced: { label: 'Interest period advanced', category: 'loan-repay', priority: 45 },
  // Signed offers
  SignedOfferFilled: { label: 'Signed offer filled', category: 'loan-open', priority: 80 },
  SignedOfferMatched: { label: 'Signed offers matched', category: 'loan-open', priority: 80 },
  SignedOfferCancelled: { label: 'Signed offer cancelled', category: 'offer', priority: 55 },
  SignedOfferNonceBurned: { label: 'Signed offer voided', category: 'offer', priority: 30 },
  // Low-priority book-keeping — never represents a transaction alone.
  Transfer: { label: 'Transfer', category: 'other', priority: 5 },
  Approval: { label: 'Approval', category: 'other', priority: 5 },
};

/**
 * Fallback humanizer for a kind absent from ACTIVITY_LABELS — splits
 * camelCase AND keeps ALL-CAPS acronyms (NFT, LTV, VPFI) intact, which
 * the old `([a-z])([A-Z])` + `toLowerCase()` mangled to "Nftminted".
 */
export function humanizeKind(kind: string): string {
  if (!kind) return 'Protocol event';
  const withSpaces = kind
    // boundary between a lowerc/digit and an uppercase: fooBar → foo Bar
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // boundary between an acronym run and a following Word: NFTMinted → NFT Minted
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
  // Capitalize the first word; leave the rest as-is so acronyms stay
  // upper ("NFT Minted", not "Nft minted").
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}

/** The readable label for an event kind (mapped or humanized). */
export function labelForKind(kind: string): string {
  return ACTIVITY_LABELS[kind]?.label ?? humanizeKind(kind);
}

/** One coalesced feed row — a single transaction's representative
 *  event plus how many sub-events it stood in for. */
export interface ActivityRowView {
  /** Stable key (representative event's tx + logIndex). */
  key: string;
  event: IndexedActivityEvent;
  label: string;
  category: ActivityCategory;
  /** Extra events in the same transaction that this row subsumes. */
  hiddenCount: number;
}

const DEFAULT_PRIORITY = 20;

function priorityOf(kind: string): number {
  return ACTIVITY_LABELS[kind]?.priority ?? DEFAULT_PRIORITY;
}

/**
 * Collapse events sharing one transaction into a single representative
 * row. Input order is preserved for the OUTPUT (rows sorted by the
 * representative event, newest first) and the representative is the
 * highest-priority event in the group (ties broken by lowest logIndex —
 * the earliest emitted). Events with no txHash each stand alone.
 */
export function coalesceByTx(events: IndexedActivityEvent[]): ActivityRowView[] {
  const groups = new Map<string, IndexedActivityEvent[]>();
  for (const ev of events) {
    // Fall back to a per-event key when txHash is missing so such
    // events are never merged together.
    const key = ev.txHash ? ev.txHash : `${ev.blockNumber}:${ev.logIndex}:${ev.kind}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(ev);
    else groups.set(key, [ev]);
  }

  const rows: ActivityRowView[] = [];
  for (const bucket of groups.values()) {
    let rep = bucket[0];
    for (const ev of bucket) {
      const better =
        priorityOf(ev.kind) > priorityOf(rep.kind) ||
        (priorityOf(ev.kind) === priorityOf(rep.kind) && ev.logIndex < rep.logIndex);
      if (better) rep = ev;
    }
    rows.push({
      key: `${rep.txHash || rep.blockNumber}-${rep.logIndex}`,
      event: rep,
      label: labelForKind(rep.kind),
      category: ACTIVITY_LABELS[rep.kind]?.category ?? 'other',
      hiddenCount: bucket.length - 1,
    });
  }

  // Newest first: higher block, then higher logIndex.
  rows.sort(
    (a, b) =>
      b.event.blockNumber - a.event.blockNumber ||
      b.event.logIndex - a.event.logIndex,
  );
  return rows;
}
