## Thread — the two borrower settlement paths nobody was driving (PR #1589)

A coverage audit of the borrower's early-exit surfaces, run after the
#1529 merge, found that two of the six options the app offers had no
automated drive behind them. Partial repayment had none at any tier —
no fork spec, no unit test, and no row in the coverage matrix recording
the absence. Refinance had a spec that asserted only that its form
RENDERS inside the grace window, which passes just as happily against a
flow whose submit reverts. Both are shipped, reachable, fund-moving
settlement paths, so this closes the gap rather than recording it.

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
comparisons. The spec now asserts that the borrower's collateral
balance does not move across the acceptance, which is what separates a
re-tagged lien from a second pledge; it was verified to catch a
one-wei perturbation.

Supporting change: the shared direct-accept helper became side-aware.
It previously bound only the lender-offer endpoints, so a lender
funding a borrow request — which the refinance spec needs — was not
expressible. Rather than add a near-duplicate, the helper now derives
which leg the acceptor escrows and which endpoint of the creator's
range binds, mirroring the contract's own rule. The existing consumer's
suite was re-run unchanged to confirm no regression.

Closes #1587
Closes #1588
