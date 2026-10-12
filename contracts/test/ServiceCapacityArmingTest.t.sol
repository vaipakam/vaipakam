// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {ServiceCapacityFacet} from "../src/facets/ServiceCapacityFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibServiceCapacity} from "../src/libraries/LibServiceCapacity.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";

/// @title #1219 (S-4) slice 3 — the arming fee's shape and the rotation epochs.
/// @dev   The fee is a governance-set RATE over a positive floor the code enforces, charged
///        only on the principal a post newly arms (nothing above bondAt4x, nothing on a
///        capacity-neutral raise), pulled into Diamond custody and credited to the recycle
///        bucket through its own provenance-verifying operation — never into the escrow,
///        never out of the principal. The post BINDS the terms the payer reviewed, and the
///        preview is the walk the post executes. A VPFI token rotation flips the epoch
///        atomically: the old epoch is archived in the escrow in its own asset, every curve
///        is cleared, and a new-token deposit waits until the operator has drained the old.
contract ServiceCapacityArmingTest is SetupTest {
    VPFIToken internal vpfi;
    address internal op;
    uint8 internal constant SOLVER = uint8(LibVaipakam.ServiceCapacityRole.Solver);
    uint8 internal constant KEEPER = uint8(LibVaipakam.ServiceCapacityRole.Keeper);
    uint256 internal constant FREE = 1e18;
    uint256 internal constant RATE = 1e16;
    uint256 internal constant AT4X = 100e18;
    uint256 internal constant COST = 1e18;
    uint256 internal constant FLOOR = 1e15; // 0.1% of newly armed principal
    uint256 internal constant FEE = 1e16; // 1%

    event ArmingFeeSet(uint256 rate, uint256 floor);
    event ArmingFeePaid(
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, uint256 fee, uint256 capacityGranted, uint256 ceilingAfter
    );
    event CapacityDepositEpochArchived(uint64 indexed epoch, address indexed token, address indexed newToken, address escrow, uint256 total);
    event CapacityDepositMigrated(uint8 indexed role, address indexed operator, uint64 indexed epoch, address token, uint256 amount);
    event CapacityCurveSet(uint8 indexed role, uint256 freeTier, uint256 freeRatePerSec, uint256 bondAt4x, uint256 classCost, uint64 epoch);
    event CapacityDepositParked(uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, uint256 requested, uint256 parkedRequest);
    event CapacityDepositArmed(
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, address token, uint256 armed, uint256 balance, uint256 eligibleAfter
    );

    function setUp() public {
        setupHelper();
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl), abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)))
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        op = makeAddr("operator");
        vpfi.mint(op, 1_000e18);
        _f().bindServiceCapacityEscrow();
        _f().setServiceCapacityEnabled(true);
        vm.warp(1_000_000);
    }

    function _f() internal view returns (ServiceCapacityFacet) { return ServiceCapacityFacet(address(diamond)); }
    function _bucket() internal view returns (uint256) { return ConfigFacet(address(diamond)).getRecycleBucket(); }
    function _escrow() internal view returns (address e) { (e, , ) = _f().getServiceCapacityEscrow(); }
    function _arm() internal {
        _f().setArmingFeeFloor(FLOOR);
        _f().setArmingFeeRate(FEE);
    }
    function _curve(uint8 role) internal { _f().setCapacityCurve(role, FREE, RATE, AT4X, COST); }
    function _ready() internal {
        _arm();
        _curve(SOLVER);
        _curve(KEEPER);
    }
    /// @dev The live terms, read BEFORE any prank (a view call would consume it).
    function _bind(uint8 role) internal view returns (LibServiceCapacity.ArmingBind memory b) {
        (, uint64 epoch, ) = _f().getServiceCapacityEscrow();
        b = LibServiceCapacity.ArmingBind({
            maxFee: type(uint256).max, minCapacityAfter: 0, expectedRotationEpoch: epoch, expectedCurveEpoch: _f().getCapacityCurve(role).epoch
        });
    }
    /// @dev Post through the quote: the preview prices it, the approval covers principal + fee, the post executes it.
    function _postWith(IERC20 token, uint8 role, uint256 amount) internal returns (uint8 status) {
        (, uint256 fee, , , ) = _f().previewArming(role, op, amount);
        LibServiceCapacity.ArmingBind memory b = _bind(role);
        vm.prank(op);
        token.approve(address(diamond), amount + fee); // exact, never unbounded
        vm.prank(op);
        status = _f().postCapacityDeposit(role, amount, b);
    }
    function _post(uint8 role, uint256 amount) internal returns (uint8 status) { return _postWith(IERC20(address(vpfi)), role, amount); }
    function _rotateTo(ERC20Mock next) internal {
        VPFITokenFacet(address(diamond)).setVPFIToken(address(next));
        // The rotation runbook migrates the Diamond's own recycled reserve to the
        // new asset before re-enabling (step 3 / step 5); the test stands in for
        // that migration by backing the bucket in the new asset.
        next.mint(address(diamond), 10e18);
    }
    function _expectMoved(uint8 which, uint256 bound, uint256 actual) internal {
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityTermsMoved.selector, which, bound, actual));
    }

    // ─── the fee ───

    /// @dev Arming is DARK until a positive rate AND the role's curve exist: each
    ///      alone still refuses by name; both lit, the post goes through.
    function test_Fee_Dark_PostRefused_UntilRateAndCurveSet() public {
        LibServiceCapacity.ArmingBind memory b = _bind(SOLVER);
        vm.prank(op);
        vpfi.approve(address(diamond), 20e18);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityArmingDark.selector, SOLVER));
        _f().postCapacityDeposit(SOLVER, 10e18, b); // no rate, no curve
        _arm();
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityArmingDark.selector, SOLVER));
        _f().postCapacityDeposit(SOLVER, 10e18, b); // a rate, no curve
        (uint8 refusal, , , , ) = _f().previewArming(SOLVER, op, 10e18);
        assertEq(refusal, LibServiceCapacity.POST_ARMING_DARK, "the preview names the same refusal");
        _curve(SOLVER);
        (refusal, , , , ) = _f().previewArming(SOLVER, op, 10e18);
        assertEq(refusal, LibServiceCapacity.POST_OK);
        assertEq(_post(SOLVER, 10e18), LibServiceCapacity.STATUS_OK, "lit: posts");
        (uint256 rate, uint256 floor) = _f().getArmingFee();
        assertEq(rate, FEE);
        assertEq(floor, FLOOR);
    }

    /// @dev The floors: a positive rate needs a positive floor and may not sit under
    ///      it; the floor is raise-only and may not climb over the live rate; zero
    ///      (dark) is always allowed; admin only.
    function test_Fee_Floors_AdminOnly_RaiseOnly() public {
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityArmingFeeBelowFloor.selector, FEE, 0));
        _f().setArmingFeeRate(FEE); // no floor yet
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityArmingFloorNotRaised.selector, 0, 0));
        _f().setArmingFeeFloor(0);
        vm.expectEmit(false, false, false, true, address(diamond));
        emit ArmingFeeSet(0, FLOOR);
        _f().setArmingFeeFloor(FLOOR);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityArmingFeeBelowFloor.selector, FLOOR - 1, FLOOR));
        _f().setArmingFeeRate(FLOOR - 1);
        vm.expectEmit(false, false, false, true, address(diamond));
        emit ArmingFeeSet(FEE, FLOOR);
        _f().setArmingFeeRate(FEE);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityArmingFloorNotRaised.selector, FLOOR, FLOOR));
        _f().setArmingFeeFloor(FLOOR); // not a raise
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityArmingFeeBelowFloor.selector, FEE, FEE + 1));
        _f().setArmingFeeFloor(FEE + 1); // over the live rate
        _f().setArmingFeeFloor(FEE); // may meet it
        _f().setArmingFeeRate(0); // dark again, always allowed
        (uint256 rate, uint256 floor) = _f().getArmingFee();
        assertEq(rate, 0);
        assertEq(floor, FEE);
        vm.prank(op);
        vm.expectRevert();
        _f().setArmingFeeRate(FEE);
        vm.prank(op);
        vm.expectRevert();
        _f().setArmingFeeFloor(FEE + 1);
    }

    /// @dev The fee is 1% of the principal newly armed, paid BESIDE the principal into
    ///      Diamond custody and credited to the recycle bucket; the escrow holds the
    ///      principal only; the armed balance is the principal under the knee. The event carries
    ///      the figures the preview quoted — one walk.
    function test_Fee_ChargedOnNewlyArmedPrincipal_LandsInTheBucket_NeverTheEscrow() public {
        _ready();
        address escrow = _escrow();
        uint256 bucketBefore = _bucket();
        uint256 diamondBefore = vpfi.balanceOf(address(diamond));
        (, uint256 fee, uint256 granted, , uint256 ceilingAfter) = _f().previewArming(SOLVER, op, 50e18);
        assertEq(fee, 0.5e18, "1% of the 50 newly armed");
        assertEq(granted, 50e18);
        assertEq(ceilingAfter, 2.5e18, "half way to the knee buys 2.5x");
        LibServiceCapacity.ArmingBind memory b = _bind(SOLVER);
        vm.prank(op);
        vpfi.approve(address(diamond), 50e18 + fee);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ArmingFeePaid(SOLVER, op, 0, fee, granted, ceilingAfter);
        vm.prank(op);
        assertEq(_f().postCapacityDeposit(SOLVER, 50e18, b), LibServiceCapacity.STATUS_OK);
        assertEq(vpfi.balanceOf(escrow), 50e18, "the escrow holds the principal only");
        assertEq(vpfi.balanceOf(address(diamond)), diamondBefore + fee, "the fee sits in Diamond custody");
        assertEq(_bucket(), bucketBefore + fee, "and is recycled");
        assertEq(_f().getCapacityDeposit(SOLVER, op, 0).eligibleAmount, 50e18, "armed = principal; the fee is paid beside it");
        assertEq(vpfi.balanceOf(op), 1_000e18 - 50e18 - fee);
    }

    /// @dev Only the principal that lands below bondAt4x is charged: a post straddling
    ///      the knee pays for the part below it; a raise wholly above it is accepted,
    ///      pays nothing and emits no fee event.
    function test_Fee_CapacityNeutralRaise_ChargesNothing() public {
        _ready();
        _post(SOLVER, 80e18); // fee 0.8
        (, uint256 fee, uint256 granted, , uint256 ceil) = _f().previewArming(SOLVER, op, 40e18);
        assertEq(granted, 20e18, "only the 20 below the knee are newly armed");
        assertEq(fee, 0.2e18);
        assertEq(ceil, 4 * FREE);
        _post(SOLVER, 40e18);
        uint256 bucket = _bucket();
        (, fee, granted, , ceil) = _f().previewArming(SOLVER, op, 50e18);
        assertEq(granted, 0, "nothing newly armed above bondAt4x");
        assertEq(fee, 0);
        assertEq(ceil, 4 * FREE);
        vm.recordLogs();
        assertEq(_post(SOLVER, 50e18), LibServiceCapacity.STATUS_OK, "the excess principal is accepted");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 paid = keccak256("ArmingFeePaid(uint8,address,uint64,uint256,uint256,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].topics.length == 0 || logs[i].topics[0] != paid, "no fee event when nothing is paid");
        }
        assertEq(_bucket(), bucket, "the bucket is untouched");
        assertEq(_f().getCapacityDeposit(SOLVER, op, 0).amount, 170e18);
    }

    /// @dev The post binds what the payer reviewed: the fee, the capacity after, the
    ///      rotation epoch and the curve epoch; each moved term refuses by name, naming
    ///      the bound and the standing figure; exact terms post.
    function test_Fee_Binds_RefuseOnMovedTerms() public {
        _ready();
        vm.prank(op);
        vpfi.approve(address(diamond), 60e18);
        LibServiceCapacity.ArmingBind memory b = _bind(SOLVER);
        b.maxFee = 0.5e18 - 1;
        vm.prank(op);
        _expectMoved(0, 0.5e18 - 1, 0.5e18);
        _f().postCapacityDeposit(SOLVER, 50e18, b);
        b = _bind(SOLVER);
        b.minCapacityAfter = 2.5e18 + 1;
        vm.prank(op);
        _expectMoved(1, 2.5e18 + 1, 2.5e18);
        _f().postCapacityDeposit(SOLVER, 50e18, b);
        b = _bind(SOLVER);
        b.expectedRotationEpoch = 1;
        vm.prank(op);
        _expectMoved(2, 1, 0);
        _f().postCapacityDeposit(SOLVER, 50e18, b);
        b = _bind(SOLVER); // quoted under curve epoch 1 ...
        _curve(SOLVER); // ... retuned to 2 before the post
        vm.prank(op);
        _expectMoved(3, 1, 2);
        _f().postCapacityDeposit(SOLVER, 50e18, b);
        b = _bind(SOLVER);
        b.maxFee = 0.5e18;
        b.minCapacityAfter = 2.5e18;
        vm.prank(op);
        assertEq(_f().postCapacityDeposit(SOLVER, 50e18, b), LibServiceCapacity.STATUS_OK, "exact terms post");
    }

    /// @dev Each unit of capacity is charged once per ARMING: principal withdrawn and
    ///      posted again is newly armed again and owes a new fee.
    function test_Fee_ReArmingWithdrawnCapacity_OwesANewFee() public {
        _ready();
        _post(SOLVER, 50e18);
        uint256 bucket = _bucket();
        vm.prank(op);
        _f().withdrawCapacityDeposit(SOLVER, 50e18);
        (, uint256 fee, uint256 granted, , ) = _f().previewArming(SOLVER, op, 50e18);
        assertEq(granted, 50e18, "armed again");
        assertEq(fee, 0.5e18);
        _post(SOLVER, 50e18);
        assertEq(_bucket(), bucket + 0.5e18, "paid again");
    }

    // ─── the rotation epochs ───

    /// @dev A VPFI token rotation flips the deposit epoch in the same transaction: the
    ///      old epoch is archived with its asset and total (principal stays in the
    ///      escrow), the live epoch is the next one with a zero total, every curve is
    ///      cleared (figures zero, counter kept) so the limiter and arming are dark.
    function test_Rotation_FlipsTheEpoch_ArchivesAndClearsCurves() public {
        _ready();
        _post(SOLVER, 50e18);
        address escrow = _escrow();
        ERC20Mock next = new ERC20Mock("VPFI v2", "VPFI2", 6);
        vm.expectEmit(true, false, false, true, address(diamond));
        emit CapacityCurveSet(SOLVER, 0, 0, 0, 0, 1);
        vm.expectEmit(true, false, false, true, address(diamond));
        emit CapacityCurveSet(KEEPER, 0, 0, 0, 0, 1);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit CapacityDepositEpochArchived(0, address(vpfi), address(next), escrow, 50e18);
        _rotateTo(next);
        (, uint64 live, uint256 liveTotal) = _f().getServiceCapacityEscrow();
        assertEq(live, 1, "the epoch flipped");
        assertEq(liveTotal, 0);
        assertTrue(_f().isRotationEpochArchived(0));
        assertFalse(_f().isRotationEpochArchived(1));
        (address t0, uint256 total0, bool a0) = _f().getServiceCapacityEscrowByEpoch(0);
        assertEq(t0, address(vpfi));
        assertEq(total0, 50e18);
        assertTrue(a0);
        (address t1, uint256 total1, bool a1) = _f().getServiceCapacityEscrowByEpoch(1);
        assertEq(t1, address(next));
        assertEq(total1, 0);
        assertFalse(a1);
        (address t9, , bool a9) = _f().getServiceCapacityEscrowByEpoch(9);
        assertEq(t9, address(0), "an epoch that never existed reads as zeros");
        assertFalse(a9);
        assertEq(vpfi.balanceOf(escrow), 50e18, "archived principal stays put, in its own asset");
        assertEq(_f().getCapacityCurve(SOLVER).freeTier, 0, "cleared");
        assertEq(_f().getCapacityCurve(SOLVER).epoch, 1, "the counter survives the clearing");
        (, , , bool dark) = _f().previewCapacity(SOLVER, op);
        assertTrue(dark, "the limiter is dark until re-set");
        vm.prank(address(diamond));
        _f().capacitySpendInternal(SOLVER, op, 1, false); // dark: a no-op, no revert
        LibServiceCapacity.ArmingBind memory b = _bind(SOLVER);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityArmingDark.selector, SOLVER));
        _f().postCapacityDeposit(SOLVER, 1e6, b); // arming is dark too
    }

    /// @dev After a rotation a post under the new token waits until the operator has
    ///      drained the retired epoch; the live withdraw does not see the old record;
    ///      the archived withdraw materializes it, pays the OLD asset in full and
    ///      empties the retired total; then the new-token post lands in the new epoch.
    function test_Rotation_NewDepositWaitsForTheDrain_ArchivedWithdrawPaysTheOldAsset() public {
        _ready();
        _post(SOLVER, 50e18);
        ERC20Mock next = new ERC20Mock("VPFI v2", "VPFI2", 18);
        _rotateTo(next);
        _curve(SOLVER); // the admin sizes a curve for the new token (epoch 2)
        next.mint(op, 100e18);
        LibServiceCapacity.ArmingBind memory b = _bind(SOLVER);
        vm.prank(op);
        next.approve(address(diamond), 20e18);
        (uint8 refusal, , , , ) = _f().previewArming(SOLVER, op, 10e18);
        assertEq(refusal, LibServiceCapacity.POST_RETIRED_BALANCE, "the preview names the refusal");
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityOldEpochBalanceStands.selector, SOLVER, op, uint64(0)));
        _f().postCapacityDeposit(SOLVER, 10e18, b);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityInsufficient.selector, SOLVER, op, 0, 50e18));
        _f().withdrawCapacityDeposit(SOLVER, 50e18); // the live epoch holds nothing of theirs
        uint256 oldBefore = vpfi.balanceOf(op);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit CapacityDepositMigrated(SOLVER, op, 0, address(vpfi), 50e18);
        vm.prank(op);
        (uint8 status, uint256 paid) = _f().withdrawArchivedCapacityDeposit(SOLVER, 0);
        assertEq(status, LibServiceCapacity.STATUS_OK);
        assertEq(paid, 50e18, "the whole record");
        assertEq(vpfi.balanceOf(op), oldBefore + 50e18, "paid in the old asset");
        assertEq(next.balanceOf(op), 100e18, "never the new one");
        (, uint256 total0, ) = _f().getServiceCapacityEscrowByEpoch(0);
        assertEq(total0, 0, "the retired total is drained");
        assertTrue(_f().getCapacityDeposit(SOLVER, op, 0).migrated);
        assertEq(_postWith(IERC20(address(next)), SOLVER, 10e18), LibServiceCapacity.STATUS_OK, "drained: the new-token post lands");
        LibVaipakam.ServiceCapacityDeposit memory d = _f().getCapacityDeposit(SOLVER, op, 1);
        assertEq(d.token, address(next));
        assertEq(d.rotationEpoch, 1);
        assertEq(d.amount, 10e18);
        (, , uint256 total1) = _f().getServiceCapacityEscrow();
        assertEq(total1, 10e18);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityInsufficient.selector, SOLVER, op, 0, 0));
        _f().withdrawArchivedCapacityDeposit(SOLVER, 0); // empty: says so by name
    }

    /// @dev A token of different decimals can never inherit the old thresholds: after
    ///      the rotation the old 100e18 deposit buys nothing (archived epochs are not
    ///      eligible) and the admin sizes the knee for 6 decimals; a 100e6 deposit then
    ///      buys exactly 4x.
    function test_Rotation_DifferingDecimals_CannotInheritTheThreshold() public {
        _ready();
        _post(SOLVER, AT4X);
        ERC20Mock usd6 = new ERC20Mock("VPFI v2", "VPFI2", 6);
        _rotateTo(usd6);
        usd6.mint(op, 1_000e6);
        _f().setCapacityCurve(SOLVER, FREE, RATE, 100e6, COST); // sized for the new token
        (, uint256 rate, uint256 ceil, bool dark) = _f().previewCapacity(SOLVER, op);
        assertFalse(dark);
        assertEq(rate, RATE, "the archived 100e18 is not read as a 6-decimals bond");
        assertEq(ceil, FREE);
        vm.prank(op);
        _f().withdrawArchivedCapacityDeposit(SOLVER, 0); // the drain
        assertEq(_postWith(IERC20(address(usd6)), SOLVER, 100e6), LibServiceCapacity.STATUS_OK);
        (, rate, ceil, ) = _f().previewCapacity(SOLVER, op);
        assertEq(rate, 4 * RATE, "the new knee buys 4x");
        assertEq(ceil, 4 * FREE);
        assertEq(usd6.balanceOf(_escrow()), 100e6, "escrowed in the new asset");
    }

    /// @dev The archived withdraw screens like the live one: a first authoritative flag
    ///      PARKS the whole record and pays nothing; with the marker persisted the next
    ///      call reverts; a clean read releases the parked cap in the old asset.
    function test_Rotation_ArchivedWithdraw_FirstFlagParks_ThenACleanReadReleases() public {
        _ready();
        _post(SOLVER, 50e18);
        _rotateTo(new ERC20Mock("VPFI v2", "VPFI2", 18));
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(op, true);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit CapacityDepositParked(SOLVER, op, 0, 50e18, 50e18);
        vm.prank(op);
        (uint8 status, uint256 paid) = _f().withdrawArchivedCapacityDeposit(SOLVER, 0);
        assertEq(status, LibServiceCapacity.STATUS_PARKED);
        assertEq(paid, 0, "nothing paid; principal frozen, never seized");
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, op));
        _f().withdrawArchivedCapacityDeposit(SOLVER, 0);
        m.setFlagged(op, false);
        vm.prank(op);
        (status, paid) = _f().withdrawArchivedCapacityDeposit(SOLVER, 0);
        assertEq(status, LibServiceCapacity.STATUS_OK);
        assertEq(paid, 50e18);
        assertEq(vpfi.balanceOf(op), 1_000e18 - 0.5e18, "whole again, less the fee paid for the arming");
    }

    /// @dev The archived withdraw refuses the live epoch and an epoch that never existed
    ///      by name, and the migration pause blocks it like the other value movers.
    function test_Rotation_ArchivedWithdraw_RefusesLiveOrUnknownEpochs_AndPauses() public {
        _ready();
        _post(SOLVER, 50e18);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityEpochNotArchived.selector, uint64(0)));
        _f().withdrawArchivedCapacityDeposit(SOLVER, 0);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityEpochNotArchived.selector, uint64(7)));
        _f().withdrawArchivedCapacityDeposit(SOLVER, 7);
        _rotateTo(new ERC20Mock("VPFI v2", "VPFI2", 18));
        AdminFacet(address(diamond)).pause();
        vm.prank(op);
        vm.expectRevert();
        _f().withdrawArchivedCapacityDeposit(SOLVER, 0);
        AdminFacet(address(diamond)).unpause();
        vm.prank(op);
        (, uint256 paid) = _f().withdrawArchivedCapacityDeposit(SOLVER, 0);
        assertEq(paid, 50e18);
    }

    // ─── PR 1 pre-open review ───

    function _eligible() internal view returns (uint256) { return _f().getCapacityDeposit(SOLVER, op, 0).eligibleAmount; }

    /// @dev P2 — a knee raised by governance arms nothing by itself: principal deposited above the
    ///      old knee stays unarmed, and buys nothing, until a zero-principal post arms it and pays.
    function test_KneeRaise_ArmsNothing_UntilAPaidPostArmsTheExcess() public {
        _ready();
        _post(SOLVER, 2 * AT4X);
        assertEq(_eligible(), AT4X, "armed to the knee, not the whole principal");
        _f().setCapacityCurve(SOLVER, FREE, RATE, 2 * AT4X, COST); // governance raises the knee
        (, , uint256 ceilBefore, ) = _f().previewCapacity(SOLVER, op);
        assertLt(ceilBefore, 4 * FREE, "the raise armed nothing by itself");
        (uint8 refusal, uint256 fee, uint256 granted, uint256 eligibleAfter, uint256 ceilingAfter) =
            _f().previewArming(SOLVER, op, 0);
        assertEq(refusal, LibServiceCapacity.POST_OK, "a zero-principal post would arm the excess");
        assertEq(granted, AT4X);
        assertEq(fee, (AT4X * FEE + 1e18 - 1) / 1e18);
        assertEq(eligibleAfter, 2 * AT4X);
        assertEq(ceilingAfter, 4 * FREE);
        LibServiceCapacity.ArmingBind memory b = _bind(SOLVER);
        vm.prank(op);
        vpfi.approve(address(diamond), fee);
        uint256 bucketBefore = _bucket();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit CapacityDepositArmed(SOLVER, op, 0, address(vpfi), AT4X, 2 * AT4X, 2 * AT4X);
        vm.prank(op);
        assertEq(_f().postCapacityDeposit(SOLVER, 0, b), LibServiceCapacity.STATUS_OK);
        assertEq(_bucket(), bucketBefore + fee, "and paid for");
        assertEq(_f().getCapacityDeposit(SOLVER, op, 0).amount, 2 * AT4X, "no principal moved");
        (, , uint256 ceilAfter, ) = _f().previewCapacity(SOLVER, op);
        assertEq(ceilAfter, 4 * FREE);
    }

    /// @dev P2 — a withdrawal never arms what it leaves behind, and the armed balance never
    ///      exceeds the principal.
    function test_Withdraw_NeverArmsWhatItLeaves() public {
        _ready();
        _post(SOLVER, 2 * AT4X);
        _f().setCapacityCurve(SOLVER, FREE, RATE, 2 * AT4X, COST);
        vm.prank(op);
        _f().withdrawCapacityDeposit(SOLVER, 1);
        assertEq(_eligible(), AT4X, "a 1-wei withdrawal re-arms nothing");
        vm.prank(op);
        _f().withdrawCapacityDeposit(SOLVER, AT4X + 1);
        assertEq(_eligible(), AT4X - 2, "the armed balance follows the principal down");
    }

    /// @dev The fee rounds UP: no armed principal is ever free.
    function test_Fee_RoundsUp() public {
        _ready();
        (, uint256 fee, uint256 granted, , ) = _f().previewArming(SOLVER, op, 1);
        assertEq(granted, 1);
        assertEq(fee, 1, "1 wei armed at 1% owes 1 wei, not zero");
    }

    /// @dev The preview names the post's arming refusals: nothing to arm, then OK.
    function test_Preview_NothingToArm_ThenOk() public {
        _ready();
        (uint8 refusal, , , , ) = _f().previewArming(SOLVER, op, 0);
        assertEq(refusal, LibServiceCapacity.POST_NOTHING_TO_ARM);
        (refusal, , , , ) = _f().previewArming(SOLVER, op, 10e18);
        assertEq(refusal, LibServiceCapacity.POST_OK);
    }

    /// @dev A parked record's archived drain pays the WHOLE record in one call after the clean
    ///      read — not only the cap a smaller earlier request parked.
    function test_Rotation_ArchivedDrainOfAParkedRecord_PaysTheWholeRecord() public {
        _ready();
        _post(SOLVER, 50e18);
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(op, true);
        vm.prank(op);
        _f().withdrawCapacityDeposit(SOLVER, 3e18); // parked, cap 3
        assertEq(_f().getCapacityDeposit(SOLVER, op, 0).parkedRequest, 3e18, "fixture-live: parked at 3");
        m.setFlagged(op, false);
        _rotateTo(new ERC20Mock("VPFI v2", "VPFI2", 18));
        vm.prank(op);
        (uint8 status, uint256 paid) = _f().withdrawArchivedCapacityDeposit(SOLVER, 0);
        assertEq(status, LibServiceCapacity.STATUS_OK);
        assertEq(paid, 50e18, "the whole record, in one call");
    }
}
