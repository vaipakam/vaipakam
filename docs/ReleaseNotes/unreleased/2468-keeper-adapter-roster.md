## Keeper liquidation routes read from the protocol (#2468)

The keeper's liquidation passes now build their swap routes the same way
the app's lender close-out does, from one shared set of rules. Before,
the keeper kept its own table of which swap venue sat at which position
in the protocol's adapter list. That table was correct only until
governance changed the list, and had no entry at all for Base Sepolia,
so the keeper could not build a liquidation route on the only live
testnet.

Now the keeper reads the adapter list from the protocol at build time.
On Base Sepolia that means it can route through the testnet mock adapter,
once it has checked that the mock would actually pay. Each aggregator is
also now quoted for the adapter that executes the swap. The old code
quoted for the protocol contract itself, which is calldata for a caller
that never makes the call. Aggregator quotes use the protocol's own
slippage ceiling.

A split liquidation now uses only aggregator routes as its legs. The
protocol checks a split's legs only in total, so each leg has to carry
its own price limit, which aggregator routes do and direct pool routes
do not. When an enabled adapter has a name the keeper does not
recognise, the keeper now says so in its log instead of leaving it out
silently.

Balancer V2 is no longer asked. Its only quote source was a hosted
subgraph service whose availability could not be confirmed, so the venue
is left out rather than sent on a guess. Using it again needs a decision
on a reliable source. The liquidity-confidence pass, which only measures
prices, uses the same builder.

No contract change.
