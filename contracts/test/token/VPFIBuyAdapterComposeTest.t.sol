// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OFTComposeMsgCodec} from "@layerzerolabs/oft-evm/contracts/libs/OFTComposeMsgCodec.sol";
import {VPFIBuyAdapter} from "../../src/token/VPFIBuyAdapter.sol";

/// @dev Mock LayerZero V2 EndpointV2 with just enough surface for the
///      adapter's OApp constructor + `lzCompose` auth. Tests prank as
///      this address when calling `lzCompose` to satisfy the
///      `msg.sender == endpoint` gate.
contract MockLZEndpoint {
    function eid() external pure returns (uint32) {
        return 40245; // Base Sepolia eid (arbitrary — only used by buy())
    }
    function setDelegate(address) external {}
}

/// @dev Minimal ERC20 — enough for the adapter to `safeTransfer` VPFI
///      to recipients in the happy / recovery paths.
contract MockVPFI {
    string public name = "Vaipakam";
    string public symbol = "VPFI";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount)
        external
        returns (bool)
    {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Test-only extension that exposes a writer for the
///      `pendingBuys` mapping so we can simulate a real `buy()` call
///      without bringing up a full LZ endpoint + peer mesh. The
///      production contract does NOT inherit from this — only the
///      test proxy uses it as the implementation.
contract TestableVPFIBuyAdapter is VPFIBuyAdapter {
    constructor(address lzEndpoint) VPFIBuyAdapter(lzEndpoint) {}

    /// @dev Direct setter for `pendingBuys[id]`. Increments
    ///      `totalPendingAmountIn` when the seeded entry is Pending —
    ///      mirroring the production `buy()` accounting so the
    ///      `_releaseToTreasury` decrement on the happy path doesn't
    ///      underflow.
    function test_seedPendingBuy(
        uint64 id,
        address buyer,
        uint96 amountIn,
        BuyStatus status
    ) external payable {
        pendingBuys[id] = PendingBuy({
            buyer: buyer,
            amountIn: amountIn,
            initiatedAt: uint64(block.timestamp),
            status: status
        });
        if (status == BuyStatus.Pending) {
            totalPendingAmountIn += amountIn;
            // Caller forwards `msg.value == amountIn` so the
            // adapter's native-ETH balance matches what `buy()` would
            // have escrowed. `_releaseToTreasury` then has something
            // real to send on the happy path.
            require(msg.value == amountIn, "seed: value mismatch");
        }
    }

    // `receive() external payable` is inherited from VPFIBuyAdapter —
    // the base's no-op implementation accepts ETH from the test
    // seeder + any LZ refunds during the buy() flow.
}

/**
 * @title VPFIBuyAdapterComposeTest
 * @notice T-031 Layer 2 — exercises the new `lzCompose` success path
 *         on the adapter: the OFT mint lands at this contract, the
 *         compose payload carries `(uint64 requestId)`, and the
 *         adapter cross-checks `pendingBuys[requestId].buyer`
 *         (authoritative local truth) before delivering VPFI and
 *         releasing the user's escrow to treasury.
 *
 *         Five attack/operational scenarios:
 *           1. Happy path — legit buy resolves through compose.
 *           2. Forged BUY_REQUEST — compose lands with an unknown
 *              requestId; VPFI gets stuck, no payout to anyone.
 *           3. Replay / late — compose arrives twice; the second one
 *              records as stuck (status guard prevents double-payout).
 *           4. Auth — `lzCompose` called from non-endpoint reverts.
 *              `_from != vpfiMirror` reverts.
 *           5. Recovery — owner can sweep stuck VPFI via
 *              `recoverStuckVPFI`.
 */
contract VPFIBuyAdapterComposeTest is Test {
    TestableVPFIBuyAdapter internal adapter;
    MockLZEndpoint internal endpoint;
    MockVPFI internal vpfi;

    address internal constant OWNER = address(0xA11CE);
    address internal constant TREASURY = address(0xCAFE);
    address internal constant MIRROR = address(0xB0FF);
    address internal constant BUYER = address(0xB077);
    address internal constant ATTACKER = address(0xBAD0);
    address internal constant RECOVERY = address(0xBEEF);

    uint32 internal constant RECEIVER_EID = 40245;
    uint64 internal constant REFUND_TIMEOUT = 900;
    uint96 internal constant AMOUNT_IN = 1 ether;
    uint256 internal constant VPFI_OUT = 1000e18;

    function setUp() public {
        endpoint = new MockLZEndpoint();
        TestableVPFIBuyAdapter impl = new TestableVPFIBuyAdapter(address(endpoint));

        // Native-gas-mode init (paymentToken = address(0)).
        bytes memory initData = abi.encodeCall(
            VPFIBuyAdapter.initialize,
            (
                OWNER,
                RECEIVER_EID,
                TREASURY,
                address(0),       // native-gas mode
                bytes(""),        // buyOptions (unused by these tests)
                REFUND_TIMEOUT
            )
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        adapter = TestableVPFIBuyAdapter(payable(address(proxy)));

        // Wire VPFI token + mirror (T-031 Layer 2 deps).
        vpfi = new MockVPFI();
        vm.startPrank(OWNER);
        adapter.setVPFIToken(address(vpfi));
        adapter.setVPFIMirror(MIRROR);
        vm.stopPrank();
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    /// @dev Build the OFTComposeMsgCodec envelope:
    ///      `[nonce(8)][srcEid(4)][amountLD(32)][composeFrom(32)][appMsg…]`.
    ///      `appMsg = abi.encode(uint64 requestId)` per the receiver.
    function _composeEnvelope(uint256 amountLD, uint64 requestId)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory inner = abi.encode(requestId);
        // composeFrom is the original sender on Base. Tests don't
        // validate this field — only `_from` and `msg.sender` matter
        // for auth — so a zero placeholder is fine.
        bytes memory framed = abi.encodePacked(bytes32(0), inner);
        return OFTComposeMsgCodec.encode(
            uint64(1),                    // nonce
            uint32(RECEIVER_EID),         // srcEid (Base)
            amountLD,                     // VPFI amount minted
            framed
        );
    }

    /// @dev Land a compose dispatch from the LZ endpoint with the
    ///      given `_from`. Used by all paths that exercise lzCompose.
    function _dispatchCompose(
        address from,
        uint256 vpfiAmount,
        uint64 requestId
    ) internal {
        bytes memory envelope = _composeEnvelope(vpfiAmount, requestId);
        // Mint VPFI to the adapter the way the OFT mirror would right
        // before the compose call lands.
        vpfi.mint(address(adapter), vpfiAmount);
        vm.prank(address(endpoint));
        adapter.lzCompose(from, bytes32(0), envelope, address(0), bytes(""));
    }

    // ─── 1. Happy path ──────────────────────────────────────────────────────

    function test_lzCompose_HappyPath_TransfersVPFIAndReleasesETH() public {
        uint64 requestId = 42;
        vm.deal(address(this), AMOUNT_IN);
        adapter.test_seedPendingBuy{value: AMOUNT_IN}(
            requestId,
            BUYER,
            AMOUNT_IN,
            VPFIBuyAdapter.BuyStatus.Pending
        );

        uint256 buyerVpfiBefore = vpfi.balanceOf(BUYER);
        uint256 treasuryEthBefore = TREASURY.balance;
        uint256 pendingBefore = adapter.totalPendingAmountIn();

        _dispatchCompose(MIRROR, VPFI_OUT, requestId);

        // VPFI delivered to the recorded local-truth buyer (NOT to
        // anyone the compose payload might claim).
        assertEq(vpfi.balanceOf(BUYER), buyerVpfiBefore + VPFI_OUT);
        // ETH released from adapter escrow to treasury.
        assertEq(TREASURY.balance, treasuryEthBefore + AMOUNT_IN);
        // Status flipped + accounting reduced.
        (, , , VPFIBuyAdapter.BuyStatus status) = adapter.pendingBuys(requestId);
        assertEq(uint8(status), uint8(VPFIBuyAdapter.BuyStatus.ResolvedSuccess));
        assertEq(adapter.totalPendingAmountIn(), pendingBefore - AMOUNT_IN);
        // No stuck balance recorded on the happy path.
        assertEq(adapter.stuckVPFIByRequest(requestId), 0);
        assertEq(adapter.totalStuckVPFI(), 0);
    }

    // ─── 2. Forged BUY_REQUEST defense ──────────────────────────────────────

    function test_lzCompose_ForgedRequest_RecordsStuckVPFI_NoPayout() public {
        uint64 forgedId = 9999;
        // Crucially: NO test_seedPendingBuy. The adapter has no
        // record of forgedId — exactly what would happen if a
        // compromised LZ DVN forged a BUY_REQUEST direct to the
        // receiver: VPFI minted on Base, OFT-composed back here,
        // but no real `buy()` call was ever made on this chain.
        uint256 buyerVpfiBefore = vpfi.balanceOf(ATTACKER);

        _dispatchCompose(MIRROR, VPFI_OUT, forgedId);

        // Attacker (or anyone) gets ZERO VPFI. The compose payload
        // doesn't even drive WHO the recipient would be — adapter
        // never reads a "buyer" from the compose; it only reads
        // its own pendingBuys mapping.
        assertEq(vpfi.balanceOf(ATTACKER), buyerVpfiBefore);
        // VPFI is stuck on the adapter for owner recovery.
        assertEq(adapter.stuckVPFIByRequest(forgedId), VPFI_OUT);
        assertEq(adapter.totalStuckVPFI(), VPFI_OUT);
        assertEq(vpfi.balanceOf(address(adapter)), VPFI_OUT);
    }

    // ─── 3. Replay / late ───────────────────────────────────────────────────

    function test_lzCompose_Replay_SecondCallRecordsStuck() public {
        uint64 requestId = 7;
        vm.deal(address(this), AMOUNT_IN);
        adapter.test_seedPendingBuy{value: AMOUNT_IN}(
            requestId,
            BUYER,
            AMOUNT_IN,
            VPFIBuyAdapter.BuyStatus.Pending
        );

        // First compose: happy path.
        _dispatchCompose(MIRROR, VPFI_OUT, requestId);
        assertEq(vpfi.balanceOf(BUYER), VPFI_OUT);

        // Second compose with the same requestId — pendingBuys[id]
        // is now ResolvedSuccess, so the second VPFI delivery must
        // be recorded as stuck (no double-payout).
        uint256 buyerBefore = vpfi.balanceOf(BUYER);
        _dispatchCompose(MIRROR, VPFI_OUT, requestId);

        // No additional payout to BUYER.
        assertEq(vpfi.balanceOf(BUYER), buyerBefore);
        // Second amount accumulated in stuck.
        assertEq(adapter.stuckVPFIByRequest(requestId), VPFI_OUT);
        assertEq(adapter.totalStuckVPFI(), VPFI_OUT);
    }

    // ─── 4. Auth gates ──────────────────────────────────────────────────────

    function test_lzCompose_Reverts_WhenCalledByNonEndpoint() public {
        uint64 requestId = 11;
        bytes memory envelope = _composeEnvelope(VPFI_OUT, requestId);
        vpfi.mint(address(adapter), VPFI_OUT);
        // Caller is a random EOA, not the LZ endpoint.
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(
                VPFIBuyAdapter.NotEndpoint.selector,
                ATTACKER
            )
        );
        adapter.lzCompose(MIRROR, bytes32(0), envelope, address(0), bytes(""));
    }

    function test_lzCompose_Reverts_WhenSenderIsNotMirror() public {
        uint64 requestId = 12;
        bytes memory envelope = _composeEnvelope(VPFI_OUT, requestId);
        vpfi.mint(address(adapter), VPFI_OUT);
        // Endpoint dispatches but `_from` is NOT the registered mirror.
        vm.prank(address(endpoint));
        vm.expectRevert(
            abi.encodeWithSelector(
                VPFIBuyAdapter.UnauthorizedComposeSource.selector,
                ATTACKER
            )
        );
        adapter.lzCompose(ATTACKER, bytes32(0), envelope, address(0), bytes(""));
    }

    function test_lzCompose_Reverts_WhenMirrorUnset() public {
        // Re-deploy with vpfiMirror unset.
        TestableVPFIBuyAdapter impl = new TestableVPFIBuyAdapter(address(endpoint));
        bytes memory initData = abi.encodeCall(
            VPFIBuyAdapter.initialize,
            (OWNER, RECEIVER_EID, TREASURY, address(0), bytes(""), REFUND_TIMEOUT)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        TestableVPFIBuyAdapter unset = TestableVPFIBuyAdapter(payable(address(proxy)));

        bytes memory envelope = _composeEnvelope(VPFI_OUT, 13);
        vm.prank(address(endpoint));
        vm.expectRevert(VPFIBuyAdapter.VpfiMirrorNotSet.selector);
        unset.lzCompose(MIRROR, bytes32(0), envelope, address(0), bytes(""));
    }

    // ─── 5. Recovery ────────────────────────────────────────────────────────

    function test_recoverStuckVPFI_OwnerSweepsStuckBalance() public {
        // Land a forged compose to populate stuck balance.
        uint64 forgedId = 0xDEAD;
        _dispatchCompose(MIRROR, VPFI_OUT, forgedId);
        assertEq(adapter.stuckVPFIByRequest(forgedId), VPFI_OUT);
        assertEq(adapter.totalStuckVPFI(), VPFI_OUT);

        uint256 recoveryBefore = vpfi.balanceOf(RECOVERY);
        vm.prank(OWNER);
        adapter.recoverStuckVPFI(forgedId, RECOVERY);

        // Recovery wallet received the VPFI; mapping zeroed; total
        // stuck decremented atomically.
        assertEq(vpfi.balanceOf(RECOVERY), recoveryBefore + VPFI_OUT);
        assertEq(adapter.stuckVPFIByRequest(forgedId), 0);
        assertEq(adapter.totalStuckVPFI(), 0);
    }

    function test_recoverStuckVPFI_RevertsForUnknownId() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                VPFIBuyAdapter.NoStuckVPFI.selector,
                uint64(123)
            )
        );
        adapter.recoverStuckVPFI(123, RECOVERY);
    }

    function test_recoverStuckVPFI_RevertsForNonOwner() public {
        uint64 forgedId = 1;
        _dispatchCompose(MIRROR, VPFI_OUT, forgedId);
        vm.prank(ATTACKER);
        vm.expectRevert();
        adapter.recoverStuckVPFI(forgedId, RECOVERY);
    }
}
