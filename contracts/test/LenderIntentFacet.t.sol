// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibMetricsTypes} from "../src/libraries/LibMetricsTypes.sol";

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

    // ─── #625 WI-2a — active-intent discovery registry ──────────────────────

    function test_getActiveLenderIntents_listsDelistsAndIsIdempotent() public {
        // Two distinct pairs for the same owner (swapped lend/coll — both valid).
        _set(mockERC20, mockCollateralERC20);
        _set(mockCollateralERC20, mockERC20);

        (LibMetricsTypes.LenderIntentSummary[] memory page, uint256 total) =
            MetricsFacet(address(diamond)).getActiveLenderIntents(0, 10);
        assertEq(total, 2, "both active intents listed");
        assertEq(page.length, 2, "page returns both");

        bool found;
        for (uint256 i = 0; i < page.length; i++) {
            if (
                page[i].lendingAsset == mockERC20
                    && page[i].collateralAsset == mockCollateralERC20
            ) {
                found = true;
                assertEq(page[i].owner, user, "owner");
                assertEq(page[i].maxExposure, MAX_EXPOSURE, "maxExposure");
                assertEq(page[i].minRateBps, MIN_RATE_BPS, "minRateBps");
                assertEq(page[i].maxInitLtvBps, MAX_INIT_LTV_BPS, "maxInitLtvBps");
                assertEq(page[i].maxDurationDays, MAX_DURATION_DAYS, "maxDurationDays");
                assertEq(page[i].minFillAmount, MIN_FILL, "minFillAmount");
                assertEq(page[i].requiresKeeperAuth, false, "requiresKeeperAuth");
                assertEq(page[i].livePrincipal, 0, "no live principal yet");
                assertEq(page[i].availableCapital, 0, "no funded capital yet");
            }
        }
        assertTrue(found, "the seeded pair is in the page");

        // Cancel one → it de-lists; the other survives.
        vm.prank(user);
        LenderIntentFacet(address(diamond)).cancelLenderIntent(
            mockERC20, mockCollateralERC20
        );
        (page, total) =
            MetricsFacet(address(diamond)).getActiveLenderIntents(0, 10);
        assertEq(total, 1, "cancelled intent de-listed");
        assertEq(page[0].collateralAsset, mockERC20, "the surviving pair remains");

        // Re-set the cancelled pair → re-lists.
        _set(mockERC20, mockCollateralERC20);
        (, total) = MetricsFacet(address(diamond)).getActiveLenderIntents(0, 10);
        assertEq(total, 2, "re-set intent re-listed");

        // Re-setting an ALREADY-active intent (a bounds update) doesn't double-count.
        _set(mockERC20, mockCollateralERC20);
        (, total) = MetricsFacet(address(diamond)).getActiveLenderIntents(0, 10);
        assertEq(total, 2, "idempotent re-set keeps count at 2");
    }

    function test_getActiveLenderIntents_pagination() public {
        _set(mockERC20, mockCollateralERC20);
        _set(mockCollateralERC20, mockERC20);

        (LibMetricsTypes.LenderIntentSummary[] memory p0, uint256 total) =
            MetricsFacet(address(diamond)).getActiveLenderIntents(0, 1);
        assertEq(total, 2, "total reflects all active");
        assertEq(p0.length, 1, "limit honoured");

        (LibMetricsTypes.LenderIntentSummary[] memory p1,) =
            MetricsFacet(address(diamond)).getActiveLenderIntents(1, 1);
        assertEq(p1.length, 1, "second page");
        assertTrue(
            p0[0].collateralAsset != p1[0].collateralAsset,
            "distinct rows across pages"
        );

        (LibMetricsTypes.LenderIntentSummary[] memory pEnd,) =
            MetricsFacet(address(diamond)).getActiveLenderIntents(5, 10);
        assertEq(pEnd.length, 0, "offset past end is empty");
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

    function test_vpfiLendingAsset_reverts() public {
        // #393 v1-d.1 (Codex P2) — VPFI as the LENDING asset is rejected at the
        // root: its vault balance drives the fee-discount/staking accounting the
        // intent fund/fill/withdraw chokepoints don't re-stamp. Configure VPFI
        // as `mockERC20`, then a mockERC20-lending intent must revert.
        vm.prank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);
        vm.prank(user);
        vm.expectRevert(LenderIntentFacet.LenderIntentVpfiLendingUnsupported.selector);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, MAX_EXPOSURE, MIN_RATE_BPS,
            MAX_INIT_LTV_BPS, MAX_DURATION_DAYS, MIN_FILL, false, true
        );
    }

    function test_vpfiCollateralAsset_allowed() public {
        // VPFI as COLLATERAL is unaffected — only the lending leg is blocked.
        vm.prank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(mockCollateralERC20);
        vm.prank(user);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, MAX_EXPOSURE, MIN_RATE_BPS,
            MAX_INIT_LTV_BPS, MAX_DURATION_DAYS, MIN_FILL, false, true
        );
        assertTrue(
            LenderIntentFacet(address(diamond))
                .getLenderIntent(user, mockERC20, mockCollateralERC20).active,
            "VPFI-collateral intent registers"
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
