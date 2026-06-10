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
