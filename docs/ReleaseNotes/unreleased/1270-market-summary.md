## Thread — market discovery is now pre-computed, not aggregated per request (PR #TBD)

The market list behind the Rate Desk's pair and tenor picker used to
be computed from scratch on every request: the indexer grouped every
active offer and signed order on the chain into markets, ranked them,
and only then clipped to the two hundred deepest. The response was
already capped, but the work wasn't — a maker fabricating thousands
of dust markets could keep every discovery request expensive, the
resource-exhaustion path the pagination audit flagged and the
previous release consciously deferred.

Discovery now reads a summary table the indexer maintains as data
changes: each ingest pass recomputes the summary only for markets its
window actually touched — new or changed offers, signed-order
lifecycle flips, and orders whose time limits lapsed during the
window — and posting a gasless signed order updates its market's row
immediately, so a brand-new signed-only market is discoverable the
moment it's posted. Serving the list is a single indexed read with no
aggregation at all, and every number is recomputed exactly from the
source rows whenever a market is refreshed, so the summary can't
drift from reality through counting mistakes.

One freshness nuance: a market whose only order quietly expires by
clock (with no other activity anywhere) leaves the list on the next
ingest pass rather than the very next request — a lag of seconds, the
same order of freshness the desk's own polling already works at.

The deploy includes a one-time backfill so the list is fully
populated the moment the new code serves it.

Closes #1270.
