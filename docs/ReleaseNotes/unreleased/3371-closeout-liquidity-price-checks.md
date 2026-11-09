## Thread — Liquidations keep running through a fast price move (PR #3374)

Whether a liquidation or a time-based default may sell its collateral depends on the collateral reading as liquid at that moment. Until now, that check refused every pool whose current price had moved more than about 3% from the pool's own 30-minute average, or away from the price feed. A sharp genuine drop does exactly that. So in a crash the collateral could read as not liquid: health-factor liquidations were refused, and a time-based default either moved the collateral in kind or was refused outright, until the pool's average caught up. Anyone willing to push a pool's price for one block could cause the same refusal on purpose.

Close-out checks now skip those two price checks, and credit the pool's 30-minute average depth (#3354) at its current price. New positions, tiers and offer bounds keep both checks, so a manipulated pool still cannot admit a position. A close-out does not need them: the forced sale demands an oracle-derived minimum output, and the in-kind fallback takes over when no route meets it. So a moved or pushed pool can fail to fill a sale, but never fill it at a bad price.

Closes #3371.
