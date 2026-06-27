## Hardening — indexer reads stay anchored to the event's block (#763)

When the indexer catches up after downtime, or re-runs a block range after a
partial failure, it can process an *old* event while the chain has already moved
on. A couple of the indexer's on-chain lookups still read the chain's *latest*
state rather than the state at the event being processed — so in that catch-up
window they could record values from after the event rather than at it.

This pins those remaining reads to the event's own block:

- The offer detail fetched when an offer is first created now reads the offer's
  **creation-time** state, so a catch-up that runs after the offer was later
  modified or cancelled can't persist the wrong (post-creation) fields.
- The grace-period-end computed for a marketplace prepay listing now reads the
  loan's duration and the grace schedule **at the triggering event's block**, so
  a later partial repayment or a governance change to the grace schedule can't
  bleed into a listing written for an earlier event.

This is determinism hardening, not a fix for any present mismatch — the offer
insert already ignored re-runs, and the grace inputs are effectively stable. It
completes the re-scan-determinism follow-ups from the #760 work, bringing every
event-triggered read onto the same block-pinned footing ahead of the
near-real-time ingest path. No user-visible behaviour change in normal operation.
