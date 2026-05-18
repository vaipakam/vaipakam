// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

import {CcipMessenger} from "../src/crosschain/CcipMessenger.sol";
import {GuardianPausable} from "../src/crosschain/GuardianPausable.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {MockCcipRouter} from "./mocks/MockCcipRouter.sol";
import {MockCrossChainRecipient} from "./mocks/MockCrossChainRecipient.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title CcipMessengerTest
 * @notice T-068 Phase 1 — unit tests for the {CcipMessenger} CCIP adapter,
 *         the single CCIP-aware contract behind the {ICrossChainMessenger}
 *         port. Two messengers ("chain A" and "chain B") share one
 *         {MockCcipRouter}; {MockCrossChainRecipient} handlers stand in for
 *         the domain contracts. Covers send / quote / receive, the routing
 *         envelope, every forgery guard, fee handling, pause, and the
 *         receive→send path the buy flow depends on.
 */
contract CcipMessengerTest is Test {
    // Logical chains under test (the messengers actually run on the
    // foundry default chain id; routing keys off the configured selectors).
    uint256 internal constant CHAIN_A = 8453; // "Base"
    uint256 internal constant CHAIN_B = 1; // "Ethereum"
    uint64 internal constant SEL_A = 15971525489660198786;
    uint64 internal constant SEL_B = 5009297550715157269;
    bytes32 internal constant CHANNEL = keccak256("vpfi-buy");

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");

    MockCcipRouter internal router;
    CcipMessenger internal messengerA;
    CcipMessenger internal messengerB;
    MockCrossChainRecipient internal handlerA;
    MockCrossChainRecipient internal handlerB;
    ERC20Mock internal token;

    uint256 internal fee;

    function setUp() public {
        router = new MockCcipRouter();
        router.setSupported(SEL_A, true);
        router.setSupported(SEL_B, true);
        fee = router.fixedFee();

        messengerA = _deployMessenger();
        messengerB = _deployMessenger();
        handlerA = new MockCrossChainRecipient();
        handlerB = new MockCrossChainRecipient();
        token = new ERC20Mock("Test", "TST", 18);

        vm.startPrank(owner);
        // messengerA is configured for the lane to chain B.
        messengerA.setChainSelector(CHAIN_B, SEL_B);
        messengerA.setRemoteMessenger(CHAIN_B, address(messengerB));
        messengerA.registerChannel(CHANNEL, address(handlerA));
        messengerA.setChannelPeer(CHANNEL, CHAIN_B, address(handlerB));
        messengerA.setGuardian(guardian);
        // messengerB is configured for the lane to chain A.
        messengerB.setChainSelector(CHAIN_A, SEL_A);
        messengerB.setRemoteMessenger(CHAIN_A, address(messengerA));
        messengerB.registerChannel(CHANNEL, address(handlerB));
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, address(handlerA));
        messengerB.setGuardian(guardian);
        vm.stopPrank();

        vm.deal(address(handlerA), 10 ether);
        vm.deal(address(handlerB), 10 ether);
        vm.deal(stranger, 10 ether);
    }

    function _deployMessenger() internal returns (CcipMessenger) {
        CcipMessenger impl = new CcipMessenger(address(router));
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(CcipMessenger.initialize, (owner))
        );
        return CcipMessenger(address(proxy));
    }

    function _noTokens()
        internal
        pure
        returns (ICrossChainMessenger.TokenAmount[] memory)
    {
        return new ICrossChainMessenger.TokenAmount[](0);
    }

    function _oneToken(
        address t,
        uint256 amount
    ) internal pure returns (ICrossChainMessenger.TokenAmount[] memory toks) {
        toks = new ICrossChainMessenger.TokenAmount[](1);
        toks[0] = ICrossChainMessenger.TokenAmount({token: t, amount: amount});
    }

    // ─── Send / receive happy paths ─────────────────────────────────────────

    function test_SendMessage_DataOnly_RoundTrip() public {
        bytes memory payload = abi.encode("hello", uint256(42));

        vm.prank(address(handlerA));
        handlerA.send{value: fee}(
            address(messengerA), CHAIN_B, payload, _noTokens(), 200_000
        );
        assertEq(router.pendingCount(), 1, "one message captured");

        router.deliver(0, SEL_A);

        assertEq(handlerB.receivedCount(), 1, "handler B received once");
        assertEq(handlerB.lastSourceChainId(), CHAIN_A, "source chain id");
        assertEq(
            handlerB.lastSourceSender(),
            address(handlerA),
            "source sender = the configured channel peer"
        );
        assertEq(handlerB.lastPayload(), payload, "payload delivered verbatim");
    }

    function test_SendMessage_WithTokens_RoundTrip() public {
        uint256 amount = 1_000e18;
        token.mint(address(handlerA), amount);
        handlerA.approve(address(token), address(messengerA), amount);

        handlerA.send{value: fee}(
            address(messengerA),
            CHAIN_B,
            abi.encode("buy"),
            _oneToken(address(token), amount),
            200_000
        );
        // The adapter pulled the tokens from the handler.
        assertEq(token.balanceOf(address(handlerA)), 0, "handler debited");

        router.deliver(0, SEL_A);

        // CCIP delivers tokens to the dest adapter, which forwards them to
        // the handler BEFORE the callback.
        assertEq(
            token.balanceOf(address(handlerB)), amount, "handler B credited"
        );
        assertEq(handlerB.lastTokenIn(), address(token), "token recorded");
        assertEq(handlerB.lastTokenAmount(), amount, "amount recorded");
    }

    function test_QuoteMessageFee_ReturnsRouterFee() public view {
        uint256 q = handlerA.quote(
            address(messengerA), CHAIN_B, abi.encode("x"), _noTokens(), 100_000
        );
        assertEq(q, fee, "quote == router fee");
    }

    function test_LocalChainId_IsBlockChainId() public view {
        assertEq(messengerA.localChainId(), block.chainid);
    }

    // ─── Fee handling ───────────────────────────────────────────────────────

    function test_SendMessage_RefundsOverpayment() public {
        // The test contract funds the `send` call; handlerA forwards the
        // whole `fee + overpay`, so handlerA's net delta isolates exactly
        // the refund it gets back. With no refund the delta would be 0;
        // with a correct refund it is exactly `overpay`.
        uint256 before = address(handlerA).balance;
        uint256 overpay = 0.5 ether;

        handlerA.send{value: fee + overpay}(
            address(messengerA), CHAIN_B, abi.encode("x"), _noTokens(), 100_000
        );

        assertEq(
            address(handlerA).balance,
            before + overpay,
            "exactly the overpayment refunded"
        );
        // Only `fee` left the system — the router (mock) kept it.
        assertEq(address(router).balance, fee, "router kept exactly the fee");
    }

    function test_SendMessage_RevertWhen_InsufficientFee() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.InsufficientFee.selector, fee - 1, fee
            )
        );
        handlerA.send{value: fee - 1}(
            address(messengerA), CHAIN_B, abi.encode("x"), _noTokens(), 100_000
        );
    }

    // ─── Forgery / misconfiguration guards ──────────────────────────────────

    function test_SendMessage_RevertWhen_CallerNotHandler() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.CallerNotHandler.selector, stranger
            )
        );
        messengerA.sendMessage{value: fee}(
            CHAIN_B, abi.encode("x"), _noTokens(), 100_000
        );
    }

    function test_SendMessage_RevertWhen_UnconfiguredChain() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.UnconfiguredChain.selector, uint256(999)
            )
        );
        handlerA.send{value: fee}(
            address(messengerA), 999, abi.encode("x"), _noTokens(), 100_000
        );
    }

    function test_CcipReceive_RevertWhen_NotRouter() public {
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: bytes32(uint256(1)),
            sourceChainSelector: SEL_A,
            sender: abi.encode(address(messengerA)),
            data: abi.encode(CHANNEL, abi.encode("x")),
            destTokenAmounts: new Client.EVMTokenAmount[](0)
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                CCIPReceiver.InvalidRouter.selector, address(this)
            )
        );
        messengerB.ccipReceive(m);
    }

    function test_CcipReceive_RevertWhen_UnauthorizedSourceMessenger() public {
        handlerA.send{value: fee}(
            address(messengerA), CHAIN_B, abi.encode("x"), _noTokens(), 100_000
        );
        // Re-point chain A's messenger to an impostor — the inbound message
        // still carries the real messengerA as its sender.
        vm.prank(owner);
        messengerB.setRemoteMessenger(CHAIN_A, address(0xDEAD));

        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.UnauthorizedSourceMessenger.selector,
                SEL_A,
                address(messengerA)
            )
        );
        router.deliver(0, SEL_A);
    }

    function test_CcipReceive_RevertWhen_UnconfiguredSelector() public {
        handlerA.send{value: fee}(
            address(messengerA), CHAIN_B, abi.encode("x"), _noTokens(), 100_000
        );
        // Deliver claiming an origin selector messengerB has no mapping for.
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.UnconfiguredSelector.selector, uint64(999)
            )
        );
        router.deliver(0, 999);
    }

    function test_CcipReceive_RevertWhen_UnknownChannel() public {
        handlerA.send{value: fee}(
            address(messengerA), CHAIN_B, abi.encode("x"), _noTokens(), 100_000
        );
        vm.prank(owner);
        messengerB.registerChannel(CHANNEL, address(0));

        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.UnknownChannel.selector, CHANNEL
            )
        );
        router.deliver(0, SEL_A);
    }

    function test_CcipReceive_RevertWhen_NoChannelPeer() public {
        handlerA.send{value: fee}(
            address(messengerA), CHAIN_B, abi.encode("x"), _noTokens(), 100_000
        );
        vm.prank(owner);
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, address(0));

        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.NoChannelPeer.selector, CHANNEL, CHAIN_A
            )
        );
        router.deliver(0, SEL_A);
    }

    // ─── Pause ──────────────────────────────────────────────────────────────

    function test_Pause_FreezesSend() public {
        vm.prank(guardian);
        messengerA.pause();

        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        handlerA.send{value: fee}(
            address(messengerA), CHAIN_B, abi.encode("x"), _noTokens(), 100_000
        );
    }

    function test_Pause_FreezesReceive_ThenReExecutable() public {
        handlerA.send{value: fee}(
            address(messengerA), CHAIN_B, abi.encode("x"), _noTokens(), 100_000
        );
        vm.prank(guardian);
        messengerB.pause();

        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        router.deliver(0, SEL_A);
        assertEq(handlerB.receivedCount(), 0, "frozen - nothing delivered");

        // Unpause and re-execute — CCIP messages survive a pause window.
        vm.prank(owner);
        messengerB.unpause();
        router.deliver(0, SEL_A);
        assertEq(handlerB.receivedCount(), 1, "delivered after unpause");
    }

    function test_Pause_GuardianCanPause_OnlyOwnerCanUnpause() public {
        vm.prank(guardian);
        messengerA.pause();

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                guardian
            )
        );
        messengerA.unpause();

        vm.prank(owner);
        messengerA.unpause();
        assertFalse(messengerA.paused(), "owner unpaused");
    }

    function test_Pause_RevertWhen_StrangerPauses() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                GuardianPausable.NotGuardianOrOwner.selector, stranger
            )
        );
        messengerA.pause();
    }

    // ─── receive → send (no shared-guard deadlock) ──────────────────────────

    function test_ReceiveThenSend_NoDeadlock() public {
        // handler B will, inside its inbound callback, send a message back.
        handlerB.armResend(
            address(messengerB), CHAIN_A, abi.encode("ack"), 100_000, fee
        );

        handlerA.send{value: fee}(
            address(messengerA), CHAIN_B, abi.encode("req"), _noTokens(), 200_000
        );
        router.deliver(0, SEL_A);

        assertEq(handlerB.receivedCount(), 1, "inbound handled");
        assertEq(router.pendingCount(), 2, "and the resend went out");
    }

    // ─── Admin config ───────────────────────────────────────────────────────

    function test_SetChainSelector_MaintainsReverseMap() public {
        assertEq(messengerA.chainIdOf(SEL_B), CHAIN_B, "reverse set");

        vm.prank(owner);
        messengerA.setChainSelector(CHAIN_B, 777);
        assertEq(messengerA.chainIdOf(SEL_B), 0, "stale reverse cleared");
        assertEq(messengerA.chainIdOf(777), CHAIN_B, "new reverse set");
    }

    function test_AdminSetters_RevertWhen_NotOwner() public {
        vm.startPrank(stranger);
        bytes memory err = abi.encodeWithSelector(
            OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger
        );
        vm.expectRevert(err);
        messengerA.setChainSelector(5, 5);
        vm.expectRevert(err);
        messengerA.setRemoteMessenger(5, address(1));
        vm.expectRevert(err);
        messengerA.registerChannel(CHANNEL, address(1));
        vm.expectRevert(err);
        messengerA.setChannelPeer(CHANNEL, 5, address(1));
        vm.stopPrank();
    }

    function test_Initialize_RevertWhen_CalledTwice() public {
        vm.expectRevert();
        messengerA.initialize(owner);
    }

    // ─── Config-integrity guards (Codex review — one-to-one maps) ───────────

    function test_SetChainSelector_RevertWhen_SelectorBoundToAnotherChain()
        public
    {
        // SEL_B is already bound to CHAIN_B in setUp. Binding it to a
        // second chain would orphan CHAIN_B's lane — rejected.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.SelectorAlreadyBound.selector, SEL_B, CHAIN_B
            )
        );
        messengerA.setChainSelector(999, SEL_B);

        // Re-binding the SAME chain to its own selector stays idempotent.
        vm.prank(owner);
        messengerA.setChainSelector(CHAIN_B, SEL_B);
        assertEq(messengerA.chainIdOf(SEL_B), CHAIN_B, "still one-to-one");
    }

    function test_RegisterChannel_RevertWhen_HandlerBoundToAnotherChannel()
        public
    {
        // handlerA is already registered on CHANNEL in setUp.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.HandlerAlreadyBound.selector,
                address(handlerA),
                CHANNEL
            )
        );
        messengerA.registerChannel(keccak256("other-channel"), address(handlerA));
    }

    function test_SendMessage_RevertWhen_DuplicateToken() public {
        // A token list naming the same address twice — `forceApprove`
        // replaces (not accumulates) the allowance, so this is rejected.
        uint256 amount = 1_000e18;
        token.mint(address(handlerA), 2 * amount);
        handlerA.approve(address(token), address(messengerA), 2 * amount);

        ICrossChainMessenger.TokenAmount[] memory dup =
            new ICrossChainMessenger.TokenAmount[](2);
        dup[0] =
            ICrossChainMessenger.TokenAmount({token: address(token), amount: amount});
        dup[1] =
            ICrossChainMessenger.TokenAmount({token: address(token), amount: amount});

        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.DuplicateToken.selector, address(token)
            )
        );
        handlerA.send{value: fee}(
            address(messengerA), CHAIN_B, abi.encode("x"), dup, 200_000
        );
    }
}
