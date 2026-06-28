## Indexer — per-chain marketplace-republish sweep on the real-time ingest path (#765)

When a loan's collateral becomes re-listable, the indexer publishes a
marketplace listing at ingest time; a periodic **sweep** is the safety net that
re-tries any listing whose inline publish failed (e.g. a transient marketplace
outage). Until now that sweep always ran globally on the cron tick, across every
configured chain at once.

With near-real-time ingest enabled, each chain is processed by its own
single-writer ingest object. This change moves the sweep onto that path: each
chain now runs its **own** sweep at the end of its catch-up, right after it has
finished writing that chain's listings — so the retry runs on the freshly-written
rows and is naturally serialized with the chain's own work instead of racing it.
The global cron sweep now runs **only** on the legacy (non-real-time) path, so a
listing is never swept twice.

There is no change to which listings get republished or when a user sees them —
this only relocates the existing retry so it composes cleanly with the real-time
ingest path. The behaviour is gated behind the same operator flag as the rest of
the real-time ingest work; with that flag off, the cron sweep runs exactly as
before.
