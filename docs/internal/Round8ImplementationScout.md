# T-086 Round-8 (§19 Borrow-OR-Sell) — Scout Report + Implementation Plan

**Date**: 2026-06-05
**Branch**: `impl/issue-355-round-7-grace-auto-list` (currently carries
both Round-7 §18 implementation reconciliation + Round-8 §19 design
through round-3.9)
**Workflow**: Scout-FIRST → Design → Code
([feedback_design_scout_code_workflow](/home/pranav/.claude/projects/-home-pranav-Codes-Vaipakam-vaipakam/memory/feedback_design_scout_code_workflow.md))
**Purpose**: Map the §19 design to the actual code surface BEFORE
writing any contract code. Catch architectural / integration
mismatches now, not during forge build.

---

## A. Reused-as-is (audit win) — 13 primitives

| Primitive | Location | Round-8 use |
| --- | --- | --- |
| `VaipakamVaultImplementation.registerListingOrderHash(orderHash, executor)` | `VaipakamVaultImplementation.sol:392` | Called TWICE per offer lifecycle (pre-loan hash at offer-create + active-loan hash at offer-accept) |
| `VaipakamVaultImplementation.revokeListingOrderHash(orderHash)` | `VaipakamVaultImplementation.sol:414` | Called TWICE (offer-accept revokes pre-loan hash; cleanup paths revoke whichever is live) |
| `VaipakamVaultImplementation.isValidSignature(hash, signature)` (ERC-1271) | `VaipakamVaultImplementation.sol:445` | Pre-loan branch's load-bearing rejection layer |
| `VaipakamVaultImplementation.setCollateralOperatorApproval(...)` (ERC721) | `VaipakamVaultImplementation.sol:327` | Pre-loan vault binding |
| `VaipakamVaultImplementation.setCollateralOperatorApprovalERC1155(...)` | `VaipakamVaultImplementation.sol:366` | Same, ERC1155 path |
| `LibPrepayOrder.buildAndHashMem(...)` | `LibPrepayOrder.sol:107` | Pre-loan + active-loan canonical hash construction |
| `LibPrepayOrder._components(...)` (internal) | `LibPrepayOrder.sol:337` | Transitive via `buildAndHashMem` |
| `LibEntitlement.proRataInterest(principal, rateBps, elapsedDays)` | `LibEntitlement.sol:33` | Pre-loan floor's projected first-period interest (§19.3); zero `treasuryFee` addend |
| `LibVaipakam.isSanctionedAddress(who)` | `LibVaipakam.sol:4807` | Caller + creator sanctions checks in `_acceptOffer`; same helper for the new diamond callback `assertOfferFillNotSanctioned` |
| `LibVaipakam.cfgTreasuryFeeBps()` | `LibVaipakam.sol:3356` | Post-accept active-loan branch (unchanged) |
| `OfferCancelFacet.cancelOffer(offerId)` | `OfferCancelFacet.sol:121` | The destructive teardown (§19.7b clarifies it's NOT the no-loan settlement callback; it IS the borrower-driven destructive path) |
| `CollateralListingExecutor._tryCancelOnSeaport(...)` (private) | `CollateralListingExecutor.sol:768` | The new `clearOfferOrder` MUST wire this for the §19.3 Scenario C two-layer rejection claim to hold |
| `VaultFactoryFacet.vaultDepositERC20From(...)` | `VaultFactoryFacet.sol:334` | Pattern for the `recordOfferSaleProceeds` diamond callback to credit the borrower's vault balance |

## B. Modified existing functions (additive — no behaviour change to existing paths)

| Function | Location | Round-8 modification |
| --- | --- | --- |
| `OfferAcceptFacet._acceptOffer` | `OfferAcceptFacet.sol:473` | Add gate `!s.offerConsumedBySale[offerId]` (revert `OfferConsumedBySale(offerId)`); add §19.3 two-order tear-down + re-record sequence (10 on-chain steps + 1 off-chain publish, in §19.3) |
| `OfferAcceptFacet.acceptOffer` (+ siblings: `acceptOfferInternal`, `acceptOfferWithPermit`) | `OfferAcceptFacet.sol:228, 270, 308` | No change (they all funnel into `_acceptOffer`) |
| `OfferCancelFacet.cancelOffer` | `OfferCancelFacet.sol:121` | Add `LibPrepayCleanup.clearOfferListing(offerId)` call BEFORE the existing collateral-refund step |
| `OfferCancelFacet.cancelExpiredOffer` (permissionless cleanup) | TBD — grep target | Same teardown as `cancelOffer` |
| `OfferMutateFacet.updateOffer` (and sibling mutation methods) | TBD — locate | Reject mutation of 5 load-bearing fields (`principal` / `interestRateBps` / `collateralAsset` / `collateralTokenId` / `allowsParallelSale`) when `s.offerPrepayListingOrderHash[offerId] != bytes32(0)`; additionally reject ALL mutations when `s.offerConsumedBySale[offerId] == true` |
| `CollateralListingExecutor.validateOrder` (zone callback outer) | `CollateralListingExecutor.sol:1065` | Extend the dispatch with a no-loan branch when `offerContext[orderHash].offerId != 0` (parallel to the existing `orderContext[orderHash].loanId != 0` branch) |
| 5 OfferActiveCheck sites — gate on `!offerConsumedBySale[offerId]` | `ProfileFacet.sol:413`, `OfferMatchFacet.sol:368/390/423/450/470`, `MetricsDashboardFacet.sol:339/464`, `EarlyWithdrawalFacet.sol:140/288/488`, `VPFIDiscountFacet.sol:753/811` | Each site already checks `offer.accepted` / `offerCancelled`; add the symmetric `offerConsumedBySale` bit |

## C. New code (minimised)

### C.1 — Storage additions

**Two new `Offer` struct fields** (slot 1 is already packed to 32 bytes
exactly; need new slots — pre-live so storage migration is cheap per
[project_platform_prelive](/home/pranav/.claude/projects/-home-pranav-Codes-Vaipakam-vaipakam/memory/project_platform_prelive.md)):

- `bool allowsParallelSale` — borrower opt-in at offer-create (slot 1 candidate if there's a free byte; otherwise new slot)
- `bytes32 parallelSaleOrderHash` — pre-loan Seaport order hash (new slot)

**Four new `LibVaipakam.Storage` mappings**:

- `mapping(uint256 => bool) offerConsumedBySale` (mirrors `s.offerCancelled` shape)
- `mapping(uint96 => bytes32) offerPrepayListingOrderHash` (mirror of the `Offer.parallelSaleOrderHash` field; keyed for fast direct lookup by callback paths)
- `mapping(uint96 => address) offerPrepayListingExecutor` (§19.7d executor-gate read site)
- `mapping(uint96 => uint64) parallelSaleNonce` (§19.10 Q3 — defeats same-block salt collisions)

**Two new executor (`CollateralListingExecutor`) storage**:

- `mapping(bytes32 orderHash => OfferContext) offerContext` (parallel to existing `mapping(bytes32 => OrderContext) orderContext`)
- `mapping(bytes32 orderHash => FeeLeg[]) _offerFeeLegs` (parallel to existing `_orderFeeLegs`)

`struct OfferContext`: see §19.6 — fields: `offerId / conduit / conduitKey / salt / startTime / askPrice / endTime / principalAsset / borrowerVault / borrowerWallet / mode`.

### C.2 — New executor interface (`IListingExecutorRecorder`) members + impl

3 new members + 1 modified caller-gate:

- `recordOfferOrder(bytes32 orderHash, OfferContext calldata ctx, FeeLeg[] calldata feeLegs)` external — diamond-only
- `clearOfferOrder(bytes32 orderHash)` external — diamond-only; MUST invoke `_tryCancelOnSeaport` (round-3.9 P3 dependency)
- `offerContext(bytes32 orderHash) returns (OfferContext memory)` view
- `offerFeeLegs(bytes32 orderHash) returns (FeeLeg[] memory)` view (already on `IListingExecutorRecorder` — confirm)

### C.3 — New diamond callbacks (executor → diamond)

All three gated on `msg.sender == s.offerPrepayListingExecutor[offerId]`
(per §19.7d):

- `markOfferConsumedBySale(uint96 offerId)` — sets the bit
- `recordOfferSaleProceeds(uint96 offerId, address principalAsset, uint256 amount)` — credits the borrower's vault balance via `vaultDepositERC20From` pattern (the diamond is the holder of `consideration[0]`; it forwards into the vault and stamps the protocol-tracked balance)
- `assertOfferFillNotSanctioned(uint96 offerId, address borrowerWallet)` — runs `LibVaipakam.isSanctionedAddress(borrowerWallet)` inside the diamond's storage slot

### C.4 — New facet selectors

- `OfferCreateFacet.postParallelSaleListing(uint96 offerId, uint256 askPrice, bytes32 conduitKey, FeeLeg[] calldata feeLegs)` — borrower-only post-offer-create entry; the design doc places this on `OfferCreateFacet` since it owns the offer lifecycle.
- `OfferCreateFacet.releaseParallelSaleLock(uint96 offerId)` — borrower-only non-destructive unlock; gated on `msg.sender == offer.creator`.

### C.5 — New cleanup library function

- `LibPrepayCleanup.clearOfferListing(uint96 offerId)` — full slot-clear set per §19.7c (5 items). Called from 5 sites (no-loan-branch sale terminal, offer-accept teardown, `cancelOffer`, `cancelExpiredOffer`, `releaseParallelSaleLock`).

### C.6 — New revert symbols (declarations only)

- `OfferLockedByParallelSale(uint96 offerId, bytes32 fieldKey)`
- `OfferConsumedBySale(uint96 offerId)`
- `OfferAlreadyHasParallelSale(uint96 offerId)`
- `NotOfferExecutor(uint96 offerId, address caller)`
- `ParallelSaleListingNotFound(uint96 offerId)`
- 2-3 more depending on the post / release / mutation paths' precondition surface

## D. Open integration questions (resolve before coding)

1. **`matchOverride.active` interaction with two-order accept-flow**: the §19.3 §19.3 Scenario B 10-step tear-down + re-record runs in `_acceptOffer`. When `matchOffers` triggers acceptance (override active), the SAME flow should fire — the offer's parallel-sale listing still needs cleanup when matched. Verify the implementation doesn't double-cleanup or skip the cleanup in the matchOffers path. The early-return at `OfferAcceptFacet.sol:391` is only inside `_refundBorrowerCollateralResidualIfNeeded`, not in `_acceptOffer` itself — likely fine, but worth a targeted test.

2. **`Offer.parallelSaleOrderHash` field vs `s.offerPrepayListingOrderHash` mapping**: design doc has BOTH (the field for offer-terms visibility, the mapping for fast callback-path lookup). Confirm the implementation keeps them in sync (every write touches both; every clear touches both). The §19.7c shared cleanup primitive already enumerates both — implementation just needs to actually do both.

3. **Executor `validateOrder` zone callback no-loan-branch dispatch order**: current dispatch reads `orderContext[orderHash]` and reverts on `loanId == 0`. The new dispatch should check `offerContext[orderHash].offerId != 0` FIRST (no-loan branch), fall through to the existing `orderContext` check (loan-keyed branch). Or use a mode constant in a unified context. The mapping-separation approach is what §19.6 picked (avoids the `loanId == 0` sentinel collision); confirm at impl time.

4. **`_assertOrderContent` no-loan branch**: needs a new `PREPAY_MODE_PRE_LOAN_FIXED_PRICE` constant + branch in `_assertOrderContent` that validates (a) `consideration[0].token == offerContext.principalAsset`, (b) `consideration[0].recipient == address(diamond)`, (c) every additional consideration item matches a fee leg in `_offerFeeLegs[orderHash]`. The Block D `_assertOrderContentAtomic` pattern (Round-6) is the template.

5. **Fee-aware `_requireAskCoversFloorWithFees` invariant**: `postParallelSaleListing` MUST enforce this same gate to prevent borrowers posting below-floor; the existing `NFTPrepayListingFacet._requireAskCoversFloorWithFees` body refactors to a pure helper callable from the new selector. Or duplicated — but duplication contradicts the [feedback_check_existing_primitives_before_coding] rule. Prefer extraction.

6. **`borrowerVault` resolution in `OfferContext`**: the design says `OfferContext.borrowerVault = s.userVaipakamVaults[offer.creator]`. Confirm the vault exists at offer-create time (the existing offer-create path already deploys the borrower's vault if absent — verify via `getOrCreateUserVault` pattern).

## E. Facet-addition 7-site checklist (per [feedback_facet_addition_checklist])

Round-8 doesn't ADD a new facet — `postParallelSaleListing` + `releaseParallelSaleLock` go on the existing `OfferCreateFacet`. So:

- ❌ `DiamondFacetNames` — no change needed
- ✅ `SelectorCoverageTest` (×2 sites) — add the 2 new selectors to `_getOfferCreateFacetSelectors`
- ❌ `FacetSizeLimitTest` — no new facet
- ❌ `DeployDiamondIntegrationTest` — facet already deployed
- ✅ `DeployDiamond.s.sol` — add 2 selectors to `_getOfferCreateFacetSelectors`
- ✅ `SetupTest.t.sol` — no factoring change; selectors auto-discover
- ✅ `HelperTest.sol` — add 2 selectors to `getOfferCreateFacetSelectors`
- ✅ `exportFrontendAbis.sh` — `OfferCreateFacet` already in FACETS array; new ABI will be re-exported on next run
- ✅ `packages/contracts/src/abis/index.ts` — re-export is in place
- ✅ Indexer event-coverage allowlist — `PostParallelSaleListing` + `OfferListingCleared` + `OfferSaleProceedsCredited` events need handlers OR `DELIBERATELY_NOT_HANDLED` entries

For the executor + LibPrepayCleanup additions:
- `IListingExecutorRecorder` interface bump propagates through
  `MockListingExecutorRecorder.sol` co-update +
  `exportFrontendAbis.sh` re-export + the dapp + keeper-bot ABI sync
  per the facet-addition checklist.

## F. Recommended PR slicing

Per [feedback_contracts_pr_granularity](/home/pranav/.claude/projects/-home-pranav-Codes-Vaipakam-vaipakam/memory/feedback_contracts_pr_granularity.md):
**one atomic PR for the full §19 implementation** (per §19's
atomic-merge constraint). Estimated surface from the inventory above:

- ~150-250 LOC new selector code (`postParallelSaleListing` +
  `releaseParallelSaleLock` + the helper extraction)
- ~100-150 LOC executor extension (no-loan-branch validation + new
  selectors + the 2 new storage mappings + offer-context shape)
- ~80-100 LOC `LibPrepayCleanup.clearOfferListing` + library wiring
- ~5-7 OfferActiveCheck-site additions (~5-10 LOC each)
- ~200-300 LOC tests covering §19.9 obligations (10+ tests)

Estimated cold-build cost: 1 full forge build per push + ~2-3 Codex
review cycles (the §19 design is well-scoped after 9 rounds of
adversarial iteration; the contract code should land with fewer
findings than a typical large PR).

## G. Estimated effort

Given the design is settled + the scout reveals most surfaces are
reused: ~4-6 hours of focused implementation + ~2-3 hours of test
authoring + ~1-2 Codex review cycles for finding-fix iteration. Order
of magnitude: 1 working day.

## H. Next step

Open the §19 implementation Issue on
[@vaipakam-labs](https://github.com/users/vaipakam/projects/1) with
this scout as the body. Tag with `enhancement` + `mainnet-rollout`
(pre-audit hardening pre-req). Then open the implementation PR
against `main` after PR #360 merges.
