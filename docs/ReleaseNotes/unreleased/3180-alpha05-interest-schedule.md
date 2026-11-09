## Thread — The next app shows a loan's interest schedule (PR #3309)

A running loan that pays interest on a schedule (every month, quarter, six months or year) now shows its current period on its page in the next app: when the period ends, when its grace period ends, the interest it owes, what has been paid toward it and what is still owed. Every figure is the protocol's own settlement preview. The interest for a period is figured on the principal and rate as they stand now, so the page says a partial repayment lowers it.

The page also says whether the period can be settled now, and what settling would do: a paid period only moves the checkpoint forward, and one still short sells just enough collateral to cover what is owed and the sale's charges. The protocol's own "can be settled now" does not account for the network's periodic-settlement switch or the protocol pause, so the page reads both and names them: switched off, it says nothing can be settled and no collateral is sold, in place of any warning of a sale; paused, it says no period can be settled while the pause lasts and that the paused time moves the period's dates. A switch, pause or period that could not be read is stated as unknown.

It also states how the borrower pays a period (by partial repayment where the loan allows it, otherwise only by full repayment or by the sale), that a pause moves the period's dates later while the interest a period owes stays one period's worth (interest keeps accruing through the pause, and any interest a repayment pays counts toward the period), that settling is open to anyone while whether the protocol's keeper settles periods is not known, and the chain time the period is placed against.

Paying a period and settling one come in later updates.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITION-SCHEDULE. Epic #3180.
