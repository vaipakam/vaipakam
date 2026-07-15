## Thread — indexer: the last four unbounded routes get honest caps (PR #TBD)

The #1247 pagination audit's second batch closes the four indexer
routes that could still scan or return without bound. Each one now
serves a fixed ceiling and says so — every response carries a
truncation flag, so a client can tell "this is everything" from "depth
was dropped", the same shape the claim-candidates route shipped with.

What changed, per route: the legacy claimables read now serves the two
hundred newest terminal loans instead of a wallet's entire terminal
history (the defi Claim Center that consumes it layers its own
on-chain verification, so the cap only bounds discovery). Market
discovery serves the two hundred deepest markets, deepest first — the
distinct pair/tenor space is spammable with dust offers, so real
markets stay reachable while fabricated ones fall off the tail. The
executed-rate candle history, whose "all" range previously had no
bound at all, now scans the newest ten thousand fills — a truncated
chart loses its oldest candles, never recent ones. And the signed
order book, which already capped each side at its hundred best-priced
rows, now admits when it dropped depth instead of truncating silently.

The signed book also gains a wallet-scoped read, and the Rate Desk's
open-orders panel uses it: a maker's own resting orders are now
fetched scoped to their wallet, so an off-market order that better-
priced depth pushed out of the public window is still visible and
cancellable by its owner — previously it simply vanished from the
desk while remaining live and fillable.

Refs #1247.
