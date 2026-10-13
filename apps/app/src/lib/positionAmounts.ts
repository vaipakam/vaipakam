/**
 * #2453 / #2454 — the two figures a position headline and its "Locked" row
 * state, kept apart from the live amounts they are easily confused with.
 *
 * A loan row carries two principals. `principal` is the LIVE outstanding
 * amount: a partial repayment, a partial swap-to-repay and internal matching
 * all reduce it, and a full internal match takes it to zero. `initPrincipal`
 * is what the loan was initiated with — the indexer stamps it once, from the
 * loan's `LoanInitiated`, and never rewrites it. What a position STARTED
 * with describes the second; what is owed describes the first. Reading the
 * live one for the headline is how an internally matched loan came to say
 * "You lent 0".
 *
 * Pure, so both rules are tested rather than read.
 */
import type { IndexedLoan, IndexedLoanStatus } from '../data/indexer';

/** The principal the loan was initiated with, or `null` when this row does
 *  not carry it — a row read straight from the chain (the indexer had not
 *  seen the loan yet: the live struct keeps only the outstanding amount), or
 *  one served by a worker that predates the field. Never falls back to the
 *  live `principal`: that is a different figure, and showing it as the
 *  amount lent is the defect this exists to prevent. */
export function initiatedPrincipal(loan: Pick<IndexedLoan, 'initPrincipal'>): bigint | null {
  const raw = loan.initPrincipal;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

/** Carry each loan's indexed `initPrincipal` onto the chain-read rows.
 *
 *  When the wallet's RPC answers, the live enumeration is the SOLE row
 *  source for the positions lists (ghosts must not survive — see
 *  `useMyLoansFull`), but the live struct holds only the outstanding
 *  principal. The initiated amount is a fact about the loan, not about who
 *  holds it now, so it is taken from the indexed row with the same loan id
 *  whatever role that row was fetched under. A loan the indexer has not seen
 *  keeps `null` — never the live principal. */
export function withIndexedInitPrincipal<T extends Pick<IndexedLoan, 'loanId' | 'initPrincipal'>>(
  liveRows: readonly T[],
  indexedRows: readonly Pick<IndexedLoan, 'loanId' | 'initPrincipal'>[] | null,
): T[] {
  if (!indexedRows || indexedRows.length === 0) return [...liveRows];
  const byId = new Map<number, string>();
  for (const r of indexedRows) {
    if (typeof r.initPrincipal === 'string') byId.set(r.loanId, r.initPrincipal);
  }
  return liveRows.map((r) => {
    const recorded = byId.get(r.loanId);
    return recorded === undefined ? r : { ...r, initPrincipal: recorded };
  });
}

/** The labels {@link lockedCollateralLine} chooses from. */
export interface LockedLineLabels {
  /** "{{collateral}} collateral (borrower's)" — collateral is still held. */
  lockedCollateralBorrower: (collateral: string) => string;
  /** No collateral held on a loan that is still open. */
  noCollateral: string;
  /** Nothing held because the loan has closed. */
  nothingLockedClosed: string;
  /** Nothing held because internal matching used the collateral. */
  nothingLockedInternalMatch: string;
}

/** The "Locked" row of an ERC-20 loan: what collateral is held NOW.
 *
 *  `collateralAmount` is a live figure too — internal matching pays the
 *  borrower's collateral to the matched loan's lender and leaves only any
 *  surplus, and a close-out releases it. So an empty amount on a closed loan
 *  means "nothing is held any more", not "this loan had no collateral", and
 *  it is never substituted into the held-collateral sentence (which is how
 *  "No collateral collateral (borrower's)" was produced). */
export function lockedCollateralLine(args: {
  hasCollateral: boolean;
  status: IndexedLoanStatus;
  /** The formatted held amount; used only when `hasCollateral`. */
  collateral: string;
  labels: LockedLineLabels;
}): string {
  const { hasCollateral, status, collateral, labels } = args;
  if (hasCollateral) return labels.lockedCollateralBorrower(collateral);
  if (status === 'internal_matched') return labels.nothingLockedInternalMatch;
  if (status === 'active' || status === 'fallback_pending') return labels.noCollateral;
  return labels.nothingLockedClosed;
}
