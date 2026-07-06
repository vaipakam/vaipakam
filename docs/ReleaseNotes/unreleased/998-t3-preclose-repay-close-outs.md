## Thread — Spec-conformance Tranche 3: fallback cure + mode-aware refinance + replacement-term rounding (#1000, #1003, #1032 / PR #<n>)

Three close-out fixes from the #998 spec-conformance review.

A borrower whose loan has slipped into the collateral-fallback state (because a
time-based default fired and the automated sale couldn't execute) is promised, in
two places in the specification, that they may still fully repay to cancel the
fallback and reclaim their collateral before the lender's claim executes.
Previously that cure was unreachable: full repayment was blocked once the loan
passed its grace window, but the fallback state only ever exists past the grace
window, so the cure always reverted and the borrower was forced into the fallback
premium the cure exists to avoid. Full repayment now cures a fallback loan even
past grace — the cure payment makes the lender whole (principal plus interest,
including grace-period accrual, plus late fees), so there is no lender-side harm.

Second, refinancing a loan now settles the exiting lender's interest the same
mode-aware way an ordinary early repayment does, instead of always charging the
full contracted term. If the loan was written on full-term-interest terms the
exiting lender still receives their full-term maximum and is strictly whole; but
if the loan was written on pro-rata terms, the borrower now pays only the
interest actually accrued, rather than being penalised with the full term simply
for refinancing rather than repaying directly. The two "early close" doors —
direct preclose and refinance — no longer disagree, and any interest already
settled through the periodic path is credited so it is never charged twice.

Third, the obligation-transfer and offset flows re-originate the loan with a
fresh start time, and their replacement-term check compared whole-day remaining
counts. Because the elapsed time was rounded down, the remaining count rounded
up, letting a replacement term carry the new maturity up to a day past the
original loan's maturity and quietly extend the lender's exposure. Those checks
now compare the actual maturities with second precision, so a replacement term
can never mature later than the loan it replaces.

Closes #1000, #1003, and #1032 under the #998 umbrella. The related offset
Step-1/Step-2 double-pay finding (S3 / #1001) is handled separately, as it
touches the offset payment-timing and cancel-unwind logic more deeply.
