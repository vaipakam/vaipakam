## Thread — S10 sanctions freeze is now enforced centrally, not path-by-path (PR #<n>)

The fail-closed release of sanctioned proceeds (S10, shipped in #1006) worked
by a convention every close-out had to remember: whenever a loan terminates and
leaves a party a *deferred* payout — a repayment refund, a liquidation surplus,
an internal-match residual, a fallback distribution — that close-out had to
stamp a "frozen-claimant" marker on the current position holder so a sanctioned
holder can't quietly withdraw during an oracle outage. Because it was a
convention, it was whack-a-mole: the #1006 review kept finding the *same*
missing-marker bug on a *different* close-out path in nearly every round. This
change makes the rule structural instead of remembered.

Every loan now runs its terminal status change (to Repaid, Defaulted,
InternalMatched, or into the fallback-pending state) through a single internal
**lifecycle host** that performs the validated transition *and* records the
fail-closed marker for both the lender and the borrower position holder in one
place. The dozen close-out paths that previously each stamped their own markers
now route through that host, so the marker can no longer be forgotten by a new
path — adding a terminal transition automatically gets the freeze. Observable
behaviour is unchanged for everyone: a clean holder is never frozen, a
genuinely-flagged holder is frozen exactly as before, and the transition rules
themselves are identical. (The host resolves the *current* holder the same way
the old per-site code did, so a transferred position still freezes the right
wallet.)

To guarantee the rule can never silently regress, a new pre-deploy /
continuous-integration guardrail scans the contract source and fails the build
if any close-out writes a deferred claim (or a mid-loan held-for-lender credit)
without a matching frozen-claimant register beside it. The guardrail carries a
small, reasoned allow-list for the genuine exceptions (a helper whose caller
does the register, or a bookkeeping row that carries no real payout). While
wiring the guardrail up it surfaced one pre-existing gap — the borrower
obligation-transfer top-up funded the lender through a non-locking deposit with
no marker, which could both brick the transfer for a flagged lender and leave
the credit releasable fail-open — and that gap is closed here as well.

This lands the deferred-claim half of the central-enforcement design
(Invariant A). The remaining half — the same structural treatment for *inline*
holder payouts and the collateral-sale settlement path (Invariant B) — is
tracked as a follow-up. Relates to #998; implements
`docs/DesignsAndPlans/S10CentralEnforcement.md`. Closes #<n>.
