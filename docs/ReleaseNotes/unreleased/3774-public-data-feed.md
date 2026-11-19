## Indexer — public data feed, v1

The indexer now serves a public, versioned, read-only data feed under `/public/v1`, with its documentation in `docs/PublicDataFeed.md`. It is a fixed list of ten existing reads: the open offer book, recent offers, open offers by pair and term, offer totals, one offer, active and recent loans, loan totals, rate candles and one loan. Each is answered by the same handler the app uses, so there is one copy of every read.

Each answer is wrapped in an envelope stating the feed version and the chain. It also states the block the indexer had reached when the read began, which is read before the data so it is a floor. It says where the figures come from and what they leave out, and carries a notice that no figure is the platform's rate, a benchmark, advice or an offer. A request to the bare prefix returns the feed's own catalogue.

Nothing kept privately for a wallet is served. The per-wallet convenience reads (claimables, notifications, loans by participant) are left out of the feed, and any path outside the list answers 404.

Each route lists the parameters it takes; only those and the chain reach the handler, and any other is refused with a 400 naming it. Tests pin each route's parameters and field names (a field may be added, never removed or renamed) and record the tables each route reads, none of them keyed to a wallet.

A new per-IP limiter, `PUBLIC_FEED_RATELIMIT` (120 a minute, one budget across every feed route), is taken before any read. Cloudflare counts it per location, so the figure is approximate. A refusal states the limit and the period and carries Retry-After. Like every limiter here it fails closed.

Advances #3774. Design: `docs/DesignsAndPlans/FeaturesOverExistingPartsDesign.md` section 8.

> Caveat: the new rate-limit binding is declared in `wrangler.jsonc`; it takes effect with the indexer's next deploy.
