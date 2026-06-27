## Hardening — indexer grace-period reads stay anchored to the event's block (#763)

When the indexer catches up after downtime, or re-runs a block range after a
partial failure, it can process an *old* event while the chain has already moved
on. The grace-period-end the indexer computes for a marketplace prepay listing
still read the chain's *latest* state rather than the state at the event being
processed — so in that catch-up window it could record a boundary from after the
event rather than at it.

This pins that computation to the event's own block: the loan's duration and the
grace schedule are now read **at the triggering event's block**, so a later
partial repayment or a governance change to the grace schedule can't bleed into a
listing written for an earlier event. If an RPC can't serve historical state for
that block during a catch-up, the read falls back to the latest state (the prior
behaviour) rather than recording an "unknown" boundary — so the hardening never
makes a listing *worse* than before.

A related robustness fix: when an offer is created and cancelled in the **same
block**, the detail lookup used at insert time returns an empty record (the offer
is already deleted). The indexer now recognises that empty result and leaves the
row as a lightweight placeholder for the cancel handler to finalise, instead of
writing blank creator/asset fields that couldn't later be repaired.

This is determinism hardening, not a fix for any present mismatch in normal
operation. It completes the re-scan-determinism follow-ups from the #760 work. No
user-visible behaviour change in normal operation.
