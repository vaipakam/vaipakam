## Thread — Commitment-gate plumbing for ShareOfPool finalization (PR #TBD)

The recycling mesh gains the Base-side half of safe ShareOfPool
finalization: the day-close readiness gate now knows about mirror
reward-headroom **commitments**, so a mirror can be funded only once its
commitments for the day are known — never from a partial or absent set
(#1222 M3 B2-c; completion-plan §M3 hardening rule 1).

Concretely, this stage lands the **gate plumbing** on the canonical chain
and defers the mirror→Base **report** that fills it to the next mesh
stage:

- On a post-cutover (armed) day, the fast full-coverage close additionally
  waits for every expected **mirror** chain's commitments to be complete.
  The canonical chain is exempt (it is never remitted to), which also keeps
  the gate inert on a single-chain deployment. The grace window stays the
  backstop that still closes a stuck day.
- **Any** close of an armed day without a mirror's complete commitments —
  the ordinary **grace-window** close as well as an operator **force-close**
  — marks that mirror **remit-ineligible-pending-reconciliation**: its
  ShareOfPool remittance is blocked (never sized from a partial set), so
  after such a close its quotes return zero and the remittance path skips
  that chain-day until an operator reconciles the true headroom off-chain,
  clears the flag, and remits that day explicitly. Only the fast
  full-coverage close (which requires completeness) leaves a mirror
  eligible.

**Scope boundary (deliberate) — the report moves to the next stage.** An
earlier draft of this stage also carried the mirror→Base commitment
report itself (a paged, per-loan message assembled from the mirror's live
active-loan list). Review established that this is the wrong mechanism for
capturing a mirror's *day-D claimable liabilities*: the active-loan list
is the wrong set (it omits closed-but-still-claimable loans and includes
loans opened after the day), it drifts when loans open/close between the
report's page messages, and a permissionless report is grief-able. Those
liabilities are, moreover, bounded by the per-day share cap — machinery
that lives in the delivered-backing stage. So the report is designed once,
correctly, in that next stage, alongside the mirror consumption and the
delivery-acknowledged remitted clamp it is coupled to; until then the gate
here is dormant (nothing sets a mirror complete), inert on the current
single-chain testnet, and fail-safe on any armed multi-chain day. Part of
#1222.
