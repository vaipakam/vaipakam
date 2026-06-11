## Thread — #408 / #410 / #413 floor-model foundation: storage + struct fields + offer→loan wiring

First PR of the 5-PR sequence that resolves the unified interest-floor-model bug cluster (#408 lender under-charges on early repay, #410 lender under-pays on parallel sale settlement, #413 borrower over-charged on preclose after partial/periodic). This PR lands ONLY the storage shape changes + the offer→loan flag wiring; the actual floor formula + accumulator-credit semantics land in PR #2 (LibEntitlement/LibSettlement) and PR #3 (RepayFacet partial+periodic).

### What's new — storage

**`LibVaipakam.Loan`** (`LibVaipakam.sol:1573`) — appended a new `uint128 interestSettled` field:

> Cumulative interest already paid toward this loan via `repayPartial` (each partial's interest portion) and `settlePeriodicInterest` (each period's interest forwarded to the lender). Read at settlement to credit against the unified `settlementInterest(loan, now)` gross owed — removes the #413 double-charge by construction.

Append-only; zero on every existing loan at deploy time; accumulator only mutates via the credit hooks added in PR #3.

**`LibVaipakam.CreateOfferParams`** (`LibVaipakam.sol:1229`) — appended `bool useFullTermInterest`:

> Lender's election for the floor-model interest. When `true` (the dapp default), every borrower-initiated ERC20 settlement applies the floor `proRataInterest(P, rate, max(elapsed, duration)) − interestSettled`. When `false`, falls back to pure pro-rata-elapsed (lender opt-out for "soft" loans).

### Offer → Loan wiring

`OfferCreateFacet._writeOfferPrincipalFields` (`OfferCreateFacet.sol:1305`) now writes `offer.useFullTermInterest = params.useFullTermInterest`. Pre-#408 the field was unreachable dead code — `Offer.useFullTermInterest` existed in storage but was never written, so `Loan.useFullTermInterest = offer.useFullTermInterest` at `LoanFacet.sol:792` was always false.

The loan-side copy was already in place; this PR activates the source.

### Test-file sweep

48 files (47 test/script + 1 invariant Handler) updated to add `useFullTermInterest: false` to every `CreateOfferParams` named-arg construction. **Default is `false` in tests** to preserve existing test semantics (which were written against the pre-#408 always-false implicit). New tests added in PR #2 (LibEntitlement) will use `true` to exercise the floor model.

The dapp builder default (`true`) lives in `apps/defi/src/lib/offerSchema.ts:153` — new offers from the connected app use the floor model from day 1 once PR #2 lands.

### Why this sequence

- **Foundation (this PR)** — storage + struct + wiring. No behavior change on a loan whose offer was created with `useFullTermInterest: false`.
- **PR #2** (LibEntitlement / LibSettlement) — rewrites `settlementInterest` to `proRataInterest(P, rate, max(elapsed, duration))`. Behavior change only when the flag is `true`.
- **PR #3** (RepayFacet) — `interestSettled` increment on partial/periodic. Resolves #413 double-charge.
- **PR #4** (OfferParallelSaleFacet) — route settlement through unified `settlementInterest`. Resolves #410.
- **PR #5** (spec + dapp + audit) — `ProjectDetailsREADME.md` early-repayment policy + `_CodeVsDocsAudit.md` entry + release notes consolidation.

Each PR is bounded + reverts independently. The cluster cannot ship as one mega-PR safely (220+ test-construction edits in one diff would be unreviewable).

### Verification

- forge build clean.
- T092AutoLifecycleIntegrationTest 21/21 + RefinanceFacetTest 36/36 + RepayFacetTest + PrecloseFacetTest + LoanFacetTest + OfferFacetTest + PreviewAcceptTest 317/317 broader green.
- Deploy-sanity 12/12.
- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- ABI re-export ran.

### Design doc

[`docs/DesignsAndPlans/InterestSettlementFloorModel.md`](docs/DesignsAndPlans/InterestSettlementFloorModel.md) — Option A (track remaining committed term on ERC20 partial repays) ratified 2026-06-07; on PR #415 docs branch.

### Out of scope (deferred to subsequent PRs)

- LibEntitlement.settlementInterest rewrite.
- LibSettlement.computePreclose / computeRepayment subtraction of interestSettled.
- RepayFacet.repayPartial + settlePeriodicInterest accumulator increments.
- RepayFacet.repayPartial duration decrement (Option A: track remaining committed term).
- OfferParallelSaleFacet settlement routing.
- RepayFacet.calculateRepaymentAmount view alignment.
- Spec updates.
