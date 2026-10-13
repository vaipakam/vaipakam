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

/// @title RewardTransportParkTest
/// @notice 3b-ii-B — the PARK is the release gate: a batch's remainder parks only
///         once every day it listed is proven closed, checked against the batch's
///         own day-list commitment, paged; the acknowledgment that releases it is
///         the administrator's disposition.
contract RewardTransportParkTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    MockRewardMessenger internal messenger;
    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant REMITTER = address(0xBA5E);
    uint256 internal constant SEED = 1_000_000 ether;
    uint256 internal constant EPOCH = 0.1e18;
    uint256 internal constant PAGE = 32; // TRANSPORT_INDEX_PAGE
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

    function _days(uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = i + 1;
    }

    /// @dev An admitted, fully indexed epoch of EPOCH listing days 1..n.
    function _epochOn(uint256 n, uint256 remitId) internal returns (bytes32 h, uint256[] memory list) {
        list = _days(n);
        bytes32 id = keccak256(abi.encode("park-epoch", n, remitId));
        _ingress().onRewardBudgetReceived(address(vpfi), EPOCH, list, CHAIN_BASE, remitId, REMITTER, 0, 0, id, false);
        h = keccak256(abi.encode(uint256(CHAIN_BASE), id));
        while (true) {
            (, , , uint32 dayCount, uint32 indexedDays, ) = _epoch().getTransportBatch(h);
            if (indexedDays >= dayCount) break;
            _epoch().materializeTransportBatchPage(h, list);
        }
    }

    /// @dev Days 1..n elapse, the chain closes each, and each is proven closed —
    ///      no obligation covers any of them, so each proof completes at its start.
    function _closeDays(uint256 n) internal {
        vm.warp(launch + (n + 1) * 1 days + 1);
        for (uint256 d = 1; d <= n; ++d) {
            _rep().closeDay(d);
            (, , bool closed) = _clo().startDayClosure(d);
            assertTrue(closed, "no obligation: closes at start");
        }
    }

    /// @dev The gate: an open listed day refuses the park by name; once every listed
    ///      day is proven closed the remainder parks, whole.
    function test_ThePark_RequiresEveryListedDayProvenClosed() public {
        (bytes32 h, uint256[] memory list) = _epochOn(2, 7);
        vm.expectRevert(abi.encodeWithSelector(TransportDayNotClosed.selector, h, 1));
        _epoch().parkTransportBatchRemainder(h, list);
        vm.warp(launch + 3 days + 1);
        _rep().closeDay(1);
        _clo().startDayClosure(1);
        vm.expectRevert(abi.encodeWithSelector(TransportDayNotClosed.selector, h, 2));
        _epoch().parkTransportBatchRemainder(h, list);
        _rep().closeDay(2);
        _clo().startDayClosure(2);
        address anyone = makeAddr("anyone");
        vm.prank(anyone);
        (uint32 checked, bool parked, uint256 amount) = _epoch().parkTransportBatchRemainder(h, list);
        assertEq(checked, 2); assertTrue(parked); assertEq(amount, EPOCH, "the whole remainder");
        (uint256 remAmount, , uint32 remDays, bool acked, ) = _epoch().getTransportRemainder(h);
        assertEq(remAmount, EPOCH); assertEq(remDays, 2); assertFalse(acked);
        (, uint256 balance, , , , bool released) = _epoch().getTransportBatch(h);
        assertEq(balance, 0, "moved out of the batch"); assertFalse(released, "parked is not released");
    }

    /// @dev The day list is checked against the batch's own commitment.
    function test_ThePark_RefusesAForeignDayList() public {
        (bytes32 h, ) = _epochOn(2, 8);
        _closeDays(2);
        uint256[] memory wrong = _days(3);
        vm.expectRevert(
            abi.encodeWithSelector(TransportDayListMismatch.selector, h, keccak256(abi.encode(_days(2))), keccak256(abi.encode(wrong)))
        );
        _epoch().parkTransportBatchRemainder(h, wrong);
    }

    /// @dev A list longer than one page is checked across calls with a cursor.
    function test_ThePark_IsPaged() public {
        (bytes32 h, uint256[] memory list) = _epochOn(PAGE + 8, 9);
        _closeDays(PAGE + 8);
        (uint32 checked, bool parked, ) = _epoch().parkTransportBatchRemainder(h, list);
        assertEq(checked, PAGE); assertFalse(parked, "one page per call");
        (checked, parked, ) = _epoch().parkTransportBatchRemainder(h, list);
        assertEq(checked, PAGE + 8); assertTrue(parked);
    }

    /// @dev The acknowledgment is the administrator's disposition; it releases the batch.
    function test_TheAcknowledgment_IsTheAdministrators_AndReleases() public {
        (bytes32 h, uint256[] memory list) = _epochOn(1, 10);
        _closeDays(1);
        _epoch().parkTransportBatchRemainder(h, list);
        address stranger = makeAddr("stranger");
        vm.expectRevert(
            abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, stranger, LibAccessControl.ADMIN_ROLE)
        );
        vm.prank(stranger);
        _epoch().acknowledgeTransportBatchRemainder(h);
        _epoch().acknowledgeTransportBatchRemainder(h);
        (, , , bool acked, ) = _epoch().getTransportRemainder(h);
        assertTrue(acked);
        (, , , , , bool released) = _epoch().getTransportBatch(h);
        assertTrue(released);
        vm.expectRevert(abi.encodeWithSelector(TransportRemainderAlreadyAcknowledged.selector, h));
        _epoch().acknowledgeTransportBatchRemainder(h);
    }
}
