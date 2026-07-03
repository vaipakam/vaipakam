## Lender position-sale listing now works on-chain (#951)

The lender's "list my loan position at my own rate" flow (`createLoanSaleOffer`, the Option-2 early-withdrawal path) could not complete on a real chain — every attempt reverted at the wallet step. Two independent blockers, both now fixed:

1. **Reentrancy collision.** Listing a position creates an internal offer to represent the sale, but that create re-entered the same reentrancy guard the listing call already held, so it reverted every time. The listing now routes through the internal offer-create entry point (the same pattern the preclose-offset flow already uses), which doesn't re-take the guard — and it passes the exiting lender through as the offer's real creator, so proceeds and cancel rights bind to the seller (not to a keeper that may have submitted the listing on their behalf).

2. **Zero-collateral validation.** The sale is represented as a borrow-style offer with no collateral posted (the real collateral stays on the live loan being sold, not re-posted). The borrower-offer ceiling check — which caps how much can be borrowed against posted collateral — treated the zero collateral as "zero borrowing allowed" and rejected the listing. Protocol-authored sale vehicles are now exempt from that ceiling, mirroring the exemption they already had from the risk-access gate.

These bugs were invisible to the test suite because every passing test stubbed the internal offer-create hop, so the real cross-facet path never ran. The fix adds an **unmocked** regression test that posts the sale offer for real (with the ceiling branch active) and confirms it lands as a genuine borrower-type offer owned by the exiting lender.

**User impact:** the position-sale *listing* UI was feature-gated off pending this fix (the instant-exit sell-to-a-buy-offer path was unaffected and stayed available). Re-enabling the listing surface is tracked separately (#927).

Closes #951.
