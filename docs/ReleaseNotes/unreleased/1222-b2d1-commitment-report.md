## Thread — Mirror→Base commitment report + remit-gate retiming (PR #TBD)

The recycling mesh gains the mirror→Base **commitment report** — the piece
the B2-c gate was waiting for — and, in building it, corrects where that
gate belongs (#1222 M3 B2-d1; completion-plan §M3; design record
Vpfi1222B2dDeliveredBackingDesign.md, esp. §2b).

**What a mirror now reports.** For every armed day, a mirror computes its
per-side *day-D claimable liability*: each participating user's day-D
reward demand, individually clamped by the per-day share cap net of
anything already paid, summed per side. The operator's keeper feeds the
users in batches, but the mirror recomputes every figure from its own
records — the keeper can delay a report, never distort one. Completeness
is proven by **demand conservation**: the submitted units must exactly
exhaust the day's per-side interest totals, so a missing user keeps the
day incomplete (delays, never understates). Each user is accepted at most
once per day and side, in ascending order; submissions are restricted to
the keeper so a third party cannot wedge a day with a deliberate partial
submission, and an operator valve can wipe a day-side for full
resubmission while the report is unsent. Once both sides complete, the
report is dispatched to the canonical chain exactly once (a failed send
rolls back and stays retryable), where it is stored per chain-day —
idempotently against duplicate delivery — as the input the
delivered-backing remittance clamp will read.

**The retiming (supersedes part of B2-c's gate placement).** Building the
report surfaced a circular dependency in the planned wiring: a day's
liability prices from the per-side caps and funding composition that the
canonical chain computes *at that day's finalization* and then broadcasts
— so the report can only ever arrive **after** finalize, while the B2-c
gate had finalization *waiting for* the report. Left as-was, every armed
day would have stalled into the grace backstop with all mirrors marked
remit-ineligible, permanently. The plan's goals (never fund from a
partial set; a late report delays, never zeroes; no permanent
underfunding) are preserved at the only causally-possible site:

- Finalization readiness no longer consults commitments; an armed day
  fast-closes on full interest coverage, as before the gate.
- What waits for the report is the chain-day's **ShareOfPool remittance**
  (the next stage's gate + clamp consume the stored liabilities).
- **Remit-ineligible-pending-reconciliation** now marks the one genuinely
  poisoned case: an armed day finalized with a chain's interest
  contribution zeroed out of the denominator. That chain's late report is
  still accepted — giving the operator the exact liability figure to size
  a manual, evidenced remittance before clearing the flag. Chains whose
  interest reported normally are never marked.
- A mirror cannot dispatch before its own day's totals are final (the
  day's funding broadcast is the on-chain precondition), so a quiet-looking
  not-yet-closed day can never ship an irreversible zero report; unarmed
  days are not reportable at all.

**Keeper.** A new mirror-side pass drives the flow end to end: it
enumerates candidate users from the indexer's loan ledger (a superset that
keeps loans closed after the target day — the live active-loan list is the
wrong set), filters each user's actual day coverage against the chain,
submits ascending batches resuming from the on-chain cursor, and
dispatches the report when the day completes. Dark until both the master
keeper switch and a dedicated flag are set, and the keeper account holds
the on-chain keeper role.

The mirror-side consumption, the delivered-backing ledger, and the
remittance clamp that reads these stored liabilities land in the next
slices. Part of #1222.
