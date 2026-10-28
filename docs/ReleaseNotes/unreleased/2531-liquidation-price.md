## Thread — Liquidation price next to the health factor (PR #2996)

The loan page's advanced health detail now states the liquidation price: the
collateral price at which the health factor reaches 1.00, in the protocol's
reference currency per whole collateral token. It is derived from the
protocol's own two answers, the health factor and the collateral's price,
read together in one block, so the app keeps no second copy of the threshold
or the interest rules. The figure is rounded up, both when it is computed and
at the precision it is shown, so it never sits below the real line, and the row says what it assumes: the borrowed asset's price and the
amount owed held where they are, with accruing interest moving it up.

Every case without a figure says why instead of showing zero: a loan whose
assets the protocol does not price has no liquidation price, a loan whose
collateral price or token details could not be read shows "unknown", and a
loan whose debt is too small to reach the line says no price brings it there.

The loan risk reads (health factor and loan-to-value, on the loan page and in
the positions lists) now go through one multicall, so they share a block and
an on-chain refusal is told from a provider failure by the call's own status.
That multicall is read as a single request, which the app's other
failure-tolerant batched reads (the forced close-out readiness and the Offer
Book's pricing) now share: the stock multicall reported an unreachable
provider as every call failing, so a liquid loan could have been shown as one
the protocol does not price. A provider failure is now an error that says the
reads failed, and a lint rule keeps the stock form out of the app. A risk
read whose latest refresh failed no longer keeps showing its last health
factor or liquidation price: the loan page says the read failed and the lists
show the health as unknown, since interest and prices move the line between
reads.
The numeraire symbol decoder the protocol console used is now shared. Closes
#2531.

> Caveat: the figure assumes the borrowed asset's price holds; if both legs move, the real line moves with the ratio of the two.
