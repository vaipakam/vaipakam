## Thread — One answer to "can this lender sell now?" (PR #TBD)

A lender can leave a loan early in two ways: sell straight into a standing buy
offer, or list the position for sale. Until now the app had to guess, route by
route, whether the contract would accept either one, by reading a dozen pieces
of state and re-implementing each entry's checks. Those guesses could drift
from what the contract actually does, so the app could offer an exit that
failed on submission or hide one that would have worked.

The contract now answers the question itself. A new read, keyed by loan and by
the wallet that would act, returns for each route every reason it is refused
right now and, for each reason, the earliest moment it can lift by time alone
or by a step anyone may take (for example an expired listing or offset being
cleared away), or no time when a decision is needed. Each reason is the exact
error the route raises, so the app decodes it with the contract's own error
list rather than a second table. Both sale entries now run their opening checks
through this same rule and raise the first reason it reports, so the answer and
the entries cannot disagree: the global and per-asset pauses, sanctions
screening, who may act, an active ERC-20 loan, a live listing or borrower
offset, the loan's term, the final-hour listing window, the relist cooldown,
consolidation, the offer-duration cap, outdated vaults, and sale admission.

The answer states what it does not cover: anything about the buy offer a direct
sale would consume, the listing's own inputs, and a keeper's service capacity.
Overdue periodic interest does not close either route. Three refusals now read
more precisely than before: listing a loan past its due date reports that the
loan is past maturity, listing from an outdated vault reports that the vault
needs an upgrade, and selling a loan that has no live lender position reports
that the loan is not active. The new host must be refreshed together with both
sale facets. Closes #1841.

> Caveat: the answer reports when a listing route could reopen at the earliest; a relist cooldown actually runs from when an expired listing is cleared away, which can be later.
