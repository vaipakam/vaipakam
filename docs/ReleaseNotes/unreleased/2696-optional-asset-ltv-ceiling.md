## Thread — An unconfigured asset can back a loan; the reserve factor is retired (PR #2817)

Any ERC-20 that passes the liquidity test was meant to be usable as collateral
without per-asset setup, with the per-asset loan-to-value value acting only as
an optional, tighter ceiling. The code read that value raw, so an asset nobody
had configured counted as a 0% ceiling and every liquid loan against it was
refused. A freshly deployed chain therefore refused all liquid borrowing until
governance had set a number for each collateral, and the launch step had to
warn about it. Now an unset ceiling means no extra per-asset limit: a new
loan's size is bounded by the loan-admission health-factor floor and, where
depth-tiered LTV is on, by the collateral's tier cap. A ceiling governance sets
still tightens that, the setter still refuses a value below 10% (so a ceiling
cannot be set to zero), and every reader of the ceiling (loan start, offer
bounds, intent matching, refinance, partial withdrawal, add-collateral and the
previews) goes through one rule. The risk-profile view now says whether a
ceiling is set rather than reporting an unset one as a number, and the launch
step's "not a check" note describes the new behaviour.

The per-asset reserve factor is retired. It was stored and range-checked but no
fee path ever read it; the treasury's cut of interest is the per-loan treasury
fee fixed when the loan starts. The risk setter now takes two values (the
ceiling and the liquidator-bonus cap), its event carries those two, and the
per-asset risk view leaves the retired field out. The storage slot keeps its
place under a declared rename, so an in-place refresh stays possible; the
curated redeploy script removes the old four-argument setter. The admin guide
and whitepaper no longer list the reserve factor or the per-asset liquidation
threshold retired earlier in #999.

Closes #2696.
