// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RewardEpochFacet} from "../src/facets/RewardEpochFacet.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardClosureFacet} from "../src/facets/RewardClosureFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibD8Delivery} from "./helpers/LibD8Delivery.sol";

/// @title RewardTransportParkTest
/// @notice 3b-ii-B — the PARK is the release gate: a batch's remainder parks only
///         once the ONE day it funds is proven closed (#2828: the day rides the
///         wire inline, so the check is a single read, never paged); the
///         acknowledgment that releases it is the administrator's disposition.
contract RewardTransportParkTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    MockRewardMessenger internal messenger;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    uint256 internal constant SEED = 1_000_000 ether;
    uint256 internal constant EPOCH = 0.1e18;
    uint256 internal launch;

    function setUp() public {
        setupHelper();
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)))
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        AdminFacet(address(diamond)).setTreasury(makeAddr("treasury"));
        launch = block.timestamp;
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(launch);
        uint256 have = vpfi.balanceOf(address(this));
        if (SEED > have) vpfi.mint(address(this), SEED - have);
        vpfi.transfer(address(diamond), SEED);
        messenger = new MockRewardMessenger(address(diamond));
        vm.chainId(CHAIN_ARB);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
        RewardReporterFacet(address(diamond)).setBaseChainId(CHAIN_BASE);
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(address(this));
        RewardReporterFacet(address(diamond)).setRewardMessenger(address(messenger));
        activateRewardCustodyForTest(address(vpfi), 0);
    }

    function _epoch() internal view returns (RewardEpochFacet) { return RewardEpochFacet(address(diamond)); }
    function _ingress() internal view returns (RewardIngressFacet) { return RewardIngressFacet(address(diamond)); }
    function _rep() internal view returns (RewardReporterFacet) { return RewardReporterFacet(address(diamond)); }
    function _clo() internal view returns (RewardClosureFacet) { return RewardClosureFacet(address(diamond)); }

    /// @dev An admitted epoch of EPOCH for day `d`, indexed at its ingress.
    function _epochOn(uint256 d, uint256 remitId) internal returns (bytes32 h) {
        bytes32 id = keccak256(abi.encode("park-epoch", d, remitId));
        h = LibD8Delivery.deliverFresh(address(diamond), address(vpfi), EPOCH, d, CHAIN_BASE, remitId, REMITTER, id);
    }

    /// @dev Day `d` elapses, the chain closes it, and it is proven closed — no
    ///      obligation covers it, so the proof completes at its start.
    function _closeDay(uint256 d) internal {
        vm.warp(launch + (d + 1) * 1 days + 1);
        _rep().closeDay(d);
        (, , bool closed) = _clo().startDayClosure(d);
        assertTrue(closed, "no obligation: closes at start");
    }

    /// @dev The gate: while its day is open the park is refused by name; once the
    ///      day is proven closed the remainder parks, whole, in one call that
    ///      anyone may make.
    function test_ThePark_RequiresItsDayProvenClosed() public {
        bytes32 h = _epochOn(2, 7);
        vm.expectRevert(abi.encodeWithSelector(TransportDayNotClosed.selector, h, 2));
        _epoch().parkTransportBatchRemainder(h);
        vm.warp(launch + 3 days + 1);
        _rep().closeDay(1);
        _clo().startDayClosure(1);
        vm.expectRevert(abi.encodeWithSelector(TransportDayNotClosed.selector, h, 2));
        _epoch().parkTransportBatchRemainder(h); // another day's closure is not this one's
        _rep().closeDay(2);
        _clo().startDayClosure(2);
        address anyone = makeAddr("anyone");
        vm.prank(anyone);
        uint256 amount = _epoch().parkTransportBatchRemainder(h);
        assertEq(amount, EPOCH, "the whole remainder");
        (bool parked, uint256 remAmount, uint256 remDay, bool acked, ) = _epoch().getTransportRemainder(h);
        assertTrue(parked); assertEq(remAmount, EPOCH); assertEq(remDay, 2, "parked against its day"); assertFalse(acked);
        (, uint256 balance, , uint256 batchDay, bool released) = _epoch().getTransportBatch(h);
        assertEq(balance, 0, "moved out of the batch"); assertEq(batchDay, 2); assertFalse(released, "parked is not released");
        vm.expectRevert(abi.encodeWithSelector(TransportRemainderAlreadyParked.selector, h));
        _epoch().parkTransportBatchRemainder(h);
    }

    /// @dev Day 0 is a real reward day: an epoch funding it parks once it closes,
    ///      like any other.
    function test_ThePark_DayZero_IsARealDay() public {
        bytes32 h = _epochOn(0, 8);
        vm.expectRevert(abi.encodeWithSelector(TransportDayNotClosed.selector, h, 0));
        _epoch().parkTransportBatchRemainder(h);
        _closeDay(0);
        assertEq(_epoch().parkTransportBatchRemainder(h), EPOCH);
        (bool parked, , uint256 remDay, , ) = _epoch().getTransportRemainder(h);
        assertTrue(parked); assertEq(remDay, 0);
    }

    /// @dev The acknowledgment is the administrator's disposition; it releases the batch.
    function test_TheAcknowledgment_IsTheAdministrators_AndReleases() public {
        bytes32 h = _epochOn(1, 10);
        _closeDay(1);
        _epoch().parkTransportBatchRemainder(h);
        address stranger = makeAddr("stranger");
        vm.expectRevert(
            abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, stranger, LibAccessControl.ADMIN_ROLE)
        );
        vm.prank(stranger);
        _epoch().acknowledgeTransportBatchRemainder(h);
        _epoch().acknowledgeTransportBatchRemainder(h);
        (, , , bool acked, ) = _epoch().getTransportRemainder(h);
        assertTrue(acked);
        (, , , , bool released) = _epoch().getTransportBatch(h);
        assertTrue(released);
        vm.expectRevert(abi.encodeWithSelector(TransportRemainderAlreadyAcknowledged.selector, h));
        _epoch().acknowledgeTransportBatchRemainder(h);
    }
}
