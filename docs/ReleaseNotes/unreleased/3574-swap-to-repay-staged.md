## Thread — The swap-to-repay rehearsal flows run on the staged runner (#3574)

The swap-to-repay rehearsal flows, a full close-out paid from a collateral sale (PF-118) and a partial repayment from one (PF-119), now broadcast through the staged runner. Before this change they could only run as a simulation, because each posted an offer and filled it in the same broadcast, which the offer-age rule refuses before anything is sent.

Each scenario now takes two steps. The first posts the lender's offer. The second, once the offer's terms have aged, registers a fixed-rate swap adapter, opens the loan, sells the collateral and checks every unit of the proceeds as before. It then closes the loan out and takes the adapter off the swap list.

The swap adapter a scenario registers is now one of the settings the staged runner records and puts back, shared by every staged module rather than kept inside the timed module. If a run stops part-way, the unwind step takes the adapter off the swap list when the chain still shows it there. The closing check refuses while it is still listed.

The rehearsal runbook runs the swap-to-repay module in the same loop as the other staged modules.

Advances #3574. The partial and negative flow scripts and the vault, keeper and operator-admin modules are still simulation-only; staging them, one module per change, is the rest of that issue.

> Caveat: unwinding an abandoned swap-to-repay run takes the adapter off the swap list but leaves that run's open offer or loan on the rehearsal chain.
