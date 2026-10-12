// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {ServiceCapacityFacet} from "../src/facets/ServiceCapacityFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibServiceCapacity} from "../src/libraries/LibServiceCapacity.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";

/// @title #1219 (S-4) slice 1 — the service capacity deposit's record lifecycle.
/// @dev   The deposit is refundable, earns nothing and is never at risk; it lives in
///        an escrow holder of its own; the channel is DARK by default; every
///        value-moving selector screens the operator through the registry-aware
///        tri-state gate. Nothing here touches the reward holder or the Diamond's
///        own balance, and the cells say so.
contract ServiceCapacityDepositTest is SetupTest {
    VPFIToken internal vpfi;
    address internal op;
    uint8 internal constant SOLVER = uint8(LibVaipakam.ServiceCapacityRole.Solver);
    uint8 internal constant KEEPER = uint8(LibVaipakam.ServiceCapacityRole.Keeper);

    event CapacityDepositPosted(
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, address token, uint256 amount, uint256 postBalance, uint256 eligibleAfter
    );
    event CapacityDepositRaised(
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, address token, uint256 amount, uint256 postBalance, uint256 eligibleAfter
    );
    event CapacityDepositWithdrawn(
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, address token, uint256 amount, uint256 postBalance, uint256 eligibleAfter
    );
    event CapacityDepositParked(uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, uint256 requested, uint256 parkedRequest);
    event CapacityDepositParkReleased(
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, address token, uint256 paid, uint256 postBalance, uint256 eligibleAfter
    );
    event ServiceCapacitySanctionsRefused(uint8 indexed role, address indexed operator, address indexed party, uint8 status);
    event ServiceCapacitySanctionsMarkerHealed(address indexed party);
    event ServiceCapacityEnabledSet(bool enabled);

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
    }

    function _f() internal view returns (ServiceCapacityFacet) { return ServiceCapacityFacet(address(diamond)); }
    function _dep(uint8 role) internal view returns (LibVaipakam.ServiceCapacityDeposit memory) { return _f().getCapacityDeposit(role, op, 0); }
    function _escrow() internal view returns (address e) { (e, , ) = _f().getServiceCapacityEscrow(); }
    function _ready() internal returns (address escrow) {
        escrow = _f().bindServiceCapacityEscrow();
        _f().setServiceCapacityEnabled(true);
        _arm();
    }
    /// @dev Slice 3 — posting needs a lit arming channel: a positive fee rate over a
    ///      positive floor, and a curve for the role. 1% of newly armed principal; the
    ///      knee sits far above every amount these cells post, so the fee is 1% of the post.
    function _arm() internal {
        _f().setArmingFeeFloor(1e15);
        _f().setArmingFeeRate(1e16);
        _f().setCapacityCurve(SOLVER, 1e18, 1e16, 1_000e18, 1e18);
        _f().setCapacityCurve(KEEPER, 1e18, 1e16, 1_000e18, 1e18);
    }
    function _fee(uint256 amount) internal pure returns (uint256) { return amount / 100; }
    /// @dev The bound terms (no rotation, one curve epoch here) — pure, so a prank is never consumed by a view.
    function _bind() internal pure returns (LibServiceCapacity.ArmingBind memory) {
        return LibServiceCapacity.ArmingBind({maxFee: type(uint256).max, minCapacityAfter: 0, expectedRotationEpoch: 0, expectedCurveEpoch: 1});
    }
    function _approve(uint256 amount) internal {
        vm.prank(op);
        vpfi.approve(address(diamond), amount + _fee(amount)); // the principal and its arming fee, exact, never unbounded
    }
    function _post(uint8 role, uint256 amount) internal returns (uint8 status) {
        _approve(amount);
        vm.prank(op);
        status = _f().postCapacityDeposit(role, amount, _bind());
    }
    function _withdraw(uint8 role, uint256 amount) internal returns (uint8 status, uint256 paid) {
        vm.prank(op);
        (status, paid) = _f().withdrawCapacityDeposit(role, amount);
    }
    function _oracle() internal returns (MockSanctionsList m) {
        m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
    }

    // ─── dark by default ───

    /// @dev The channel ships off: posting is refused by name until the admin
    ///      enables it, and the switch is observable.
    function test_Dark_PostingIsRefused_UntilEnabled() public {
        _f().bindServiceCapacityEscrow();
        assertFalse(_f().isServiceCapacityEnabled(), "dark by default");
        _approve(10e18);
        assertEq(_refusal(10e18), LibServiceCapacity.POST_CHANNEL_DARK, "the preview names the refusal");
        vm.prank(op);
        vm.expectRevert(IVaipakamErrors.ServiceCapacityDisabled.selector);
        _f().postCapacityDeposit(SOLVER, 10e18, _bind());
        vm.expectEmit(false, false, false, true, address(diamond));
        emit ServiceCapacityEnabledSet(true);
        _f().setServiceCapacityEnabled(true);
        assertTrue(_f().isServiceCapacityEnabled());
        _arm();
        assertEq(_post(SOLVER, 10e18), LibServiceCapacity.STATUS_OK, "posted once enabled");
    }

    /// @dev Disabling the channel again strands nothing: a withdrawal still goes through.
    function test_Dark_PreservesWithdrawals() public {
        _ready();
        _post(SOLVER, 10e18);
        _f().setServiceCapacityEnabled(false);
        (uint8 status, uint256 paid) = _withdraw(SOLVER, 4e18);
        assertEq(status, LibServiceCapacity.STATUS_OK);
        assertEq(paid, 4e18, "paid while dark");
        assertEq(_dep(SOLVER).amount, 6e18);
    }

    // ─── the escrow holder ───

    /// @dev Bound once by the admin; a second bind and a non-admin bind are refused.
    function test_Escrow_IsBoundOnce_ByTheAdmin() public {
        assertEq(_escrow(), address(0), "unbound at first");
        address e = _f().bindServiceCapacityEscrow();
        assertEq(_escrow(), e);
        assertTrue(e != address(diamond) && e != address(0), "its own contract");
        vm.expectRevert(IVaipakamErrors.ServiceCapacityEscrowAlreadyBound.selector);
        _f().bindServiceCapacityEscrow();
        vm.prank(op);
        vm.expectRevert();
        _f().bindServiceCapacityEscrow();
    }

    /// @dev Posting before the escrow is bound is refused by name; nothing moves.
    function test_Post_RefusedWhileTheEscrowIsUnbound() public {
        _f().setServiceCapacityEnabled(true);
        _approve(1e18);
        assertEq(_refusal(1e18), LibServiceCapacity.POST_NOT_BOUND, "the preview names the refusal");
        vm.prank(op);
        vm.expectRevert(IVaipakamErrors.ServiceCapacityEscrowNotBound.selector);
        _f().postCapacityDeposit(SOLVER, 1e18, _bind());
    }

    // ─── the record lifecycle ───

    /// @dev A post moves principal into the ESCROW (not the Diamond), records it
    ///      under (role, operator, epoch 0) with the eligible balance equal to the
    ///      principal, publishes the epoch total, and emits the posted event.
    function test_Post_RecordsAndEscrows() public {
        address e = _ready();
        uint256 diamondBefore = vpfi.balanceOf(address(diamond));
        _approve(10e18);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit CapacityDepositPosted(SOLVER, op, 0, address(vpfi), 10e18, 10e18, 10e18);
        vm.prank(op);
        assertEq(_f().postCapacityDeposit(SOLVER, 10e18, _bind()), LibServiceCapacity.STATUS_OK);
        LibVaipakam.ServiceCapacityDeposit memory d = _dep(SOLVER);
        assertEq(d.token, address(vpfi));
        assertEq(d.rotationEpoch, 0);
        assertEq(uint8(d.state), uint8(LibVaipakam.ServiceDepositState.Active));
        assertEq(d.amount, 10e18);
        assertEq(d.eligibleAmount, 10e18, "armed equals principal: the arming fee is paid beside it");
        assertEq(d.parkedRequest, 0);
        assertEq(vpfi.balanceOf(e), 10e18, "the escrow holds it");
        assertEq(vpfi.balanceOf(address(diamond)), diamondBefore + 0.1e18, "the Diamond holds exactly the arming fee (recycled), never the principal");
        assertEq(vpfi.balanceOf(op), 1_000e18 - 10e18 - 0.1e18, "the principal and its 1% arming fee");
        (, uint64 epoch, uint256 total) = _f().getServiceCapacityEscrow();
        assertEq(epoch, 0);
        assertEq(total, 10e18, "the epoch total is published");
        assertEq(_dep(KEEPER).amount, 0, "per role");
    }

    /// @dev A second post is a RAISE: it adds and emits the raised event.
    function test_Raise_Adds() public {
        _ready();
        _post(SOLVER, 10e18);
        _approve(5e18);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit CapacityDepositRaised(SOLVER, op, 0, address(vpfi), 5e18, 15e18, 15e18);
        vm.prank(op);
        _f().postCapacityDeposit(SOLVER, 5e18, _bind());
        assertEq(_dep(SOLVER).amount, 15e18);
        assertEq(_dep(SOLVER).eligibleAmount, 15e18);
    }

    /// @dev Withdrawal is immediate (owner: option (i)): part, then the rest; the
    ///      escrow and the epoch total fall with it; more than held is refused.
    function test_Withdraw_IsImmediate_AndBounded() public {
        address e = _ready();
        _post(SOLVER, 10e18);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit CapacityDepositWithdrawn(SOLVER, op, 0, address(vpfi), 4e18, 6e18, 6e18);
        (uint8 status, uint256 paid) = _withdraw(SOLVER, 4e18);
        assertEq(status, LibServiceCapacity.STATUS_OK);
        assertEq(paid, 4e18);
        assertEq(vpfi.balanceOf(e), 6e18);
        assertEq(vpfi.balanceOf(op), 1_000e18 - 6e18 - 0.1e18);
        (, , uint256 total) = _f().getServiceCapacityEscrow();
        assertEq(total, 6e18);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityInsufficient.selector, SOLVER, op, 6e18, 7e18));
        _f().withdrawCapacityDeposit(SOLVER, 7e18);
        (, paid) = _withdraw(SOLVER, 6e18);
        assertEq(paid, 6e18);
        assertEq(_dep(SOLVER).amount, 0);
        assertEq(vpfi.balanceOf(e), 0, "the escrow is empty again");
    }

    /// @dev Zero amounts and unknown roles are refused by name; a withdrawal from
    ///      an empty record names what it holds.
    function test_Refusals_ByName() public {
        _ready();
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityNothingToArm.selector, SOLVER, op));
        _f().postCapacityDeposit(SOLVER, 0, _bind()); // a zero-principal post must arm something
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityRoleUnknown.selector, uint8(7)));
        _f().postCapacityDeposit(7, 1e18, _bind());
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityInsufficient.selector, KEEPER, op, 0, 1e18));
        _f().withdrawCapacityDeposit(KEEPER, 1e18);
    }

    /// @dev The migration pause blocks both value-moving selectors.
    function test_Pause_BlocksTheValueMovers() public {
        _ready();
        _post(SOLVER, 10e18);
        AdminFacet(address(diamond)).pause();
        _approve(1e18);
        vm.prank(op);
        vm.expectRevert();
        _f().postCapacityDeposit(SOLVER, 1e18, _bind());
        vm.prank(op);
        vm.expectRevert();
        _f().withdrawCapacityDeposit(SOLVER, 1e18);
        AdminFacet(address(diamond)).unpause();
        (, uint256 paid) = _withdraw(SOLVER, 1e18);
        assertEq(paid, 1e18);
    }

    // ─── sanctions: the registry-aware tri-state on every value-moving selector ───

    /// @dev A FIRST authoritative flag on a post is a COMMITTED, value-unmoving
    ///      refusal: status returned, marker persisted, nothing escrowed. With the
    ///      marker persisted, the next post takes the central Tier-1 revert.
    function test_Sanctions_FirstFlagOnPost_CommitsTheMarker_MovesNothing() public {
        address e = _ready();
        MockSanctionsList m = _oracle();
        m.setFlagged(op, true);
        _approve(10e18);
        assertEq(_refusal(10e18), LibServiceCapacity.POST_SANCTIONED, "the preview names the refusal");
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ServiceCapacitySanctionsRefused(SOLVER, op, op, LibServiceCapacity.STATUS_REFUSED_SANCTIONED);
        vm.prank(op);
        uint8 status = _f().postCapacityDeposit(SOLVER, 10e18, _bind());
        assertEq(status, LibServiceCapacity.STATUS_REFUSED_SANCTIONED, "refused by status, not by revert");
        assertEq(vpfi.balanceOf(e), 0, "nothing moved");
        assertEq(_dep(SOLVER).amount, 0);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, op));
        _f().postCapacityDeposit(SOLVER, 10e18, _bind());
    }

    /// @dev A first flag on a WITHDRAWAL parks the request (capped to the
    ///      principal) and pays nothing; with the marker persisted the next call
    ///      reverts; an authoritative clean read then releases the parked cap and
    ///      heals the marker.
    function test_Sanctions_FirstFlagOnWithdraw_Parks_ThenACleanReadReleases() public {
        address e = _ready();
        _post(SOLVER, 10e18);
        MockSanctionsList m = _oracle();
        m.setFlagged(op, true);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit CapacityDepositParked(SOLVER, op, 0, 12e18, 10e18);
        (uint8 status, uint256 paid) = _withdraw(SOLVER, 12e18);
        assertEq(status, LibServiceCapacity.STATUS_PARKED);
        assertEq(paid, 0, "nothing paid");
        LibVaipakam.ServiceCapacityDeposit memory d = _dep(SOLVER);
        assertEq(uint8(d.state), uint8(LibVaipakam.ServiceDepositState.SanctionsParked));
        assertEq(d.parkedRequest, 10e18, "capped to the principal");
        assertEq(d.amount, 10e18, "principal frozen, never seized");
        assertEq(vpfi.balanceOf(e), 10e18);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, op));
        _f().withdrawCapacityDeposit(SOLVER, 1e18);
        m.setFlagged(op, false); // delisted
        vm.expectEmit(true, false, false, true, address(diamond));
        emit ServiceCapacitySanctionsMarkerHealed(op);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit CapacityDepositParkReleased(SOLVER, op, 0, address(vpfi), 10e18, 0, 0);
        (status, paid) = _withdraw(SOLVER, 1e18);
        assertEq(status, LibServiceCapacity.STATUS_OK);
        assertEq(paid, 10e18, "the parked cap is released, no more and no less");
        assertEq(_dep(SOLVER).amount, 0);
        assertEq(uint8(_dep(SOLVER).state), uint8(LibVaipakam.ServiceDepositState.Active));
        assertEq(vpfi.balanceOf(op), 1_000e18 - 0.1e18, "whole again, less the fee paid for the arming");
    }

    /// @dev An oracle OUTAGE defers every deposit mutation, for a never-flagged
    ///      operator too, and persists nothing: the deferral is latency, not a lock —
    ///      the same calls succeed on the first clean read after recovery.
    function test_Sanctions_OutageDefers_EveryParty_ThenRecovers() public {
        _ready();
        _post(SOLVER, 10e18);
        MockSanctionsList m = _oracle();
        m.setRevertOnRead(true);
        _approve(1e18);
        assertEq(_refusal(1e18), LibServiceCapacity.POST_SANCTIONS_UNAVAILABLE, "the preview names the deferral");
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacitySanctionsUnavailable.selector, op));
        _f().postCapacityDeposit(SOLVER, 1e18, _bind());
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacitySanctionsUnavailable.selector, op));
        _f().withdrawCapacityDeposit(SOLVER, 1e18);
        m.setRevertOnRead(false);
        assertEq(_post(SOLVER, 1e18), LibServiceCapacity.STATUS_OK, "recovered: posts");
        (, uint256 paid) = _withdraw(SOLVER, 2e18);
        assertEq(paid, 2e18, "recovered: pays");
    }

    /// @dev A stale persisted marker is healed by the next authoritative clean read
    ///      on a post, in the same call that posts.
    function test_Sanctions_CleanReadHealsAStaleMarker_OnPost() public {
        _ready();
        MockSanctionsList m = _oracle();
        m.setFlagged(op, true);
        assertEq(_post(SOLVER, 1e18), LibServiceCapacity.STATUS_REFUSED_SANCTIONED, "marker persisted by the refusal");
        m.setFlagged(op, false);
        _approve(1e18);
        vm.expectEmit(true, false, false, true, address(diamond));
        emit ServiceCapacitySanctionsMarkerHealed(op);
        vm.prank(op);
        assertEq(_f().postCapacityDeposit(SOLVER, 1e18, _bind()), LibServiceCapacity.STATUS_OK, "healed and posted");
        assertEq(_dep(SOLVER).amount, 1e18);
    }

    /// @dev With no oracle configured (the deploy window), the screen passes, as on
    ///      the rest of the Tier-1 surface.
    function test_Sanctions_NoOracle_Passes() public {
        _ready();
        assertEq(_post(SOLVER, 1e18), LibServiceCapacity.STATUS_OK);
        (, uint256 paid) = _withdraw(SOLVER, 1e18);
        assertEq(paid, 1e18);
    }

    // ─── PR 1 pre-open review ───

    function _refusal(uint256 amount) internal view returns (uint8 r) { (r, , , , ) = _f().previewArming(SOLVER, op, amount); }

    /// @dev A post on a parked record whose operator now reads clean releases the park, and the
    ///      stale cap goes with it: a later first flag parks only what is then requested.
    function test_Sanctions_PostOnAParkedRecord_ReleasesThePark() public {
        _ready();
        _post(SOLVER, 10e18);
        MockSanctionsList m = _oracle();
        m.setFlagged(op, true);
        _withdraw(SOLVER, 4e18); // parked: cap 4
        assertEq(_dep(SOLVER).parkedRequest, 4e18, "fixture-live: parked at 4");
        m.setFlagged(op, false);
        _post(SOLVER, 5e18); // clean: the park is released and the raise lands
        LibVaipakam.ServiceCapacityDeposit memory d = _dep(SOLVER);
        assertEq(uint8(d.state), uint8(LibVaipakam.ServiceDepositState.Active));
        assertEq(d.parkedRequest, 0, "the stale cap went with the park");
        assertEq(d.amount, 15e18);
        m.setFlagged(op, true);
        _withdraw(SOLVER, 2e18); // a new first flag parks only the new request
        assertEq(_dep(SOLVER).parkedRequest, 2e18);
    }
}
