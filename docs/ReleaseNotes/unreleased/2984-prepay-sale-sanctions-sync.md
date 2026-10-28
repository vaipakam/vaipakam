## Thread — keeper backstop for committing flagged prepay-sale recipients

A prepay sale listing, and a parallel-sale offer, carries the parties it would pay: the borrower-position holder and each fee-leg recipient. When one of those addresses becomes sanctioned after the listing went up, the protocol's sync call commits that fact on-chain so the sale can no longer pay the flagged party. Anyone may make that call, and nothing made it on a schedule, so a listing could stay live with a flagged recipient until someone happened to notice.

The keeper's protocol upkeep pass now carries a third step, the prepay-sale sanctions sync, behind its own arming flag. It ships switched off. While it is off the run report says so by name rather than leaving the step out.

The keeper asks the protocol which parties each listing would pay, through the two new party views, so it screens exactly the set the sync call itself checks rather than a copy of that rule. It screens those addresses through a new Diamond view, `sanctionsStatus`, which gives the same three-way answer the sync acts on: clean, flagged, or unavailable when the oracle cannot answer. The older yes-or-no screen reads an oracle outage as clean, so a run during an outage would have reported nothing flagged. Now a listing the oracle could not screen is named in the report as unscreened. The keeper sends the sync only for a listing that names a flagged party. With no oracle configured the step does nothing and says why. Every read the step makes stops at its stage's cutoff, so a slow read cannot use the time its sends need.

Loan listings are read a window of active loans per run. Parallel-sale offers are nominated from the indexed listing events and read back on-chain before anything is sent. The offer cursor moves only past rows that have settled on finalized state, so a reorg cannot make it skip one. The report names each listing synced, each one the sync left live, and each one that disappeared between the read and the send. The keeper pays only gas and moves no value. Refs #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision.
> Caveat: needs the party views from #3049 and the `sanctionsStatus` view from this change; it cannot run against a Diamond that lacks them, so on the testnets it waits for the fresh deploy.
> Caveat: on a large book a listing can wait several runs before its window comes round.
