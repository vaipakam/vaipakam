// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibMetricsHooks} from "../../src/libraries/LibMetricsHooks.sol";

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
        LibMetricsHooks.onLoanInitialized(s.loans[loanId]);
    }

    /// @notice Scaffold an open offer end-to-end — see {scaffoldActiveLoan}.
    function scaffoldOpenOffer(uint256 offerId, LibVaipakam.Offer memory data) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.offers[offerId] = data;
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
    function setKYCEnforcementFlag(bool enforced) external {
        LibVaipakam.storageSlot().kycEnforcementEnabled = enforced;
    }

    // ─── Reward-pool mutators (for staking + interaction coverage tests) ─────

    /// @notice Set the cumulative paid-out counter for the staking pool.
    function setStakingPoolPaidOut(uint256 v) external {
        LibVaipakam.storageSlot().stakingPoolPaidOut = v;
    }

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

    /// @notice Write `assetRiskParams[asset].liqThresholdBps` directly,
    ///         bypassing the bounded-range guard on
    ///         `RiskFacet.updateRiskParams`. Lets tests stress the
    ///         liqThresholdBps == 0 edge case in
    ///         `RiskFacet.calculateHealthFactor` (which the production
    ///         setter rejects below `RISK_PARAMS_LIQ_THRESHOLD_BPS_MIN`).
    /// @dev    Compiler resolves the storage slot via the named field
    ///         path — no hardcoded magic numbers, so this stays correct
    ///         when the `Storage` struct layout shifts under it.
    function setLiqThresholdBpsRaw(address asset, uint16 bps) external {
        LibVaipakam.storageSlot().assetRiskParams[asset].liqThresholdBps = bps;
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

    /// @notice Write `s.saleOfferToLoanId[offerId] = loanId` directly.
    ///         Used by tests scaffolding lender-sale completion without
    ///         running the full sale flow.
    function setSaleOfferToLoanIdRaw(uint256 offerId, uint256 loanId) external {
        LibVaipakam.storageSlot().saleOfferToLoanId[offerId] = loanId;
    }

    /// @notice Write `s.offsetOfferToLoanId[offerId] = loanId` directly.
    ///         Used by OfferFacet auto-complete coverage tests.
    function setOffsetOfferToLoanIdRaw(uint256 offerId, uint256 loanId) external {
        LibVaipakam.storageSlot().offsetOfferToLoanId[offerId] = loanId;
    }

    /// @notice Write `s.escrowVersion[user] = version` directly.
    ///         Used by `EscrowFactoryFacetTest` to simulate a user
    ///         whose proxy is already at a specific version.
    function setEscrowVersionRaw(address user, uint256 version) external {
        LibVaipakam.storageSlot().escrowVersion[user] = version;
    }

    /// @notice Write `s.assetRiskParams[asset].minPartialBps = bps`
    ///         directly. Used by `RepayFacetTest.testRepayPartialRevertsMinPartialAmount`
    ///         to set the min-partial floor without going through the
    ///         bounded-range setter on `RiskFacet.updateRiskParams`.
    function setMinPartialBpsRaw(address asset, uint256 bps) external {
        LibVaipakam.storageSlot().assetRiskParams[asset].minPartialBps = bps;
    }

    /// @notice Read `s.userVaipakamEscrows[user]` directly. Used by
    ///         `WorkflowComplianceAndRejection` test to look up a
    ///         user's escrow proxy address bypassing the
    ///         `getOrCreateUserEscrow` path's mandatory-version
    ///         check (which would revert in the upgrade-required
    ///         scenario the test exercises).
    function getUserVaipakamEscrowRaw(address user) external view returns (address) {
        return LibVaipakam.storageSlot().userVaipakamEscrows[user];
    }

    /// @notice Test-only: expose raw staking accrual storage fields so tests
    ///         can assert against the internal reward-per-token counters
    ///         without grepping storage slots.
    function getStakingRPTStored() external view returns (uint256) {
        return LibVaipakam.storageSlot().stakingRewardPerTokenStored;
    }

    function getStakingLastUpdateTime() external view returns (uint256) {
        return LibVaipakam.storageSlot().stakingLastUpdateTime;
    }

    function getUserStakingPaid(address u) external view returns (uint256) {
        return LibVaipakam.storageSlot().userStakingRewardPerTokenPaid[u];
    }

    function getUserStakingPending(address u) external view returns (uint256) {
        return LibVaipakam.storageSlot().userStakingPendingReward[u];
    }

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

    /// @notice Test-only: stamp `s.localEid` without going through the
    ///         RewardReporterFacet path. Production sets this via
    ///         `RewardReporterFacet.setLocalEid` (admin-gated). Tests
    ///         that exercise the canonical-chain VPFI fixed-rate buy
    ///         must set a non-zero `localEid` here so the per-(buyer,
    ///         originEid) cap bucket is well-defined; the on-chain
    ///         entry point reverts `VPFICanonicalEidNotSet` otherwise.
    function setLocalEidForTest(uint32 eid) external {
        LibVaipakam.storageSlot().localEid = eid;
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
            perDayNumeraire18: perDayNumeraire18
        });
        s.userRewardEntryIds[user].push(id);
    }
}
