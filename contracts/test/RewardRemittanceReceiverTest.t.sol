// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {
    RewardRemittanceReceiver,
    IRewardBudgetIngress
} from "../src/crosschain/RewardRemittanceReceiver.sol";
import {RemitWire} from "../src/crosschain/RemitWire.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Stand-in for the CCIP adapter: the only thing the receiver checks is
///      `msg.sender == messenger`, and `initialize` requires the messenger to
///      have code — so a tiny relay contract is the cleanest fixture.
contract MockCcipRelay {
    function relay(
        RewardRemittanceReceiver r,
        uint256 srcChainId,
        address sender,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) external {
        r.onCrossChainMessage(srcChainId, sender, payload, tokens, bytes32(0));
    }

    function relayWithId(
        RewardRemittanceReceiver r,
        uint256 srcChainId,
        address sender,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens,
        bytes32 transportMessageId
    ) external {
        r.onCrossChainMessage(srcChainId, sender, payload, tokens, transportMessageId);
    }
}

/// @dev Stand-in for the mirror Diamond's rooted budget ingress — records the
///      last credit so the test can assert the forward + call.
contract MockRewardBudgetIngress is IRewardBudgetIngress {
    address public immutable vpfi;
    uint256 public lastAmount;
    uint256 public lastSourceChainId;

    constructor(address vpfi_) {
        vpfi = vpfi_;
    }

    uint256 public lastRemitId;
    address public lastRemitter;
    /// @dev The recycled component the receiver forwarded, already scaled to
    ///      what physically landed.
    uint256 public lastRecycledShare;
    /// @dev #1434 P1-a — the FRESH component the receiver forwarded: what is
    ///      left of the delivery after the scaled recycled share.
    uint256 public lastFreshShare;
    /// @dev #1566 closure 2 cutover PR 1 — the transport id the receiver
    ///      passed through, the Diamond's ingress stamp.
    bytes32 public lastTransportMessageId;
    // 3d-1 — the rooted ingress.
    bytes32 public lastRoot;
    uint256 public lastElementCount;
    uint256 public lastChunkCount;
    uint64 public lastIntendedEra;
    uint256 public rootedCalls;
    // #918 — the day's part (as Base sent it, unscaled) and its whole.
    uint256 public lastDeclaredTotal;
    uint256 public lastDeclaredRecycled;
    uint256 public lastWholeFresh;
    uint256 public lastWholeRecycled;

    function onRewardBudgetReceivedD7(
        address token,
        uint256 amount,
        bytes32 dayListRoot,
        uint256 elementCount,
        uint256 chunkCount,
        uint256 sourceChainId,
        uint256 remitId,
        address remitter,
        uint256 recycledShare,
        uint256 freshShare,
        bytes32 transportMessageId,
        uint64 intendedEra,
        uint256 declaredTotal,
        uint256 declaredRecycled,
        uint256 dayWholeFresh,
        uint256 dayWholeRecycled
    ) external override {
        require(token == vpfi, "ingress: token");
        lastAmount = amount;
        lastRoot = dayListRoot;
        lastElementCount = elementCount;
        lastChunkCount = chunkCount;
        lastSourceChainId = sourceChainId;
        lastRemitId = remitId;
        lastRemitter = remitter;
        lastRecycledShare = recycledShare;
        lastFreshShare = freshShare;
        lastTransportMessageId = transportMessageId;
        lastIntendedEra = intendedEra;
        lastDeclaredTotal = declaredTotal;
        lastDeclaredRecycled = declaredRecycled;
        lastWholeFresh = dayWholeFresh;
        lastWholeRecycled = dayWholeRecycled;
        rootedCalls++;
    }
}

/// @title RewardRemittanceReceiverTest — #776 PR2 (mirror receiver) unit coverage.
/// @notice Exercises the inbound CCIP token path: messenger-gated delivery,
///         declared-vs-delivered token/amount validation, fee-on-transfer-safe
///         forward into the Diamond, the ingress call, and the pause lever.
contract RewardRemittanceReceiverTest is Test {
    RewardRemittanceReceiver internal receiver;
    MockCcipRelay internal messenger;
    MockRewardBudgetIngress internal diamond;
    ERC20Mock internal vpfi;

    address internal owner = address(this);
    address internal guardian = address(0x6A1D);
    uint256 internal constant SRC_BASE = 8453;

    function setUp() public {
        vpfi = new ERC20Mock("Vaipakam", "VPFI", 18);
        messenger = new MockCcipRelay();
        diamond = new MockRewardBudgetIngress(address(vpfi));

        RewardRemittanceReceiver impl = new RewardRemittanceReceiver();
        receiver = RewardRemittanceReceiver(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        RewardRemittanceReceiver.initialize,
                        (owner, address(messenger), address(diamond), address(vpfi))
                    )
                )
            )
        );
        receiver.setGuardian(guardian);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    function _days(uint256 a, uint256 b) internal pure returns (uint256[] memory d) {
        d = new uint256[](2);
        d[0] = a;
        d[1] = b;
    }

    function _tokens(address token, uint256 amount)
        internal
        pure
        returns (ICrossChainMessenger.TokenAmount[] memory t)
    {
        t = new ICrossChainMessenger.TokenAmount[](1);
        t[0] = ICrossChainMessenger.TokenAmount({token: token, amount: amount});
    }

    /// @dev The real CCIP adapter transfers the tokens to the receiver BEFORE
    ///      the callback, so a test delivery must pre-fund the receiver.
    function _deliver(uint256 amount, uint256 declaredTotal) internal {
        vpfi.mint(address(receiver), amount);
        messenger.relay(
            receiver,
            SRC_BASE,
            address(0xBA5E), // sourceSender — receiver ignores it (peer check is on the messenger)
            _d6Payload(declaredTotal),
            _tokens(address(vpfi), declaredTotal)
        );
    }

    /// @dev A d7 (rooted) budget payload declaring `total`, wholly fresh,
    ///      as its day's one part.
    function _d6Payload(uint256 total) internal pure returns (bytes memory) {
        return _d7(bytes32(uint256(1)), 2, 1, total, 0, address(0xD1A), 0, 0);
    }

    /// @dev A d7 payload carrying its day's whole as its one part.
    function _d7(
        bytes32 root,
        uint256 elementCount,
        uint256 chunkCount,
        uint256 total,
        uint256 remitId,
        address remitter,
        uint256 recycled,
        uint64 era
    ) internal pure returns (bytes memory) {
        return RemitWire.encodeD7(
            RemitWire.D7({
                dayListRoot: root,
                elementCount: elementCount,
                chunkCount: chunkCount,
                total: total,
                remitId: remitId,
                remitter: remitter,
                recycledShare: recycled,
                intendedEra: era,
                dayWholeFresh: total - recycled,
                dayWholeRecycled: recycled
            })
        );
    }

    // ── happy path ───────────────────────────────────────────────────────────

    function test_Deliver_ForwardsToDiamondAndCallsIngress() public {
        _deliver(1_000e18, 1_000e18);
        assertEq(vpfi.balanceOf(address(diamond)), 1_000e18, "diamond funded");
        assertEq(vpfi.balanceOf(address(receiver)), 0, "receiver drained");
        assertEq(diamond.rootedCalls(), 1, "ingress called once");
        assertEq(diamond.lastAmount(), 1_000e18, "credited amount");
        assertEq(diamond.lastSourceChainId(), SRC_BASE, "source chain");
        assertEq(diamond.lastElementCount(), 2, "day count");
    }

    /// @dev #1566 closure 2 cutover PR 1 — the transport's message id crosses both
    /// seams unchanged: adapter → receiver → Diamond ingress.
    function test_Deliver_ForwardsTheTransportMessageId() public {
        vpfi.mint(address(receiver), 1e18);
        bytes32 id = keccak256("ccip-message-1");
        messenger.relayWithId(
            receiver, SRC_BASE, address(0xBA5E), _d6Payload(1e18), _tokens(address(vpfi), 1e18), id
        );
        assertEq(diamond.lastTransportMessageId(), id, "the id reached the Diamond ingress");
        assertEq(diamond.rootedCalls(), 1);
    }

    /// @dev #1566 transport epochs 3d-1 — the d6 (ROOTED) shape takes its own
    ///      frame and its own Diamond ingress: the commitment, the extent, the
    ///      typed split and the era all surface, and the fresh component is
    ///      what is left of the delivery after the recycled share.
    function test_Deliver_D6PayloadReachesTheRootedIngress() public {
        vpfi.mint(address(receiver), 500e18);
        messenger.relayWithId(
            receiver,
            SRC_BASE,
            address(0xBA5E),
            _d7(bytes32(uint256(0xBEEF)), 33, 3, 500e18, 78, address(0xD1A), 120e18, 4),
            _tokens(address(vpfi), 500e18),
            keccak256("d6-msg")
        );
        assertEq(diamond.rootedCalls(), 1, "the rooted ingress, once");
        assertEq(diamond.lastAmount(), 500e18);
        assertEq(diamond.lastRoot(), bytes32(uint256(0xBEEF)), "the root surfaces");
        assertEq(diamond.lastElementCount(), 33, "and the extent");
        assertEq(diamond.lastChunkCount(), 3);
        assertEq(diamond.lastRemitId(), 78);
        assertEq(diamond.lastRemitter(), address(0xD1A));
        assertEq(diamond.lastRecycledShare(), 120e18, "the recycled share as sent");
        assertEq(diamond.lastFreshShare(), 380e18, "fresh is the remainder of what landed");
        assertEq(diamond.lastIntendedEra(), 4, "the era surfaces");
        assertEq(diamond.lastTransportMessageId(), keccak256("d6-msg"));
        assertEq(diamond.lastDeclaredTotal(), 500e18, "#918: the part as sent");
        assertEq(diamond.lastDeclaredRecycled(), 120e18);
        assertEq(diamond.lastWholeFresh(), 380e18, "and the day's whole");
        assertEq(diamond.lastWholeRecycled(), 120e18);
        assertEq(vpfi.balanceOf(address(diamond)), 500e18, "the tokens were forwarded");
    }

    /// @dev A short delivery scales the recycled share and gives the fresh
    ///      share the rest, so the two always account for the whole delivery —
    ///      the rooted ingress holds the whole delivery as one epoch typed by
    ///      exactly those two caps.
    function test_Deliver_D6ShortDelivery_KeepsTheSplitWhole() public {
        vpfi.mint(address(receiver), 300e18); // declared 500, only 300 to forward
        messenger.relay(
            receiver,
            SRC_BASE,
            address(0xBA5E),
            _d7(bytes32(uint256(1)), 2, 1, 500e18, 79, address(0xD1A), 120e18, 0),
            _tokens(address(vpfi), 500e18)
        );
        assertEq(diamond.lastAmount(), 300e18, "what landed");
        assertEq(diamond.lastRecycledShare(), 72e18, "recycled scaled to what landed");
        assertEq(diamond.lastFreshShare(), 228e18, "fresh is the rest");
        assertEq(diamond.lastRecycledShare() + diamond.lastFreshShare(), diamond.lastAmount(), "whole");
        assertEq(diamond.lastDeclaredTotal(), 500e18, "#918: the declared part is NOT scaled");
        assertEq(diamond.lastDeclaredRecycled(), 120e18, "it is what Base sent for the day");
    }

    /// @dev Every budget shape older than d6 is refused by name, before any
    ///      token moves: the untagged legacy 2-tuple (head word 0x40), the
    ///      untagged d2 4-tuple (0x80) and the tagged d5 payload. All three
    ///      carried a flat day list, and the two untagged ones no split; the
    ///      Diamond ingress that took them is gone. CCIP records the refusal as
    ///      a failed message rather than delivering it.
    function test_Deliver_RefusesEveryPreD7BudgetShape() public {
        uint256 d5Tag = uint256(keccak256("vaipakam.remit.wire.d5"));
        // #918 retired d6 outright: the literal tag, since the codec no longer
        // names it.
        uint256 d6Tag = uint256(keccak256("vaipakam.remit.wire.d6"));
        bytes[] memory shapes = new bytes[](4);
        shapes[0] = abi.encode(_days(1, 2), uint256(1e18));
        shapes[1] = abi.encode(_days(1, 2), uint256(1e18), uint256(77), address(0xD1A));
        shapes[2] = abi.encode(d5Tag, _days(1, 2), uint256(1e18), uint256(77), address(0xD1A), uint256(1e17));
        shapes[3] = abi.encode(
            d6Tag, bytes32(uint256(1)), uint256(2), uint256(1), uint256(1e18), uint256(77), address(0xD1A), uint256(0), uint256(0)
        );
        uint256[4] memory heads = [uint256(0x40), uint256(0x80), d5Tag, d6Tag];
        vpfi.mint(address(receiver), 1e18);
        for (uint256 i; i < shapes.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(RewardRemittanceReceiver.UnknownRemitWireShape.selector, heads[i]));
            messenger.relay(receiver, SRC_BASE, address(0xBA5E), shapes[i], _tokens(address(vpfi), 1e18));
        }
        assertEq(diamond.rootedCalls(), 0, "nothing reached the Diamond");
        assertEq(vpfi.balanceOf(address(receiver)), 1e18, "and no token moved");
    }

    // ── auth / validation reverts ────────────────────────────────────────────

    function test_Deliver_RevertsWhenCallerNotMessenger() public {
        vpfi.mint(address(receiver), 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceReceiver.NotMessenger.selector,
                address(this)
            )
        );
        receiver.onCrossChainMessage(
            SRC_BASE,
            address(0xBA5E),
            _d6Payload(1e18),
            _tokens(address(vpfi), 1e18)
        , bytes32(0));
    }

    function test_Deliver_RevertsOnWrongTokenCount() public {
        ICrossChainMessenger.TokenAmount[] memory none =
            new ICrossChainMessenger.TokenAmount[](0);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceReceiver.WrongTokenCount.selector,
                uint256(0)
            )
        );
        messenger.relay(receiver, SRC_BASE, address(0xBA5E), _d6Payload(1e18), none);
    }

    function test_Deliver_RevertsOnTokenMismatch() public {
        ERC20Mock other = new ERC20Mock("Other", "OTH", 18);
        other.mint(address(receiver), 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceReceiver.TokenMismatch.selector,
                address(vpfi),
                address(other)
            )
        );
        messenger.relay(
            receiver,
            SRC_BASE,
            address(0xBA5E),
            _d6Payload(1e18),
            _tokens(address(other), 1e18)
        );
    }

    function test_Deliver_RevertsOnAmountMismatch() public {
        // delivered token amount (900) != payload declared total (1000)
        vpfi.mint(address(receiver), 900e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceReceiver.AmountMismatch.selector,
                uint256(1_000e18),
                uint256(900e18)
            )
        );
        messenger.relay(
            receiver,
            SRC_BASE,
            address(0xBA5E),
            _d6Payload(1_000e18),
            _tokens(address(vpfi), 900e18)
        );
    }

    function test_Deliver_RevertsOnZeroAmount() public {
        vm.expectRevert(RewardRemittanceReceiver.ZeroAmount.selector);
        messenger.relay(
            receiver,
            SRC_BASE,
            address(0xBA5E),
            _d6Payload(0),
            _tokens(address(vpfi), 0)
        );
    }

    // ── pause lever ──────────────────────────────────────────────────────────

    function test_Deliver_RevertsWhenPaused() public {
        vm.prank(guardian);
        receiver.pause();
        vpfi.mint(address(receiver), 1e18);
        vm.expectRevert();
        messenger.relay(
            receiver,
            SRC_BASE,
            address(0xBA5E),
            _d6Payload(1e18),
            _tokens(address(vpfi), 1e18)
        );
    }

    function test_Pause_GuardianCanPause_OwnerUnpauses() public {
        vm.prank(guardian);
        receiver.pause();
        // guardian cannot unpause (owner-only) — then owner resumes.
        vm.prank(guardian);
        vm.expectRevert();
        receiver.unpause();
        receiver.unpause(); // owner (this)
        _deliver(5e18, 5e18);
        assertEq(diamond.rootedCalls(), 1, "resumes after unpause");
    }
}
