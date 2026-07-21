// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AutoLifecycleFacet} from "../src/facets/AutoLifecycleFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {FeeEntitlementFacet} from "../src/facets/FeeEntitlementFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAutoRefinanceCheck} from "../src/libraries/LibAutoRefinanceCheck.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  T092AutoLifecycleIntegrationTest
 * @notice T-092 follow-up (#514) — end-to-end integration tests for
 *         the auto-lifecycle surface. Verifies the kill switches +
 *         consent + cap + tagged-offer binding all wire together
 *         correctly against a real Active loan, not just isolated
 *         per-facet unit tests.
 *
 *         Coverage:
 *           - Kill switches default false; admin enables in setUp.
 *           - Kill-switch flips block the relevant entry points
 *             (AutoLendDisabled / AutoRefinanceDisabled /
 *             AutoExtendDisabled).
 *           - Refinance-tagged offer creation enforces
 *             `LibAutoRefinanceCheck.validate` at create-time.
 *           - Keeper-driven refinance rejects untagged offers
 *             (InvalidRefinanceOffer).
 *           - Extend-in-place rejects when both-side consent is
 *             missing (BothSideAutoExtendRequired).
 *
 *         Happy-path fund-flow assertions are intentionally NOT
 *         covered here — that requires the full multi-step keeper
 *         orchestration (create→accept→refinance) which is exercised
 *         by the existing RefinanceFacetTest fixtures. This file's
 *         scope is the NEW T-092 surface (kill switches + tagged-
 *         offer binding + consent gates) bound to a real loan.
 */
contract T092AutoLifecycleIntegrationTest is SetupTest {
    function setUp() public {
        setupHelper();
        // Enable the three kill switches so the consent + executor
        // surface is reachable in tests. Per-test overrides flip
        // individual switches back to false to exercise the kill
        // paths.
        AdminFacet(address(diamond)).setAutoLendEnabled(true);
        AdminFacet(address(diamond)).setAutoRefinanceEnabled(true);
        AdminFacet(address(diamond)).setAutoExtendEnabled(true);
    }

    function _f() internal view returns (AutoLifecycleFacet) {
        return AutoLifecycleFacet(address(diamond));
    }

    function _admin() internal view returns (AdminFacet) {
        return AdminFacet(address(diamond));
    }

    // ─── Kill-switch coverage ────────────────────────────────────────

    function test_KillSwitch_AutoLend_BlocksOptIn() public {
        _admin().setAutoLendEnabled(false);
        address user = makeAddr("intUser1");
        vm.expectRevert(AutoLifecycleFacet.AutoLendDisabled.selector);
        vm.prank(user);
        _f().setAutoLendConsent(true);
    }

    function test_KillSwitch_AutoLend_AllowsRevoke() public {
        address user = makeAddr("intUser2");
        vm.prank(user);
        _f().setAutoLendConsent(true);
        _admin().setAutoLendEnabled(false);
        // Revocation still permitted even when the feature is
        // disabled — protects users from being trapped in consent
        // when admin disables.
        vm.prank(user);
        _f().setAutoLendConsent(false);
        assertFalse(_f().getAutoLendConsent(user));
    }

    function test_KillSwitch_AutoExtend_BlocksExecutor() public {
        _admin().setAutoExtendEnabled(false);
        vm.expectRevert(AutoLifecycleFacet.AutoExtendDisabled.selector);
        _f().extendLoanInPlace(1, 500, 30);
    }

    function test_KillSwitch_GettersExposeState() public {
        // Set + assert via getter; flip + re-assert.
        assertTrue(_admin().getAutoLendEnabled());
        assertTrue(_admin().getAutoRefinanceEnabled());
        assertTrue(_admin().getAutoExtendEnabled());
        _admin().setAutoLendEnabled(false);
        assertFalse(_admin().getAutoLendEnabled());
    }

    function test_KillSwitch_OnlyAdminCanFlip() public {
        address randoUser = makeAddr("randoUser");
        vm.prank(randoUser);
        // The exact error selector depends on the AccessControl
        // library; just assert the call reverts. Admin-only is the
        // semantic; the modifier-driven revert message varies.
        vm.expectRevert();
        _admin().setAutoLendEnabled(false);
    }

    // ─── Cap-setter integration ──────────────────────────────────────

    function test_SetDefaultAutoRefinanceCaps_AcceptsZeroRate() public {
        address user = makeAddr("zeroRateUser");
        vm.prank(user);
        _f().setDefaultAutoRefinanceCaps(true, 0, uint64(block.timestamp + 90 days));
        LibVaipakam.AutoRefinanceCaps memory caps =
            _f().getDefaultAutoRefinanceCaps(user);
        assertTrue(caps.enabled);
        assertEq(caps.maxRateBps, 0);
    }

    function test_AutoOptInOnNewLoan_PopulatesPerLoanCaps() public {
        // The convenience flag is the per-user toggle that auto-
        // populates per-loan caps at loan-init. This integration
        // test exercises the toggle setter + the read-back; the
        // per-loan populate-on-init wire is unit-tested in
        // LoanFacet's existing suite.
        address user = makeAddr("optInUser");
        vm.prank(user);
        _f().setAutoOptInOnNewLoan(true);
        assertTrue(_f().getAutoOptInOnNewLoan(user));
    }

    // ─── LibAutoRefinanceCheck error-selector guardrails ─────────────

    function test_LibAutoRefinanceCheck_ErrorSelectorsExist() public {
        // Compile-time guardrail — the new error selectors are part
        // of the public ABI surface that the dapp + indexer must
        // decode. A rename in `LibAutoRefinanceCheck` would break
        // consumers silently if the selector check isn't here.
        assertTrue(
            LibAutoRefinanceCheck.RefinanceTargetNotActive.selector !=
                bytes4(0)
        );
        assertTrue(
            LibAutoRefinanceCheck.RefinanceTargetNotBorrower.selector !=
                bytes4(0)
        );
        assertTrue(
            LibAutoRefinanceCheck.RefinanceCapsRequired.selector != bytes4(0)
        );
        assertTrue(
            LibAutoRefinanceCheck.RefinanceRateExceedsCap.selector !=
                bytes4(0)
        );
        assertTrue(
            LibAutoRefinanceCheck.RefinanceExpiryExceedsCap.selector !=
                bytes4(0)
        );
        assertTrue(
            LibAutoRefinanceCheck.RefinanceTargetIncompatible.selector !=
                bytes4(0)
        );
        // Pass-2 A1/D5 (#1189) — post-grace target fail-fast selector.
        assertTrue(
            LibAutoRefinanceCheck.RefinanceTargetPastGrace.selector != bytes4(0)
        );
    }

    // ─── RefinanceFacet new-error guardrails ─────────────────────────

    function test_RefinanceFacet_ErrorSelectorsExist() public {
        assertTrue(
            RefinanceFacet.AutoRefinanceDisabled.selector != bytes4(0)
        );
    }

    // ─── OfferCreateFacet new-error guardrails ───────────────────────

    function test_OfferCreateFacet_InvalidRefinanceTargetSelectorExists()
        public
    {
        assertTrue(
            OfferCreateFacet.InvalidRefinanceTarget.selector != bytes4(0)
        );
    }

    // ─── Active-loan-backed scenarios (Codex round-1 P2 follow-up) ────
    //
    // The selector / kill-switch tests above cover the consent +
    // admin surface. The tests below exercise the NEW T-092 surface
    // (refinance-tagged offer validation, extend gating) against a
    // real Active loan so the wire-up between consent storage,
    // capped offer creation, and extend executor is actually
    // exercised end-to-end.

    uint256 internal constant LOAN_PRINCIPAL = 100 ether;
    uint256 internal constant LOAN_COLLATERAL = 1800 ether;
    uint256 internal activeLoanIdForIntegration;

    /// @dev One-time helper to mint an Active ERC20 loan between
    ///      SetupTest's `lender` and `borrower`. Returns the loan id.
    ///      Pattern copied from {RefinanceFacetTest}'s constructor —
    ///      lender opens a single-value offer, borrower accepts.
    function _buildActiveLoan() internal returns (uint256 loanId) {
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockERC20, 1e8, 8);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockCollateralERC20, 1e8, 8);

        address lenderVault =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        address borrowerVault =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        vm.prank(lender);
        ERC20(mockERC20).approve(lenderVault, type(uint256).max);
        vm.prank(borrower);
        ERC20(mockCollateralERC20).approve(borrowerVault, type(uint256).max);

        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: LOAN_PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: LOAN_COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: LOAN_PRINCIPAL,
                interestRateBpsMax: 500,
                collateralAmountMax: LOAN_COLLATERAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    /// @dev Build a refinance-tagged Borrower offer template.
    ///      `rateBps` is the offer's `interestRateBps` (collapsed to
    ///      `interestRateBpsMax` via amountMax=0).
    function _refinanceTaggedOfferParams(
        uint256 targetLoanId,
        uint256 rateBps
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: mockERC20,
            amount: LOAN_PRINCIPAL,
            interestRateBps: rateBps,
            collateralAsset: mockCollateralERC20,
            collateralAmount: LOAN_COLLATERAL,
            durationDays: 30,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: mockERC20,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: LOAN_PRINCIPAL,
            interestRateBpsMax: rateBps,
            collateralAmountMax: LOAN_COLLATERAL,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            // T-092 Phase 2b — refinance-tagged offers MUST be Aon.
            fillMode: LibVaipakam.FillMode.Aon,
            refinanceTargetLoanId: targetLoanId,
            useFullTermInterest: false
        });
    }

    function test_RefinanceTaggedOffer_RequiresCapsAtCreate() public {
        // No caps set → LibAutoRefinanceCheck.validate reverts
        // RefinanceCapsRequired at create.
        uint256 loanId = _buildActiveLoan();
        vm.expectRevert(
            LibAutoRefinanceCheck.RefinanceCapsRequired.selector
        );
        vm.prank(borrower);
        OfferCreateFacet(address(diamond)).createOffer(
            _refinanceTaggedOfferParams(loanId, 400)
        );
    }

    function test_RefinanceTaggedOffer_RejectsRateAboveCap() public {
        // Caps set with maxRate = 300; offer with rate 400 fails
        // create-time `RefinanceRateExceedsCap`.
        uint256 loanId = _buildActiveLoan();
        vm.prank(borrower);
        _f().setAutoRefinanceCaps(
            loanId,
            true,
            300, // maxRate
            uint64(block.timestamp + 365 days)
        );
        vm.expectRevert(
            LibAutoRefinanceCheck.RefinanceRateExceedsCap.selector
        );
        vm.prank(borrower);
        OfferCreateFacet(address(diamond)).createOffer(
            _refinanceTaggedOfferParams(loanId, 400)
        );
    }

    /// @dev Pass-2 A1/D5 (#1189) — a refinance-tagged offer against a target
    ///      loan that is Active but PAST its grace window fails fast at create
    ///      (`RefinanceTargetPastGrace`), mirroring RefinanceFacet's execution
    ///      gate — so a post-grace target can't attract a lender to an offer the
    ///      refinance path would then reject.
    function test_RefinanceTaggedOffer_RejectsPastGraceTarget() public {
        uint256 loanId = _buildActiveLoan();
        vm.prank(borrower);
        _f().setAutoRefinanceCaps(
            loanId,
            true,
            600,
            uint64(block.timestamp + 365 days)
        );

        // Warp the target strictly past its grace window.
        LibVaipakam.Loan memory l =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        uint256 endTime = uint256(l.startTime) + uint256(l.durationDays) * 1 days;
        vm.warp(endTime + LibVaipakam.gracePeriod(l.durationDays) + 1);

        vm.expectRevert(
            LibAutoRefinanceCheck.RefinanceTargetPastGrace.selector
        );
        vm.prank(borrower);
        OfferCreateFacet(address(diamond)).createOffer(
            _refinanceTaggedOfferParams(loanId, 400)
        );
    }

    /// @dev Pass-2 A1/D5 (#1189, Codex #1233 r2 P2) — a refinance-tagged offer's
    ///      expiry is clamped to the target loan's grace deadline at create, so
    ///      it can't linger unfillable (and lock a non-carry-over pledge) once
    ///      the target passes grace. `_refinanceTaggedOfferParams` uses an
    ///      open-ended `expiresAt: 0`, which is stamped to the grace deadline.
    function test_RefinanceTaggedOffer_ExpiryClampedToGraceDeadline() public {
        uint256 loanId = _buildActiveLoan();
        vm.prank(borrower);
        _f().setAutoRefinanceCaps(
            loanId,
            true,
            600,
            uint64(block.timestamp + 365 days)
        );

        LibVaipakam.Loan memory l =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        uint256 graceEnd = uint256(l.startTime) +
            uint256(l.durationDays) * 1 days +
            LibVaipakam.gracePeriod(l.durationDays);

        vm.prank(borrower);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _refinanceTaggedOfferParams(loanId, 400)
        );

        assertEq(
            uint256(
                OfferCancelFacet(address(diamond))
                    .getOfferDetails(offerId)
                    .expiresAt
            ),
            graceEnd + 1,
            "open-ended tagged offer expiry clamped to grace deadline + 1 (fillable through graceEnd, #1233 r2/r3)"
        );
    }

    function test_RefinanceTaggedOffer_AcceptsWithinCaps() public {
        // Caps satisfied → create succeeds; the offer becomes
        // accessible to a lender accept (and downstream to
        // refinanceLoan once accepted).
        uint256 loanId = _buildActiveLoan();
        vm.prank(borrower);
        _f().setAutoRefinanceCaps(
            loanId,
            true,
            600, // maxRate above offer's 400
            uint64(block.timestamp + 365 days)
        );
        vm.prank(borrower);
        uint256 refinanceOfferId = OfferCreateFacet(address(diamond))
            .createOffer(_refinanceTaggedOfferParams(loanId, 400));
        // Offer has the tag persisted.
        LibVaipakam.Offer memory o =
            OfferCancelFacet(address(diamond)).getOfferDetails(refinanceOfferId);
        assertEq(o.refinanceTargetLoanId, loanId);
    }

    function test_ExtendInPlace_RealLoan_RequiresBothSideConsent() public {
        // Active loan with neither side's extend consent set →
        // extendLoanInPlace reverts BothSideAutoExtendRequired.
        // Warp past the 1-day "too soon after start" guard so the
        // executor reaches the auth + consent stage.
        uint256 loanId = _buildActiveLoan();
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(
            AutoLifecycleFacet.BothSideAutoExtendRequired.selector
        );
        vm.prank(borrower);
        _f().extendLoanInPlace(loanId, 500, 30);
    }

    // ─── #1384 — fee-entitlement reprice on in-place extension ───────

    /// @dev Build an active ERC20 loan with both-side auto-extend caps set and
    ///      the borrower vault pre-funded to cover accrued interest, so a
    ///      subsequent {extendLoanInPlace} succeeds. Warps 2 days past the
    ///      "too soon after start" accrual guard. Caller stamps the fee
    ///      entitlement as needed before extending.
    function _setupExtendableLoan() internal returns (uint256 loanId) {
        loanId = _buildActiveLoan();

        // Both sides opt into auto-extend within a wide rate / expiry band.
        uint64 farExpiry = uint64(block.timestamp + 400 days);
        vm.prank(borrower);
        _f().setAutoExtendBorrowerCaps(loanId, true, 0, 1000, farExpiry);
        vm.prank(lender);
        _f().setAutoExtendLenderCaps(loanId, true, 0, 1000, farExpiry);

        // Pre-fund the borrower's vault with principal asset so the extension's
        // per-term interest settlement (`_routeInterest` → vault withdraw) clears.
        address borrowerVault =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        ERC20Mock(mockERC20).mint(borrowerVault, 10 ether);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            borrower, mockERC20, 10 ether
        );

        // Past the 1-day "too soon after start" accrual guard.
        vm.warp(block.timestamp + 2 days);
    }

    /// @notice #1384 — an in-place extension downgrades a lender Full stamp and
    ///         resets the loan-side reward-cap base for the un-tariffed new
    ///         term, while leaving the borrower's whole-loan Full custody
    ///         untouched. Prevents an unpriced lender +10% (#1354) / oversized
    ///         reward budget (#1353) on added term no fresh `C*` paid for.
    function test_1384_ExtendReprice_LenderFullDowngraded_RewardCapReset()
        public
    {
        uint256 loanId = _setupExtendableLoan();

        // Stamp the Full/Full record the #1347 charger would write at open.
        TestMutatorFacet(address(diamond)).setFeeEntitlementRaw(
            loanId,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.Full,
                lenderMode: LibVaipakam.FeeEntitlementMode.Full,
                openDays: 30,
                rewardHaircutBpsAtOpen: 2000,
                borrowerTariffPaid: 7 ether,
                lenderTariffPaid: 5 ether,
                cStarOpen: 10 ether,
                loanSideRewardCapOpen: 4 ether
            })
        );

        // Extend to a DIFFERENT term (45d) so the restamped openDays is visible.
        vm.prank(borrower);
        _f().extendLoanInPlace(loanId, 500, 45);

        LibVaipakam.FeeEntitlement memory fe =
            FeeEntitlementFacet(address(diamond)).getFeeEntitlement(loanId);

        // Lender Full downgraded → no unpriced +10% on the added term. The
        // paid-tariff record is cleared to hold the struct invariant.
        assertEq(
            uint8(fe.lenderMode),
            uint8(LibVaipakam.FeeEntitlementMode.None),
            "lender Full downgraded on extension"
        );
        assertEq(fe.lenderTariffPaid, 0, "lender tariff record cleared");
        // Reward-cap base reset for the un-tariffed new term.
        assertEq(fe.cStarOpen, 0, "cStarOpen reset");
        assertEq(fe.loanSideRewardCapOpen, 0, "reward cap reset");
        assertEq(uint256(fe.openDays), 45, "openDays restamped to new term");
        // Borrower Full custody untouched (whole-loan vpfiHeld → terminal rebate).
        assertEq(
            uint8(fe.borrowerMode),
            uint8(LibVaipakam.FeeEntitlementMode.Full),
            "borrower Full preserved across extension"
        );
        assertEq(fe.borrowerTariffPaid, 7 ether, "borrower tariff preserved");
    }

    /// @notice #1384 — the reprice is a no-op on a plain (unstamped) loan: no
    ///         entitlement record is fabricated on extension.
    function test_1384_ExtendReprice_UnstampedLoanStaysUnstamped() public {
        uint256 loanId = _setupExtendableLoan();

        LibVaipakam.FeeEntitlement memory before =
            FeeEntitlementFacet(address(diamond)).getFeeEntitlement(loanId);
        assertEq(uint256(before.openDays), 0, "precondition: unstamped");

        vm.prank(borrower);
        _f().extendLoanInPlace(loanId, 500, 45);

        LibVaipakam.FeeEntitlement memory fe =
            FeeEntitlementFacet(address(diamond)).getFeeEntitlement(loanId);
        assertEq(
            uint256(fe.openDays),
            0,
            "unstamped loan stays unstamped (reprice no-op)"
        );
        assertEq(
            uint8(fe.lenderMode),
            uint8(LibVaipakam.FeeEntitlementMode.None),
            "no mode fabricated"
        );
    }

    function test_T092B_AutoOptInGate_PopulatesOnLiquidCollateral() public {
        // T-092-B (#531) — borrower with autoOptInOnNewLoan + valid
        // default caps initiates a loan whose collateral is liquid.
        // The per-loan caps slot should be populated from the
        // defaults (existing behaviour, retained).
        vm.prank(borrower);
        _f().setAutoOptInOnNewLoan(true);
        vm.prank(borrower);
        _f().setDefaultAutoRefinanceCaps(
            true,
            600,
            uint64(block.timestamp + 365 days)
        );
        uint256 loanId = _buildActiveLoan(); // ERC20 + liquid collateral

        LibVaipakam.AutoRefinanceCaps memory caps =
            _f().getAutoRefinanceCaps(loanId);
        assertTrue(
            caps.enabled,
            "auto-opt-in should populate caps on liquid-collateral loan"
        );
        assertEq(caps.maxRateBps, 600);
    }

    function test_T092B_AutoOptInGate_SkipsOnIlliquidCollateral() public {
        // T-092-B (#531) — borrower with autoOptInOnNewLoan + valid
        // default caps initiates a loan whose collateral is ILLIQUID.
        // The per-loan caps slot must STAY UNPOPULATED. Borrower
        // would need an explicit `setAutoRefinanceCaps` call to
        // enroll this loan in the keeper-driven refinance path.
        //
        // Asymmetric default-loss risk: illiquid collateral on a
        // defaulted loan goes WHOLE to the lender (no swap) — the
        // borrower must consciously consent, not be silently
        // enrolled via the convenience flag.
        vm.prank(borrower);
        _f().setAutoOptInOnNewLoan(true);
        vm.prank(borrower);
        _f().setDefaultAutoRefinanceCaps(
            true,
            600,
            uint64(block.timestamp + 365 days)
        );
        // Re-mock so the collateral is now Illiquid for this loan.
        mockOracleLiquidity(
            mockCollateralERC20,
            LibVaipakam.LiquidityStatus.Illiquid
        );
        mockOraclePrice(mockCollateralERC20, 1e8, 8);
        mockOracleLiquidity(
            mockERC20,
            LibVaipakam.LiquidityStatus.Liquid
        );
        mockOraclePrice(mockERC20, 1e8, 8);

        // Build the loan inline so we control the mocked liquidity.
        address lenderVault =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        address borrowerVault =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        vm.prank(lender);
        ERC20(mockERC20).approve(lenderVault, type(uint256).max);
        vm.prank(borrower);
        ERC20(mockCollateralERC20).approve(borrowerVault, type(uint256).max);

        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: LOAN_PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: LOAN_COLLATERAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: LOAN_PRINCIPAL,
                interestRateBpsMax: 500,
                collateralAmountMax: LOAN_COLLATERAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);

        // The gate skipped the populate — caps stay default-empty.
        LibVaipakam.AutoRefinanceCaps memory caps =
            _f().getAutoRefinanceCaps(loanId);
        assertFalse(
            caps.enabled,
            "auto-opt-in must NOT populate caps on illiquid-collateral loan"
        );
    }

    function test_RefinanceTaggedOffer_RejectsPartialFillMode() public {
        // Refinance-tagged offer with Partial fill mode → revert
        // InvalidRefinanceTarget (Codex Phase 2b round-2 P2). The
        // borrower's caps are satisfied so the only reason for the
        // revert is the fillMode gate.
        uint256 loanId = _buildActiveLoan();
        vm.prank(borrower);
        _f().setAutoRefinanceCaps(
            loanId,
            true,
            600,
            uint64(block.timestamp + 365 days)
        );
        LibVaipakam.CreateOfferParams memory params =
            _refinanceTaggedOfferParams(loanId, 400);
        params.fillMode = LibVaipakam.FillMode.Partial;
        vm.expectRevert(
            OfferCreateFacet.InvalidRefinanceTarget.selector
        );
        vm.prank(borrower);
        OfferCreateFacet(address(diamond)).createOffer(params);
    }

    // ─── T-092 #548 — fixture helpers smoke test ────────────────────────

    function test_T092Fixture_NewLenderProvisioning() public {
        // Smoke-test the new SetupTest fixture helpers. Verifies the
        // actor provisioning shape that the upcoming #539 atomic-accept-
        // and-refinance integration test will build on.
        address newLender = _provisionFundedActorWithVault(
            "smokeNewLender",
            mockERC20,
            200 ether
        );

        // Wallet got HALF the funds.
        assertEq(
            ERC20(mockERC20).balanceOf(newLender),
            100 ether,
            "actor wallet should hold half of totalAmount"
        );

        // Vault proxy got the other half.
        address proxy = VaultFactoryFacet(address(diamond))
            .getOrCreateUserVault(newLender);
        assertEq(
            ERC20(mockERC20).balanceOf(proxy),
            100 ether,
            "actor vault proxy should hold half of totalAmount"
        );

        // Diamond approval is at max.
        assertEq(
            ERC20(mockERC20).allowance(newLender, address(diamond)),
            type(uint256).max,
            "standing diamond approval should be max"
        );
    }

    function test_T092Fixture_GrantStandingApproval() public {
        // A fresh actor (not one of the standard fixture's prebuilt
        // borrower/lender) starts with NO diamond approval. After
        // _grantStandingApprovalToDiamond they have a max allowance —
        // the same shape the dapp sets at consent time.
        address freshUser = makeAddr("fixtureFreshUser");
        assertEq(
            ERC20(mockERC20).allowance(freshUser, address(diamond)),
            0,
            "fresh user should start without diamond approval"
        );
        _grantStandingApprovalToDiamond(freshUser, mockERC20);
        assertEq(
            ERC20(mockERC20).allowance(freshUser, address(diamond)),
            type(uint256).max,
            "after grantStandingApproval, allowance should be max"
        );
    }

    // ─── T-092-H (#539) Atomic accept-and-refinance happy path ─────────

    function test_T092H_AtomicAccept_DirectPath_ChainsInSameTx() public {
        // T-092-H happy path. A new lender accepts a refinance-tagged
        // Borrower offer via OfferAcceptFacet.acceptOffer; the chain
        // inside _acceptOffer fires RefinanceFacet.refinanceLoanFromAccept
        // in the same tx. Asserts both loans transitioned atomically.

        // Step 1: build the active OLD loan via the standard fixture.
        uint256 oldLoanId = _buildActiveLoan();

        // Step 2: borrower sets refinance caps that the refinance
        // attempt will satisfy.
        vm.prank(borrower);
        _f().setAutoRefinanceCaps(
            oldLoanId,
            true,
            600,
            uint64(block.timestamp + 365 days)
        );

        // Step 3: borrower creates the refinance-tagged offer.
        vm.prank(borrower);
        uint256 refinanceOfferId = OfferCreateFacet(address(diamond))
            .createOffer(_refinanceTaggedOfferParams(oldLoanId, 400));

        // Step 4: provision a new lender with wallet + vault funded
        // via the #548 fixture helpers.
        address newLender = _provisionFundedActorWithVault(
            "atomicNewLender",
            mockERC20,
            LOAN_PRINCIPAL * 4
        );

        // Step 5: borrower needs a standing diamond approval so the
        // chained refinance can pull the old-payoff from their wallet.
        // (Mirrors the dapp's consent-time approval set in #520.)
        _grantStandingApprovalToDiamond(borrower, mockERC20);

        // Step 6: SINGLE TX — accept fires the chain. `makeAddrAndKey` yields
        // the SAME address `_provisionFundedActorWithVault` derived via
        // `makeAddr`, so this just recovers the key for the typed-terms sign.
        (, uint256 newLenderPk) = makeAddrAndKey("atomicNewLender");
        uint256 newLoanId =
            _signAndAcceptOffer(newLender, newLenderPk, refinanceOfferId);

        // Step 7: assert both loans transitioned atomically.
        LibVaipakam.Loan memory oldLoan = LoanFacet(address(diamond))
            .getLoanDetails(oldLoanId);
        assertEq(
            uint8(oldLoan.status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "old loan must be Repaid after atomic accept-and-refinance"
        );
        LibVaipakam.Loan memory newLoan = LoanFacet(address(diamond))
            .getLoanDetails(newLoanId);
        assertEq(
            uint8(newLoan.status),
            uint8(LibVaipakam.LoanStatus.Active),
            "new loan must remain Active"
        );
    }

    /// @notice #576 — a refinance-TAGGED atomic refinance carries the old
    ///         loan's collateral over IN PLACE: the encumbrance lien retags
    ///         old→new (no second collateral lock), the collateral never
    ///         leaves the borrower's vault, and the new loan is keyed to the
    ///         original custody address. Proves the carry-over mechanism, not
    ///         just that the flow completes.
    function test_576_atomicRefinance_carriesCollateralOverViaLienRetag() public {
        uint256 oldLoanId = _buildActiveLoan();
        vm.prank(borrower);
        _f().setAutoRefinanceCaps(oldLoanId, true, 600, uint64(block.timestamp + 365 days));
        vm.prank(borrower);
        uint256 refinanceOfferId = OfferCreateFacet(address(diamond))
            .createOffer(_refinanceTaggedOfferParams(oldLoanId, 400));
        // #576 — the persisted carry-over decision is stamped true at create
        // for this clean original-borrower / single-value / live-lien /
        // matching-identity offer.
        assertTrue(
            OfferCancelFacet(address(diamond))
                .getOfferDetails(refinanceOfferId).refinanceCarryOver,
            "carry-over flag persisted true at create"
        );
        address newLender = _provisionFundedActorWithVault(
            "carryoverNewLender", mockERC20, LOAN_PRINCIPAL * 4
        );
        _grantStandingApprovalToDiamond(borrower, mockERC20);

        // Pre-state: the OLD loan's collateral is liened exactly once.
        assertEq(
            MetricsFacet(address(diamond)).getEncumbered(borrower, mockCollateralERC20, 0),
            LOAN_COLLATERAL,
            "pre: single collateral lock"
        );

        // SINGLE TX — accept fires the atomic accept-and-refinance chain.
        // Recover the funded actor's key (same address as the `makeAddr` it
        // was provisioned with) for the typed-terms sign.
        (, uint256 newLenderPk) = makeAddrAndKey("carryoverNewLender");
        uint256 newLoanId =
            _signAndAcceptOffer(newLender, newLenderPk, refinanceOfferId);

        // #576 — the lien RETAGGED old→new: still exactly one lock (NOT
        // doubled by a fresh pledge), the old lien released, the new lien
        // carries the same identity under the original borrower custody.
        assertEq(
            MetricsFacet(address(diamond)).getEncumbered(borrower, mockCollateralERC20, 0),
            LOAN_COLLATERAL,
            "post: still a single lock (retagged, not doubled)"
        );
        LibVaipakam.Encumbrance memory oldLien =
            MetricsFacet(address(diamond)).getLoanCollateralLien(oldLoanId);
        assertTrue(oldLien.released, "old lien retagged away (released)");
        // #576 Codex P3 — the released old-loan tombstone must read amount 0
        // so old-loan readers (e.g. getLoanCollateralLien) can't stale-report
        // the full collateral as still liened against the refinanced-away loan.
        assertEq(oldLien.amount, 0, "released old lien amount zeroed on retag");
        LibVaipakam.Encumbrance memory newLien =
            MetricsFacet(address(diamond)).getLoanCollateralLien(newLoanId);
        assertEq(newLien.user, borrower, "carried lien.user = original borrower custody");
        assertEq(newLien.asset, mockCollateralERC20, "carried lien.asset");
        assertEq(newLien.amount, LOAN_COLLATERAL, "carried lien.amount = collateral");
        assertFalse(newLien.released, "carried lien is active");

        // The new loan is keyed to the original custody address + carries the
        // old collateral identity (structurally a transferred position).
        LibVaipakam.Loan memory newLoan =
            LoanFacet(address(diamond)).getLoanDetails(newLoanId);
        assertEq(newLoan.borrower, borrower, "new loan.borrower = original custody address");
        assertEq(newLoan.collateralAmount, LOAN_COLLATERAL, "new loan carries the old collateral amount");
        assertEq(uint8(newLoan.status), uint8(LibVaipakam.LoanStatus.Active), "new loan Active");
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(oldLoanId).status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "old loan Repaid"
        );
    }

    function test_576_refinanceTaggedOffer_mismatchedCollateral_isNotCarryOver()
        public
    {
        // #576 Codex P3 — a refinance-tagged offer whose carried collateral
        // identity does NOT match the targeted loan's is NOT eligible for
        // carry-over: the persisted `refinanceCarryOver` flag resolves to
        // false, so it takes the legacy fresh-pledge path (a fresh batch IS
        // deposited) instead of skipping a deposit it could never satisfy at
        // refinance. The offer is created normally — no revert.
        uint256 oldLoanId = _buildActiveLoan();
        vm.prank(borrower);
        _f().setAutoRefinanceCaps(
            oldLoanId, true, 600, uint64(block.timestamp + 365 days)
        );

        LibVaipakam.CreateOfferParams memory params =
            _refinanceTaggedOfferParams(oldLoanId, 400);
        // Mismatch the carried collateral amount vs the old loan's
        // (LOAN_COLLATERAL); keep the single-value invariant intact.
        params.collateralAmount = LOAN_COLLATERAL + 1 ether;
        params.collateralAmountMax = LOAN_COLLATERAL + 1 ether;

        vm.prank(borrower);
        uint256 offerId =
            OfferCreateFacet(address(diamond)).createOffer(params);

        LibVaipakam.Offer memory o =
            OfferCancelFacet(address(diamond)).getOfferDetails(offerId);
        assertFalse(
            o.refinanceCarryOver,
            "mismatched-collateral tagged offer is not carry-over"
        );
    }

    function test_576_refinanceTaggedOffer_collateralMutationBlocked() public {
        // #576 Codex P2 — a refinance-tagged carry-over offer vaults NO
        // collateral batch at create (the deposit is skipped). Mutating its
        // collateral post-create would desync the create-time carry-over
        // decision from the physical vault, so both mutation entry points must
        // reject a tagged offer's collateral cluster.
        uint256 oldLoanId = _buildActiveLoan();
        vm.prank(borrower);
        _f().setAutoRefinanceCaps(
            oldLoanId, true, 600, uint64(block.timestamp + 365 days)
        );
        vm.prank(borrower);
        uint256 taggedOfferId = OfferCreateFacet(address(diamond))
            .createOffer(_refinanceTaggedOfferParams(oldLoanId, 400));

        // setOfferCollateral on a tagged offer reverts.
        vm.prank(borrower);
        vm.expectRevert(
            OfferMutateFacet.CollateralMutationUnsupportedForShape.selector
        );
        OfferMutateFacet(address(diamond)).setOfferCollateral(
            taggedOfferId, LOAN_COLLATERAL, LOAN_COLLATERAL
        );

        // modifyOffer's collateral cluster on a tagged offer reverts too.
        vm.prank(borrower);
        vm.expectRevert(
            OfferMutateFacet.CollateralMutationUnsupportedForShape.selector
        );
        OfferMutateFacet(address(diamond)).modifyOffer(
            taggedOfferId,
            LibVaipakam.OfferModifyParams({
                amount: LOAN_PRINCIPAL,
                amountMax: LOAN_PRINCIPAL,
                interestRateBps: 400,
                interestRateBpsMax: 400,
                collateralAmount: LOAN_COLLATERAL + 1 ether,
                collateralAmountMax: LOAN_COLLATERAL + 1 ether
            })
        );
    }

    function test_595_nonAdmissibleTaggedOffer_notMatchable() public {
        // #595 — a refinance-tagged offer that FAILS the admission mirror is
        // still rejected by matchOffers (RefinanceTaggedOfferNotMatchable),
        // before previewMatch. Here the auto-refinance kill-switch is OFF, so
        // the keeper-driven matched-refinance completion path is gated →
        // `LibAutoRefinanceCheck.matchAdmissible` returns false. (Pre-#595 ALL
        // tagged offers were rejected; now only non-admissible ones are.)
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        uint256 oldLoanId = _buildActiveLoan();
        vm.prank(borrower);
        _f().setAutoRefinanceCaps(
            oldLoanId, true, 600, uint64(block.timestamp + 365 days)
        );
        vm.prank(borrower);
        uint256 taggedOfferId = OfferCreateFacet(address(diamond))
            .createOffer(_refinanceTaggedOfferParams(oldLoanId, 400));

        // Kill-switch OFF ⇒ the matched-refinance completion path is gated.
        _admin().setAutoRefinanceEnabled(false);

        vm.expectRevert(
            OfferMatchFacet.RefinanceTaggedOfferNotMatchable.selector
        );
        OfferMatchFacet(address(diamond)).matchOffers(999, taggedOfferId);
    }

    /// @dev A fresh Partial lender offer that funds a refinance, matching the
    ///      carry-over offer's terms. `collateralReq` lets a test make the
    ///      lender demand MORE collateral than the carried amount.
    function _refiLenderOfferId(uint256 rateBps, uint256 collateralReq)
        internal
        returns (uint256)
    {
        deal(mockERC20, lender, LOAN_PRINCIPAL * 4);
        address lenderVault =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        vm.prank(lender);
        ERC20(mockERC20).approve(lenderVault, type(uint256).max);
        vm.prank(lender);
        return OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: LOAN_PRINCIPAL,
                interestRateBps: rateBps,
                collateralAsset: mockCollateralERC20,
                collateralAmount: collateralReq,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: LOAN_PRINCIPAL,
                interestRateBpsMax: rateBps,
                collateralAmountMax: collateralReq,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    function _carryOverMatchFixture()
        internal
        returns (uint256 oldLoanId, uint256 taggedOfferId)
    {
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        oldLoanId = _buildActiveLoan();
        vm.prank(borrower);
        _f().setAutoRefinanceCaps(
            oldLoanId, true, 600, uint64(block.timestamp + 365 days)
        );
        vm.prank(borrower);
        taggedOfferId = OfferCreateFacet(address(diamond))
            .createOffer(_refinanceTaggedOfferParams(oldLoanId, 400));
    }

    function test_595_matchedCarryOver_admitsRetagsAndRepaysOld() public {
        (uint256 oldLoanId, uint256 taggedOfferId) = _carryOverMatchFixture();
        uint256 lenderOfferId = _refiLenderOfferId(400, LOAN_COLLATERAL);

        // §3.1-3.3 — previewMatch admits with the forced/pinned values.
        LibOfferMatch.MatchResult memory mr = OfferMatchFacet(address(diamond))
            .previewMatch(lenderOfferId, taggedOfferId);
        assertEq(uint8(mr.errorCode), uint8(LibOfferMatch.MatchError.Ok), "admitted");
        assertEq(mr.matchAmount, LOAN_PRINCIPAL, "matchAmount = borrower full amount");
        assertEq(mr.reqCollateral, LOAN_COLLATERAL, "reqCollateral pinned to carried");

        // §2/§3.6 — the atomic carry-over refinance executes in the match tx.
        // A successful matchOffers IMPLIES the strict same-key retag succeeded
        // (a failed retag reverts the whole tx), so there is no uncollateralized
        // window.
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, taggedOfferId);

        assertTrue(
            LoanFacet(address(diamond)).getLoanDetails(oldLoanId).status
                != LibVaipakam.LoanStatus.Active,
            "old loan refinanced away (terminal)"
        );
    }

    function test_595_matchedCarryOver_lenderWantsMoreCollateral_shortfall()
        public
    {
        (uint256 oldLoanId, uint256 taggedOfferId) = _carryOverMatchFixture();
        oldLoanId; // silence unused
        // Lender demands MORE collateral than the carried amount — carry-over
        // can't top up with fresh collateral ⇒ shortfall.
        uint256 lenderOfferId =
            _refiLenderOfferId(400, LOAN_COLLATERAL + 100 ether);

        LibOfferMatch.MatchResult memory mr = OfferMatchFacet(address(diamond))
            .previewMatch(lenderOfferId, taggedOfferId);
        assertEq(
            uint8(mr.errorCode),
            uint8(LibOfferMatch.MatchError.RefinanceCarryOverCollateralShortfall),
            "shortfall surfaced in preview"
        );
        vm.expectRevert();
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, taggedOfferId);
    }

    function test_595_carryOverOffer_amountMutationFrozen() public {
        (, uint256 taggedOfferId) = _carryOverMatchFixture();

        // setOfferAmount on a refinance-tagged offer reverts (§3.5 freeze).
        vm.prank(borrower);
        vm.expectRevert(
            OfferMutateFacet.AmountMutationUnsupportedForShape.selector
        );
        OfferMutateFacet(address(diamond)).setOfferAmount(
            taggedOfferId, LOAN_PRINCIPAL + 1 ether, LOAN_PRINCIPAL + 1 ether
        );

        // modifyOffer's amount cluster on a tagged offer reverts too.
        vm.prank(borrower);
        vm.expectRevert(
            OfferMutateFacet.AmountMutationUnsupportedForShape.selector
        );
        OfferMutateFacet(address(diamond)).modifyOffer(
            taggedOfferId,
            LibVaipakam.OfferModifyParams({
                amount: LOAN_PRINCIPAL + 1 ether,
                amountMax: LOAN_PRINCIPAL + 1 ether,
                interestRateBps: 400,
                interestRateBpsMax: 400,
                collateralAmount: LOAN_COLLATERAL,
                collateralAmountMax: LOAN_COLLATERAL
            })
        );
    }

    function test_595_matchedCarryOver_killSwitchOff_rejected() public {
        (uint256 oldLoanId, uint256 taggedOfferId) = _carryOverMatchFixture();
        oldLoanId;
        uint256 lenderOfferId = _refiLenderOfferId(400, LOAN_COLLATERAL);
        // Disable the auto-refinance kill-switch ⇒ admission fails.
        _admin().setAutoRefinanceEnabled(false);

        LibOfferMatch.MatchResult memory mr = OfferMatchFacet(address(diamond))
            .previewMatch(lenderOfferId, taggedOfferId);
        assertEq(
            uint8(mr.errorCode),
            uint8(LibOfferMatch.MatchError.RefinanceTagged),
            "gated kill-switch -> not admissible"
        );
        vm.expectRevert(
            OfferMatchFacet.RefinanceTaggedOfferNotMatchable.selector
        );
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, taggedOfferId);
    }

    function test_576_refinanceTaggedOffer_cannotOptIntoParallelSale() public {
        // #576 Codex P1 — a refinance-tagged offer is single-purpose. It must
        // not also opt into the pre-loan parallel sale (#358 borrow-OR-sell):
        // on a carry-over offer the listed collateral is the target loan's
        // already-encumbered NFT, so a sale fill before the refinance accept
        // would transfer it out while the old loan stays Active. Reject the
        // combination at create.
        uint256 oldLoanId = _buildActiveLoan();
        vm.prank(borrower);
        _f().setAutoRefinanceCaps(
            oldLoanId, true, 600, uint64(block.timestamp + 365 days)
        );
        LibVaipakam.CreateOfferParams memory params =
            _refinanceTaggedOfferParams(oldLoanId, 400);
        params.allowsParallelSale = true;

        vm.prank(borrower);
        vm.expectRevert(OfferCreateFacet.InvalidRefinanceTarget.selector);
        OfferCreateFacet(address(diamond)).createOffer(params);
    }

    function test_576_refinanceTaggedOffer_notTransferableViaObligation()
        public
    {
        // #576 Codex P1 — a refinance-tagged offer must not be consumable by
        // the unrelated obligation-transfer path. On a carry-over offer the
        // collateral was never deposited (it's the target loan's, already
        // liened), so transferObligation would double-lien the same NFT and
        // corrupt settlement. Reject before any state change.
        uint256 oldLoanId = _buildActiveLoan();
        vm.prank(borrower);
        _f().setAutoRefinanceCaps(
            oldLoanId, true, 600, uint64(block.timestamp + 365 days)
        );
        vm.prank(borrower);
        uint256 taggedOfferId = OfferCreateFacet(address(diamond))
            .createOffer(_refinanceTaggedOfferParams(oldLoanId, 400));

        vm.prank(borrower);
        vm.expectRevert(PrecloseFacet.InvalidOfferTerms.selector);
        PrecloseFacet(address(diamond)).transferObligationViaOffer(
            oldLoanId, taggedOfferId
        );
    }

    function test_T092H_RefinanceLoanFromAccept_RejectsExternalEOA() public {
        // T-092-H — the new external entry is `onlyDiamondInternal`
        // gated. A direct external EOA call must revert
        // OnlyDiamondInternal — not bubble through to the refinance
        // logic. Structural guardrail against accidentally exposing
        // the no-nonReentrant entry to arbitrary callers.
        address randoUser = makeAddr("randoExternalCaller");
        vm.prank(randoUser);
        vm.expectRevert(RefinanceFacet.OnlyDiamondInternal.selector);
        RefinanceFacet(address(diamond)).refinanceLoanFromAccept(1, 1);
    }

    // ─── #407 Vault encumbrance sub-ledger — collateral lien ──────────

    function test_407_LoanInitCreatesCollateralLien() public {
        // Build an active loan via the existing fixture
        // (ERC20-principal + ERC20-collateral). Then assert the
        // collateral lien was created at loan-init with the right
        // shape, and that the borrower's `encumbered` aggregate
        // ticked up by the collateral amount.
        uint256 loanId = _buildActiveLoan();

        // Aggregate ticked up.
        uint256 enc = MetricsFacet(address(diamond))
            .getEncumbered(borrower, mockCollateralERC20, 0);
        assertEq(
            enc,
            LOAN_COLLATERAL,
            "encumbered aggregate must equal the loan's collateral amount"
        );

        // Per-loan lien row populated.
        LibVaipakam.Encumbrance memory lien =
            MetricsFacet(address(diamond)).getLoanCollateralLien(loanId);
        assertEq(lien.user, borrower, "lien.user = borrower");
        assertEq(lien.asset, mockCollateralERC20, "lien.asset = collateral");
        assertEq(lien.tokenId, 0, "lien.tokenId = 0 for ERC20");
        assertEq(lien.amount, LOAN_COLLATERAL, "lien.amount = collateral");
        assertFalse(lien.released, "fresh lien is not released");

        // Free-balance helper: a synthetic raw balance reports
        // `raw − encumbered` as available.
        uint256 free = MetricsFacet(address(diamond)).getFreeBalance(
            borrower,
            mockCollateralERC20,
            0,
            LOAN_COLLATERAL + 100 ether
        );
        assertEq(
            free,
            100 ether,
            "freeBalance = raw - sum(liens)"
        );
    }
}
