// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

// Numeraire generalization (b1) — INumeraireOracle interface and its mocks were
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
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);
    }

    /// @dev Price BOTH legs at $1000. Tests that push the principal above the
    ///      finer-cadence threshold historically repriced only the lending leg
    ///      ($1000) while the collateral stayed at $1, which now trips the
    ///      #998 S15 admission floor (collateral >= ~1.765x lending value on
    ///      liquid ERC-20 both-legs offers) — the base 10x collateral is only
    ///      10x in *tokens*, i.e. ~0.01x in value at a 1000:1 price gap.
    ///      Pricing the collateral equal to lending keeps the base 10x
    ///      collateral comfortably above the floor while leaving the principal
    ///      numeraire (the cadence-threshold input) unchanged.
    function _priceBothLegs1000() internal {
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1_000 * 1e8, 8);
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
            creatorRiskAndTermsConsent: true,
            prepayAsset: mockERC20,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: amount,
            interestRateBpsMax: 500,
            collateralAmountMax: 10 * amount,
            periodicInterestCadence: cadence,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });
    }

    function _create(
        LibVaipakam.CreateOfferParams memory p
    ) internal returns (uint256) {
        vm.prank(lender);
        return OfferCreateFacet(address(diamond)).createOffer(p);
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
            NumeraireConfigFacet(address(diamond)).getPeriodicInterestConfig();
        assertFalse(periodicEnabled, "default off");

        _enableFeature();
        (, , , periodicEnabled, ) =
            NumeraireConfigFacet(address(diamond)).getPeriodicInterestConfig();
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
        _priceBothLegs1000(); // $1000 per token, both legs (#998 S15 floor)
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
        _priceBothLegs1000();
        _create(_baseLenderParams(1000 ether, 60, MONTHLY));
    }

    function testFilter2Row2_AboveThreshold_QuarterlyAllowedOn180d() public {
        _enableFeature();
        _priceBothLegs1000();
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
        _priceBothLegs1000();
        _create(_baseLenderParams(1000 ether, 730, MONTHLY));
    }

    function testFilter2Row4_MultiYear_AboveThreshold_AnnualAllowed() public {
        _enableFeature();
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
        _priceBothLegs1000();
        _create(_baseLenderParams(1000 ether, 730, ANNUAL));
    }

    // ─── Loan struct snapshot (§2.1) ─────────────────────────────────────────

    function testCadenceSnapshottedOntoLoan() public {
        _enableFeature();
        _priceBothLegs1000();
        uint256 offerId = _create(_baseLenderParams(1000 ether, 60, MONTHLY));
        uint256 startTs = block.timestamp;
        _signAndAcceptOffer(borrower, borrowerPk, offerId);

        LibVaipakam.Loan memory l =
            LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(uint8(l.periodicInterestCadence), uint8(MONTHLY));
        assertEq(l.lastPeriodicInterestSettledAt, SafeCast.toUint64(startTs));
        assertEq(l.interestPaidSinceLastPeriod, 0);
        // startTime downsize sanity — should equal block.timestamp at init.
        assertEq(uint256(l.startTime), startTs);
    }

    function testNoneCadence_LoanSnapshotIsNone() public {
        uint256 offerId = _create(_baseLenderParams(1000 ether, 30, NONE_C));
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
        LibVaipakam.Loan memory l =
            LoanFacet(address(diamond)).getLoanDetails(1);
        assertEq(uint8(l.periodicInterestCadence), uint8(NONE_C));
    }

    // ─── Setters (§5.1, §6, §10) ─────────────────────────────────────────────

    function testSetPreNotifyDays_DefaultThenSet() public {
        (, , uint8 preNotify, ,) =
            NumeraireConfigFacet(address(diamond)).getPeriodicInterestConfig();
        assertEq(preNotify, LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_DEFAULT);

        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPreNotifyDays(7);
        (, , preNotify, ,) =
            NumeraireConfigFacet(address(diamond)).getPeriodicInterestConfig();
        assertEq(preNotify, 7);
    }

    function testSetPreNotifyDays_BelowFloorReverts() public {
        // Floor is 1; pass an out-of-range value (15) above the ceiling (14).
        vm.expectPartialRevert(IVaipakamErrors.ParameterOutOfRange.selector);
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPreNotifyDays(15);
    }

    function testSetPreNotifyDays_ZeroResetsToDefault() public {
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPreNotifyDays(7);
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPreNotifyDays(0);
        (, , uint8 preNotify, ,) =
            NumeraireConfigFacet(address(diamond)).getPeriodicInterestConfig();
        assertEq(preNotify, LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_DEFAULT);
    }

    function testSetMinPrincipalForFinerCadence_AboveCeilReverts() public {
        // Ceiling is 10M*1e18; pass 10M*1e18 + 1.
        vm.expectPartialRevert(IVaipakamErrors.ParameterOutOfRange.selector);
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setMinPrincipalForFinerCadence(
            LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL + 1
        );
    }

    function testSetMinPrincipalForFinerCadence_BelowFloorReverts() public {
        vm.expectPartialRevert(IVaipakamErrors.ParameterOutOfRange.selector);
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setMinPrincipalForFinerCadence(
            LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR - 1
        );
    }

    function testSetMinPrincipalForFinerCadence_InRange() public {
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setMinPrincipalForFinerCadence(50_000 * 1e18);
        (, uint256 threshold, , ,) =
            NumeraireConfigFacet(address(diamond)).getPeriodicInterestConfig();
        assertEq(threshold, 50_000 * 1e18);
    }

    function testSetNumeraire_DisabledFlagReverts() public {
        // Default: numeraireSwapEnabled = false. setNumeraire reverts.
        // Args don't matter past the gate check.
        address fakeFeed = makeAddr("fakeFeed");
        address fakeDenom = makeAddr("fakeDenom");
        vm.expectRevert(IVaipakamErrors.NumeraireSwapDisabled.selector);
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setNumeraire(
            // forge-lint: disable-next-line(unsafe-typecast)
            fakeFeed, fakeDenom, bytes32("eur"), bytes32(0), 50_000 * 1e18, 0, 0
        );
    }

    function testSetNumeraire_RejectsZeroEthFeed() public {
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setNumeraireSwapEnabled(true);
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setNumeraire(
            // forge-lint: disable-next-line(unsafe-typecast)
            address(0), makeAddr("denom"), bytes32("eur"), bytes32(0), 0, 0, 0
        );
    }

    function testSetNumeraire_RejectsZeroDenominator() public {
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setNumeraireSwapEnabled(true);
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setNumeraire(
            // forge-lint: disable-next-line(unsafe-typecast)
            makeAddr("ethFeed"), address(0), bytes32("eur"), bytes32(0), 0, 0, 0
        );
    }

    function testSetNumeraire_RejectsZeroSymbol() public {
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setNumeraireSwapEnabled(true);
        vm.expectPartialRevert(IVaipakamErrors.ParameterOutOfRange.selector);
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setNumeraire(
            makeAddr("ethFeed"), makeAddr("denom"), bytes32(0), bytes32(0), 0, 0, 0
        );
    }

    function testSetNumeraire_AcceptsValidEurRotation() public {
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setNumeraireSwapEnabled(true);
        // Hypothetical EUR rotation: ETH/EUR Chainlink feed +
        // Chainlink Feed Registry's Denominations.EUR constant +
        // bytes32("eur") for symbol-derived secondary queries +
        // Pyth ETH/EUR feed id. None of these need to actually exist
        // on the test chain — the setter only validates structure.
        address ethEurFeed = makeAddr("ethEurFeed");
        address eurDenom = makeAddr("eurDenom");
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 eurSymbol = bytes32("eur");
        bytes32 pythEurFeedId = bytes32(uint256(0xCAFEBABE));
        uint256 thresholdInEur = 5_000 * 1e18;
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setNumeraire(
            ethEurFeed, eurDenom, eurSymbol, pythEurFeedId,
            thresholdInEur, 0, 0
        );
        (bytes32 sym, uint256 threshold, , ,) =
            NumeraireConfigFacet(address(diamond)).getPeriodicInterestConfig();
        assertEq(sym, eurSymbol);
        assertEq(threshold, thresholdInEur);
        assertEq(NumeraireConfigFacet(address(diamond)).getEthNumeraireFeed(), ethEurFeed);
    }

    function testNonAdmin_SetterReverts() public {
        // Sanity: setters are ADMIN_ROLE-gated. Non-admin reverts.
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);

        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        NumeraireConfigFacet(address(diamond)).setPreNotifyDays(5);
    }

    // ─── #3009 — the multi-year floor binds only when periodic interest can run ──

    function _allowTwoYears() internal {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
    }

    /// @dev Switch off: `Annual` is refused too, so a floor would leave a
    ///      multi-year loan no cadence at all. `None` is admitted.
    function testMultiYear_FeatureOff_NoneAdmitted() public {
        _allowTwoYears();
        _create(_baseLenderParams(1000 ether, 730, NONE_C));
        vm.expectRevert(IVaipakamErrors.PeriodicInterestDisabled.selector);
        _create(_baseLenderParams(1000 ether, 730, ANNUAL));
    }

    /// @dev An illiquid leg may only carry `None`, so the floor cannot bind it.
    function testMultiYear_IlliquidCollateral_NoneAdmitted() public {
        _enableFeature();
        _allowTwoYears();
        LibVaipakam.CreateOfferParams memory p = _baseLenderParams(1000 ether, 730, NONE_C);
        p.collateralAsset = mockIlliquidERC20;
        _create(p);
        p.periodicInterestCadence = ANNUAL;
        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowedForIlliquid.selector);
        _create(p);
    }

    /// @dev Mutation re-admits by the same rule: a multi-year `None` offer the
    ///      floor does not bind keeps its amount changes.
    function testMultiYear_FeatureOff_NoneOfferAmountMutable() public {
        _allowTwoYears();
        uint256 offerId = _create(_baseLenderParams(1000 ether, 730, NONE_C));
        vm.prank(lender);
        OfferMutateFacet(address(diamond)).setOfferAmount(offerId, 900 ether, 1000 ether);
    }

    /// @dev Mutation reads the whole rule: with the switch turned off after
    ///      creation, a finer cadence is refused on an amount change exactly as
    ///      creation would refuse it.
    function testMutate_FeatureTurnedOff_FinerCadenceRefused() public {
        _enableFeature();
        _priceBothLegs1000();
        uint256 offerId = _create(_baseLenderParams(1000 ether, 180, MONTHLY));
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(false);
        vm.prank(lender);
        vm.expectRevert(IVaipakamErrors.PeriodicInterestDisabled.selector);
        OfferMutateFacet(address(diamond)).setOfferAmount(offerId, 900 ether, 1000 ether);
    }

    // ─── #3025 — the rule runs again when a loan opens ───────────────────────

    /// @dev A multi-year `None` offer posted while periodic interest was off
    ///      is refused at accept once the switch is on: the `Annual` floor now
    ///      binds the loan it would open.
    function testAccept_SwitchTurnedOn_MultiYearNoneRefused() public {
        _allowTwoYears();
        uint256 offerId = _create(_baseLenderParams(1000 ether, 730, NONE_C));
        _enableFeature();
        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowed.selector);
        this.acceptAsBorrower(offerId);
    }

    /// @dev While the switch stays off, the same offer opens its loan.
    function testAccept_SwitchStillOff_MultiYearNoneOpens() public {
        _allowTwoYears();
        uint256 offerId = _create(_baseLenderParams(1000 ether, 730, NONE_C));
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(l.periodicInterestCadence), uint8(NONE_C));
        assertEq(l.durationDays, 730);
    }

    /// @dev The reverse flip: a `Monthly` offer posted while the switch was on
    ///      cannot open a loan after it is turned off.
    function testAccept_SwitchTurnedOff_FinerCadenceRefused() public {
        _enableFeature();
        _priceBothLegs1000();
        uint256 offerId = _create(_baseLenderParams(1000 ether, 60, MONTHLY));
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(false);
        vm.expectRevert(IVaipakamErrors.PeriodicInterestDisabled.selector);
        this.acceptAsBorrower(offerId);
    }

    /// @dev A leg that loses its liquidity after posting refuses the cadence
    ///      it can no longer carry (Filter 0), read in the accepting
    ///      transaction rather than from the offer's record.
    function testAccept_CollateralTurnedIlliquid_FinerCadenceRefused() public {
        _enableFeature();
        _priceBothLegs1000();
        uint256 offerId = _create(_baseLenderParams(1000 ether, 60, MONTHLY));
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Illiquid);
        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowedForIlliquid.selector);
        this.acceptAsBorrower(offerId);
    }

    /// @dev The match path opens its loan through the same point, so it is
    ///      refused by the same rule.
    function testMatch_SwitchTurnedOn_MultiYearNoneRefused() public {
        _allowTwoYears();
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        uint256 lenderOfferId = _create(_baseLenderParams(1000 ether, 730, NONE_C));
        LibVaipakam.CreateOfferParams memory b = _baseLenderParams(1000 ether, 730, NONE_C);
        b.offerType = LibVaipakam.OfferType.Borrower;
        vm.prank(borrower);
        uint256 borrowerOfferId = OfferCreateFacet(address(diamond)).createOffer(b);
        _enableFeature();
        LibOfferMatch.MatchResult memory r = OfferMatchFacet(address(diamond)).previewMatch(
            lenderOfferId, borrowerOfferId, address(this), address(this)
        );
        assertEq(uint8(r.errorCode), uint8(LibOfferMatch.MatchError.CadenceNotAdmitted));
        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowed.selector);
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);
    }

    /// @dev The accept preview reports what loan creation would refuse,
    ///      before anyone signs, and clears once the switch is back off.
    function testPreviewAccept_ReportsCadenceRefusal() public {
        _allowTwoYears();
        uint256 offerId = _create(_baseLenderParams(1000 ether, 730, NONE_C));
        OfferAcceptFacet.AcceptPreview memory pv =
            OfferPreviewFacet(address(diamond)).previewAccept(offerId, borrower);
        assertEq(uint8(pv.errorCode), uint8(OfferAcceptFacet.AcceptError.None));

        _enableFeature();
        pv = OfferPreviewFacet(address(diamond)).previewAccept(offerId, borrower);
        assertEq(uint8(pv.errorCode), uint8(OfferAcceptFacet.AcceptError.CadenceNotAdmitted));
        vm.expectPartialRevert(IVaipakamErrors.CadenceNotAllowed.selector);
        OfferPreviewFacet(address(diamond)).requireOriginationCadenceAdmitted(offerId, pv.effectivePrincipal);
    }

    /// @dev External hop so `expectRevert` lands on the accept itself rather
    ///      than on the signing helper's preparatory view calls.
    function acceptAsBorrower(uint256 offerId) external {
        require(msg.sender == address(this));
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    // ─── #3009 — the cadence-admission preview ───────────────────────────────

    function _preview(uint256 amount, uint256 duration, address collateral)
        internal
        view
        returns (OfferPreviewFacet.CadenceAdmissionPreview memory)
    {
        return OfferPreviewFacet(address(diamond)).previewCadenceAdmission(
            mockERC20, amount, LibVaipakam.AssetType.ERC20, collateral, LibVaipakam.AssetType.ERC20, duration
        );
    }

    /// @dev The preview's refusal for each cadence is the revert data creation
    ///      raises on the same terms, and an admitted cadence creates.
    function _assertPreviewMatchesCreate(uint256 amount, uint256 duration) internal {
        OfferPreviewFacet.CadenceAdmissionPreview memory pv = _preview(amount, duration, mockCollateralERC20);
        assertEq(pv.cadences.length, 5, "one verdict per cadence");
        for (uint256 i; i < pv.cadences.length; ++i) {
            assertEq(uint8(pv.cadences[i].cadence), i, "None first, in enum order");
            uint256 snap = vm.snapshotState();
            vm.prank(lender);
            try OfferCreateFacet(address(diamond)).createOffer(
                _baseLenderParams(amount, duration, pv.cadences[i].cadence)
            ) {
                assertTrue(pv.cadences[i].admitted, "create admitted what the preview refused");
            } catch (bytes memory reason) {
                assertFalse(pv.cadences[i].admitted, "the preview admitted what create refused");
                assertEq(pv.cadences[i].refusal, reason, "the refusal is create's revert data");
            }
            vm.revertToState(snap);
        }
    }

    function testPreview_FeatureOff_OnlyNone() public {
        OfferPreviewFacet.CadenceAdmissionPreview memory pv = _preview(1000 ether, 180, mockCollateralERC20);
        assertFalse(pv.periodicInterestEnabled);
        assertTrue(pv.bothLegsQualify);
        assertFalse(pv.annualFloorApplies);
        assertTrue(pv.cadences[0].admitted, "None is always open with the switch off");
        for (uint256 i = 1; i < 5; ++i) {
            assertFalse(pv.cadences[i].admitted);
            assertEq(
                pv.cadences[i].refusal, abi.encodeWithSelector(IVaipakamErrors.PeriodicInterestDisabled.selector)
            );
        }
        _assertPreviewMatchesCreate(1000 ether, 180);
    }

    function testPreview_MultiYearBelowThreshold_OnlyAnnual() public {
        _enableFeature();
        _allowTwoYears();
        OfferPreviewFacet.CadenceAdmissionPreview memory pv = _preview(1000 ether, 730, mockCollateralERC20);
        assertTrue(pv.annualFloorApplies);
        assertLt(pv.principalNumeraire, pv.threshold, "the principal sits below the threshold");
        for (uint256 i; i < 5; ++i) {
            assertEq(pv.cadences[i].admitted, i == uint256(uint8(ANNUAL)), "only Annual below the threshold");
        }
        assertEq(
            pv.cadences[0].refusal,
            abi.encodeWithSelector(
                IVaipakamErrors.CadenceNotAllowed.selector, uint8(NONE_C), 730, pv.principalNumeraire, pv.threshold
            )
        );
        _assertPreviewMatchesCreate(1000 ether, 730);
    }

    function testPreview_AboveThreshold_IntervalFilter() public {
        _enableFeature();
        _priceBothLegs1000();
        // 120 days: Monthly and Quarterly fit; SemiAnnual and Annual do not.
        OfferPreviewFacet.CadenceAdmissionPreview memory pv = _preview(1000 ether, 120, mockCollateralERC20);
        assertGe(pv.principalNumeraire, pv.threshold);
        assertTrue(pv.cadences[0].admitted && pv.cadences[1].admitted && pv.cadences[2].admitted);
        assertFalse(pv.cadences[3].admitted || pv.cadences[4].admitted);
        _assertPreviewMatchesCreate(1000 ether, 120);
    }

    function testPreview_IlliquidLeg_OnlyNoneAndNoFloor() public {
        _enableFeature();
        _allowTwoYears();
        OfferPreviewFacet.CadenceAdmissionPreview memory pv = _preview(1000 ether, 730, mockIlliquidERC20);
        assertEq(uint8(pv.collateralLiquidity), uint8(LibVaipakam.LiquidityStatus.Illiquid));
        assertFalse(pv.bothLegsQualify);
        assertFalse(pv.annualFloorApplies, "an illiquid loan has no mandatory Annual checkpoint");
        assertTrue(pv.cadences[0].admitted);
        for (uint256 i = 1; i < 5; ++i) {
            assertFalse(pv.cadences[i].admitted);
            assertEq(
                pv.cadences[i].refusal,
                abi.encodeWithSelector(
                    IVaipakamErrors.CadenceNotAllowedForIlliquid.selector,
                    uint8(pv.principalLiquidity),
                    uint8(pv.collateralLiquidity),
                    uint8(i)
                )
            );
        }
    }
}
