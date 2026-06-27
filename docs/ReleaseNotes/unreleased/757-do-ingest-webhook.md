## Thread — Near-real-time indexer ingest: webhook trigger + per-chain Durable Object (#757)

The chain indexer fed D1 from a once-a-minute cron that processed **one chain
per tick**, round-robin, so a given chain only refreshed every *N* minutes (N =
number of indexed chains). After a repay / match / default the dapp could show
stale state for minutes.

This adds a near-real-time ingest path **without weakening the decentralized
fallback** — every layer still degrades to the previous behaviour.

What's new:

- **A per-chain ingest Durable Object** is now the single serialized writer for
  a chain. The cron and the new webhook both forward a "this chain changed, up
  to block H" hint to that chain's DO, which runs the existing scan. Because all
  ingest for a chain funnels through one object guarded by an explicit
  single-flight, two scans never overlap — so the existing indexing logic stays
  correct unchanged. The cron now pings **every** chain's DO each minute (rather
  than one per round-robin tick), so even without the webhook, baseline
  staleness drops to about a minute.
- **An inbound chain webhook** (`POST /hooks/chain-event`). A provider (Alchemy)
  watching the contract POSTs when a matching event is mined; the indexer
  HMAC-verifies the delivery, caps the body, de-duplicates, and forwards the
  hint to the chain's DO. On a fast-finality chain the change lands in D1 within
  seconds of the block being finalized — the dapp keeps polling, but now polls
  fresh data.
- **Honest freshness, never speculation.** The DO only ingests blocks the chain
  reports as *safe* (finalized), so it never shows state that could be reorged
  away; a block above the safe head is waited for, not cached. The webhook is a
  latency optimization only — a missed or failed delivery, or an unconfigured
  chain, simply falls back to the cron, with no user-facing error.

The webhook and the Durable Object are **off** until an operator provisions the
signing key + the provider webhook; until then the indexer runs exactly as
before. No contract change, no new on-chain events.

(Follow-ups tracked separately: making the marketplace-listing republish
replay-safe under the new ingest, and a couple of lower-severity re-scan
determinism hardenings.)
