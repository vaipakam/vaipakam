## Thread — #411: refinance over-pay fix — drop redundant shortfall to exiting old lender

`RefinanceFacet.refinanceLoan` historically paid the exiting old lender `principal + full-term interest + rate shortfall`, where shortfall = `oldFullTerm − newFullTerm` when the new offer yields less. The shortfall block over-compensated the lender: full-term interest IS the maximum the lender could have earned on this loan (the run-to-maturity, no-early-payoff case), so paying additional shortfall pushed them BEYOND their ceiling, funded by the borrower.

### What's new

**Contract change** ([`RefinanceFacet.sol:283-326`](contracts/src/facets/RefinanceFacet.sol#L283-L326)):

- Removed the `newExpectedInterest` + `shortfall` computation block.
- `interestPortion = oldInterest` (was `oldInterest + shortfall`).
- The `shortfall` local is retained at 0 to keep the `LoanRefinanced` event signature byte-identical — indexers continue to decode the field, just always read 0 post-fix. No ABI break.

**Spec update** ([`docs/FunctionalSpecs/ProjectDetailsREADME.md`](docs/FunctionalSpecs/ProjectDetailsREADME.md)):

- §2198 "Frontend Warning" updated to drop the "plus any rate shortfall" clause for refinance.
- §2211-§2214 "Original Lender Protection Rule for Refinance" updated to clarify that full-term interest already satisfies the rule for an EXITING lender; shortfall remains in force on the obligation-transfer / offset paths where the lender STAYS on the loan.

### Why refinance differs from transfer / offset

| Path | Lender state | Shortfall needed? |
|---|---|---|
| Refinance | EXITS (`lenderClaims` set; old loan closes) | NO — full-term interest IS their maximum |
| Obligation transfer (`PrecloseFacet.transferObligationViaOffer`) | STAYS (continues on the loan at new rate) | YES — bridges back up to original full-term |
| Offset | STAYS | YES — same as transfer |

The refinance-path shortfall was the bug. Transfer and offset shortfall are unchanged.

### Verification

- forge build clean.
- New test `test_411_RefinanceExitingLenderReceivesFullTermOnly` — exact assertion that old lender's vault delta = `principal + fullTermInterest - treasuryFee` with NO shortfall addend, even when the new offer yields strictly less (500 bps → 400 bps).
- RefinanceFacetTest 36/36 (was 35, +1 new test).
- T092AutoLifecycleIntegrationTest 21/21 (no regression).
- Deploy-sanity 12/12.
- ABI re-export ran.

### Design doc

[`docs/DesignsAndPlans/RefinanceOldLenderOverpayFix.md`](docs/DesignsAndPlans/RefinanceOldLenderOverpayFix.md) — Option 1 selected 2026-06-07; pending PR #415 to land that doc.

### Out of scope

- The interest floor model + `interestSettled` accumulator (#408 / #410 / #413) — separate cluster, larger contract surface.
