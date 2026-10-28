## Thread — keeper backstop for committing flagged prepay-sale recipients

A prepay sale listing, and a parallel-sale offer, carries the parties it would pay: the borrower-position holder and each fee-leg recipient. When one of those addresses becomes sanctioned after the listing went up, the protocol's sync call commits that fact on-chain so the sale can no longer pay the flagged party. Anyone may make that call, and nothing made it on a schedule, so a listing could stay live with a flagged recipient until someone happened to notice.

The keeper's protocol upkeep pass now carries a third step, the prepay-sale sanctions sync, behind its own arming flag. It ships switched off. While it is off the run report says so by name rather than leaving the step out.

The keeper asks the protocol which parties each listing would pay, through the two new party views, so it screens exactly the set the sync call itself checks rather than a copy of that rule. It screens those addresses against the Diamond's own sanctions oracle and sends the sync only for a listing that names a flagged party. With no oracle configured the step does nothing and says why.

Loan listings are read a window of active loans per run. Parallel-sale offers are nominated from the indexed listing events and read back on-chain before anything is sent. The offer cursor moves only past rows that have settled on finalized state, so a reorg cannot make it skip one. The report names each listing synced, each one the sync left live, and each one that disappeared between the read and the send. The keeper pays only gas and moves no value. Refs #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision.
> Caveat: needs the party views from #3049; it cannot run against a Diamond that lacks them.
> Caveat: on a large book a listing can wait several runs before its window comes round.
