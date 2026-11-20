// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {LibFallbackGate} from "../src/libraries/LibFallbackGate.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ForcedSaleFacet} from "../src/facets/ForcedSaleFacet.sol";
import {ForcedSalePreviewFacet} from "../src/facets/ForcedSalePreviewFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";

/// @title FallbackGateTest
/// @notice #3538 — a terminal forced sale (HF liquidation, time-based
///         default) whose listed routes all fail moves the loan into the
///         in-kind fallback only when an earlier failed sale of the same loan
///         is at least `LibFallbackGate.MIN_SPAN` old. Before that the failed
///         sale is undone and only recorded, so one caller-built try-list
///         cannot push a loan with a working market into in-kind custody, and
///         anyone with a working route can still sell in between.
contract FallbackGateTest is SetupTest {
    uint256 internal constant LOAN = 1;
    uint256 internal constant ADAPTER_IDX = 1; // index 0 is SetupTest's legacy shim
    uint256 internal constant PLEDGED = 5000 ether;

    MockSwapAdapter internal adapter;
    address internal griefer = makeAddr("griefer");
    address internal keeper = makeAddr("honest-keeper");
    uint256 internal startTs;

    function setUp() public {
        setupHelper();
        _price(1_000 * 1e8);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);

        adapter = new MockSwapAdapter("gate");
        ERC20Mock(mockERC20).mint(address(adapter), 1_000_000 ether);
        AdminFacet(address(diamond)).addSwapAdapter(address(adapter));
        adapter.setTokenPrice(mockERC20, 1_000 * 1e8);

        _createLoan();
        startTs = uint256(LoanFacet(address(diamond)).getLoanDetails(LOAN).startTime);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _createLoan() internal {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                integrator: address(0),
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
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
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: PLEDGED,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false,
                linkKind: 0,
                linkMarginBps: 0,
                rateFarFromAverageAcknowledged: false
            }),
            type(uint64).max
        );
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    function _price(uint256 price8) internal {
        mockOraclePrice(mockCollateralERC20, price8, 8);
        if (address(adapter) != address(0)) adapter.setTokenPrice(mockCollateralERC20, price8);
    }

    /// @dev Collateral worth 1.15x the principal, and the loan liquidatable.
    function _liquidatable() internal {
        _price((11_500 * 200 * 1e8) / 10_000);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, LOAN),
            abi.encode(uint256(0.9e18))
        );
    }

    function _calls() internal pure returns (LibSwap.AdapterCall[] memory calls) {
        calls = new LibSwap.AdapterCall[](1);
        calls[0] = LibSwap.AdapterCall({adapterIdx: ADAPTER_IDX, data: ""});
    }

    function _plan(ForcedSaleFacet.ForcedSaleKind kind) internal view returns (uint256) {
        return ForcedSalePreviewFacet(address(diamond)).previewForcedSale(LOAN, kind).sell;
    }

    function _status() internal view returns (LibVaipakam.LoanStatus) {
        return LoanFacet(address(diamond)).getLoanDetails(LOAN).status;
    }

    function _vaultCollateral() internal view returns (uint256) {
        address v = VaultFactoryFacet(address(diamond)).getUserVaultAddress(borrower);
        return _owned(v, mockCollateralERC20);
    }

    function _gate() internal view returns (uint256 fails, uint256 first, uint256 opensAt) {
        return ForcedSalePreviewFacet(address(diamond)).getFallbackGate(LOAN);
    }

    /// @dev The griefer's liquidation: the adapter fails every sale.
    function _failingLiquidation() internal {
        adapter.setShouldRevert(true);
        uint256 sell = _plan(ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation);
        vm.prank(griefer);
        RiskFacet(address(diamond)).triggerLiquidation(LOAN, sell, _calls());
        adapter.setShouldRevert(false);
    }

    // ─── HF liquidation ───────────────────────────────────────────────────

    /// @dev One failing sale changes nothing but the record.
    function test_firstFailedSale_isUndoneAndRecorded() public {
        _liquidatable();
        uint256 vault0 = _vaultCollateral();
        uint256 sell = _plan(ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation);
        adapter.setShouldRevert(true);

        vm.expectEmit(true, true, true, true, address(diamond));
        emit ForcedSaleFacet.ForcedSaleFallbackDeferred(
            LOAN,
            uint8(ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation),
            1,
            block.timestamp + LibFallbackGate.MIN_SPAN,
            griefer
        );
        vm.prank(griefer);
        RiskFacet(address(diamond)).triggerLiquidation(LOAN, sell, _calls());

        assertEq(uint256(_status()), uint256(LibVaipakam.LoanStatus.Active), "the loan stays Active");
        assertEq(_vaultCollateral(), vault0, "no collateral left the borrower's vault");
        assertEq(LoanFacet(address(diamond)).getLoanDetails(LOAN).collateralAmount, PLEDGED, "collateral unchanged");
        (uint256 fails, uint256 first, uint256 opensAt) = _gate();
        assertEq(fails, 1);
        assertEq(first, block.timestamp);
        assertEq(opensAt, block.timestamp + LibFallbackGate.MIN_SPAN);
    }

    /// @dev Repeating the failure inside the span still changes nothing.
    function test_repeatedFailure_insideTheSpan_staysActive() public {
        _liquidatable();
        _failingLiquidation();
        vm.warp(block.timestamp + LibFallbackGate.MIN_SPAN - 1);
        _failingLiquidation();
        assertEq(uint256(_status()), uint256(LibVaipakam.LoanStatus.Active), "still Active");
        (uint256 fails,,) = _gate();
        assertEq(fails, 2);
    }

    /// @dev A failure at least the span after the first opens the fallback.
    function test_failureAfterTheSpan_entersTheFallback() public {
        _liquidatable();
        _failingLiquidation();
        vm.warp(block.timestamp + LibFallbackGate.MIN_SPAN);
        _failingLiquidation();
        assertEq(
            uint256(_status()), uint256(LibVaipakam.LoanStatus.FallbackPending), "the fallback opened"
        );
    }

    /// @dev Between failures, anyone with a working route sells at market.
    function test_workingRouteBetweenFailures_liquidates() public {
        _liquidatable();
        _failingLiquidation();
        vm.warp(block.timestamp + 1 minutes);
        uint256 sell = _plan(ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation);
        vm.prank(keeper);
        RiskFacet(address(diamond)).triggerLiquidation(LOAN, sell, _calls());
        assertEq(uint256(_status()), uint256(LibVaipakam.LoanStatus.Defaulted), "liquidated at market");
    }

    /// @dev A record whose last failure is stale starts again.
    function test_staleRecord_startsAgain() public {
        _liquidatable();
        _failingLiquidation();
        vm.warp(block.timestamp + LibFallbackGate.STALE_AFTER + 1);
        _price((11_500 * 200 * 1e8) / 10_000); // refresh the oracle reads
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        _failingLiquidation();
        assertEq(uint256(_status()), uint256(LibVaipakam.LoanStatus.Active), "a new record, not the old one");
        (uint256 fails, uint256 first,) = _gate();
        assertEq(fails, 1, "the new record counts one failure");
        assertEq(first, block.timestamp);
    }

    /// @dev Any other refusal of the sale reverts as before and records
    ///      nothing.
    function test_otherRefusal_revertsAndRecordsNothing() public {
        _liquidatable();
        uint256 sell = _plan(ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation);
        vm.prank(griefer);
        vm.expectRevert();
        RiskFacet(address(diamond)).triggerLiquidation(LOAN, sell / 2, _calls());
        (uint256 fails,,) = _gate();
        assertEq(fails, 0);
    }

    // ─── Time-based default ───────────────────────────────────────────────

    function test_default_failedSaleIsDeferredThenOpens() public {
        vm.warp(startTs + 90 days + LibVaipakam.gracePeriod(90) + 1);
        _price(1_000 * 1e8);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        uint256 sell = _plan(ForcedSaleFacet.ForcedSaleKind.TimeBasedDefault);
        adapter.setShouldRevert(true);

        vm.prank(griefer);
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, sell, _calls());
        assertEq(uint256(_status()), uint256(LibVaipakam.LoanStatus.Active), "deferred");

        vm.warp(block.timestamp + LibFallbackGate.MIN_SPAN);
        _price(1_000 * 1e8);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        sell = _plan(ForcedSaleFacet.ForcedSaleKind.TimeBasedDefault);
        vm.prank(griefer);
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, sell, _calls());
        assertEq(uint256(_status()), uint256(LibVaipakam.LoanStatus.FallbackPending), "opened");
    }
}
