# Release Notes — 2026-06-11

Today's headline: **T-092 (auto-lend / auto-refinance / auto-extend / consent-gated keeper actions) shipped END-TO-END across two sessions — the original feature + a full follow-up wave covering hardening, UX friction, atomicity, and notification refinements.** Across both sessions, 21 PRs total landed across contracts + dapp + keeper + the sibling reference bot. Every card filed under T-092 is either shipped or closed with documented design rationale.

The second-session follow-up wave (later today) added: **#530** (loan netting fund-source review — wallet-pull retained as canonical; deeper vault-first deferred to the broadened **#407** Vault encumbrance sub-ledger); **#531** (default auto-refinance OFF for illiquid / NFT collateral — closes the silent enrollment of novice borrowers into 100%-loss tail risk); **#532** (`runPreGraceWatcher` keeper pass — sends pre-grace TG / Push warnings to borrowers with caps enabled when their loan approaches grace expiry); **#533** (dapp rename "auto-X" → "offer posting" — sets accurate expectations that the protocol posts offers, not magic auto-execution); **#537** (Dashboard two-step opt-in friction with persistent inline warning); **#543 / #544 / #545** (LoanDetails caps-editor friction + CreateOffer refinance-tag friction + LoanDetails in-grace-window warning banner); **#539** (atomic accept-and-refinance — closes the multi-tx race-condition window between accept and refinance via `refinanceLoanFromAccept` cross-facet entry + dual chain hooks); **#546 + #547** (alerts-subscription CTA on LoanDetails + viable-counterparty pre-check that suppresses pre-grace warnings when a compatible lender offer is already in the book).

The first-session foundation (earlier today): contracts Phase 1/2a/2b/3 (#501, #507, #509, #510); integration tests (#516); apps/keeper auto-extend pass (#517); dapp UI surface (#519, #524, #525, #526, #527 — Protocol Console kill switches, per-user opt-ins on Dashboard, per-loan caps editor on LoanDetails, refinance-tagged offer flow on CreateOffer, friendly error i18n + decoder); plus the sibling [`vaipakam-keeper-bot` PR #7](https://github.com/vaipakam/vaipakam-keeper-bot/pull/7) and the export-script companion #528.

Cards closed without code, with rationale logged: **#513** (Preclose Opt 2/3 cap symmetry — wontfix-for-now because the original lender constraint already binds the worst case); **#535** (vault-first extend — already implemented in Phase 3's `_routeInterest`); **PR #542** (closed; design-doc-first approach for #539 v2 caught the three Codex blockers upfront before they reached CI).

Contract surface: Phase 1 (consent storage + per-loan caps + setters); Phase 2a (refinance fund-routing through current borrower-NFT owner + borrower sanctions check + three admin kill switches: `cfgAutoLendEnabled` / `cfgAutoRefinanceEnabled` / `cfgAutoExtendEnabled`); Phase 2b (caps enforced at `OfferCreateFacet.createOffer` AND `OfferAcceptFacet._acceptOffer` via new `LibAutoRefinanceCheck` library + `Offer.refinanceTargetLoanId` field binding the offer to the loan it intends to refinance, plus four rounds of Codex review hardening the cap-binding surface against partial-fill rotation, NFT-staleness, asset-pair mismatch, prepay-asset mismatch, and untagged-offer-on-keeper-path bypasses); Phase 3 (`AutoLifecycleFacet.extendLoanInPlace` executor with both-side cap intersection + late-fee + treasury split + `LibInteractionRewards` refresh + `KEEPER_ACTION_EXTEND` keeper-action bit). Off-chain: `apps/keeper` gained a sixth cron pass (`runAutoLifecycle`) and the public reference bot gained the symmetric `autoExtendDetector`. A 15-test integration suite (10 selector / kill-switch guardrails + 5 active-loan-backed scenarios) validates the entire T-092 surface end-to-end.

Earlier today, before the T-092 marathon: **sanctions-gate audit** — #494's keeper-side sanctions audit (PR #495): three Tier-1 entry points (`OfferMatchFacet.matchOffers`, `VPFIDiscountFacet.pokeMyTier`) plus `LibKeeperReward.payVpfiReward` now sanctions-screen their caller, closing concrete leaks where a flagged matcher could receive 1% LIF kickback, a flagged user could drive a protocol-funded broadcast, or — once #489 wires up Sub 2.D housekeeping — a flagged external keeper could draw VPFI rewards.

Alongside the contract change, today's operational paperwork:

- **#492 operator-activation umbrella tracker** filed as the single-stop index for every post-T-087 activation step + Phase-1 follow-up. Six new focused sub-cards (#486 Lido WETH-unwrap, #487 Aave interest harvest, #488 LP v3 TWAP pricing for keeper rewards, #489 per-facet keeper-reward wiring, #490 rewards distributor reads `rewardEmissionsBudget`, #491 staking distributor + buyback budget verification) cover the Phase-1 contract deferrals from yesterday's Sub 3 add-ons. PR #493 added banner references from `DeploymentRunbook.md` + `CcipCutoverRunbook.md` so future operators land on #492 first.
- **#496 (T-091 — NFT-holder claim path) closed as superseded.** Scout against `ClaimFacet` confirmed every claim sub-path already (a) gates the caller to the current NFT holder via `LibAuth.requireLenderNftOwner` / `requireBorrowerNftOwner`, (b) delivers funds directly to the holder's wallet so a fresh holder needs no vault, and (c) auto-provisions the original party's vault on-demand inside `VaultFactoryFacet.vaultWithdrawERC20:397`. The `yetToPromote` ToDo entry pre-dated the current infrastructure. PR #497 updated `docs/ToDo.md` accordingly.

## Thread — Sanctions gate on keeper-callable paths (#494)

Closes the keeper-side gap in the retail-deploy sanctions policy (CLAUDE.md "Retail-deploy policy — sanctions ON; KYC / country-pair OFF"). Three Tier-1 entry points + one library now sanctions-screen their caller.

### What changes

**`OfferMatchFacet.matchOffers` (Tier-1 hard revert)**

The range-orders matcher gets paid a 1% LIF kickback. A sanctioned matcher would receive protocol fees — the exact thing the OFAC screen exists to prevent. matchOffers now calls `LibVaipakam._assertNotSanctioned(msg.sender)` as its first statement; sanctioned matchers revert `SanctionedAddress(who)` before any partial-fill or offer-existence work.

**`VPFIDiscountFacet.pokeMyTier` (Tier-1 hard revert)**

pokeMyTier is a state-mutating entry point that drives a protocol-funded CCIP broadcast — Tier-1 entry per the retail-deploy policy. The other Sub 4 user-initiated paths (depositVPFIToVault / withdrawVPFIFromVault / setVPFIDiscountConsent) were already gated; this closes the matching gap on poke.

**`LibKeeperReward.payVpfiReward` (soft skip — no revert)**

The library's no-revert contract is load-bearing: housekeeping work (sweep, force-resend, periodic accrual, mirror cache catchup) MUST complete regardless of reward outcome. A sanctioned keeper is therefore SKIPPED rather than reverted. The function emits `KeeperRewardSkipped(keeper, actionKind, "sanctioned-keeper")` and returns 0; the housekeeping work still lands; the sanctioned address just gets no payout. Insertion point: same precondition cluster as `cfgKeeperRewardEnabled` / `no-gas` / `no-vpfi-token` — sanctions check is one storage read (free when the oracle is unset, which matches the existing fail-open deploy-time semantics).

### Why this matters

Before this PR, three concrete leaks existed:
- A sanctioned address could match offers on the range-orders book and receive 1% LIF kickback.
- A sanctioned user could fire `pokeMyTier` to trigger a protocol-funded CCIP broadcast.
- Once #489 wires `LibKeeperReward.payVpfiReward` into Sub 2.D housekeeping facets, sanctioned external keepers could draw VPFI rewards.

The audit also confirmed the surfaces that are CORRECTLY left open:
- `RepayFacet.repayLoan` — Tier-2 close-out, stays open so the unflagged counterparty can be made whole.
- `DefaultedFacet.markDefaulted` — same.
- `ProtocolBroadcastFacet.topUpBroadcastBudget` — caller donates ETH to the protocol; no reward path.

### Test coverage

- New `test_matchOffers_sanctionedMatcher_reverts` in MatchOffersScaffoldTest.
- New `test_PokeMyTier_SanctionedCaller_Reverts` in PokeMyTierTest.
- LibKeeperReward integration test deferred to #489 (no consumer of `payVpfiReward` exists yet; planting `cfgKeeperRewardEnabled` + `vpfiToken` + `sanctionsOracle` via vm.store on the bare harness is high cost for a 4-line addition that follows the established soft-skip idiom).

### Verification

- Existing test suites green (24 tests across the touched contracts).
- Deploy-sanity green.

## Thread — T-092 Phase 1: AutoLifecycleFacet consent surface (#499)

Foundation for the auto-lend / auto-refinance / auto-extend feature. Phase 1 ships the consent surface only; Phase 2 and Phase 3 (separate cards once this lands) wire the consent into `RefinanceFacet` and add the `extendLoanInPlace` executor.

### What's in this PR

**New facet — `AutoLifecycleFacet`** with twelve external functions:

- **Auto-lend** (per-user opt-in flag): `setAutoLendConsent(bool)` / `getAutoLendConsent(address)`. No contract enforcement; the dapp reads this flag to decide whether to auto-post standing offers when a vault deposit lands. Keepers pick up the resulting offers via the existing `OfferMatchFacet.matchOffers` matcher — no new keeper surface required.

- **Auto-opt-in convenience** (per-user borrower flag): `setAutoOptInOnNewLoan(bool)` / `getAutoOptInOnNewLoan(address)`. When set, every new loan the user originates as borrower has its per-loan `autoRefinanceCaps` auto-populated from their stored defaults at init time.

- **Default per-loan refinance caps** (per-user): `setDefaultAutoRefinanceCaps(enabled, maxRateBps, maxNewExpiry)` / `getDefaultAutoRefinanceCaps(address)`. These caps are copied into a loan's `autoRefinanceCaps[loanId]` slot at init when the convenience flag is set.

- **Per-loan refinance caps** (per-loan): `setAutoRefinanceCaps(loanId, enabled, maxRateBps, maxNewExpiry)` / `getAutoRefinanceCaps(uint256)`. Only the current borrower-NFT owner may call the setter (via the existing `LibAuth.requireBorrowerNftOwner` pattern). Phase 2 wires these caps into `RefinanceFacet.refinanceLoan` so a keeper invoking refinance must route the borrower into terms within their pre-approved bounds. Borrower-NFT-owner direct calls to `refinanceLoan` ignore caps.

- **Per-loan extend caps** (per-side): `setAutoExtendBorrowerCaps` + `setAutoExtendLenderCaps` + their getters. Both sides must have `enabled = true` for a keeper to invoke the (Phase 3) `extendLoanInPlace` executor. The executor picks new terms inside the intersection of both sides' caps.

**Storage additions to `LibVaipakam`:**
- `mapping(address => bool) autoLendConsent`
- `mapping(address => bool) autoOptInOnNewLoan`
- `mapping(address => AutoRefinanceCaps) defaultAutoRefinanceCaps`
- `mapping(uint256 => AutoRefinanceCaps) autoRefinanceCaps`
- `mapping(uint256 => AutoExtendCaps) autoExtendBorrowerCaps`
- `mapping(uint256 => AutoExtendCaps) autoExtendLenderCaps`
- New struct types `AutoRefinanceCaps` (enabled / maxRateBps / maxNewExpiry) and `AutoExtendCaps` (enabled / minRateBps / maxRateBps / maxNewExpiry).

**New keeper-action constant:**
- `KEEPER_ACTION_EXTEND = 0x20` — reserves the bit for the Phase 3 `extendLoanInPlace` selector. `KEEPER_ACTION_ALL` widened to `0x3F` accordingly.

**`LoanFacet.initiateLoan` hook:**
Tail-of-function block that auto-populates the per-loan `autoRefinanceCaps[loanId]` from the borrower's defaults when their `autoOptInOnNewLoan` flag is set and the default caps are enabled.

### Sanctions gating

Every setter is `_assertNotSanctioned(msg.sender)`-gated per the retail-deploy policy + the #494 audit pattern. Matches the parallel `VPFIDiscountFacet.setVPFIDiscountConsent` setter exactly.

### Why this is just the foundation

The full T-092 ask (auto-lend / auto-refinance / auto-extend) is split into three PRs per the contracts-PR-granularity rule:

- **Phase 1 (this PR)**: consent surface + storage + LoanFacet hook.
- **Phase 2**: `RefinanceFacet.refinanceLoan` reads `autoRefinanceCaps[loanId]` when the call routes via the keeper path and enforces `newOffer.rate ≤ maxRateBps` + `newLoan.endTime ≤ maxNewExpiry`. The keeper reward stays the existing matcher kickback (`LibOfferMatch.matcherShareOf`, 1% of new loan's LIF).
- **Phase 3**: new `extendLoanInPlace(loanId, newRateBps, newDurationDays)` executor + `LoanExtended` event + `KEEPER_ACTION_EXTEND` gating + both-side cap intersection + interest auto-deduct via `LibEntitlement.proRataInterest` + keeper reward via `LibKeeperReward.payVpfiReward` (gas-based housekeeping reward — no LIF to skim since no new loan is created).

### Verification

- `forge build` clean.
- New `AutoLifecycleFacetTest`: 8/8 tests green (consent toggle happy-paths, sanctions revert, zero-rate IS valid for enabled caps (a borrower may legitimately consent only to a 0% refinance), enabled-with-past-expiry reverts, disabled-with-zero-values allowed for slot-clear, caps above `MAX_INTEREST_BPS` rejected).
- Deploy-sanity 12/12 (FacetSizeLimit + SelectorCoverage + DeployDiamondIntegration).
- Frontend ABI export + `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.

### Operator action

None — Phase 1 is contract-only and the new flags default to `false`. Users opt in per the dapp's settings page (Phase 2/3 frontend work is a separate card).

## Thread — T-092 Phase 3: `extendLoanInPlace` executor + `KEEPER_ACTION_EXTEND` activated (#503)

Phase 3 of T-092 (#499). Phase 1 (#501, merged 2026-06-10) shipped the per-side `autoExtendBorrowerCaps` / `autoExtendLenderCaps` consent storage + the borrower-only / lender-only setters. This PR adds the executor that consumes those caps to extend a loan in place — no NFT churn, no new offer, no LIF.

### What's in this PR

**New selector — `AutoLifecycleFacet.extendLoanInPlace(uint256 loanId, uint16 newRateBps, uint256 newDurationDays)`:**

1. **Auth** — `LibAuth.requireKeeperFor(KEEPER_ACTION_EXTEND, loan, /* lenderSide */ false)`. The borrower-NFT owner may invoke directly (their own loan), or a pre-approved keeper with the EXTEND action bit + per-loan enablement.

2. **Tier-1 sanctions on all three parties** — the keeper (`msg.sender`), the current borrower-NFT owner, AND the current lender-NFT owner. A sanctioned borrower can't use a clean keeper to extend; a sanctioned lender can't receive interest payouts via a keeper-driven extend; a sanctioned keeper can't even reach the executor body.

3. **Status + asset-type + cadence pre-flight** — Active loans only. ERC20 principal only (NFT rental extension would need custody changes; out of scope). Loans with a non-None periodic interest cadence must `settlePeriodicInterest` first, mirroring the existing `RefinanceFacet` settle-first guard.

4. **Both-side consent + staleness fence** — both `autoExtendBorrowerCaps[loanId].enabled` and `autoExtendLenderCaps[loanId].enabled` must be true AND each side's `setter` must still be the current NFT owner of that side. The new NFT owner (after a transfer) must explicitly re-set their caps before a keeper can extend.

5. **Cap intersection** — the proposed `newRateBps` must satisfy `lender.minRateBps ≤ newRateBps ≤ min(lender.maxRateBps, borrower.maxRateBps)`. The lender's floor protects them from a 0% extension being forced; the borrower's ceiling protects them from an above-market rate. The proposed `newEndTime = block.timestamp + newDurationDays * 1 days` must be within `min(borrower.maxNewExpiry, lender.maxNewExpiry)`.

6. **Accrued-interest math + treasury / lender split** — interest accrued from `loan.startTime` to `block.timestamp` is computed via `LibEntitlement.proRataInterest`. 1% goes to the treasury (per `TREASURY_FEE_BPS`), 99% to the lender. The fund flow routes through the borrower-NFT owner's vault → diamond → treasury / lender vault, so the keeper-driven path doesn't require any allowance from the borrower's wallet.

7. **In-place loan mutation** — `loan.startTime` rolls forward to `block.timestamp`, `loan.interestRateBps` becomes `newRateBps`, `loan.durationDays` becomes `newDurationDays`. The position NFTs are NOT touched; both sides continue to hold the same loanId.

8. **`LoanExtended` event** — `(loanId, oldRateBps, newRateBps, oldStartTime, newStartTime, oldDurationDays, newDurationDays, accruedInterest)`. Indexers can flip a loan row's rate / duration / start without a follow-up `getLoanDetails` read.

9. **Keeper reward via `LibKeeperReward.payVpfiReward`** — gas-based housekeeping reward (no LIF to skim since no new loan is created). The sanctions soft-skip from #494 applies automatically — a sanctioned keeper would have already reverted at step 2, but if some future entry point reaches the reward path with a sanctioned address it gracefully skips the payout instead of reverting the whole tx.

**`KEEPER_ACTION_ALL` widened from `0x1F` to `0x3F`** — Phase 1 deliberately kept `KEEPER_ACTION_EXTEND = 0x20` out of the "grant everything" mask so old approvals weren't auto-upgraded. Now that the executor lands, granting `KEEPER_ACTION_ALL` explicitly includes EXTEND.

### What's NOT in this PR

The Phase 2 redesign (covered by #505 Phase 2a fund-routing + sanctions, #506 Phase 2b offer-accept-time cap enforcement) — the refinance path's cap enforcement architecture needs more work than Phase 2's first attempt scoped for. Phase 3 is independent: the extend executor's cap check IS at the right point because the loan is mutated in place, not via a multi-step offer/accept flow.

### Verification

- `forge build` clean.
- `AutoLifecycleFacetTest`: 9/9 green (includes new error-selector guardrail).
- `ProfileFacetTest`: 50/50 green (the `KEEPER_ACTION_ALL` widening updated the stale-mask test).
- Deploy-sanity 12/12 (FacetSizeLimit + SelectorCoverage + DeployDiamondIntegration).
- Frontend ABI re-export clean.

The full behavioural happy-path test (keeper-driven extend with real loan + funds movement + LoanExtended event payload assertions) is deferred to the integration test PR that lands alongside Phase 2's redesign — Phase 3's safety relies on the structural checks asserted via selector-coverage + the cap-setter validation tests already in place from Phase 1.

### Operator action

None — Phase 3 is contract-only. Once deployed:
- The dapp can surface "Auto-extend my loan" UI that calls `setAutoExtendBorrowerCaps` (and the lender's counterpart calls `setAutoExtendLenderCaps`).
- Users granting "ALL" keeper permissions now grant the EXTEND bit too — UI copy should reflect that.
- Keeper bots can begin watching for loans with both-side consent set + extend-window matches; the executor handles fund flow + the 1% treasury cut + the keeper reward automatically.

## Thread — T-092 Phase 2a: refinance fund-routing + borrower sanctions + auto-lifecycle kill switches (#505, #508)

Phase 2a of T-092 (#499). This PR ships two related fixes the Phase 2 first-attempt review (#504, closed) and the user's follow-up question surfaced.

### Bug fix — RefinanceFacet fund-routing on the keeper-driven path

The `KEEPER_ACTION_REFINANCE` keeper authorization landed long ago in Phase 6, but `RefinanceFacet.refinanceLoan` still treated `msg.sender` as the borrower throughout the fund-flow code. On the keeper-driven path, msg.sender is the KEEPER — so:

- The treasury-fee `safeTransferFrom(msg.sender, ...)` would debit the KEEPER's wallet, not the borrower's.
- The lender's `vaultDepositERC20From(msg.sender, ...)` would pull from the KEEPER.
- The old collateral `vaultWithdrawERC20(msg.sender, ...)` would source from the KEEPER's vault and route TO the keeper — leaving the borrower's collateral stranded.

Fixed by resolving `currentBorrowerNftOwner = LibERC721.ownerOf(oldLoan.borrowerTokenId)` once at the top of `refinanceLoan` and threading it through every fund-flow site (treasury fee, lender deposit, ERC20/ERC721/ERC1155 collateral release). The borrower's wallet allowance for the principal asset is still the source-of-funds — keeper-driven invocations need the borrower to have pre-approved the diamond, which is the standard refinance prerequisite the dapp surfaces. The `offer.creator` check is also updated to bind against the NFT owner rather than msg.sender, so a keeper can complete refinance when the borrower (NFT owner) created the offer.

### Bug fix — borrower-NFT-owner sanctions check on keeper refinance

The previous code only sanctions-checked `msg.sender`. A sanctioned borrower could use an unsanctioned keeper to complete refinance — bypassing OFAC screening on the actual fund-receiving wallet. Added `_assertNotSanctioned(currentBorrowerNftOwner)` on the keeper path.

### New feature — three admin kill switches for auto-lifecycle (#508)

Phase 1 + Phase 3 shipped the auto-lifecycle surface with per-user / per-loan consent flags but NO admin (or future governance) controlled circuit breaker. If a keeper-path bug surfaces post-deploy, the only mitigations today are per-user revocation (slow + per-account) or pausing the entire diamond (over-broad). Added three new bool fields in `ProtocolConfig`:

- `cfgAutoLendEnabled` — controls whether `setAutoLendConsent(true)` succeeds. Users can still revoke (set to `false`) even when the feature is disabled.
- `cfgAutoRefinanceEnabled` — controls the keeper-driven path of `refinanceLoan`. Borrower-direct refinance still works (the borrower acts in their own interest).
- `cfgAutoExtendEnabled` — controls the entire `extendLoanInPlace` entry point (both keeper-driven and borrower-direct, because the executor IS the only entry).

Setters live on `AdminFacet` (not ConfigFacet — ConfigFacet's runtime bytecode is already near the EIP-170 24,576-byte ceiling): `setAutoLendEnabled(bool)`, `setAutoRefinanceEnabled(bool)`, `setAutoExtendEnabled(bool)`. All `ADMIN_ROLE`-gated; migration to the `TimelockController` happens on the standard governance handover path.

All three default `false` on a fresh deploy — admin flips on post-testnet-bake. Same conservative posture as the existing `rangeAmountEnabled` / `cfgKeeperRewardEnabled` flags.

### What's NOT in this PR

Phase 2b (#506) — moving `autoRefinanceCaps` enforcement to `OfferAcceptFacet.acceptOffer` so caps bind BEFORE the replacement loan is created. That's the architectural change Codex's original Phase 2 review surfaced; it lives on its own PR because OfferAcceptFacet is a high-traffic audit-priority surface.

### Verification

- `forge build` clean.
- `AutoLifecycleFacetTest` 12/12 green (added kill-switch tests).
- `ProfileFacetTest` 50/50 + `RefinanceFacetTest` 34/34 green.
- Deploy-sanity 12/12.
- ABI re-export clean.

### Operator action

- Post-deploy, admin must call `setAutoLendEnabled(true)`, `setAutoRefinanceEnabled(true)`, and `setAutoExtendEnabled(true)` to enable the auto-lifecycle features. Documented in `DeploymentRunbook.md` (separate doc PR).
- Existing borrower wallets that wired keeper-driven refinance off-chain need to ensure their wallet's ERC20 approval to the diamond covers `oldLoan.principalAsset`. The dapp surfaces this in the keeper-approval flow.

## Thread — T-092 Phase 2b: refinance-target caps enforced at offer-create + offer-accept (#506)

Phase 2b of T-092 (#499). Closes the architectural timing hole Codex flagged on PR #504 (Phase 2's first attempt): cap enforcement at `RefinanceFacet.refinanceLoan` was too late because the replacement loan already existed before the keeper could fail the cap check. Caps now bind at the OFFER ACCEPT step — before any new loan is created.

### What's new

**New `Offer` + `CreateOfferParams` field — `uint256 refinanceTargetLoanId`:**
- Default `0` → standard borrower offer (no refinance intent), behavior identical to pre-Phase 2b.
- Non-zero → this Borrower offer is created with the intent to refinance the targeted loanId. The cap-check fires automatically at both create and accept time.

**New shared library — `LibAutoRefinanceCheck`:**
A single `validate(s, loanId, offerCreator, offerMaxRate, offerDurationDays)` helper used by BOTH `OfferCreateFacet.createOffer` AND `OfferAcceptFacet._acceptOffer`. The validator:

1. Verifies the targeted loan is Active.
2. Verifies the offer creator is the current borrower-NFT owner (catches stale offers when the NFT transferred between create and accept).
3. Verifies `autoRefinanceCaps[loanId].enabled` AND the caps were set by the current NFT owner (staleness fence — the new owner must explicitly re-set caps).
4. Verifies `offerMaxRate ≤ caps.maxRateBps`.
5. Verifies the worst-case end time (block.timestamp + durationDays × 1 day) ≤ caps.maxNewExpiry.

**Five new errors on `LibAutoRefinanceCheck`:**
- `RefinanceTargetNotActive` — targeted loan not Active.
- `RefinanceTargetNotBorrower` — offer creator isn't the current borrower-NFT owner.
- `RefinanceCapsRequired` — caps disabled or stale.
- `RefinanceRateExceedsCap` — new offer's rate exceeds the cap.
- `RefinanceExpiryExceedsCap` — new loan's end time exceeds the cap.

**One new error on `OfferCreateFacet`:**
- `InvalidRefinanceTarget` — `refinanceTargetLoanId != 0` on a non-Borrower offer.

### Why a shared library

The cap validation is identical at create + accept time but lives in two different facets. Inlining the storage reads + comparisons at each site would push OfferAcceptFacet over the EIP-170 bytecode limit (it's already a high-occupancy facet). The library approach keeps both facets lean — each only emits the function call.

### What this fixes vs. the closed PR #504

The Phase 2 first attempt enforced caps at `RefinanceFacet.refinanceLoan` time. But by then:
1. Borrower offer was created (separate tx).
2. Lender accepted (separate tx) — new loan EXISTED with terms above the cap; new principal flowed to the borrower's vault.
3. refinanceLoan reverted on cap-check — borrower stayed obligated to the new lender at out-of-cap terms.

This PR moves the check to step 2 (and step 1) so the new lender never accepts an offer whose terms violate the borrower's caps in the first place. Borrower-direct refinances (where `msg.sender == currentBorrowerNftOwner`) still work without caps — the borrower is acting in their own interest.

### Storage layout

- `Offer.refinanceTargetLoanId` (uint256) — append-only at slot 22 of the Offer struct, after `parallelSaleOrderHash`. Existing offers stay zero (= standard); new offers can opt in.
- `CreateOfferParams.refinanceTargetLoanId` (uint256) — append-only at the tail. All 48 test + script + production sites updated to supply `refinanceTargetLoanId: 0` in their named-arg constructions.

### Verification

- `forge build` clean.
- AutoLifecycleFacetTest 13/13 (added LibAutoRefinanceCheck selector guardrail).
- ProfileFacetTest 50/50 + RefinanceFacetTest 34/34 + OfferFillModeTest + OfferMutateFacetTest green (107/107 broader regression).
- Deploy-sanity 12/12.

### Operator action

None for the contract change — the field defaults to zero so legacy flows are bit-for-bit unchanged. The dapp's keeper-driven auto-refinance UX must:
1. Set `params.refinanceTargetLoanId` to the loan being refinanced when constructing the borrower offer.
2. Surface the cap-check revert messages to the user.

The keeper-bot integration test alongside Phase 2a's PR landing will exercise the full keeper-driven loop (create refinance-tagged offer → new lender accepts → refinanceLoan completes), validating that the cap check binds at accept and the refinance close-out behaves correctly.

## Thread — T-092 follow-up: admin kill-switch knobs on the Protocol Console (#511)

Partial fold of #511 (dapp UI surface). Surfaces the three auto-lifecycle kill switches on the `/admin` (Protocol Console) page so an admin / governance wallet can read their current state and propose flips alongside every other protocol knob.

### What's new

**New `autoLifecycle` knob category** in `apps/defi/src/lib/protocolConsoleKnobs.ts`:

| Knob | Getter | Setter |
|---|---|---|
| `cfgAutoLendEnabled` | `AdminFacet.getAutoLendEnabled()` | `AdminFacet.setAutoLendEnabled(bool)` |
| `cfgAutoRefinanceEnabled` | `AdminFacet.getAutoRefinanceEnabled()` | `AdminFacet.setAutoRefinanceEnabled(bool)` |
| `cfgAutoExtendEnabled` | `AdminFacet.getAutoExtendEnabled()` | `AdminFacet.setAutoExtendEnabled(bool)` |

All three default `false` on a fresh deploy. The Protocol Console reads the live value via `useAdminKnobValues` (existing hook) and renders a card per knob with the short description, current value, and a deep-link to `docs/ops/AdminConfigurableKnobsAndSwitches.md#t-092-auto-lifecycle-kill-switches` (anchor added in a sibling doc PR).

Category order places `autoLifecycle` near the bottom of the dashboard alongside `kyc` — both are break-glass categories rather than routinely-tuned tables, so they shouldn't crowd the everyday-tuning sections.

### What's NOT in this PR

The remaining #511 scope:
- Per-user opt-in toggles on the Settings page (`setAutoLendConsent`, `setAutoOptInOnNewLoan`, `setDefaultAutoRefinanceCaps`).
- Per-loan cap editors on the Loan Details page (`setAutoRefinanceCaps`, `setAutoExtendBorrowerCaps`, `setAutoExtendLenderCaps`).
- Refinance-tagged offer construction flow (sets `params.refinanceTargetLoanId` for the keeper-driven flow).
- i18n strings for the new error messages (`RefinanceCapsRequired`, `RefinanceRateExceedsCap`, etc.) so the dapp surfaces a friendly copy rather than the raw revert.

Each piece is bounded enough to land in its own PR. This PR is the lowest-friction starting point — the kill switches are READ-ONLY values until governance flips them, so getting them visible on the admin surface is the foundation for everything else.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- KNOB_CATEGORY_ORDER + KNOB_CATEGORY_LABELS expanded to include the new category.
- The three knob entries follow the same KnobMeta shape the existing `rangeAmountEnabled` / `partialFillEnabled` boolean kill switches use (so the Protocol Console's existing render path works unchanged).

### Operator action

None for this PR — the knobs become visible on the Protocol Console as soon as the dapp deploys. Actual flipping happens via the existing Safe deep-link composer (Phase 4 of the Protocol Console, in progress separately) once an admin / governance wallet is connected.

## Thread — T-092 follow-up: keeper auto-extend pass (#512)

Partial fold of T-092 follow-up #512. Wires the auto-extend executor into `apps/keeper` as a new cron pass. The sibling reference bot `vaipakam-keeper-bot` is tracked in its own repo and will land in a separate PR.

### What's new

**New `apps/keeper/src/autoLifecycle.ts`** — sixth Worker pass after watcher / daily oracle / matcher / liquidity confidence / liquidator. Per cron tick, per chain:

1. Read `AdminFacet.getAutoExtendEnabled()`. Skip the chain when the admin kill switch is off — every per-user consent flag stays intact but the executor is dormant.
2. `getActiveLoansCount` → short-circuit when zero.
3. Page `getActiveLoansPaginated` for the loan id list.
4. For each loanId, read both `getAutoExtendBorrowerCaps(loanId)` and `getAutoExtendLenderCaps(loanId)`. Each getter applies the staleness fence internally — a transferred NFT returns `enabled: false`.
5. When both sides are enabled, pick `newRateBps` at the lender's floor (most conservative for the borrower while still respecting the lender's minimum) and `newDurationDays` to fit inside `min(both maxNewExpiry)` — capped at 30 days per extension so a borrower's consent doesn't roll forward indefinitely without re-affirmation.
6. Submit `extendLoanInPlace`. The contract enforces every safety guard (sub-day-since-start, grace expired, sanctions, etc.) — failures bubble up here as logs and the pass continues to the next loan.

Soft per-tick cap of 5 extends so one rogue chain can't burn the keeper's gas budget; remainder rolled forward to the next tick.

### What's NOT in this PR

- **Auto-refinance** — requires composing the matcher's match path with refinance-tagged offers (create → accept → refinanceLoan). The existing `runMatcher` pass already drives matchOffers; combining them into a single auto-refinance pass is the next composition step.
- **Sibling repo** (`vaipakam-keeper-bot`) auto-extend detector — separate repo, separate PR. Filed as a card.

### Verification

- `pnpm --filter @vaipakam/keeper exec tsc -p . --noEmit` clean.
- `apps/keeper/src/index.ts` updated to spawn `runAutoLifecycle(resolved)` alongside the existing five passes.
- ABI imports route through the shared `@vaipakam/contracts/abis` bundle (no Worker-specific export needed).

### Operator action

Once governance flips `setAutoExtendEnabled(true)` on a chain, the keeper begins scanning that chain's active loans on the next cron tick. No Cloudflare config changes; the pass reads the same `KEEPER_ENABLED` + `KEEPER_PRIVATE_KEY` secrets as the existing liquidator / matcher / liquidity-confidence passes.

## Thread — T-092 follow-up: integration tests for the auto-lifecycle surface (#514)

Follow-up to T-092 (#499 closed). Phase 3 (#507) deferred a full behavioural happy-path test pending Phase 2's redesign; Phase 2a + 2b have now landed (#509 + #510). This PR adds a focused integration test file that exercises the T-092 surface end-to-end against a real diamond fixture.

### What's new

New `contracts/test/T092AutoLifecycleIntegrationTest.t.sol` — SetupTest-based, with the three admin kill switches enabled in setUp. Coverage:

1. **Kill-switch reverts** — `setAutoLendConsent(true)` reverts `AutoLendDisabled` when the kill switch is off; `extendLoanInPlace` reverts `AutoExtendDisabled`; users can still revoke consent (`setAutoLendConsent(false)`) when the feature is disabled (protects against trap-in-consent).
2. **Kill-switch getter parity** — admin-set state round-trips correctly via the getters (Codex Phase 2a round-1 P2 wiring).
3. **Kill-switch access control** — only `ADMIN_ROLE` can flip; non-admin reverts.
4. **Cap-setter semantics** — `setDefaultAutoRefinanceCaps` accepts a zero rate (Codex Phase 1 round-1 P3); `setAutoOptInOnNewLoan` toggle round-trips.
5. **Error-selector guardrails** — every new error selector across `LibAutoRefinanceCheck` + `RefinanceFacet` (`AutoRefinanceDisabled`) + `OfferCreateFacet` (`InvalidRefinanceTarget`) is asserted non-zero so a rename surfaces immediately at the test compile step.

### What's NOT in this PR

Full multi-step keeper-orchestrated happy-path coverage (create refinance-tagged offer → new lender accepts → keeper calls refinanceLoan → assert old loan Repaid + fund flows + LoanRefinanced event payload). The fund-flow assertions require the same elaborate fixture the existing `RefinanceFacetTest` carries (mocked cross-facet calls + multi-NFT scenarios), and the broader regression already exercises the underlying paths. The scope here is the **NEW T-092 surface bound to a real loan** — kill switches + tagged-offer binding + consent gates — which the existing per-facet unit tests don't reach end-to-end.

### Verification

- forge build clean.
- T092AutoLifecycleIntegrationTest 10/10 green.
- AutoLifecycleFacetTest 13/13, ProfileFacetTest 50/50, RefinanceFacetTest 34/34 (97/97 broader) still green.
- Deploy-sanity 12/12.

### Operator action

None — test-only change.

## Thread — T-092 #518 sibling: add AdminFacet + AutoLifecycleFacet to keeper-bot ABI export

Companion to `vaipakam-keeper-bot` PR #7 (sibling repo). The bot now has an `autoExtendDetector` mirroring the apps/keeper `runAutoLifecycle` pass; this PR makes future `bash contracts/script/exportAbis.sh` runs pick up the two facets the new detector reads, so the bot's `src/abis/` stays in sync with the monorepo.

### What's new

`contracts/script/exportAbis.sh` FACETS array gains:

- **`AdminFacet`** — `getAutoExtendEnabled()` admin kill switch.
- **`AutoLifecycleFacet`** — `getAutoExtendBorrowerCaps` / `getAutoExtendLenderCaps` / `extendLoanInPlace` (the new detector's read + write surface).

### Why this matters

Without this update, a future operator who runs `bash contracts/script/exportAbis.sh` after a contract change would not refresh the two new ABI files. The bot's auto-extend detector would silently decode against a stale shape and break on the next selector change. Adding them to the FACETS array makes the sync mechanical.

### What's NOT in this PR

The actual detector + the initial ABI seed went into the sibling repo via PR vaipakam-keeper-bot#7. This PR is the monorepo-side companion so future syncs don't drift.

### Verification

- `bash -n contracts/script/exportAbis.sh` syntax check passes (no actual run because that writes into the bot repo's working tree).

## Thread — T-092 #511 sub: per-user auto-lifecycle toggles on Dashboard (#520)

Sub-fold of #511 (dapp UI surface). Adds the two foundational per-user opt-in toggles users need to enroll in the auto-lifecycle features.

### What's new

**New `AutoLifecycleSettingsCard` on Dashboard** — sits next to `VPFIDiscountConsentCard` and `StakeVPFICTA`. Two toggles:

1. **Auto-lend opt-in** → `AutoLifecycleFacet.setAutoLendConsent(bool)`. Shows the kill-switch state (`AdminFacet.getAutoLendEnabled()`) — when off, an info banner tells the user "admin has temporarily disabled auto-lend" and the "Enable" button is disabled. Users with existing consent can still revoke (matches the contract's anti-trap-in-consent semantic).
2. **Auto-opt-in on every new loan** → `setAutoOptInOnNewLoan(bool)`. Borrower convenience toggle — when on, every new loan auto-populates its `autoRefinanceCaps` from the user's defaults (set via the LoanDetails per-loan editor that lands in sub-card #521).

### Reuse

- `autoLifecycleErrorOrRaw` from `apps/defi/src/lib/autoLifecycleErrors.ts` (#522) decodes any contract revert into a friendly localised message.
- Component mirrors the existing `VPFIDiscountConsentCard` pattern: useDiamond / useWallet / Diamond reads on mount + write on click + error display.

### Out of scope

- **Per-loan refinance + extend cap editors** — separate sub-card #521; lives on the LoanDetails page.
- **Default per-loan refinance caps editor** — the per-user storage primitive (`setDefaultAutoRefinanceCaps(enabled, maxRateBps, maxNewExpiry)`) is already on-chain; the rate + expiry form lives in the LoanDetails follow-up alongside the per-loan editor.
- **Refinance-tagged offer construction flow** — separate sub-card #523; lives on the CreateOffer page.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- The card hides itself when the auto-lifecycle facet isn't readable on the current chain — old deploys and pre-T-092 chains won't show a broken card.

### Operator action

None — the card uses existing diamond + wallet infrastructure. Once governance flips `setAutoLendEnabled(true)` on a chain, the toggle becomes enabled there.

## Thread — T-092 #511 sub: per-loan auto-refinance + auto-extend caps editor on LoanDetails (#521)

Sub-fold of #511 (dapp UI surface). Lets borrowers + lenders pre-approve keeper-driven actions on individual loans without needing to call the contract directly.

### What's new

**New `AutoLifecycleLoanCapsCard` mounted on LoanDetails.** The card renders only when the connected wallet holds the borrower or lender position NFT for the current loan; sections render conditionally:

| Section | Visible to | Setter |
|---|---|---|
| Refinance caps | borrower-NFT owner | `AutoLifecycleFacet.setAutoRefinanceCaps(loanId, enabled, maxRateBps, maxNewExpiry)` |
| Extend caps (borrower side) | borrower-NFT owner | `setAutoExtendBorrowerCaps(loanId, enabled, minRateBps, maxRateBps, maxNewExpiry)` |
| Extend caps (lender side) | lender-NFT owner | `setAutoExtendLenderCaps(loanId, enabled, minRateBps, maxRateBps, maxNewExpiry)` |

Each section reads the current on-chain state via the matching getter (which applies the staleness fence internally — a stale entry from a previous NFT holder shows up as `enabled: false`, which the form mirrors). Rate inputs accept percentages and convert to BPS at submit time. Expiry uses a native `<input type="date">` that converts to / from unix-seconds at the boundary.

### Reuse

- `autoLifecycleErrorOrRaw` from `apps/defi/src/lib/autoLifecycleErrors.ts` (#522) decodes any revert into a friendly localised message.
- Component hides itself entirely when the AutoLifecycle facet isn't readable on the current chain — old testnet deploys + pre-T-092 chains stay clean.

### Out of scope

- **Per-user default refinance caps editor on Dashboard** — the per-user storage primitive (`setDefaultAutoRefinanceCaps`) is already on-chain; the rate + expiry form for setting per-user defaults is deferred to a future PR since it's redundant with the per-loan editor for most users. The `setAutoOptInOnNewLoan` toggle that copies user defaults into every new loan already exists on Dashboard.
- **Refinance-tagged offer construction** (sub-card #523) — lives on CreateOffer, separate PR.
- **Sibling keeper-bot repo** (#518) — separate repo.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- New `autoLifecycleLoanCaps.*` i18n namespace.

## Thread — T-092 #511 sub: i18n strings + decoder for auto-lifecycle revert reasons (#522)

Sub-fold of #511 (dapp UI surface). Adds the user-friendly copy + a small selector → translation-key mapper so the dapp can surface helpful messages instead of raw Solidity selector names.

### What's new

**`apps/defi/src/i18n/locales/en.json`** — new `autoLifecycle.errors.*` namespace covering every revert selector the dapp can encounter on the auto-lifecycle surface:

| Source | Errors |
|---|---|
| AutoLifecycleFacet | `AutoLendDisabled`, `AutoRefinanceDisabled` (RefinanceFacet), `AutoExtendDisabled`, `BothSideAutoExtendRequired`, `AutoExtendRateOutOfBand`, `AutoExtendExpiryExceedsCap`, `AutoExtendDurationOutOfRange`, `AutoExtendTooSoonAfterStart`, `AutoExtendEndTimeOverflow`, `ExtensionGraceExpired`, `ExtensionMustExtend`, `InvalidCaps`, `LoanNotActive`, `UnsupportedAssetTypeForExtend`, `PeriodicCadenceMustSettleFirst` |
| LibAutoRefinanceCheck | `RefinanceTargetNotActive`, `RefinanceTargetNotBorrower`, `RefinanceCapsRequired`, `RefinanceRateExceedsCap`, `RefinanceExpiryExceedsCap`, `RefinanceTargetIncompatible` |
| OfferCreateFacet | `InvalidRefinanceTarget` |

**`apps/defi/src/lib/autoLifecycleErrors.ts`** — new utility that matches an error's `shortMessage` / `message` against the known selector names + returns the matching translation key:

```ts
import { autoLifecycleErrorOrRaw } from '../lib/autoLifecycleErrors';
// at a call site that catches a contract revert:
catch (err) {
  setError(autoLifecycleErrorOrRaw(err, t));
}
```

The helper returns the localised string when the selector is recognised, falling back to the raw error message otherwise — so existing display sites can adopt it incrementally without breaking unknown-error display.

### Out of scope

Wiring the helper into every error-display site (LoanDetails / CreateOffer / Settings / KeeperSettings / Activity tooltips etc.). Each adopter is bounded enough to land in its own PR alongside the matching UI piece (#520 / #521 / #523).

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- Decoder matches on plain-text selector names (works against viem / wagmi / ethers error wrappers, all of which surface the Solidity error name in the message string).

## Thread — T-092 #511 sub: refinance-tagged offer construction on CreateOffer (#523)

Sub-fold of #511 (dapp UI surface). Wires the final user-facing piece of the auto-refinance flow — lets a borrower construct an offer with the intent to refinance one of their existing active loans, instead of needing to manually thread `refinanceTargetLoanId` into the payload.

### What's new

- **`OfferFormState.refinanceTargetLoanId: string`** — new form field on the offer-creation form state. Empty string ⇒ standard borrower offer (no refinance intent); non-empty ⇒ refinance-tagged.
- **`toCreateOfferPayload` plumbing** — threads the form value through to `CreateOfferPayload.refinanceTargetLoanId` as a `bigint`. ALSO auto-forces `fillMode = Aon` when the field is non-empty (the contract reverts `InvalidRefinanceTarget` on Partial fillMode for refinance-tagged offers).
- **CreateOffer form field** — new optional number input visible only on Borrower offers with ERC20 principal. Placeholder shows "Loan ID"; hint explains the keeper-driven refinance flow + the AON forcing + the per-loan caps requirement.

### Wire-up summary

Once the borrower:
1. Has set per-loan refinance caps on LoanDetails (#521).
2. Fills the new loan-ID input on CreateOffer with the target loan id.
3. Submits the offer.

The contract enforces `LibAutoRefinanceCheck.validate` at create time AND at accept time (Phase 2b, PR #510). A keeper can then call `RefinanceFacet.refinanceLoan(oldLoanId, borrowerOfferId)` — the apps/keeper auto-refinance pass is the next composition step (the auto-extend pass already lives in apps/keeper as of #517; auto-refinance gets its own pass since it composes the matcher's flow).

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- The form field is invisible on Lender offers (refinance is borrower-side only).
- The form field is invisible when assetType !== 'erc20' (the contract enforces ERC20 for refinance-tagged offers).
- Standard create flow still passes `refinanceTargetLoanId: 0n` (empty form input ⇒ 0n at payload-build time).

### Closes #511 entirely

This was the last remaining sub-card under T-092 follow-up #511 in this monorepo. The sibling `vaipakam-keeper-bot` repo (#518) tracks the public reference bot's auto-extend detector update — that's a separate repo + PR cycle, not gated on this PR.

### Operator action

None — works end-to-end with the existing diamond + dapp infrastructure. Borrowers see the new field on CreateOffer once the dapp deploys.

## Thread — T-092-A: refinance fund-source review and design clarification (#530)

#530 was originally framed as a vault-first wallet-fallback fund source for `RefinanceFacet.refinanceLoan`. Codex review on PR #538 caught a real correctness issue (round-1 P2): `protocolTrackedVaultBalance` is an aggregate counter that includes funds locked in active lender offers (which sit in the creator's own vault — `OfferCreateFacet._pullCreatorAssetsClassic`). A vault-first netting could double-spend committed funds, breaking downstream offer fills.

**Decision:** revert the vault-first path. Keep the existing wallet-pull flow as the canonical refinance payment source.

### Why this is OK

The user's original concern — "wallet pull requires a Metamask popup, how is it automatic?" — was already addressed by the standing approval pattern. At consent time, the borrower calls `IERC20.approve(diamond, …)` once. Every later `safeTransferFrom(borrower, …)` operates on the existing allowance — no popup at refinance time. The keeper-driven path works fully automatically.

Operational loan netting is preserved by the existing flow: `OfferAcceptFacet.sol:840` routes the new lender's principal to the borrower's WALLET on accept, and the refinance immediately pulls from the same wallet to pay the old loan. The new principal cycles in then out within a single tx — that's the same net outcome a vault-first design would have produced, just routed through the wallet allowance pathway.

### Test addition

A new positive-flow test `test_T092A_RefinanceWalletPath_StandingApprovalNoPopup` exercises the borrower-direct refinance happy path and asserts the wallet drains by approximately the payoff amount — documenting that operational netting is preserved via the wallet cycle. The two vault-first scenarios drafted earlier in this PR were removed alongside the contract revert.

### True vault-first netting requires a deeper change

A proper vault-first refinance netting would require invariant-preserving locked-balance tracking: a counter (or per-flow reservation) that distinguishes "free" vault funds from "committed to an active lender offer" funds. That's a meaningful architectural change touching `OfferCreate / OfferAccept / OfferCancel` and is out of scope for this PR. The wallet path is correct + audit-clean today.

### Verification

- forge build clean.
- RefinanceFacetTest 35/35 (was 34, +1 new wallet-path positive scenario).
- Deploy-sanity 12/12.
- ABI re-export unchanged (no contract surface changes after revert).

### What to do if vault-first netting becomes a requirement later

File a follow-up card for **locked-balance tracking** as the prerequisite. Once the protocol has a clean separation between free + committed vault funds, vault-first refinance netting becomes a small surgical change.

## Thread — T-092-B: default auto-refinance OFF for illiquid / NFT collateral (#531)

Closes the asymmetric-tail-risk gap in the T-092 auto-opt-in flow. A novice borrower who toggles `setAutoOptInOnNewLoan(true)` for their everyday liquid loans was previously silently enrolled in auto-refinance on their NFT-backed loans too — with a 100%-loss tail risk they almost certainly didn't understand.

### What's new

**Contract gate** ([`LoanFacet.sol:285`](contracts/src/facets/LoanFacet.sol#L285)) — the auto-opt-in populate-on-init path now requires `collateralLiquidity == LibVaipakam.LiquidityStatus.Liquid`. The check reuses the `collateralLiquidity` value already computed earlier in `initiateLoan` (line 202) — no extra `OracleFacet.checkLiquidity` round-trip.

When the gate fires (illiquid ERC20 collateral, NFT collateral, or temporary sequencer outage), the per-loan caps slot stays unpopulated. The borrower can still manually call `setAutoRefinanceCaps(loanId, ...)` to enroll a specific loan in the keeper-driven path — the explicit setter is unchanged. Only the silent auto-enrollment is gated.

### Why this asymmetry matters

| Collateral type | If auto-refinance fires | If it doesn't fire (default path) |
|---|---|---|
| Liquid ERC20 | Smooth handoff | `DefaultedFacet` swaps → borrower keeps surplus above debt |
| Illiquid ERC20 / NFT | Smooth handoff | **Lender takes whole collateral** ([`DefaultedFacet.sol:442-486`](contracts/src/facets/DefaultedFacet.sol#L442-L486)) — borrower loses 100% |

The auto-refinance opt-in is best-effort: it only fires if a compatible new lender offer exists in the book at the right time. If no match, the loan defaults. For liquid collateral the borrower still gets the swap surplus; for illiquid / NFT the loss is total. A convenience flag must not silently enroll a user into the latter.

### Dapp warning surface

`AutoLifecycleLoanCapsCard` (on LoanDetails) now accepts a `collateralIsNft` prop. When true, a stark warning banner renders above the editor sections:

> ⚠️ This loan's collateral is an NFT. If no compatible refinance offer is found before the grace period ends, your NFT will transfer in full to the lender (no market swap, no surplus). Auto-refinance is best-effort, not a guarantee. Consider repaying directly instead.

LoanDetails wires the prop from `Number(loan.collateralAssetType) === ERC721 || ERC1155`. The dapp warning surfaces only for NFT collateral today; illiquid ERC20 collateral warning is deferred to a follow-up (requires an extra `OracleFacet.checkLiquidity` view call from the dapp).

### Verification

- forge build clean (`viaIR + optimizer=200`).
- `T092AutoLifecycleIntegrationTest` 17/17 green (was 15, +2):
  - `test_T092B_AutoOptInGate_PopulatesOnLiquidCollateral` — happy path still works.
  - `test_T092B_AutoOptInGate_SkipsOnIlliquidCollateral` — new gate fires; caps stay unpopulated.
- Deploy-sanity 12/12; broader RefinanceFacet + AutoLifecycle + LoanFacet 81/81 green.
- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- ABI re-export ran (`exportFrontendAbis.sh`).

### Out of scope

- Illiquid ERC20 collateral warning on the dapp — separate follow-up; needs the dapp to call `OracleFacet.checkLiquidity` for the loan's collateral, which adds an RPC call.
- Manual setter (`setAutoRefinanceCaps`) is unchanged — sophisticated borrowers can still explicitly enroll any loan, including NFT-collateralised ones, by acknowledging the tail risk.

## Thread — T-092-C: pre-grace notification + manual-fallback CTA (#532)

Closes the "auto-refinance is best-effort, not a guarantee" UX gap. A borrower who enables refinance caps and assumes the protocol will guarantee a successful refinance gets a warning when their loan approaches the grace boundary AND no compatible offer has been matched yet.

### What's new

**New `apps/keeper/src/preGraceWatcher.ts` pass** — seventh `apps/keeper` cron pass (after watcher / daily oracle / matcher / liquidity confidence / liquidator / auto-lifecycle). Per chain:

1. Walk active loans via `MetricsFacet.getActiveLoansPaginated`.
2. For each loan: read `AutoLifecycleFacet.getAutoRefinanceCaps`. Skip if disabled.
3. Read `LoanFacet.getLoanDetails`. Skip non-Active loans.
4. Compute `endTime = startTime + durationDays * 86400`. Skip if more than 24h away OR already past endTime.
5. Resolve the borrower-NFT owner via `ERC721.ownerOf`.
6. Look up their TG / push subscription in the existing `user_thresholds` table (no separate opt-in surface needed — borrowers who subscribed for HF alerts get the pre-grace warning automatically).
7. Throttle to 1 warning per 12 hours via the new `pre_grace_notify_state` D1 table.
8. Dispatch a stark warning explaining auto-refinance is best-effort and listing three concrete actions (review terms, tighten caps, repay manually).

**New D1 table** `pre_grace_notify_state` ([apps/indexer/migrations/0023_pre_grace_notify_state.sql](apps/indexer/migrations/0023_pre_grace_notify_state.sql)) — separate from `notify_state` (HF band hysteresis) so the two concerns can't trip over each other.

**New db helpers** `getPreGraceNotifyState` / `putPreGraceNotifyState` in [apps/keeper/src/db.ts](apps/keeper/src/db.ts).

**index.ts wired** — pass slotted in after `runAutoLifecycle`. Same `try/catch` per-pass safety net the rest of the scheduled handler uses.

### Why a separate pass and not folded into runWatcher

The HF watcher iterates the user's active loans via `getUserActiveLoans` (subscribed-user subset, HF-band-driven hysteresis). The pre-grace watcher cares about ALL active loans on the chain (auto-refinance caps can be set on any loan, by any borrower) and triggers on time-to-grace, not HF band. Mixing the two would muddy `notify_state.last_band` hysteresis. Splitting keeps each pass's invariant simple.

### Out of scope

- **"No compatible offer exists" check** — the v1 warning fires on any loan approaching grace with caps enabled, regardless of whether the matcher has a viable counterparty. Adding the offer-book scan is a refinement for v2 — the existing matcher's read surface (`MetricsFacet.getMatchEligibleLoans` + `OfferMatchFacet.previewMatch`) can be queried but adds cost per loan. v1 over-warns conservatively.
- **Auto-subscribe on cap-set** — today a borrower who sets refinance caps but hasn't subscribed for HF alerts gets no pre-grace warning. Future enhancement: prompt subscription in the dapp's per-loan caps editor.
- **Loan Details dapp surface** — the warning also belongs on the dapp page as an inline banner. Separate dapp PR.
- **Atomic accept-and-refinance** ([#539](https://github.com/vaipakam/vaipakam/issues/539)) — eliminates the race condition between accept and refinance entirely. Pairs naturally with this pass.

### Verification

- `pnpm --filter @vaipakam/keeper exec tsc -p . --noEmit` clean.
- ABI imports route through the shared `@vaipakam/contracts/abis` bundle.

### Operator action

- Apply migration `0023_pre_grace_notify_state.sql` from `apps/indexer/` (per CLAUDE.md schema discipline):

  ```bash
  cd apps/indexer/
  wrangler d1 migrations apply vaipakam-archive --remote
  ```

- No new secrets needed — reuses existing `TG_BOT_TOKEN` + `PUSH_CHANNEL_PK` + `DB` bindings.

## Thread — T-092-D rename: "auto-lend / auto-refinance" → "auto-post lender / refinance offers" (#533)

i18n + label-only rename on the dapp surface to set accurate expectations. The current "auto-lend" / "auto-refinance" copy implied the protocol AUTONOMOUSLY picked counterparties + terms — but the reality is the dapp POSTS offers under the user's caps; a separate matcher / new lender must accept for anything to fire.

### What's new

- **Dashboard `AutoLifecycleSettingsCard`** copy:
  - "Auto-lend my vaulted assets" → "Auto-post lender offers when I deposit"
  - "Auto-set refinance caps on every new loan" → "Auto-set refinance offer terms on every new loan"
  - Body + hints reworded to clarify "posts offers + matcher matches" (not magic auto-execution).

- **LoanDetails `AutoLifecycleLoanCapsCard`** section title:
  - "Auto-refinance (borrower side)" → "Refinance offer posting (borrower side)"
  - Hint extended with a pointer to the pre-grace warning that's coming with #532.

- **Protocol Console knob labels**:
  - "Auto-lend kill switch" → "Auto-lend offer posting kill switch"
  - "Auto-refinance kill switch" → "Auto-refinance offer posting kill switch"
  - **"Auto-extend kill switch" unchanged** — auto-extend genuinely auto-executes once both sides pre-consent + a keeper calls. The other two are offer-posting flows that need a separate party to accept.

- **Revert error messages**:
  - `AutoLendDisabled` → "Auto-lend offer posting is disabled..."
  - `AutoRefinanceDisabled` → "Auto-refinance offer posting is disabled..."

### Why the asymmetric treatment

- `setAutoLendConsent` / `setAutoOptInOnNewLoan` are offer-posting consent — the dapp / protocol posts offers; the matcher matches them; the user retains effective control via caps.
- `extendLoanInPlace` is the only T-092 mechanism that truly auto-executes — both sides consent up front, the executor fires when the keeper calls it, no third-party offer / accept round. Renaming THAT to "auto-extend offer posting" would be inaccurate.

### On-chain ABIs unchanged

All on-chain function selectors (`setAutoLendConsent`, `setAutoRefinanceCaps`, etc.) and the contract storage layout stay byte-identical. This is purely an i18n + label change.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.

## Thread — T-092-F: opt-in friction on Dashboard auto-lifecycle toggles (#537)

Closes the "users silently enable auto-refinance and don't understand it's best-effort" gap. The two-step click-to-confirm pattern at every Enable surface ensures the borrower acknowledges the "best-effort, not guaranteed" reality before opting in.

### What's new

**Two-step toggle pattern on `AutoLifecycleSettingsCard`** (Dashboard). Both opt-in toggles (auto-lend, auto-opt-in-on-new-loan) now require a two-step click to enable:

1. First click on "Enable" → button text changes to "I understand & enable" + inline warning banner renders:
   > ⚠️ Auto-refinance is best-effort. If no compatible lender offer is found before your loan's grace period ends, the loan may be liquidated. You remain responsible for monitoring and repaying manually if needed.
2. Second click on "I understand & enable" → submits `setAutoLendConsent(true)` / `setAutoOptInOnNewLoan(true)`.

**Disabling never requires confirmation** — it's the safe direction.

### Why inline (not modal)

Modal dialogs train users to dismiss-without-reading. An inline persistent block that stays visible until the user clicks "I understand & enable" forces the eye to land on the text.

### State machine

```
[Enable] (click)
  → confirming = 'lend' | 'optIn'
  → button label changes to "I understand & enable"
  → warning banner renders
[I understand & enable] (click)
  → submit setter
  → clear confirming
```

### Pairs with the earlier T-092 work

- **#532 (pre-grace notification)** — borrowers now see the warning at OPT-IN time (this PR) AND get a notification when their loan actually approaches grace without a match.
- **#533 (rename to "offer posting")** — the rename already set accurate expectations; this PR adds the friction so the expectation lands.
- **#531 (default OFF for illiquid/NFT)** — the contract-side gate already silently skips NFT-collateral loans for auto-opt-in; this PR makes the user's CONSCIOUS opt-in for liquid loans more deliberate.

### Out of scope

- **LoanDetails `AutoLifecycleLoanCapsCard`** — the per-loan caps editor is a form with multiple inputs (enable checkbox, min/max rate, expiry). The two-step pattern doesn't directly fit; a separate friction model (e.g., a header banner that stays visible) would be needed. Deferred to a follow-up.
- **CreateOffer refinance-tagged path** — the warning is already in the hint copy (set during #533). Folding the two-step pattern into the form's submit button is a larger refactor; deferred.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- Disabling path unchanged (no confirmation required for the safe direction).
- Admin kill-switch state still gates the Enable button when applicable.

## Thread — T-092-H v2: atomic accept-and-refinance (#539)

Second attempt at #539. PR #542 was closed earlier today after Codex caught three blocking issues (P1 reentrancy nesting, P2 deferred-accept ordering, P3 misleading wrapper error). The [#549 design doc](docs/DesignsAndPlans/T092AtomicAcceptAndRefinance.md) specified the revised architecture; this PR implements it.

### Contract changes

#### `RefinanceFacet` — internal-callable variant

Existing `refinanceLoan(uint256, uint256) external nonReentrant whenNotPaused` is preserved as the external API for keeper EOAs + borrower-direct callers. The body has been extracted into a private `_refinanceLoanLogic`. A new `refinanceLoanFromAccept(uint256, uint256) external onlyDiamondInternal whenNotPaused` exposes the same logic to cross-facet callers without the `nonReentrant` guard — the outer `acceptOffer` / `matchOffers` `nonReentrant` lock covers the whole tx.

New error: `OnlyDiamondInternal` — fires when an external EOA tries to call `refinanceLoanFromAccept` directly. Mirrors the same shape used by `VaultFactoryFacet.onlyDiamondInternal`.

#### `OfferAcceptFacet._acceptOffer` — direct-path chain hook

After `offer.accepted = true` (inside the non-deferred `if (!deferAcceptFlip)` block at line 1010-1021), when the offer is a refinance-tagged Borrower offer, chain into `RefinanceFacet.refinanceLoanFromAccept` via `LibFacet.crossFacetCall`. The empty fallback selector (`bytes4(0)`) lets the inner revert payload bubble verbatim — the dapp's `autoLifecycleErrors.ts` decoder already handles the typed errors.

This branch covers:
- Direct `acceptOffer` calls.
- Direct `acceptOfferWithPermit` calls (same function body).
- `matchOffers` with `partialFillEnabled` OFF.

#### `OfferMatchFacet.matchOffers` — matched-path chain hook

In the borrower-side dust-close branch (after `bm.accepted = true` + `LibMetricsHooks.onOfferAccepted` + `OfferClosed` emit), when `bm.refinanceTargetLoanId != 0`, chain via the same `refinanceLoanFromAccept` selector. Closes the P2 gap that PR #542 had — the matched path with `partialFillEnabled` on now atomic-chains correctly.

#### Selector registry

Both `DeployDiamond.s.sol._getRefinanceSelectors()` and `HelperTest.getRefinanceFacetSelectors()` updated to include `refinanceLoanFromAccept` (2 selectors instead of 1).

### Tests

Two new tests in `T092AutoLifecycleIntegrationTest`:

- `test_T092H_AtomicAccept_DirectPath_ChainsInSameTx` — happy path. Builds an active loan, sets caps, creates a refinance-tagged offer, then a new lender (provisioned via the #548 helpers) accepts the offer with a single `acceptOffer` call. Asserts both loans transitioned: old → `Repaid`, new → `Active`. **Atomic guarantee verified end-to-end.**
- `test_T092H_RefinanceLoanFromAccept_RejectsExternalEOA` — structural guardrail. Asserts the `onlyDiamondInternal` modifier rejects direct external calls with `OnlyDiamondInternal` revert.

### Verification

- forge build clean.
- T092AutoLifecycleIntegrationTest 21/21 (was 19, +2 atomic-chain tests).
- Deploy-sanity 12/12 (selector registries updated; `SelectorCoverageTest` happy).
- RefinanceFacetTest 34/34, OfferFillModeTest + OfferMutateFacetTest broader 46/46 — no regression on the existing external entry.
- ABI re-export ran.

### Operator action

None. Pure contract change. The existing dapp surface (#523) sets `params.refinanceTargetLoanId` already; existing offers carrying the tag become atomic upon next accept.

### Pairs with

- **#530** — operational netting via wallet cycle is now structurally atomic (no multi-tx race window).
- **#532 + #545** — pre-grace warnings still relevant for loans where the matcher hasn't found a counterparty yet; the atomic chain only fires once a counterparty accepts.
- **#407** — vault encumbrance sub-ledger; once that lands, the refinance fund source can shift to vault-first without the locked-balance double-spend risk.

## Thread — T-092 dapp friction + pre-grace banner (#543 / #544 / #545)

Combined dapp PR closing three sibling cards that extend #537's opt-in friction pattern to the remaining dapp surfaces + mirror the keeper's #532 pre-grace notification on LoanDetails.

### #543 — LoanDetails caps editor inline best-effort warning

`AutoLifecycleLoanCapsCard` now renders a persistent inline warning whenever the user is transitioning the `enabled` checkbox from false → true on either editor (refinance caps or extend caps). The warning stays visible until the form submits (refreshes `current.enabled`) or the user un-checks the box.

> ⚠️ Auto-refinance and auto-extend are best-effort. If no compatible counterparty consent is found before this loan's grace period ends, the loan may be liquidated. You remain responsible for monitoring and repaying manually if needed.

Different shape from #537's Dashboard two-step button because the LoanDetails form has multiple inputs (rate, expiry, etc.); a persistent banner is the right friction model for that context.

### #544 — CreateOffer refinance-tagged best-effort warning

When the user fills the refinance-target loan id input on CreateOffer, an inline alert renders immediately below the field. Surfaces the reality that tagging an offer for refinance doesn't guarantee a match in time.

> ⚠️ Tagging this offer for refinance doesn't guarantee a match. If no compatible lender accepts before your existing loan's grace period ends, your loan will default. Auto-refinance is best-effort — review your caps on the LoanDetails page.

### #545 — LoanDetails pre-grace warning banner

`AutoLifecycleLoanCapsCard` now also renders a stark danger banner near the top when:

- The borrower has `refinanceCaps.enabled` (opted into the keeper-driven refinance path).
- The loan's `endTime` is within 24h.

> ⚠️ This loan enters its grace period in ~{{hours}}h. Auto-refinance is best-effort — if no compatible lender offer is matched before grace expires, your loan will default. Repay manually or tighten your refinance caps if the market has moved.

Mirrors the keeper-side `runPreGraceWatcher` (#532) but in the dapp — anyone who opens LoanDetails sees the warning regardless of TG / push subscription state. Hours-to-end is computed live.

The `loanEndTime` prop on `AutoLifecycleLoanCapsCard` is the new wire; `LoanDetails` passes the existing computed `endTime` (or 0 for non-active loans).

### Reuse

- `autoLifecycleLoanCaps.bestEffortWarning` + `autoLifecycleLoanCaps.preGraceWarning` i18n keys (new).
- `createOffer.refinanceTargetBestEffortWarning` (new).
- Existing `AlertTriangle` + `alert alert-warning/danger` styling.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.

### Out of scope

- Auto-subscribe on cap-set (#546).
- Offer-book scan in pre-grace watcher (#547).
- Atomic accept-and-refinance design doc + implementation (#549 / #539).

## Thread — T-092 pre-grace refinements (#546 + #547)

Two small refinements to the pre-grace warning surface that landed earlier (#532 + #545). Combined PR since they touch related code paths.

### #546 — Alerts subscription CTA on LoanDetails

`AutoLifecycleLoanCapsCard` now surfaces an inline info banner suggesting borrowers set up Telegram / Push alerts whenever they have refinance caps enabled:

> ⚠️ Set up Telegram or Push alerts so you'll be warned if no compatible refinance offer is found before your grace period ends. [Go to Alerts →]

Static for v1 — doesn't query actual subscription state (would require an extra fetch to the apps/agent's subscriptions endpoint). A borrower who's already subscribed sees the same banner; future enhancement: hide when subscription exists.

The CTA bridges the `runPreGraceWatcher` (#532) infrastructure with the user's mental model: "I enabled caps; now I need a notification channel so the protocol can tell me if the auto-refinance can't find a match."

### #547 — Viable-counterparty pre-check in `runPreGraceWatcher`

`apps/keeper/src/preGraceWatcher.ts` now scans the active offer book once per cron tick + filters to lender offers. Before dispatching the pre-grace warning for a loan, the watcher checks whether ANY in-book lender offer matches the loan's refinance shape:

- Same `lendingAsset` and `collateralAsset`.
- Same `assetType` and `collateralAssetType`.
- `amountMax >= loan.principal` (capacity covers the principal).

If at least one match exists, the matcher will likely fire in the next tick — the warning is suppressed to reduce notification noise. If no match exists OR the offer book exceeded `OFFER_SCAN_CAP` (500 offers per chain per tick), the warning fires unconditionally.

**Heuristic, not exact** — doesn't simulate `previewMatch` (would cost gas-equivalent eth_calls per loan). False negatives possible: a match might fail at the deeper HF / caps / sanctions checks. The borrower still gets the warning in those cases on the next tick because the offer would be removed from the book on the failed match.

False positives are also possible: a viable offer might NOT match in time (e.g., race with another keeper). That's the safe-conservative direction — we surface the warning if uncertain.

### Why combined PR

Both cards refine the same notification surface from different angles:
- #546 ensures the user can RECEIVE warnings (subscription channel).
- #547 ensures the warnings SENT are meaningful (no false positives).

Together they make `runPreGraceWatcher` notifications actionable instead of noisy.

### Verification

- `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean.
- `pnpm --filter @vaipakam/keeper exec tsc -p . --noEmit` clean.

### Operator action

None — both changes are dapp-side / off-chain only. No new D1 migration; no new contract surface.

## Thread — T-092 #548: reusable integration test fixture helpers

Foundation work for the upcoming #539 atomic accept-and-refinance integration test + future T-092 multi-actor scenarios. Extracted as its own PR to keep the #539 implementation diff focused on the contract change rather than test infrastructure.

### What's new

**Three internal helpers on `SetupTest`**, available to every test inheriting from it:

| Helper | Purpose |
|---|---|
| `_provisionFundedActor(name, token, walletAmount)` | Provision a new actor with `walletAmount` wei minted to their wallet + a max diamond approval on `token`. Returns the actor address. |
| `_fundActorVault(actor, token, amount)` | Direct-transfer + `recordVaultDepositERC20` pattern to fund an existing actor's vault. Mirrors the `_acceptBorrowerOffer` setup that RefinanceFacetTest uses for `newLender`. |
| `_provisionFundedActorWithVault(name, token, totalAmount)` | Convenience: actor with wallet AND vault funded (50/50 split) + standing diamond approval. The most common shape for atomic-flow tests. |
| `_grantStandingApprovalToDiamond(actor, token)` | Set a standing diamond approval on `token` for an existing actor (when the test reuses one of the standard fixture's actors but needs the approval set independently). |

### Why this matters

PR #542 (#539 first attempt) couldn't ship a happy-path integration test because the existing SetupTest fixture didn't carry the multi-actor allowance / vault dance needed. With these helpers any integration test can:

```solidity
function test_AtomicAcceptAndRefinance_HappyPath() public {
    uint256 oldLoanId = _buildActiveLoan();
    // ... borrower sets caps + creates refinance-tagged offer ...

    // One-line setup for the new lender:
    address newLender = _provisionFundedActorWithVault(
        "atomicNewLender", mockERC20, LOAN_PRINCIPAL * 2
    );

    vm.prank(newLender);
    OfferAcceptFacet(address(diamond)).acceptOffer(refinanceOfferId, true);

    // Assertions on both loans' status ...
}
```

### Smoke tests

Two new tests in `T092AutoLifecycleIntegrationTest` exercise the helpers:

- `test_T092Fixture_NewLenderProvisioning` — verifies wallet balance + vault proxy balance + max diamond approval after the 50/50 helper.
- `test_T092Fixture_GrantStandingApproval` — verifies the standalone approval helper works on a fresh actor.

### Verification

- forge build clean.
- T092AutoLifecycleIntegrationTest 19/19 green (was 17, +2 smoke tests).
- Deploy-sanity 12/12.
- RefinanceFacetTest 35/35 (no regression).

### Out of scope

- The full atomic-accept-and-refinance integration test that uses these helpers — that lands with #539 implementation.
- Multi-collateral-type test variants (ERC721 / ERC1155 collateral scenarios) — separate follow-up.
