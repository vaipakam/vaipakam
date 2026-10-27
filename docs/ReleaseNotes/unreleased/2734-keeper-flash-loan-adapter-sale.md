## #2734 — the keeper's flash-loan liquidations sell through the Diamond's own swap adapters (PR #2896)

The flash-loan liquidator now sells the collateral it seizes only through a
swap adapter the Diamond has registered and not disabled (the contract half of
#2734). The keeper's flash-loan branch is changed to match.

- **One quote path.** The keeper used to keep a second quote service just for
  this branch, which asked 0x and 1inch for calldata the liquidator would call
  itself. That service is gone. The branch now asks the same route builder
  every other forced close uses, each aggregator quoted with its adapter as
  the taker, and hands the liquidator the chosen adapter and its quote.
- **The testnet mock is checked for the right caller.** Where a chain's mock
  adapter only pays one caller, the route builder now checks it would pay the
  liquidator, which is the contract that sells through it on this branch.
- **The internal-match window is a "not yet".** When the Diamond's preview
  says the loan is inside the internal-match priority window, the keeper logs
  that reason and leaves the loan to its normal liquidation branch, which is
  the one that dispatches the match.

Nothing is armed by this change: the branch still runs only on chains named in
`DISCOUNT_PATH_CHAIN_IDS`, which ships empty, and only where a liquidator is
deployed.
