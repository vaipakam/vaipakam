## Thread — Distinct liquidators per chain on the loan stats (PR #<n>)

The indexer's loan stats now report how many distinct addresses carried out liquidations on the chain over the last 7 and 30 days. This is the trigger for the liquidation bonus auction (#3355): the auction gets built once a chain has at least five independent liquidators over 30 days. Before this, nothing measured that.

The protocol keeper is counted separately from third parties. It is identified by the chain's published keeper address, which is now recorded for Base Sepolia, Arbitrum Sepolia and BNB Testnet. The routes the auction threshold counts (Health-Factor liquidation in its single and split forms, partial, discounted) are kept apart from the internal match and the periodic auto-liquidation. Those two routes are shown, but they don't count toward the threshold.

The time-based default's liquidation event names no caller, so those liquidations are counted only as events and never assigned to an address by guesswork. #3367 adds the caller to that event.

Closes #3366.

> Caveat: The count is of distinct addresses, not independent operators. One party can run several wallets, so the auction threshold is a lower bar that still needs a human check.
> Caveat: A liquidation through a flash-loan receiver contract names that contract, so each receiver deployment counts as one address.
