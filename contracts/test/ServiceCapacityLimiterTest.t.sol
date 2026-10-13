// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ServiceCapacityFacet} from "../src/facets/ServiceCapacityFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibServiceCapacity} from "../src/libraries/LibServiceCapacity.sol";
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
    event CapacityFreeTierSpent(uint8 indexed role, address indexed initiator, uint256 cost, uint256 balanceAfter);
    event CapacityBucketReset(uint8 indexed role, address indexed actor, uint64 fromEpoch, uint64 toEpoch);
    event CapacityCurveSet(uint8 indexed role, uint256 freeTier, uint256 freeRatePerSec, uint256 bondAt4x, uint256 classCost, uint64 epoch);

    address internal backstopVault;

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
        _f().setArmingFeeFloor(1e15); // slice 3: posting needs a lit arming channel
        _f().setArmingFeeRate(1e16); // 1% of newly armed principal
        // The backstop vault, whose fill the free-tier route charges to its initiator (#2459 r4).
        vm.startPrank(owner);
        BackstopFacet(address(diamond)).initializeBackstopVaultImplementation();
        backstopVault = BackstopFacet(address(diamond)).provisionBackstopVault();
        vm.stopPrank();
        vm.warp(1_000_000);
    }

    function _f() internal view returns (ServiceCapacityFacet) { return ServiceCapacityFacet(address(diamond)); }
    function _curve() internal { _f().setCapacityCurve(SOLVER, FREE, RATE, AT4X, COST); }
    /// @dev A DIRECT caller's charge: the route names the caller itself (rule 1).
    function _spend(address actor) internal { vm.prank(address(diamond)); _f().capacityChargeInternal(SOLVER, actor); }
    /// @dev A FREE-TIER charge, through the real route (#2459 r4): the backstop vault's
    ///      fill with no recorded initiator, so the route names the transaction's
    ///      originator — `actor` — at the free tier (rules 3 and 4).
    ///      The vault is read BEFORE the prank: a call in the arguments would consume it.
    function _spendFree(address actor) internal {
        address vault = backstopVault;
        vm.prank(address(diamond), actor);
        _f().capacityChargeInternal(SOLVER, vault);
    }
    function _expectExhausted(address actor, uint256 have) internal {
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityExhausted.selector, SOLVER, actor, COST, have));
    }
    /// @dev Slice 3 — through the quote: the preview prices the arming fee, the approval covers
    ///      principal + fee, the live terms are read BEFORE the prank (a view would consume it).
    function _deposit(address who, uint256 amount) internal {
        (, uint256 fee, , , ) = _f().previewArming(SOLVER, who, amount);
        (, uint64 epoch, ) = _f().getServiceCapacityEscrow();
        LibServiceCapacity.ArmingBind memory b = LibServiceCapacity.ArmingBind({
            maxFee: type(uint256).max, minCapacityAfter: 0, expectedRotationEpoch: epoch, expectedCurveEpoch: _f().getCapacityCurve(SOLVER).epoch
        });
        vm.prank(who);
        vpfi.approve(address(diamond), amount + fee);
        vm.prank(who);
        _f().postCapacityDeposit(SOLVER, amount, b);
    }
    function _accrued(address actor) internal view returns (uint256 a) { (a, , , ) = _f().previewCapacity(SOLVER, actor); }

    /// @dev With no curve set the limiter is DARK: a spend is a no-op and the preview says so.
    function test_Dark_UnsetCurve_SpendIsANoOp() public {
        (, , , bool dark) = _f().previewCapacity(SOLVER, op);
        assertTrue(dark, "dark");
        _spend(op); // no revert, no charge
        assertFalse(_f().getCapacityBucket(SOLVER, op).seen, "nothing recorded");
    }

    /// @dev #2459 r2 — a curve's arithmetic never overflows: the refill rate and the
    ///      knee are bounded (one past each bound refuses), so every product the curve
    ///      forms fits — a curve set AT the bounds still previews instead of panicking.
    ///      (A refill rate near 2^200 used to be accepted and made every preview,
    ///      post and charged action for the role panic.)
    function test_SetCurve_ArithmeticBounds_AndAnExtremeCurveStillPreviews() public {
        uint256 q = type(uint128).max / 4;
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityCurveInvalid.selector, SOLVER));
        _f().setCapacityCurve(SOLVER, FREE, q + 1, AT4X, COST); // refill rate one past the bound
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityCurveInvalid.selector, SOLVER));
        _f().setCapacityCurve(SOLVER, FREE, RATE, uint256(type(uint128).max) + 1, COST); // knee one past the bound
        _f().setCapacityCurve(SOLVER, q, q, type(uint128).max, COST); // at the bounds: accepted
        (, uint256 rate, uint256 ceiling, bool dark) = _f().previewCapacity(SOLVER, makeAddr("extreme-actor"));
        assertFalse(dark, "fixture-live: the curve is lit");
        assertEq(rate, q, "a zero deposit refills at the free rate");
        assertEq(ceiling, q, "and holds the free tier");
    }

    /// @dev #2459 r1 — the resolution floor: a per-action cost or a free refill rate
    ///      under a million units would let whole-unit rounding swallow a meaningful
    ///      share of an action (armed principal buying nothing until a threshold).
    ///      Straddle by one unit on each figure; the floor itself is accepted.
    function test_SetCurve_ResolutionFloor() public {
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityCurveInvalid.selector, SOLVER));
        _f().setCapacityCurve(SOLVER, 1e6, RATE, AT4X, 1e6 - 1); // cost one unit under the floor
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityCurveInvalid.selector, SOLVER));
        _f().setCapacityCurve(SOLVER, FREE, 1e6 - 1, AT4X, COST); // refill one unit under the floor
        _f().setCapacityCurve(SOLVER, 1e6, 1e6, AT4X, 1e6); // the floor itself is accepted
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
        _f().capacityChargeInternal(SOLVER, op); // Diamond-gated
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

    /// @dev The first touch grants exactly ONE action, never deposit-derived credit. Since
    ///      slice 3 a deposit cannot be posted while the role is dark (arming is refused),
    ///      and a post settles BEFORE it raises — so every first touch happens at zero
    ///      eligible and the deposit shows only through the RATE afterwards: an actor
    ///      posting bondAt4x gets one action, not four. No fresh-address burst.
    function test_UnseenBucket_StartsWithOneFreeAction_NotTheDepositCeiling() public {
        _curve();
        _deposit(op, AT4X); // the deposit's settle is the first touch, at zero eligible
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
        _spend(op); // the same second, the BONDED bucket (its own, never the free tier's): admitted
    }

    // ─── PR 1 pre-open review ───

    /// @dev P1 — a retune never locks a SEEN actor out. The refused spend at the retune instant
    ///      rolls back, and the bucket re-earns under the new curve from the moment it was set:
    ///      a second short of one action's refill it is still refused (straddle), at it the spend
    ///      goes through.
    function test_Retune_ASeenActorReearns_NeverLockedOut() public {
        _curve();
        _spend(op); // seen, empty
        vm.warp(block.timestamp + 1_000);
        _curve(); // epoch 2, set now
        _expectExhausted(op, 0);
        _spend(op);
        vm.warp(block.timestamp + 99);
        assertEq(_accrued(op), 99 * RATE, "re-earning under the new curve since it was set");
        _expectExhausted(op, 99 * RATE);
        _spend(op);
        vm.warp(block.timestamp + 1);
        assertEq(_accrued(op), COST, "one action's refill after the retune");
        _spend(op); // admitted: never locked out
        assertEq(_accrued(op), 0);
    }

    /// @dev Rule 3 — the backstop/unbound FREE-TIER bucket is its own: a bonded operator's stored
    ///      credit above the free tier survives a free-tier charge, which is never clamped onto it.
    function test_FreeTier_IsItsOwnBucket_NeverReclampsTheBonded() public {
        _curve();
        _deposit(op, AT4X); // bonded: 4x rate and ceiling
        vm.warp(block.timestamp + 10_000);
        assertEq(_accrued(op), 4 * FREE, "fixture-live: the bonded bucket holds its 4x ceiling");
        vm.expectEmit(true, true, false, true, address(diamond));
        emit CapacityFreeTierSpent(SOLVER, op, COST, 0);
        _spendFree(op); // the free tier's one action, first touch
        assertEq(_accrued(op), 4 * FREE, "the bonded credit is untouched");
        (uint256 free, , uint256 freeCeil, ) = _f().previewFreeTierCapacity(SOLVER, op);
        assertEq(free, 0, "the free-tier bucket spent its one action");
        assertEq(freeCeil, FREE, "at the free tier, deposit ignored");
    }

    /// @dev The curve's free tier must leave the 4x ceiling inside a bucket's balance.
    function test_SetCurve_RefusesAFreeTierTheBucketCannotHold() public {
        uint256 bound = uint256(type(uint128).max) / 4;
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityCurveInvalid.selector, SOLVER));
        _f().setCapacityCurve(SOLVER, bound + 1, RATE, AT4X, COST);
        _f().setCapacityCurve(SOLVER, bound, RATE, AT4X, COST); // straddle: the bound itself is accepted
    }

    /// @dev Only a registered adapter is bound to an operator; the spend is the Diamond's own
    ///      self-call, refused by its own name otherwise.
    function test_AdapterBinding_AndTheSpendGate_RefuseByName() public {
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityNotAnAdapter.selector, address(0xBEEF)));
        _f().setAdapterOperator(address(0xBEEF), op);
        _curve();
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityOnlyDiamondInternal.selector, address(this)));
        _f().capacityChargeInternal(SOLVER, op);
    }
}
