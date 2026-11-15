## Thread — The vault and VPFI rehearsal flows run on the staged runner (#3574)

The vault and VPFI rehearsal flows now broadcast through the staged runner. They cover recovering a stray token from a vault (PF-280), the ban when the declared source is sanctioned (PF-281), disowning a stray token (PF-282), and the VPFI deposit, discount consent, loan and withdraw sequence (PF-250). With this change every positive-flow module broadcasts in stages, and the rehearsal runbook runs all nine in one loop.

The recovery scenarios take one step each. The VPFI scenario takes two. The first funds the borrower in a mock VPFI token, deposits and consents, and posts the lender's offer. The second runs once the deposit has been held for the Diamond's minimum staking period plus a day, a period it reads from the Diamond rather than assuming. It opens and closes the loan, checks that no VPFI left the borrower's vault, withdraws free VPFI and puts the discount settings back. On a local chain the runner steps the clock past that wait; on a live testnet the run waits for it.

Every setting these flows change is recorded as a setting to put back: the sanctioned source PF-281 flags, and the discount rate, reference asset and borrower consent PF-250 changes. If a run stops part-way, the unwind step restores whatever the chain still shows changed, and the closing check refuses while anything is. This was exercised on a run stopped after the VPFI setup: the unwind put back the rate, the reference asset and the consent, and a second unwind found nothing left to do.

The VPFI scenario never replaces the Diamond's VPFI token. Replacing a token cannot be undone: it retires the deposit period and clears the service capacity settings, and setting the old token back is a second replacement that restores neither. So the scenario registers its mock token only on a Diamond that has none, reuses a mock an earlier run registered, and on a Diamond with any other token it is skipped and says why.

Advances #3574. The partial and negative flow scripts are still simulation-only.

> Caveat: a Diamond with no VPFI token set keeps the mock token registered after the run, because the Diamond refuses to set the token back to none. Only a fresh local chain starts that way.
