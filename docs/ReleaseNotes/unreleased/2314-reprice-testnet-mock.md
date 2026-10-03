## Thread — A testnet drawdown rehearsal now moves the price feed and the pool together (PR #<n>)

Rehearsing a health-factor drop or a liquidation on testnet means moving a faucet asset's price. The obvious way, moving only its mock price feed, does not work. The faucet's mock trading pool keeps its old price, and the oracle stops trusting a pool whose price disagrees with the feed by more than 3%. Past that point the asset reads as illiquid, which looks exactly like a pool too shallow to trade. #2314 was first diagnosed as a depth problem for that reason. It was the rehearsal method, not the pool.

There is now one script for repricing a faucet asset, and it moves everything that carries the price at once: the price feed, the pool's price, and the price the mock swap venue pays out in a liquidation. It derives the pool's new price with the same calculation that set the pool up in the first place; the two scripts now share it, so they cannot drift apart. It works on the two faucet tokens that have their own feed (tLIQ and mUSDC). It refuses mWETH, whose feed is shared with WETH: moving it would move the quote side of every faucet pool.

Before sending anything, the script refuses in these cases:

- The deployment record no longer matches the chain.
- The sender does not own the mocks.
- The Diamond would not read the new price.
- The asset would read as illiquid even after the full move. This one can be overridden deliberately.

A companion rehearsal runs the script against a local copy of the live testnet, playing the real mock owner, and checks the outcome before anyone touches the shared testnet. The Base Sepolia runbook has a new section covering both and reminds operators to restore the seeded price afterwards. On testnet the script has not yet been run by anyone; it needs the mock owner's key.

Closes #2314.
