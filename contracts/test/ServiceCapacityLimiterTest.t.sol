// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ServiceCapacityFacet} from "../src/facets/ServiceCapacityFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title #1219 (S-4) slice 2 — the capacity limiter.
/// @dev   Every bucket accrues at its OWN rate from its OWN last touch and is clamped
///        to its OWN ceiling; an unseen bucket starts empty; an unset curve is dark;
///        no implicit minimum, tested so that a tiny deposit is MEASURABLY ahead of
///        none. The spend is driven here through the Diamond-gated entry by pranking
///        the Diamond, exactly as the gated routes reach it.
contract ServiceCapacityLimiterTest is SetupTest {
    VPFIToken internal vpfi;
    address internal op;
    address internal op2;
    uint8 internal constant SOLVER = uint8(LibVaipakam.ServiceCapacityRole.Solver);
    uint8 internal constant KEEPER = uint8(LibVaipakam.ServiceCapacityRole.Keeper);
    uint256 internal constant FREE = 1e18;     // one action of free tier
    uint256 internal constant RATE = 1e16;     // 0.01 action per second -> 100 s per free action
    uint256 internal constant AT4X = 100e18;   // the deposit that buys 4x
    uint256 internal constant COST = 1e18;

    event CapacitySpent(uint8 indexed role, address indexed actor, uint256 cost, uint256 balanceAfter);
    event CapacityBucketReset(uint8 indexed role, address indexed actor, uint64 fromEpoch, uint64 toEpoch);
    event CapacityCurveSet(uint8 indexed role, uint256 freeTier, uint256 freeRatePerSec, uint256 bondAt4x, uint256 classCost, uint64 epoch);

    function setUp() public {
        setupHelper();
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl), abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)))
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        op = makeAddr("op");
        op2 = makeAddr("op2");
        vpfi.mint(op, 1_000e18);
        vpfi.mint(op2, 1_000e18);
        _f().bindServiceCapacityEscrow();
        _f().setServiceCapacityEnabled(true);
        vm.warp(1_000_000);
    }

    function _f() internal view returns (ServiceCapacityFacet) { return ServiceCapacityFacet(address(diamond)); }
    function _curve() internal { _f().setCapacityCurve(SOLVER, FREE, RATE, AT4X, COST); }
    function _spend(address actor) internal { vm.prank(address(diamond)); _f().capacitySpendInternal(SOLVER, actor, 1, false); }
    function _spendFree(address actor) internal { vm.prank(address(diamond)); _f().capacitySpendInternal(SOLVER, actor, 1, true); }
    function _expectExhausted(address actor, uint256 have) internal {
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityExhausted.selector, SOLVER, actor, COST, have));
    }
    function _deposit(address who, uint256 amount) internal {
        vm.prank(who);
        vpfi.approve(address(diamond), amount);
        vm.prank(who);
        _f().postCapacityDeposit(SOLVER, amount);
    }
    function _accrued(address actor) internal view returns (uint256 a) { (a, , , ) = _f().previewCapacity(SOLVER, actor); }

    /// @dev With no curve set the limiter is DARK: a spend is a no-op and the preview says so.
    function test_Dark_UnsetCurve_SpendIsANoOp() public {
        (, , , bool dark) = _f().previewCapacity(SOLVER, op);
        assertTrue(dark, "dark");
        _spend(op); // no revert, no charge
        assertFalse(_f().getCapacityBucket(SOLVER, op).seen, "nothing recorded");
    }

    /// @dev The curve's floors: every figure positive, the free tier at least one action; admin only; the epoch increments.
    function test_SetCurve_Floors_AndEpoch() public {
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityCurveInvalid.selector, SOLVER));
        _f().setCapacityCurve(SOLVER, 0.5e18, RATE, AT4X, COST); // free tier below one action
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityCurveInvalid.selector, SOLVER));
        _f().setCapacityCurve(SOLVER, FREE, RATE, 0, COST); // bondAt4x divides
        vm.expectEmit(true, false, false, true, address(diamond));
        emit CapacityCurveSet(SOLVER, FREE, RATE, AT4X, COST, 1);
        _curve();
        assertEq(_f().getCapacityCurve(SOLVER).epoch, 1);
        _curve();
        assertEq(_f().getCapacityCurve(SOLVER).epoch, 2, "every retune bumps the epoch");
        vm.prank(op);
        vm.expectRevert();
        _f().setCapacityCurve(SOLVER, FREE, RATE, AT4X, COST);
        vm.prank(op);
        vm.expectRevert();
        _f().capacitySpendInternal(SOLVER, op, 1, false); // Diamond-gated
    }

    /// @dev An unseen bucket starts with exactly ONE free action: the first spend
    ///      admits, the second is refused by name, and after the free rate has
    ///      accrued one action it admits again.
    function test_UnseenBucket_StartsEmpty_RefusesThenAccrues() public {
        _curve();
        vm.expectEmit(true, true, false, true, address(diamond));
        emit CapacitySpent(SOLVER, op, COST, 0);
        _spend(op); // the one free action every operator has
        _expectExhausted(op, 0);
        _spend(op);
        vm.warp(block.timestamp + 100); // 100 s x 0.01 = one action
        vm.expectEmit(true, true, false, true, address(diamond));
        emit CapacitySpent(SOLVER, op, COST, 0);
        _spend(op);
        _expectExhausted(op, 0);
        _spend(op);
    }

    /// @dev The first touch grants the FREE floor, never deposit-derived credit: a
    ///      deposit posted while the limiter was DARK (nothing settles; the bucket stays
    ///      unseen) meets the arriving curve holding bondAt4x — and gets one action, not
    ///      four. No fresh-address burst, whatever the deposit.
    function test_UnseenBucket_StartsWithOneFreeAction_NotTheDepositCeiling() public {
        vm.prank(op);
        vpfi.approve(address(diamond), AT4X);
        vm.prank(op);
        _f().postCapacityDeposit(SOLVER, AT4X); // dark: no settle, the bucket is still unseen
        _curve(); // the curve arrives with the deposit already armed
        assertEq(_accrued(op), COST, "one free action, not the 4x ceiling");
        _spend(op);
        _expectExhausted(op, 0);
        _spend(op);
    }

    /// @dev No implicit minimum, DISCRIMINATING: with the free allowance exhausted for
    ///      both, a tiny deposit admits strictly before none does — at the second at
    ///      which the zero-deposit actor is still refused.
    function test_NoImplicitMinimum_ATinyDepositIsMeasurablyAhead() public {
        _curve();
        _deposit(op2, AT4X / 100); // 1%: rate = free x 1.03
        _spend(op); // each spends its one free action: both buckets seen and empty at the same second
        _spend(op2);
        vm.warp(block.timestamp + 98); // 98 s: 0.98 free action; 1.0094 with the tiny deposit
        _expectExhausted(op, 98e16);
        _spend(op);
        vm.expectEmit(true, true, false, false, address(diamond));
        emit CapacitySpent(SOLVER, op2, COST, 0);
        _spend(op2);
    }

    /// @dev The ceiling: no deposit clamps at 1x the free tier; the deposit at bondAt4x
    ///      buys exactly 4x rate and 4x ceiling; beyond it, flat.
    function test_Ceiling_IsFourTimesTheFreeTier_AtBondAt4x_AndFlatBeyond() public {
        _curve();
        (, uint256 rate0, uint256 ceil0, ) = _f().previewCapacity(SOLVER, op);
        assertEq(rate0, RATE);
        assertEq(ceil0, FREE);
        _deposit(op2, AT4X);
        (, uint256 rate4, uint256 ceil4, ) = _f().previewCapacity(SOLVER, op2);
        assertEq(rate4, 4 * RATE);
        assertEq(ceil4, 4 * FREE);
        _deposit(op2, AT4X); // beyond: flat
        (, uint256 rate8, uint256 ceil8, ) = _f().previewCapacity(SOLVER, op2);
        assertEq(rate8, 4 * RATE, "flat beyond bondAt4x");
        assertEq(ceil8, 4 * FREE);
        vm.warp(block.timestamp + 10_000);
        assertEq(_accrued(op), COST, "unseen: the one free action, whatever the time");
    }

    /// @dev A retune RESETS every bucket at its next touch (the conservative branch):
    ///      accrued credit under the old curve is forfeited, never re-credited.
    function test_Retune_ResetsTheBucket() public {
        _curve();
        _spend(op); // the free action: seen, empty
        vm.warp(block.timestamp + 100);
        assertEq(_accrued(op), FREE, "one action accrued");
        _curve(); // epoch 2
        assertEq(_accrued(op), 0, "the preview reads a retired epoch as empty");
        vm.expectEmit(true, true, false, true, address(diamond));
        emit CapacityBucketReset(SOLVER, op, 1, 2);
        _expectExhausted(op, 0);
        _spend(op);
    }

    /// @dev A deposit change settles the bucket under the OLD capacity first; a withdrawal
    ///      then clamps the accrued credit to the smaller ceiling at the next touch.
    function test_DepositChange_SettlesThenClamps() public {
        _curve();
        _deposit(op, AT4X); // seen through the settle-on-change
        vm.warp(block.timestamp + 10_000);
        assertEq(_accrued(op), 4 * FREE, "full at the 4x ceiling");
        vm.prank(op);
        _f().withdrawCapacityDeposit(SOLVER, AT4X);
        assertEq(_accrued(op), FREE, "clamped to the 1x ceiling once the deposit left");
        _spend(op); // admits one action from the clamped balance
        _expectExhausted(op, 0);
        _spend(op);
    }

    /// @dev The free-only spend ignores the deposit (the backstop route's rule): an actor
    ///      holding bondAt4x still accrues at the free rate for it.
    function test_FreeOnly_IgnoresTheDeposit() public {
        _curve();
        _deposit(op, AT4X); // first touch: one free action
        _spendFree(op); // spent
        vm.warp(block.timestamp + 25); // 25 s: a quarter action at the free rate, one at 4x
        _expectExhausted(op, 25e16);
        _spendFree(op);
        _spend(op); // the same second, deposit-aware: admitted
    }
}
