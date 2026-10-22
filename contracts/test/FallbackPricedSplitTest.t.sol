// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibFallback} from "../src/libraries/LibFallback.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {FallbackCustodyFacet} from "../src/facets/FallbackCustodyFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {EncumbranceMutateFacet} from "../src/facets/EncumbranceMutateFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title  FallbackPricedSplitTest
 * @notice #1281 item 027. The fallback split takes its oracle availability
 *         from the price reads, never from the size of a converted amount,
 *         and sizes the lender's slice as the collateral NEEDED to cover the
 *         lender's due (rounded up, lender first).
 *
 *         Before: a lender due whose collateral equivalent rounded down to
 *         zero read as an oracle failure, so a fully priced loan sent the
 *         whole collateral to the lender and emitted the oracle-unavailable
 *         event; and a floored slice could be worth up to one collateral unit
 *         less than the due at the very price it was sized at.
 *
 * @dev    Every expected figure is computed here from the loan's terms and
 *         the mocked prices, never read back from the split under test. The
 *         loan is scaffolded the way initiation leaves it and enters the
 *         fallback through the REAL producer (`_enterFallbackViaProducer`).
 *         Both tokens are SetupTest's 18-decimal mocks; feeds are 8-decimal.
 */
contract FallbackPricedSplitTest is SetupTest {
    uint256 internal constant LOAN = 8101;
    uint256 internal constant PRINCIPAL = 1_000 ether;
    uint256 internal constant COLLATERAL = 1_000 ether;
    /// @dev Zero-rate loan with explicit fallback terms: due = principal × 1.03,
    ///      treasury due = principal × 0.02.
    uint16 internal constant BONUS_BPS = 300;
    uint16 internal constant TREASURY_BPS = 200;
    uint256 internal constant DUE = PRINCIPAL + (PRINCIPAL * BONUS_BPS) / 10_000;
    uint256 internal constant TREASURY_DUE = (PRINCIPAL * TREASURY_BPS) / 10_000;
    uint256 internal constant PAR = 1e8;

    address internal lender_;
    address internal borrower_;

    function setUp() public {
        setupHelper();
        lender_ = makeAddr("fpsLender");
        borrower_ = makeAddr("fpsBorrower");
    }

    // ── fixtures ─────────────────────────────────────────────────────────

    function _seed() internal {
        LibVaipakam.Loan memory l;
        l.id = LOAN;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lender_;
        l.borrower = borrower_;
        l.principalAsset = mockERC20;
        l.principal = PRINCIPAL;
        l.collateralAsset = mockCollateralERC20;
        l.collateralAmount = COLLATERAL;
        l.principalLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.collateralLiquidity = LibVaipakam.LiquidityStatus.Liquid;
        l.liquidationLtvBpsAtInit = 8_500;
        l.startTime = uint64(block.timestamp);
        l.durationDays = 30;
        l.fallbackLenderBonusBpsAtInit = BONUS_BPS;
        l.fallbackTreasuryBpsAtInit = TREASURY_BPS;
        l.borrowerTokenId = LOAN * 2;
        l.lenderTokenId = LOAN * 2 + 1;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(LOAN, l);
        vm.mockCall(address(diamond), abi.encodeWithSelector(IERC721.ownerOf.selector, LOAN * 2), abi.encode(borrower_));
        vm.mockCall(address(diamond), abi.encodeWithSelector(IERC721.ownerOf.selector, LOAN * 2 + 1), abi.encode(lender_));
        address bVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower_);
        ERC20Mock(mockCollateralERC20).mint(bVault, COLLATERAL);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(borrower_, mockCollateralERC20, COLLATERAL);
        TestMutatorFacet(address(diamond)).setLoanCollateralLienRaw(
            LOAN, borrower_, mockCollateralERC20, 0, COLLATERAL, LibVaipakam.AssetType.ERC20
        );
    }

    /// @dev Enters the fallback at `collateralPrice` (principal at par) and
    ///      returns the snapshot's three slices plus whether the
    ///      oracle-unavailable event was emitted.
    function _enterAt(uint256 collateralPrice)
        internal
        returns (uint256 lc, uint256 tc, uint256 bc, bool unavailableEmitted)
    {
        _seed();
        mockOraclePrice(mockERC20, PAR, 8);
        mockOraclePrice(mockCollateralERC20, collateralPrice, 8);
        vm.recordLogs();
        _enterFallbackViaProducer(LOAN);
        unavailableEmitted = _emitted(vm.getRecordedLogs());
        uint256 due;
        (lc, tc, bc, due, , , ) = ClaimFacet(address(diamond)).getFallbackSnapshot(LOAN);
        assertEq(due, DUE, "fixture-live: the due is principal plus the 3% bonus");
    }

    function _emitted(Vm.Log[] memory logs) internal pure returns (bool) {
        bytes32 topic = FallbackCustodyFacet.LiquidationFallbackOracleUnavailable.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) return true;
        }
        return false;
    }

    // ── availability comes from the price reads ─────────────────────────

    /// @notice A priced loan whose lender due is worth less than one unit of
    ///         collateral is a fair-value split, not the oracle-unavailable
    ///         branch: the lender takes the one unit that covers the due, the
    ///         borrower keeps the rest. The pre-fix code read the zero floored
    ///         slice as an oracle failure and handed the lender all 1,000.
    function test_pricedSliceBelowOneUnit_isASplit_notOracleUnavailable() public {
        // 1 collateral token (1e18 units) at 1e30 / 1e8 = $1e22, so one unit
        // is worth $1e4 and the $1,030 due is ~0.1 unit: floor 0, ceil 1.
        uint256 price = 1e30;
        uint256 exact = (DUE * PAR) / price;
        assertEq(exact, 0, "fixture-live: the floored equivalent is zero");

        (uint256 lc, uint256 tc, uint256 bc, bool unavailable) = _enterAt(price);
        assertFalse(unavailable, "a priced split emits no oracle-unavailable event");
        assertEq(lc, 1, "the lender takes the one unit that covers the due");
        assertEq(tc, (TREASURY_DUE * PAR) / price, "the treasury slice rounds down (to zero here)");
        assertEq(bc, COLLATERAL - lc - tc, "the borrower keeps the rest");
    }

    /// @notice The lender slice rounds UP: at the entry price it is worth at
    ///         least the due, where a floored slice is worth less.
    function test_lenderSlice_roundsUp_coversTheDueAtTheEntryPrice() public {
        uint256 price = 3 * PAR; // 1030e18 / 3 is not a whole number of units
        uint256 floored = (DUE * PAR) / price;
        uint256 ceiled = Math.ceilDiv(DUE * PAR, price);
        assertEq(ceiled, floored + 1, "fixture-live: the conversion has a remainder");
        assertLt((floored * price) / PAR, DUE, "fixture-live: a floored slice falls short of the due");

        (uint256 lc, uint256 tc, uint256 bc, bool unavailable) = _enterAt(price);
        assertFalse(unavailable, "priced");
        assertEq(lc, ceiled, "the lender slice is the collateral needed, rounded up");
        assertGe((lc * price) / PAR, DUE, "and it is worth at least the due at the entry price");
        assertEq(tc, (TREASURY_DUE * PAR) / price, "the treasury slice rounds down");
        assertEq(bc, COLLATERAL - lc - tc, "the borrower takes the remainder");
    }

    /// @notice A genuinely unpriced leg still takes the full-collateral branch
    ///         and says so. The price read fails with a missing feed, and the
    ///         real `OracleFacet.getAssetPriceStatus` classifies it.
    function test_unpricedLeg_isTheFullCollateralBranch() public {
        _seed();
        mockOraclePrice(mockERC20, PAR, 8);
        _priceRevertsWith(mockCollateralERC20, OracleFacet.NoPriceFeed.selector);
        _assertFullCollateralBranch();
    }

    // ── #666: a distrusted price refuses, a missing one does not ────────

    /// @notice A leg whose price exists but which every responding secondary
    ///         oracle disagrees with is DISTRUSTED, not missing: the fallback
    ///         entry refuses (`OraclePriceDivergence`) instead of handing the
    ///         lender the whole collateral, and nothing is written.
    function test_distrustedCollateralPrice_refusesTheSplit() public {
        _seed();
        mockOraclePrice(mockERC20, PAR, 8);
        _priceRevertsWith(mockCollateralERC20, OracleFacet.OraclePriceDivergence.selector);
        _assertEntryRefused();
    }

    /// @notice The same for the principal leg.
    function test_distrustedPrincipalPrice_refusesTheSplit() public {
        _seed();
        mockOraclePrice(mockCollateralERC20, PAR, 8);
        _priceRevertsWith(mockERC20, OracleFacet.OraclePriceDivergence.selector);
        _assertEntryRefused();
    }

    /// @notice The Pyth cross-check's divergence is distrust too, and the
    ///         refusal carries that read's own error and arguments, so the
    ///         caller can see which check disagreed.
    function test_crossCheckDistrust_refusesTheSplitByItsOwnError() public {
        _seed();
        mockOraclePrice(mockERC20, PAR, 8);
        bytes memory crossCheck = abi.encodeWithSelector(
            OracleFacet.OracleCrossCheckDivergence.selector,
            uint256(2_000_00000000),
            uint256(2_500_00000000),
            uint256(2_500),
            uint256(500)
        );
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockCollateralERC20),
            crossCheck
        );
        _assertEntryRefusedWith(crossCheck);
    }

    /// @notice A leg with NO price decides the split whatever the other leg
    ///         says: the pair cannot be priced either way, so a distrusted
    ///         price on the other leg does not hold up the full-collateral
    ///         branch the missing price already calls for.
    function test_missingPriceWins_overADistrustedOtherLeg() public {
        _seed();
        _priceRevertsWith(mockERC20, OracleFacet.OraclePriceDivergence.selector);
        _priceRevertsWith(mockCollateralERC20, OracleFacet.StalePriceData.selector);
        _assertFullCollateralBranch();
    }

    /// @dev The Diamond's own `getAssetPrice(asset)` reverts with `selector`,
    ///      so the real status read (`this.getAssetPrice` through the Diamond)
    ///      sees exactly that failure.
    function _priceRevertsWith(address asset, bytes4 selector) internal {
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, asset),
            abi.encodeWithSelector(selector)
        );
    }

    function _assertFullCollateralBranch() internal {
        vm.recordLogs();
        _enterFallbackViaProducer(LOAN);
        bool unavailable = _emitted(vm.getRecordedLogs());
        (uint256 lc, uint256 tc, uint256 bc, , , , ) =
            ClaimFacet(address(diamond)).getFallbackSnapshot(LOAN);
        assertTrue(unavailable, "the oracle-unavailable event is emitted");
        assertEq(lc, COLLATERAL, "the lender takes the whole collateral");
        assertEq(tc + bc, 0, "treasury and borrower take nothing");
    }

    /// @dev Drives the producer's steps by hand so the revert can be expected
    ///      on `enterFallback` itself, then checks that the refusal left the
    ///      loan Active with no snapshot.
    function _assertEntryRefused() internal {
        _assertEntryRefusedWith(abi.encodeWithSelector(OracleFacet.OraclePriceDivergence.selector));
    }

    function _assertEntryRefusedWith(bytes memory refusal) internal {
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(LOAN);
        vm.startPrank(address(diamond));
        EncumbranceMutateFacet(address(diamond)).releaseCollateralLien(LOAN);
        VaultFactoryFacet(address(diamond)).vaultWithdrawERC20(
            l.borrower, l.collateralAsset, address(diamond), l.collateralAmount
        );
        vm.expectRevert(refusal);
        FallbackCustodyFacet(address(diamond)).enterFallback(LOAN);
        vm.stopPrank();

        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(LOAN).status),
            uint8(LibVaipakam.LoanStatus.Active),
            "the refused entry left the loan Active"
        );
        (uint256 lc, uint256 tc, uint256 bc, , , bool active, ) =
            ClaimFacet(address(diamond)).getFallbackSnapshot(LOAN);
        assertFalse(active, "no fallback snapshot was written");
        assertEq(lc + tc + bc, 0, "and no split was recorded");
    }
}

/// @dev Exposes the pure conversions of {LibFallback} to the fuzzer.
contract LibFallbackRateHarness {
    function toCollateral(uint256 num, uint256 den, uint256 x, bool up) external pure returns (uint256) {
        return LibFallback.toCollateral(
            LibFallback.Rate({num: num, den: den}), x, up ? Math.Rounding.Ceil : Math.Rounding.Floor
        );
    }

    function toPrincipal(uint256 num, uint256 den, uint256 c) external pure returns (uint256) {
        return LibFallback.toPrincipal(LibFallback.Rate({num: num, den: den}), c);
    }
}

/**
 * @title  LibFallbackRateTest
 * @notice The conversion properties the fallback split and the backstop par
 *         guard rely on (#1281): collateral sized to COVER an amount
 *         (rounded up) is worth at least that amount at the same rate, and
 *         differs from the amount's floored worth by at most one unit.
 */
contract LibFallbackRateTest is Test {
    LibFallbackRateHarness internal h;

    function setUp() public {
        h = new LibFallbackRateHarness();
    }

    function testFuzz_coverIsWorthTheAmount(uint256 num, uint256 den, uint256 amount) public view {
        // Realistic scales: a feed price up to 1e30 times decimal factors up
        // to 1e36, and amounts up to 1e30 units.
        num = bound(num, 1, 1e40);
        den = bound(den, 1, 1e40);
        amount = bound(amount, 0, 1e30);
        uint256 cover = h.toCollateral(num, den, amount, true);
        uint256 worth = h.toCollateral(num, den, amount, false);
        assertGe(h.toPrincipal(num, den, cover), amount, "the cover is worth the amount");
        assertLe(cover - worth, 1, "rounding up adds at most one unit");
    }
}
