## Thread — The keeper rehearsal flow runs on the staged runner (#3574)

The keeper rehearsal flow (PF-300) now broadcasts through the staged runner. Before this change it could only run as a simulation, because it posted an offer and filled it in the same broadcast, which the offer-age rule refuses before anything is sent.

The scenario now takes three steps. The first posts the lender's offer. The second, once the offer's terms have aged, opens the loan and has the borrower approve a keeper for one action on it. The third has the keeper preclose the loan from its own wallet, then the borrower revokes the keeper.

The keeper approval is recorded as a setting to put back. If a run stops after the approval, the unwind step revokes it when the chain still shows it, so an abandoned rehearsal does not leave a live delegation on the borrower. This was exercised on a run that really broke: the closing check refused, and the unwind revoked the leftover keeper.

The staged runner now sizes each transaction's gas from the node's own estimate, taken when the transaction is sent, instead of from a multiple of the gas forge's simulation measured. A price read through the Diamond needs a fixed gas reserve on top of what it uses, so a transaction that reads a price late in its run was refused for lack of gas even at twice its measured use. The node's estimator finds the limit the transaction actually needs. The timed, swap-to-repay and lender-intent modules were re-run on this sizing.

Advances #3574. The partial and negative flow scripts and the vault and operator-admin modules are still simulation-only; staging them, one module per change, is the rest of that issue.

> Caveat: on a public testnet the node's estimate can come from a slightly stale view of the chain, which the runbook already notes for other broadcasts; a stage stopped that way is handled like any stage that did not land whole: unwind it and start a fresh run.
