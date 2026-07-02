/**
 * #183 canonical role-aware offer-headline reader (F-20260630-001).
 *
 * The on-chain offer fields `amount` / `interestRateBps` are role-overloaded,
 * so reading them raw shows the wrong number on one side of the book:
 *   - lender ERC-20 offer  → headline principal is `amountMax` (what
 *     direct-accept locks); `amount` is the `minPartialFillAmount` (~10% of
 *     max), and the locked rate is `interestRateBps` (the lender's floor).
 *   - borrower ERC-20 offer → headline principal is `amount` (min-need floor)
 *     and the locked rate is `interestRateBpsMax` (the borrower's ceiling).
 *   - NFT rental offer      → `amount` is a daily fee and `interestRateBps`
 *     applies for both roles.
 *
 * Mirrors `useAcceptTermsSigning`'s `roleAmount` / `roleRate` endpoints and the
 * OfferBook table's `displayAmount` / `displayRate`, so every principal/rate
 * surface (table row, offer detail, accept review) agrees with what acceptance
 * actually executes. Signing-safety critical: the accept modal is the last
 * review before the user locks the loan.
 *
 * Extracted to this pure module (no React / wagmi imports) so it can be
 * unit-tested directly. `OfferData` in `pages/OfferBook` is structurally a
 * superset of {@link OfferHeadlineInput}, so callers pass it as-is.
 */
export interface OfferHeadlineInput {
  /** 0 = ERC-20 principal; non-zero = NFT rental (`amount` is a daily fee). */
  assetType: number;
  /** 0 = lender offer; 1 = borrower offer. */
  offerType: number;
  amount: bigint;
  amountMax: bigint;
  interestRateBps: bigint;
  interestRateBpsMax: bigint;
}

export function offerHeadline(offer: OfferHeadlineInput): {
  principal: bigint;
  rateBps: bigint;
} {
  const isERC20 = offer.assetType === 0;
  const isLender = offer.offerType === 0;
  return {
    principal: isERC20 && isLender ? offer.amountMax : offer.amount,
    rateBps: isERC20
      ? isLender
        ? offer.interestRateBps
        : offer.interestRateBpsMax
      : offer.interestRateBps,
  };
}
