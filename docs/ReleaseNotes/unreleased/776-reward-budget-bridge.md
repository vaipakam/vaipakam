## Cross-chain reward-budget bridge — mirror claims are now funded (#776)

Interaction rewards accrue globally but are claimed on whatever chain a user
is on. Until now the cross-chain mesh finalized each day's accounting and
broadcast the global denominator to every mirror chain — which opened the
local claim gate — but nothing ever moved the VPFI a mirror needs to pay
those claims. A mirror user could pass the gate and then have the claim
revert at the token transfer because the mirror Diamond's VPFI balance was
empty. This was finding #00006 ("mirror interaction reward budgets are not
bridged during finalization").

#776 closes that gap with an on-demand Base→mirror reward-budget bridge over
Chainlink CCIP, deliberately kept off the finalization hot path (bridging
value automatically inside every finalization would drag in CCIP lane rate
limits, native-fee funding, and per-day replay/recovery). Base — which holds
the whole 69M interaction pool and every input — computes each finalized
day's per-chain VPFI slice and, when an operator or the keeper calls for it,
remits that slice to the mirror. A per-mirror receiver validates and forwards
the VPFI into the mirror Diamond, and the existing claim path simply pays out
from the now-funded balance. Sends are batched over days, idempotent (a retry
skips already-sent days), and bounded by a per-call cap so each send stays
under the live CCIP lane bucket.

The accounting is conservative on both sides: what Base has remitted to
mirrors is reserved against Base's own claim payouts, so remittances plus
Base-local claims can never jointly exceed the 69M pool; and a day's slice is
only remittable for chains that were actually folded into that day's finalized
denominator, so an operator reshuffling the expected-chain set mid-day can't
cause an over-send. Every cross-chain contract in the flow carries the
guardian pause lever and rotates to the governance timelock at mainnet
handover.

Delivered across six PRs: the design (#888), the Base-side sender (#889), the
per-mirror receiver plus deploy/CCIP wiring (#916), the end-to-end proof +
documentation (#923), a fee-quote helper that dry-runs a batch's exact
cross-chain fee (#924), and the keeper automation that drives remittance without
operator intervention (#925). An end-to-end test demonstrates the fix directly —
a claim on an unfunded mirror reverts, and the identical claim succeeds once
the budget has been remitted and received.

Two follow-ups are tracked as separate cards, not gaps in this work: #917
(a bounded on-chain reclaim path for the rare terminal-wind-down case where a
mirror is over-funded relative to what its users ultimately claim — today that
surplus safely funds subsequent days' claims and any true residual is a
governance action, because the mirror Diamond's VPFI is commingled with LIF
custody and treasury) and #918 (a deploy-time pre-flight that asserts the
reward-budget CCIP lane capacity clears the largest single-day slice, since a
day is remitted atomically).

Closes #776. The bridge is code-complete but stays dark until an operator
provisions the reward-budget CCIP lane, deploys and registers the per-mirror
receiver, authorizes the keeper on-chain, and turns the automation on.
