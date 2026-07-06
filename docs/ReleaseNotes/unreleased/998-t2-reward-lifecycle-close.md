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
reward entries at the moment they settle it. The exiting lender is always paid in
full and never forfeits; the borrower side is clean only when the close happens
within the loan's grace window — a late preclose or refinance (past grace, before
anyone triggered default) is treated as a non-clean close and forfeits the
borrower reward, the same way an ordinary post-grace close does. The
obligation-transfer path (which keeps the loan open under a new borrower and a
re-originated term) splits the reward windows at the transfer point: the exiting
borrower and the unchanged lender keep what they earned before the transfer, and
fresh entries covering the continuing loan are opened under the new rate and
duration, so the incoming borrower only earns from the transfer forward and never
inherits the previous borrower's history.

As a safety net, a reward entry also becomes claimable once its loan simply
reaches a terminal status even if the closing path did not explicitly notify the
reward system, so no terminal path can ever freeze a reward forever; while a loan
sits in a liquidation/default status that fallback also routes the borrower's
reward to treasury rather than paying it out, and the permissionless forfeit
sweep is guarded so it can only ever touch genuinely-forfeited entries (never a
payable one). Offset completion now applies the same in-grace/late clean-vs-
forfeit rule as the direct-preclose and refinance paths.

The complete, precise close-out of every terminal path is deliberately scoped as
a dedicated follow-up rather than rushed here: explicitly notifying the reward
system from the internal-match-liquidation, prepay-sale, and other close paths
(so the borrower forfeit is durable across a later Settled transition and the
accrual window is trimmed to the real close day), and re-anchoring reward entries
to the current position-NFT holder before an obligation transfer or offset
completes. Those paths are no worse than before this change — where a path is not
yet explicitly wired, its rewards remain claimable exactly as they were — and the
platform is pre-live, so there is no historical reward state to migrate. This
change lands the claim gate, the ordinary-close wiring (repay, preclose,
refinance, and the existing liquidation/default paths), and the safety net; the
remaining precision work is tracked under the same umbrella.

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
