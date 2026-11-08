## Thread — Forced sales lose less on deep, calm markets (PR #3380)

Every forced sale of collateral used to accept losing up to the full 6% slippage cap to the market, whatever the asset. On a deep market in a quiet hour a sale fills for far less than that. The rest was room for a searcher to take from the sale, and the borrower paid for it, since what a forced sale fails to raise comes out of what is returned to them.

A new rule, read by every forced seller through one self-call (the health-factor liquidation on both routes, the partial liquidation, the liquid time-based default and the periodic-interest settlement), now tightens the floor to a figure set by depth tier. A collateral that clears the $5M probe at no more than 2% impact gets 2.5%, the $500k probe gets 3.5%, and the $50k probe gets 4.5%. The tighter floor applies only while the pair is calm and the loan is well cushioned. Calm means the collateral-to-principal oracle rate now is within 2% of the rate at each of the last two hourly checkpoints. Well cushioned means the collateral is worth at least 110% of the debt. Anything else uses the full 6% at once. These are the owner's "Balanced" figures, chosen on 2026-11-08.

Every input the rule cannot establish falls back to the full cap: no checkpoint for either asset in either hour, a price that cannot be read, or a collateral shallower than the $50k probe. The rule can make a sale's floor tighter only when it has positive evidence, so a missing keeper or a stale price returns a sale to the behaviour before this change and never tightens it. The depth tier is measured the way a close-out measures liquidity (window-mean depth, no check against the pool's current price, #3354 and #3371), so a sale's own block cannot move it. A sale whose routes cannot meet the tighter floor takes the ordinary failed-swap path.

The hourly checkpoints are a new permissionless step. Anyone may record each asset's oracle reading for the current hour, and the first caller wins. A keeper pass will back it and will ship disarmed, so until it is armed every forced sale keeps the full 6%. The figures, the calm bound and the cushion are governance settings with bounded ranges, and the sale preview now reports the floor each sale will use.

The liquidator incentive is unchanged: it is still sized against the fixed 6%. The failed-swap retry and the borrower's own swap-to-repay keep their own floors.

The rule lives in a new facet, `SaleFloorFacet`, because the forced-sale host had about 300 bytes of contract-size headroom left. OracleFacet gains the close-out depth-tier read. The curated redeploy script refuses a Diamond that does not already route the rule, so the crossing is a fresh deploy or the all-facets refresh.

Closes #3359.

> Caveat: the tighter floors take effect only once the hourly-checkpoint keeper pass is armed; until then every forced sale uses the full 6%.
