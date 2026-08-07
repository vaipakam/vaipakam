## Thread — the two borrower settlement paths nobody was driving (PR #1589)

A coverage audit of the borrower's early-exit surfaces, run after the
#1529 merge, found that two of the six options the app offers had no
automated drive behind them from the app's own side. The contract rules
for both are well unit-pinned in Solidity — partial repayment alone has
around ten cases covering the floor, the full-principal rejection and
the boundary a wei below it — so the gap was never "is the rule right".
It was that no test drove the borrower's actual surface: partial
repayment had no fork spec, nothing in the frontend unit tier, and no
row in the coverage matrix recording the absence, while refinance had a
spec asserting only that its form RENDERS inside the grace window,
which passes just as happily against a flow whose submit reverts. Both
are shipped, reachable, fund-moving paths, so this closes the gap
rather than recording it.

Each new spec drives the real UI on an Anvil fork and takes its verdict
from the chain rather than from a success banner. The partial-repay
drive asserts the pair that actually distinguishes the behaviour — the
principal falls by exactly the amount typed AND the loan stays Active —
because either alone is satisfied by the wrong thing: a full repay also
reduces what is owed, and a no-op also leaves the loan open. Its chosen
amount is bounded against the contract's own live minimum-partial floor
and its full-retirement ceiling, so a risk-parameter change on the
forked chain fails inside the spec naming the cause instead of arriving
as an opaque revert behind a wallet confirmation.

The refinance drive posts the request through the borrower's form, has
a second lender accept it, and checks that the old loan closes as
Repaid while the replacement opens under the same borrower at the same
principal. Two of its assertions exist because mutation testing
contradicted the reasoning behind the first draft. The form's "posted"
confirmation turned out to be transient — the page-owned pending card
takes the story over immediately — so the spec now asserts the standing
surface, and cross-checks the request id it names against the chain's
own record of which loan the request targets. More substantially, the
draft claimed that comparing the new loan's collateral asset and amount
proved the collateral had carried over. It does not: the documented
failure mode, where the offer's creator does not match the borrower
stored at loan initiation, produces a fresh pledge of the same asset in
the same amount pulled from the poster's wallet, and sails through both
comparisons.

Balance invariance alone does not settle it either, which review caught
in a later round. The contract keeps a legacy branch that returns the
old collateral at acceptance, so a re-pledge nets to zero across any
window and looks identical from the outside. The spec therefore pins
both halves: the persisted carry-over flag, read off the chain request,
establishes which path was taken, and the borrower's collateral balance
— sampled before the request is posted and compared after completion —
establishes that nothing was pulled along the way. The balance half was
verified to catch a one-wei perturbation; the flag half guards a path
that is not reachable through this surface today, so it is a regression
guard rather than a mutation-isolated assertion, and it is described
that way rather than claimed as more. The rate ceiling and loan length
typed into the form are also read back, off both the request and the
replacement loan, so a form that quietly stopped persisting either
would fail here rather than posting a valid request on stale terms.

Supporting change: the shared direct-accept helper became side-aware.
It previously bound only the lender-offer endpoints, so a lender
funding a borrow request — which the refinance spec needs — was not
expressible. Rather than add a near-duplicate, the helper now derives
which leg the acceptor escrows and which endpoint of the creator's
range binds, mirroring the contract's own rule. The existing consumer's
suite was re-run unchanged to confirm no regression.

Closes #1587
Closes #1588
