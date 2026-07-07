## Thread — #998 Tranche 5: offer-mutate floor/ceiling checks (PR #<n>)

**#900 (L1 / spec-review S15) — offer mutation skipped the create-time
floor/ceiling checks.** `createOffer` enforces, for range-amount-enabled,
both-legs-ERC-20, both-legs-liquid offers, that a lender's collateral clears the
system-derived floor at its worst-case lending size, and that a borrower's
lending ceiling doesn't exceed what their collateral can back. The mutate
surface (`setOfferAmount` / `setOfferCollateral` / `modifyOffer`) re-checked
only range-ordering, positivity, the filled-floor, and cadence — so a creator
could mutate an offer into a state `createOffer` would reject. Nothing
under-collateralised could mint (the binding HF/LTV gates re-run at settlement,
KYC re-checks at accept), but the offer became silently "created but never
matchable", stranding the creator's capital until they cancelled. The same
floor/ceiling checks now run on the post-mutation shape, before any vault delta,
so the mutation fails early with the same errors create time uses. Same scope as
create time — a no-op for non-liquid or non-range offers.

The other two Tranche-5 findings are split into their own follow-up PRs, each
needing more than a one-line change:
- **S8 #1004** (NFT-rental late fee on the overdue rental amount) — the rental
  accounting has no single "days-paid" / original-term counter that survives
  BOTH `autoDeductDaily` (advances the deduction clock, decrements duration) AND
  `repayPartial` (decrements duration only), so computing the overdue amount,
  the original maturity for the late-fee rate, and the 5%-of-total-rental cap
  correctly needs a proper rental-accounting model, not a formula patch.
- **S10 #1006** (fail-closed release of sanctioned-locked proceeds) — needs a
  locked-proceeds state model to keep never-flagged claims fail-open while only
  the locked-release gate fails closed.

Closes #900 (umbrella #998).
