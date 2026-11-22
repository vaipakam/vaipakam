// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {Router} from "@chainlink/contracts-ccip/contracts/Router.sol";
import {RMNRemote} from "@chainlink/contracts-ccip/contracts/rmn/RMNRemote.sol";
import {RMNProxy} from "@chainlink/contracts-ccip/contracts/rmn/RMNProxy.sol";
import {IRMN} from "@chainlink/contracts-ccip/contracts/interfaces/IRMN.sol";
import {IAny2EVMMessageReceiver} from "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Pool} from "@chainlink/contracts-ccip/contracts/libraries/Pool.sol";
import {RehearsalOffRamp} from "../script/e2e/RehearsalOffRamp.sol";
import {MessageV1Codec} from "../script/e2e/ccipV2/MessageV1Codec.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev A receiver that records what it was handed and burns `burn` gas,
///      or reverts when told to.
contract RecordingReceiver is IAny2EVMMessageReceiver {
    error Refused();

    uint256 public burn;
    bool public refuse;
    uint256 public calls;
    bytes32 public lastId;
    bytes public lastData;
    uint256 public lastTokenAmount;

    function set(uint256 burn_, bool refuse_) external {
        burn = burn_;
        refuse = refuse_;
    }

    function ccipReceive(Client.Any2EVMMessage calldata message) external override {
        if (refuse) revert Refused();
        uint256 start = gasleft();
        while (start - gasleft() < burn) {}
        calls += 1;
        lastId = message.messageId;
        lastData = message.data;
        lastTokenAmount = message.destTokenAmounts.length == 0 ? 0 : message.destTokenAmounts[0].amount;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IAny2EVMMessageReceiver).interfaceId || id == 0x01ffc9a7;
    }
}

/// @dev The registry's one call the stand-in makes.
contract StubRegistry {
    mapping(address => address) public getPool;

    function setPool(address token, address pool) external {
        getPool[token] = pool;
    }
}

/// @dev A 1.0 pool that mints to the receiver, and refuses any caller but
///      the off-ramp it names (as a real pool asks the router).
contract StubPoolV1 {
    ERC20Mock public immutable token;
    address public immutable offRamp;

    constructor(ERC20Mock token_, address offRamp_) {
        token = token_;
        offRamp = offRamp_;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == Pool.CCIP_POOL_V1 || id == 0x01ffc9a7;
    }

    function releaseOrMint(Pool.ReleaseOrMintInV1 calldata input) external returns (Pool.ReleaseOrMintOutV1 memory) {
        require(msg.sender == offRamp, "not the off-ramp");
        token.mint(input.receiver, input.sourceDenominatedAmount);
        return Pool.ReleaseOrMintOutV1({destinationAmount: input.sourceDenominatedAmount});
    }
}

/**
 * @title  The deploy rehearsal's off-ramp stand-in (#3892)
 * @notice Runs the stand-in over the REAL vendored `Router`, copied over a
 *         stand-in "real off-ramp" address the way the rehearsal installs it,
 *         with messages built by the 2.0.0 codec. Holds the three properties
 *         the design asks of the relay's contract half: it delivers only the
 *         encoded message it is handed (checked against lane, on-ramp and
 *         addressed off-ramp), it calls the receiver with the message's own
 *         gas limit, and a failed receiver fails the delivery.
 */
contract RehearsalOffRampTest is Test {
    uint64 internal constant SRC = 3478487238524512106; // Arb Sepolia
    uint64 internal constant DST = 10344971235874465080; // Base Sepolia
    uint16 internal constant EXACT_CHECK = 5_000;

    address internal relayer = makeAddr("relayer");
    address internal realOffRamp = makeAddr("realOffRamp");
    address internal sourceOnRamp = makeAddr("sourceOnRamp");
    address internal sender = makeAddr("sender");

    Router internal router;
    StubRegistry internal registry;
    RehearsalOffRamp internal ramp;
    RMNRemote internal rmn;
    RecordingReceiver internal receiver;

    function setUp() public {
        rmn = new RMNRemote(DST, IRMN(address(0)));
        RMNProxy proxy = new RMNProxy(address(rmn));
        router = new Router(makeAddr("weth"), address(proxy));
        registry = new StubRegistry();

        // Install as the rehearsal does: deploy, then copy the runtime code
        // (immutables included) over the real off-ramp's address.
        RehearsalOffRamp built = new RehearsalOffRamp(address(router), address(registry), DST, EXACT_CHECK, address(proxy), relayer);
        vm.etch(realOffRamp, address(built).code);
        ramp = RehearsalOffRamp(realOffRamp);

        Router.OffRamp[] memory offRamps = new Router.OffRamp[](1);
        offRamps[0] = Router.OffRamp({sourceChainSelector: SRC, offRamp: realOffRamp});
        router.applyRampUpdates(new Router.OnRamp[](0), new Router.OffRamp[](0), offRamps);

        bytes[] memory onRamps = new bytes[](1);
        onRamps[0] = abi.encode(sourceOnRamp);
        vm.prank(relayer);
        ramp.allowOnRamps(SRC, onRamps);

        receiver = new RecordingReceiver();
    }

    function _message(uint32 gasLimit, bytes memory data) internal view returns (MessageV1Codec.MessageV1 memory m) {
        m.sourceChainSelector = SRC;
        m.destChainSelector = DST;
        m.messageNumber = 7;
        m.executionGasLimit = gasLimit + 100_000;
        m.ccipReceiveGasLimit = gasLimit;
        m.finality = bytes4(0);
        m.onRampAddress = abi.encode(sourceOnRamp);
        m.offRampAddress = abi.encodePacked(realOffRamp);
        m.sender = abi.encode(sender);
        m.receiver = abi.encodePacked(address(receiver));
        m.data = data;
        m.tokenTransfer = new MessageV1Codec.TokenTransferV1[](0);
    }

    function _encode(MessageV1Codec.MessageV1 memory m) internal pure returns (bytes memory) {
        return MessageV1Codec._encodeMessageV1(m);
    }

    function _deliver(bytes memory encoded) internal {
        vm.prank(relayer);
        ramp.execute(encoded);
    }

    // ── delivers the message it is handed, with that message's own gas ───

    function test_DeliversThroughTheRealRouterWithTheMessagesGasLimit() public {
        receiver.set(30_000, false);
        bytes memory encoded = _encode(_message(200_000, hex"c0ffee"));
        bytes32 id = keccak256(encoded);

        vm.recordLogs();
        _deliver(encoded);

        assertEq(receiver.calls(), 1);
        assertEq(receiver.lastId(), id, "id is the hash of the emitted bytes");
        assertEq(receiver.lastData(), hex"c0ffee");
        assertTrue(ramp.executed(id));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != RehearsalOffRamp.RehearsalDelivered.selector) continue;
            assertEq(logs[i].topics[1], id);
            (uint256 gasLimit, uint256 gasUsed, bool called) = abi.decode(logs[i].data, (uint256, uint256, bool));
            assertEq(gasLimit, 200_000);
            assertTrue(called);
            assertGt(gasUsed, 30_000);
            assertLt(gasUsed, 200_000);
            seen = true;
        }
        assertTrue(seen, "RehearsalDelivered emitted");
    }

    function test_ReceiverNeedingMoreThanTheMessagesLimitFails() public {
        receiver.set(150_000, false);
        bytes memory tight = _encode(_message(100_000, hex"01"));
        vm.prank(relayer);
        vm.expectPartialRevert(RehearsalOffRamp.ReceiverError.selector);
        ramp.execute(tight);
        assertFalse(ramp.executed(keccak256(tight)), "a failed delivery records nothing");

        // The same receiver under a limit that covers it is delivered.
        bytes memory roomy = _encode(_message(250_000, hex"01"));
        _deliver(roomy);
        assertEq(receiver.calls(), 1);
    }

    function test_FailedReceiverFailsTheStep() public {
        receiver.set(0, true);
        bytes memory encoded = _encode(_message(200_000, hex"02"));
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RehearsalOffRamp.ReceiverError.selector, abi.encodeWithSelector(RecordingReceiver.Refused.selector)
            )
        );
        ramp.execute(encoded);
        assertFalse(ramp.executed(keccak256(encoded)));
    }

    // ── refuses anything the real ramp would refuse ──────────────────────

    function test_OnlyTheRelayer() public {
        bytes memory encoded = _encode(_message(200_000, hex"03"));
        vm.expectRevert(abi.encodeWithSelector(RehearsalOffRamp.OnlyRelayer.selector, address(this)));
        ramp.execute(encoded);
    }

    function test_RefusesAMessageAddressedToAnotherOffRamp() public {
        MessageV1Codec.MessageV1 memory m = _message(200_000, hex"04");
        m.offRampAddress = abi.encodePacked(makeAddr("elsewhere"));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(RehearsalOffRamp.NotAddressedHere.selector, m.offRampAddress));
        ramp.execute(_encode(m));
    }

    function test_RefusesAnOnRampTheRealRampDidNotAllow() public {
        MessageV1Codec.MessageV1 memory m = _message(200_000, hex"05");
        m.onRampAddress = abi.encode(makeAddr("otherOnRamp"));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(RehearsalOffRamp.OnRampNotAllowed.selector, SRC, m.onRampAddress));
        ramp.execute(_encode(m));
    }

    /// @dev `OffRamp 2.0.0` checks the source chain's curse on its RMNRemote
    ///      before it executes; a cursed lane must not deliver here either.
    function test_RefusesACursedSourceChain() public {
        rmn.curse(bytes16(uint128(SRC)));
        MessageV1Codec.MessageV1 memory m = _message(200_000, hex"05");
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(RehearsalOffRamp.CursedByRMN.selector, SRC));
        ramp.execute(_encode(m));
    }

    function test_DeliversWhenAnotherChainIsCursed() public {
        rmn.curse(bytes16(uint128(SRC + 1)));
        MessageV1Codec.MessageV1 memory m = _message(200_000, hex"05");
        vm.prank(relayer);
        ramp.execute(_encode(m));
        assertTrue(ramp.executed(keccak256(_encode(m))));
    }

    function test_RefusesAnotherDestination() public {
        MessageV1Codec.MessageV1 memory m = _message(200_000, hex"06");
        m.destChainSelector = 13264668187771770619;
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(RehearsalOffRamp.WrongDestination.selector, m.destChainSelector));
        ramp.execute(_encode(m));
    }

    function test_RefusesALaneTheRouterDoesNotRouteHere() public {
        Router.OffRamp[] memory removes = new Router.OffRamp[](1);
        removes[0] = Router.OffRamp({sourceChainSelector: SRC, offRamp: realOffRamp});
        router.applyRampUpdates(new Router.OnRamp[](0), removes, new Router.OffRamp[](0));

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(RehearsalOffRamp.LaneNotRouted.selector, SRC));
        ramp.execute(_encode(_message(200_000, hex"07")));
    }

    function test_DeliversOnce() public {
        bytes memory encoded = _encode(_message(200_000, hex"08"));
        _deliver(encoded);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(RehearsalOffRamp.AlreadyExecuted.selector, keccak256(encoded)));
        ramp.execute(encoded);
    }

    // ── token transfers go through the registry's pool ───────────────────

    function test_TokenThroughThePoolMeasuredAtTheReceiver() public {
        ERC20Mock token = new ERC20Mock("T", "T", 18);
        StubPoolV1 pool = new StubPoolV1(token, realOffRamp);
        registry.setPool(address(token), address(pool));

        MessageV1Codec.MessageV1 memory m = _message(200_000, hex"09");
        m.tokenTransfer = new MessageV1Codec.TokenTransferV1[](1);
        m.tokenTransfer[0] = MessageV1Codec.TokenTransferV1({
            amount: 5e18,
            sourcePoolAddress: abi.encode(makeAddr("sourcePool")),
            sourceTokenAddress: abi.encode(makeAddr("sourceToken")),
            destTokenAddress: abi.encodePacked(address(token)),
            tokenReceiver: abi.encodePacked(address(receiver)),
            extraData: ""
        });
        _deliver(_encode(m));

        assertEq(token.balanceOf(address(receiver)), 5e18);
        assertEq(receiver.lastTokenAmount(), 5e18, "the receiver is told the measured amount");
    }

    function test_TokenOnlyTransferCallsNoReceiver() public {
        ERC20Mock token = new ERC20Mock("T", "T", 18);
        StubPoolV1 pool = new StubPoolV1(token, realOffRamp);
        registry.setPool(address(token), address(pool));

        MessageV1Codec.MessageV1 memory m = _message(0, "");
        m.tokenTransfer = new MessageV1Codec.TokenTransferV1[](1);
        m.tokenTransfer[0] = MessageV1Codec.TokenTransferV1({
            amount: 1e18,
            sourcePoolAddress: abi.encode(makeAddr("sourcePool")),
            sourceTokenAddress: abi.encode(makeAddr("sourceToken")),
            destTokenAddress: abi.encodePacked(address(token)),
            tokenReceiver: abi.encodePacked(address(receiver)),
            extraData: ""
        });
        _deliver(_encode(m));

        assertEq(token.balanceOf(address(receiver)), 1e18);
        assertEq(receiver.calls(), 0);
    }
}
