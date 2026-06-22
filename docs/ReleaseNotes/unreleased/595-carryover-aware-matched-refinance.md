## Thread — Carry-over-aware matched refinance (PR #<n>)

Refinance-tagged carry-over offers can again be filled through the
range-orders / partial-fill matcher (`matchOffers`), not only by direct
accept. PR #593 had disabled them there after two bugs were found
(an uncollateralized-loan window, and a collateral-divergence that made
valid offers unfillable); this re-enables the path safely, against a
design spec that passed a four-round adversarial review.

The key idea is that a refinance is intrinsically all-or-nothing — one old
loan, one collateral lien, one retag — so a carry-over offer is admitted to
the matcher only as a single full (AON) fill. That makes the fill reach the
existing atomic retag in the same transaction (no uncollateralized window),
and it keeps the model coherent (a partial fill would create more than one
replacement loan for a single old lien). The matched collateral is pinned to
the carried amount and the risk check runs on that pinned value, so a lender
asking for less collateral than the loan already carries no longer makes the
offer unfillable; a lender asking for *more* than the carried amount is
cleanly rejected (carry-over pledges no fresh collateral to top up).

Crucially, the matcher's admission test is a faithful mirror of every
precondition the atomic accept-and-refinance path enforces — target still
active, offer creator still the current borrower-position holder, the amount
still equal to the loan's outstanding principal, auto-refinance caps and the
kill-switch satisfied, no pending periodic-interest settlement, no live
swap-to-repay intent, and the strict same-key lien retag still possible — so
a keeper's preview never reports a match that would then revert on-chain. A
carry-over offer's amount is frozen while it stays refinance-tagged (cancel
and re-create to retarget), and a carry-over offer is all-or-nothing
single-value from creation. Closes #595.
