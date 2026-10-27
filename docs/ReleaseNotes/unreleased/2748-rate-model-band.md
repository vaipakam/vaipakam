## Rate-model band: points cap, share of the market rate, points floor (PR #2942)

A registered rate model's quote was clamped to a fixed band of plus or minus
5 percentage points around the market rate the caller supplies. That is loose
on a low market rate (around a 1% market it let a quote fall to 0% or rise to
6%) and fixed regardless of the rate it surrounds. The band is now set by
three governance limits: each side is the tighter of a cap in percentage
points (default 5 points) and a share of the market rate (default 50% of it),
and never narrower than a floor in percentage points (default 1 point). The
band never goes below 0%. With the defaults, a 1% market allows 0% to 2%, a
4% market 2% to 6%, a 12% market 7% to 17%, and a 0% market 0% to 1%.

The three limits are set in one admin call, each with its own bounded range
and a reset-to-default value, and a floor wider than the cap is refused.
The floor in effect is also never above the cap in effect, so a cap set
under the old single-value setter is not widened by the new floor's default
when a Diamond is refreshed in place. The
single-value setter for the old cap is retired (the platform is prelive, so
no compatibility route is kept); the getter for the points cap is unchanged
and two getters are added. The Protocol Console shows all three limits and
labels which two are percentage points and which one is a share of the market
rate. The quote stays a dormant opt-in: no offer path calls it today, so this
changes no live rate. The two new limits are appended storage fields that read
as their defaults until set.

The rate model, its band and the quote now live together in one new facet
(RateModelFacet), moved off AdminFacet and OfferCreateFacet with their
function selectors unchanged. The move was needed because the wider clamp
took OfferCreateFacet over the contract size limit; it also puts the setter
and the clamp it governs in one place, so they can no longer be refreshed
apart. The curated stale-facet refresh refuses a Diamond that does not yet
have the new facet. The change reaches the testnets with the all-waves
deploy.

Closes #2748.
