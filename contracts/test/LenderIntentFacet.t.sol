// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibMetricsTypes} from "../src/libraries/LibMetricsTypes.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

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

    // ─── #625 WI-2a — active-intent discovery registry (funded-set) ─────────

    /// @dev Fund an intent's lending leg so it enters the keeper feed — the registry
    ///      advertises ONLY active + FUNDED intents (zero-capital registrations stay out).
    function _fund(address lendAsset, address collAsset, uint256 amount) internal {
        ERC20Mock(lendAsset).mint(user, amount);
        vm.prank(user);
        ERC20(lendAsset).approve(address(diamond), amount);
        vm.prank(user);
        LenderIntentFacet(address(diamond)).fundLenderIntent(
            lendAsset, collAsset, amount
        );
    }

    function _activeCount() internal view returns (uint256 total) {
        (, total) = MetricsFacet(address(diamond)).getActiveLenderIntents(0, 100);
    }

    function test_getActiveLenderIntents_onlyFundedAreListed() public {
        // Bare registration commits no capital ⇒ NOT advertised (anti-spam: entering
        // the global feed costs committed capital, not just gas).
        _set(mockERC20, mockCollateralERC20);
        assertEq(_activeCount(), 0, "unfunded intent is not listed");

        // Funding it lists it, with the bounds + sizing figures.
        _fund(mockERC20, mockCollateralERC20, 1_000 ether);
        (LibMetricsTypes.LenderIntentSummary[] memory page, uint256 total) =
            MetricsFacet(address(diamond)).getActiveLenderIntents(0, 10);
        assertEq(total, 1, "funded intent listed");
        assertEq(page[0].owner, user, "owner");
        assertEq(page[0].lendingAsset, mockERC20, "lendingAsset");
        assertEq(page[0].collateralAsset, mockCollateralERC20, "collateralAsset");
        assertEq(page[0].maxExposure, MAX_EXPOSURE, "maxExposure");
        assertEq(page[0].minRateBps, MIN_RATE_BPS, "minRateBps");
        assertEq(page[0].maxInitLtvBps, MAX_INIT_LTV_BPS, "maxInitLtvBps");
        assertEq(page[0].maxDurationDays, MAX_DURATION_DAYS, "maxDurationDays");
        assertEq(page[0].minFillAmount, MIN_FILL, "minFillAmount");
        assertEq(page[0].requiresKeeperAuth, false, "requiresKeeperAuth");
        assertEq(page[0].livePrincipal, 0, "no live principal yet");
        assertEq(page[0].availableCapital, 1_000 ether, "funded capital");
    }

    function test_getActiveLenderIntents_belowMinFillNotListed() public {
        _set(mockERC20, mockCollateralERC20);
        // Funded, but BELOW the intent's minFillAmount ⇒ no valid fill is possible
        // (a fill must be >= minFillAmount AND <= capital) ⇒ not advertised.
        _fund(mockERC20, mockCollateralERC20, MIN_FILL - 1);
        assertEq(_activeCount(), 0, "funded below minFillAmount is not listed");

        // Top up to exactly minFillAmount ⇒ a valid fill now exists ⇒ listed.
        _fund(mockERC20, mockCollateralERC20, 1);
        assertEq(_activeCount(), 1, "reaching minFillAmount lists the intent");
    }

    function test_getActiveLenderIntents_delistsOnCancelAndDepletion() public {
        _set(mockERC20, mockCollateralERC20);
        _fund(mockERC20, mockCollateralERC20, 1_000 ether);
        _set(mockCollateralERC20, mockERC20);
        _fund(mockCollateralERC20, mockERC20, 2_000 ether);
        assertEq(_activeCount(), 2, "two funded intents listed");

        // Cancel one → de-lists.
        vm.prank(user);
        LenderIntentFacet(address(diamond)).cancelLenderIntent(
            mockERC20, mockCollateralERC20
        );
        assertEq(_activeCount(), 1, "cancelled intent de-listed");

        // Withdraw the other's capital to 0 → de-lists (depleted, still active).
        vm.prank(user);
        LenderIntentFacet(address(diamond)).withdrawLenderIntentCapital(
            mockCollateralERC20, mockERC20, 2_000 ether
        );
        assertEq(_activeCount(), 0, "depleted intent de-listed");

        // Re-fund the depleted intent → re-lists.
        _fund(mockCollateralERC20, mockERC20, 500 ether);
        assertEq(_activeCount(), 1, "re-funded intent re-listed");

        // A top-up of an already-listed intent is idempotent.
        _fund(mockCollateralERC20, mockERC20, 500 ether);
        assertEq(_activeCount(), 1, "idempotent top-up keeps count at 1");
    }

    function test_getActiveLenderIntents_pagination() public {
        _set(mockERC20, mockCollateralERC20);
        _fund(mockERC20, mockCollateralERC20, 1_000 ether);
        _set(mockCollateralERC20, mockERC20);
        _fund(mockCollateralERC20, mockERC20, 1_000 ether);

        (LibMetricsTypes.LenderIntentSummary[] memory p0, uint256 total) =
            MetricsFacet(address(diamond)).getActiveLenderIntents(0, 1);
        assertEq(total, 2, "total reflects all funded-active");
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
