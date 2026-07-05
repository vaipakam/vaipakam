# Release Notes — 2026-07-05

The secondary market completes: alpha02 gains the BUY side of the
lender position-sale flow (#991), reviewed across four Codex rounds and
verified end-to-end through the app on Base Sepolia. Alongside it, the
consolidated deployments bundle was synced with the day-before's
post-#989 catch-up re-cut on all three testnets and the hardened
Base Sepolia faucet mocks (#990), so every consumer reads the facet
addresses and mock assets actually live on-chain.

## Thread — alpha02 loan-sale BUY flow (#986 Part 3 surface)

The last blocked corner of the secondary market opens: alpha02 can now
BUY a listed lender position. Previously an offer tied to a running
loan was flat-out unacceptable in the app (the #951 honesty block) —
the fresh-loan review would have misdescribed the deal. The accept
review now recognises a position sale and replaces the block with a
real buy-a-running-loan review.

Everything the buyer sees comes from the linked loan read live, never
from the listing's stored row (which carries zero collateral and a
term that already partly elapsed): the price is the loan's current
outstanding principal, the earnings projection covers only the
remaining slice of the term at the listing's rate (the same figure the
protocol settles against), the collateral shown is what the borrower
actually has locked, and the end date is the running loan's real due
date. A banner introduces the deal plainly: you are buying the lender
side of a named, already-running loan — the borrower and their
obligations do not change.

The purchase is signable only when every gate is positively clear.
Beyond the loan being active and unmatured, the review preflights the
SELLER's settlement funding: completing a sale pulls the seller's
accrued-interest forfeit from the seller's wallet, and a seller who
revoked or spent their standing approval after listing would make the
buy fail on-chain with an opaque error. The review blocks that case
with a plain reason instead of letting a doomed transaction be signed.
What the buyer signs is bound to the same live loan numbers the review
showed (principal, original term, live collateral floor) — the
protocol enforces exactly this binding, so any movement between review
and signing aborts before the wallet prompt. Offset-linked offers (and
linked offers whose kind can't be positively identified) keep the
previous block.

Verified end-to-end on Base Sepolia before the UI landed: a listed
position (sale offer #21 on loan #11) was bought by a second test
wallet through the same contract path the flow drives — lender
handoff, principal payout to the seller, and the accrued forfeit all
confirmed on-chain.
