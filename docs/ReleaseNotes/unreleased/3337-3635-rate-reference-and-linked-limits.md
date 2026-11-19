## Thread — rate reference, market-linked rate limits and the warning band (PR #<n>)

Each chain now has a standalone rate reference, found through the protocol
registry's new `RATE_REFERENCE` pointer, which carries the same 7-day minimum
delay as the price guard. For each asset it reads the variable borrowing rate
of three to five outside lending markets through small fixed readers, keeps
the median of the readings that agree, steps and caps it per its series, and
records an exact running sum, held time and hourly and daily checkpoints.
From those it answers the averaged rate over any window, whether the rate is
unusual (24-hour average more than 5 points from the 30-day one), the term
average for a loan's term, and the warning band around it. A read that cannot
be substantiated says why and is never a number. Series are immutable, open
only after the reference's own delay, and a source can be muted at once. The
design is `docs/DesignsAndPlans/RateReferenceDesign.md` and
`TermAverageAndLinkGuardsDesign.md`.

A maker may now link an offer's or an Auto-lend slot's rate limit to the
averaged reference or to the term average, plus a margin. The link only
tightens the typed limit, follows the loan's term, and is refused by name
while it cannot be used. Matches, direct accepts and instant-market fills all
read the effective limits through one new facet, `RateLinkFacet`, which also
holds the match rule on rate (the midpoint of the two effective limits), and a
loan whose rate a link set records it. The Auto-lend slot match and the
instant-market fill now run the match core through the one copy
`OfferMatchFacet` hosts instead of carrying their own, which keeps both under
the contract size limit; refresh the three together.

Every step that sets, changes or takes a fixed rate now runs one shared band
check: outside the band around the term average it needs the user's
acknowledgement, which is a new field on offer creation, both offer edits, the
intent setter, the signed offer, the accept terms and the instant borrow. The
offer-created, offer-modified, intent rate-terms and loan-opened events carry
the warnings mask the contract derives, and an integrator's count of warned
loans now moves.

Breaking for integrators: `CreateOfferParams`, `OfferModifyParams`,
`setOfferRate`, `setLenderIntent`, the signed-offer and accept-terms typed
data, `MatchResult` and several events gained fields. The next fresh deploy
carries them; ABIs are re-exported in this change.

Advances #3337 (part 1) and #3635 (part A), with #3713 and #3719.

> Caveat: the reference opens with no series; each asset's series is proposed and opened by its owner after deploy, and the keeper's hourly `update` pass is still to be built (shipped disarmed, keeper thread).
> Caveat: previews return the fill's rate; its band is one read of `RateLinkFacet.rateWarnings`, not yet a field of each preview.
