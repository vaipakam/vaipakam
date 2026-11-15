## Thread — The vault and VPFI rehearsal flows run on the staged runner (#3574)

The vault and VPFI rehearsal flows now broadcast through the staged runner. They cover recovering a stray token from a vault (PF-280), the ban when the declared source is sanctioned (PF-281), disowning a stray token (PF-282), and the VPFI deposit, discount consent, loan and withdraw sequence (PF-250). With this change every positive-flow module broadcasts in stages, and the rehearsal runbook runs all nine in one loop.

The recovery scenarios take one step each. The VPFI scenario takes two. The first wires a mock VPFI token on the Diamond, deposits and consents, and posts the lender's offer. The second runs once the deposit has been held for the Diamond's minimum staking period plus a day, a period it reads from the Diamond rather than assuming. It opens and closes the loan, checks that no VPFI left the borrower's vault, withdraws free VPFI and puts the Diamond's VPFI settings back. On a local chain the runner steps the clock past that wait; on a live testnet the run waits for it.

Every setting these flows change is recorded as a setting to put back: the sanctioned source PF-281 flags, and the VPFI token, discount rate, reference asset and borrower consent PF-250 changes. If a run stops part-way, the unwind step restores whatever the chain still shows changed, and the closing check refuses while anything is. This was exercised on a run stopped after the VPFI setup: the unwind put back the earlier token, the rate, the reference asset and the consent, and a second unwind found nothing left to do.

Advances #3574. The partial and negative flow scripts are still simulation-only.

> Caveat: a Diamond with no VPFI token set keeps the mock token wired after the run, because the Diamond refuses to set the token back to none. This was already the case before staging, and only a fresh local chain starts that way.
