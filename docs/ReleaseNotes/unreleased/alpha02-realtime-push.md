## Thread — alpha02 subscribes to the indexer's realtime push channel

The retail app now listens to the indexing service's per-chain push
channel (the same one the pro dapp already uses): after each ingest
write, the service broadcasts a tiny "this slice changed" signal and
the app immediately refreshes the matching indexed views — the offer
book, the wallet's listed positions, loan rows, claimables and the
activity feed. Other people's actions (a new offer appearing on the
book, a repayment landing) now reflect within seconds of ingestion
instead of on the next 30–60 second poll.

The channel is additive and trust-preserving: frames carry only a
change signal, every refresh still goes through the normal read
surface, the regular polling cadence keeps running underneath as the
fallback, and a missing or disabled channel leaves the app exactly as
fresh as it was before. Bursts coalesce into a single refresh and a
hidden tab defers its refresh to one pass on focus, so the push never
drives background traffic.
