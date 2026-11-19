/**
 * #3661 — what can go wrong, said plainly. The short key-risk list is shown
 * with the Terms before a first acceptance and on the always-reachable risk
 * page; every review that opens a loan or a rental carries the ONE line
 * that applies to its side and to how that loan settles (`loanRiskKey`,
 * `rentalRiskKey`). The lines are stated facts about the protocol's
 * settlement, never a promise: a lender's collateral is sold to repay them
 * only where both legs are liquid, and an illiquid leg settles in kind.
 */
import type { CopyKey } from '../copy/useCopy';
import type { AssetClass } from '../offers/assets';

/** The address of the risk page, linked from the footer and every review. */
export const RISKS_PATH = '/risks';

/** The short list, in the order the Terms prompt and the page show it. */
export const KEY_RISKS: readonly CopyKey[] = ['keyRisks.lose', 'keyRisks.lend', 'keyRisks.borrow', 'keyRisks.software', 'keyRisks.wallet', 'keyRisks.advice'];

/** What the risk page adds below the short list. */
export const MORE_RISKS: readonly CopyKey[] = ['keyRisks.peg', 'keyRisks.feed', 'keyRisks.lentFunds', 'keyRisks.tax', 'keyRisks.thirdParty'];

/** How a loan that goes wrong is settled: by a sale of the collateral
 *  (both legs liquid), in kind (either leg illiquid: the protocol values it
 *  at zero and never sells it), or not known when the review is signed:
 *  a posted offer or request, or a signed order, fills later, and the
 *  protocol classes both legs again then and keeps that on the loan. */
export type Settlement = 'sale' | 'in-kind' | 'unknown';

/** The settlement the two legs' classes give. A distrusted leg never
 *  reaches a review (the review blocks it), so it reads as unknown here. */
export function settlementOf(lending: AssetClass, collateral: AssetClass): Settlement {
  if (lending === 'illiquid' || collateral === 'illiquid') return 'in-kind';
  if (lending === 'distrusted' || collateral === 'distrusted') return 'unknown';
  return 'sale';
}

/** The review's "if things go wrong" line for a loan, by side and settlement. */
export function loanRiskKey(side: 'lender' | 'borrower', settlement: Settlement): CopyKey {
  if (side === 'lender') return settlement === 'sale' ? 'keyRisks.lenderSale' : settlement === 'in-kind' ? 'keyRisks.lenderInKind' : 'keyRisks.lenderUnknown';
  return settlement === 'sale' ? 'keyRisks.borrowerSale' : settlement === 'in-kind' ? 'keyRisks.borrowerInKind' : 'keyRisks.borrowerUnknown';
}

/** The review's line for an NFT rental, by side. */
export function rentalRiskKey(side: 'owner' | 'renter'): CopyKey {
  return side === 'owner' ? 'keyRisks.owner' : 'keyRisks.renter';
}
