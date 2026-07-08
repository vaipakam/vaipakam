// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../../src/libraries/LibInteractionRewards.sol";
import {LibMetricsHooks} from "../../src/libraries/LibMetricsHooks.sol";
import {LibERC721} from "../../src/libraries/LibERC721.sol";
import {LibCollateralSettlement} from "../../src/libraries/LibCollateralSettlement.sol";
import {LibPrepayCleanup} from "../../src/libraries/LibPrepayCleanup.sol";

/// @title TestMutatorFacet
/// @notice Test-only facet that exposes full struct setters for Loan and
///         Offer storage. NOT to be cut into production deployments.
/// @dev Tests do read-modify-write: fetch the struct via the real getter,
///      mutate the field they want, then call {setLoan} or {setOffer}.
///      This makes test setup code layout-independent — reordering or
///      packing fields in LibVaipakam.Loan / LibVaipakam.Offer does not
///      require changes to any test that used to vm.store raw slot
///      offsets, because Solidity's named-field assignment handles the
///      mapping.
contract TestMutatorFacet {
    /// @notice Overwrite the entire Loan record at `loanId`.
    function setLoan(uint256 loanId, LibVaipakam.Loan memory data) external {
        LibVaipakam.storageSlot().loans[loanId] = data;
    }

    /// @notice Test-only entry that invokes the step-10
    ///         {LibPrepayCleanup.clearActiveListing} helper from
    ///         the diamond's storage context. Equivalent to what
    ///         `DefaultedFacet.triggerDefault` and
    ///         `RiskFacet.triggerLiquidation*` do as their first
    ///         step, without the surrounding KYC / oracle / swap
    ///         scaffolding.
    function invokePrepayCleanup(uint256 loanId) external {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        LibPrepayCleanup.clearActiveListing(loan, loanId);
    }

    /// @notice Overwrite the entire Offer record at `offerId`.
    function setOffer(uint256 offerId, LibVaipakam.Offer memory data) external {
        LibVaipakam.storageSlot().offers[offerId] = data;
    }

    /// @notice Scaffold an active loan end-to-end — writes the struct AND
    ///         fires {LibMetricsHooks.onLoanInitialized} so counters, the
    ///         active-loan list, NFT-by-collection tallies, unique-user
    ///         bookkeeping, and the position-token reverse mapping are all
    ///         populated the same way a live `LoanFacet.initiateLoan` would.
    ///         Use this (not {setLoan}) in tests that exercise MetricsFacet
    ///         views or anything else that reads the hook-maintained state.
    function scaffoldActiveLoan(uint256 loanId, LibVaipakam.Loan memory data) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.loans[loanId] = data;
        // Mirror prod's LoanFacet.initiateLoan: populate the per-user
        // index so user-keyed views (getUserLoansPaginated,
        // getUserDashboardLoans, getUserSummary, etc.) see the
        // scaffolded loan. `LibMetricsHooks.onLoanInitialized` only
        // updates the active-list + counters, not `userLoanIds`.
        s.userLoanIds[data.lender].push(loanId);
        if (data.borrower != address(0) && data.borrower != data.lender) {
            s.userLoanIds[data.borrower].push(loanId);
        }
        LibMetricsHooks.onLoanInitialized(s.loans[loanId]);
    }

    /// @notice Scaffold an open offer end-to-end — see {scaffoldActiveLoan}.
    function scaffoldOpenOffer(uint256 offerId, LibVaipakam.Offer memory data) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.offers[offerId] = data;
        // Mirror prod's OfferCreateFacet.createOffer: populate the per-user
        // index. `LibMetricsHooks.onOfferCreated` covers the active
        // list + counters; the per-user index lives separately.
        s.userOfferIds[data.creator].push(offerId);
        LibMetricsHooks.onOfferCreated(s.offers[offerId]);
    }

    /// @notice Writes `to` into `loans[id].status` AND fires the matching
    ///         {LibMetricsHooks.onLoanStatusChanged} hook so counters and
    ///         the active-loan list are updated the same way a live
    ///         {LibLifecycle.transition} would. The caller supplies the
    ///         prior status; on the production path LibLifecycle reads it
    ///         from storage before the mutation but here we accept it as a
    ///         parameter so tests can simulate arbitrary transitions
    ///         (e.g. Active → Defaulted) without driving the full flow.
    function scaffoldLoanStatusChange(
        uint256 id,
        LibVaipakam.LoanStatus from,
        LibVaipakam.LoanStatus to
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[id];
        loan.status = to;
        LibMetricsHooks.onLoanStatusChanged(loan, from, to);
    }

    /// @notice Bump the `nextLoanId` counter so MetricsFacet iteration ranges
    ///         can be scaffolded without running the full Offer → Loan flow.
    function setNextLoanId(uint256 v) external {
        LibVaipakam.storageSlot().nextLoanId = v;
    }

    /// @notice Bump the `nextOfferId` counter — see {setNextLoanId}.
    function setNextOfferId(uint256 v) external {
        LibVaipakam.storageSlot().nextOfferId = v;
    }

    /// @notice Overwrite the treasury address. Tests use this so they can
    ///         receive initiation / interest fees at the Diamond itself
    ///         (address(this)) without having to cut AdminFacet in.
    function setTreasuryAddress(address t) external {
        LibVaipakam.storageSlot().treasury = t;
    }

    /// @notice Test-only: flip the README §16 Phase 1 KYC pass-through flag.
    ///         Allows tests that exercise the retained tiered-KYC framework
    ///         to activate enforcement without cutting AdminFacet into their
    ///         minimal diamond setup.
    // forge-lint: disable-next-line(mixed-case-function)
    function setKYCEnforcementFlag(bool enforced) external {
        LibVaipakam.storageSlot().kycEnforcementEnabled = enforced;
    }

    /// @notice Flip `ProtocolConfig.discountPathEnabled` directly for
    ///         tests that don't cut `ConfigFacet` into the diamond.
    ///         FlashLoanLiquidationPath.md kill-switch.
    function setDiscountPathEnabledRaw(bool enabled) external {
        LibVaipakam.storageSlot().protocolCfg.discountPathEnabled = enabled;
    }

    /// @notice Flip `ProtocolConfig.depthTieredLtvEnabled` directly
    ///         for tests that don't cut `ConfigFacet` into the diamond.
    ///         MarketRateWidgetAndDepthTieredLTV.md §4.2 kill-switch
    ///         — gates the LoanFacet / LibOfferMatch / RefinanceFacet
    ///         tier-LTV cap + relaxed-HF-floor regime.
    function setDepthTieredLtvEnabledRaw(bool enabled) external {
        LibVaipakam.storageSlot().protocolCfg.depthTieredLtvEnabled = enabled;
    }

    /// @notice Set `ProtocolConfig.rentalBufferBps` directly for tests that
    ///         don't cut `ConfigFacet` into the diamond. #998 S8 (#1004) —
    ///         exercises the rental late-fee cap `min(5%, cfgRentalBufferBps())`
    ///         so a buffer configured below 5% cannot brick a late rental.
    function setRentalBufferBpsRaw(uint16 bps) external {
        LibVaipakam.storageSlot().protocolCfg.rentalBufferBps = bps;
    }

    // ─── Reward-pool mutators (for interaction coverage tests) ───────────────
    // #687-B: setStakingPoolPaidOut removed with the 5% VPFI staking yield.

    /// @notice Set the cumulative paid-out counter for the interaction pool.
    function setInteractionPoolPaidOut(uint256 v) external {
        LibVaipakam.storageSlot().interactionPoolPaidOut = v;
    }

    /// @notice Rewind/fast-forward a user's interaction claim cursor.
    function setInteractionLastClaimedDay(address user, uint256 day) external {
        LibVaipakam.storageSlot().interactionLastClaimedDay[user] = day;
    }

    /// @notice Seed per-day per-user + total USD counters for the lender
    ///         interaction side. Avoids driving the full OfferFacet +
    ///         RepayFacet E2E path when only the reward-split math is
    ///         under test.
    /// @dev Also mirrors `totalNumeraire18` into the cross-chain `knownGlobalLender`
    ///      slot and flips `knownGlobalSet[day]` so the §4a gate enforced
    ///      by {InteractionRewardsFacet} passes on the single-chain test
    ///      harness. Tests that need the gate to FAIL (e.g. finalize-is-
    ///      required coverage) should call {setKnownGlobalSet(day, false)}
    ///      after seeding, or use {setKnownGlobalDailyInterest} directly.
    function setDailyLenderInterest(
        uint256 day,
        address user,
        uint256 userNumeraire18,
        uint256 totalNumeraire18
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.userLenderInterestNumeraire18[day][user] = userNumeraire18;
        s.totalLenderInterestNumeraire18[day] = totalNumeraire18;
        s.knownGlobalLenderInterestNumeraire18[day] = totalNumeraire18;
        s.knownGlobalSet[day] = true;
    }

    /// @notice Seed per-day per-user + total USD counters for the borrower
    ///         interaction side. See {setDailyLenderInterest}.
    function setDailyBorrowerInterest(
        uint256 day,
        address user,
        uint256 userNumeraire18,
        uint256 totalNumeraire18
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.userBorrowerInterestNumeraire18[day][user] = userNumeraire18;
        s.totalBorrowerInterestNumeraire18[day] = totalNumeraire18;
        s.knownGlobalBorrowerInterestNumeraire18[day] = totalNumeraire18;
        s.knownGlobalSet[day] = true;
    }

    /// @notice Directly overwrite the §4a cross-chain global denominator
    ///         pair for `day` and the finalized-flag. Used by coverage
    ///         tests that assert the gate's negative path (claims revert
    ///         before the broadcast has landed).
    function setKnownGlobalDailyInterest(
        uint256 day,
        uint256 lenderTotalNumeraire18,
        uint256 borrowerTotalNumeraire18,
        bool isSet
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.knownGlobalLenderInterestNumeraire18[day] = lenderTotalNumeraire18;
        s.knownGlobalBorrowerInterestNumeraire18[day] = borrowerTotalNumeraire18;
        s.knownGlobalSet[day] = isSet;
    }

    /// @notice Flip just the finalized flag for `day` without touching
    ///         the global totals. Test-only escape hatch for the §4a gate.
    function setKnownGlobalSet(uint256 day, bool isSet) external {
        LibVaipakam.storageSlot().knownGlobalSet[day] = isSet;
    }

    /// @notice Write the ETH/USD Chainlink feed address directly. Lets
    ///         reward-cap coverage tests exercise the §4 per-user cap
    ///         without cutting OracleAdminFacet into the harness.
    function setEthUsdFeedRaw(address feed) external {
        LibVaipakam.storageSlot().ethNumeraireFeed = feed;
    }

    /// @notice Test-only: stamp `s.wethContract` directly without going
    ///         through `OracleAdminFacet.setWethContract` (which the
    ///         minimal test fixtures don't cut). Used by
    ///         `NotificationFeeTest` to exercise
    ///         `LibNotificationFee`'s Phase 1 fallback path
    ///         (ETH/USD via OracleFacet × fixed VPFI/ETH rate),
    ///         which reads `s.wethContract`.
    function setWethContractRaw(address weth) external {
        LibVaipakam.storageSlot().wethContract = weth;
    }

    /// @notice Write the admin-configurable per-user interaction-reward
    ///         cap override directly. Zero = fall back to default; the
    ///         uint256 max sentinel disables the cap entirely.
    function setInteractionCapVpfiPerEthRaw(uint256 value) external {
        LibVaipakam.storageSlot().interactionCapVpfiPerEth = value;
    }

    /// @notice Write `protocolTrackedVaultBalance[user][token]`
    ///         directly. PR5 of internal-match work — execution-body
    ///         tests `scaffoldActiveLoan` + `ERC20Mock.mint(vault,
    ///         …)` to set up loans without going through the
    ///         `initiateLoan` HF gate, but that bypasses the
    ///         counter that `vaultDepositERC20` would otherwise
    ///         tick up. Without a matching counter write, the
    ///         later `vaultWithdrawERC20` underflows when it
    ///         decrements an untracked balance. This helper closes
    ///         that gap purely for tests.
    function setProtocolTrackedVaultBalanceRaw(
        address user,
        address token,
        uint256 amount
    ) external {
        LibVaipakam.storageSlot().protocolTrackedVaultBalance[user][token] = amount;
    }

    /// @notice Write all three per-tier liquidation-LTV slots in
    ///         `protocolCfg` directly. PR2 of internal-match work —
    ///         lets tests that don't cut `ConfigFacet` (most legacy
    ///         test diamonds) seed the same per-tier defaults the
    ///         production setter (`setTierLiquidationLtvBps`) would
    ///         configure. Useful in test setUp to pin the legacy
    ///         "every asset = 85%" behaviour by passing
    ///         `(8500, 8500, 8500)`. Bypasses the bounded + monotonic
    ///         checks in the production setter — callers in tests can
    ///         supply nonsense values to stress edge cases. Layout-
    ///         resilient via the named-field storage path.
    function setTierLiquidationLtvBpsAllRaw(uint16 t1, uint16 t2, uint16 t3) external {
        LibVaipakam.ProtocolConfig storage c = LibVaipakam.storageSlot().protocolCfg;
        c.tier1LiquidationLtvBps = t1;
        c.tier2LiquidationLtvBps = t2;
        c.tier3LiquidationLtvBps = t3;
    }

    /// @notice #999 (S1) — read-through to the internal
    ///         `LibVaipakam.cfgTierLiquidationLtvBps(tier)` so a test can assert
    ///         the per-tier-INDEX mapping directly, including the tier-0
    ///         untierable fallback (which must alias the conservative Tier-1
    ///         value post-#999, not Tier 3). No production view exposes the
    ///         per-index lookup, so this test-only passthrough is the cleanest
    ///         proof of the tier-0 remap.
    function tierLiquidationLtvBpsFor(uint8 tier) external view returns (uint256) {
        return LibVaipakam.cfgTierLiquidationLtvBps(tier);
    }

    /// @notice Write `loans[loanId].liquidationLtvBpsAtInit` directly,
    ///         bypassing the snapshot-at-init logic in `LoanFacet`.
    ///         Lets tests stress edge cases in HF math —
    ///         e.g. `liquidationLtvBpsAtInit == 0` (which the
    ///         production snapshot path skips for liquid collateral).
    ///         PR2 replacement for the retired `setLiqThresholdBpsRaw`;
    ///         the per-asset `RiskParams.liqThresholdBps` it wrote no
    ///         longer exists (liquidation threshold is now per-tier,
    ///         snapshotted onto each loan).
    /// @dev    Compiler resolves the storage slot via the named field
    ///         path — no hardcoded magic numbers, so this stays correct
    ///         when the `Storage` / `Loan` struct layouts shift.
    function setLiquidationLtvBpsAtInitRaw(uint256 loanId, uint16 bps) external {
        LibVaipakam.storageSlot().loans[loanId].liquidationLtvBpsAtInit = bps;
    }

    /// @notice Write `s.offerIdToLoanId[offerId] = loanId` directly.
    ///         Used by `EarlyWithdrawalFacetTest` to scaffold the
    ///         loan-sale state without going through the full
    ///         create-offer + accept lifecycle. Layout-resilient via
    ///         the named-field storage path — no hardcoded slot math.
    function setOfferIdToLoanIdRaw(uint256 offerId, uint256 loanId) external {
        LibVaipakam.storageSlot().offerIdToLoanId[offerId] = loanId;
    }

    /// @notice Write `s.heldForLender[loanId] = amount` directly.
    ///         Used by tests that need to scaffold preclose-residual
    ///         state without running a full preclose flow.
    function setHeldForLenderRaw(uint256 loanId, uint256 amount) external {
        LibVaipakam.storageSlot().heldForLender[loanId] = amount;
    }

    /// #594 test — append a loanId to a user's loan index directly (to set up
    /// the already-indexed dup-protection case).
    function pushUserLoanIdRaw(address user, uint256 loanId) external {
        LibVaipakam.storageSlot().userLoanIds[user].push(loanId);
    }

    /// #594 test — read the configured VPFI token so a test can point a loan's
    /// principalAsset at it (exercising the VPFI-heldForLender exclusion).
    function vpfiTokenRaw() external view returns (address) {
        return LibVaipakam.storageSlot().vpfiToken;
    }

    /// #597/#673 test — designate the VPFI token directly, for harnesses whose
    /// diamond does not cut `VPFITokenFacet` (e.g. EarlyWithdrawalFacetTest).
    function setVpfiTokenRaw(address token) external {
        LibVaipakam.storageSlot().vpfiToken = token;
    }

    /// #594 test — set a loan's per-loan lender-proceeds reservation (amount +
    /// asset) directly, to exercise the partially-reserved VPFI-held exclusion.
    function setLenderProceedsEncumberedRaw(
        uint256 loanId,
        address asset,
        uint256 amount
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.lenderProceedsEncumbered[loanId] = amount;
        s.lenderProceedsEncumberedAsset[loanId] = asset;
    }

    /// @notice Overwrite `s.lenderClaims[loanId].amount` directly.
    ///         Layout-resilient — used by `ClaimFacetTest` to exercise
    ///         the `NothingToClaim` revert without slot math.
    function setLenderClaimAmountRaw(uint256 loanId, uint256 amount) external {
        LibVaipakam.storageSlot().lenderClaims[loanId].amount = amount;
    }

    /// @notice Overwrite `s.borrowerClaims[loanId].amount` directly.
    ///         Mirror of `setLenderClaimAmountRaw` for the borrower side.
    function setBorrowerClaimAmountRaw(uint256 loanId, uint256 amount) external {
        LibVaipakam.storageSlot().borrowerClaims[loanId].amount = amount;
    }

    /// @notice Overwrite `s.lenderClaims[loanId].asset` directly. Used
    ///         by tests that need to scaffold a claim against a
    ///         not-deployed asset address.
    function setLenderClaimAssetRaw(uint256 loanId, address asset) external {
        LibVaipakam.storageSlot().lenderClaims[loanId].asset = asset;
    }

    /// @notice Overwrite `s.borrowerClaims[loanId].asset` directly.
    function setBorrowerClaimAssetRaw(uint256 loanId, address asset) external {
        LibVaipakam.storageSlot().borrowerClaims[loanId].asset = asset;
    }

    /// @notice Overwrite the NFT-claim fields on `s.lenderClaims[loanId]`
    ///         (assetType + tokenId + quantity) without disturbing the
    ///         asset / amount / claimed fields. Used by ClaimFacetTest's
    ///         ERC721 / ERC1155 claim-asset coverage tests.
    // forge-lint: disable-next-line(mixed-case-function)
    function setLenderClaimNFTFieldsRaw(
        uint256 loanId,
        LibVaipakam.AssetType assetType,
        uint256 tokenId,
        uint256 quantity
    ) external {
        LibVaipakam.ClaimInfo storage c = LibVaipakam.storageSlot().lenderClaims[loanId];
        c.assetType = assetType;
        c.tokenId = tokenId;
        c.quantity = quantity;
    }

    /// @notice Mirror of `setLenderClaimNFTFieldsRaw` for the borrower
    ///         side.
    // forge-lint: disable-next-line(mixed-case-function)
    function setBorrowerClaimNFTFieldsRaw(
        uint256 loanId,
        LibVaipakam.AssetType assetType,
        uint256 tokenId,
        uint256 quantity
    ) external {
        LibVaipakam.ClaimInfo storage c = LibVaipakam.storageSlot().borrowerClaims[loanId];
        c.assetType = assetType;
        c.tokenId = tokenId;
        c.quantity = quantity;
    }

    /// @notice Write `s.treasuryBalances[asset] = amount` directly.
    ///         Used by `TreasuryFacetTest` to scaffold a treasury IOU
    ///         without running a full fee-accrual flow.
    function setTreasuryBalanceRaw(address asset, uint256 amount) external {
        LibVaipakam.storageSlot().treasuryBalances[asset] = amount;
    }

    /// @notice Write `s.backstopAbsorbCash[principal][collateral]` directly.
    ///         Used by `BackstopAbsorbTest` to isolate the insufficient-cash
    ///         guard without spending the seeded bucket down.
    function setBackstopAbsorbCashRaw(
        address principal,
        address collateral,
        uint256 amount
    ) external {
        LibVaipakam.storageSlot().backstopAbsorbCash[principal][collateral] = amount;
    }

    /// @notice Write `s.saleOfferToLoanId[offerId] = loanId` directly.
    ///         Used by tests scaffolding lender-sale completion without
    ///         running the full sale flow.
    function setSaleOfferToLoanIdRaw(uint256 offerId, uint256 loanId) external {
        LibVaipakam.storageSlot().saleOfferToLoanId[offerId] = loanId;
    }

    /// @notice Write `s.loanToSaleOfferId[loanId] = saleOfferId` directly (the
    ///         loan→listing forward link). Used by #951 (Codex #959) tests that
    ///         assert a live listing freezes collateral withdrawal / direct sale.
    function setLoanToSaleOfferIdRaw(uint256 loanId, uint256 saleOfferId) external {
        LibVaipakam.storageSlot().loanToSaleOfferId[loanId] = saleOfferId;
    }

    // #951 v2 (Codex #959 bind-to-live) — `setSaleListingCollateralRaw` was
    // removed with the `saleListingCollateral` snapshot mapping. The accept now
    // binds collateral `>=` live against the loan in `_bindTermsToOffer`, so
    // there is no snapshot for tests to scaffold.

    /// @notice Write `s.offsetOfferToLoanId[offerId] = loanId` directly.
    ///         Used by OfferFacet auto-complete coverage tests.
    function setOffsetOfferToLoanIdRaw(uint256 offerId, uint256 loanId) external {
        LibVaipakam.storageSlot().offsetOfferToLoanId[offerId] = loanId;
    }

    /// @notice Write `s.vaultVersion[user] = version` directly.
    ///         Used by `VaultFactoryFacetTest` to simulate a user
    ///         whose proxy is already at a specific version.
    function setVaultVersionRaw(address user, uint256 version) external {
        LibVaipakam.storageSlot().vaultVersion[user] = version;
    }

    /// @notice Write `s.assetRiskParams[asset].minPartialBps = bps`
    ///         directly. Used by `RepayFacetTest.testRepayPartialRevertsMinPartialAmount`
    ///         to set the min-partial floor without going through the
    ///         bounded-range setter on `RiskFacet.updateRiskParams`.
    function setMinPartialBpsRaw(address asset, uint256 bps) external {
        LibVaipakam.storageSlot().assetRiskParams[asset].minPartialBps = bps;
    }

    /// @notice Write `s.assetRiskParams[asset].loanInitMaxLtvBps = bps` directly.
    ///         #998 S15 — a liquid collateral asset needs a configured per-asset
    ///         init-LTV cap for `LibOfferBounds` to admit an offer against it
    ///         (a 0 cap is no-borrow at loan-init, so the create/mutate bound
    ///         rejects it fail-fast). Bespoke diamonds that don't cut `RiskFacet`
    ///         use this instead of the bounded `RiskFacet.updateRiskParams`.
    function setLoanInitMaxLtvBpsRaw(address asset, uint256 bps) external {
        LibVaipakam.storageSlot().assetRiskParams[asset].loanInitMaxLtvBps = bps;
    }

    /// @notice Read `s.userVaipakamVaults[user]` directly. Used by
    ///         `WorkflowComplianceAndRejection` test to look up a
    ///         user's vault proxy address bypassing the
    ///         `getOrCreateUserVault` path's mandatory-version
    ///         check (which would revert in the upgrade-required
    ///         scenario the test exercises).
    function getUserVaipakamVaultRaw(address user) external view returns (address) {
        return LibVaipakam.storageSlot().userVaipakamVaults[user];
    }

    // #687-B: the staking-accrual storage getters (getStakingRPTStored,
    // getStakingLastUpdateTime, getUserStakingPaid, getUserStakingPending)
    // were removed with the 5% VPFI staking yield.

    // ─── Reverse-index mutators (enumeration tests) ─────────────────────────

    /// @notice Append `loanId` to the user's reverse loan index.
    function pushUserLoanId(address user, uint256 loanId) external {
        LibVaipakam.storageSlot().userLoanIds[user].push(loanId);
    }

    /// @notice Append `offerId` to the user's reverse offer index.
    function pushUserOfferId(address user, uint256 offerId) external {
        LibVaipakam.storageSlot().userOfferIds[user].push(offerId);
    }

    /// @notice Flip the offer-cancelled history marker directly.
    function setOfferCancelled(uint256 offerId, bool cancelled) external {
        LibVaipakam.storageSlot().offerCancelled[offerId] = cancelled;
    }

    /// @notice Flip the Scenario-A consumed-by-sale terminal marker directly.
    ///         Used by `EnumerationTest.testGetOfferState` to exercise the
    ///         `ConsumedBySale` branch of `MetricsFacet.getOfferState` (#955).
    function setOfferConsumedBySaleRaw(uint256 offerId, bool consumed) external {
        LibVaipakam.storageSlot().offerConsumedBySale[offerId] = consumed;
    }

    // ─── Metrics-counter read-through (invariant-suite accessors) ──────────
    //
    // Expose the fields that LibMetricsHooks maintains but that aren't
    // on any production read path. The counter-parity invariant needs
    // direct access to assert that
    //   • activeLoanIdsListPos / activeOfferIdsListPos stay 1-based and
    //     consistent with their list, and
    //   • the hook-maintained counters never drift from a full-scan
    //     ground truth.

    function getActiveLoanIdsListLength() external view returns (uint256) {
        return LibVaipakam.storageSlot().activeLoanIdsList.length;
    }

    function getActiveLoanIdAt(uint256 i) external view returns (uint256) {
        return LibVaipakam.storageSlot().activeLoanIdsList[i];
    }

    function getActiveLoanIdPos(uint256 loanId) external view returns (uint256) {
        return LibVaipakam.storageSlot().activeLoanIdsListPos[loanId];
    }

    function getActiveOfferIdsListLength() external view returns (uint256) {
        return LibVaipakam.storageSlot().activeOfferIdsList.length;
    }

    function getActiveOfferIdAt(uint256 i) external view returns (uint256) {
        return LibVaipakam.storageSlot().activeOfferIdsList[i];
    }

    function getActiveOfferIdPos(uint256 offerId) external view returns (uint256) {
        return LibVaipakam.storageSlot().activeOfferIdsListPos[offerId];
    }

    function getActiveLoansCounter() external view returns (uint256) {
        return LibVaipakam.storageSlot().activeLoansCount;
    }

    function getActiveOffersCounter() external view returns (uint256) {
        return LibVaipakam.storageSlot().activeOffersCount;
    }

    function getTotalLoansEverCreatedCounter() external view returns (uint256) {
        return LibVaipakam.storageSlot().totalLoansEverCreated;
    }

    function getTerminalBadOrSettledCounter() external view returns (uint256) {
        return LibVaipakam.storageSlot().terminalBadOrSettledCount;
    }

    function getInterestRateBpsSumCounter() external view returns (uint256) {
        return LibVaipakam.storageSlot().interestRateBpsSum;
    }

    function getUniqueUserCounter() external view returns (uint256) {
        return LibVaipakam.storageSlot().uniqueUserCount;
    }

    function getUserSeenFlag(address u) external view returns (bool) {
        return LibVaipakam.storageSlot().userSeen[u];
    }

    /// @notice Vestigial (T-068): writes the deprecated `localEid`
    ///         legacy slot. The reward + VPFI-buy facets now derive a
    ///         chain's identity from `block.chainid`, so nothing reads
    ///         this value any more — the writer is retained only so the
    ///         62-entry test-mutator selector list need not be
    ///         re-indexed. Safe to drop together with that re-index.
    function setLocalEidForTest(uint32 eid) external {
        LibVaipakam.storageSlot().localEidLegacyDoNotUse = eid;
    }

    /// @notice Append a {LibVaipakam.RewardEntry} record for `user` and link
    ///         it to their `userRewardEntryIds` index. Test-only — production
    ///         path goes through {LibInteractionRewards.registerLoan} from
    ///         {LoanFacet.initiateLoan}, which is heavy to drive in unit
    ///         tests focused only on the new view's read path.
    /// @notice Test-only accessor for the gated, default-DENY country-pair
    ///         helper {LibVaipakam._canTradeBetweenStorageGated}. The
    ///         retail Vaipakam deploy never calls the gated branch — its
    ///         flow goes through the pure-true {LibVaipakam.canTradeBetween}.
    ///         Exposing the gated helper here lets `CountryPairGatedTest`
    ///         exercise the whitelist + symmetry + miss-defaults-to-deny
    ///         contract without cutting in a separate test facet, and
    ///         without changing any production call site.
    function canTradeBetweenStorageGated(
        string memory countryA,
        string memory countryB
    ) external view returns (bool) {
        return LibVaipakam._canTradeBetweenStorageGated(countryA, countryB);
    }

    /// @notice EC-003 Phase 1 — overwrite the FallbackSnapshot for `loanId`
    ///         directly. Test-only — lets a fixture scaffold a
    ///         FallbackPending loan with realistic snap fields without
    ///         running the full at-fallback liquidation flow.
    function setFallbackSnapshotRaw(
        uint256 loanId,
        LibVaipakam.FallbackSnapshot memory snap
    ) external {
        LibVaipakam.storageSlot().fallbackSnapshot[loanId] = snap;
    }

    function pushRewardEntry(
        address user,
        uint64 loanId,
        LibVaipakam.RewardSide side,
        uint256 perDayNumeraire18,
        uint32 startDay
    ) external returns (uint256 id) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.nextRewardEntryId += 1;
        id = s.nextRewardEntryId;
        s.rewardEntries[id] = LibVaipakam.RewardEntry({
            user: user,
            loanId: loanId,
            startDay: startDay,
            endDay: 0,
            side: side,
            processed: false,
            forfeited: false,
            closed: false, // #1002 (S4) — seeded open; tests close via closeLoan/mutator
            perDayNumeraire18: perDayNumeraire18
        });
        s.userRewardEntryIds[user].push(id);
    }

    // ─── #953 test-only — sale-forfeit sweep-reachability scaffolding ───────

    /// @notice Set the per-loan active lender entry pointer so a test can then
    ///         drive {callTransferLenderEntry} (production sets it in
    ///         {LibInteractionRewards.registerLoan} at loan init).
    function setLoanActiveLenderEntryId(uint256 loanId, uint256 entryId) external {
        LibVaipakam.storageSlot().loanActiveLenderEntryId[loanId] = entryId;
    }

    /// @notice Invoke the internal {LibInteractionRewards.transferLenderEntry} to
    ///         simulate a position sale forfeiting the exiting lender's entry and
    ///         advancing the active pointer off it.
    function callTransferLenderEntry(uint256 loanId, address newLender) external {
        LibInteractionRewards.transferLenderEntry(loanId, newLender);
    }

    /// @notice Read the #953 orphaned-forfeited-lender-entry list for a loan.
    function getForfeitedLenderEntryIds(uint256 loanId)
        external
        view
        returns (uint256[] memory)
    {
        return LibVaipakam.storageSlot().loanForfeitedLenderEntryIds[loanId];
    }

    // ─── LibERC721 lock-state direct manipulators (test-only) ───────────
    // Wraps the internal `_lock`/`_unlock` library functions so unit
    // tests can exercise the lock-counter + `setApprovalForAll` gating
    // without running a full Preclose / EarlyWithdrawal lifecycle. The
    // production-side flows still go through PrecloseFacet /
    // EarlyWithdrawalFacet exclusively; these helpers are NOT cut into
    // production deployments.

    /// @notice Test-only: mint a tokenId to `to`, bypassing the
    ///         production `_enforceAuthorizedCaller` gate on
    ///         `VaipakamNFTFacet.mintNFT`. Used by the focused
    ///         setApprovalForAll-during-lock test to populate a token
    ///         without standing up the full offer-accept loan lifecycle.
    /// @dev    Name avoids the `test...` prefix so Foundry's test
    ///         discovery doesn't try to run this as a fuzz case.
    function mintNFTRaw(address to, uint256 tokenId) external {
        LibERC721._mint(to, tokenId);
    }

    /// @notice Test-only: lock a tokenId with the given reason. Mirrors
    ///         the call PrecloseFacet / EarlyWithdrawalFacet make
    ///         internally.
    function lockNFTRaw(uint256 tokenId, LibERC721.LockReason reason) external {
        LibERC721._lock(tokenId, reason);
    }

    /// @notice Test-only: unlock a tokenId.
    function unlockNFTRaw(uint256 tokenId) external {
        LibERC721._unlock(tokenId);
    }

    /// @notice Test-only: burn a tokenId via the library. Mirrors the
    ///         call `LibLoan.migrateLenderPosition` /
    ///         `VaipakamNFTFacet._burnInternal` make internally — used
    ///         by the focused lock-counter test to assert that burning
    ///         a still-locked token doesn't permanently strand the
    ///         owner's counter (the L145 finding closed by this PR).
    function burnNFTRaw(uint256 tokenId) external {
        LibERC721._burn(tokenId);
    }

    // ─── LibCollateralSettlement view proxies (T-086 step 3) ────────────
    // Pure view wrappers so the focused test for the closed-form floor
    // formula doesn't have to stand up a Seaport order — it just
    // scaffolds a Loan via {setLoan} and reads the floor through the
    // diamond.

    function getLiveFloor(uint256 loanId, uint256 asOfTimestamp)
        external
        view
        returns (uint256)
    {
        return LibCollateralSettlement.liveFloor(loanId, asOfTimestamp);
    }

    function getPrincipalPlusAccruedInterest(uint256 loanId, uint256 asOfTimestamp)
        external
        view
        returns (uint256)
    {
        return LibCollateralSettlement.principalPlusAccruedInterest(loanId, asOfTimestamp);
    }

    function getTreasuryAndPrecloseFee(uint256 loanId, uint256 asOfTimestamp)
        external
        view
        returns (uint256)
    {
        return LibCollateralSettlement.treasuryAndPrecloseFee(loanId, asOfTimestamp);
    }

    /// @notice Test-only direct write to `protocolCfg.treasuryFeeBps` so
    ///         the LibCollateralSettlement tests can flip the treasury
    ///         fee without cutting `ConfigFacet` into the minimal test
    ///         diamond. Bypasses the bounded-range setter — callers
    ///         supply raw bps.
    function setTreasuryFeeBpsRaw(uint16 bps) external {
        LibVaipakam.storageSlot().protocolCfg.treasuryFeeBps = bps;
    }

    /// @notice Test-only: write `locks[tokenId]` directly, BYPASSING
    ///         the counter-increment side-effect of {LibERC721._lock}.
    ///         Simulates a pre-PR-#282 diamond upgrade state where
    ///         tokens were locked under the old code path (which had
    ///         no `lockedTokenCount` mapping) and the owner's counter
    ///         is therefore 0 even though `locks[tokenId] != None`.
    ///         Used by the focused regression test to assert that the
    ///         first post-upgrade `_unlock` / `_burn` on such a legacy
    ///         lock does NOT underflow + revert.
    // forge-lint: disable-next-line(mixed-case-function)
    function forceSetLockWithoutCounter(uint256 tokenId, LibERC721.LockReason reason) external {
        LibERC721._storage().locks[tokenId] = reason;
    }

    /// @notice Test-only: read the per-owner locked-token counter.
    function getLockedTokenCount(address owner) external view returns (uint256) {
        return LibERC721._storage().lockedTokenCount[owner];
    }

    /// @notice Test-only: read the per-owner operator-approval epoch
    ///         (bumped on every fresh `_lock`).
    function getOperatorApprovalEpoch(address owner) external view returns (uint256) {
        return LibERC721._storage().operatorApprovalEpoch[owner];
    }

    /// @notice Test-only: read the epoch stamped when an operator
    ///         approval was granted.
    function getOperatorApprovalGrantEpoch(address owner, address operator)
        external
        view
        returns (uint256)
    {
        return LibERC721._storage().operatorApprovalGrantEpoch[owner][operator];
    }

    // ─── T-086 Round-7 (Issue #355) — auto-list state mutators ──────────

    /// @notice Direct-set the diamond's pinned orderHash for `loanId`
    ///         so auto-list integration tests can simulate "an
    ///         existing listing is here" without running through the
    ///         full borrower-driven post path.
    function setPrepayListingOrderHash(uint256 loanId, bytes32 orderHash) external {
        LibVaipakam.storageSlot().prepayListingOrderHash[loanId] = orderHash;
    }

    function setPrepayListingExecutor(uint256 loanId, address executor) external {
        LibVaipakam.storageSlot().prepayListingExecutor[loanId] = executor;
    }

    /// @notice Direct-set the per-loan auto-list opt-out flag so tests
    ///         can assert the auto-list path's `AutoListBorrowerOptedOut`
    ///         gate without exercising the full cancel-during-grace
    ///         flow that ordinarily sets the flag.
    function setPrepayListingAutoListOptedOut(uint256 loanId, bool optedOut) external {
        LibVaipakam.storageSlot().prepayListingAutoListOptedOut[loanId] = optedOut;
    }

    // (`getPrepayListingAutoListOptedOut` removed in round-3 — the
    // production read is now `NFTPrepayListingFacet.getPrepayListingAutoListOptedOut`
    // and tests call that directly. Keeping a duplicate here would
    // collide on the same selector.)

    function getPrepayListingAutoListNonce(uint256 loanId) external view returns (uint64) {
        return LibVaipakam.storageSlot().prepayListingAutoListNonce[loanId];
    }

    // ─── #407 PR 4 (T-407-B) — encumbrance-aggregate direct write ───────
    //
    // Lets the withdraw-guard tests pin `encumbered[user][asset][tokenId]`
    // to a known value without driving the full offer-create / loan-init
    // flow. The production lifecycles (`LibEncumbrance.createCollateralLien`
    // / `createOfferPrincipalLien`) are exercised in PR 3's fixture
    // sweep + the upcoming T-407-C tests; this helper is purely for
    // exercising the guard's REVERT branch in isolation.

    function setEncumberedRaw(
        address user,
        address asset,
        uint256 tokenId,
        uint256 amount
    ) external {
        LibVaipakam.storageSlot().encumbered[user][asset][tokenId] = amount;
    }

    // ─── #569 Codex #572 round-4 P2 — encumbrance-aggregate reader ──────
    //
    // Mirror of `setEncumberedRaw` for assertions: lets lifecycle tests
    // read the live `encumbered[user][asset][tokenId]` aggregate after a
    // real loan flow (e.g. to prove the collateral lien is HELD across a
    // proper-close terminal and RELEASED only at `claimAsBorrower`).

    function getEncumberedRaw(
        address user,
        address asset,
        uint256 tokenId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().encumbered[user][asset][tokenId];
    }

    // ─── #577 — loan-collateral lien row setter / reader ────────────────
    //
    // Pin a `loanCollateralLien[loanId]` row + tick its aggregate without
    // driving the full loan-init flow, so internal-match residual tests can
    // prove an over-collateralized residual stays LIENED (not drainable by a
    // transferred-away `loan.borrower`) and is claimable by the NFT holder.
    // Mirrors exactly what `LibEncumbrance.createCollateralLien` writes.
    function setLoanCollateralLienRaw(
        uint256 loanId,
        address user,
        address asset,
        uint256 tokenId,
        uint256 amount,
        LibVaipakam.AssetType assetType
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.loanCollateralLien[loanId] = LibVaipakam.Encumbrance({
            user: user,
            asset: asset,
            tokenId: tokenId,
            amount: amount,
            assetType: assetType,
            released: false
        });
        s.encumbered[user][asset][tokenId] += amount;
    }

    function getLoanCollateralLienAmount(uint256 loanId)
        external
        view
        returns (uint256 amount, bool released)
    {
        LibVaipakam.Encumbrance storage l =
            LibVaipakam.storageSlot().loanCollateralLien[loanId];
        return (l.amount, l.released);
    }
}
