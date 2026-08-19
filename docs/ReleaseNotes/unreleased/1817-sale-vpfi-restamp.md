## Selling a VPFI-settled position now refreshes both parties' fee-tier clock (PR #TBD)

The VPFI fee-discount tier is time-weighted: every time VPFI moves through a
user's vault, the platform is supposed to re-record their balance at that
moment, so the average that prices their discount reflects what they actually
held, for as long as they actually held it. Deposits, withdrawals, fee
payments, and claim consolidation all did this. A lender position sale did
not — on either route.

A sale settled in VPFI moves it through both vaults at once: the held-back
VPFI attached to the loan leaves the seller and lands with the buyer, and the
purchase itself debits the buyer and pays the seller. Until now that whole
settlement happened without either party's tier clock being touched. The
seller's departed balance kept earning discount history as if it had never
left; the buyer's new balance went uncounted. Both errors silently corrected
themselves only at each user's next unrelated vault movement, which could be
much later or never — and until then one side was quietly over-priced and the
other under-priced on every fee the tier touches.

Both sale routes — the instant sale into a standing offer and the completion
of a listed sale — now refresh the seller's and the buyer's tier records at
settlement, at their true post-sale balances, the same way every other vault
movement already did.

Part of #1503 (item 27); tracked as #1817.
