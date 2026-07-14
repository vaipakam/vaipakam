# RPC read-diet PR 0 — indexer push-completeness + rail-health metadata

Prerequisite slice of the Alpha02 RPC read-diet design
(docs/DesignsAndPlans/Alpha02RpcReadDietDesign.md §9, PR 0). Before the
app can stop blanket-refetching chain data every block (PR A), the
indexer's realtime push signal has to name every class of change the
affected views depend on, and the rail has to report its own freshness.
This PR closes the gaps found in that design's review:

- **New `ownership.changed` push key.** A position NFT changing hands — a
  secondary trade, a claim burning a position, a borrower-obligation
  migration — previously produced at most an activity-feed push, so
  holder-keyed views (My positions, Claims, the detail page's owner
  gates) learned about it only from polling. The ingest scan now counts
  ownership re-points and broadcasts them under a dedicated key, and the
  connected app maps that key onto every holder-keyed view.
- **Entitlement changes now push.** Data-only loan mutations with no
  status transition — a partial repayment, a partial internal match, the
  partial rescue of a pending-fallback loan (which parks funds a lender
  can later claim), a collateral top-up, an extension, a
  periodic-interest advance — previously broadcast nothing beyond the
  activity feed. They now ride the existing loan-update key, and that key
  additionally refreshes vault balances (settlement and interest events
  are exactly the class that moves escrow into a party's vault).
- **Rail-health metadata.** The push channel's greeting now reports how
  recently ingestion advanced and the expected scan cadence; every
  successful scan is followed by a small cursor heartbeat (previously a
  no-change pass sent nothing, making a quiet chain indistinguishable
  from a stalled rail); and the public stats endpoints report the same
  cadence for deployments without a socket. A failed scan deliberately
  sends no heartbeat so a broken rail can never look healthy. PR A's
  signal-gated polling consumes these; until then the app ignores them.

No behaviour changes for existing clients: unknown push keys and unknown
frame kinds were already ignored, so the indexer and app halves deploy
independently. Observing the new `ownership.changed` frame on the live
rail is the gate before PR A ships (design §7c).
