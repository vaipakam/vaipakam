# Spec-vs-Code Conformance Review — Pass 2 (2026-07-13)

**Branch reviewed:** fresh `main` (post the 2026-07-05/12 spec reconciliation and the
`#998` code-fix tranches).
**Oracle (intended behaviour, code under test):** `docs/FunctionalSpecs/ProjectDetailsREADME.md`
+ `docs/FunctionalSpecs/TokenomicsTechSpec.md`.
**Dedup base:** `docs/FunctionalSpecs/_CodeVsDocsAudit.md`,
`Findings20260705-SpecVsCodeConformanceReview.md`, `Findings20260702-SmartContractSecurityAudit.md`,
`Findings20260713-ContractsSpecFollowup.md`, and the live `@vaipakam-labs` issue set. Nothing
already tracked is re-reported except explicit VERIFY-of-known rows.

Six independent domain reviews (loan lifecycle; offers/matching/signed book;
risk/liquidation/oracle; rental/listings/strategic flows; tokenomics/rewards/cross-chain;
sanctions/vaults/access/admin). **Every `#998` code fix that had landed was re-checked
against the spec and the recorded owner decision and verified correctly implemented**
(full list at the end). This report records only *new* divergences.

## Severity roll-up

| Sev | New findings |
|-----|--------------|
| **High** | D1 |
| **Medium** | A1/D5 (merged), A2, A3, C1, D3, D4 |
| **Low** | B1, B2, B3, B4, C2, C3, C4, C5, E1, E2, E3, A4, F1, F2, F3, F4, F5, D6, D7 |
| **Info** | A5 |
| **VERIFY (known-open, still unfixed)** | D2 (#893), and re-confirmed open: #966 (High), #972, #973 |

Legend for the decision column: **[T]** = trivial, my recommended call shown (needs only
owner confirmation); **[?]** = genuine owner decision required.

---

## High

### D1 — Rental term retirement shifts the loan's maturity & grace *earlier* → mid-term permissionless default + repay-brick on a fully-serviced rental  [?]
`autoDeductDaily` (`RepayPeriodicFacet.sol:213-217`) and rental `repayPartial`
(`RepayFacet.sol:983`) decrement `loan.durationDays` while `startTime` never moves. Every
rental maturity/grace consumer computes `startTime + durationDays × 1 day` off the shrunk
counter (`DefaultedFacet.sol:243/787`, `RepayFacet.sol:267-280/1049`, `LibVaipakam.isGraceWindow:6013`,
`PrecloseFacet` Option-2/offset gates), and `gracePeriod(durationDays)` shrinks the grace bucket
too. **Impact:** on the *designed* daily cadence a 7-day rental is permissionlessly
`triggerDefault`-able by ~day 4 (borrower forfeits remaining prepay + full 5% buffer to
treasury) and an in-term `repayLoan` is first late-fee'd, then reverts `RepaymentPastGracePeriod`
— i.e. the borrower cannot close a fully-funded, fully-serviced rental. Spec: README "maturity and
grace fixed at origination / never moved" (consolidation header + §1362), rental default only
"by the end of the grace period" after the agreed term (§1333). Extends open **#893**'s root cause
(that issue only covers the ERC-4907 expiry manifestation; its fix would not touch these sites).
**Classification:** real bug. **Recommendation:** fix jointly with #893 — derive rental
`endTime` from `lastDeductTime + durationDays × 1 day` (or keep `durationDays` immutable and
track a separate paid/remaining counter, the #641 pattern) and feed `gracePeriod()` the original
term. Owner decision needed only to confirm severity/approach and the joint-with-#893 framing.

---

## Medium

### A1 + D5 — Early-close doors (`precloseDirect`, `refinanceLoan`, offset completion) stay open past maturity and charge **zero late fee**  [?]
The three strategic-close paths gate only on `status == Active` — no maturity/grace gate —
and compute no late fee: `LibSettlement.computePreclose` hardcodes `lateFee: 0`
(`LibSettlement.sol:72-74`), refinance settles only `settlementInterestNet` (`RefinanceFacet.sol:342`),
`_computeOffsetSettlement` has no late-fee term (`PrecloseFacet.sol:1291-1328`), and the rental
preclose branch charges only rent. Meanwhile `repayLoan` charges `calculateLateFee`/
`calculateRentalLateFee` on any in-grace close and *reverts* past grace (`RepayFacet.sol:278-283`).
So a late borrower routes around the late fee (≈1–5% of outstanding, ~99% of it lender income)
with one different call, and gets a post-grace repayment door the repay path deliberately closes.
Grace-window *interest* is still charged; only the penalty layer leaks. Spec §1217 (late fees apply
after the due date / post-grace), §1403 (preclose is for closing *before* maturity), §1325
(post-grace → default path). **Classification:** real bug + an ambiguous fix-arm. **Recommendation
(mine):** the late-fee-parity arm — add `calculateLateFee` to the three payoffs when
`now > endTime`, and block all three strictly post-grace like `repayLoan` (keeps a lender-favourable
in-grace cure). Owner picks the arm.

### A2 — `repayPartial` post-payment HF floor blocks strictly-deleveraging repayments  [T → fix code]
`RepayFacet.sol:1008-1023` reverts `HealthFactorTooLow` unless post-payment HF ≥ the **1.5
admission floor**. But a partial repayment reduces principal and resets accrued interest with
collateral still liened, so HF *strictly increases* — the gate can only bind when the loan is
already sub-1.5 and the payment doesn't fully restore it, i.e. it blocks exactly the deleveraging
the lender most wants (loan at HF 1.2, a partial that lifts it to 1.4 reverts). Spec §1161-1164
grants partial repayment with no post-payment HF condition; the directional rule elsewhere (§1362)
is "strictly improve HF and restore to ≥ 1.0," never 1.5. **Classification:** real bug (an inverted
withdrawal-style gate). **My call:** drop the floor check on `repayPartial` (or replace with an
HF-after ≥ HF-before monotonicity assert). Owner sign-off only because it deletes a revert path.

### A3 — Voluntary partial paths never credit/clear `interestSettled` (missed sites of #915/S12)  [T → fix code]
`repayPartial` (`RepayFacet.sol:769/881`) and `swapToRepayPartial` (`SwapToRepayFacet.sol:700/807`)
charge gross accrued interest and reset the accrual clock **without** `creditSettledInterest` or
zeroing `loan.interestSettled` — unlike the two sites the #915 fix did cover (`PrecloseFacet.sol:886`,
`RiskFacet.sol:1250`). On a periodic-cadence loan with an auto-liquidated period this (1) re-charges
the settled interest at the partial (the tracked audit item **M1**, plus its never-named
`SwapToRepayFacet` twin) and (2) — new post-#915 — leaves a stale `interestSettled` that
`currentBorrowBalance`/`settlementInterestNet` now subtract from future-only accrual, understating
HF (delaying liquidation) and underpaying the lender at final settle. Gated on the dormant
`periodicInterestEnabled` flag. Spec §1339 ("credited … never charged twice … applies uniformly to
every path"). **Classification:** incompletely-applied #915 fix. **My call:** mirror
`PrecloseFacet.sol:886` at both sites (credit + zero). Confirm M1's card so it lands once.

### C1 — Time-default "value-collapsed" branch over-transfers on HF<1 (not just LTV>110%)  [?]
`DefaultedFacet`'s value-collapsed arm fires on `HF < 1e18` (`RiskFacet.sol:520`), not only the
spec's LTV > 110% collapse, and hands the lender the **entire** liquid collateral in-kind with
**zero swap attempts** and **no borrower residual claim** (`DefaultedFacet.sol:533-637`). For
collateral between `debt` and `debt/threshold` (up to ~1.25× debt at Tier-1 80%) oracle pricing is
live and the collateral exceeds the lender's spec'd ceiling (due + interest + 3%), so the borrower
loses recoverable surplus. Spec §774 (no automatic full-collateral-to-lender unless the split can't
be computed or collateral is insufficient), §790 (lender ceiling), §1373 (must attempt one route).
The LTV>110% arm is conformant. **Classification:** real bug / ambiguous (depends on whether HF<1
with sufficient collateral is intended to route through the swap/split path). **Recommendation
(mine):** restrict the whole-collateral in-kind arm to genuine LTV>110% collapse or oracle-dead
cases; for HF<1-but-covered, attempt the swap/split with the §790 ceiling + borrower residual. Owner
confirms intent.

### D3 — Rental buffer BPS never snapshotted; cancel/modify/transfer re-derive from **live** config  [?]
`OfferCancelFacet.sol:413` recomputes the cancel refund from `cfgRentalBufferBps()` live (deposit
used create-time config): a post-create buffer *raise* over-withdraws and can brick cancel; a *cut*
strands prepay. `PrecloseFacet.sol:980` resets `loan.bufferAmount` from live config on Option-2
transfer, which can make it exceed the funded buffer and defeat the #1004 `fee ≤ bufferAmount`
guarantee (resurrecting the `InsufficientPrepay` brick #1096 fixed). The modify-path skew is
acknowledged in-code but the cancel/transfer skew is not. Spec §696-699, §1233, §1243
(snapshot-at-origination discipline). **Classification:** real bug (manifests on a governance
retune). **Recommendation (mine):** snapshot `rentalBufferBps` (or the absolute buffer) on the
offer at create; read the snapshot at cancel/modify; set `loan.bufferAmount` from the offer's
snapshot at transfer.

### D4 — Option-2 obligation transfer on rentals uses ERC-20 APR math on the per-day fee; undeducted rent lost  [?]
`transferObligationViaOffer` (`PrecloseFacet.sol:709-741`) charges the exiting borrower
`proRataInterest(loan.principal, interestRateBps, elapsed)`, but for a rental `loan.principal` is
the per-day fee and rent = `principal × days` with no APR — so the **undeducted elapsed rent**
(between `lastDeductTime` and the transfer) is never settled to the lender, and the residual prepay
stays freely withdrawable in the exiting borrower's un-liened vault. Spec §1512 ("pay all interest
accrued up to the transfer" — for rentals, accrued rent), §1543 (Option 2 supports rentals), §1420
(don't leave the original lender worse off). **Classification:** real bug (undeducted-rent leg) +
ambiguous (shortfall units). **Recommendation (mine):** either (a) internal `autoDeduct` catch-up
before the reset + define rental shortfall in rent terms, or (b) restrict Option 2 to ERC-20 like
Option 3 and update §1543.

---

## Low

- **B1 [T]** — signed-offer `amountMax = 0 ⇒ collapse to amount` sentinel honored by the matcher
  path but not `toCreateOfferParams` (direct fill reverts `AmountMaxMustBePositive`); path
  inconsistency, fail-loud. Spec §1083. *Fix: honor the sentinel in the direct path.*
  (`LibSignedOffer` / `toCreateOfferParams`.)
- **B2 [?]** — the authoritative offer-state view (`LibMetricsTypes.deriveOfferState`) has no
  `Expired` state; a lapsed GTT offer reads `Open` (fills still refuse it via `expiresAt`). Spec
  §1075 "distinguish … expired." *Add an Expired state, or accept as mitigated?*
- **B3 [T]** — signed-offer GTT vet uses `>` where the rule is `>=` ("at and after the deadline");
  behaviour is safe (materialize-time gate) but the boundary-second error is misleading. *Fix:
  align to `>=`.*
- **B4 [T]** — tracked L-b's ratified spec edit never landed: README §885 still says a
  refinance-tagged offer's principal "can still be adjusted" while `OfferMutateFacet` freezes it.
  *Fix: reword §885.*
- **C2 [T]** — #999's comment-fix missed the accessors: `LibVaipakam.sol:5680/5692/5698` still
  label Tier-1 as 90% / Tier-3 as 80% (inverted) and mis-name the tier-0 alias. *Fix: NatSpec.*
- **C3 [T]** — stale `RiskFacet.sol:622-627` comment claims time-defaults fall back to full
  transfer when the sequencer is down; `DefaultedFacet` correctly reverts. *Fix: delete comment.*
- **C4 [T]** — liquid time-default treasury transfers skip `recordTreasuryAccrual`
  (`DefaultedFacet.sol:475-481`), under-counting the spec'd treasury/revenue analytics. *Fix: add
  the accrual call.*
- **C5 [?]** — `FlashLoanLiquidator` checks debt+fee only (`:425-430`); the spec's "configured
  gas/profit headroom" (§1350) has no on-chain knob. *Add the knob, or treat the spec line as
  off-chain keeper policy?*
- **E1 [T]** — residual retired-terminology NatSpec the 07-13 sweep missed: two "Insurance pool"
  mentions (`RewardAggregatorFacet.sol:49/276`), "LZ outage" failure-mode comments, an orphaned
  "Base is the SOLE seller of the fixed-rate VPFI … via VPFIBuyAdapter" block
  (`LibVaipakam.sol:2810-2813/2602`), `GuardianPausable.sol:17`, `LibKeeperReward.sol:33`. Legal
  surface in comments. *Fix: sweep (roll into #1018).*
- **E2 [?]** — `settleBorrowerLifProper` pays the borrower LIF rebate at the effective tier without
  consulting `vpfiDiscountConsent`, while spec §6a says consent-off ⇒ effective discount 0 at
  settlement (lender yield-fee sites *do* gate consent). *Recommendation (mine): spec is
  over-broad — carve out the pre-paid borrower rebate rather than confiscate custody. Owner
  confirms.*
- **E3 [T]** — Base's own `closeDay` stores a late self-report after `finalizeDay` instead of
  rejecting it (`RewardReporterFacet.sol:143-207` lacks the `ReportAfterFinalization` guard the
  mirror ingress has); payout-benign but poisons the `backfillDayInclusion` predicate + audit
  trail. *Fix: add the guard on the Base path.*
- **A4 [T]** — README §2683/2688/2699 still describe unconditional full-term refinance interest,
  lagging the landed mode-aware #1003 code and the 07-12 consolidation header. *Fix: reword.*
- **F1 [T]** — spec §2144 lists the removed `setStakingApr` as a live bounded knob (setter deleted
  with the staking program). *Fix: remove from spec.*
- **F2 [T]** — spec §2146 documents the retired `updateRiskParams.liqThresholdBps`; replaced by
  per-tier `setTierLiquidationLtvBps` + the #999 `T1≤T2≤T3` invariant. *Fix: update spec.*
- **F3 [T]** — spec §812-813 says position NFTs won't be natively transfer-locked for preclose/sale
  flows, but the locks exist and §1636 relies on them (self-contradiction; code is ratified). *Fix:
  reconcile §812 to acknowledge listing/sale locks.*
- **F4 [?]** — no handover-time assertion that Timelock `getMinDelay() ≥ 48h`; the
  `TIMELOCK_MIN_DELAY` env can floor it to 1h with no mainnet gate. Spec silent. *Add a
  handover/predeploy assertion? (hardening).*
- **F5 [T]** — spec §2647's blanket "fail safe" sentence contradicts the ratified fail-open posture
  for never-flagged wallets during an oracle outage (§2642-2643 + the #1006 decision). *Fix:
  reword.*
- **D6 [T]** — stale in-code custody comments ("ERC721 stays in lender's wallet") vs the
  correctly-implemented create-time vault escrow; open **#894** looks stale against main (verify the
  signed-offer escrow path before closing). *Fix: comments + re-verify #894.*
- **D7 [T]** — `_CodeVsDocsAudit.md:43` still lists #951 under Open though it closed 2026-07-04 (PR
  #959). *Fix: move to Resolved.*

## Info

- **A5 [T]** — `RiskFacet.sol:979-983` NatSpec describes the pre-#641 `startTime`/`durationDays`
  rewire the code no longer does (it re-stamps only the interest clock). *Fix: rewrite the
  docstring.*

## VERIFY — known-open, confirmed still live on main

- **D2 / #893 (High)** — renter's ERC-4907 expiry still collapses at 2× (`RepayPeriodicFacet.sol:220`,
  `RepayFacet.sol:987`); fix jointly with D1 (one anchor covers both).
- **#966 (High)** — dust-donation underflow in `tryApplyYieldFee`/`tryApplyBorrowerLif` can block
  `repayLoan`; re-confirmed open — flag for prioritization.
- **#972** — `vpfiToken == address(0)` branch bricks close-outs. **#973** — notification-fee bill
  skips the discount restamp. Both re-confirmed open.

---

## Landed `#998` fixes re-verified correct (no regression)

S1 #999 (tier gradient flip 80/85/90 + `T1≤T2≤T3` invariant + tier-0→Tier-1 remap), S11 #1007
($50k Tier-1 probe gating), S2 #1000 (fallback repay-cure reachability), S3 #1001 (offset
settle-at-completion + loss-free cancel + single-offset + mutual-exclusion guards), S4 #1002 + S5
#969 (interaction-reward lifecycle close-out), S7 #1003 (mode-aware refinance payoff), S8 #1004
(rental late fee scales with overdue rent + buffer clamp), S9 #1005 (`NoEnabledSwapRoute` central
empty/all-disabled coverage), S13 #1008 (per-day reward cap, Option B), L-c #1032 (second-precise
replacement-maturity gates), L-g #1009 (treasury-handling-fee subordination, liquidator bonus kept),
L-h #1010 (dynamic incentive on time-based-default swaps), M7 #915 (`interestSettled` netting at the
four forced-close sites — the two voluntary-partial sites it missed are A3), #1067 (durable
holder-accurate terminal reward close-out), the S10 family (#1122 fail-closed locked-proceeds
release, #1126 confirmed-flagged registry movement gate, #1141 terminalize host + register-coverage
CI guardrail, #1146 Invariant B inline-payout backstop + Seaport `syncPrepaySale`), #1115
(RiskPreviewFacet split + preview/live floor parity), #1101 (S15 offer floor/ceiling at create +
mutate), #1164 (#940 FallbackPending in the active-set dashboard views), and the full gasless
signed-offer book (order-hash on-chain remainder ledger, ERC-20-only shapes via
`SignedOfferUnsupportedShape`, AON Permit2 witness, replay/batch-nonce cancel, fill-time HF checks).

*Per-domain detail retained in the review scratch files; this document is the consolidated record.*
