## Thread — The discounted liquidation's discount is fixed when the loan starts (PR #<n>)

A discounted liquidation gives the liquidator the collateral at a discount that depends on how deep the collateral's market is: the thinner the market, the wider the discount. Until now the route measured that depth at the moment of the liquidation, with the same read new positions use. That read deliberately drops a pool whose current price disagrees with the oracle. So a liquidator could push one deep pool's price in the liquidation's own block, make the collateral look thinner, and take a wider discount out of the borrower's surplus. A keeper lowering the asset's tier later had the same effect on every open loan. The route is switched off on every chain, so nothing was exposed, but it had to be fixed before the route is ever switched on.

The tier and its discount are now recorded on the loan when it starts, and the route and its preview read only that record. The recorded tier is the lower of two readings. One is the collateral's close-out depth tier: its pools' average depth over the look-back window, valued at the oracle price, which nothing done in one block can move. The other is the keeper's tier for the asset. The discount is that tier's discount at that time. After the start, no later pool movement, keeper-tier change or change to the discount table alters it, so a borrower knows from the start what a liquidator on this route would receive.

The trade-off is stated, not hidden. If the collateral's market genuinely thins during the loan, the recorded discount does not widen to attract liquidators. The ordinary liquidation routes stay available for such a loan. A loan whose collateral had no tier at the start is refused by this route for its whole life, as an untiered loan already was.

Two fields are appended to the loan record, so the loan details read carries them. Existing loans on the testnets carry no record and are refused by the route until the next fresh deploy; the route is off there anyway.

Closes #910. Also answers the check #3351 asked for: a keeper-tier change no longer reaches an open loan's discount.
