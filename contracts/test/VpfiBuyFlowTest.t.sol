// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {CcipMessenger} from "../src/crosschain/CcipMessenger.sol";
import {VpfiBuyAdapter} from "../src/crosschain/VpfiBuyAdapter.sol";
import {VpfiBuyReceiver} from "../src/crosschain/VpfiBuyReceiver.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {MockCcipRouter} from "./mocks/MockCcipRouter.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @dev Stand-in for the Base Diamond's `processBridgedBuy`. On success it
 *      "mints" vpfi to its caller (the receiver), mirroring the real
 *      Diamond which mints the canonical vpfi onto the receiver contract.
 */
contract MockBuyDiamond {
    ERC20Mock public immutable vpfi;
    bool public willRevert;
    uint256 public fixedOut = 1_000 ether;

    constructor(ERC20Mock vpfi_) {
        vpfi = vpfi_;
    }

    function setRevert(bool v) external {
        willRevert = v;
    }

    function setFixedOut(uint256 v) external {
        fixedOut = v;
    }

    function processBridgedBuy(
        address,
        uint32,
        uint256,
        uint256 minVpfiOut
    ) external returns (uint256) {
        require(!willRevert, "diamond: rejected");
        require(fixedOut >= minVpfiOut, "diamond: slippage");
        vpfi.mint(msg.sender, fixedOut);
        return fixedOut;
    }
}

/**
 * @title VpfiBuyFlowTest
 * @notice T-068 Phase 3 — end-to-end integration tests for the CCIP
 *         fixed-rate buy flow. Two real {CcipMessenger}s ("mirror" and
 *         "Base") over one {MockCcipRouter} carry the two legs between a
 *         real {VpfiBuyAdapter} and {VpfiBuyReceiver}. Covers the happy
 *         path, the BUY_FAILED refund, and the design-§5 two-step release
 *         guard (forged / replayed deliveries park as stuck).
 */
contract VpfiBuyFlowTest is Test {
    uint256 internal constant MIRROR = 1; // "Ethereum"
    uint256 internal constant BASE = 8453; // "Base"
    uint64 internal constant SEL_MIRROR = 5009297550715157269;
    uint64 internal constant SEL_BASE = 15971525489660198786;
    bytes32 internal constant CHANNEL =
        keccak256("vaipakam.ccip.channel.vpfi-buy");

    uint256 internal constant GAS = 500_000;
    uint64 internal constant TIMEOUT = 15 minutes;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal buyer = makeAddr("buyer");

    MockCcipRouter internal router;
    CcipMessenger internal messengerMirror;
    CcipMessenger internal messengerBase;
    VpfiBuyAdapter internal adapter;
    VpfiBuyReceiver internal receiver;
    MockBuyDiamond internal diamond;
    ERC20Mock internal vpfi;

    uint256 internal fee;

    function setUp() public {
        router = new MockCcipRouter();
        router.setSupported(SEL_MIRROR, true);
        router.setSupported(SEL_BASE, true);
        fee = router.fixedFee();

        vpfi = new ERC20Mock("Vaipakam DeFi Token", "vpfi", 18);
        diamond = new MockBuyDiamond(vpfi);

        messengerMirror = _deployMessenger();
        messengerBase = _deployMessenger();

        adapter = _deployAdapter();
        receiver = _deployReceiver();

        vm.startPrank(owner);
        // Mirror messenger ⇄ Base.
        messengerMirror.setChainSelector(BASE, SEL_BASE);
        messengerMirror.setRemoteMessenger(BASE, address(messengerBase));
        messengerMirror.registerChannel(CHANNEL, address(adapter));
        messengerMirror.setChannelPeer(CHANNEL, BASE, address(receiver));
        // Base messenger ⇄ mirror.
        messengerBase.setChainSelector(MIRROR, SEL_MIRROR);
        messengerBase.setRemoteMessenger(MIRROR, address(messengerMirror));
        messengerBase.registerChannel(CHANNEL, address(receiver));
        messengerBase.setChannelPeer(CHANNEL, MIRROR, address(adapter));
        vm.stopPrank();

        vm.deal(buyer, 100 ether);
        vm.deal(address(receiver), 10 ether); // leg-2 fee float
    }

    function _deployMessenger() internal returns (CcipMessenger) {
        CcipMessenger impl = new CcipMessenger(address(router));
        return CcipMessenger(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(CcipMessenger.initialize, (owner))
                )
            )
        );
    }

    function _deployAdapter() internal returns (VpfiBuyAdapter) {
        VpfiBuyAdapter impl = new VpfiBuyAdapter();
        return VpfiBuyAdapter(
            payable(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        VpfiBuyAdapter.initialize,
                        (
                            owner,
                            address(messengerMirror),
                            BASE,
                            treasury,
                            address(0), // native-ETH mode
                            address(vpfi),
                            TIMEOUT,
                            GAS
                        )
                    )
                )
            )
        );
    }

    function _deployReceiver() internal returns (VpfiBuyReceiver) {
        VpfiBuyReceiver impl = new VpfiBuyReceiver();
        return VpfiBuyReceiver(
            payable(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        VpfiBuyReceiver.initialize,
                        (owner, address(messengerBase), address(diamond), address(vpfi), GAS)
                    )
                )
            )
        );
    }

    /// @dev Drive a captured leg from the router into its destination.
    function _deliver(uint256 index, uint64 sourceSelector) internal {
        router.deliver(index, sourceSelector);
    }

    // ─── Happy path ─────────────────────────────────────────────────────────

    function test_BuyFlow_HappyPath() public {
        uint256 amountIn = 1 ether;
        uint256 treasuryBefore = treasury.balance;

        vm.prank(buyer);
        (uint64 requestId, ) =
            adapter.buy{value: amountIn + fee}(amountIn, 0);
        assertEq(requestId, 1, "first request id");
        assertEq(router.pendingCount(), 1, "leg-1 captured");

        // Leg 1 — BUY_REQUEST → Base. The receiver mints + dispatches leg 2.
        _deliver(0, SEL_MIRROR);
        assertEq(router.pendingCount(), 2, "leg-2 dispatched");

        // Leg 2 — vpfi delivery → mirror. The adapter releases to the buyer.
        _deliver(1, SEL_BASE);

        assertEq(vpfi.balanceOf(buyer), 1_000 ether, "buyer received vpfi");
        assertEq(
            treasury.balance, treasuryBefore + amountIn, "payment released"
        );
        assertEq(adapter.totalPendingAmountIn(), 0, "no pending left");
        ( , , , VpfiBuyAdapter.BuyStatus status) = adapter.pendingBuys(1);
        assertEq(
            uint8(status),
            uint8(VpfiBuyAdapter.BuyStatus.ResolvedSuccess),
            "buy resolved success"
        );
    }

    // ─── BUY_FAILED → refund ────────────────────────────────────────────────

    function test_BuyFlow_DiamondRejects_RefundsBuyer() public {
        diamond.setRevert(true);
        uint256 amountIn = 1 ether;
        uint256 buyerBefore = buyer.balance;

        vm.prank(buyer);
        adapter.buy{value: amountIn + fee}(amountIn, 0);

        _deliver(0, SEL_MIRROR); // BUY_REQUEST → Base rejects → BUY_FAILED
        _deliver(1, SEL_BASE); // BUY_FAILED → adapter refunds

        // The buyer is made whole for `amountIn` (they still spent `fee`).
        assertEq(buyer.balance, buyerBefore - fee, "amountIn refunded");
        assertEq(vpfi.balanceOf(buyer), 0, "no vpfi on a failed buy");
        ( , , , VpfiBuyAdapter.BuyStatus status) = adapter.pendingBuys(1);
        assertEq(
            uint8(status),
            uint8(VpfiBuyAdapter.BuyStatus.ResolvedRefunded),
            "buy resolved refunded"
        );
    }

    // ─── Two-step release guard ─────────────────────────────────────────────

    /// @dev A one-token list — the shape of a leg-2 vpfi delivery.
    function _vpfiTokens(
        uint256 amount
    ) internal view returns (ICrossChainMessenger.TokenAmount[] memory t) {
        t = new ICrossChainMessenger.TokenAmount[](1);
        t[0] = ICrossChainMessenger.TokenAmount({
            token: address(vpfi),
            amount: amount
        });
    }

    function test_TwoStep_ForgedDelivery_ParksStuck() public {
        // Simulate the messenger delivering a leg-2 vpfi transfer for a
        // requestId the adapter NEVER originated — the forged-message
        // case. The messenger forwards the tokens to the handler before
        // the callback, so mint them onto the adapter first.
        uint256 amount = 500 ether;
        vpfi.mint(address(adapter), amount);

        vm.prank(address(messengerMirror));
        adapter.onCrossChainMessage(
            BASE, address(receiver), abi.encode(uint64(99)), _vpfiTokens(amount)
        );

        // vpfi reached no wallet — it is parked stuck for owner recovery.
        assertEq(adapter.stuckVpfiByRequest(99), amount, "forged delivery parked");
        assertEq(adapter.totalStuckVpfi(), amount, "stuck total");
        assertEq(vpfi.balanceOf(buyer), 0, "nothing routed anywhere");
    }

    function test_TwoStep_ReplayedDelivery_ParksStuck() public {
        // A genuine happy buy, then a replayed leg-2 for the same id.
        vm.prank(buyer);
        adapter.buy{value: 1 ether + fee}(1 ether, 0);
        _deliver(0, SEL_MIRROR);
        _deliver(1, SEL_BASE);
        assertEq(vpfi.balanceOf(buyer), 1_000 ether, "paid once");

        // Replay leg 2 for requestId 1 — its status is now ResolvedSuccess.
        uint256 amount = 1_000 ether;
        vpfi.mint(address(adapter), amount);
        vm.prank(address(messengerMirror));
        adapter.onCrossChainMessage(
            BASE, address(receiver), abi.encode(uint64(1)), _vpfiTokens(amount)
        );

        // The buyer is NOT paid twice; the replayed vpfi parks stuck.
        assertEq(vpfi.balanceOf(buyer), 1_000 ether, "still paid once only");
        assertEq(adapter.stuckVpfiByRequest(1), amount, "replay parked stuck");
    }

    function test_RecoverStuckVPFI() public {
        uint256 amount = 500 ether;
        vpfi.mint(address(adapter), amount);
        vm.prank(address(messengerMirror));
        adapter.onCrossChainMessage(
            BASE, address(receiver), abi.encode(uint64(99)), _vpfiTokens(amount)
        );

        address recovery = makeAddr("recovery");
        vm.prank(owner);
        adapter.recoverStuckVPFI(99, recovery);
        assertEq(vpfi.balanceOf(recovery), amount, "recovered");
        assertEq(adapter.totalStuckVpfi(), 0, "stuck cleared");
    }

    // ─── Timeout refund ─────────────────────────────────────────────────────

    function test_ReclaimTimedOutBuy() public {
        uint256 amountIn = 2 ether;
        uint256 buyerBefore = buyer.balance;
        vm.prank(buyer);
        adapter.buy{value: amountIn + fee}(amountIn, 0);
        // No response arrives.

        vm.expectRevert(VpfiBuyAdapter.RefundTimeoutNotElapsed.selector);
        adapter.reclaimTimedOutBuy(1);

        vm.warp(block.timestamp + TIMEOUT + 1);
        adapter.reclaimTimedOutBuy(1); // permissionless
        assertEq(buyer.balance, buyerBefore - fee, "timed-out buy refunded");
    }

    // ─── Rate limits ────────────────────────────────────────────────────────

    function test_RateLimit_PerRequestCap() public {
        vm.prank(owner);
        adapter.setRateLimits(1 ether, type(uint256).max);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiBuyAdapter.BuyExceedsPerRequestCap.selector,
                2 ether,
                1 ether
            )
        );
        adapter.buy{value: 2 ether + fee}(2 ether, 0);
    }

    // ─── Pause ──────────────────────────────────────────────────────────────

    function test_Pause_FreezesBuy() public {
        vm.prank(owner);
        adapter.pause();
        vm.prank(buyer);
        vm.expectRevert(); // PausableUpgradeable.EnforcedPause
        adapter.buy{value: 1 ether + fee}(1 ether, 0);
    }

    // ─── Fee-surplus refund (Codex review P1) ───────────────────────────────

    function test_Buy_RefundsFeeSurplus() public {
        // The buyer pads the fee (a stale/conservative quoteBuy). The
        // adapter forwards only the exact CCIP fee and refunds the rest —
        // the surplus must reach the buyer, not strand in the adapter.
        uint256 amountIn = 1 ether;
        uint256 overpay = 0.3 ether;
        uint256 buyerBefore = buyer.balance;

        vm.prank(buyer);
        adapter.buy{value: amountIn + fee + overpay}(amountIn, 0);

        assertEq(
            buyer.balance,
            buyerBefore - amountIn - fee,
            "only amountIn + exact fee spent - surplus refunded"
        );
        assertEq(
            address(adapter).balance,
            amountIn,
            "adapter holds only the locked amountIn, no stray fee"
        );
    }

    function test_Buy_RevertWhen_FeeBelowQuote() public {
        uint256 amountIn = 1 ether;
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiBuyAdapter.InsufficientFee.selector, fee - 1, fee
            )
        );
        adapter.buy{value: amountIn + fee - 1}(amountIn, 0);
    }

    // ─── Lossy chain-id cast guard (Codex review) ───────────────────────────

    function test_Receive_RevertWhen_SourceChainIdTooLarge() public {
        // A source chain id beyond uint32 would silently alias onto
        // another chain's bridged-buy accounting — rejected pre-mint.
        uint256 bigChain = uint256(type(uint32).max) + 1;
        bytes memory payload =
            abi.encode(uint64(1), buyer, uint256(1 ether), uint256(0));
        vm.prank(address(messengerBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiBuyReceiver.ChainIdTooLarge.selector, bigChain
            )
        );
        receiver.onCrossChainMessage(
            bigChain,
            address(adapter),
            payload,
            new ICrossChainMessenger.TokenAmount[](0)
        );
    }

    // ─── Payment-token rotation guard (Codex review P1) ─────────────────────

    function test_SetPaymentToken_RevertWhen_PendingBuysExist() public {
        // A pending buy holds a lock in the current payment asset;
        // rotating the token now would settle it in the wrong asset.
        vm.prank(buyer);
        adapter.buy{value: 1 ether + fee}(1 ether, 0);
        assertEq(adapter.totalPendingAmountIn(), 1 ether, "buy is pending");

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiBuyAdapter.PaymentTokenRotationBlocked.selector, 1 ether
            )
        );
        adapter.setPaymentToken(address(0));

        // Once the buy resolves, rotation is allowed again.
        _deliver(0, SEL_MIRROR);
        _deliver(1, SEL_BASE);
        assertEq(adapter.totalPendingAmountIn(), 0, "pending drained");
        vm.prank(owner);
        adapter.setPaymentToken(address(0));
    }

    // ─── Receiver-side stuck retry ──────────────────────────────────────────

    function test_Receiver_StuckDelivery_Retry() public {
        // Drain the receiver's ETH float so leg-2 cannot pay its fee — the
        // vpfi is minted but the delivery soft-fails and parks as stuck.
        vm.prank(owner);
        receiver.rescueETH(payable(owner), address(receiver).balance);

        vm.prank(buyer);
        adapter.buy{value: 1 ether + fee}(1 ether, 0);
        _deliver(0, SEL_MIRROR); // receiver mints, leg-2 soft-fails

        assertEq(router.pendingCount(), 1, "leg-2 not dispatched");
        assertEq(
            receiver.stuckVpfiByRequest(1), 1_000 ether, "vpfi parked stuck"
        );

        // Re-fund the float and retry — leg 2 now dispatches.
        vm.deal(address(receiver), 10 ether);
        vm.prank(owner);
        receiver.retryStuckDelivery(1, MIRROR);
        assertEq(router.pendingCount(), 2, "leg-2 dispatched on retry");
        assertEq(receiver.totalStuckVpfi(), 0, "stuck cleared");

        _deliver(1, SEL_BASE);
        assertEq(vpfi.balanceOf(buyer), 1_000 ether, "buyer paid after retry");
    }
}
