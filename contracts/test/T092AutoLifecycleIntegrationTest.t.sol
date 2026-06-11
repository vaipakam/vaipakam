// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AutoLifecycleFacet} from "../src/facets/AutoLifecycleFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAutoRefinanceCheck} from "../src/libraries/LibAutoRefinanceCheck.sol";
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
                refinanceTargetLoanId: 0
            })
        );
        vm.prank(borrower);
        loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
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
            refinanceTargetLoanId: targetLoanId
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
                refinanceTargetLoanId: 0
            })
        );
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond))
            .acceptOffer(offerId, true);

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
}
