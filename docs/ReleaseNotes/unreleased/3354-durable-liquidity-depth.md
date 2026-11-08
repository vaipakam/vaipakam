## Liquidity status reads pool depth that persists, not a single block (PR #<n>)

Whether a token counts as liquid, and which depth tier it earns, used to be read from each pool exactly as it stood in the current block. Depth added and removed around one transaction could therefore make a weak token look liquid when a loan opened, and depth pulled just before a liquidation could make that liquidation refuse. The owner chose an on-chain fix.

A V3-style pool now counts only when its own on-chain record covers the averaging window (30 minutes by default), and its depth is the liquidity it held on average over that window. Opening a position, reading a tier or checking an offer's bounds credits the lower of the current depth and the average. A liquidation or a time-based default credits the average alone, so depth withdrawn in the same block cannot turn a liquid loan's sale into a refusal. The sale's own minimum output and the in-kind fallback decide what a genuinely thinner pool can fill. The recent-price check that compares the window's average price with the current price is now required, where before it was skipped for a pool without history.

V2-fork pools are no longer consulted at all, because they keep no time-weighted record of their reserves. Their three factory setters and getters, their events and the factory configuration script are removed. The three storage slots stay unused so the storage layout only grows.

The testnet mock pools now answer the same oracle query, with a record that starts a day before deployment and follows every later liquidity change. Deployed mock pools predate this and must be redeployed with the change, so it reaches the testnets at the next fresh deploy.

Closes #3354. Advances #830 and #1275: an attacker who holds real depth for longer than the window is not stopped by this, and keeper confidence and exposure caps remain open there.

> Caveat: a real pool created at the default oracle size has no history and reads illiquid until someone enlarges its record and the window passes.
