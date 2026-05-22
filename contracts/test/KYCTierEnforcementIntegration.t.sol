// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title KYCTierEnforcementIntegration
 * @notice End-to-end integration coverage for the Phase-1 load-bearing
 *         compliance gate: with country-pair restrictions disabled (see
 *         {LibVaipakam.canTradeBetween}), the tiered KYC thresholds are
 *         the sole on-chain policy blocking high-value activity by
 *         unverified wallets.
 *
 *         Covers the full matrix:
 *           - Tier 0 (no KYC)  — allowed only below $1,000 USD notional.
 *           - Tier 1 (email)   — allowed in the $1,000 – $9,999 band.
 *           - Tier 2 (full)    — allowed at $10,000+.
 *
 *         Each rung is exercised via the full offer → accept path so the
 *         test doubles as a regression guard for `OfferAcceptFacet.acceptOffer`
 *         and `_calculateTransactionValueNumeraire`, not just the
 *         `ProfileFacet.meetsKYCRequirement` view (which has unit-level
 *         coverage).
 *
 *         Enforcement is toggled on in `setUp()` via
 *         `AdminFacet.setKYCEnforcement(true)` — mirrors the ops flip
 *         that will happen at production bring-up once the KYC admin
 *         role has onboarded its first cohort.
 *
 * @dev    #168 Track A — folded onto `SetupTest`. SetupTest's setupHelper()
 *         brings up the 28-facet production-mirroring diamond, mints +
 *         approves both actors against `mockERC20` (used here as the
 *         USDC-like $1 principal asset) and `mockCollateralERC20`, pins
 *         both at Tier-2, and unpauses. This file's setUp() then deviates
 *         in three KYC-specific ways:
 *
 *           1) Re-mock `mockCollateralERC20`'s price to $2,000 so the
 *              0.05-ether collateral leg contributes a fixed ~$100 to
 *              valueNumeraire — the principal dominates the threshold
 *              math (see PRINCIPAL_* constants below).
 *           2) Downgrade `borrower` to Tier-0 so the threshold-blocked
 *              path is reachable; individual tests upgrade mid-flow.
 *              `lender` stays at Tier-2 so every revert below is
 *              attributable to borrower state.
 *           3) Flip `setKYCEnforcement(true)` — without this,
 *              `meetsKYCRequirement` returns true unconditionally and
 *              the assertions wouldn't bind.
 */
contract KYCTierEnforcementIntegration is SetupTest {
    uint256 constant DURATION = 30;
    uint256 constant RATE_BPS = 500;

    // valueNumeraire = principal + collateral (both in active numeraire,
    // USD post-deploy default). Collateral is pinned at 0.05 ether ×
    // $2,000 = $100; principal dominates band selection:
    //   400   `mockERC20` principal → ~$500   (Tier-0 OK)
    //   2,500 `mockERC20` principal → ~$2,600 (Tier-1 required)
    //   15,000 `mockERC20` principal → ~$15,100 (Tier-2 required)
    // HF stays oracle-mocked to 2.0 inside `setupHelper()` so the small
    // collateral leg doesn't trip the HF-floor at acceptOffer.
    uint256 constant PRINCIPAL_UNDER_TIER0 = 400 ether;
    uint256 constant PRINCIPAL_BETWEEN_TIER0_AND_TIER1 = 2_500 ether;
    uint256 constant PRINCIPAL_ABOVE_TIER1 = 15_000 ether;
    uint256 constant COLLATERAL_ERC20 = 0.05 ether; // ~$100 @ $2k WETH

    function setUp() public {
        setupHelper();

        // (1) Re-price the collateral leg to $2,000 — overrides the
        //     SetupTest default of $1 so the principal dominates the
        //     threshold math. Both classification + active-network
        //     liquidity remain as setupHelper() left them (Liquid).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getAssetPrice.selector,
                mockCollateralERC20
            ),
            abi.encode(uint256(2000e8), uint8(8))
        );

        // (2) Downgrade borrower to Tier-0. setupHelper() pins both
        //     sides at Tier-2; the threshold-blocked paths need the
        //     borrower below the gate's floor.
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(
            borrower,
            LibVaipakam.KYCTier.Tier0
        );

        // (3) Flip KYC enforcement on. Retail-deploy default is OFF (per
        //     CLAUDE.md retail-deploy policy); this file is the
        //     industrial-fork integration coverage that exercises the
        //     ON state.
        AdminFacet(address(diamond)).setKYCEnforcement(true);
    }

    // ─── Tier-0: blocked above $1k threshold ────────────────────────────

    /// @notice A Tier-0 borrower can accept a small (< $1k) offer — the
    ///         tiered-KYC gate is a no-op below the Tier-0 threshold.
    function test_Tier0_AllowedBelowTier0Threshold() public {
        uint256 offerId = _lenderOffer(PRINCIPAL_UNDER_TIER0);
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
        LibVaipakam.Loan memory L =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(L.status), uint8(LibVaipakam.LoanStatus.Active));
    }

    /// @notice A Tier-0 borrower attempting a $2.5k loan reverts
    ///         KYCRequired — Tier-1 is the minimum for the $1k–$10k band.
    function test_Tier0_BlockedAboveTier0Threshold() public {
        uint256 offerId = _lenderOffer(PRINCIPAL_BETWEEN_TIER0_AND_TIER1);
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.KYCRequired.selector);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
    }

    // ─── Tier-1: passes the middle band, blocked above $10k ─────────────

    /// @notice After the borrower upgrades to Tier-1, the same $2.5k offer
    ///         now accepts cleanly. Guards against a regression where the
    ///         tier comparison inverts or the threshold math drifts.
    function test_Tier1_AllowedInMiddleBand() public {
        uint256 offerId = _lenderOffer(PRINCIPAL_BETWEEN_TIER0_AND_TIER1);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier1);
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
        LibVaipakam.Loan memory L =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(L.status), uint8(LibVaipakam.LoanStatus.Active));
    }

    /// @notice A Tier-1 borrower attempting a $15k loan reverts KYCRequired.
    ///         Tier-2 is the minimum above the $10k threshold.
    function test_Tier1_BlockedAboveTier1Threshold() public {
        uint256 offerId = _lenderOffer(PRINCIPAL_ABOVE_TIER1);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier1);
        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.KYCRequired.selector);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
    }

    // ─── Tier-2: unlimited ───────────────────────────────────────────────

    /// @notice Tier-2 borrower clears every threshold. End-to-end proof that
    ///         the full KYC gate chains through OfferAcceptFacet.acceptOffer.
    function test_Tier2_AllowedAboveTier1Threshold() public {
        uint256 offerId = _lenderOffer(PRINCIPAL_ABOVE_TIER1);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(borrower, LibVaipakam.KYCTier.Tier2);
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
        LibVaipakam.Loan memory L =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(L.status), uint8(LibVaipakam.LoanStatus.Active));
    }

    // ─── Enforcement toggle — confirms the gate can be disabled ─────────

    /// @notice With KYC enforcement OFF, the same Tier-0 borrower can take
    ///         the $2.5k loan that previously reverted. Exercises the
    ///         global bypass flag at {AdminFacet.setKYCEnforcement}.
    function test_EnforcementOff_Tier0AllowedAboveThreshold() public {
        AdminFacet(address(diamond)).setKYCEnforcement(false);
        uint256 offerId = _lenderOffer(PRINCIPAL_BETWEEN_TIER0_AND_TIER1);
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
        LibVaipakam.Loan memory L =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(L.status), uint8(LibVaipakam.LoanStatus.Active));
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    /// @dev Builds a Lender-side createOffer over (mockERC20 = $1 USDC-like
    ///      principal, mockCollateralERC20 = $2k WETH-like collateral). The
    ///      pricing was set in setUp(); SetupTest pre-approves both actors
    ///      against the diamond and their per-user vaults for both tokens.
    function _lenderOffer(uint256 principal) internal returns (uint256 offerId) {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: principal,
                interestRateBps: RATE_BPS,
                collateralAsset: mockCollateralERC20,
                collateralAmount: COLLATERAL_ERC20,
                durationDays: DURATION,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: address(0),
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                amountMax: principal,
                interestRateBpsMax: RATE_BPS,
                collateralAmountMax: COLLATERAL_ERC20,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );
    }
}
