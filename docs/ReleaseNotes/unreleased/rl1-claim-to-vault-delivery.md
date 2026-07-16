## Thread — RL-1: interaction-reward claim-to-vault delivery (PR #TBD)

The VPFI recycling loop-closure design (`VpfiRecyclingLoopClosureDesign.md`,
ratified 2026-07-16) found the reward loop open at the distribution end:
every claimed interaction reward paid straight to the claimant's wallet and
exited the sink system entirely unless the user manually re-deposited it.
RL-1 closes that leak. A direct wallet (EOA-style) claim now delivers the
payout into the claimant's own per-user vault by default, where it
immediately counts toward protocol-tracked balance and VPFI fee-discount
tier standing — the Jupiter-ASR-style "reward re-enters the system at
claim" pattern, without any lockup (vault withdrawal stays available at all
times).

The delivery is powered by a new Diamond-funded vault credit primitive: the
Diamond pays the reward from its own pre-funded balance directly into the
claimant's vault proxy and then runs the same recording tail a normal
deposit runs (tracked-balance increment plus a post-mutation tier rollup),
so the credit is never clamped out as unsolicited dust. The tier rollup on
this path is deliberately broadcast-free — a claim never inherits the
cross-chain tier push's failure modes; the push rides the user's next
balance mutation. Delivery never reduces claim availability: if the vault
credit cannot complete (no vault yet, a pending mandatory vault upgrade, or
a tier-bookkeeping failure), the whole vault-side unit rolls back atomically
and the claim pays the wallet exactly as before — never a double-pay, never
partial vault state.

Contract callers keep the raw wallet-style transfer they always observed
(the aggregator adapter and backstop vault forwarders are additionally
hardwired to it), and every caller can pick the venue explicitly via a new
explicit-delivery claim entry — so a Safe or account-abstraction wallet can
opt in to vault delivery. A new per-claim delivery event (stamped with the
claim day) makes vault-delivered claims observable for the upcoming RL-2
loop-closure dashboard metric. Functional spec §4 gains the "Claim delivery
venue" rules in the same diff. Follow-ups per the design's §9 plan: RL-2
(loop-closure metric + vault-debit observability event), RL-3 (365-day
claim horizon), RL-4 (allocation register, Phase C′), RL-5 (absorption
bootstrap sequencing).
