## #1222 M3 B2-d2 — delivered-backing remit ledger: reservation → ack lifecycle, the Σcommitments remit gate + clamp, and the zeroed-chain manual-budget path

Stage B2-d2 of the recycling completion programme (plan #1348 §M3; umbrella
#1349; design record `Vpfi1222B2dDeliveredBackingDesign.md` §2d/§3). B2-d1
gave Base each mirror's day-level claimable-liability report; this stage makes
that report actually govern the money, and closes the loop on whether a
remittance was ever *delivered*.

**The remit gate and clamp are live, identically at every remittance
surface.** On an armed day, Base remits to a chain only once that chain's
commitment report is complete (a late report delays the day, never zeroes
it), and the amount is the uncapped slice bounded by the chain's reported
liability — Base never sends a mirror more than the mirror itself attested it
can pay out. The send and both planning quotes share one computation, so a
quoted batch is exactly what the send moves. The withheld surplus stays where
it was (fresh in the emission pool, recycled in the bucket), and the day's
finalization-time funding commitments are retired in full at terminal close —
including an explicit release of the withheld residual's reservation, so a
clamped day can never leave availability permanently encumbered. A day whose
whole slice clamps to zero still closes cleanly with nothing dispatched.
Pre-cutover days are untouched.

**Every remittance now reserves before it dispatches, and finalizes only on
delivery.** The send records a reservation (destination, amount, funding
decomposition, the days it closed) under a fresh reservation id that travels
in the message; the cross-chain transport's message id is bound to the
reservation at send time — the operator's entry point when reconciling from
observed delivery evidence. On delivery the mirror records a receipt and
anyone may trigger its acknowledgement (content comes from the mirror's own
receipt, the caller only pays the fee, and a lost ack is recovered by simply
re-sending). Base finalizes each reservation exactly once. Two evidenced
operator valves cover the terminal edge cases: force-finalize for a
delivered-but-ack-lost reservation, and release for a message that can
verifiably never execute — release re-opens the days and restores the
counters and commitments, but deliberately does not re-credit the recycle
bucket (the tokens sit in the transport's custody, not the platform's; a
late ack after a wrong release is loudly surfaced).

**The zeroed-chain manual-budget path exists now** (the B2-d1 review
deferral): a day force-finalized with a chain zeroed out of the interest
denominator can be funded by an operator-sized manual send that anchors on
the still-set remit-ineligible flag as its evidence, draws fresh under the
lifetime emission cap, and reserves + acknowledges through the same ledger
as any remittance.

Receipts are bound to the canonical deployment itself (the mirror records
the authenticated sender, the acknowledgement echoes it, and the canonical
side accepts only acknowledgements naming itself), so even a same-chain
canonical redeployment can never let stale-era receipts finalize the new
deployment's reservations — while a delivery from the new deployment
supersedes a stale same-numbered receipt so nothing is ever wedged.

**Keeper + indexer.** A new keeper pass scans Base's dense reservation
sequence (terminal-prefix frontier plus a rotating cursor, so one stuck
delivery can never hide later reservations) and drives each landed
delivery's ack (rate-limited per reservation); the remittance pass now
plans through a batch view that also surfaces clamped-to-zero days needing
closure, and extends its window over the armed range so late-completing
reports are still funded; the indexer persists operator reconcile events so
the mirror commitment-report pass re-surfaces reconciled old days outside
its normal scan window. Operator note: apply D1 migration
`0044_keeper_remit_ack.sql` before enabling the passes (same
`REWARD_REMIT_ENABLED` / `REWARD_COMMIT_ENABLED` arming as before — nothing
new to flip).

Everything ships dark until the governor arming ceremony; on a single-chain
deployment the entire surface is inert.
