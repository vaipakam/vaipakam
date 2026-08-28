## Thread — The liquidity-confidence pass stops re-reading what cannot change (PR #TBD)

The keeper's liquidity-confidence pass decides, per collateral asset, whether
real aggregator routing supports the depth tier the protocol has on file. Its
per-tick request budget was dominated by two things that were not that
decision.

The first was the scan that finds which assets to evaluate at all: it read every
active loan's details one at a time, sequentially, purely to collect the
distinct collateral assets among them. Those reads are now batched. The walk
still stops as soon as it has as many distinct assets as a tick will evaluate,
so a chain with a very large loan book does not trade one unbounded cost for
another — the batching happens chunk by chunk rather than in one unbounded
request.

The second was repetition. For every asset under evaluation the pass asks the
oracle for that asset's price and the token for its decimals, and then does the
same for each quote token it might route through. Those answers are identical
for every asset within the same tick, and a token's decimals are identical for
all time, yet each pairing re-read both. Both are now remembered for the
duration of one chain's tick.

Two deliberate limits on that memory, because the failure mode here is quiet
rather than loud. It is scoped to a single chain's tick and discarded
afterwards: the same address is a different token on a different chain, so a
memory shared across chains would answer with the wrong chain's price. And only
successful reads are remembered. A missing price feed or a failed decimals read
is retried on next use, exactly as before, because the decimals path falls back
to a default when it cannot read the real value — and a remembered wrong
default would silently distort every slippage figure derived from it for the
rest of the tick. Tests pin both properties, including the retry-on-failure
behaviour that a well-meaning simplification would remove.

Measured against the profiling fixture the pass drops from 428 requests per tick
to 209. The decimals saving is not part of that figure and is additional: the
fixture has no ERC-20 interface, so every decimals read there fails and falls
back, which the pass swallows without logging — an unrelated gap in the fixture,
noted separately, that has been reporting this pass as making zero errors while
it failed 78 reads per run.

Refs #1896.
