## Keeper: liquidity-tier promotions cannot be made faster than the design allows

The keeper raises an asset's confirmed liquidity tier one step at a time, and only after the aggregators have confirmed the higher tier on consecutive checks spread over several days. It lowers a tier on a single reading. The rule exists so that depth added for a short time cannot lift a tier (the rate guide and link guards design, section 9).

Until now the two settings behind the raise, the number of checks and the number of days, could be set below the design's figures. They now have hard floors: at least 5 checks over at least 3 days. Leaving them unset uses the floors. A lower value, or one that is not a whole number, is refused by name: the keeper logs which setting it refused and raises no tier until the setting is corrected. Lowering continues unchanged, because it is the fail-safe direction. A refused setting also gathers no evidence, so a corrected setting starts a full window.
