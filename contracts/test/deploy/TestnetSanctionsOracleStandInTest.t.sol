// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TestnetSanctionsOracleStandIn} from "../../src/compliance/TestnetSanctionsOracleStandIn.sol";
import {
    SanctionsClearanceAttestor,
    SANCTIONS_CLEARANCE_WIRE_VERSION,
    CLEARANCE_REQUEST,
    CLEARANCE_RESPONSE
} from "../../src/compliance/SanctionsClearanceAttestor.sol";
import {ICrossChainMessenger} from "../../src/crosschain/ICrossChainMessenger.sol";
import {ISanctionsList} from "../../src/interfaces/ISanctionsList.sol";

/**
 * @title  TestnetSanctionsOracleStandInTest
 * @notice The testnet stand-in for RedStone's Sanctions Oracle (#2443): it
 *         cannot exist on a mainnet, it says it is a stand-in, it flags only
 *         what its owner flags, and its freshness is its owner's last write,
 *         never the current block's time. The last test reads it through a
 *         real `SanctionsClearanceAttestor`, so the reply the timelock would
 *         receive carries the stand-in's answer and its own update time.
 */
contract TestnetSanctionsOracleStandInTest is Test {
    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");
    address internal a = makeAddr("a");
    address internal b = makeAddr("b");

    /// @dev Start time, written as a literal: under viaIR a test may read the
    ///      pre-warp `block.timestamp` back.
    uint256 internal constant T0 = 1_800_000_000;

    TestnetSanctionsOracleStandIn internal standIn;

    event StandInFlagSet(address indexed account, bool flagged);
    event StandInUpdated(uint256 timestamp);

    function setUp() public {
        vm.chainId(84532);
        vm.warp(T0);
        standIn = new TestnetSanctionsOracleStandIn(admin);
    }

    function _arr(address x) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = x;
    }

    function _arr(address x, address y) internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = x;
        r[1] = y;
    }

    function test_RefusesEveryMainnet() public {
        uint256[4] memory mainnets = [uint256(1), 8453, 42161, 56];
        for (uint256 i; i < mainnets.length; ++i) {
            vm.chainId(mainnets[i]);
            vm.expectRevert(abi.encodeWithSelector(TestnetSanctionsOracleStandIn.NotATestnet.selector, mainnets[i]));
            new TestnetSanctionsOracleStandIn(admin);
        }
    }

    function test_SaysItIsAStandIn() public view {
        assertTrue(standIn.isTestnetStandIn());
        assertEq(standIn.STAND_IN_FOR(), "RedStone Sanctions Oracle");
        assertEq(standIn.owner(), admin);
    }

    function test_DeploymentPublishesAnEmptyList() public {
        assertEq(standIn.getLastUpdateBlockTimestamp(), T0);
        assertFalse(standIn.isSanctioned(a));
        vm.expectEmit(false, false, false, true);
        emit StandInUpdated(T0);
        new TestnetSanctionsOracleStandIn(admin);
    }

    function test_FlagsOnlyWhatTheOwnerFlags_AndEachWriteIsAPublication() public {
        vm.warp(T0 + 1 days);
        vm.expectEmit(address(standIn));
        emit StandInFlagSet(a, true);
        vm.expectEmit(address(standIn));
        emit StandInFlagSet(b, true);
        vm.expectEmit(address(standIn));
        emit StandInUpdated(T0 + 1 days);
        vm.prank(admin);
        standIn.setFlagged(_arr(a, b), true);
        assertTrue(standIn.isSanctioned(a));
        assertTrue(standIn.isSanctioned(b));
        assertTrue(standIn.flagged(a));
        assertEq(standIn.getLastUpdateBlockTimestamp(), T0 + 1 days);

        vm.warp(T0 + 2 days);
        vm.prank(admin);
        standIn.setFlagged(_arr(a), false);
        assertFalse(standIn.isSanctioned(a));
        assertTrue(standIn.isSanctioned(b));
        assertEq(standIn.getLastUpdateBlockTimestamp(), T0 + 2 days);
    }

    function test_FreshnessIsTheOwnersLastWrite_NeverTheBlockTime() public {
        vm.warp(T0 + 30 days);
        assertEq(standIn.getLastUpdateBlockTimestamp(), T0, "time passing alone does not refresh it");

        vm.expectEmit(address(standIn));
        emit StandInUpdated(T0 + 30 days);
        vm.prank(admin);
        standIn.markUpdated();
        assertEq(standIn.getLastUpdateBlockTimestamp(), T0 + 30 days);
        assertFalse(standIn.isSanctioned(a), "a refresh changes no flag");
    }

    function test_OnlyTheOwnerWrites() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        standIn.setFlagged(_arr(a), true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        standIn.markUpdated();
        vm.stopPrank();
        assertEq(standIn.getLastUpdateBlockTimestamp(), T0);
    }

    function test_BatchRefusals() public {
        vm.startPrank(admin);
        vm.expectRevert(TestnetSanctionsOracleStandIn.EmptyBatch.selector);
        standIn.setFlagged(new address[](0), true);
        vm.expectRevert(TestnetSanctionsOracleStandIn.ZeroAddress.selector);
        standIn.setFlagged(_arr(a, address(0)), true);
        vm.stopPrank();
        assertFalse(standIn.isSanctioned(a), "a refused batch changes nothing");
        assertEq(standIn.getLastUpdateBlockTimestamp(), T0);
    }

    /// @dev Read through a real attestor, standing in for the messenger
    ///      itself: the reply owed carries the stand-in's flags and ITS update
    ///      time, which is what a timelock's freshness gate then judges.
    function test_AnAttestorReplyCarriesTheStandInsAnswerAndUpdateTime() public {
        vm.prank(admin);
        standIn.setFlagged(_arr(b), true);
        vm.warp(T0 + 3 days);

        SanctionsClearanceAttestor att =
            new SanctionsClearanceAttestor(ISanctionsList(address(standIn)), ICrossChainMessenger(address(this)));
        bytes memory request = abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_REQUEST, uint64(7), _arr(a, b));
        bytes32 messageId = keccak256("request-7");
        att.onCrossChainMessage(421614, makeAddr("timelock"), request, new ICrossChainMessenger.TokenAmount[](0), messageId);

        bool[] memory flags = new bool[](2);
        flags[1] = true;
        bytes memory expected =
            abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_RESPONSE, uint64(7), _arr(a, b), flags, uint64(T0));
        (uint256 dest, bytes32 payloadHash, uint32 accounts, bool sent) = att.replyOf(messageId);
        assertEq(dest, 421614);
        assertEq(payloadHash, keccak256(expected), "the stand-in's flags and its own update time, not the block's");
        assertEq(accounts, 2);
        assertFalse(sent);
    }
}
