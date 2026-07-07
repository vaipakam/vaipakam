## Offer collateral floor / lending ceiling is now enforced at creation and modification (PR #<n>)

The protocol derives, for any liquid-both-legs ERC-20 offer, a minimum collateral
a lender may require (so the worst-case fill can clear the loan-admission Health
Factor) and a maximum principal a borrower may request against their posted
collateral. Previously this bound was only *intended* to run at offer creation
and was, in practice, not enforced at all: it sat behind a configuration flag
that the platform never enables, and even with the flag on it read an
offer-amount field that had not been populated at that point, so it never
actually rejected anything. There was also no equivalent check when an existing
offer was modified in place, so a lender could post a compliant offer and then
edit it into a shape a fresh creation would have rejected.

This makes the bound real and consistent. The floor/ceiling is now enforced
whenever an offer is liquid on both legs — the same scope as the runtime
loan-admission gate — and it is applied identically at offer creation, at every
in-place offer modification, and at internal-match slice materialization, sharing
a single definition so the three paths cannot drift. It no longer depends on any
configuration flag. Offers on illiquid or NFT legs are unaffected (they follow
the mutual-consent illiquid path). In the depth-tiered risk regime, collateral in
the no-borrow tier is rejected up front at creation/modification instead of only
at acceptance, so an offer that could never become a loan now fails fast.

The read-only intent match preview keeps its non-reverting, structured-error
contract — the shared bound math is exposed to it as a check that returns a
failure code rather than reverting, so solvers and preflight callers see the same
outcome the execution path would produce.

Observable effect: an offer whose collateral is too thin (lender) or whose
requested principal is too high for its collateral (borrower) is now rejected at
creation or modification with a clear collateral-floor / lending-ceiling error,
rather than being posted and only failing later at acceptance.

This is the last of the three deferred #998 spec-conformance findings; its
approach was ratified in the Tranche-5 deferred-trio design doc after three
rounds of review.

Closes #900.
