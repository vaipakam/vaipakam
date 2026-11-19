// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test, console2} from "forge-std/Test.sol";
import {SetupTest} from "../SetupTest.t.sol";
import {SaleFloorFacet} from "../../src/facets/SaleFloorFacet.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibTestPriceGuard} from "../helpers/LibTestPriceGuard.sol";

/// @dev The price surface the handler moves. The suite owns the mocks
///      because they are keyed on the Diamond's guard, which it knows.
interface ICheckpointChainPrices {
    function setCollateralPrice(uint256 price8) external;
    function breakCollateralPrice() external;
}

/**
 * @title CheckpointChainHandler
 * @notice Drives the hourly checkpoint chain the way an adversary could:
 *         moves the collateral price inside an hour, picks WHEN in each
 *         hour (if at all) the permissionless checkpoint is taken, calls it
 *         repeatedly, and makes the price unreadable at chosen moments. It
 *         records, independently of the contract, the first readable price
 *         taken in each hour.
 */
contract CheckpointChainHandler is Test {
    address public immutable diamond;
    ICheckpointChainPrices public immutable prices;
    address public immutable collateral;
    address public immutable principal;

    /// @dev The collateral price now (8 decimals); 0 while unreadable.
    uint256 public colPrice8;
    /// @dev hour => the first readable collateral price checkpointed in it.
    mapping(uint256 => uint256) public ghostCheckpoint8;
    uint256 public checkpointsTaken;
    uint256 public overwriteAttempts;

    constructor(address _diamond, ICheckpointChainPrices _prices, address _collateral, address _principal, uint256 start8) {
        diamond = _diamond;
        prices = _prices;
        collateral = _collateral;
        principal = _principal;
        colPrice8 = start8;
    }

    /// @notice Move the collateral price by up to ±10% (never below $500 or
    ///         above $2,000, so the cushion test always passes and only the
    ///         calm rule decides).
    function movePrice(uint256 bpsSeed, bool up) external {
        if (colPrice8 == 0) return;
        uint256 bps = bound(bpsSeed, 0, 1_000);
        uint256 next = up ? colPrice8 + (colPrice8 * bps) / 10_000 : colPrice8 - (colPrice8 * bps) / 10_000;
        if (next < 500e8) next = 500e8;
        if (next > 2_000e8) next = 2_000e8;
        colPrice8 = next;
        prices.setCollateralPrice(next);
    }

    /// @notice The price read fails (stale feed, guard refusal) until the
    ///         next {restorePrice}.
    function breakPrice() external {
        colPrice8 = 0;
        prices.breakCollateralPrice();
    }

    function restorePrice(uint256 priceSeed) external {
        colPrice8 = bound(priceSeed, 500e8, 2_000e8);
        prices.setCollateralPrice(colPrice8);
    }

    /// @notice Anyone checkpoints, at whatever moment the fuzzer picked.
    function checkpoint(address caller) external {
        address[] memory a = new address[](2);
        a[0] = collateral;
        a[1] = principal;
        uint256 hour = block.timestamp / 1 hours;
        if (ghostCheckpoint8[hour] != 0) overwriteAttempts++;
        vm.prank(caller);
        SaleFloorFacet(diamond).checkpointHourlyPrices(a);
        if (ghostCheckpoint8[hour] == 0 && colPrice8 != 0) {
            ghostCheckpoint8[hour] = colPrice8;
            checkpointsTaken++;
        }
    }

    /// @notice Time passes: one minute to three hours.
    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1 minutes, 3 hours));
    }
}

/**
 * @title CheckpointChainInvariant
 * @notice #3568 chain C3: the hourly checkpoint chain that feeds the
 *         forced-sale floor (#3359) and the maker price-move rule (#3358).
 *         Whatever the order of price moves, checkpoint timing, repeated
 *         checkpoint calls and unreadable prices:
 *
 *         1. a sale gets the tight tier figure only when BOTH of the last two
 *            hours carry a checkpoint and the pair now is within the calm
 *            bound of each, judged against the price first taken in that
 *            hour (an independent record, not the contract's);
 *         2. every other state reads as the full cap, never anything tighter;
 *         3. the first readable checkpoint in an hour is never replaced;
 *         4. the market half is one rule: a treasury swap and a forced sale
 *            of the same pair get the same floor whenever the cushion holds.
 */
contract CheckpointChainInvariant is SetupTest, ICheckpointChainPrices {
    uint256 internal constant START8 = 1_000e8;
    uint256 internal constant PLEDGED = 5_000 ether;
    uint256 internal constant DEBT = 1_000 ether;

    CheckpointChainHandler internal handler;

    function setUp() public {
        setupHelper();
        vm.warp(((block.timestamp / 1 hours) + 10) * 1 hours);
        mockOraclePrice(mockERC20, 1_000e8, 8);
        mockOraclePrice(mockCollateralERC20, START8, 8);
        // The deepest tier, so only the calm rule and a readable price decide.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getCloseOutLiquidityTier.selector, mockCollateralERC20),
            abi.encode(uint8(3))
        );
        handler = new CheckpointChainHandler(address(diamond), this, mockCollateralERC20, mockERC20, START8);
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](5);
        sel[0] = CheckpointChainHandler.movePrice.selector;
        sel[1] = CheckpointChainHandler.breakPrice.selector;
        sel[2] = CheckpointChainHandler.restorePrice.selector;
        sel[3] = CheckpointChainHandler.checkpoint.selector;
        sel[4] = CheckpointChainHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    // ─── Price surface for the handler ───────────────────────────────────

    function setCollateralPrice(uint256 price8) external {
        require(msg.sender == address(handler), "handler only");
        mockOraclePrice(mockCollateralERC20, price8, 8);
    }

    function breakCollateralPrice() external {
        require(msg.sender == address(handler), "handler only");
        vm.mockCallRevert(
            LibTestPriceGuard.guardOf(address(diamond)),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockCollateralERC20),
            "price unreadable"
        );
    }

    // ─── Invariants ──────────────────────────────────────────────────────

    /// @notice 1 + 2: the floor is the tight figure exactly when the
    ///         independent record says the pair is calm, otherwise the cap.
    function invariant_TightOnlyWhenCalmAgainstBothHours() public view {
        SaleFloorFacet.SaleFloor memory f =
            SaleFloorFacet(address(diamond)).saleFloorBps(mockCollateralERC20, mockERC20, PLEDGED, DEBT);
        uint256 cap = LibVaipakam.cfgMaxLiquidationSlippageBps();
        LibVaipakam.SaleFloorConfig memory c = SaleFloorFacet(address(diamond)).getSaleFloorConfig();
        uint256 tight = c.tier3Bps < cap ? c.tier3Bps : cap;

        (bool expectTight, SaleFloorFacet.FloorReason expected) = _expected(c.calmMoveBps);
        if (expectTight) {
            assertEq(uint8(f.reason), uint8(SaleFloorFacet.FloorReason.Tight), "calm pair not tight");
            assertEq(f.bps, tight, "tight floor is not the tier figure");
        } else {
            assertEq(uint8(f.reason), uint8(expected), "reason differs from the independent rule");
            assertEq(f.bps, cap, "an uncalm or unknown pair got less than the cap");
        }
        assertGe(f.bps, tight, "floor tighter than the deepest tier");
        assertLe(f.bps, cap, "floor above the cap");
    }

    /// @notice 3: the first readable checkpoint in an hour stands.
    function invariant_FirstCheckpointInTheHourStands() public view {
        uint256 hour = block.timestamp / 1 hours;
        for (uint256 back; back <= 3 && back <= hour; ++back) {
            uint256 h = hour - back;
            uint256 g = handler.ghostCheckpoint8(h);
            uint256 onChain = SaleFloorFacet(address(diamond)).getHourlyPriceCheckpoint(mockCollateralERC20, h);
            assertEq(onChain, g * 1e10, "an hour's checkpoint differs from the first price taken in it");
        }
    }

    /// @notice 4: the market half is one rule for both kinds of swap.
    function invariant_SwapAndSaleShareTheMarketRule() public view {
        SaleFloorFacet.SaleFloor memory sale =
            SaleFloorFacet(address(diamond)).saleFloorBps(mockCollateralERC20, mockERC20, PLEDGED, DEBT);
        SaleFloorFacet.SaleFloor memory swap =
            SaleFloorFacet(address(diamond)).swapFloorBps(mockCollateralERC20, mockERC20);
        assertEq(sale.bps, swap.bps, "sale and swap floors differ");
        assertEq(uint8(sale.reason), uint8(swap.reason), "sale and swap reasons differ");
    }

    function afterInvariant() public view {
        console2.log("checkpoints taken", handler.checkpointsTaken());
        console2.log("repeat calls in an hour", handler.overwriteAttempts());
    }

    // ─── The independent rule ────────────────────────────────────────────

    function _expected(uint256 calmBps) internal view returns (bool tight, SaleFloorFacet.FloorReason reason) {
        uint256 now8 = handler.colPrice8();
        if (now8 == 0) return (false, SaleFloorFacet.FloorReason.Unpriced);
        uint256 hour = block.timestamp / 1 hours;
        // Each of the last two hours in turn, newest first: a missing
        // checkpoint or a move past the bound ends the look-back (either
        // way the sale gets the cap; the reason names the first failure).
        for (uint256 back = 1; back <= 2; ++back) {
            uint256 then8 = handler.ghostCheckpoint8(hour - back);
            if (then8 == 0) return (false, SaleFloorFacet.FloorReason.NoCheckpoint);
            uint256 diff = now8 > then8 ? now8 - then8 : then8 - now8;
            uint256 moved = (diff * 10_000 + then8 - 1) / then8;
            if (moved > calmBps) return (false, SaleFloorFacet.FloorReason.Moving);
        }
        return (true, SaleFloorFacet.FloorReason.Tight);
    }
}
