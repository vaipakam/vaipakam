## Thread — #408 / #410 / #413 unified floor-model fix (single end-to-end PR)

Resolves three related interest-settlement bugs together via the single architectural change described in `docs/DesignsAndPlans/InterestSettlementFloorModel.md` (Option A ratified 2026-06-07, lives on PR [#415](https://github.com/vaipakam/vaipakam/pull/415) — not yet on `main`).

### The bugs

| # | Symptom | Direction |
|---|---|---|
| #408 | Early full repayment via `repayLoan` charges pro-rata, not committed full-term interest | Lender under-paid |
| #410 | Parallel-sale settlement pays the lender pro-rata, penalises lender vs full-term | Lender under-paid |
| #413 | `precloseDirect` after a partial-repay or periodic settlement double-charges interest | Borrower over-charged |

### The fix — one formula

```
floorDays     = useFullTermInterest ? durationDays : 0
elapsedDays   = (now - startTime) / 1 day
effectiveDays = max(elapsedDays, floorDays)
gross         = proRataInterest(principal, rate, effectiveDays)
net           = gross - interestSettled (saturating at 0)
```

Every borrower-initiated ERC20 settlement now routes through `LibEntitlement.settlementInterestNet`. This collapses `computePreclose` and `computeRepayment` to the same formula (preclose is the pre-maturity case where `max(elapsed, duration) = duration`), which is what removes the #413 divergence by construction. The floor branch fixes #408 + the gross-amount half of #410; the credit term removes the #413 double-charge.

### Storage

- `LibVaipakam.Loan` appended `uint256 interestSettled` — cumulative interest already paid via partial-repay or periodic settlement.
- `LibVaipakam.CreateOfferParams` appended `bool useFullTermInterest` — lender's election for the floor model (default `true` at the dapp builder layer).

`uint256` chosen defensively per Codex round-3 P2 feedback: at max-duration + max-APR corners, `uint128` could overflow.

### Code changes

- **`LibEntitlement.settlementInterest`** rewritten to the floor formula above (returns gross). New companion `settlementInterestNet` subtracts `loan.interestSettled` for the credit-aware path.
- **`LibSettlement.computeRepayment` + `computePreclose`** route through `settlementInterestNet`. Both now use the same formula — preclose is just the pre-maturity case.
- **`LibCollateralSettlement.principalPlusAccruedInterest` + `treasuryAndPrecloseFee`** (parallel-sale + swap-to-repay-intent paths) route through `settlementInterestNet`. Resolves #410: lender gets full-term floor on parallel-sale settlement when `useFullTermInterest: true`.
- **`RepayFacet.repayPartial`** (ERC20 branch):
  - Increments `loan.interestSettled += accrued` so a later full-repay / preclose credits the partial's interest exactly once (Option A's accumulator side).
  - Decrements `loan.durationDays -= elapsedSinceSegmentStart` so the floor in `settlementInterest` always reflects the borrower's REMAINING commitment, not the original (Option A's remaining-term tracking).
- **`RepayFacet.settlePeriodicInterest`** (auto-liquidate branch): credits `loan.interestSettled += lenderProceeds` so periodic interest forwarded to the lender isn't double-charged at a later settlement.
- **`RepayFacet.calculateRepaymentAmount`** view routes through `settlementInterestNet` so the view's "due amount" matches what the settler actually charges. Pre-fix the view computed independently and could drift.
- **`OfferCreateFacet._writeOfferPrincipalFields`** writes `offer.useFullTermInterest = params.useFullTermInterest`. Pre-fix the field was unreachable dead code.

### Dapp

- `apps/defi/src/lib/offerSchema.ts` adds the field to `OfferFormState` + `CreateOfferPayload` + the payload builder, with the dapp default `true` — new offers from the connected app use the floor model by default.

### Test sweep

48 test/script files updated with `useFullTermInterest: false` to preserve existing test semantics. New focused tests:
- `test_408_EarlyRepayChargesFullTermFloor` — full-term loan, early repay at day 1 of 30, asserts `principal + fullTermInterest`.
- `test_413_PrecloseAfterPartialDoesNotDoubleCharge` — partial at day 10, then preclose, asserts net = `gross_remaining - interestSettled` (saturating).

### Verification

- forge build clean.
- 355/355 broader regression + 12/12 deploy-sanity green (RepayFacetTest, RefinanceFacetTest, PrecloseFacetTest, LoanFacetTest, OfferFacetTest, PreviewAcceptTest, T092AutoLifecycleIntegrationTest, PeriodicInterestSettleTest, PeriodicInterestCadenceTest).
- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- ABI re-export ran.

### Pre-live posture

Per the user direction (2026-06-12): pre-live → no backwards-compat at the ABI level. Struct appends change selector tuples; the deploy pipeline refreshes all facets together (no `Replace` cut tricks needed). Tests use named-field struct construction throughout, so storage shape changes don't propagate to test positional access.

### Out of scope (deferred follow-ups)

- **Spec updates** (`docs/FunctionalSpecs/ProjectDetailsREADME.md` early-repayment policy text) — follow-up doc PR.
- **`_CodeVsDocsAudit.md` entry** — same follow-up.
- **Dapp UI control for `useFullTermInterest` opt-out** — separate UX PR; payload field is wired so the contract supports both values today.
- **Deploy script polish** (`ReplaceStaleFacets` etc.) — pre-live can rebuild facets fresh; no script reshape needed in this PR.
