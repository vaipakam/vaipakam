# Release Notes — 2026-06-13

This release completes the **vault collateral-encumbrance** epic — the
protocol-wide guarantee that collateral backing a live loan cannot leave a
borrower's vault through any path that doesn't first account for it. It folds
together the work that built the sub-ledger and the enforcement layer: the
`EncumbranceMutateFacet` foundation (#407 PR 2) and vault-encumbrance
foundation, the unified collateral-floor model (#408/#410/#413), the
refinance over-pay correction (#411), and — the centrepiece — the full
**encumbrance enforcement and transferred-position drain-closure** (#565).

The #565 work, in particular, was re-built against a complete custody
lifecycle map and hardened across an extended review into a *structural*
guarantee, governed by a single principle: **the collateral lien's lifecycle
mirrors the borrower-position-NFT's lifecycle** — created when the position
NFT is minted, released when it is burned. That made the protection
self-enforcing rather than patched site-by-site. A handful of deliberately-
scoped follow-ups (internal-match residual claimability, the broader
transferred-position vault-authority audit, refinance collateral carry-over)
are tracked separately and remain out of scope here.

The same release extends the guarantee to the **lender side** (#566 /
T-407-C). An ERC-20 lender offer's pre-vaulted principal is now locked
against withdrawal for as long as the offer is live — the counterpart of
the borrower-collateral lock, sharing the same encumbrance aggregate and
withdraw chokepoint. The lock tracks the principal in lock-step across the
entire offer lifecycle (create, accept, cancel, lazy-expiry, partial-fill,
dust-close, loan-sale-into-a-buy-offer, and in-place size edits), so a
lender can never withdraw principal out from under an open offer. The
symmetric borrower-offer-collateral lock (#573, the pre-acceptance
VPFI-drain case) remains the next follow-up.

## Thread — #407 PR 2: EncumbranceMutateFacet foundation

Second impl PR in the vault encumbrance sub-ledger sequence. Lands the **`EncumbranceMutateFacet`** — a thin cross-facet entry that exposes `releaseCollateralLien(uint256)` so each loan-lifecycle terminal can release the lien via `LibFacet.crossFacetCall` (~50 bytes per call site) instead of inlining `LibEncumbrance.releaseCollateralLien` directly (~150 bytes per call site).

### What's new

- **`contracts/src/facets/EncumbranceMutateFacet.sol`** — new facet, `onlyDiamondInternal` gate, single selector today (`releaseCollateralLien`). Will grow with the offer-principal-lock impl PR.
- **Full 7-site facet-registration**:
  - `DiamondFacetNames.cutFacetNames()` → 52 entries (was 51); appended `"EncumbranceMutateFacet"`.
  - `DeployDiamond.s.sol` → import + construct + cut at `cuts[51]` + `_getEncumbranceMutateFacetSelectors()` helper + `Deployments.writeFacet`.
  - `HelperTest.sol` → mirror import + facet var + `getEncumbranceMutateFacetSelectors()` helper.
  - `SetupTest.t.sol` → import + facet var + construct + cuts[52] wire (was 52 entries; now 53 with the test-only `TestMutatorFacet`).
  - `SelectorCoverageTest.t.sol` → `_addAll(_getEncumbranceMutateFacetSelectors())`.
  - `FacetSizeLimitTest.t.sol` + `SelectorCoverageTest.t.sol` + `DeployDiamondIntegrationTest.t.sol` → `string[51]` → `string[52]` for `cutFacetNames()` returns.

### Why the release wires are NOT in this PR

The 9 per-facet integration tests (`RepayFacetTest`, `RefinanceFacetTest`, `PrecloseFacetTest`, `ClaimFacetTest`, etc.) each maintain their own minimal-cut `setUp()` (typically 14-20 facets, not all 52). When `RepayFacet.repayLoan` calls `crossFacetCall(EncumbranceMutateFacet.releaseCollateralLien.selector, ...)`, those tests' minimal cuts don't include `EncumbranceMutateFacet` → the diamond fallback fires `FunctionDoesNotExist`.

Updating all 9 test-fixture cut blocks (add facet construction + array-size bump + cut entry per file) is a focused mechanical change that warrants its own scoped PR (PR 3). This PR delivers the **facet foundation + registration** so PR 3 can drop in the release call sites + fixture updates without bouncing between concerns.

### Tradeoffs

- **What this PR enables**: any future code (offer-principal-lock impl, withdraw guard, third-party integrations) can now `crossFacetCall` to release a collateral lien with one stable selector.
- **What's still deferred to PR 3**: the actual release call sites at `RepayFacet.repayLoan` / `PrecloseFacet.precloseDirect` / `RefinanceFacet._refinanceLoanLogic` / `ClaimFacet.claimAs*` — alongside the matching 9 test-fixture updates.

### Verification

- forge build clean.
- All 12 deploy-sanity tests pass (DiamondFacetNames + FacetSizeLimitTest + SelectorCoverageTest + DeployDiamondIntegrationTest).
- 277/277 broader regression (RepayFacetTest 65 + RefinanceFacetTest 36 + PrecloseFacetTest + LoanFacetTest + DefaultedFacetTest + T092AutoLifecycleIntegrationTest 22) — no regressions.
- ABI re-export ran.

### Pre-live posture

Per user direction (2026-06-12): pre-live → no ABI back-compat. The new facet + selector cut is an accepted facet-refresh cost.

### Out of scope (PR 3+)

- Release wires at `RepayFacet.repayLoan` / `PrecloseFacet.precloseDirect` / `RefinanceFacet._refinanceLoanLogic` / `ClaimFacet.claimAs*` (cross-facet calls).
- 9 per-facet test-fixture updates to include `EncumbranceMutateFacet` in their minimal cuts.
- Withdraw guard at `VaultFactoryFacet.vaultWithdrawERC20`.
- Offer-principal-lock impl (§7 of design doc).

## Thread — #407 vault encumbrance sub-ledger — foundation + collateral lien (PR 1 of N)

First implementation PR for the unified vault encumbrance sub-ledger described in [`docs/DesignsAndPlans/PerLoanCollateralLien.md`](docs/DesignsAndPlans/PerLoanCollateralLien.md). Scoped per design doc §7.5 (recommended impl sequencing): collateral-lien half lands first; offer-principal-lock half is a separate follow-up PR.

### What's new — storage

- **`LibVaipakam.Encumbrance` struct** — one row per active lien (asset, tokenId, amount, kind via per-side mapping, released tombstone).
- **`LibVaipakam.Storage.loanCollateralLien[loanId]`** — per-loan collateral lien row.
- **`LibVaipakam.Storage.encumbered[user][asset][tokenId]`** — running aggregate that the withdraw guard (separate PR) will consult to compute `freeBalance = balanceOf − Σ liens`.
- **`LibVaipakam.Storage.offerPrincipalLien[offerId]`** — pre-allocated for the offer-principal-lock impl PR; this PR doesn't write to it.

### What's new — library

**`LibEncumbrance`** — `internal`-only helpers operating directly on storage:

- `createCollateralLien(loanId, loan)` — call from `LoanFacet.initiateLoan` after the loan row is final.
- `releaseCollateralLien(loanId)` — call from every loan-lifecycle terminal that frees the collateral. **Idempotent** on already-released or empty rows.
- `rekeyCollateralLienOnRefinance(oldLoanId, newLoanId, newLoan)` — handles refinance's release-old + create-new pattern in one helper.
- Offer-principal half (`createOfferPrincipalLien` / `decrementOfferPrincipalLien` / `releaseOfferPrincipalLien`) — implemented but not yet wired; activates in the follow-up offer-principal-lock impl PR.
- `freeBalance(user, asset, tokenId, rawBalance)` — saturating `raw − encumbered` view helper.

### Hook wiring (this PR — partial coverage)

- **Create**: `LoanFacet.initiateLoan` calls `createCollateralLien` after `_emitLoanInitiatedDetails`.
- **Release on default**: `DefaultedFacet.triggerDefault` calls `releaseCollateralLien` right after the `transitionFromAny(Defaulted)` flip.

### What's INTENTIONALLY NOT wired in this PR

- **Release on Repaid** (`RepayFacet.repayLoan`): RepayFacet sits at the EIP-170 24,576-byte ceiling — adding the release call pushes it 151 bytes over. The lien tombstones via the eventual Settled transition (`ClaimFacet`) on a follow-up PR.
- **Release on preclose** (`PrecloseFacet.precloseDirect` + sale-vehicle / offset paths): same EIP-170 concern; follow-up.
- **Re-key on refinance** (`RefinanceFacet._refinanceLoanLogic`): same EIP-170 concern; follow-up.
- **Release on claim** (`ClaimFacet`): follow-up.
- **Withdraw guard** at `VaultFactoryFacet.vaultWithdrawERC20`: touches every facet's vault interactions — warrants its own focused PR.
- **Offer-principal-lock half** (§7 of the design doc): per design §7.5, separate impl PR; matcher hot-path coordination is too much to fold here.

### Approach for the remaining wires

Per the design doc §3.4 + this PR's RepayFacet note, the recommended path is to extract a thin **`EncumbranceMutateFacet`** with `releaseCollateralLien(loanId) external onlyDiamondInternal` so every loan-lifecycle terminal can cross-facet-call it (~50 bytes added per call site vs ~150 for inlined). That's deferred to the next PR.

### View surface — added to MetricsFacet

Four new view selectors (registered in `DeployDiamond._getMetricsSelectors` + `HelperTest.getMetricsFacetSelectors`):

- `getLoanCollateralLien(loanId) → Encumbrance` — proves "this exact collateral backs this exact loan."
- `getOfferPrincipalLien(offerId) → Encumbrance` — stub for the follow-up offer-principal impl.
- `getEncumbered(user, asset, tokenId) → uint256` — aggregate sum of active liens.
- `getFreeBalance(user, asset, tokenId, rawBalance) → uint256` — convenience wrapper.

### Verification

- forge build clean.
- New test `test_407_LoanInitCreatesCollateralLien` exercises: init loan → assert per-loan lien row + aggregate + free-balance helper.
- T092AutoLifecycleIntegrationTest 22/22 (+1 new) + 347/348 broader regression green (one pre-existing skip).
- Deploy-sanity 12/12 — EveryFacetUnderEip170 passes (DefaultedFacet has headroom; RepayFacet stays at-ceiling but unchanged).
- ABI re-export ran.

### Pre-live posture

Per user direction (2026-06-12): pre-live → no ABI back-compat concerns. The struct appends + storage map appends are accepted facet-refresh cost.

### Out of scope (follow-up PRs)

- Release wiring at the remaining terminals (`RepayFacet`, `PrecloseFacet`, `RefinanceFacet`, `ClaimFacet`) via the `EncumbranceMutateFacet` cross-facet pattern.
- Withdraw guard at `VaultFactoryFacet.vaultWithdrawERC20`.
- Offer-principal-lock impl (§7 of design doc) — wiring of `OfferCreateFacet._pullCreatorAssetsClassic` create + `OfferCancelFacet` + `OfferAcceptFacet` + `OfferMatchFacet` release/decrement.
- Spec updates (`docs/FunctionalSpecs/ProjectDetailsREADME.md` Ethos E1 provability section).

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

# Vault collateral encumbrance — enforcement (T-407-B, #565)

The platform now structurally guarantees that collateral backing a live loan
cannot leave a borrower's vault except through a protocol flow that first
accounts for it. A borrower who has pledged an ERC-20 asset (or an NFT) as
collateral can no longer drain that asset out of their vault through any
unrelated exit — the withdrawal chokepoint refuses to release more than the
borrower's free (un-pledged) balance, and every legitimate flow that moves
collateral (repayment, early repayment, refinance, liquidation, default,
partial collateral withdrawal, swap-to-repay, obligation transfer) adjusts the
running encumbrance first so it never blocks itself.

What a borrower sees in normal use is unchanged: repaying a loan returns their
collateral, withdrawing genuinely-excess collateral (above the health-factor
floor) still works, adding collateral still works. What changes is that an
attempt to pull pledged collateral out through a side door — most concretely,
unstaking VPFI that is simultaneously backing a live loan — is now refused
with a clear, specific error instead of silently under-collateralizing the
loan. This closes a real gap: VPFI is an eligible collateral asset (which is
safe in Vaipakam's peer-to-peer model, where the lender who accepts it prices
that risk), and the staking-unwind path previously had no awareness of
collateral commitments.

Two deliberate scoping decisions shape the behaviour:

- **NFT-rental prepayments are not encumbered.** For an NFT rental the
  borrower's "collateral" is the prepaid rental pool, which is designed to be
  drawn down continuously by the rental mechanism itself. Rather than track a
  lien that the rental flow would immediately fight, the platform leaves the
  rental pool unencumbered and instead forbids using the platform's own VPFI
  token as a rental prepayment asset (a rental prepayment must be a plain
  ERC-20 with no separate unstake door). This keeps the rental experience
  unchanged while removing the only way the prepay pool could have been
  drained out from under the lender.

- **Obligation transfer re-keys protection to the new borrower.** When a loan's
  obligation is transferred to a new borrower, the exiting borrower's
  collateral is released and the incoming borrower's collateral — already in
  their vault from their offer — is protected in its place, so the continuing
  loan is never left unprotected mid-transfer.

The enforcement also corrects an ordering issue in the internal-match
liquidation path so that opposing loans can be matched and settled without the
new chokepoint blocking the very settlement that is reducing the collateral,
and it ensures a loan that is cured back to active after a failed liquidation
has its protection reinstated.

This work supersedes the earlier incremental "wire each site as we find it"
attempt; it was re-built in one piece against a complete map of every place
collateral can move
(`docs/DesignsAndPlans/EncumbranceLifecycleMap.md`), so the protection is
applied uniformly rather than patched site by site.

## Review hardening — transferred borrower positions (Codex #572)

A second pass closed a class of edge cases that only appear once a
**borrower position has been sold or transferred** to a different holder.
A Vaipakam loan's collateral physically stays in the *original* borrower's
vault for the life of the loan — transferring the borrower-position NFT
moves the right to the position, not the vault contents. Every exit that
returns or moves that collateral now consistently takes it from the
original borrower's vault (where the protection is anchored) and delivers
it to whoever currently holds the position, so a transfer can never route
collateral to the wrong vault or leave the real collateral unprotected.

The most important refinement: on a normal close — repayment, early
close, or a swap-to-repay — the protection on the borrower's collateral is
now held until the borrower actually **claims** it back, released in the
same step as the claim, rather than the instant the loan closes. Returned
collateral sits in the borrower's vault as a pending claim between those
two moments; holding the protection across that gap means a borrower who
had already sold their position cannot drain the collateral out from under
the new position-holder before they claim it. For the ordinary case (the
same person closes and claims) nothing observable changes — they simply
claim and receive their collateral as before.

The same pass also protects collateral a borrower adds to a struggling
loan during its post-liquidation grace window, so a top-up made while a
loan is awaiting resolution can't be stranded under a stale lien if the
loan then defaults.

A companion improvement to refinancing — letting a refinance carry the
*same* collateral forward instead of requiring a fresh pledge and
returning the old — is captured as a dedicated follow-up, now that this
encumbrance ledger provides the accounting it needs.

## Thread — Offer-principal lock: a lender's escrowed principal can't be withdrawn out from under a live offer (PR #580)

When a lender posts an ERC-20 lending offer, the platform escrows the
offer's full principal ceiling into the lender's own per-user vault at
create time — it sits there, ready, until the offer is filled. Until
this change that escrowed principal was only protected by bookkeeping:
nothing stopped the lender from separately withdrawing it back out of
their vault while the offer stayed open and discoverable, so a taker (or
the matching bot) could try to fill an offer whose principal had quietly
been pulled, and the fill would fail late and opaquely.

This thread closes that gap by marking the escrowed principal as
*encumbered* — the same protective ledger introduced for borrower
collateral — so the vault's withdrawal chokepoint refuses any withdrawal
that would dip into principal committed to a live offer. The lock is
kept exactly in step with the principal across the whole offer
lifecycle: it is placed when the offer is created, lifted in full when
the offer is accepted outright or cancelled, drawn down slice-by-slice
as a range offer is partially filled by the matching engine, and lifted
on the final dust-close. Crucially, an offer's own legitimate refunds —
cancelling, or a lender editing their offer's size downward — release
the relevant portion of the lock *before* the money moves, so an offer
can always pay itself back; only third-party / cross-purpose withdrawals
are blocked. Editing an offer's size upward grows the lock by exactly
the extra principal pulled in.

The protection is automatic and needs no new user action: the lock flows
through the same encumbrance aggregate the withdrawal guard already
consults, so a lender simply finds that the slice of their balance
backing an open offer is not withdrawable until that offer is closed or
trimmed. Sanctions, KYC and country-pair behaviour are unchanged. Closes
#573 (T-407-C). The companion borrower-collateral encumbrance audit
(holistic review of every escrow leg) remains tracked separately under
#574.
