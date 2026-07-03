## Lender position-sale listing now works on-chain (#951)

The lender's "list my loan position at my own rate" flow (`createLoanSaleOffer`, the Option-2 early-withdrawal path) could not complete on a real chain — every attempt reverted at the wallet step. Two independent blockers, both now fixed:

1. **Reentrancy collision.** Listing a position creates an internal offer to represent the sale, but that create re-entered the same reentrancy guard the listing call already held, so it reverted every time. The listing now routes through the internal offer-create entry point (the same pattern the preclose-offset flow already uses), which doesn't re-take the guard — and it passes the exiting lender through as the offer's real creator, so proceeds and cancel rights bind to the seller (not to a keeper that may have submitted the listing on their behalf).

2. **Zero-collateral validation.** The sale is represented as a borrow-style offer with no collateral posted (the real collateral stays on the live loan being sold, not re-posted). The borrower-offer ceiling check — which caps how much can be borrowed against posted collateral — treated the zero collateral as "zero borrowing allowed" and rejected the listing. Protocol-authored sale vehicles are now exempt from that ceiling, mirroring the exemption they already had from the risk-access gate.

These bugs were invisible to the test suite because every passing test stubbed the internal offer-create hop, so the real cross-facet path never ran. The fix adds an **unmocked** regression test that posts the sale offer for real (with the ceiling branch active) and confirms it lands as a genuine borrower-type offer owned by the exiting lender.

Making the listing actually post revealed that the rest of the flow — accept, complete, cancel, and offer-mutation — had never run end-to-end either, so the whole lifecycle was redesigned coherently (see `docs/DesignsAndPlans/LenderSaleVehicleRedesign.md`):

- **Accept auto-completes without re-entering the guard.** Accepting a sale offer completes it in the same transaction, and that completion re-entered the reentrancy guard the acceptance already held — so every sale *acceptance* would have reverted. Completion now runs through an internal, guard-free entry (the same pattern the offset flow uses).
- **One consistent identity for the whole sale.** The exiting lender's position is now *consolidated to its current holder at listing time* — re-anchoring both the stored lender-of-record and any held-for-lender balance to whoever actually owns the position NFT (the seller). This is the same "consolidate before a terminal action" step every other close-out path already performs. With it, the party who lists, the party the buyer pays, the party settlement is charged against, and the vault physically holding the proceeds are all the same address, so a position transferred on the secondary market before listing can no longer split those apart. (A position carrying unresolved held VPFI can't be unified this way and is refused at listing until that's cleared.)
- **A listed sale is frozen.** Once listed, the sale offer is immutable (the seller can't change its amount, rate, or collateral out from under a pending buyer) and can only be taken through the direct accept path, not the range/partial matcher (a position sale is all-or-nothing).

**Phase 1 scope:** lender position-sale is supported for loans with **ERC-20 collateral**. A loan whose collateral is an NFT is rejected at listing for now, because the sale vehicle holds no collateral of its own (it stays on the live loan) and the accept / complete / cancel paths would otherwise try to move an NFT that was never escrowed. NFT-collateral lender-sale is a tracked follow-up (#974).

**User impact:** the position-sale *listing* UI was feature-gated off pending this fix (the instant-exit sell-to-a-buy-offer path was unaffected and stayed available). Re-enabling the listing surface is tracked separately (#927).

Closes #951.
