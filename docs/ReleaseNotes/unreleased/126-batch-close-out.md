## Thread — Repay all and Close all early on loans from one offer (PR #3060)

When one of a borrower's offers filled into two or more loans that are
still open, the Positions page now shows a card for that offer with
"Repay all" and, in Advanced mode, "Close all early". The borrower
approves the total once and then signs one transaction for up to 30
loans, instead of one approval and one transaction per loan.

The checks the loan page runs before a repayment or early close (live
status, position still held, grace on the live term, accepted sale,
refinance request, offset offer, sanctions) now live in one per-loan
plan that the loan page and the batch both use, so the two cannot
drift. Two small page changes come with that move: the allowance pad is
worked out from the loan's live principal and rate, and early close
checks the offset lock live before signing.

A loan with anything the borrower should see first (a sale waiting to
complete, a refinance request, an offset offer, a loan in its fallback
period, a rental) is left out of the batch and named, with a pointer to
its own page. The batch goes through the Diamond's existing multicall
with each loan allowed to fail on its own, so one loan that fails never
undoes the others. Afterwards every loan is read back from the chain at
the block the transaction mined in: repaid, still open with the reason,
changed another way, or unreadable. If nothing closed, the approval is
set back; if something did, the approval left standing is read and
stated.

Advances #126 (slice 1 of 3; the lender's "List all for sale" and the
borrower's "Refinance all" follow). Design:
`docs/DesignsAndPlans/OfferGroupBatchActionsDesign.md`.

> Caveat: the owner's recorded decision on #126 names an EIP-5792 wallet batch; this slice uses the Diamond multicall instead and the choice is with the owner. Only the sender changes if EIP-5792 is kept.
> Caveat: no Anvil end-to-end spec yet; it needs a seed that fills one offer into two loans.
