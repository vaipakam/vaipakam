# Release Notes — 2026-06-27

A focused day on **indexer correctness and freshness**. The #757 near-real-time
render epic shipped end-to-end — a webhook + per-chain Durable Object ingest
path that drops baseline staleness to about a minute (and to seconds once an
operator enables the webhook), built so every layer still degrades to the prior
decentralized behaviour. Alongside it, the three re-scan-determinism follow-ups
from the #760 review landed, so a catch-up after downtime can no longer
mis-record a loan. All of the below is off by default until an operator opts in;
no contract changes.

## Thread — Indexer: re-scan-idempotent loan/offer handlers (#760)

A correctness fix to the chain indexer's projection of on-chain state into D1.

The indexer's per-chain scan writes its domain rows **before** it advances its
block cursor, so a tick that fails partway (after writing some rows, before the
cursor moves) makes the next tick **re-scan the same block range**. Two handlers
computed their write by reading the *current* D1 row and applying a **delta** to
it, which double-applies under that re-scan:

- An **internal-match** settlement read each loan's current principal/collateral
  and *subtracted* the matched amounts — a re-scan subtracted them again,
  corrupting the loan's principal and collateral.
- An **offer match** computed the filled amount from the current row's maximum —
  if the offer was also modified in the same batch, a re-scan computed it
  against the wrong (post-modify) base.

Both now write **absolute** values read **from the chain, pinned to the exact
block of the event being processed**, so re-applying the same event sets the
same value — the projection converges no matter how many times a range is
re-scanned. If the chain read fails, the row is left untouched for the next scan
to heal rather than committing a fallback value.

This is a latent bug today (partial-tick failures are rare) and changes no
intended behaviour — loan balances and offer fills were always meant to be
exact; this makes the indexer reliably reflect that. It is also the prerequisite
for the near-real-time render work (#757), which raises how often a range is
re-scanned.

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

Marketplace-listing republish is already replay-safe under the new ingest (the
republish marker only commits against the exact order it published, so a
concurrent re-price can't be falsely marked published), and the per-chain ingest
cursor only ever advances forward — both are part of this change. The one
remaining follow-up, tracked separately, is routing the periodic
marketplace-republish sweep per-chain through the Durable Object; it is now an
efficiency nicety rather than a correctness gate.

## Fix — indexer no longer mis-labels a partially-matched-then-repaid loan (#762)

The indexer projects each loan's lifecycle status into its read database. One
rare ordering produced a wrong label: if a loan was *partially* settled by an
internal match and then *fully repaid* (or swap-repaid) later in the **same
block**, the indexer could record the loan as "internally matched" when it was
actually repaid.

The cause was an inference: the internal-match handler decided a loan was fully
matched by checking whether its principal had reached zero at the end of the
block. But a same-block repay also drives the principal to zero — so the handler
mistook the repay's effect for the match's, stamped the loan "internally
matched," and the later repay update (which only corrects loans still marked
active) couldn't fix it.

The handler now reads the loan's **actual on-chain status** at that block (the
same lookup it already performs returns it) instead of guessing from the
principal, and records exactly that status: internally matched, repaid, settled,
or defaulted. So whatever truly closed the loan in that block is what the label
reflects — including the case where a claim-time match is **settled in the same
block** (previously that too could be mislabelled, and would have been left
stuck "active" by a naive fix).

User-visible effect: in the (uncommon) same-block cases above, a loan now shows
its true terminal state (repaid / settled) rather than "internally matched" or a
stuck "active". No balances were ever affected — this was a status-label fix
only. Closes the last of the re-scan-determinism follow-ups raised during the
#760 review.

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
