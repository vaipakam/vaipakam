# Spec-vs-Code Conformance Review — 2026-07-05

A review of the on-chain Vaipakam contracts against the **functional
specifications**, using the spec as the intended-behaviour oracle and the code
as the system under test. This is a *different lens* from the 2026-07-02/03
adversarial security audit (`Findings20260702-SmartContractSecurityAudit.md`,
51 issues #893–#973): that audit hunted for exploitable bugs from the code's
structure; this one asks **"does the code do what the documents say it should?"**

## Method

- **Oracle (intended behaviour):** `docs/FunctionalSpecs/ProjectDetailsREADME.md`
  (§1–§16) and `docs/FunctionalSpecs/TokenomicsTechSpec.md` (§1–§13).
- **Under test:** all facets/libraries on `main` implementing those behaviours.
- Six parallel domain reviews mapped each concrete spec claim to its
  implementing code and recorded divergences. Prior-audit issues #893–#973 were
  excluded from re-reporting except where the spec lens materially reframes or
  elevates one (noted inline).

## Classification legend

Each divergence is tagged:

- **Real bug** — code contradicts the spec; the *code* should change.
- **Stale spec** — code is right (often a later, ratified hardening); the *doc*
  should change.
- **Phase gap** — spec describes future/optional behaviour, off by default.
- **Ambiguous** — spec is unclear or internally contradictory; needs a human
  intent decision (record in `docs/FunctionalSpecs/_CodeVsDocsAudit.md`).

**Important:** many items below are *stale spec* (documentation should be
updated), not code defects. But per the project's own rule the spec is the test
oracle, so every divergence is worth an explicit decision. The High findings and
most Mediums classified "Real bug" are the ones that warrant code changes.

---

## Severity summary

| # | Sev | Title | Classification | Location |
|---|-----|-------|----------------|----------|
| S1 | High | Per-tier liquidation-threshold gradient is inverted (thinnest tier gets the highest threshold) | Real bug | `LibVaipakam.sol:162-164` |
| S2 | High | Cure-by-full-repayment of a FallbackPending loan is unreachable for time-based defaults | Real bug | `RepayFacet.sol:254` |
| S3 | High | Offset (Preclose Option 3) prepays the old lender's full principal at Step 1; cancel never unwinds it → double-pay | Real bug | `PrecloseFacet.sol:1128`, `OfferCancelFacet.sol:202` |
| S4 | High | Interaction rewards are claimable at contracted maturity while the loan is still open → clean-repay forfeit is front-runnable | Real bug | `LibInteractionRewards.sol:907` |
| S5 | High | Preclose/Refinance never close reward entries → accrual on retired principal, forfeit unwired (confirms/elevates #969) | Real bug | `PrecloseFacet.sol`, `RefinanceFacet.sol` |
| S6 | Medium | Grace-period off-by-one at exactly 365 days (30-day grace instead of 2 weeks) | Stale spec (owner decision 2026-07-05: keep code; spec updated in PR #1011) | `LibVaipakam.sol:5859` |
| S7 | Medium | Refinance always pays the exiting lender full-term interest, ignoring the loan's pro-rata election | Real bug | `RefinanceFacet.sol:323` |
| S8 | Medium | NFT-rental late fee is computed on the daily fee, not the overdue rental amount (~D× too small) | Real bug | `LibVaipakam.sol:6036` |
| S9 | Medium | Empty adapter try-list routes a default/liquidation straight into the collateral fallback with no swap attempt | Real bug | `LibSwap.sol:158` |
| S10 | Medium | Locked-proceeds release gate (`SanctionedProceedsLocked`) fails **open** on sanctions-oracle revert — must fail closed; normal never-flagged claims stay fail-open by owner decision (#1006) | Real bug (narrowed to the locked-release gate) | `LibVaipakam.sol:6940` |
| S11 | Medium | Tier-1 assignment ignores the $50k tier-1 depth probe (`tier1SizePad` is a no-op) | Real bug / Ambiguous | `OracleFacet.sol:1765` |
| S12 | Medium | Forced-close debt (liq/default/fallback) ignores `interestSettled` — periodic interest charged twice (confirms #915) | Real bug | `RiskFacet.sol:770`, `DefaultedFacet.sol:396` |
| S13 | Medium | Per-user interaction-reward cap enforced per entry-window, not per day as §4 specifies | Real bug (mild) | `LibInteractionRewards.sol:947` |
| S14 | Medium | Spec's Health-Factor formula + worked example don't match the risk-adjusted HF the code enforces | Stale spec | `README §3:519`, `RiskFacet.sol:452` |
| S15 | Medium | Range-offer worst-case-fill bounds not re-enforced on mutation; create-time check skipped when `rangeAmountEnabled` is false | Ambiguous | `OfferMutateFacet.sol` |
| S16 | Medium | Peer-LTV consensus tolerance is 30pp in code vs 15pp in spec | Stale spec | `LibVaipakam.sol:321` |
| S17 | Medium | Keeper-initiable preclose/transfer/offset/refinance/sale-listing vs the spec's "party-only" execution matrix | Ambiguous (spec self-contradicts) | `PrecloseFacet`, `RefinanceFacet`, `EarlyWithdrawalFacet` |
| S18 | Medium | Tier-LTV hard-stale fallback is 50/60/65, not the spec's 50/62/73 (spec values are dead code) | Stale spec + dead code | `LibVaipakam.sol:6363` |
| S19 | Medium | §9 insurance/bug-bounty 2%-of-supply surplus recycling rule has no on-chain implementation | Phase gap / Stale spec | (absent) |

Lower-severity and stale-doc items are listed in the "Low" and "Informational"
sections. Grand totals: **5 High, 14 Medium, ~14 Low, ~14 Informational.**

---

## High

### S1 — Per-tier liquidation-threshold gradient is inverted
- **Spec:** ProjectDetailsREADME §7 (~1280) "deeper assets receiving **higher** liquidation thresholds and thinner assets receiving **lower** thresholds… Tier 1 at least as conservative as Tier 2, Tier 2 at least as conservative as Tier 3"; §1 (~217) "tiers 1 through 3 represent progressively deeper markets" (tier 3 = deepest, $5M probe).
- **Code:** `LibVaipakam.sol:162-164` — `TIER1_LIQ_LTV = 9000, TIER2 = 8500, TIER3 = 8000`; `ConfigFacet.sol:1484` enforces `T1 ≥ T2 ≥ T3`; snapshotted onto every liquid loan at `LoanFacet.sol:1121`, consumed by `RiskFacet.calculateHealthFactor:472`. But in the tier machinery (`OracleFacet._liquidityTier:1751-1789`) **tier 1 is the thinnest** ($5k floor) and tier 3 the deepest ($5M) — consistent with init-LTV caps (T1 50% < T3 65%) and liquidation discounts (T1 widest "because thinnest").
- **Divergence:** thinnest tier gets the **highest** liquidation threshold (90%); deepest gets the lowest (80%) — the opposite of the spec's gradient. The `LibVaipakam.sol:152` comment and `InternalLiquidationLedger.md` were authored under an inverted tier-numbering assumption; they state the right *principle* but the numbers implement its opposite.
- **Classification:** Real bug (cross-artifact semantic inversion). **Live today:** the snapshot runs regardless of `depthTieredLtvEnabled`, and `effectiveTier = min(onChain, keeperTier)` with keeper default 1, so virtually every liquid-collateral loan snapshots the 90% threshold.
- **Impact / fix:** thin-market collateral is only liquidatable at 90% LTV, leaving a ~10% cushion to absorb the 6% slippage cap + 2% handling + up to 3% liquidator bonus — the bad-debt shape the gradient is meant to prevent. Swap the default gradient (and the setter invariant) to `T1 ≤ T2 ≤ T3`, or formally re-ratify the code's shape in the spec with an economic argument. Existing loans keep their snapshots — fix before origination volume grows.

### S2 — Cure-by-full-repayment of a FallbackPending loan is unreachable for time-based defaults
- **Spec:** README ~742 and §6 ~1230 — "before the lender claim is executed, the borrower may still add collateral or **fully repay the loan (incl. accrued interest and late fees)** to cure"; "Full repayment cancels the fallback path." No time limit other than lender-claim execution.
- **Code:** `RepayFacet.sol:226-254` — `repayLoan` accepts `FallbackPending` (the cure path) but then unconditionally runs `if (block.timestamp > graceEnd) revert RepaymentPastGracePeriod();` (`:254`) *before* the cure branch. A time-based-default fallback (`DefaultedFacet.triggerDefault`) exists **only** past `graceEnd`, so the repay-cure always reverts. `FallbackCureTest.t.sol` only exercises the top-up cure in that regime.
- **Classification:** Real bug (code contradicts an explicit, twice-stated right; the facet header at `RepayFacet.sol:61` promises the cure).
- **Impact / fix:** a borrower with funds cannot cancel the fallback and reclaim collateral; they're forced into the 3%+2% fallback premium the cure exists to avoid. Skip/extend the grace gate when `curingFallback == true` — the cure payment fully compensates the lender (principal + interest incl. grace accrual + late fees), so there is no lender-side harm.

### S3 — Offset (Preclose Option 3) prepays full principal at Step 1; cancel never unwinds it
- **Spec:** §8 Option 3 flow (~1534-1541) — Step 1 the borrower pays only "accrued interest owed… any shortfall owed"; these "are reserved… and tracked separately **until the counterparty matches**." The lender's *principal* claim materialises only at completion. The checklist (~1759) requires defined behaviour "if the linked offer is cancelled."
- **Code:** `PrecloseFacet._settleOffsetPayments:1128-1160` — at *offer-creation* it deposits `lenderTotal = principal + accruedInterest − treasuryFee + shortfall` directly into the old lender's vault and `s.heldForLender[loanId] += lenderTotal` (monotone, never decremented — `LibVaipakam.sol:2279`). `OfferCancelFacet.cancelOffer:202-207` handles offset-offer cancel by unlocking the NFT + deleting link mappings only — **no refund / no `heldForLender` decrement**. `ClaimFacet.claimAsLender:899` pays `heldForLender` *additively* on top of terminal `lenderClaims`.
- **Divergence:** (a) borrower needs ~2× principal liquidity at Step 1 (one copy to the old lender, one funding the new offer) vs spec's accrued-only reservation; (b) if the borrower cancels the un-matched offset offer (explicitly permitted) and the loan later closes any other way, the lender collects the terminal settlement **plus** the stranded `heldForLender` — principal paid twice.
- **Classification:** Real bug (fund-loss on the cancel path) + payment-timing divergence.
- **Impact / fix:** move the principal payoff to `completeOffset` (spec Step 2), or make `cancelOffer` pull `lenderTotal` back out of the lender's vault and zero `heldForLender[loanId]`, or refuse cancel once Step-1 funds moved. Also reject a second `offsetWithNewOffer` while `loanToOffsetOfferId[loanId] != 0`.

### S4 — Interaction rewards claimable at contracted maturity while the loan is still open
- **Spec:** TokenomicsTechSpec §4 (~178-186) — borrower rewards "only on clean full repayment"; lenders "cannot claim while the loan is still active"; both unlock "only after the relevant loan has closed."
- **Code:** `LibInteractionRewards.sol:907` — the "still open" gate is `if (e.endDay == 0) return (0,0)`, but `_allocEntry:1022` stamps `endDay = startDay + durationDays` at **registration**, so no open entry has `endDay == 0`. The only remaining gate is that cumRPN advanced through `endDay-1` (calendar + finalization), independent of loan state.
- **Divergence:** once the maturity day's global denominator finalizes (~maturity +1 day +4h), both parties can `claimInteractionRewards()` and be paid the full-window reward while the loan is unrepaid (in grace, or defaulted-but-not-marked). Later `closeLoan(..., borrowerClean=false)` sets `forfeited=true` on an already-`processed` entry, and `_processEntry` short-circuits — nothing is clawed back.
- **Classification:** Real bug — a borrower intending to default waits past maturity, claims, then defaults; the spec-mandated forfeit-to-treasury is skipped.
- **Fix:** gate `_processEntry` on the loan actually being closed (a `closed` bit on `RewardEntry` set by `closeLoan`), keeping `endDay` purely as the accrual bound.

### S5 — Preclose/Refinance never close reward entries (confirms/elevates #969)
- **Spec:** §4 — daily rewards ∝ daily interest; unlock only after close; borrower rewards require clean full repayment.
- **Code:** `LibInteractionRewards.closeLoan` is called from Repay/SwapToRepay/Defaulted/Risk*/Claim/AutoLifecycle but **not** from `PrecloseFacet` or `RefinanceFacet` (grep: zero hits), both of which flip loans Active→Repaid. The lib docstring (`:302`) says the preclose forfeit is "wired at the call site" — no call site exists.
- **Divergence:** after preclose both entries keep accruing to the *original* contracted `endDay` (reward on interest never earned); preclose-by-borrower isn't "clean full repayment" yet collects the full window; refinance registers a NEW loan while the OLD loan's entries stay open → same principal double-counted in numerator and denominator.
- **Classification:** Real bug. This is the same root cause as already-filed **#969 (M18)**; the spec lens confirms it, elevates it to High (it violates §4's forfeit/lock rules and dilutes honest participants), and adds the refinance double-count angle.
- **Fix:** wire `closeLoan(...)` into both preclose paths (borrower-initiated ⇒ `borrowerClean=false`; lender-initiated ⇒ `lenderForfeit=true`) and RefinanceFacet's old-loan settlement (refinance intent needs a decision — arguably `borrowerClean=true` per §6).

---

## Medium

### S6 — Grace-period off-by-one at exactly 365 days
- **Spec (as reviewed):** §2 (~264) "≤ 1 year: 2 weeks … > 1 year: 30 days." **Code:** `LibVaipakam.gracePeriod:5859` uses `if (durationDays < 365) return 2 weeks; return 30 days;`. A 365-day loan (both a standard bucket and `MAX_OFFER_DURATION_DAYS_DEFAULT`) falls into the ">1 year" catch-all → **30 days grace, not 2 weeks**, delaying every max-tenor lender's default rights by 16 days.
- **Classification:** **Stale spec** — **owner decision 2026-07-05: KEEP CODE / UPDATE SPEC.** A 365-day (max-tenor) loan intentionally keeps the longer, borrower-friendly 30-day grace; the code is NOT to be changed to shrink it to 2 weeks. §2 has been reworded so the "2 weeks" bucket is documented as `< 365` days and exactly-1-year loans as receiving 30 days. **Resolved via the spec update merged in PR #1011 (2026-07-05).**

### S7 — Refinance ignores the loan's pro-rata interest election
- **Spec:** §233 (pro-rata opt-in) + Phase-1-Additions step 4 (~2597) "principal + full-term interest **as per early repayment rules**." **Code:** `RefinanceFacet.sol:323` uses `fullTermInterest(...)` unconditionally, never consulting `loan.useFullTermInterest` — whereas `precloseDirect` on the same loan routes through `settlementInterestNet` (accrued-only for pro-rata). **Real bug:** the two "early close" doors disagree; a pro-rata loan overcharges the borrower / overpays the exiting lender on refinance. **Owner decision 2026-07-05: FIX CODE (mode-aware)** — full-term interest by default (a borrower-initiated refinance must not punish the lender), but when the exiting lender opted into pro-rata, settle pro-rata; route the refinance payoff through the same `settlementInterestNet` the preclose path uses. Filed as #1003.

### S8 — NFT-rental late fee computed on the daily fee, not the overdue rental
- **Spec:** §6 (~1160) "1% of… overdue rental amount (for NFT renting)… capped at 5% of… total rental amount." **Code:** `LibVaipakam.calculateLateFee:6036` returns `loan.principal × feePercent / 10000` for all asset types, but for rentals `loan.principal` is the **per-day** fee. For a D-day rental the base is ~D× too small and the cap is 5% of one day's fee. **Real bug** (under-charges the late renter, under-compensates lender/treasury). Base the NFT-branch fee on `principal × undeducted days` with a 5%-of-total-rental cap.

### S9 — Empty adapter try-list forces a default/liquidation into the collateral fallback
- **Spec:** §7 — the fallback engages only when "every configured swap route fails"; the caller supplies a "ranked try-list" and the Diamond "tries routes in the submitted order." **Code:** `LibSwap.swapWithFailover:158` returns `(false,0)` for `calls.length == 0`, and `DefaultedFacet.triggerDefault:364` / `RiskFacet.triggerLiquidation:754` then invoke `_fullCollateralTransferFallback` — so any permissionless caller pushes an eligible loan into FallbackPending (3%+2% premium, in-kind lender recovery) with **zero routes attempted** on a healthy DEX. `RepayPeriodicFacet.settlePeriodicInterest:458` already rejects an empty list (`PeriodicSettleSwapPathRequired`). **Real bug** — require a non-empty try-list on the two forced-close entry points.

### S10 — Sanctions screening fails **open** on oracle revert, including claim paths
- **Spec:** §16 (~2556) "value-moving sanctions checks that cannot determine a clean result should **fail safe**." **Code:** `LibVaipakam.isSanctionedAddress:6940` does `catch { return false; }` ("fail-open on infrastructure failure"), and every Tier-1 gate — including value-releasing `ClaimFacet.claimAsLender/claimAsBorrower` (`:296/:663/:1068`) and the `SanctionedProceedsLocked` release — routes through it. (The stuck-token recovery path *does* fail-closed — `VaultFactoryFacet.sol:753` — showing the intended pattern.) **Real bug — narrowed by owner decision 2026-07-05 (PARTIAL FIX):** during an oracle outage a flagged wallet's parked locked-proceeds become claimable. Normal (never-flagged) claim/withdraw paths **stay fail-open** — an oracle blip must not hold honest users' funds hostage (liveness). Only the **release gate for already-locked `SanctionedProceedsLocked` funds** fails **closed** on oracle revert: the funds stay parked in the flagged wallet's own vault until the oracle recovers AND confirms clean. Filed as #1006.

### S11 — Tier-1 assignment ignores the $50k tier-1 depth probe
- **Spec:** §1 (~217) "tier probes are $5k, $50k, $500k, $5M." **Code:** `OracleFacet._liquidityTier:1765` computes all four impacts but decides `best[0]>bound⇒0; best[3]≤bound⇒3; best[2]≤bound⇒2; else 1` — `best[1]` (`tier1SizePad = $50k`) is never consulted, so clearing the $5k floor alone yields Tier 1. **Real bug / Ambiguous:** an asset absorbing $5k but not $50k still gets Tier 1 (and today's 90% threshold per S1), and the `tier1SizePad` governance knob is a no-op. Gate Tier 1 on `best[1] ≤ bound`, or amend the spec to a three-probe model.

### S12 — Forced-close debt ignores `interestSettled` (confirms #915)
- **Spec:** §7 (~1268) liquidation recovers the "outstanding" amount; periodic-settled interest must be credited (paid once). **Code:** voluntary closes net correctly (`settlementInterestNet`), but `RiskFacet.triggerLiquidation:770`, `RiskSplitLiquidationFacet:234`, `DefaultedFacet.triggerDefault:396`, and `LibFallback.computeFallbackEntitlements:151` use gross accrual with no `interestSettled` credit — while `RepayPeriodicFacet._autoLiquidatePeriodShortfall:637` credits `interestSettled` without resetting the clock. A periodically-settled loan later liquidated/defaulted pays the same interest twice. **Real bug** — same family as **#915 (M7)**, confirmed live at the forced-close sites via the spec lens. Net `interestSettled` (saturating) in all four.

### S13 — Per-user reward cap enforced per-window, not per-day
- **Spec:** §4 (~187) "each user's **daily** interaction reward is capped at 0.5 VPFI per 0.001 ETH of eligible interest." **Code:** `LibInteractionRewards.sol:947` applies `windowCap = perDayCap × daysInWindow` once over the whole entry window, so a high-share quiet day nets against under-cap days (an upper-bound relaxation). **Real bug (mild)** — enforce `min(raw_d, cap_d)` per day in the cumRPN walk, or amend §4 to the window-aggregate cap.

### S14 — Spec's Health-Factor formula and example don't match the code
- **Spec:** §3 (519) "HF = Collateral Value / Borrowed Value"; example (714) "$1500 (150% HF) for 1000 USDC." **Code:** `RiskFacet.calculateHealthFactor:452` = `collateral × liquidationLtvBpsAtInit / BPS × 1e18 / borrow` (liquidation-threshold-weighted). The spec's own example computes to HF ≈ 1.23 at an 82% threshold and would be **rejected** by the `HF ≥ 1.5e18` init gate (needs ~$1830). **Stale spec** (code follows standard DeFi practice), but as the test oracle the formula + worked example are materially wrong — any frontend/test built from §3 under-computes required collateral. Update §3 to the risk-adjusted definition (same issue recurs in the §2578 partial-withdrawal formula).

### S15 — Range-offer worst-case bounds not re-enforced on mutation
- **Spec:** §4 (1014) range offers "must satisfy the Health-Factor floor at the worst-case fill" (unconditional); §3 modify (610) "must satisfy the same invariants `createOffer` enforces." **Code:** `OfferCreateFacet:906` enforces `MinCollateralBelowFloor`/`MaxLendingAboveCeiling` (only when `rangeAmountEnabled`), but `OfferMutateFacet` never re-checks them. A creator can mutate a compliant range offer into a shape `createOffer` would reject. **Ambiguous** — no direct fund risk (loan-init + match-time HF gates still bind), but offer-book hygiene. Also: the create-time check only runs when `rangeAmountEnabled == true`, whose storage default is false post-#183, so ranged offers on such a deploy skip §1014 entirely, and `ConfigFacet.setRangeAmountEnabled`'s doc-comment no longer describes real behaviour. Add the checks to mutate, or amend the spec.

### S16 — Peer-LTV consensus tolerance 30pp vs 15pp
- **Spec:** §1 (227) "at least two peers agree within **15 percentage points**." **Code:** `LibVaipakam.sol:321` `PEER_DIVERGENCE_TOLERANCE_BPS = 3000` (30pp), documented as deliberate (Aave-vs-Compound 20-30pp spreads). **Stale spec** — reconcile §227 with the 30pp rationale (bounded by the per-tier safety boxes, which match spec exactly), or tighten the constant.

### S17 — Keeper-initiable close flows vs the spec's "party-only" execution matrix
- **Spec:** execution matrix (789-792) lists `precloseDirect`/`transferObligationViaOffer`/`refinanceLoan`/`createLoanSaleOffer` as party-only; §1340/§1591 say a keeper "must not… start a new flow." **Code:** all four admit a keeper holding the matching `KEEPER_ACTION_*` bit. **But the spec contradicts itself** (§1349 "may be initiated by… an authorised keeper"; §2589 blesses keeper-orchestrated refinance; §1692 keeper sale-listing). **Ambiguous** — the code follows the newer per-action keeper-bit model; the matrix + two general-rule bullets were never updated. Reconcile the matrix with the Phase-6 model (or strip the INIT_* bits) via an explicit intent decision. (`addCollateral` correctly stays party-only.)

### S18 — Tier-LTV hard-stale fallback is 50/60/65, not the spec's 50/62/73
- **Spec:** §1 (225) stale-cache falls back to "library defaults of 50%, 62%, 73%." **Code:** `LibVaipakam.effectiveTierMaxInitLtvBps:6363` falls back to the governance cap `TIER{1,2,3}_MAX_INIT_LTV_BPS_DEFAULT = 5000/6000/6500` (#633, so a tightened cap survives a peer-pause); the spec's `TIER*_LTV_DEFAULT_BPS = 5000/6200/7300` (`tierLtvLibraryDefaultBps`) have **zero callers** (dead code). **Stale spec + dead code** — conservative direction (only bites when `depthTieredLtvEnabled`). Update §225, delete/wire the dead helper, fix the natspec.

### S19 — §9 insurance/bug-bounty 2%-of-supply surplus recycling not implemented
- **Spec:** TokenomicsTechSpec §9 (549) "if the insurance/bug-bounty pool exceeds 2% of total supply, surplus VPFI is also recycled through the conversion path." **Code:** no contract tracks an insurance pool or a 2%-of-`totalSupply()` surplus check; only two natspec mentions. **Phase gap / Stale spec** — either implement the surplus check + convert routing, or rewrite §9 as an operational multisig procedure (the §3 bug-bounty allocation is "locked in multisig", i.e. off-chain).

---

## Low (condensed)

| # | Title | Class | Location |
|---|-------|-------|----------|
| L-a | LIF matcher kickback paid on direct accepts & signed-offer fills, not only `matchOffers` (spec: full LIF → treasury otherwise) | Ambiguous | `OfferAcceptFacet.sol:1153` |
| L-b | Refinance-tagged offer principal is frozen; spec §3 (841) says it "can still be adjusted" | Stale spec (#595) | `OfferMutateFacet.sol:160` |
| L-c | Day-granularity rounding lets Option-2/3 replacement terms exceed the original maturity by up to ~24h | Real (minor, #1032) | `PrecloseFacet.sol:1414` |
| L-d | §8 Option 1 states unconditional full-term interest; code honors the pro-rata election (§233) | Stale spec | `LibSettlement.sol:82` |
| L-e | Partial-withdrawal HF formula (§2578) omits the liquidation-threshold weighting the code applies | Stale spec | `PartialWithdrawalFacet.sol:323` |
| L-f | Interest keeps accruing through grace on top of late fees; not in the spec's interest formula | Ambiguous (#408) | `LibEntitlement.sol:152` |
| L-g | Liquidation waterfall takes liquidator bonus + 2% handling before the lender when proceeds are short | Ambiguous (spec internally inconsistent) | `RiskFacet.sol:802` |
| L-h | Time-based default's swap liquidation pays no caller incentive (HF liq does) | Ambiguous / Phase gap | `DefaultedFacet.sol:364` |
| L-i | Zero-registered-adapters deployment reverts liquidation outright; spec says it "reaches the fallback" | Ambiguous (spec self-contradictory) | `LibSwap.sol:154` |
| L-j | Reward per-user cap uses claim-time ETH price for all historical days (drift with ETH price) | Ambiguous | `LibInteractionRewards.sol:643` |
| L-k | Min-tier anti-gaming clamp scans up to 30 days, not the configured min-history window (code stricter) | Stale spec / hardening | `VPFIDiscountAccumulatorFacet.sol:375` |
| L-l | KYC transaction value sums liquid principal + liquid collateral; §16 headline says principal-only | Ambiguous (retail-dormant) | `LibCompliance.sol:56` |
| L-m | Governance can raise max loan duration to ~12 years (`_CEIL = 4385`) vs the 1–365-day product bound | Ambiguous | `LibVaipakam.sol:403` |
| L-n | Allocation table sums to 101% / 232.3M against the 230M hard cap; per-bucket caps unenforced on-chain | Stale spec (acknowledged) | `VPFIToken.sol:65` |
| L-o | Founder/Team vesting: §3 ("12mo cliff + 36mo") vs §3a ("1yr cliff + 4yr") are internally inconsistent; code = 4yr/1yr-cliff | Ambiguous | `DeployFounderVesting.s.sol:36` |

---

## Informational / stale-doc (behaviour conforms; documentation lags)

- **Yield-fee base includes late fees**; §5 says "interest" (late fees are lender yield economically). — `RepayFacet.sol:297`
- **§4a reporter payload** describes one combined chain-interest number; code tracks lender/borrower separately (required for the 50/50 split). Spec is internally inconsistent.
- **Stale NatSpec** describing "time-weighted average across the loan's lifetime" for the discount, while the implementation (T-087) reads the instant canonical tier at settlement (which current §6 mandates). — `LibVPFIDiscount.sol`
- **NFT-rental default buffer → treasury**: §7 "Processes" bullet says the full prepayment incl. buffer goes to the lender, but the §7 example says buffer → treasury; code follows the example. Spec self-contradicts. — `DefaultedFacet.sol:612`
- **Hard-coded numeric literals** (`365`, `100/50/500/10000`) where §6 mandates named constants (`DAYS_PER_YEAR`, BPS constants). — `LibPeriodicInterest.sol:31`, `LibVaipakam.sol:6046`
- **Partial-liquidation bounds**: spec's "launch bounds 2%/75%" are not on-chain (default cap 100%, no min knob); likely keeper-config. — `RiskFacet.sol:1093`
- **Signed-offer partial-fill remainder** tracked on-chain (`signedOfferFilled`), not "off-chain" as §3 (313) states. Code is stronger.
- **Depth-tiered regime** relaxes the init HF floor to 1.0 (kill-switched, off by default); §3–§5 don't mention it or the [1.2, 2.0] tunability.
- **§10 deployment step 6** still names "mirror-chain buy-adapter rate limits" — the buy adapter was removed (#687-A); the real surface is `VpfiPoolRateGovernor` TokenPool limits.
- **Stale code NatSpec** referencing the removed `VPFIBuyAdapter` and retired LayerZero/OFT terminology (which §10 forbids in generated docs). — `LibVaipakam.sol:2792`, `OracleAdminFacet.sol:118`, `LibKeeperReward.sol:33`, `VPFITokenFacet.sol:22`
- **Dead `MIN_LIQUIDITY_PAD`** + stale "$1M depth-at-tick" comment (rework landed); the slippage-at-floor gate now implements §1 correctly. — `LibVaipakam.sol:115`
- **Stale CLAUDE.md constants**: "$1M volume" liquidity criterion and `KYC_THRESHOLD_USD = 2000e18` no longer exist (actual KYC tiers $1k/$10k). NOT covered by the PR #1011 spec updates — CLAUDE.md still carries both; tracked on open card #1018 (CLAUDE.md staleness).
- **Rollout chain list** conflict: TokenomicsTechSpec §10 lists Polygon; CLAUDE.md lists BNB/Base (no Polygon). Code is chain-agnostic (config-driven).
- **Initial-mint recipient / minter** not required to be a contract (`code.length > 0`); §11/§2 expect a Safe/timelock, not an EOA. Cheap hardening.
- **Sale price** hard-pinned to exactly the outstanding principal; §9's "typically the outstanding principal" flexibility and the "Liam pays the remainder directly" branch are implemented as a revert (net-settlement-only).
- **Stale facet NatSpec**: `PrecloseFacet.sol:44` claims "all three options support NFT rentals"; code (and spec §1485) restrict offset to ERC-20.
- **Known prior-audit items re-observed on `main`**: VPFIToken pause is owner-only, no guardian (#937); treasury-yield `harvestInterest` declared but not implemented (#962).

---

## Verified conformant (spot-checked, no divergence)

The code faithfully implements the spec across a large surface, including:

- **Tokenomics numbers** — every headline value matches exactly: 230M cap /
  23M initial (10%) / 69M interaction pool (30%), emission schedule
  (32/29/24/20/15/10/5/5% with the exact day cutoffs), 50/50 lender/borrower
  split, 500 VPFI/ETH cap, 1% yield fee, 0.1% LIF, 1% matcher share, tier table
  (100/1k/5k/20k → 10/15/20/24%), TWA knobs (7 recent × weight 3 over 30 days,
  3-day min-history, 60-day mirror max-age), day-0 exclusion. Staking-yield
  program genuinely removed.
- **Oracle stack** — hybrid direct-feed → asset/ETH×ETH path, PAD pivot,
  per-feed staleness override + min-answer floor, 2h/25h peg-aware staleness,
  Soft 2-of-N Tellor/API3/DIA quorum with the exact accept/revert rules, Pyth
  cross-check, and every bounded knob in §202-211 matching code bounds.
- **Liquidity classification** — fail-closed on sequencer/oracle/pool failure,
  slippage-at-floor ($5k @ 2%) over the V3 fee tiers (1% correctly excluded) and
  V2 forks, two manipulation guards, no Ethereum-mainnet fallback, WETH
  special-casing.
- **HF/LTV machinery** — admission floor [1.2e18, 2.0e18] default 1.5e18,
  snapshotted per loan, tier safety boxes / haircuts / discounts exact.
- **Offer/loan lifecycle** — consent-before-vault-movement, escrow lien
  lock-step, fill modes (Partial/AON/IOC), GTT expiry, rate model with ±deviation
  clamp, Permit2 + classic, signed offers (replay ledger, ERC-1271), parallel
  sale, self-trade rejection, previews.
- **Repayment/liquidation** — late-fee schedule (1% day-1, +0.5%/day, 5% cap),
  fallback three-way split (principal+accrued+3% / 2% / remainder), dynamic
  liquidator incentive (6%−slippage capped 3%) on the HF-based and split-route
  liquidation paths, split-route liquidation, partial-repay/partial-liquidation
  guards, periodic interest, yield-fee snapshot at origination, NFT-gated
  claims. Explicitly EXCLUDED from this bullet (it carries a finding above):
  the time-based-default swap path, which pays NO caller incentive (L-h,
  #1010).
- **Preclose/early-withdrawal/refinance/consolidation — verified subpaths
  only** — Option 1 (direct) and Option 2 (obligation-transfer) settlement
  splits and continuity, §9 sale flows, refinance principal carry-over (#411
  no shortfall top-up), consolidation eager/lazy rules, addCollateral cure.
  Explicitly EXCLUDED from this bullet (they carry findings above): Option 3
  offset's Step-1 payment timing and cancel unwind (S3), reward-entry closure
  on preclose/refinance (S5), and refinance's interest-mode handling (S7).
- **Compliance** — KYC pass-through dormant-by-default, retail `canTradeBetween`
  pure-true with the gated variant kept separate, sanctions Tier-1/Tier-2 split,
  proceeds vault-lock, current-holder screening, ToS gate.
- **Cross-chain** — CCIP messenger allowlists + one-to-one maps + guardian
  pause, mirror-token pool-only mint, rate governor refuse-disable + bounds,
  pull-only reward claims + transparency views.

---

## Recommended actions (status as of 2026-07-05 — decisions recorded, cards filed)

Every High/Medium finding has an owner decision recorded in
`docs/FunctionalSpecs/_CodeVsDocsAudit.md`: the code-fix items sit under its
**Open findings** table with their card refs (the fixes have NOT landed),
while the spec-update items (S6, S14, S16, S17, S18, S19, L-f, L-l, L-m)
have moved to its **Resolved findings** table, closed by the PR #1011 spec
update (merged 2026-07-05). The code-fix cards are filed under umbrella
**#998**. Remaining state:

1. **Code-fix cards filed (umbrella #998) — fix before origination volume /
   mainnet:** S1 → #999 (tier gradient inversion — live on every loan),
   S2 → #1000 (fallback repay-cure), S3 → #1001 (offset double-pay),
   S4 → #1002 (reward claim while open), S5 → tracked on existing #969
   (preclose/refinance reward closure), S7 → #1003 (decided: mode-aware
   refinance interest), S8 → #1004 (NFT late-fee base), S9 → #1005 (empty
   try-list forced fallback), S10 → #1006 (decided: partial — only the
   locked-proceeds release gate fails closed; normal claims stay fail-open),
   S11 → #1007 (decided: gate Tier 1 on the $50k probe), S12 → tracked on
   existing #915 (forced-close `interestSettled`), S13 → #1008 (decided:
   per-day cap), S15 → with existing #900 (range-mutate checks),
   L-c → #1032 (day-granularity rounding on Option-2/3 replacement terms),
   L-g → #1009 (decided: subordinate the 2% treasury handling fee to full
   lender recovery; keep the liquidator bonus), L-h → #1010 (dynamic
   incentive on the time-based-default swap path).
2. **Spec updates — merged in PR #1011 (2026-07-05):** S6 (365-day loans keep
   30-day grace — owner decision KEEP CODE), S14 (HF formula + example),
   S16 (peer tolerance), S17 (keeper-init model ratified; execution matrix
   fixed), S18 (tier-LTV fallback), S19 (insurance surplus stays
   dormant/operational on retail), L-f (grace-period interest accrual
   documented — owner decision KEEP CODE), L-l, L-m, plus the Informational
   stale-doc cluster. The whitepaper v4 rewrite merged separately as
   PR #1015.
3. **CLAUDE.md constants — NOT resolved:** the stale "$1M volume" liquidity
   criterion and `KYC_THRESHOLD_USD = 2000e18` are still present in
   CLAUDE.md (PR #1011 did not touch it); tracked on open card **#1018**
   (CLAUDE.md staleness — its scope now includes these constants).
4. **Still needs owner adjudication:** L-i (zero-registered-adapters
   deployment reverts liquidation outright vs the spec's "reaches the
   fallback" — the spec is self-contradictory here), plus any remaining
   Low/Informational "Ambiguous" items without a recorded decision
   (L-a, L-j, L-o).

This spec-conformance pass complements the 2026-07-02/03 security audit and the
economic model; together they cover the code's *exploitability*, its *economics*,
and its *fidelity to intent*. It remains pre-audit hardening — a professional
human audit + fuzzing/formal campaign is still warranted before mainnet.

---

## Status update — 2026-07-11 (all code fixes merged; umbrella #998 complete)

Every code-fix card filed under umbrella **#998** is now **merged and closed**:

- **High:** S1 #999, S2 #1000, S3 #1001, S4 #1002, S5 #969 — all closed.
- **Medium:** S7 #1003, S8 #1004, S9 #1005, S10 #1006, S11 #1007, S12 #915,
  S13 #1008, S15 #900 — all closed.
- **Low:** L-g #1009, L-h #1010, L-c #1032 — all closed.

The reward-accounting cluster (S4 #1002 / S5 #969 / S13 #1008) was completed by
the **interaction-reward terminal close-out** (#1067, merged) — every loan
terminal now closes reward entries durably and re-anchors each open entry to the
live position-NFT holder, and the per-user cap is enforced per day (Option B:
threshold snapshotted at day finalisation and broadcast canonically).

**Spec-update items** (S6, S14, S16–S19, L-f, L-l, L-m) were closed by the
spec-reconciliation **PR #1011** and the whitepaper-v4 rewrite **PR #1015**.

**The "still needs owner adjudication" set is now DECIDED (owner, 2026-07-11)** —
each recorded in `docs/FunctionalSpecs/_CodeVsDocsAudit.md` (Resolved findings)
and its card closed:

- **L-a → #1159 — KEEP CODE / update spec.** The `1%` LIF matcher share is paid
  to the transaction submitter on *every* initiation path (relayer on
  `matchOffers`; `msg.sender` on a direct accept / signed-offer fill), treasury
  keeps the complementary `99%`. TokenomicsTechSpec §5a reworded.
- **L-i → #1158 — KEEP CODE / update spec.** A zero-registered-adapter
  deployment must fail loud (revert), not silently reach the in-kind fallback.
  ProjectDetailsREADME §7 clarified (≥1 registered adapter + non-empty enabled
  try-list required; fallback is per-loan, only after configured routes fail).
- **L-j → #1160 — RESOLVED BY #1008.** The per-day cap now prices at day
  finalisation (Option B), so no claim-time drift; no residual change.
- **L-o → #1161 — KEEP CODE.** The standard 4-yr linear / 1-yr-cliff schedule
  (25% at the cliff, inclusive) is intended; the specs (TokenomicsTechSpec
  §3/§3a + ProjectDetailsREADME) already document it — no residual spec edit.

**Documentation follow-up:** #1018 (CLAUDE.md staleness — the removed
`VpfiBuyAdapter` surface described as live, the Phase-1 chain scope listing BNB
instead of Polygon, the stale `"$1M volume"` liquidity criterion and
`KYC_THRESHOLD_USD = 2000e18` constant, and the deployments omit-keys section's
dead buy-surface keys) was fixed and merged in **PR #1163**.

With the four adjudications above recorded, the 2026-07-05 spec-vs-code
conformance review is **fully closed out** — every finding has landed as a code
fix, a spec update, or a recorded owner decision.

**Related, not a #998 child:** #940 (dashboards omit `FallbackPending` loans —
a contract-side `MetricsDashboardFacet` filter bug surfaced on the apps/defi
dashboard) remains open as a separate UX card.

With that, umbrella **#998 is complete** — all conformance-review code fixes are
on `main`. The pre-audit-hardening caveat above still stands.
