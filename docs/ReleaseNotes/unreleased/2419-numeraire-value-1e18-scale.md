## Thread — Loan risk values carried at 1e18 numeraire precision (PR #2690)

Every value the protocol computes for a loan leg is now expressed in the active
numeraire with eighteen decimal places, through one shared rule, instead of in
whole numeraire units. That covers each leg of the loan-to-value and health-
factor readings (so loan initiation, liquidation, add-collateral and
refinance), the create-time collateral floor and lending ceiling an offer is
checked against, the partial-liquidation snapshots, the partial-withdrawal
simulation and every KYC comparison (both parties' on acceptance, the lender's
at default, both parties' on a counterparty change, and the liquidator's). An
asset that is not liquid still counts for nothing in a KYC comparison. The rule
rounds once, in the lender's favour: a debt or principal leg rounds up, a
collateral leg rounds down, and a value compared against a threshold rounds
down. The offer-time bounds are derived from the same rounding the binding
check uses: a health-factor bound is exactly the tightest value that check
accepts, and a loan-to-value bound holds the unrounded ratio to the cap, so it
is never looser than the check and at most one basis point stricter. A small
loan's risk figures are therefore exact to a billionth of a billionth of a
unit, and the binding check and the pair-level preview agree. Offers so small
that they fell below one numeraire unit now meet the same collateral bounds as
any other offer.

The rule lives in one library and is served to the facets close to the
contract size limit by a new view-only facet, the numeraire value facet, with
three reads: the value of an amount of a token, the amount of a token worth a
given value, and the value a KYC comparison uses (zero for an asset that is
not liquid). It reads the price through the oracle, so staleness, sequencer
and quorum refusals apply unchanged. A price of zero is refused rather than
used, and a token whose decimal count cannot be read is refused by name and is
not classified as liquid. The new facet is carried by the full in-place
refresh and by both curated refresh scripts; a facet that values through it,
refreshed onto a Diamond without it, fails with a clear "function does not
exist" revert rather than misreading a value.

A time-based default on collateral that is liquid, or was liquid when the loan
began, whose pair cannot be priced (either leg has no price, or a price of
zero) still completes. It attempts no sale, because a sale with no oracle
floor is not one the protocol will make, and enters the fallback directly, the
same entry a failed sale takes: the lender's claim is the collateral, and the
loan stays curable until claimed. A missing collateral price no longer leaves
such a loan to the illiquid route, where a loan without both parties'
illiquid consent could not default at all. A loan that began on illiquid
collateral keeps its consented in-kind transfer. A price the oracle's sources
disagree on still refuses the default until they agree.

An asset whose decimal count cannot be read is now classified illiquid before
any other check, including the wrapped-ether shortcut, so no part of the
protocol treats it as liquid while its valuation refuses.

**Operator action — the partial-liquidation dust floor.** The dust floor is
a numeraire value, so it moves to the same 1e18 scale: one thousand dollars is
now written as one thousand followed by eighteen zeros. A nonzero floor must
sit between one and one hundred thousand numeraire units, and the setter
refuses a value written on the old whole-unit scale by name. A floor already
stored on the old scale is below that minimum, so after the refresh it reads
as no floor: dust handling is off, and the sizing getter reports a floor of
zero. Set it again on the new scale if dust handling should stay on; the
setter lives in the admin facet, so a curated refresh that leaves the admin
facet on older code cannot set a floor on the new scale until that facet is
refreshed too. Changing the active numeraire now also resets the floor to
zero (dust handling off) until governance sets one in the new numeraire. Dust
handling ships off by default, so a deployment that never set a floor needs
nothing.

Part of #2419.
