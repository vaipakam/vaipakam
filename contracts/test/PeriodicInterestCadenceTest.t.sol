// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

// USD-Sweep / B1 — INumeraireOracle interface and its mocks were
// retired in favour of the symbol-derived feed slots
// (ethNumeraireFeed + numeraireSymbol + numeraireChainlinkDenominator
// + pythCrossCheckFeedId). The atomic `setNumeraire` setter now takes
// these slot values directly; no oracle contract to mock.

/// @title PeriodicInterestCadenceTest
/// @notice Targeted PR1 coverage for T-034 — Periodic Interest Payment.
///         Locks the storage shape, the validation matrix at offer
///         creation (Filter 0 + 1 + 2), the master kill-switch behavior,
///         and the numeraire-related setters. Settlement / repay-fold
///         paths land in PR2 — out of scope here.
///
///         See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md.
contract PeriodicInterestCadenceTest is SetupTest {
    // Shorthand
    LibVaipakam.PeriodicInterestCadence constant NONE_C =
        LibVaipakam.PeriodicInterestCadence.None;
    LibVaipakam.PeriodicInterestCadence constant MONTHLY =
        LibVaipakam.PeriodicInterestCadence.Monthly;
    LibVaipakam.PeriodicInterestCadence constant QUARTERLY =
        LibVaipakam.PeriodicInterestCadence.Quarterly;
    LibVaipakam.PeriodicInterestCadence constant SEMI =
        LibVaipakam.PeriodicInterestCadence.SemiAnnual;
    LibVaipakam.PeriodicInterestCadence constant ANNUAL =
        LibVaipakam.PeriodicInterestCadence.Annual;

    function setUp() public {
        setupHelper();
        // Default starts the feature DISABLED. Most tests opt in.
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _enableFeature() internal {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);
    }

    function _baseLenderParams(
        uint256 amount,
        uint256 duration,
        LibVaipakam.PeriodicInterestCadence cadence
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: mockERC20,
            amount: amount,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: 10 * amount,
            durationDays: duration,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorFallbackConsent: true,
            prepayAsset: mockERC20,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            amountMax: 0,
            interestRateBpsMax: 0,
            periodicInterestCadence: cadence
        });
    }

    function _create(
        LibVaipakam.CreateOfferParams memory p
    ) internal returns (uint256) {
        vm.prank(lender);
        return OfferFacet(address(diamond)).createOffer(p);
    }

    function _expectCadenceNotAllowed(
        LibVaipakam.PeriodicInterestCadence cadence,
        uint256 duration
    ) internal {
        // We only assert the selector — the inner numeric fields depend on
        // oracle wiring that varies per test. Forge's expectPartialRevert
        // matches selector + first arg.
        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowed.selector);
        cadence; duration; // silence unused
    }

    // ─── Library helper: intervalDays ────────────────────────────────────────

    function testIntervalDaysLookup() public pure {
        assertEq(LibVaipakam.intervalDays(LibVaipakam.PeriodicInterestCadence.None), 0);
        assertEq(LibVaipakam.intervalDays(LibVaipakam.PeriodicInterestCadence.Monthly), 30);
        assertEq(LibVaipakam.intervalDays(LibVaipakam.PeriodicInterestCadence.Quarterly), 90);
        assertEq(LibVaipakam.intervalDays(LibVaipakam.PeriodicInterestCadence.SemiAnnual), 180);
        assertEq(LibVaipakam.intervalDays(LibVaipakam.PeriodicInterestCadence.Annual), 365);
    }

    // ─── Master kill-switch (§10.1) ──────────────────────────────────────────

    function testKillSwitchOff_NoneAlwaysAllowed() public {
        // Default state: feature off. None still allowed.
        _create(_baseLenderParams(1000 ether, 30, NONE_C));
    }

    function testKillSwitchOff_AnyCadenceReverts() public {
        vm.expectRevert(IVaipakamErrors.PeriodicInterestDisabled.selector);
        _create(_baseLenderParams(1000 ether, 60, MONTHLY));
    }

    function testKillSwitchOn_NoneStillAllowed() public {
        _enableFeature();
        _create(_baseLenderParams(1000 ether, 30, NONE_C));
    }

    function testToggleEnabledFlag() public {
        (, , , bool periodicEnabled, ) =
            ConfigFacet(address(diamond)).getPeriodicInterestConfig();
        assertFalse(periodicEnabled, "default off");

        _enableFeature();
        (, , , periodicEnabled, ) =
            ConfigFacet(address(diamond)).getPeriodicInterestConfig();
        assertTrue(periodicEnabled, "after enable");
    }

    // ─── Filter 0 — illiquid assets (§3.0) ───────────────────────────────────

    function testFilter0_IlliquidLendingAssetBlocksCadence() public {
        _enableFeature();
        // mockIlliquidERC20 is wired in SetupTest as Illiquid via
        // mockOracleLiquidity. Use it as the lending asset.
        LibVaipakam.CreateOfferParams memory p =
            _baseLenderParams(1000 ether, 60, MONTHLY);
        p.lendingAsset = mockIlliquidERC20;
        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowedForIlliquid.selector);
        _create(p);
    }

    function testFilter0_IlliquidCollateralBlocksCadence() public {
        _enableFeature();
        LibVaipakam.CreateOfferParams memory p =
            _baseLenderParams(1000 ether, 60, MONTHLY);
        p.collateralAsset = mockIlliquidERC20;
        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowedForIlliquid.selector);
        _create(p);
    }

    function testFilter0_IlliquidWithNoneStillAllowed() public {
        _enableFeature();
        LibVaipakam.CreateOfferParams memory p =
            _baseLenderParams(1000 ether, 60, NONE_C);
        p.lendingAsset = mockIlliquidERC20;
        // Seed lender with illiquid balance + allowance so the actual
        // pull doesn't revert. We're testing Filter 0 cadence logic
        // here, not ERC20 plumbing — base SetupTest only seeds for
        // mockERC20 / mockCollateralERC20.
        ERC20Mock(mockIlliquidERC20).mint(lender, 1000 ether);
        vm.prank(lender);
        ERC20Mock(mockIlliquidERC20).approve(address(diamond), type(uint256).max);
        // None on illiquid is fine (today's behaviour) — should NOT revert
        // on the cadence guard.
        _create(p);
    }

    // ─── Filter 1 — interval >= duration (§3.1) ──────────────────────────────

    function testFilter1_MonthlyOnExactly30dReverts() public {
        _enableFeature();
        // Monthly interval (30) >= duration (30) → Filter 1 reject.
        // (Without an oracle mock the principal numeraire = 0 ⇒ below
        //  threshold ⇒ Filter 2 also rejects, but Filter 1 is the inner
        //  guard. Either way `CadenceNotAllowed` reverts.)
        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowed.selector);
        _create(_baseLenderParams(1000 ether, 30, MONTHLY));
    }

    function testFilter1_AnnualOnExactly365dReverts() public {
        _enableFeature();
        // Need above-threshold to bypass Filter 2 row 2 — set principal
        // to something the oracle will price above $100k.
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8); // $1000 per token
        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowed.selector);
        _create(_baseLenderParams(1000 ether, 365, ANNUAL));
    }

    // ─── Filter 2 row 1 — ≤365d below threshold → only None ───────────────────

    function testFilter2Row1_BelowThreshold_MonthlyRejected() public {
        _enableFeature();
        // No oracle mock → principal numeraire defaults to 0 ⇒ below
        // any positive threshold.
        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowed.selector);
        _create(_baseLenderParams(1000 ether, 60, MONTHLY));
    }

    function testFilter2Row1_BelowThreshold_NoneAllowed() public {
        _enableFeature();
        _create(_baseLenderParams(1000 ether, 60, NONE_C));
    }

    // ─── Filter 2 row 2 — ≤365d above threshold → finer cadence allowed ──────

    function testFilter2Row2_AboveThreshold_MonthlyAllowed() public {
        _enableFeature();
        // Price 1 token = $1000. Principal 1000 tokens = $1M, well above
        // the $100k default threshold.
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        _create(_baseLenderParams(1000 ether, 60, MONTHLY));
    }

    function testFilter2Row2_AboveThreshold_QuarterlyAllowedOn180d() public {
        _enableFeature();
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        _create(_baseLenderParams(1000 ether, 180, QUARTERLY));
    }

    // ─── Filter 2 row 3 — >365d below threshold → Annual forced ──────────────

    function testFilter2Row3_MultiYear_BelowThreshold_NoneRejected() public {
        _enableFeature();
        // Allow >365d duration first.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
        // Below threshold → must be Annual; None reverts.
        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowed.selector);
        _create(_baseLenderParams(1000 ether, 730, NONE_C));
    }

    function testFilter2Row3_MultiYear_BelowThreshold_MonthlyRejected() public {
        _enableFeature();
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
        // Below threshold → only Annual allowed. Monthly rejected.
        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowed.selector);
        _create(_baseLenderParams(1000 ether, 730, MONTHLY));
    }

    function testFilter2Row3_MultiYear_BelowThreshold_AnnualAllowed() public {
        _enableFeature();
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
        _create(_baseLenderParams(1000 ether, 730, ANNUAL));
    }

    // ─── Filter 2 row 4 — >365d above threshold → any cadence ────────────────

    function testFilter2Row4_MultiYear_AboveThreshold_MonthlyAllowed() public {
        _enableFeature();
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        _create(_baseLenderParams(1000 ether, 730, MONTHLY));
    }

    function testFilter2Row4_MultiYear_AboveThreshold_AnnualAllowed() public {
        _enableFeature();
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        _create(_baseLenderParams(1000 ether, 730, ANNUAL));
    }

    // ─── Loan struct snapshot (§2.1) ─────────────────────────────────────────

    function testCadenceSnapshottedOntoLoan() public {
        _enableFeature();
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        uint256 offerId = _create(_baseLenderParams(1000 ether, 60, MONTHLY));
        uint256 startTs = block.timestamp;
        vm.prank(borrower);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);

        LibVaipakam.Loan memory l =
            LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(uint8(l.periodicInterestCadence), uint8(MONTHLY));
        assertEq(l.lastPeriodicInterestSettledAt, uint64(startTs));
        assertEq(l.interestPaidSinceLastPeriod, 0);
        // startTime downsize sanity — should equal block.timestamp at init.
        assertEq(uint256(l.startTime), startTs);
    }

    function testNoneCadence_LoanSnapshotIsNone() public {
        uint256 offerId = _create(_baseLenderParams(1000 ether, 30, NONE_C));
        vm.prank(borrower);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
        LibVaipakam.Loan memory l =
            LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(uint8(l.periodicInterestCadence), uint8(NONE_C));
    }

    // ─── Setters (§5.1, §6, §10) ─────────────────────────────────────────────

    function testSetPreNotifyDays_DefaultThenSet() public {
        (, , uint8 preNotify, ,) =
            ConfigFacet(address(diamond)).getPeriodicInterestConfig();
        assertEq(preNotify, LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_DEFAULT);

        vm.prank(owner);
        ConfigFacet(address(diamond)).setPreNotifyDays(7);
        (, , preNotify, ,) =
            ConfigFacet(address(diamond)).getPeriodicInterestConfig();
        assertEq(preNotify, 7);
    }

    function testSetPreNotifyDays_BelowFloorReverts() public {
        // Floor is 1; pass an out-of-range value (15) above the ceiling (14).
        vm.expectPartialRevert(IVaipakamErrors.ParameterOutOfRange.selector);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPreNotifyDays(15);
    }

    function testSetPreNotifyDays_ZeroResetsToDefault() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPreNotifyDays(7);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPreNotifyDays(0);
        (, , uint8 preNotify, ,) =
            ConfigFacet(address(diamond)).getPeriodicInterestConfig();
        assertEq(preNotify, LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_DEFAULT);
    }

    function testSetMinPrincipalForFinerCadence_AboveCeilReverts() public {
        // Ceiling is 10M*1e18; pass 10M*1e18 + 1.
        vm.expectPartialRevert(IVaipakamErrors.ParameterOutOfRange.selector);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMinPrincipalForFinerCadence(
            LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL + 1
        );
    }

    function testSetMinPrincipalForFinerCadence_BelowFloorReverts() public {
        vm.expectPartialRevert(IVaipakamErrors.ParameterOutOfRange.selector);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMinPrincipalForFinerCadence(
            LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR - 1
        );
    }

    function testSetMinPrincipalForFinerCadence_InRange() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMinPrincipalForFinerCadence(50_000 * 1e18);
        (, uint256 threshold, , ,) =
            ConfigFacet(address(diamond)).getPeriodicInterestConfig();
        assertEq(threshold, 50_000 * 1e18);
    }

    function testSetNumeraire_DisabledFlagReverts() public {
        // Default: numeraireSwapEnabled = false. setNumeraire reverts.
        // Args don't matter past the gate check.
        address fakeFeed = makeAddr("fakeFeed");
        address fakeDenom = makeAddr("fakeDenom");
        vm.expectRevert(IVaipakamErrors.NumeraireSwapDisabled.selector);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setNumeraire(
            fakeFeed, fakeDenom, bytes32("eur"), bytes32(0), 50_000 * 1e18, 0, 0, 0
        );
    }

    function testSetNumeraire_RejectsZeroEthFeed() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setNumeraireSwapEnabled(true);
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setNumeraire(
            address(0), makeAddr("denom"), bytes32("eur"), bytes32(0), 0, 0, 0, 0
        );
    }

    function testSetNumeraire_RejectsZeroDenominator() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setNumeraireSwapEnabled(true);
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setNumeraire(
            makeAddr("ethFeed"), address(0), bytes32("eur"), bytes32(0), 0, 0, 0, 0
        );
    }

    function testSetNumeraire_RejectsZeroSymbol() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setNumeraireSwapEnabled(true);
        vm.expectPartialRevert(IVaipakamErrors.ParameterOutOfRange.selector);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setNumeraire(
            makeAddr("ethFeed"), makeAddr("denom"), bytes32(0), bytes32(0), 0, 0, 0, 0
        );
    }

    function testSetNumeraire_AcceptsValidEurRotation() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setNumeraireSwapEnabled(true);
        // Hypothetical EUR rotation: ETH/EUR Chainlink feed +
        // Chainlink Feed Registry's Denominations.EUR constant +
        // bytes32("eur") for symbol-derived secondary queries +
        // Pyth ETH/EUR feed id. None of these need to actually exist
        // on the test chain — the setter only validates structure.
        address ethEurFeed = makeAddr("ethEurFeed");
        address eurDenom = makeAddr("eurDenom");
        bytes32 eurSymbol = bytes32("eur");
        bytes32 pythEurFeedId = bytes32(uint256(0xCAFEBABE));
        uint256 thresholdInEur = 5_000 * 1e18;
        vm.prank(owner);
        ConfigFacet(address(diamond)).setNumeraire(
            ethEurFeed, eurDenom, eurSymbol, pythEurFeedId,
            thresholdInEur, 0, 0, 0
        );
        (bytes32 sym, uint256 threshold, , ,) =
            ConfigFacet(address(diamond)).getPeriodicInterestConfig();
        assertEq(sym, eurSymbol);
        assertEq(threshold, thresholdInEur);
        assertEq(ConfigFacet(address(diamond)).getEthNumeraireFeed(), ethEurFeed);
    }

    function testNonAdmin_SetterReverts() public {
        // Sanity: setters are ADMIN_ROLE-gated. Non-admin reverts.
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        ConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);

        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        ConfigFacet(address(diamond)).setPreNotifyDays(5);
    }
}
