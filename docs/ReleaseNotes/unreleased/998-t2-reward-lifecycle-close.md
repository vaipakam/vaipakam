## Thread — Spec-conformance Tranche 2: interaction-reward lifecycle close-out (#1002, #969 / PR #<n>)

The second tranche of the #998 spec-conformance fixes closes two ways the
interaction-reward accrual could pay for interest that was never really earned.

Previously a reward entry became claimable purely because the calendar passed
the loan's contracted maturity and the global reward denominator for those days
finalized — independent of whether the loan had actually closed. A borrower who
intended to default could therefore wait past maturity, claim the full-window
reward, and only then default, side-stepping the specification's rule that
borrower rewards accrue only on a clean repayment and that neither side can
claim while the loan is still live. Each reward entry now carries an explicit
"closed" marker that is set only when the loan is actually closed (or the lender
position is sold); a reward is claimable or sweepable only once that marker is
set. The entry's day-window remains the accrual bound, but it no longer doubles
as the "is the loan over?" signal.

Second, the early-close paths that flip a loan to Repaid without going through
ordinary repayment — direct preclose, offset completion, and refinance — did not
tell the reward system the loan had closed, so both parties' entries kept
accruing to the original contracted end date. After a refinance this
double-counted the same principal because the new loan registered its own fresh
entries while the old loan's stayed open. These paths now close the old loan's
reward entries at the moment they settle it (a clean close — the borrower repaid
or rolled over, and the exiting lender was paid in full, so neither forfeits).
The obligation-transfer path (which keeps the loan open under a new borrower)
instead re-points the borrower's reward entry to the incoming borrower, so the
party who left the loan can no longer claim the rewards the continuing
borrower's interest earns.

Because the preclose facet is already at the contract-size ceiling, the reward
bookkeeping for those paths runs through a small internal hook rather than being
inlined; the hook is best-effort by design, so reward accounting can never block
a borrower from reclaiming their collateral on a preclose.

A separate, narrower reward finding — that the per-user reward cap is currently
enforced over each entry's whole window rather than strictly per calendar day
(#1008 / S13) — is intentionally deferred to its own follow-up, because a correct
per-user-per-day cap needs a dedicated accounting design. It is a mild
over-relaxation, not a safety issue, and nothing in this change alters it.

Closes #1002 and #969 under the #998 umbrella. A known follow-up: on an
obligation transfer the re-pointed entry still reflects the original loan's
interest rate and window rather than the re-originated term.
