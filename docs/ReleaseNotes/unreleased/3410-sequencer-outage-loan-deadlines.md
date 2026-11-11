## Thread — Loan deadlines wait out an L2 sequencer outage (PR #3551)

On an L2, the sequencer can stop for a while. Nobody can send a transaction during that time, so a borrower whose grace period ended inside the outage could not repay and was defaultable the moment the chain came back. Liquidations already waited for one hour after the sequencer recovered; time-based deadlines did not.

Now a loan's grace end that falls inside an outage, or inside the hour after it, moves to the end of that hour. Until then the loan cannot be defaulted and the borrower can still repay, partially repay or swap to repay. The loan's due date itself does not move: an outage changes when a deadline can be enforced, not the loan's term or its interest.

A periodic interest settlement deadline is not moved. Settling a missed period sells collateral, and that sale needs a price, which the price guard already refuses until the recovery hour has passed. So no settlement sale can happen inside the outage or its recovery hour, and moving the deadline as well would add nothing that is enforced.

No late fee runs for time inside the outage and its recovery hour, whether the outage covered the due date or came later. A grace-period auto-listing of NFT collateral also waits until the recovery hour has passed. The loan's published deadlines read (the one that already reports the pause credit) reports the moved grace end.

The outage is read from the same sequencer uptime feed the price guard uses for liquidations, through a new read on the price guard. Nothing is recorded on-chain, so only the latest outage is known: an earlier outage's time is not excluded from a late fee charged after a later one. Where no sequencer feed is configured (an L1), nothing changes.

This changes the loan-clock family that every deadline reader shares, and the price guard gains a function, so it reaches the testnets at the next fresh deploy.

> Caveat: an off-chain surface that computes a grace end itself, instead of reading the loan's published deadlines, does not see the outage; such surfaces should read the moved deadline or say an outage is in progress (#3525).

Closes #3410.
