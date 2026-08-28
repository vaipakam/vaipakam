## Thread — The liquidity-confidence pass stops re-reading what cannot change (PR #1993)

The keeper's liquidity-confidence pass decides, per collateral asset, whether
real aggregator routing supports the depth tier the protocol has on file. Its
per-tick request budget was dominated by two things that were not that
decision.

The first was the scan that finds which assets to evaluate at all: it read every
active loan's details one at a time, sequentially, purely to collect the
distinct collateral assets among them. Those reads are now batched. The walk
still stops as soon as it has as many distinct assets as a tick will evaluate,
and the batches are sized to that same cap so that a book whose loans all carry
different collateral does not decode a pile of loan records the old loop would
never have touched — decoding is the cost this work is about, so a batch that
overshoots the cap would trade a smaller request count for a larger one.

The second was repetition. For every asset under evaluation the pass asks the
token for its decimals, and then does the same for each quote token it might
route through — a value that is fixed for the life of the contract, re-read
dozens of times a tick. It is now remembered for the duration of one chain's
tick, with two deliberate limits. The memory is scoped to a single chain and
discarded afterwards, because the same address is a different token on a
different chain. And only successful reads are remembered: the decimals path
falls back to a default when it cannot read the real value, and a remembered
wrong default would silently distort every slippage figure derived from it for
the rest of the tick.

Oracle prices were **not** given the same treatment, and the reason is worth
recording. An earlier draft of this change remembered them too, which would have
saved more. But the oracle read is live rather than a snapshot of one moment,
and a tick is not instantaneous — evaluating a couple of dozen assets means
dozens of sequential requests to outside pricing services. Reusing an early
asset's price against a later asset's freshly quoted one would compute a
slippage figure across two different market moments. The consequence is
lopsided: raising an asset's tier requires the same verdict several ticks
running and would absorb a blip, but lowering it happens immediately by design,
so a single stale price could lower a tier — and the tier governs how much can
be borrowed against that asset. The saving was not worth that, so prices are
read fresh, and a test asserts they are not cached rather than leaving it to a
comment.

Measured against the profiling fixture the pass drops from 428 requests per tick
to 215, and its CPU from 207 ms to 150 ms.

Separately, the profiling fixture could not see the decimals saving at all: it
carried no ERC-20 interface, so every such read failed and fell back to the
default — silently, because the pass swallows that failure without logging it.
The fixture reported this pass as making zero errors while it failed 78 reads
per run. It now answers those reads, which is what makes the figure above a
like-for-like comparison.

Refs #1896.
