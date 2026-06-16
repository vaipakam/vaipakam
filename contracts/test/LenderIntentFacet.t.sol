// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/**
 * @title  LenderIntentFacetTest
 * @notice #393 v1-a — the LenderIntentVault standing-terms surface
 *         (set / cancel / read + bounds validation). No fill path yet
 *         (that's v1-b `matchIntent`); this suite proves the intent record
 *         lifecycle + the bounds guard in isolation.
 */
contract LenderIntentFacetTest is SetupTest {
    address internal user;

    // A valid 1.5x-style bound set (the numbers are nominal — no fill here).
    uint256 internal constant MAX_EXPOSURE = 100_000 ether;
    uint256 internal constant MIN_RATE_BPS = 300;
    uint16 internal constant MAX_INIT_LTV_BPS = 6600; // 66%
    uint32 internal constant MAX_DURATION_DAYS = 90;
    uint256 internal constant MIN_FILL = 100 ether;

    function setUp() public {
        setupHelper();
        user = makeAddr("intentLender");
    }

    function _set(address lendAsset, address collAsset) internal {
        vm.prank(user);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            lendAsset,
            collAsset,
            MAX_EXPOSURE,
            MIN_RATE_BPS,
            MAX_INIT_LTV_BPS,
            MAX_DURATION_DAYS,
            MIN_FILL,
            false, // requiresKeeperAuth
            true // riskAndTermsConsent
        );
    }

    // ─── 1. Set + read round-trip ──────────────────────────────────────────

    function test_setLenderIntent_roundTrip() public {
        _set(mockERC20, mockCollateralERC20);

        LibVaipakam.LenderIntent memory it = LenderIntentFacet(address(diamond))
            .getLenderIntent(user, mockERC20, mockCollateralERC20);
        assertTrue(it.active, "active");
        assertEq(it.maxExposure, MAX_EXPOSURE, "maxExposure");
        assertEq(it.minRateBps, MIN_RATE_BPS, "minRateBps");
        assertEq(it.maxInitLtvBps, MAX_INIT_LTV_BPS, "maxInitLtvBps");
        assertEq(it.maxDurationDays, MAX_DURATION_DAYS, "maxDurationDays");
        assertEq(it.minFillAmount, MIN_FILL, "minFillAmount");
        assertFalse(it.requiresKeeperAuth, "requiresKeeperAuth default false");
    }

    // ─── 2. Overwrite in place ─────────────────────────────────────────────

    function test_setLenderIntent_overwrites() public {
        _set(mockERC20, mockCollateralERC20);
        vm.prank(user);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 50_000 ether, 500, 5000, 30, 1 ether, false, true
        );
        LibVaipakam.LenderIntent memory it = LenderIntentFacet(address(diamond))
            .getLenderIntent(user, mockERC20, mockCollateralERC20);
        assertEq(it.maxExposure, 50_000 ether, "overwritten exposure");
        assertEq(it.minRateBps, 500, "overwritten rate");
        assertEq(it.maxInitLtvBps, 5000, "overwritten ltv");
    }

    // ─── 3. Cancel ─────────────────────────────────────────────────────────

    function test_cancelLenderIntent() public {
        _set(mockERC20, mockCollateralERC20);
        vm.prank(user);
        LenderIntentFacet(address(diamond)).cancelLenderIntent(
            mockERC20, mockCollateralERC20
        );
        LibVaipakam.LenderIntent memory it = LenderIntentFacet(address(diamond))
            .getLenderIntent(user, mockERC20, mockCollateralERC20);
        assertFalse(it.active, "cancelled => inactive");
    }

    function test_cancel_whenNotActive_reverts() public {
        vm.prank(user);
        vm.expectRevert(LenderIntentFacet.LenderIntentNotActive.selector);
        LenderIntentFacet(address(diamond)).cancelLenderIntent(
            mockERC20, mockCollateralERC20
        );
    }

    // ─── 4. Bounds validation ──────────────────────────────────────────────

    function test_zeroAsset_reverts() public {
        vm.prank(user);
        vm.expectRevert(LenderIntentFacet.LenderIntentZeroAddress.selector);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            address(0), mockCollateralERC20, MAX_EXPOSURE, MIN_RATE_BPS,
            MAX_INIT_LTV_BPS, MAX_DURATION_DAYS, MIN_FILL, false, true
        );
    }

    function test_zeroExposure_reverts() public {
        vm.prank(user);
        vm.expectRevert(LenderIntentFacet.LenderIntentInvalidBounds.selector);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, MIN_RATE_BPS,
            MAX_INIT_LTV_BPS, MAX_DURATION_DAYS, MIN_FILL, false, true
        );
    }

    function test_minFillAboveExposure_reverts() public {
        vm.prank(user);
        vm.expectRevert(LenderIntentFacet.LenderIntentInvalidBounds.selector);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 100 ether, MIN_RATE_BPS,
            MAX_INIT_LTV_BPS, MAX_DURATION_DAYS, 200 ether, false, true
        );
    }

    function test_zeroLtv_reverts() public {
        vm.prank(user);
        vm.expectRevert(LenderIntentFacet.LenderIntentInvalidBounds.selector);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, MAX_EXPOSURE, MIN_RATE_BPS,
            0, MAX_DURATION_DAYS, MIN_FILL, false, true
        );
    }

    function test_ltvAbove100pct_reverts() public {
        vm.prank(user);
        vm.expectRevert(LenderIntentFacet.LenderIntentInvalidBounds.selector);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, MAX_EXPOSURE, MIN_RATE_BPS,
            10_001, MAX_DURATION_DAYS, MIN_FILL, false, true
        );
    }

    function test_zeroDuration_reverts() public {
        vm.prank(user);
        vm.expectRevert(LenderIntentFacet.LenderIntentInvalidBounds.selector);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, MAX_EXPOSURE, MIN_RATE_BPS,
            MAX_INIT_LTV_BPS, 0, MIN_FILL, false, true
        );
    }

    function test_rateAboveMax_reverts() public {
        // minRateBps above MAX_INTEREST_BPS (10_000) → unfillable; rejected.
        vm.prank(user);
        vm.expectRevert(LenderIntentFacet.LenderIntentInvalidBounds.selector);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, MAX_EXPOSURE, 10_001,
            MAX_INIT_LTV_BPS, MAX_DURATION_DAYS, MIN_FILL, false, true
        );
    }

    function test_selfCollateralized_reverts() public {
        // lendingAsset == collateralAsset → the fill path's createOffer would
        // reject SelfCollateralizedOffer; rejected at registration.
        vm.prank(user);
        vm.expectRevert(LenderIntentFacet.LenderIntentSelfCollateralized.selector);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockERC20, MAX_EXPOSURE, MIN_RATE_BPS,
            MAX_INIT_LTV_BPS, MAX_DURATION_DAYS, MIN_FILL, false, true
        );
    }

    function test_keeperAuthFlag_accepted() public {
        // #393 v1-c — requiresKeeperAuth=true is now honoured (the gate ships in
        // matchIntent); registering it round-trips.
        vm.prank(user);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, MAX_EXPOSURE, MIN_RATE_BPS,
            MAX_INIT_LTV_BPS, MAX_DURATION_DAYS, MIN_FILL, true, true
        );
        assertTrue(
            LenderIntentFacet(address(diamond))
                .getLenderIntent(user, mockERC20, mockCollateralERC20)
                .requiresKeeperAuth,
            "requiresKeeperAuth stored"
        );
    }

    function test_noConsent_reverts() public {
        // riskAndTermsConsent=false → RiskAndTermsConsentRequired (same gate as
        // offer-create).
        vm.prank(user);
        vm.expectRevert(IVaipakamErrors.RiskAndTermsConsentRequired.selector);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, MAX_EXPOSURE, MIN_RATE_BPS,
            MAX_INIT_LTV_BPS, MAX_DURATION_DAYS, MIN_FILL, false, false
        );
    }

    // ─── 5. Kill-switch (admin-gated) ──────────────────────────────────────

    function test_setLenderIntentEnabled_adminOnly() public {
        // Default off.
        assertFalse(
            LenderIntentFacet(address(diamond)).isLenderIntentEnabled(),
            "kill-switch default off"
        );
        // Owner holds ADMIN_ROLE in SetupTest — can toggle.
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);
        assertTrue(
            LenderIntentFacet(address(diamond)).isLenderIntentEnabled(),
            "enabled after admin toggle"
        );

        // A non-admin cannot.
        vm.prank(user);
        vm.expectRevert();
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(false);
    }

    // ─── 6. Independence across asset-pairs ────────────────────────────────

    function test_intents_independentPerPair() public {
        _set(mockERC20, mockCollateralERC20);
        // A different collateral asset is a distinct intent slot.
        assertFalse(
            LenderIntentFacet(address(diamond))
                .getLenderIntent(user, mockERC20, mockERC20).active,
            "distinct pair untouched"
        );
    }
}
