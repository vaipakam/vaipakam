## Selling a VPFI-settled position now refreshes both parties' fee-tier clock (PR #TBD)

The VPFI fee-discount tier is time-weighted: every time VPFI moves through a
user's vault, the platform is supposed to re-record their balance at that
moment, so the average that prices their discount reflects what they actually
held, for as long as they actually held it. The flows the tier system already
wires up — the VPFI vault page's own deposits and withdrawals, fee payments,
claim consolidation — do this. A lender position sale did not, on either
route. (A handful of other vault paths, such as the funds an offer escrows at
creation and returns at cancellation, also lack the refresh today; those are
recorded and tracked separately rather than silently widened into this
change.)

A sale settled in VPFI moves vaulted VPFI on both sides at once: the held-back
VPFI attached to the loan leaves the seller's vault and lands in the buyer's,
and the purchase debits the buyer's vaulted escrow. (The sale price itself is
paid to the seller's wallet, outside the vault.) Until now that settlement
happened without either party's tier clock being touched. The seller's
departed held balance kept earning discount history as if it had never left;
the buyer's new balance went uncounted. Both errors silently corrected
themselves only at each user's next unrelated vault movement, which could be
much later or never — and until then one side was quietly over-priced and the
other under-priced on every fee the tier touches.

Both sale routes now refresh each party's tier record at the vault movements
the sale itself performs. On the instant sale that is every movement: the
buyer's principal debit (and any refund of an oversized offer), and the held
VPFI leaving the seller and landing with the buyer. On the completion of a
listed sale it is the movements completion actually makes — the held
migration and any rate-difference deposit; a completion that moves nothing
(the legacy recovery path) touches no one's record, and the buyer's
purchase-price debit, which happened earlier when they accepted the listing,
remains among the untracked paths recorded in the audit and deferred to
#1820.

Part of #1503 (item 27); tracked as #1817.
