## Indexer — public data feed, v1

The indexer now serves a public, versioned, read-only data feed under `/public/v1`, with its documentation in `docs/PublicDataFeed.md`. It is a fixed list of ten existing reads: the open offer book, recent offers, markets, offer totals, one offer, active and recent loans, loan totals, rate candles and one loan. Each is answered by the same handler the app uses, so there is one copy of every read.

Each answer is wrapped in an envelope stating the feed version and the chain. It also states the block the indexer had reached when the read began, which is read before the data so it is a floor. It says where the figures come from and what they leave out, and carries a notice that no figure is the platform's rate, a benchmark, advice or an offer. A request to the bare prefix returns the feed's own catalogue.

Nothing kept privately for a wallet is served. The per-wallet convenience reads (claimables, notifications, loans by participant) are left out of the feed, and any path outside the list answers 404.

A new per-IP limiter, `PUBLIC_FEED_RATELIMIT` (120 a minute), is taken before any read. Like every limiter here it fails closed. The figure is the builder's proposal and has been raised with the owner, as section 13 item 4 of the design asks.

Advances #3774. Design: `docs/DesignsAndPlans/FeaturesOverExistingPartsDesign.md` section 8.

> Caveat: the new rate-limit binding is declared in `wrangler.jsonc`; it takes effect with the indexer's next deploy.
