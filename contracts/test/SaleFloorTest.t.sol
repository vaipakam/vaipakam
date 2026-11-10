// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ForcedSalePreviewFacet} from "../src/facets/ForcedSalePreviewFacet.sol";
import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {ForcedSaleFacet} from "../src/facets/ForcedSaleFacet.sol";
import {SaleFloorFacet} from "../src/facets/SaleFloorFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {LibTestPriceGuard} from "./helpers/LibTestPriceGuard.sol";

/**
 * @title SaleFloorTest
 * @notice #3359 — the forced-sale floor rule ({SaleFloorFacet.saleFloorBps}),
 *         its hourly checkpoints and settings, and what the forced-sale host
 *         does with it. The rule tightens a forced sale's slippage floor to
 *         the depth tier's figure (2.5% / 3.5% / 4.5%) only when the pair is
 *         calm against BOTH of the last two hourly checkpoints and the
 *         collateral covers 110% of the debt; every other case, including any
 *         missing input, is the full cap (6%).
 */
contract SaleFloorTest is SetupTest {
    uint256 internal constant LOAN = 1;
    uint256 internal constant ADAPTER_IDX = 1; // index 0 is SetupTest's legacy shim
    uint256 internal constant PLEDGED = 5000 ether;
    uint256 internal constant PRINCIPAL = 1000 ether;

    MockSwapAdapter internal adapter;
    address internal keeper = makeAddr("sale-floor-keeper");

    function setUp() public {
        setupHelper();
        // Start on an hour boundary so the checkpoint hours are exact.
        vm.warp(((block.timestamp / 1 hours) + 10) * 1 hours);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        _colPrice(1_000 * 1e8);

        adapter = new MockSwapAdapter("floor");
        ERC20Mock(mockERC20).mint(address(adapter), 1_000_000 ether);
        AdminFacet(address(diamond)).addSwapAdapter(address(adapter));
        adapter.setTokenPrice(mockERC20, 1_000 * 1e8);
        _createLoan();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _createLoan() internal {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: PLEDGED,
                durationDays: 90,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: true,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: 500,
                collateralAmountMax: PLEDGED,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            }),
            type(uint64).max
        );
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    function _colPrice(uint256 price8) internal {
        mockOraclePrice(mockCollateralERC20, price8, 8);
        if (address(adapter) != address(0)) adapter.setTokenPrice(mockCollateralERC20, price8);
    }

    function _tier(uint8 t) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getCloseOutLiquidityTier.selector, mockCollateralERC20),
            abi.encode(t)
        );
    }

    function _assets() internal view returns (address[] memory a) {
        a = new address[](2);
        a[0] = mockCollateralERC20;
        a[1] = mockERC20;
    }

    /// @dev Checkpoint both legs at the current prices in each of the two
    ///      hours before the one this leaves the clock in.
    function _twoCheckpoints() internal {
        SaleFloorFacet(address(diamond)).checkpointHourlyPrices(_assets());
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        SaleFloorFacet(address(diamond)).checkpointHourlyPrices(_assets());
        vm.warp(vm.getBlockTimestamp() + 1 hours);
    }

    function _floor(uint256 collateral, uint256 debt) internal view returns (SaleFloorFacet.SaleFloor memory) {
        return SaleFloorFacet(address(diamond)).saleFloorBps(mockCollateralERC20, mockERC20, collateral, debt);
    }

    /// @dev The ordinary calm, deep, well-cushioned case: 5,000 units at
    ///      $1,000 against a 1,000-unit debt at $1,000 is a 500% cover.
    function _floorNow() internal view returns (SaleFloorFacet.SaleFloor memory) {
        return _floor(PLEDGED, PRINCIPAL);
    }

    // ─── The rule ─────────────────────────────────────────────────────────

    function test_tightFiguresByTier() public {
        _twoCheckpoints();
        _tier(3);
        SaleFloorFacet.SaleFloor memory f = _floorNow();
        assertEq(f.bps, 250);
        assertEq(uint8(f.reason), uint8(SaleFloorFacet.FloorReason.Tight));
        _tier(2);
        assertEq(_floorNow().bps, 350);
        _tier(1);
        assertEq(_floorNow().bps, 450);
    }

    function test_shallowCollateralGetsTheCap() public {
        _twoCheckpoints();
        _tier(0);
        SaleFloorFacet.SaleFloor memory f = _floorNow();
        assertEq(f.bps, 600);
        assertEq(uint8(f.reason), uint8(SaleFloorFacet.FloorReason.Shallow));
    }

    function test_noCheckpointsGetsTheCap() public {
        _tier(3);
        SaleFloorFacet.SaleFloor memory f = _floorNow();
        assertEq(f.bps, 600);
        assertEq(uint8(f.reason), uint8(SaleFloorFacet.FloorReason.NoCheckpoint));
    }

    /// @dev One checkpoint is not enough: the look-back must reach a full
    ///      hour, so the hour before the last one must be recorded too.
    function test_onlyTheLastHourCheckpointedGetsTheCap() public {
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        SaleFloorFacet(address(diamond)).checkpointHourlyPrices(_assets());
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _tier(3);
        assertEq(uint8(_floorNow().reason), uint8(SaleFloorFacet.FloorReason.NoCheckpoint));
        assertEq(_floorNow().bps, 600);
    }

    function test_aMoveOverTheBoundGetsTheCap() public {
        _twoCheckpoints();
        _tier(3);
        _colPrice(979 * 1e8); // -2.1%
        SaleFloorFacet.SaleFloor memory f = _floorNow();
        assertEq(f.bps, 600);
        assertEq(uint8(f.reason), uint8(SaleFloorFacet.FloorReason.Moving));
    }

    function test_aMoveInsideTheBoundStaysTight() public {
        _twoCheckpoints();
        _tier(3);
        _colPrice(981 * 1e8); // -1.9%
        assertEq(_floorNow().bps, 250);
        _colPrice(1_019 * 1e8); // +1.9%
        assertEq(_floorNow().bps, 250);
    }

    /// @dev The test is on the PAIR's rate: the principal moving counts.
    function test_aPrincipalMoveCounts() public {
        _twoCheckpoints();
        _tier(3);
        mockOraclePrice(mockERC20, 1_030 * 1e8, 8);
        assertEq(uint8(_floorNow().reason), uint8(SaleFloorFacet.FloorReason.Moving));
        // Both legs moving together leave the rate where it was.
        _colPrice(1_030 * 1e8);
        assertEq(_floorNow().bps, 250);
    }

    /// @dev A move against the OLDER checkpoint alone still counts, so a
    ///      checkpoint taken just after a fall cannot hide it.
    function test_aMoveAgainstTheOlderCheckpointCounts() public {
        SaleFloorFacet(address(diamond)).checkpointHourlyPrices(_assets());
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _colPrice(950 * 1e8);
        SaleFloorFacet(address(diamond)).checkpointHourlyPrices(_assets());
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _tier(3);
        assertEq(uint8(_floorNow().reason), uint8(SaleFloorFacet.FloorReason.Moving));
    }

    function test_aThinCushionGetsTheCap() public {
        _twoCheckpoints();
        _tier(3);
        // 1,090 units at $1,000 against a 1,000-unit debt: 109% cover.
        SaleFloorFacet.SaleFloor memory f = _floor(1_090 ether, PRINCIPAL);
        assertEq(f.bps, 600);
        assertEq(uint8(f.reason), uint8(SaleFloorFacet.FloorReason.ThinCushion));
        assertEq(_floor(1_100 ether, PRINCIPAL).bps, 250, "110% is enough");
        assertEq(uint8(_floor(1, 0).reason), uint8(SaleFloorFacet.FloorReason.ThinCushion), "no debt");
    }

    function test_anUnreadablePriceGetsTheCap() public {
        _twoCheckpoints();
        _tier(3);
        vm.mockCallRevert(
            LibTestPriceGuard.guardOf(address(diamond)),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockCollateralERC20),
            "stale"
        );
        SaleFloorFacet.SaleFloor memory f = _floorNow();
        assertEq(f.bps, 600);
        assertEq(uint8(f.reason), uint8(SaleFloorFacet.FloorReason.Unpriced));
    }

    /// @dev A tier figure above a later-lowered cap reads as the cap.
    function test_neverAboveTheCap() public {
        _twoCheckpoints();
        _tier(1);
        ConfigFacet(address(diamond)).setLiquidationConfig(0, 300, 0);
        assertEq(_floorNow().bps, 300);
    }

    // ─── Checkpoints ──────────────────────────────────────────────────────

    function test_checkpointFirstCallerInTheHourWins() public {
        uint256 hour = block.timestamp / 1 hours;
        SaleFloorFacet(address(diamond)).checkpointHourlyPrices(_assets());
        assertEq(SaleFloorFacet(address(diamond)).getHourlyPriceCheckpoint(mockCollateralERC20, hour), 1_000e18);
        _colPrice(2_000 * 1e8);
        SaleFloorFacet(address(diamond)).checkpointHourlyPrices(_assets());
        assertEq(
            SaleFloorFacet(address(diamond)).getHourlyPriceCheckpoint(mockCollateralERC20, hour),
            1_000e18,
            "a later call in the hour changes nothing"
        );
    }

    function test_checkpointSkipsAnUnreadablePrice() public {
        uint256 hour = block.timestamp / 1 hours;
        vm.mockCallRevert(
            LibTestPriceGuard.guardOf(address(diamond)),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockCollateralERC20),
            "stale"
        );
        SaleFloorFacet(address(diamond)).checkpointHourlyPrices(_assets());
        assertEq(SaleFloorFacet(address(diamond)).getHourlyPriceCheckpoint(mockCollateralERC20, hour), 0);
        assertEq(SaleFloorFacet(address(diamond)).getHourlyPriceCheckpoint(mockERC20, hour), 1_000e18);
    }

    // ─── Settings ─────────────────────────────────────────────────────────

    function test_settingsDefaultsAndReset() public {
        LibVaipakam.SaleFloorConfig memory c = SaleFloorFacet(address(diamond)).getSaleFloorConfig();
        assertEq(c.tier1Bps, 450);
        assertEq(c.tier2Bps, 350);
        assertEq(c.tier3Bps, 250);
        assertEq(c.calmMoveBps, 200);
        assertEq(c.cushionBps, 11_000);
        SaleFloorFacet(address(diamond)).setSaleFloorConfig(500, 400, 300, 300, 12_000);
        c = SaleFloorFacet(address(diamond)).getSaleFloorConfig();
        assertEq(c.tier3Bps, 300);
        SaleFloorFacet(address(diamond)).setSaleFloorConfig(0, 0, 0, 0, 0);
        assertEq(SaleFloorFacet(address(diamond)).getSaleFloorConfig().tier3Bps, 250);
    }

    function test_settingsBounds() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector, bytes32("saleFloorTier1Bps"), 700, 100, 600
            )
        );
        SaleFloorFacet(address(diamond)).setSaleFloorConfig(700, 0, 0, 0, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector, bytes32("saleFloorCushionBps"), 10_000, 10_500, 20_000
            )
        );
        SaleFloorFacet(address(diamond)).setSaleFloorConfig(0, 0, 0, 0, 10_000);
        // A deeper tier may never be looser than a shallower one.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector, bytes32("saleFloorTierOrder"), 500, 0, 450
            )
        );
        SaleFloorFacet(address(diamond)).setSaleFloorConfig(0, 0, 500, 0, 0);
    }

    function test_settingsAreAdminOnly() public {
        vm.prank(borrower);
        vm.expectRevert();
        SaleFloorFacet(address(diamond)).setSaleFloorConfig(400, 300, 200, 0, 0);
    }

    // ─── The forced-sale host ─────────────────────────────────────────────

    /// @dev The preview states the floor, and sizes the sale and its minimum
    ///      output from it: a tight floor sells less collateral for the same
    ///      need.
    function test_previewCarriesTheFloor() public {
        _liquidatable();
        ForcedSaleFacet.ForcedSalePlan memory loose =
            ForcedSalePreviewFacet(address(diamond)).previewForcedSale(LOAN, ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation);
        assertEq(loose.floorBps, 600, "no checkpoints: the cap");

        _twoCheckpoints();
        _tier(3);
        ForcedSaleFacet.ForcedSalePlan memory tight =
            ForcedSalePreviewFacet(address(diamond)).previewForcedSale(LOAN, ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation);
        assertEq(tight.floorBps, 250);
        assertLt(tight.sell, loose.sell, "a tighter floor needs less collateral sold");
        assertGe(tight.floor, tight.need, "still covers the need");
    }

    function _liquidatable() internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, LOAN),
            abi.encode(uint256(0.9e18))
        );
    }

    function _liquidateAtLoss(uint256 outputBps) internal {
        adapter.setOutputMultiplierBps(outputBps);
        ForcedSaleFacet.ForcedSalePlan memory p =
            ForcedSalePreviewFacet(address(diamond)).previewForcedSale(LOAN, ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation);
        LibSwap.AdapterCall[] memory calls = new LibSwap.AdapterCall[](1);
        calls[0] = LibSwap.AdapterCall({adapterIdx: ADAPTER_IDX, data: ""});
        vm.prank(keeper);
        RiskFacet(address(diamond)).triggerLiquidation(LOAN, p.sell, calls);
    }

    function _status() internal view returns (LibVaipakam.LoanStatus) {
        return LoanFacet(address(diamond)).getLoanDetails(LOAN).status;
    }

    /// @dev Under the tight floor, a route that loses 3% fails its minimum
    ///      output, so the sale takes the in-kind fallback instead of
    ///      selling at that loss.
    function test_tightFloorRefusesARouteThatLosesMore() public {
        _liquidatable();
        _twoCheckpoints();
        _tier(3);
        _liquidateAtLoss(9_700);
        assertEq(uint256(_status()), uint256(LibVaipakam.LoanStatus.FallbackPending), "no sale at a 3% loss");
    }

    /// @dev Without the checkpoints the cap applies, and the same 3% loss fills.
    function test_capFloorFillsTheSameRoute() public {
        _liquidatable();
        _tier(3);
        _liquidateAtLoss(9_700);
        assertTrue(_status() != LibVaipakam.LoanStatus.FallbackPending, "sold under the cap");
        assertTrue(_status() != LibVaipakam.LoanStatus.Active, "the liquidation closed the loan");
    }

    /// @dev A tight-floor sale that loses less than its floor fills.
    function test_tightFloorFillsARouteInsideIt() public {
        _liquidatable();
        _twoCheckpoints();
        _tier(3);
        _liquidateAtLoss(9_800);
        assertTrue(_status() != LibVaipakam.LoanStatus.FallbackPending, "sold inside the floor");
    }
}
