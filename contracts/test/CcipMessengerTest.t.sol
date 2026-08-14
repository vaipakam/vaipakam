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
        // still carries the real messengerA as its sender. Clear-before-
        // repoint applies here too, so this takes the two-step form.
        vm.startPrank(owner);
        messengerB.setRemoteMessenger(CHAIN_A, address(0));
        messengerB.setRemoteMessenger(CHAIN_A, address(0xDEAD));
        vm.stopPrank();

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

        // Re-pointing is clear-then-set; the reverse map must be maintained
        // across both halves — released on the clear, rebuilt on the set.
        vm.startPrank(owner);
        messengerA.setChainSelector(CHAIN_B, 0);
        assertEq(messengerA.chainIdOf(SEL_B), 0, "stale reverse cleared");
        messengerA.setChainSelector(CHAIN_B, 777);
        vm.stopPrank();
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

    // ─── setChannelPeer re-point guard (#1650) ──────────────────────────────
    //
    // Why this is guarded at all, when the sibling setters guard routing:
    // a wrong selector or handler makes messages fail to route, loudly. A
    // wrong peer routes everything perfectly and simply tells the handler the
    // wrong originator — the failure with no symptom. `setUp` has already
    // pointed messengerB's CHANNEL/CHAIN_A peer at handlerA, so these exercise
    // the LIVE-peer transitions rather than first-time assignment.

    function test_SetChannelPeer_RevertWhen_RepointingLivePeer() public {
        address other = address(0xBEEF);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.ChannelPeerAlreadySet.selector,
                CHANNEL,
                CHAIN_A,
                address(handlerA)
            )
        );
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, other);

        // The refusal must leave the old peer in place — a half-applied
        // re-point would be worse than either outcome.
        assertEq(
            messengerB.channelPeerOf(CHANNEL, CHAIN_A),
            address(handlerA),
            "refused re-point must not disturb the configured peer"
        );
    }

    function test_SetChannelPeer_ClearThenSet_Succeeds() public {
        address other = address(0xBEEF);

        // Clearing is always allowed: it is how an operator deliberately
        // takes the lane down before re-pointing it.
        vm.prank(owner);
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, address(0));
        assertEq(
            messengerB.channelPeerOf(CHANNEL, CHAIN_A),
            address(0),
            "clear must zero the peer"
        );

        vm.prank(owner);
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, other);
        assertEq(
            messengerB.channelPeerOf(CHANNEL, CHAIN_A),
            other,
            "set after clear must apply"
        );
    }

    function test_SetChannelPeer_SameValue_IsIdempotent() public {
        // A redeploy or reconfigure script that reasserts its configuration
        // must not need to know whether it has run before.
        vm.prank(owner);
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, address(handlerA));
        assertEq(
            messengerB.channelPeerOf(CHANNEL, CHAIN_A),
            address(handlerA),
            "re-setting the same peer must be a no-op, not a revert"
        );
    }

    function test_SetChannelPeer_RevertWhen_PeerBoundToAnotherChannel()
        public
    {
        // The copy-paste mistake: an operator drops an address that is
        // already channel X's peer into channel Y's empty slot. The source
        // side stamps one channel per originator, so at most one of the two
        // lanes could ever be right — reject it at configuration time.
        bytes32 otherChannel = keccak256("other-channel");
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.ChannelPeerAlreadyBound.selector,
                address(handlerA),
                CHAIN_A,
                CHANNEL
            )
        );
        messengerB.setChannelPeer(otherChannel, CHAIN_A, address(handlerA));
    }

    function test_SetChannelPeer_ReverseBindingReleasedOnClear() public {
        // Clearing must release the reverse binding, or the address could
        // never be re-declared anywhere — including on the channel it just
        // left.
        bytes32 otherChannel = keccak256("other-channel");
        vm.startPrank(owner);
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, address(0));
        messengerB.setChannelPeer(otherChannel, CHAIN_A, address(handlerA));
        vm.stopPrank();
        assertEq(
            messengerB.channelOfPeer(CHAIN_A, address(handlerA)),
            otherChannel,
            "the reverse binding must follow the peer to its new channel"
        );
    }

    // ─── Clear-before-repoint on the sibling lane setters ───────────────────
    //
    // The peer is the setting whose misconfiguration is silent, but the rule
    // is applied uniformly: no live lane setting is overwritten in place.

    function test_SetRemoteMessenger_RevertWhen_RepointingLive() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.RemoteMessengerAlreadySet.selector,
                CHAIN_A,
                address(messengerA)
            )
        );
        messengerB.setRemoteMessenger(CHAIN_A, address(0xDEAD));
    }

    function test_RegisterChannel_RevertWhen_RepointingLiveHandler() public {
        // Codex P1: `HandlerAlreadyBound` only stops one handler serving two
        // channels. Pointing a LIVE channel at a different, so-far-unbound
        // recipient used to be accepted, and if that recipient is
        // ABI-compatible the messages and tokens land there successfully.
        address stranger = address(0xBEEF);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.ChannelHandlerAlreadySet.selector,
                CHANNEL,
                address(handlerB)
            )
        );
        messengerB.registerChannel(CHANNEL, stranger);
    }

    function test_SetChainSelector_RevertWhen_RepointingLive() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.ChainSelectorAlreadySet.selector, CHAIN_A, SEL_A
            )
        );
        messengerB.setChainSelector(CHAIN_A, 4242);
    }

    // ─── Upgrade migration for the reverse peer index (#1680 r4) ────────────
    //
    // The reverse map is appended by this change, so an already-deployed
    // proxy carries a populated forward map and an empty reverse one. The
    // messenger is live on three testnets, so this transition is real.

    function test_BackfillChannelPeerIndex_PopulatesReverseMap() public {
        vm.prank(owner);
        messengerB.backfillChannelPeerIndex(
            _channels(CHANNEL), _chains(CHAIN_A)
        );
        assertEq(
            messengerB.channelOfPeer(CHAIN_A, address(handlerA)),
            CHANNEL,
            "existing forward binding must be indexed in reverse"
        );
    }

    function test_BackfillChannelPeerIndex_IsIdempotent() public {
        vm.startPrank(owner);
        messengerB.backfillChannelPeerIndex(
            _channels(CHANNEL), _chains(CHAIN_A)
        );
        vm.stopPrank();
        // A second run would revert on the reinitializer, which is the
        // point: the migration is once-only. Re-stating a pair WITHIN one
        // run is what has to be inert, so that a re-derived list overlapping
        // an earlier partial migration does not fail.
        assertEq(
            messengerB.channelOfPeer(CHAIN_A, address(handlerA)),
            CHANNEL,
            "index intact"
        );
    }

    function test_BackfillChannelPeerIndex_RevertWhen_PairUnconfigured()
        public
    {
        bytes32 ghost = keccak256("never-configured");
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.NoChannelPeer.selector, ghost, CHAIN_A
            )
        );
        messengerB.backfillChannelPeerIndex(_channels(ghost), _chains(CHAIN_A));
    }

    function test_BackfillChannelPeerIndex_RevertWhen_LengthsDiffer() public {
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = CHANNEL;
        ids[1] = CHANNEL;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.ArrayLengthMismatch.selector, uint256(2),
                uint256(1)
            )
        );
        messengerB.backfillChannelPeerIndex(ids, _chains(CHAIN_A));
    }

    function test_BackfillChannelPeerIndex_RevertWhen_ListEmpty() public {
        // An empty list would consume the one-shot `reinitializer(2)`
        // without migrating anything, leaving the proxy permanently
        // un-indexed with no way to re-run (#1680 r5 P1).
        vm.prank(owner);
        vm.expectRevert(CcipMessenger.EmptyMigration.selector);
        messengerB.backfillChannelPeerIndex(
            new bytes32[](0), new uint256[](0)
        );
    }

    function test_BackfillChannelPeerIndex_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector, stranger
            )
        );
        messengerB.backfillChannelPeerIndex(
            _channels(CHANNEL), _chains(CHAIN_A)
        );
    }

    function test_ClearPeer_DoesNotStealAnotherChannelsReverseEntry() public {
        // The un-backfilled window: channel X's forward binding exists with
        // no reverse entry, so channel Y is admitted onto the same address.
        // Clearing X must not then delete Y's reverse binding — an
        // unconditional delete did exactly that (#1680 r4 P1).
        bytes32 other = keccak256("other-channel");
        vm.startPrank(owner);
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, address(0));
        messengerB.setChannelPeer(other, CHAIN_A, address(handlerA));
        vm.stopPrank();

        // `other` now legitimately owns the reverse entry. Re-create the
        // un-migrated shape the upgrade produces — a forward binding with
        // NO reverse entry of its own — by writing `channelPeerOf` (slot 5)
        // directly. The public setter cannot reach this state on a fresh
        // deployment, which is the point: it exists only on a proxy carrying
        // pre-upgrade configuration, and that is where the bug lives.
        vm.store(
            address(messengerB),
            keccak256(
                abi.encode(
                    CHAIN_A, keccak256(abi.encode(CHANNEL, uint256(5)))
                )
            ),
            bytes32(uint256(uint160(address(handlerA))))
        );
        assertEq(
            messengerB.channelPeerOf(CHANNEL, CHAIN_A),
            address(handlerA),
            "precondition: two channels share a peer, only one indexed"
        );

        // Clearing OUR channel must not touch the entry `other` owns.
        // An unconditional `delete channelOfPeer[chain][current]` did.
        vm.prank(owner);
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, address(0));

        assertEq(
            messengerB.channelOfPeer(CHAIN_A, address(handlerA)),
            other,
            "another channel's reverse binding must survive our clear"
        );
    }

    // ─── Peer rotation is recoverable, not permanent (#1680 r4) ────────────

    function test_PeerRotation_StrandedMessageRecoverableByRollback() public {
        // Send under the old peer, then rotate without draining.
        handlerA.send{value: fee}(
            address(messengerA), CHAIN_B, abi.encode("x"), _noTokens(), 100_000
        );
        address newPeer = address(0xBEEF);
        vm.startPrank(owner);
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, address(0));
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, newPeer);
        vm.stopPrank();

        // The in-flight message is rejected — it carries the OLD originator.
        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.UnauthorizedChannelPeer.selector,
                CHANNEL,
                CHAIN_A,
                address(handlerA),
                newPeer
            )
        );
        router.deliver(0, SEL_A);

        // But it is NOT lost. Roll the peer back and it delivers. This is
        // what makes "can never be re-executed" wrong: there is no epoch
        // and no revocation, and clearing releases the reverse index so the
        // old address can be re-installed.
        vm.startPrank(owner);
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, address(0));
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, address(handlerA));
        vm.stopPrank();

        router.deliver(0, SEL_A);
        assertEq(
            handlerB.receivedCount(),
            1,
            "the stranded message is recoverable by rolling the peer back"
        );
    }

    function _channels(bytes32 id)
        internal
        pure
        returns (bytes32[] memory ids)
    {
        ids = new bytes32[](1);
        ids[0] = id;
    }

    function _chains(uint256 chainId)
        internal
        pure
        returns (uint256[] memory chains)
    {
        chains = new uint256[](1);
        chains[0] = chainId;
    }

    // ─── Originator verification on receive (#1650) ─────────────────────────
    //
    // These cover the control this change actually introduces. The suite was
    // green WITHOUT them because the happy path is unaffected — handlerA
    // sends, handlerA is the configured peer, equality holds — so an inverted
    // or deleted comparison would not have been caught.

    function test_CcipReceive_SourceSenderIsTheVerifiedOriginator() public {
        bytes memory payload = abi.encode("round-trip");
        handlerA.send{value: fee}(
            address(messengerA), CHAIN_B, payload, _noTokens(), 100_000
        );
        router.deliver(0, SEL_A);

        // Pins the encode/decode pair: what the handler is told came from
        // the remote side must be the address that actually sent it.
        assertEq(
            handlerB.lastSourceSender(),
            address(handlerA),
            "sourceSender must be the true originating handler"
        );
        assertEq(handlerB.lastPayload(), payload, "payload survives the envelope");
    }

    function test_CcipReceive_RevertWhen_PeerRotatedWhileMessageInFlight()
        public
    {
        // The scenario the wire-borne originator exists for. handlerA sends;
        // the peer is then rotated; the pending message is delivered
        // afterwards. Before this change it would have been reported to
        // handlerB as coming from the NEW peer — an authentic message
        // attributed to a contract that never sent it.
        address rotatedTo = address(0xBEEF);
        handlerA.send{value: fee}(
            address(messengerA), CHAIN_B, abi.encode("pre-rotation"), _noTokens(), 100_000
        );

        vm.startPrank(owner);
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, address(0));
        messengerB.setChannelPeer(CHANNEL, CHAIN_A, rotatedTo);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(
                CcipMessenger.UnauthorizedChannelPeer.selector,
                CHANNEL,
                CHAIN_A,
                address(handlerA),
                rotatedTo
            )
        );
        router.deliver(0, SEL_A);
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
