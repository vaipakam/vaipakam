## Thread — A testnet drawdown rehearsal now moves the pool and the venue with the price feed (PR #2372)

Rehearsing a health-factor drop or a liquidation on testnet means moving a faucet asset's price. The obvious way, moving only its mock price feed, does not work. The faucet's mock trading pool keeps its old price, and the oracle stops trusting a pool whose price disagrees with the feed by more than 3%. Past that point the asset reads as illiquid, which looks exactly like a pool too shallow to trade. #2314 was first diagnosed as a depth problem for that reason. It was the rehearsal method, not the pool.

There is now one script for repricing a faucet asset, and it moves everything that carries the price: the price feed, the pool's price, and the price the mock swap venue pays out in a liquidation. These are three separate transactions, not one atomic change, because each mock belongs to a fixed owner wallet. For a few blocks in between, the asset can briefly read as illiquid. If a run stops part-way, running the same command again finishes it. It derives the pool's new price with the same calculation that set the pool up in the first place; the two scripts now share it, so they cannot drift apart. It works on the two faucet tokens that have their own feed (tLIQ and mUSDC). It refuses mWETH, whose feed is shared with WETH: moving it would move the quote side of every faucet pool.

Before sending anything, the script refuses in these cases:

- The deployment record no longer matches the chain.
- The sender does not own the mocks.
- The swap venue is not the one the Diamond actually sends liquidations to.
- The Diamond would not read the new price.
- The asset would read as illiquid even after the full move. This one can be overridden deliberately.

After the move, the script also reports, without refusing, the swap venue's other settings and the venue's price for every faucet asset, compared with the oracle's. These decide what a liquidation actually pays, and the script does not write them. It also says what it does not inspect: how much of the payout token the venue holds, and the venue's price for any token outside the faucet set. It reports a venue that anyone could call, too, because the venue holds funds. A clean run is therefore not a promise that a liquidation will settle correctly.

A companion rehearsal runs the script against a local copy of the live testnet, playing the real mock owner, and checks the outcome before anyone touches the shared testnet. The Base Sepolia runbook has a new section covering both and reminds operators to restore the seeded price afterwards. On testnet the script has not yet been run by anyone; it needs the mock owner's key.

Closes #2314.
