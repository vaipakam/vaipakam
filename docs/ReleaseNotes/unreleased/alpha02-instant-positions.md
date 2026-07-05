## Thread — My positions reflect transactions instantly (chain-authoritative own positions)

Posting an offer or opening a loan used to take 30–60 seconds to show
up under My positions: the list was fed entirely by the indexer, whose
ingestion runs on a once-per-minute schedule, and nothing in the UI
admitted the wait. The wallet's own positions are now discovered from
the chain itself — open offers it created and loan positions it
currently holds (side decided by which position token the wallet
holds, so bought or transferred positions surface for their new
holder) — which makes a just-confirmed transaction visible within a
block. The indexed history still contributes what the chain can no
longer enumerate: closed positions whose position tokens are burned
and listings received by transfer.

Live chain state also now outranks stale indexed snapshots in both
directions: a just-cancelled offer can no longer linger looking
cancellable (the chain's terminal verdict suppresses the lagging
indexed row), and a loan whose position token the wallet no longer
holds no longer ghosts in the list. Received/bought open listings are
chain-discovered too.

Availability improves with honesty preserved: an indexer outage no
longer blanks the page (live current positions still render), but the
page then shows a plain warning that a data source is degraded —
never a confident partial list. The full unavailable state appears
only when both the chain and the indexer fail. The Activity page,
which remains indexer-fed by nature (event history has no chain
view), refuses to render without the indexed loan list its
participation filter needs, and carries the market lists' self-gating
staleness note on empty and non-empty feeds alike.

Follow-up tracked separately: push-based indexer ingestion (webhook →
immediate scan) to shrink the freshness gap for everyone else's views
of the market, not just one's own positions.
