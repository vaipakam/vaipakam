## Risk-access preview cluster split into its own facet + intent-preview floor parity (PR #<n>)

The self-sovereign risk-access surface was carried by a single internal
facet that had grown to the very edge of the protocol's per-facet code-size
limit, leaving no room for future work on that surface. This change splits it
into two: the original facet keeps the state-writing controls (a vault opting
its own risk tier up or down, granting per-pair consent, the governance terms
levers) and the plain state read-outs, while a new sibling facet takes over the
read-only "preview" surface — the dry-run checks the app and keeper bots call to
learn, without spending gas, whether an offer accept, a keeper match, or an
auto-lend intent fill would be allowed, plus the two internal gate assertions
the match and obligation-transfer paths already delegated to it. The behaviour
of every one of these entry points is unchanged; only their home moves. Callers
reach them through the same single protocol address as before, so no integration
sees a difference. The split frees a large amount of head-room on both facets so
future risk-access work has somewhere to land.

Riding along on the freed head-room, this also closes a small divergence between
the auto-lend intent **preview** and the live fill it predicts. For a collateral
that can never back a new loan at origination — an asset configured to admit no
borrow, or one demoted to the no-borrow tier under depth-tiered risk — the live
fill is rejected up front with a clear "collateral below the required floor"
reason. The preview, however, was only doing a lighter floor check that such a
collateral could slip past, so it would report a different, later reason than the
one the fill actually raised. The preview now applies the same no-borrow guard the
live path does, so a solver or the app sees exactly the outcome the fill would
produce. This was deferred earlier only because the extra check did not fit under
the code-size limit; the split is what makes it affordable.

Also repaired in the same change: two test suites that exercise adjacent surfaces
were using collateral thinner than the offer-admission floor introduced by the
earlier floor/ceiling work, so they had started failing; their collateral is now
set above the floor (they test plumbing, not the bound). A larger signed-offer
matcher suite with the same root cause is tracked as a separate follow-up.

Closes #1104.
