import type { IndexedActivityEvent } from '@vaipakam/defi-client';

/** Companion / noise events hidden from the Basic activity feed. */
export const HIDDEN_ACTIVITY_KINDS = new Set(['Transfer', 'OfferCanceledDetails']);

const KIND_LABELS: Record<string, string> = {
  OfferCreated: 'Offer created',
  OfferAccepted: 'Offer accepted',
  OfferCanceled: 'Offer canceled',
  OfferConsumedBySale: 'Offer sold',
  LoanInitiated: 'Loan opened',
  LoanRepaid: 'Loan repaid',
  LoanDefaulted: 'Loan defaulted',
  LenderFundsClaimed: 'Lender claimed funds',
  BorrowerFundsClaimed: 'Borrower claimed funds',
  CollateralAdded: 'Collateral added',
  LoanSold: 'Lender position sold',
  LoanObligationTransferred: 'Borrower position transferred',
  LoanExtended: 'Loan extended',
  LoanSettled: 'Loan settled',
  PartialRepaid: 'Partial repayment',
  SwapToRepayExecuted: 'Repaid via swap',
  SwapToRepayPartialExecuted: 'Partial repay via swap',
  BorrowerLifRebateClaimed: 'VPFI rebate claimed',
  VPFIDepositedToVault: 'VPFI deposited',
  VPFIWithdrawnFromVault: 'VPFI withdrawn',
};

const KIND_PRIORITY = [
  'OfferAccepted',
  'LoanInitiated',
  'LoanRepaid',
  'LoanSettled',
  'LoanDefaulted',
  'OfferCreated',
  'OfferCanceled',
  'LenderFundsClaimed',
  'BorrowerFundsClaimed',
  'PartialRepaid',
  'CollateralAdded',
  'OfferConsumedBySale',
];

export function activityKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function pickPrimaryActivityKind(kinds: string[]): string {
  for (const k of KIND_PRIORITY) {
    if (kinds.includes(k)) return k;
  }
  return kinds[0] ?? 'Unknown';
}

export function activityEventRefs(event: IndexedActivityEvent): string | null {
  const parts: string[] = [];
  if (event.loanId != null) parts.push(`Loan #${event.loanId}`);
  if (event.offerId != null) parts.push(`Offer #${event.offerId}`);
  return parts.length ? parts.join(' · ') : null;
}

export function filterVisibleActivity(events: IndexedActivityEvent[]): IndexedActivityEvent[] {
  return events.filter((e) => !HIDDEN_ACTIVITY_KINDS.has(e.kind));
}

export function groupActivityByTx(events: IndexedActivityEvent[]) {
  const byTx = new Map<string, IndexedActivityEvent[]>();
  for (const ev of events) {
    const bucket = byTx.get(ev.txHash) ?? [];
    bucket.push(ev);
    byTx.set(ev.txHash, bucket);
  }

  const groups = [...byTx.entries()].map(([txHash, evs]) => {
    evs.sort((a, b) => a.logIndex - b.logIndex);
    const kinds = evs.map((e) => e.kind);
    return {
      txHash,
      blockNumber: evs[0]!.blockNumber,
      blockAt: evs[0]!.blockAt,
      primaryKind: pickPrimaryActivityKind(kinds),
      events: evs,
      loanId: evs.find((e) => e.loanId != null)?.loanId ?? null,
      offerId: evs.find((e) => e.offerId != null)?.offerId ?? null,
    };
  });

  groups.sort((a, b) => b.blockNumber - a.blockNumber || b.events[0]!.logIndex - a.events[0]!.logIndex);
  return groups;
}