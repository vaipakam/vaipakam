// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibPriceGuard} from "../src/libraries/LibPriceGuard.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {SaleFloorFacet} from "../src/facets/SaleFloorFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LoanClockFacet} from "../src/facets/LoanClockFacet.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";
import {LibTestPriceGuard} from "./helpers/LibTestPriceGuard.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {Vm} from "forge-std/Vm.sol";

/**
 * @title PriceReadGasBudgetTest
 * @notice #3504 — every read the Diamond makes of the price guard gives the
 *         guard exactly {LibPriceGuard.GUARD_READ_GAS}, and a reader that
 *         carries on without a price never reads "ran out of gas" as "no
 *         price": too little gas reverts {LibPriceGuard.PriceReadOutOfGas}
 *         by name, and a refusal the guard returns still reads as no price.
 *         Before #3504 the hourly checkpoint caught a starved read and
 *         skipped the asset, so a gas estimate found the limit at which the
 *         checkpoint was skipped rather than written.
 */
contract PriceReadGasBudgetTest is SetupTest {
    uint256 internal constant LOAN = 1;
    uint256 internal constant PLEDGED = 5000 ether;
    uint256 internal constant PRINCIPAL = 1000 ether;

    /// @dev Below every read's requirement (about 0.6M at the self-call),
    ///      far above what the work around the read costs.
    uint256 internal constant SHORT_GAS = 400_000;
    uint256 internal constant AMPLE_GAS = 5_000_000;

    address internal guardAddr;

    function setUp() public {
        setupHelper();
        vm.warp(((block.timestamp / 1 hours) + 10) * 1 hours);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1_000 * 1e8, 8);
        guardAddr = LibTestPriceGuard.guardOf(address(diamond));
    }

    function _assets() internal view returns (address[] memory a) {
        a = new address[](2);
        a[0] = mockCollateralERC20;
        a[1] = mockERC20;
    }

    function _checkpoint(uint256 gasLimit) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = address(diamond).call{gas: gasLimit}(
            abi.encodeCall(SaleFloorFacet.checkpointHourlyPrices, (_assets()))
        );
    }

    function _assertOutOfGas(bool ok, bytes memory ret) internal pure {
        assertFalse(ok, "the call must revert");
        assertEq(ret, abi.encodeWithSelector(LibPriceGuard.PriceReadOutOfGas.selector), "reverts by name");
    }

    function _checkpointOf(address asset) internal view returns (uint256) {
        return SaleFloorFacet(address(diamond)).getHourlyPriceCheckpoint(asset, block.timestamp / 1 hours);
    }

    // ─── The checkpoint writer (the issue's case) ───────────────────────

    function test_checkpoint_shortOfGas_revertsByName_writesNothing() public {
        (bool ok, bytes memory ret) = _checkpoint(SHORT_GAS);
        _assertOutOfGas(ok, ret);
        assertEq(_checkpointOf(mockCollateralERC20), 0);
        assertEq(_checkpointOf(mockERC20), 0);
    }

    function test_checkpoint_enoughGas_writesBoth() public {
        (bool ok,) = _checkpoint(AMPLE_GAS);
        assertTrue(ok);
        assertEq(_checkpointOf(mockCollateralERC20), 1_000e18);
        assertEq(_checkpointOf(mockERC20), 1_000e18);
    }

    /// @dev A refusal the guard returns is still "no price": the asset is
    ///      skipped and the rest of the batch is written.
    function test_checkpoint_refusedPrice_stillSkipsOnlyThatAsset() public {
        vm.mockCallRevert(
            guardAddr, abi.encodeWithSelector(IPriceGuard.getAssetPrice.selector, mockCollateralERC20), "stale"
        );
        (bool ok,) = _checkpoint(AMPLE_GAS);
        assertTrue(ok);
        assertEq(_checkpointOf(mockCollateralERC20), 0);
        assertEq(_checkpointOf(mockERC20), 1_000e18);
    }

    /// @dev The guard is given exactly the budget, whatever the caller's
    ///      gas limit, so what it answers cannot depend on that limit.
    function test_checkpoint_guardGetsExactlyTheBudget() public {
        vm.expectCall(
            guardAddr,
            0,
            uint64(LibPriceGuard.GUARD_READ_GAS),
            abi.encodeWithSelector(IPriceGuard.getAssetPrice.selector, mockCollateralERC20)
        );
        (bool ok,) = _checkpoint(AMPLE_GAS);
        assertTrue(ok);
    }

    // ─── The daily snapshot (the other batch writer) ────────────────────

    function test_dailySnapshot_shortOfGas_revertsByName() public {
        (bool ok, bytes memory ret) = address(diamond).call{gas: SHORT_GAS}(
            abi.encodeCall(OracleFacet.captureDailyPriceSnapshot, (_assets()))
        );
        _assertOutOfGas(ok, ret);
        uint32 today = uint32(block.timestamp / 1 days);
        assertEq(OracleFacet(address(diamond)).getHistoricalAssetPrice(mockERC20, today).capturedAt, 0);
    }

    function test_dailySnapshot_enoughGas_capturesBoth() public {
        (bool ok,) = address(diamond).call{gas: AMPLE_GAS}(
            abi.encodeCall(OracleFacet.captureDailyPriceSnapshot, (_assets()))
        );
        assertTrue(ok);
        uint32 today = uint32(block.timestamp / 1 days);
        assertGt(OracleFacet(address(diamond)).getHistoricalAssetPrice(mockERC20, today).capturedAt, 0);
        assertGt(OracleFacet(address(diamond)).getHistoricalAssetPrice(mockCollateralERC20, today).capturedAt, 0);
    }

    // ─── The strict and status forwards ─────────────────────────────────

    function test_strictRead_shortOfGas_revertsByName() public {
        (bool ok, bytes memory ret) = address(diamond).staticcall{gas: SHORT_GAS}(
            abi.encodeCall(OracleFacet.getAssetPrice, (mockERC20))
        );
        _assertOutOfGas(ok, ret);
    }

    function test_statusRead_shortOfGas_revertsByName_notUnavailable() public {
        (bool ok, bytes memory ret) = address(diamond).staticcall{gas: SHORT_GAS}(
            abi.encodeCall(OracleFacet.getAssetPriceStatus, (mockERC20))
        );
        _assertOutOfGas(ok, ret);
    }

    function test_statusRead_guardGetsExactlyTheBudget() public {
        vm.expectCall(
            guardAddr,
            0,
            uint64(LibPriceGuard.GUARD_READ_GAS),
            abi.encodeWithSelector(IPriceGuard.getAssetPriceStatus.selector, mockERC20)
        );
        OracleFacet(address(diamond)).getAssetPriceStatus{gas: AMPLE_GAS}(mockERC20);
    }

    function test_sequencerRead_guardGetsExactlyTheBudget() public {
        vm.expectCall(
            guardAddr, 0, uint64(LibPriceGuard.GUARD_READ_GAS), abi.encodeWithSelector(IPriceGuard.sequencerHealthy.selector)
        );
        OracleFacet(address(diamond)).sequencerHealthy{gas: AMPLE_GAS}();
    }

    // ─── The loan clock's outage read ───────────────────────────────────

    function test_outageWindow_guardGetsExactlyTheBudget() public {
        vm.expectCall(
            guardAddr,
            0,
            uint64(LibPriceGuard.GUARD_READ_GAS),
            abi.encodeWithSelector(IPriceGuard.sequencerOutageWindow.selector)
        );
        LoanClockFacet(address(diamond)).getSequencerOutageWindow{gas: AMPLE_GAS}();
    }

    /// @dev A deadline read short of gas used to read the outage as "none"
    ///      (no deadline moved); it now reverts by name.
    function test_deadlineRead_shortOfGas_revertsByName() public {
        _createLoan();
        (bool ok, bytes memory ret) = address(diamond).staticcall{gas: SHORT_GAS}(
            abi.encodeCall(LoanClockFacet.getLoanDeadlines, (LOAN))
        );
        _assertOutOfGas(ok, ret);
        (ok,) = address(diamond).staticcall{gas: AMPLE_GAS}(abi.encodeCall(LoanClockFacet.getLoanDeadlines, (LOAN)));
        assertTrue(ok);
    }

    // ─── A best-effort read of a figure built on a price ────────────────

    /// @dev Adding collateral reads the new health factor and LTV for its
    ///      event and its fallback cure, and carries on when a read is
    ///      refused. Under a limit that covers the top-up but not the read,
    ///      the read used to be skipped and the event reported a health
    ///      factor of zero; it now reverts by name and nothing is added.
    function test_addCollateral_shortForTheHealthRead_revertsByName() public {
        _createLoan();
        uint256 before = LoanFacet(address(diamond)).getLoanDetails(LOAN).collateralAmount;
        // A limit of SELF_READ_GAS covers the top-up (about 67k here) but can
        // never reach the read, which needs more than that left at its own
        // point. A fixed figure (700k) went stale when the top-up got cheaper:
        // the read is reached from about 684k on this fixture.
        vm.prank(borrower);
        (bool ok, bytes memory ret) = address(diamond).call{gas: LibPriceGuard.SELF_READ_GAS}(
            abi.encodeCall(AddCollateralFacet.addCollateral, (LOAN, 100 ether))
        );
        _assertOutOfGas(ok, ret);
        assertEq(LoanFacet(address(diamond)).getLoanDetails(LOAN).collateralAmount, before);
    }

    function test_addCollateral_enoughGas_reportsTheHealthFactor() public {
        _createLoan();
        vm.recordLogs();
        vm.prank(borrower);
        (bool ok,) = address(diamond).call{gas: AMPLE_GAS}(
            abi.encodeCall(AddCollateralFacet.addCollateral, (LOAN, 100 ether))
        );
        assertTrue(ok);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != AddCollateralFacet.CollateralAdded.selector) continue;
            (,, uint256 newHf, uint256 newLtv) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            assertGt(newHf, 0, "health factor read");
            assertGt(newLtv, 0, "LTV read");
            seen = true;
        }
        assertTrue(seen, "CollateralAdded emitted");
    }

    function _createLoan() internal {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                integrator: address(0),
                lifecycleFlex: 0,
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
}
