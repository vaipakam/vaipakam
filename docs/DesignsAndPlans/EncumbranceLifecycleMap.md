# Encumbrance Lifecycle Map (T-407 / #569)

**Status:** Design — implementation-ready once reviewed.
**Supersedes the wire-as-you-go approach of closed PR #567.**
**Source of truth for intent:** `docs/FunctionalSpecs/ProjectDetailsREADME.md`
§§5–9 + "Phase 1 Additions" + the post-Phase-1 design docs
(`NFTCollateralSaleAndAuction.md`, `PerLoanCollateralLien.md`,
T-090 swap-to-repay, T-092 atomic-refinance). This map is sourced from
the **intended** lifecycle in those documents and then matched to code
call sites — never transcribed from the code.

---

## 1. The one invariant

> **A borrower's vaulted assets that back a live loan must never leave the
> borrower's vault except through a protocol flow that first adjusts the
> encumbrance ledger.** No unrelated withdraw surface may drain
> loan-backing collateral.

The withdraw guard added in PR #567 (`VaultFactoryFacet._assertWithdrawAllowed`
→ `LibEncumbrance.freeBalance = rawBalance − encumbered[user][asset][tokenId]`)
enforces this at the chokepoint. The guard is correct; what PR #567 got
wrong was treating the lien as "create-at-init, release-at-terminal." The
lien is actually a **running balance that must track `loan.collateralAmount`
(or, for rentals, the prepay+buffer pool) through every state change.**

The `encumbered[user][asset][tokenId]` aggregate is the **single source
of truth**. Every surface that can move a borrower's assets out of their
vault — including the VPFI staking-unwind path (§6, finding F-1) — must
consult it.

---

## 2. Lien shape per loan kind

| Loan kind | Collateral identity | Liened asset | Lien amount basis |
|-----------|--------------------|--------------|-------------------|
| ERC-20 loan, ERC-20 collateral | `(borrower, collateralAsset, 0)` | `collateralAsset` | `loan.collateralAmount` |
| ERC-20 loan, ERC-721 collateral | `(borrower, collateralAsset, collateralTokenId)` | the NFT | `1` |
| ERC-20 loan, ERC-1155 collateral | `(borrower, collateralAsset, collateralTokenId)` | the NFT | `loan.collateralQuantity` |
| NFT rental | — **NOT liened** (see D-1) | — | — |

**Decision D-1 — NFT rentals are NOT liened (RESOLVED 2026-06-13, owner).**
Earlier drafts liened the rental prepay+buffer pool, but that forced a
decrement wire at every legitimate rental drain (daily deduction, partial
repay, default, preclose) — a large wire surface whose *only* purpose was
to close one hole: `withdrawVPFIFromVault` draining the pool when
`prepayAsset == VPFI`. That hole is closed far more cheaply by a one-line
gate (D-2) instead of a continuous-drain lien.

Why rentals don't need the lien:
- **Non-VPFI prepay (USDC / WETH / DAI / …)** has NO vault-side unstake
  door. The rental-deduction mechanism (`autoDeductDaily` / `repayPartial`)
  is the *only* mover of the prepay pool, and it's intrinsic to the loan.
  Already safe with zero new wires.
- **VPFI prepay** is the only drainable case — and it's eliminated by D-2.

**Decision D-2 — VPFI may NOT be a rental prepay asset (RESOLVED
2026-06-13, owner).** A one-line gate at offer-create / loan-init for the
NFT-rental path rejects `prepayAsset == VPFI`. Spec-consistent:
ProjectDetailsREADME §"Collateral for NFT Renting" requires the prepayment
be "denominated in ERC-20 tokens" but never mandates VPFI; paying rent in
USDC vs VPFI is a trivial UX difference and borrowers still hold VPFI for
fee discounts. This collapses the rental-lien question entirely.

Net effect: the lien is **ERC-20-and-NFT *collateral* on actual loans
only** — create/release plus a few slice/topup paths. The continuously-
draining rental pool never enters the ledger.

---

## 3. Lien operations (the verbs)

| Op | When | Effect on `encumbered` + lien row |
|----|------|-----------------------------------|
| **create** | `LoanFacet.initiateLoan` | new row + aggregate `+= amount` |
| **release** | loan reaches a terminal status (Repaid / Defaulted / Settled / InternalMatched) | aggregate `-= row.amount`, tombstone row |
| **decrement(consumed)** | loan stays Active but `collateralAmount` shrinks (slice sold, rent consumed) | aggregate `-= consumed`, `row.amount -= consumed` |
| **increment(added)** | loan stays Active and `collateralAmount` grows (top-up, partial-fill refund) | aggregate `+= added`, `row.amount += added` |
| **recreate** | FallbackPending → Active cure restores collateral | overwrite row from `loan`, aggregate `+= amount` |
| **rekey** | loan continues under a new borrower / new collateral identity | release old key + create new key |

**Ordering rule (load-bearing):** every op that frees vault balance
(`release` / `decrement` / `rekey`'s release-leg) MUST run **before** the
`vaultWithdraw*` it unblocks, in the same transaction. Revert safety:
the op's storage write rolls back with any downstream revert, so the lien
only changes when the move actually commits. `increment`/`recreate` may
run after their paired deposit.

---

## 4. Master site inventory

Every `vaultWithdrawERC20/721/1155` site in `contracts/src/`, classified.
**Protective** = the lien must be adjusted. "Status" = whether the target
state was reached on closed PR #567's branch (`feat/407-pr4-withdraw-guard`)
— the re-implementation against this map starts from a clean main, so
"wired" rows are *reference designs* to port, "MISSING"/"BUG" rows are
*new work*.

### 4.1 Protective sites — terminal release

(Only ERC-20-loan **collateral** sites — rental-prepay sites are
non-protective under D-1, see §4.6.)

| Site | Function | Loan transition | Op | Status |
|------|----------|-----------------|----|--------|
| `RefinanceFacet:468,480,491` | `_refinanceLoanLogic` (old loan; ERC20 + NFT collateral) | Active→Repaid | release | wired ✓ |
| `SwapToRepayFacet:291` | `swapToRepayFull` (ERC20 collateral) | Active→Repaid | release | wired ✓ |
| `DefaultedFacet:315,458,473,484` | `triggerDefault` (ERC20 + NFT collateral) | Active→Defaulted | release | wired ✓ |
| `RiskFacet:591` | `triggerLiquidation` (external branch) | Active→Defaulted | release (AFTER auto-dispatch returns false) | wired ✓ |
| `RiskFacet:887` | `triggerLiquidationSplit` | Active→Defaulted | release | wired ✓ |
| `RiskFacet:1608` | `triggerLiquidationDiscounted` | Active→Defaulted | release | wired ✓ |

> Note: `RepayFacet` ERC-20 terminal and `PrecloseFacet` ERC-20 terminal
> do NOT have a co-located withdraw — ERC-20 collateral stays in the
> borrower vault and is recorded as a `borrowerClaim`, withdrawn later by
> `ClaimFacet`. The release still fires at the terminal (tracking the
> loan closing, not the withdraw). `ClaimFacet`'s later withdraw runs
> against an already-released lien — see §4.5. The ERC-20 `repayLoan` /
> `precloseDirect` releases stay wired even with no co-located withdraw.

### 4.2 Protective sites — slice decrement (loan stays Active)

(ERC-20-loan **collateral** slices only. The rental-prepay slices
`RepayFacet:792,803,892,903` are non-protective under D-1 — see §4.6.)

| Site | Function | Slice basis | Op | Status |
|------|----------|-------------|----|--------|
| `RepayFacet:1279` | `_autoLiquidatePeriodShortfall` (ERC20 periodic interest) | `toSell` | decrement | wired ✓ |
| `RiskFacet:1190` | `triggerPartialLiquidation` | `swappedCollateral` | decrement | wired ✓ |
| `SwapToRepayFacet:550` | `swapToRepayPartial` | `collateralSwapAmount` (− partial-fill refund increment) | decrement + increment | wired ✓ |
| **`PartialWithdrawalFacet:107`** | **`partialWithdrawCollateral`** | **`amount`** | **decrement** | **MISSING ❌** |

### 4.3 Protective sites — top-up increment / recreate

| Site | Function | Op | Status |
|------|----------|----|--------|
| `AddCollateralFacet:133` | `addCollateral` (Active branch; `vaultDepositERC20`) | increment | wired ✓ |
| `AddCollateralFacet:222` | `_cureFallback` (FallbackPending→Active) | recreate | wired ✓ |

### 4.4 Protective sites — temporary custody + rekey + ordering bug

| Site | Function | Issue | Required design | Status |
|------|----------|-------|-----------------|--------|
| **`SwapToRepayIntentFacet:543`** | **`commitSwapToRepayIntent`** | full collateral pulled to diamond while loan stays Active; returns on cancel, closes on fill | **decrement at commit; increment-restore on every teardown path (`cancelIntent`/`cancelExpired`/force-cancel); release on fill-settlement (lives in `LibSwapToRepayIntentSettlement`/`IntentDispatchFacet`)** | **MISSING ❌** |
| **`RiskMatchLiquidationFacet:383,398`** | **`_settleLeg` (Active leg)** | lien op in `_settleFallbackOrTransitionPostMatch` runs AFTER the withdraw → guard reads un-decremented lien → revert | **hoist the per-leg lien op (release on full / decrement on partial) to BEFORE `_settleLeg`'s withdraw, keyed to the loan whose collateral the leg consumes** | **ORDERING BUG ❌** |
| **`PrecloseFacet:535,546,557`** | **`transferObligationViaOffer`** | old borrower's collateral returned, loan continues under new borrower | **rekey: release old borrower's lien before the withdraw; create the new borrower's lien (the new collateral enters via the offer-accept deposit, so the create may belong at the obligation-transfer accept, not here)** | **MISSING ❌** |

### 4.5 Non-protective — `ClaimFacet` (lien already released upstream)

`ClaimFacet.claimAsLender` (272,284,295,315,329,340) and
`claimAsBorrower` (450,461,472) all run AFTER a terminal that already
released the lien (`RepayFacet`/`DefaultedFacet`/`RiskFacet`). The
collateral-return withdraws hit an already-released aggregate → guard
passes → **no lien op in ClaimFacet.** Lender claim-payouts withdraw from
the lender's OWN vault (never borrower collateral). The VPFI rebate at
:493 is a diamond `safeTransfer`, not a vault withdraw.

> **Stale-doc fix:** `LoanFacet.createCollateralLien` natspec currently
> names `ClaimFacet.claimAs*` among the lien release/rekey terminals.
> That is wrong — `ClaimFacet` never touches the lien (release is strictly
> upstream). Correct the comment during implementation. (`VaultFactoryFacet`'s
> comment already lists the right terminal set.)

### 4.6 Non-protective — fees, rewards, lender flows, offer stage

| Site(s) | Why not protective |
|---------|-------------------|
| `AutoLifecycleFacet:811` | withdraws lender accrued interest (`principalAsset`), collateral never moves |
| `EarlyWithdrawalFacet:215,244,262,596` | lender-principal / `heldForLender` migration on loan sale; live-loan collateral never moves |
| `EarlyWithdrawalFacet:647,659,672` | sale-vehicle temp-loan collateral return; **latent** — vehicle posts 0 collateral today so dormant; add a defensive `release(tempLoanId)` in teardown (§7 step 9) |
| `LibNotificationFee:158` | small watcher-fee charge, not collateral |
| `LibVPFIDiscount:561` | borrower-LIF escrow to diamond (own lifecycle), not collateral |
| `LibVPFIDiscount:762` | lender-yield-fee from lender vault, not borrower collateral |
| `OfferAcceptFacet:417,802,817,838` | offer→loan boundary, BEFORE `initiateLoan` creates the lien; 802/817/838 are lender-principal (T-407-C) |
| `OfferCancelFacet:237,249,260,298,310,321,342` | offer-stage refunds of the *unfilled* remainder; filled slices are deliberately excluded; 237/249/260 are lender-principal (T-407-C) |
| `OfferMatchFacet:330,367,421` | post-match offer-stage dust refunds; 367 is lender-principal (T-407-C) |
| `OfferMutateFacet:657` | open-offer modify-time delta refund; no loan exists (when modifying a *lender* offer this touches lender-principal → T-407-C) |
| `LibOfferMatch:129` (`splitLifToMatcher`) | **dead code** (no caller; logic inlined in `OfferAcceptFacet`); if revived, lender-principal (T-407-C) |
| **NFT-rental prepay drains** — `RepayFacet:462,475` (`repayLoan`), `RepayFacet:792,803` (`repayPartial`), `RepayFacet:892,903` (`autoDeductDaily`), `PrecloseFacet:317,337` (`precloseDirect` NFT branch), `DefaultedFacet:535,552` (`triggerDefault` NFT branch) | **Non-protective under D-1** — rentals aren't liened. The prepay pool moves ONLY through these intrinsic rental-deduction paths; non-VPFI prepay has no side door, and VPFI prepay is forbidden by D-2. No lien op anywhere on the rental path. |

> **What D-1 removed:** earlier drafts marked the rental drains above as
> protective (terminal-release on the close paths, slice-decrement on the
> daily/partial paths) plus a special "buffer-release edge" on
> `autoDeductDaily`'s final day. All of that is gone — rentals never enter
> the ledger, so there is nothing to release, decrement, or zero. This is
> the single biggest simplification D-1 + D-2 buy.

---

## 5. Offer-principal lock is a SEPARATE ledger (T-407-C, #566)

The 7 lender-principal sites tagged above (offer escrow consumed at
accept/match, refunded at cancel/dust-close) belong to the **offer-principal
lock** — a different sub-ledger keyed by `offerId`, not `loanId`. It is
out of scope for this map. The borrower-side offer-collateral refunds
(excess above the committed slice) are a *potential third* sub-ledger
("borrow-offer collateral lock") but the spec does not currently require
protecting pre-loan borrow-offer collateral from an unrelated drain, so
they stay unliened for now. Flagged for the owner: if borrow-offer
collateral should be protected pre-loan, that's a fourth surface.

---

## 6. Bugs surfaced vs FunctionalSpec

Mapping the lifecycle against the spec surfaced one **current** divergence
(exists on `main` today, independent of the encumbrance work) and several
**future-correctness** requirements (only manifest once the guard is live).

### F-1 — `withdrawVPFIFromVault` bypasses collateral protection (CURRENT, TRIAGED 2026-06-13: code-wrong)

**Spec:** ProjectDetailsREADME §"Allow Borrower to Withdraw Excess
Collateral (Health Factor)" — a borrower may withdraw collateral **only**
down to the health-factor floor, through the risk-checked withdrawal path.
The implied invariant: collateral backing a live loan is not freely
withdrawable.

**Code:** `VPFIDiscountFacet.withdrawVPFIFromVault` unstakes VPFI from the
caller's vault guarded **only** by `IERC20(vpfi).balanceOf(vault) >= amount`
+ the staking `protocolTrackedVaultBalance` counter (a yield-accounting
figure, NOT a collateral lien). VPFI is a liquid ERC-20 (it has the
Chainlink path used across `LibVPFIDiscount`), so a borrower may post VPFI
as ERC-20 collateral. Because that collateral stays in the borrower's
vault (the whole premise of the lien — borrowers add/withdraw collateral
via `AddCollateralFacet` / `PartialWithdrawalFacet`),
`withdrawVPFIFromVault` can drain it to the borrower's wallet with **no HF
check and no revert**, leaving the loan under-collateralized. The proper
collateral-exit door (`PartialWithdrawalFacet`) enforces the HF gate; the
staking-unwind door does not.

**Owner triage (2026-06-13): VPFI IS collateral-eligible — code is wrong,
fix it.** Reasoning: Vaipakam is P2P. The own-token-collateral reflexivity
death-spiral that bars this in *pooled* protocols (Aave/Venus — bad debt
socializes, liquidations cascade across all depositors) does not exist
here. Each loan is bilateral; a lender who accepts VPFI collateral prices
and bears that specific risk — same principle the spec already states for
NFT collateral ("the decision to accept such terms rests entirely with the
borrower"). So VPFI-as-collateral is a real value-add (token utility,
borrowing capacity) and is safe under P2P + lender discretion. The fix is
the encumbrance consult, NOT a collateral-eligibility carve-out.

**Severity:** High (theft-of-collateral-backing / under-collateralization
vector). Gated on VPFI actually being used as ERC-20 collateral, so latent
until that happens, but it is a real spec violation present today.

**Fix:** `withdrawVPFIFromVault` must subtract the caller's VPFI
encumbrance from the withdrawable amount —
`require(prevBal - encumbered[msg.sender][vpfi][0] >= amount)` — i.e. route
through the SAME `LibEncumbrance.freeBalance` the dedicated collateral
paths use. **Scope: VPFI-as-ERC-20-collateral only** (rentals don't lien,
per D-1, and VPFI rental prepay is forbidden by D-2, so there's no rental
VPFI to protect). One implementation nuance: the consult must leave the
staking-checkpoint / time-weighted-discount accumulator math intact when a
withdraw is partially blocked — guard the *amount*, don't corrupt the
checkpoint.

→ Logged to `docs/FunctionalSpecs/_CodeVsDocsAudit.md` (triaged: code-wrong);
bug card #570.

### F-2..F-6 — future-correctness lien wiring (not current bugs)

These only break once the withdraw guard is live; on today's `main`
(no guard) they function. They are *requirements for the
re-implementation*, captured in §4: `PrecloseFacet` NFT-rental release
(§4.1), `DefaultedFacet` rental-prepay release (§4.1), `PartialWithdrawalFacet`
decrement (§4.2), `SwapToRepayIntentFacet` temporary custody (§4.4),
`RiskMatchLiquidationFacet` ordering (§4.4), `transferObligationViaOffer`
rekey (§4.4), `autoDeductDaily` buffer release (§4.6). Not logged as
audit divergences because the spec describes intended behaviour the code
*will* satisfy once wired — they're implementation gaps in unshipped work,
not shipped-code-vs-spec divergences.

---

## 7. Implementation plan (single coherent PR against this map)

Ordered so each step leaves a consistent state:

1. **Ledger surface** — confirm `LibEncumbrance` has
   `create/release/decrement/increment/recreate/rekey` + the
   `EncumbranceMutateFacet` cross-facet wrappers + selector wiring
   (DeployDiamond/HelperTest). (`rekey` is the only new verb vs PR #567.)
2. **D-2 gate** — reject `prepayAsset == VPFI` at offer-create /
   loan-init for the NFT-rental path. One guard; unblocks D-1.
3. **Create** at `LoanFacet.initiateLoan` for **ERC-20-loan collateral
   only** (ERC-20 + NFT collateral; NOT rentals, per D-1).
4. **Terminal releases** — §4.1 (ERC-20-collateral sites; all already
   wired in #567 — port them).
5. **Slice decrements** — §4.2 (incl. the MISSING PartialWithdrawalFacet).
6. **Top-up / recreate** — §4.3 (port from #567).
7. **Temporary custody** — §4.4 SwapToRepayIntentFacet (commit decrement +
   teardown restore + fill release in the settlement lib).
8. **Ordering fix** — §4.4 RiskMatchLiquidationFacet `_settleLeg`
   (hoist lien op before withdraw, per-leg keying).
9. **Rekey** — §4.4 transferObligationViaOffer.
10. **Cross-surface close** — F-1: route `withdrawVPFIFromVault` through
    `LibEncumbrance.freeBalance` (VPFI-as-ERC-20-collateral; leave the
    staking checkpoint intact). + defensive `release` in
    EarlyWithdrawalFacet temp-loan teardown (§4.6 latent).
11. **Guard** — enable `VaultFactoryFacet._assertWithdrawAllowed` on all
    three withdraw selectors (port from #567).
12. **Stale-doc fix** — §4.5 `LoanFacet.createCollateralLien` natspec.
13. **Tests** — one focused suite per op-class + an invariant:
    `Σ encumbered[borrower][asset][id] == Σ over-active-loans of
    lien.amount` at all times; plus a per-flow assertion that every
    `vaultWithdraw*` in §4.1–4.4 succeeds end-to-end (the regression
    PR #567 used to catch the reverts). **Rental flows assert the lien
    stays UNTOUCHED** (D-1) — a regression guard against re-liening them.

### What D-1 + D-2 removed from the plan

The rental-lien steps (terminal release on `RepayFacet`/`PrecloseFacet`
NFT branches + `DefaultedFacet` rental-prepay, slice-decrement on
`autoDeductDaily`/`repayPartial`, the buffer-release edge) are GONE. The
re-implementation touches only ERC-20-loan collateral. This is roughly
half the wire surface PR #567 was heading toward.

### Test fixtures touched

Every facet in §4.1–4.4 + `InvariantBase` + the scenario suite + the
deploy-sanity selector lists. The new sites vs #567 add
PartialWithdrawalFacetTest, SwapToRepayIntentFacetTest,
VPFIDiscountFacetTest, plus a D-2-gate test (VPFI-prepay rejected at
rental offer-create).

---

## 8. Decisions

- **D-1 (RESOLVED 2026-06-13): rentals are NOT liened.** §2. The wire cost
  of a continuously-draining rental lien isn't justified once D-2 closes
  the only hole.
- **D-2 (RESOLVED 2026-06-13): VPFI may not be a rental prepay asset.** §2.
  One-line gate; spec-consistent; closes the VPFI-rental-prepay drain
  without a lien.
- **F-1 (TRIAGED 2026-06-13: code-wrong): VPFI IS collateral-eligible;**
  fix `withdrawVPFIFromVault` with the encumbrance consult (§6).

### Still open

- **Borrow-offer collateral pre-loan (§5):** protect it or not? Spec is
  silent. If yes, a fourth lock surface (borrower-side analogue of the
  T-407-C offer-principal lock). Default: leave unprotected — pre-loan
  borrow-offer collateral is the creator's own escrow and no spec'd flow
  drains it through a side door.
