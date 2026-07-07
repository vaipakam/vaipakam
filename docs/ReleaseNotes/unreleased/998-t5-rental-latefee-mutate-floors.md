## Thread — #998 Tranche 5: rental late fee + offer-mutate floor checks (PR #<n>)

Two independent spec-conformance fixes from the standalone tranche. (The third
Tranche-5 finding, S10 #1006 — fail-closed release of sanctioned-locked
proceeds — is split into its own follow-up PR: it needs a small locked-proceeds
state model to keep never-flagged claims fail-open while only the locked-release
gate fails closed, which is more than a one-line change.)

**S8 (#1004) — the NFT-rental late fee was computed on a single day's fee.**
For an NFT rental, `loan.principal` is the PER-DAY rental fee, but the late-fee
helper applied the 1%..5% rate to `loan.principal` directly — so for a D-day
rental the base was ~D× too small and the 5% cap was 5% of a single day's fee.
The rental late fee now applies the rate to the OVERDUE rental amount (the
rental that has accrued but not yet been deducted from prepay) and caps it at 5%
of the TOTAL rental amount. The total rental term is recovered without a new
stored field: `autoDeductDaily` advances the deduction clock and decrements the
remaining duration together, so `already-deducted-days + remaining-days` is an
invariant equal to the original term. The rental math lives in a dedicated
`calculateRentalLateFee` so it isn't inlined into the ERC-20-only forced-close
facets (only the rental-repay path charges a rental late fee — HF liquidation is
ERC-20-only and a time-based rental default settles from prepay with no late
fee).

**#900 (L1 / spec-review S15) — offer mutation skipped the create-time
floor/ceiling checks.** `createOffer` enforces, for range-amount-enabled,
both-legs-ERC-20, both-legs-liquid offers, that a lender's collateral clears the
system-derived floor at its worst-case lending size, and that a borrower's
lending ceiling doesn't exceed what their collateral can back. The mutate
surface (`setOfferAmount` / `setOfferCollateral` / `modifyOffer`) re-checked
only range-ordering, positivity, the filled-floor, and cadence — so a creator
could mutate an offer into a state `createOffer` would reject. Nothing
under-collateralised could mint (the binding HF/LTV gates re-run at settlement),
but the offer became silently "created but never matchable", stranding the
creator's capital until they cancelled. The same floor/ceiling checks now run on
the post-mutation shape, before any vault delta, so the mutation fails early
with the same errors create time uses. Same scope as create time — a no-op for
non-liquid or non-range offers.

Closes #1004, #900 (umbrella #998).
