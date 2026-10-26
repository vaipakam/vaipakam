## Thread — WETH always has a liquidity-tier quote route (PR #TBD)

The liquidity-tier search never quotes an asset against itself, so WETH can
only be tiered through a quote asset other than WETH. A fresh Diamond's quote
list is unset and stands for WETH alone, and no deploy step set it outside
Anvil, so WETH resolved to tier 0 whatever its market depth (#2747). That
matters even with depth-tiered LTV off: the tier sets every liquid loan's
liquidation threshold for its whole life and decides the discounted
liquidation's discount, which refuses tier 0. With depth-tiered LTV on, every
new WETH-collateral loan would have been refused.

The quote list now has one rule: once set, it always names an asset besides
WETH. Governance cannot set a list without one (an empty list included), cannot
re-point WETH at the list's only other quote, and cannot switch depth-tiered
LTV on while the list is still unset. The launch step gains a seventh
readiness requirement that refuses a chain whose list names no quote besides
WETH, so no chain opens with WETH at tier 0. The configure step writes the
list: the testnet mock rig's stable stand-in where the rig is recorded, and
the chain's canonical stablecoin from a new per-chain setting elsewhere.
Whether that quote's pools are deep enough for a higher tier is still measured
per loan and is not a launch requirement. Fresh deploy only, as for the rest
of this pre-live work.

Closes #2747.
