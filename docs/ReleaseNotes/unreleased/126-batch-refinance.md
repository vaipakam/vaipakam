## Thread — Refinance all on loans from one offer (PR #3067)

A borrower whose offer filled into two or more open loans can now post a
refinance request for all of them at once from the Positions page. In
Advanced mode, the borrower's card for that offer has "Refinance all" next
to "Repay all" and "Close all early". The borrower picks one highest rate
and one duration, reviews every loan, approves once, and signs one
transaction for up to 15 requests instead of up to three wallet steps per
loan.

The checks the loan page's refinance form runs before a request is posted
(sanctions, the borrower position still held by its original borrower, both
assets unpaused, the loan active and within its grace window, the fee terms
reviewed, no request already on record) now live in one per-loan plan that
the form and the batch both use, so the two cannot drift.

The review shows, for each loan, today's payoff, how much more it can grow
after the due date, the spare balance an acceptance needs, and what the
loan's own page says before a request. It states the total spare balance,
which the wallet must hold now, and the one approval for the sum of the
largest payoffs, and says that this approval also serves any other open
refinance request on the same token. Where a loan's guardrails need
writing, the write goes in the same transaction right before its request,
so a request is never posted without them. Every loan is checked again in
full right before its transaction is sent, and one whose largest payoff
or spare amount grew is left out, so no request is posted needing more
than the balance that was checked.

Which loans got a request is taken from the transaction's own record: a
request posted (with its offer number, which the loan's page then shows and
can cancel), no request with the reason, no longer active, not confirmed
yet, or unreadable. The approval is set back only when it is certain that no
request was posted.

Advances #126 (slice 3 of 3).
Design: `docs/DesignsAndPlans/OfferGroupBatchActionsDesign.md`.

> Caveat: no Anvil end-to-end spec yet; it needs a seed that fills one borrower offer into two loans.
