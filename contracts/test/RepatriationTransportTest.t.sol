// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SetupTest} from "./SetupTest.t.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RepatriationFacet} from "../src/facets/RepatriationFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {ReturnWire} from "../src/crosschain/ReturnWire.sol";
import {VpfiReturnSender} from "../src/crosschain/VpfiReturnSender.sol";
import {VpfiReturnReceiver} from "../src/crosschain/VpfiReturnReceiver.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {
    MockTokenAdminRegistry,
    MockVpfiTokenPool
} from "./mocks/MockVpfiTokenPool.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Stand-in for the CCIP adapter on the SEND side: quotes a settable
///      fee and, like the real `CcipMessenger._pullTokens`, PULLS each
///      declared token amount from the calling handler — so the sender
///      satellite's escrow + exact-approval mechanics are exercised for
///      real, not assumed.
contract MockCcipChannelMessenger {
    using SafeERC20 for IERC20;

    /// @notice chainId → CCIP selector, mirroring `CcipMessenger`'s public
    ///         registry — the surface the facet's live lane-capacity
    ///         bounds consult.
    mapping(uint256 => uint64) public chainSelectorOf;

    function setChainSelector(uint256 chainId, uint64 selector) external {
        chainSelectorOf[chainId] = selector;
    }

    uint256 public fee;
    uint256 public lastDst;
    bytes public lastPayload;
    uint256 public lastValue;
    uint256 public lastGasLimit;
    address public lastToken;
    uint256 public lastTokenAmount;
    uint256 public sendCount;

    function setFee(uint256 f) external {
        fee = f;
    }

    function quoteMessageFee(
        uint256,
        bytes calldata,
        ICrossChainMessenger.TokenAmount[] calldata,
        uint256
    ) external view returns (uint256) {
        return fee;
    }

    function sendMessage(
        uint256 destinationChainId,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens,
        uint256 gasLimit
    ) external payable returns (bytes32) {
        lastDst = destinationChainId;
        lastPayload = payload;
        lastValue = msg.value;
        lastGasLimit = gasLimit;
        if (tokens.length == 1) {
            lastToken = tokens[0].token;
            lastTokenAmount = tokens[0].amount;
            IERC20(tokens[0].token).safeTransferFrom(
                msg.sender, address(this), tokens[0].amount
            );
        } else {
            lastToken = address(0);
            lastTokenAmount = 0;
        }
        sendCount += 1;
        return keccak256(abi.encode(destinationChainId, payload, sendCount));
    }

    receive() external payable {}
}

/// @dev Stand-in for the CCIP adapter on the RECEIVE side: the receiver
///      satellite only checks `msg.sender == messenger` (and `initialize`
///      requires code), so a tiny relay is the cleanest fixture.
contract MockReturnRelay {
    function relay(
        VpfiReturnReceiver r,
        uint256 srcChainId,
        address sender,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) external {
        r.onCrossChainMessage(srcChainId, sender, payload, tokens);
    }
}

/**
 * @title  RepatriationTransportTest
 * @notice #1568 C2 transport slice — behaviour pins for the Mode-A wire:
 *         Base dispatch surfaces, the mirror instruction/cancel/execute
 *         lifecycle through the REAL `VpfiReturnSender` (against a
 *         token-pulling CCIP stand-in), and the REAL kind-dispatching
 *         `VpfiReturnReceiver` driving the Diamond's settlement/release
 *         ingresses. All Diamond reads/writes go THROUGH the Diamond
 *         (a test-contract `storageSlot()` resolves against the test's own
 *         storage and asserts 0 == 0).
 *
 *         Availability on the Base side is seeded through the REAL report
 *         ingress so every assertion starts from a proven non-zero
 *         baseline; the mirror bucket is seeded raw plus a physical mint,
 *         which `debitRepatriationSurplus` / `creditCustodyRelocated`
 *         both re-verify against.
 */
contract RepatriationTransportTest is SetupTest {
    MockRewardMessenger internal messenger;
    MockCcipChannelMessenger internal ccip;
    MockReturnRelay internal relay;
    MockVpfiTokenPool internal pool;
    MockTokenAdminRegistry internal tokenRegistry;
    VpfiReturnSender internal returnSender;
    VpfiReturnReceiver internal returnReceiver;
    ERC20Mock internal vpfi;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint32 internal constant CHAIN_OP = 10;
    uint64 internal constant SEL_BASE = 15971525489660198786;
    uint64 internal constant SEL_ARB = 4949039107694359620;
    uint64 internal constant SEL_OP = 3734403246176062136;
    uint256 internal constant DEST_GAS = 400_000;
    address internal constant STRANGER = address(0x57A9);

    function setUp() public {
        setupHelper();
        messenger = new MockRewardMessenger(address(diamond));
        ccip = new MockCcipChannelMessenger();
        relay = new MockReturnRelay();
        vpfi = new ERC20Mock("VPFI", "VPFI", 18);
        _mut().setVpfiTokenRaw(address(vpfi));
        // The expected-source config is canonical-gated, so take the Base
        // role for the shared setup; tests re-pick their role via
        // `_armBase()` / `_armMirror()`.
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](2);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        _agg().setExpectedSourceChainIds(chainIds);

        // Live lane-capacity wiring (#1618 r6/r7): the facet resolves
        // registry -> active pool -> lane membership -> limiter bucket at
        // every check, through the messenger's selector registry. Unset
        // selectors' buckets read disabled = no bound (all lanes default
        // SUPPORTED in the mock), so tests that pin the bound itself
        // enable a bucket / unsupport a lane explicitly.
        pool = new MockVpfiTokenPool();
        tokenRegistry = new MockTokenAdminRegistry();
        tokenRegistry.setPool(address(vpfi), address(pool));
        ccip.setChainSelector(CHAIN_BASE, SEL_BASE);
        ccip.setChainSelector(CHAIN_ARB, SEL_ARB);
        ccip.setChainSelector(CHAIN_OP, SEL_OP);
        _mut().setCrossChainMessengerRaw(address(ccip));
        _repat().setRepatriationTokenAdminRegistry(address(tokenRegistry));

        // Base-side receiver satellite (real, behind a proxy), driven by
        // the relay standing in for the CCIP adapter.
        VpfiReturnReceiver recvImpl = new VpfiReturnReceiver();
        returnReceiver = VpfiReturnReceiver(
            address(
                new ERC1967Proxy(
                    address(recvImpl),
                    abi.encodeCall(
                        VpfiReturnReceiver.initialize,
                        (address(this), address(relay), address(diamond))
                    )
                )
            )
        );

        // Mirror-side sender satellite (real, behind a proxy), pointed at
        // the token-pulling CCIP stand-in. Deployed under the mirror chain
        // id — its initializer rejects `baseChainId_ == block.chainid`.
        vm.chainId(CHAIN_ARB);
        VpfiReturnSender sendImpl = new VpfiReturnSender();
        returnSender = VpfiReturnSender(
            address(
                new ERC1967Proxy(
                    address(sendImpl),
                    abi.encodeCall(
                        VpfiReturnSender.initialize,
                        (
                            address(this),
                            address(ccip),
                            address(diamond),
                            address(vpfi),
                            DEST_GAS
                        )
                    )
                )
            )
        );
        vm.deal(STRANGER, 100 ether);
    }

    // ── Role/handle helpers ─────────────────────────────────────────────────

    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }

    function _agg() internal view returns (RewardAggregatorFacet) {
        return RewardAggregatorFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _repat() internal view returns (RepatriationFacet) {
        return RepatriationFacet(address(diamond));
    }

    /// Take the Base role: canonical, receiver satellite armed. The lane
    /// pool + selector registry are wired once in setUp; buckets default
    /// to disabled (no bound), so only bound-pinning tests enable them.
    function _armBase() internal {
        vm.chainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _repat().setRepatriationEndpoints(address(0), address(returnReceiver));
    }

    /// Take the mirror role: non-canonical, sender satellite armed.
    function _armMirror() internal {
        vm.chainId(CHAIN_ARB);
        _rep().setIsCanonicalRewardChain(false);
        _repat().setRepatriationEndpoints(address(returnSender), address(0));
    }

    /// Real-ingress availability seed on the Base side.
    function _seedAvail(uint256 dayId, uint256 amount) internal {
        messenger.deliverChainReportRecycled(
            CHAIN_ARB, dayId, 20e18, 10e18, amount, amount
        );
    }

    function _avail(uint32 chainId) internal view returns (uint256 avail) {
        (, , avail, ) = _agg().getChainRecycledLedger(chainId);
    }

    /// Base fixture: seeded availability + one PENDING authorization.
    function _authorized(uint256 amount) internal returns (uint256 authId) {
        _armBase();
        _seedAvail(1, 100 ether);
        authId = _repat().authorizeRepatriation(CHAIN_ARB, amount);
    }

    /// Mirror fixture: armed, bucket seeded (accounting + physical), one
    /// PENDING instruction from `issuingBase`.
    function _instructed(
        address issuingBase,
        uint256 authId,
        uint256 amount
    ) internal {
        _armMirror();
        _mut().setRecycleBucketRaw(100 ether);
        vpfi.mint(address(diamond), 100 ether);
        messenger.deliverRepatriationInstruction(issuingBase, authId, amount);
    }

    function _oneToken(uint256 amount)
        internal
        view
        returns (ICrossChainMessenger.TokenAmount[] memory tokens)
    {
        tokens = new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] = ICrossChainMessenger.TokenAmount({
            token: address(vpfi),
            amount: amount
        });
    }

    function _noTokens()
        internal
        pure
        returns (ICrossChainMessenger.TokenAmount[] memory)
    {
        return new ICrossChainMessenger.TokenAmount[](0);
    }

    // ── Base side: instruction dispatch ─────────────────────────────────────

    function test_SendInstruction_DispatchesThroughMessenger() public {
        uint256 authId = _authorized(40 ether);
        // Permissionless: a stranger pays the fee and dispatches.
        vm.prank(STRANGER);
        _repat().sendRepatriationInstruction{value: 1 ether}(
            authId, payable(STRANGER)
        );
        assertEq(messenger.repatSendCount(), 1);
        assertEq(messenger.lastRepatDst(), uint256(CHAIN_ARB));
        assertEq(messenger.lastRepatAuthId(), authId);
        assertEq(messenger.lastRepatAmount(), 40 ether);
        assertEq(messenger.lastRepatValue(), 1 ether);
        assertEq(messenger.lastRepatRefund(), STRANGER);
    }

    function test_SendInstruction_RevertsWhenNotPending() public {
        _armBase();
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationAuthNotPending.selector, 7, 0
            )
        );
        _repat().sendRepatriationInstruction(7, payable(address(this)));
    }

    function test_SendInstruction_DarkWithoutReceiver() public {
        uint256 authId = _authorized(40 ether);
        _repat().setRepatriationEndpoints(address(0), address(0));
        vm.expectRevert(RepatriationFacet.RepatriationNotConfigured.selector);
        _repat().sendRepatriationInstruction(authId, payable(address(this)));
    }

    function test_SendInstruction_RevertsWithoutMessenger() public {
        uint256 authId = _authorized(40 ether);
        _rep().setRewardMessenger(address(0));
        vm.expectRevert(
            RepatriationFacet.RepatriationMessengerNotSet.selector
        );
        _repat().sendRepatriationInstruction(authId, payable(address(this)));
    }

    // ── Live lane-capacity bounds (#1618 r1→r6) ─────────────────────────────

    function test_Authorize_BoundedByLiveInboundCapacity() public {
        _armBase();
        _seedAvail(1, 100 ether);
        pool.setInbound(SEL_ARB, true, 30 ether);
        // Above the LIVE inbound capacity: refused at ISSUANCE — a single
        // CCIP token message above capacity is rejected permanently, so an
        // over-capacity authorization could only ever strand its draw.
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationExceedsLaneCapacity.selector,
                30 ether + 1,
                30 ether
            )
        );
        _repat().authorizeRepatriation(CHAIN_ARB, 30 ether + 1);
        // Exactly at capacity passes; a capacity RAISE binds immediately —
        // no arming ceremony, the next read simply sees the new bucket.
        _repat().authorizeRepatriation(CHAIN_ARB, 30 ether);
        pool.setInbound(SEL_ARB, true, 100 ether);
        _repat().authorizeRepatriation(CHAIN_ARB, 60 ether);
    }

    function test_Authorize_LaneBoundIsPerDestination() public {
        // Codex #1618 r2 — capacities may diverge per lane; the bound
        // read must be the DESTINATION lane's, not any global figure.
        _armBase();
        uint32[] memory chainIds = new uint32[](3);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        chainIds[2] = CHAIN_OP;
        _agg().setExpectedSourceChainIds(chainIds);
        _seedAvail(1, 100 ether);
        messenger.deliverChainReportRecycled(
            CHAIN_OP, 2, 20e18, 10e18, 100 ether, 100 ether
        );
        pool.setInbound(SEL_ARB, true, 30 ether);
        pool.setInbound(SEL_OP, true, 50 ether);
        // 40 exceeds ARB's lane capacity but fits OP's — only ARB refuses.
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationExceedsLaneCapacity.selector,
                40 ether,
                30 ether
            )
        );
        _repat().authorizeRepatriation(CHAIN_ARB, 40 ether);
        _repat().authorizeRepatriation(CHAIN_OP, 40 ether);
    }

    function test_Authorize_FailsClosedOnMissingWiring() public {
        _armBase();
        _seedAvail(1, 100 ether);
        // Unknown lane selector — the messenger registry has no entry.
        ccip.setChainSelector(CHAIN_ARB, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationLaneUnknown.selector,
                uint256(CHAIN_ARB)
            )
        );
        _repat().authorizeRepatriation(CHAIN_ARB, 1 ether);
        ccip.setChainSelector(CHAIN_ARB, SEL_ARB);
        // Unset registry — the bounded surface is dark, never unbounded.
        _repat().setRepatriationTokenAdminRegistry(address(0));
        vm.expectRevert(RepatriationFacet.RepatriationNotConfigured.selector);
        _repat().authorizeRepatriation(CHAIN_ARB, 1 ether);
        _repat().setRepatriationTokenAdminRegistry(address(tokenRegistry));
        // Unregistered token (registry answers zero pool) — dark too.
        tokenRegistry.setPool(address(vpfi), address(0));
        vm.expectRevert(RepatriationFacet.RepatriationNotConfigured.selector);
        _repat().authorizeRepatriation(CHAIN_ARB, 1 ether);
        tokenRegistry.setPool(address(vpfi), address(pool));
        _repat().authorizeRepatriation(CHAIN_ARB, 1 ether);
    }

    function test_Authorize_RemovedLaneFailsClosed() public {
        // #1618 r7 P1 — for a lane the pool does NOT carry, Chainlink's
        // limiter getter returns a ZEROED bucket with isEnabled == false,
        // indistinguishable from "governor chose unlimited". Without the
        // membership gate a REMOVED lane would read as unbounded, and an
        // authorization toward it could execute on the mirror and then
        // fail delivery forever.
        _armBase();
        _seedAvail(1, 100 ether);
        pool.setSupported(SEL_ARB, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationLaneUnknown.selector,
                uint256(CHAIN_ARB)
            )
        );
        _repat().authorizeRepatriation(CHAIN_ARB, 1 ether);
        pool.setSupported(SEL_ARB, true);
        _repat().authorizeRepatriation(CHAIN_ARB, 1 ether);
    }

    function test_Authorize_PoolRotationAutoTracks() public {
        // #1618 r7 P2 — a CCT pool upgrade switches the active pool via
        // TokenAdminRegistry.setPool; because the facet resolves the pool
        // through the registry at EVERY check, the very next authorize is
        // bounded by the NEW pool's buckets with no Diamond call at all.
        _armBase();
        _seedAvail(1, 100 ether);
        pool.setInbound(SEL_ARB, true, 100 ether);
        _repat().authorizeRepatriation(CHAIN_ARB, 40 ether);
        MockVpfiTokenPool rotated = new MockVpfiTokenPool();
        rotated.setInbound(SEL_ARB, true, 10 ether);
        tokenRegistry.setPool(address(vpfi), address(rotated));
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationExceedsLaneCapacity.selector,
                40 ether,
                10 ether
            )
        );
        _repat().authorizeRepatriation(CHAIN_ARB, 40 ether);
    }

    function test_Execute_BoundedByLiveOutboundCapacity_Retryable() public {
        // The mirror-outbound half (#1618 r6): checked BEFORE the one-shot
        // marker, so an instruction above the lane's CURRENT capacity —
        // including one issued before a capacity was LOWERED — fails
        // retryably instead of marking executed and sending a message the
        // limiter permanently rejects.
        address base = address(0xBA5E);
        _instructed(base, 1, 40 ether);
        pool.setOutbound(SEL_BASE, true, 30 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationExceedsLaneCapacity.selector,
                40 ether,
                30 ether
            )
        );
        _repat().executeRepatriation(base, 1, payable(address(this)));
        (uint8 state, ) = _repat().getRepatriationInstruction(base, 1);
        assertEq(state, 1, "still pending after the refused execute");
        // A raise (or drain) unblocks the same instruction.
        pool.setOutbound(SEL_BASE, true, 100 ether);
        _repat().executeRepatriation(base, 1, payable(address(this)));
        (state, ) = _repat().getRepatriationInstruction(base, 1);
        assertEq(state, 2);
    }

    function test_SetTokenAdminRegistry_AdminOnlyAndCodeChecked() public {
        _armBase();
        vm.prank(STRANGER);
        vm.expectRevert();
        _repat().setRepatriationTokenAdminRegistry(address(tokenRegistry));
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationEndpointNotContract.selector,
                address(0xE0A1)
            )
        );
        _repat().setRepatriationTokenAdminRegistry(address(0xE0A1));
        assertEq(
            _repat().getRepatriationTokenAdminRegistry(),
            address(tokenRegistry)
        );
    }

    // ── Base side: cancel request ───────────────────────────────────────────

    function test_RequestCancel_DispatchesThroughMessenger() public {
        uint256 authId = _authorized(40 ether);
        _repat().requestRepatriationCancel{value: 0.5 ether}(
            authId, payable(address(this))
        );
        assertEq(messenger.repatCancelSendCount(), 1);
        assertEq(messenger.lastRepatCancelDst(), uint256(CHAIN_ARB));
        assertEq(messenger.lastRepatCancelAuthId(), authId);
        // The request does NOT release anything — the auth stays PENDING
        // and the draw stays charged until the mirror's ACK (5c).
        (uint8 status, , , , ) = _repat().getRepatriationAuthorization(authId);
        assertEq(status, 1, "still pending after cancel REQUEST");
        (uint256 netDraw, ) = _repat().getChainRepatriationDraw(CHAIN_ARB);
        assertEq(netDraw, 40 ether, "draw still charged");
    }

    function test_RequestCancel_AdminOnly() public {
        uint256 authId = _authorized(40 ether);
        vm.prank(STRANGER);
        vm.expectRevert();
        _repat().requestRepatriationCancel(authId, payable(STRANGER));
    }

    // ── Mirror side: cancel-instruction ingress ─────────────────────────────

    function test_CancelIngress_TombstonesPending() public {
        address base = address(0xBA5E);
        _instructed(base, 1, 40 ether);
        (uint8 state, uint256 amount) = _repat().getRepatriationInstruction(base, 1);
        assertEq(state, 1);
        assertEq(amount, 40 ether);
        messenger.deliverRepatriationCancel(base, 1);
        (state, ) = _repat().getRepatriationInstruction(base, 1);
        assertEq(state, 3, "tombstoned");
        // Execution is now structurally excluded (shared slot).
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationInstructionWrongState.selector,
                base,
                1,
                3
            )
        );
        _repat().executeRepatriation(base, 1, payable(address(this)));
    }

    function test_CancelIngress_PreTombstonesUnknownId() public {
        address base = address(0xBA5E);
        _armMirror();
        // The cancel OVERTOOK the instruction: tombstone the never-received
        // id, so the late instruction lands on a terminal record and no-ops.
        messenger.deliverRepatriationCancel(base, 9);
        (uint8 state, ) = _repat().getRepatriationInstruction(base, 9);
        assertEq(state, 3, "pre-tombstoned");
        messenger.deliverRepatriationInstruction(base, 9, 40 ether);
        (state, ) = _repat().getRepatriationInstruction(base, 9);
        assertEq(state, 3, "instruction after tombstone is a no-op");
        (, uint256 amount) = _repat().getRepatriationInstruction(base, 9);
        assertEq(amount, 0, "no amount recorded for a tombstoned-first id");
    }

    function test_CancelIngress_NoopOnExecuted() public {
        address base = address(0xBA5E);
        _instructed(base, 1, 40 ether);
        _repat().executeRepatriation(base, 1, payable(address(this)));
        // Execution won the race; the late cancel must not revert (the CCIP
        // packet would retry forever toward an unreachable state) and must
        // not un-execute.
        messenger.deliverRepatriationCancel(base, 1);
        (uint8 state, ) = _repat().getRepatriationInstruction(base, 1);
        assertEq(state, 2, "still executed");
    }

    function test_CancelIngress_DarkWithoutSender() public {
        vm.chainId(CHAIN_ARB);
        _rep().setIsCanonicalRewardChain(false);
        vm.expectRevert(RepatriationFacet.RepatriationNotConfigured.selector);
        messenger.deliverRepatriationCancel(address(0xBA5E), 1);
    }

    // ── Mirror side: execute ────────────────────────────────────────────────

    function test_Execute_DebitsBucketAndSendsReturn() public {
        address base = address(0xBA5E);
        _instructed(base, 1, 40 ether);
        ccip.setFee(0.2 ether);
        vm.prank(STRANGER);
        _repat().executeRepatriation{value: 0.2 ether}(
            base, 1, payable(STRANGER)
        );
        // Ledger: bucket down, outflow cumulative up (§7 #8's new term).
        assertEq(_mut().getRecycleBucketRaw(), 60 ether);
        (uint256 repatriatedOut, , , ) = _repat().getRepatriationPosition();
        assertEq(repatriatedOut, 40 ether);
        // Marker: executed, one-shot.
        (uint8 state, ) = _repat().getRepatriationInstruction(base, 1);
        assertEq(state, 2);
        // Physical: the VPFI left the Diamond, was pulled from the sender
        // satellite by the (mock) CCIP adapter, and nothing stranded in
        // the satellite's escrow.
        assertEq(vpfi.balanceOf(address(diamond)), 60 ether);
        assertEq(vpfi.balanceOf(address(returnSender)), 0);
        assertEq(vpfi.balanceOf(address(ccip)), 40 ether);
        // Wire: Mode-A kind, era-bound payload, token-bearing, to Base.
        assertEq(ccip.lastDst(), uint256(CHAIN_BASE));
        assertEq(ccip.lastToken(), address(vpfi));
        assertEq(ccip.lastTokenAmount(), 40 ether);
        assertEq(
            ccip.lastPayload(),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_REPAT_A1,
                base,
                uint256(1),
                uint256(40 ether)
            )
        );
        assertEq(ccip.lastValue(), 0.2 ether);
        assertEq(ccip.lastGasLimit(), DEST_GAS);
    }

    function test_Execute_OneShot() public {
        address base = address(0xBA5E);
        _instructed(base, 1, 40 ether);
        _repat().executeRepatriation(base, 1, payable(address(this)));
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationInstructionWrongState.selector,
                base,
                1,
                2
            )
        );
        _repat().executeRepatriation(base, 1, payable(address(this)));
    }

    function test_Execute_RetryableWhenSurplusReserved() public {
        address base = address(0xBA5E);
        _instructed(base, 1, 40 ether);
        // Reserve enough of the bucket that the fundable slice is short.
        _mut().setRecycleKeeperBudgetRaw(70 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibVpfiRecycle.RepatriationExceedsFundable.selector,
                40 ether,
                30 ether
            )
        );
        _repat().executeRepatriation(base, 1, payable(address(this)));
        // A failed execute leaves the instruction PENDING — retryable once
        // the reservation clears.
        (uint8 state, ) = _repat().getRepatriationInstruction(base, 1);
        assertEq(state, 1, "still pending after a failed execute");
        _mut().setRecycleKeeperBudgetRaw(0);
        _repat().executeRepatriation(base, 1, payable(address(this)));
        (state, ) = _repat().getRepatriationInstruction(base, 1);
        assertEq(state, 2);
    }

    function test_Execute_RefundsFeeSurplus() public {
        address base = address(0xBA5E);
        _instructed(base, 1, 40 ether);
        ccip.setFee(0.2 ether);
        uint256 before = STRANGER.balance;
        vm.prank(STRANGER);
        _repat().executeRepatriation{value: 0.7 ether}(
            base, 1, payable(STRANGER)
        );
        assertEq(before - STRANGER.balance, 0.2 ether, "surplus refunded");
    }

    function test_Execute_InsufficientFee() public {
        address base = address(0xBA5E);
        _instructed(base, 1, 40 ether);
        ccip.setFee(0.2 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiReturnSender.InsufficientFee.selector, 0.1 ether, 0.2 ether
            )
        );
        _repat().executeRepatriation{value: 0.1 ether}(
            base, 1, payable(address(this))
        );
    }

    function test_Execute_DarkWithoutSender() public {
        vm.chainId(CHAIN_ARB);
        _rep().setIsCanonicalRewardChain(false);
        vm.expectRevert(RepatriationFacet.RepatriationNotConfigured.selector);
        _repat().executeRepatriation(
            address(0xBA5E), 1, payable(address(this))
        );
    }

    function test_SenderSatellite_OnlyDiamond() public {
        _armMirror();
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiReturnSender.NotDiamond.selector, address(this)
            )
        );
        returnSender.sendRepatriationReturn(
            uint256(CHAIN_BASE), address(0xBA5E), 1, 1 ether,
            payable(address(this))
        );
    }

    // ── Mirror side: cancel ACK send ────────────────────────────────────────

    function test_CancelAckSend_RequiresTombstone() public {
        address base = address(0xBA5E);
        _instructed(base, 1, 40 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationInstructionWrongState.selector,
                base,
                1,
                1
            )
        );
        _repat().sendRepatriationCancelAck(base, 1, payable(address(this)));
    }

    function test_CancelAckSend_DataOnlyAndResendable() public {
        address base = address(0xBA5E);
        _instructed(base, 1, 40 ether);
        messenger.deliverRepatriationCancel(base, 1);
        vm.prank(STRANGER);
        _repat().sendRepatriationCancelAck(base, 1, payable(STRANGER));
        assertEq(ccip.sendCount(), 1);
        assertEq(ccip.lastDst(), uint256(CHAIN_BASE));
        assertEq(ccip.lastTokenAmount(), 0, "ACK is data-only");
        assertEq(
            ccip.lastPayload(),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_REPAT_CANCEL_ACK_A1,
                base,
                uint256(1)
            )
        );
        // Re-sendable: a lost ACK is retried by re-calling.
        _repat().sendRepatriationCancelAck(base, 1, payable(address(this)));
        assertEq(ccip.sendCount(), 2);
    }

    // ── Base side: return delivery through the real receiver ────────────────

    function test_ReturnDelivery_SettlesAuthorization() public {
        uint256 authId = _authorized(40 ether);
        uint256 bucketBefore = _mut().getRecycleBucketRaw();
        // CCIP forwards the bridged tokens to the receiver BEFORE the
        // callback — simulate with a mint, then relay the payload.
        vpfi.mint(address(returnReceiver), 40 ether);
        relay.relay(
            returnReceiver,
            uint256(CHAIN_ARB),
            address(0),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_REPAT_A1,
                address(diamond),
                authId,
                uint256(40 ether)
            ),
            _oneToken(40 ether)
        );
        (uint8 status, , , , uint256 shortfall) =
            _repat().getRepatriationAuthorization(authId);
        assertEq(status, 2, "settled");
        assertEq(shortfall, 0);
        // The value re-entered Base's books as a CUSTODY RELOCATION into
        // the bucket (never fresh absorption), physically backed.
        assertEq(_mut().getRecycleBucketRaw(), bucketBefore + 40 ether);
        assertEq(vpfi.balanceOf(address(diamond)), 40 ether);
        assertEq(vpfi.balanceOf(address(returnReceiver)), 0);
    }

    function test_ReturnDelivery_ShortActualRecordsShortfall() public {
        uint256 authId = _authorized(40 ether);
        // Fee-on-transfer simulation: the receiver holds less than the
        // declared amount; it forwards what it has, and the Diamond closes
        // the authorization at the DECLARED amount with the gap recorded —
        // the source debit never silently resizes (§3.6a 6a/7).
        vpfi.mint(address(returnReceiver), 39 ether);
        relay.relay(
            returnReceiver,
            uint256(CHAIN_ARB),
            address(0),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_REPAT_A1,
                address(diamond),
                authId,
                uint256(40 ether)
            ),
            _oneToken(40 ether)
        );
        (uint8 status, , , , uint256 shortfall) =
            _repat().getRepatriationAuthorization(authId);
        assertEq(status, 2, "settled at declared");
        assertEq(shortfall, 1 ether, "gap recorded");
        assertEq(_mut().getRecycleBucketRaw(), 39 ether);
    }

    function test_ReturnDelivery_WrongEraRejected() public {
        uint256 authId = _authorized(40 ether);
        vpfi.mint(address(returnReceiver), 40 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationWrongEra.selector,
                address(0xDEAD)
            )
        );
        relay.relay(
            returnReceiver,
            uint256(CHAIN_ARB),
            address(0),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_REPAT_A1,
                address(0xDEAD),
                authId,
                uint256(40 ether)
            ),
            _oneToken(40 ether)
        );
    }

    function test_ReturnDelivery_WrongSourceChainRejected() public {
        uint256 authId = _authorized(40 ether);
        vpfi.mint(address(returnReceiver), 40 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationWrongSourceChain.selector,
                CHAIN_OP,
                CHAIN_ARB
            )
        );
        relay.relay(
            returnReceiver,
            uint256(CHAIN_OP),
            address(0),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_REPAT_A1,
                address(diamond),
                authId,
                uint256(40 ether)
            ),
            _oneToken(40 ether)
        );
    }

    // ── Base side: cancel-ACK delivery through the real receiver ────────────

    function test_CancelAckDelivery_ReleasesDrawAndRestoresAvail() public {
        uint256 authId = _authorized(40 ether);
        assertEq(_avail(CHAIN_ARB), 60 ether, "draw charged");
        relay.relay(
            returnReceiver,
            uint256(CHAIN_ARB),
            address(0),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_REPAT_CANCEL_ACK_A1,
                address(diamond),
                authId
            ),
            _noTokens()
        );
        (uint8 status, , , , ) = _repat().getRepatriationAuthorization(authId);
        assertEq(status, 3, "released");
        (uint256 netDraw, uint256 lifetimeReleased) =
            _repat().getChainRepatriationDraw(CHAIN_ARB);
        assertEq(netDraw, 0, "net draw decremented in place");
        assertEq(lifetimeReleased, 40 ether, "lifetime observability");
        assertEq(_avail(CHAIN_ARB), 100 ether, "availability restored");
    }

    function test_CancelAckDelivery_DuplicateRejected() public {
        uint256 authId = _authorized(40 ether);
        bytes memory ack = abi.encode(
            ReturnWire.RETURN_WIRE_TAG_REPAT_CANCEL_ACK_A1,
            address(diamond),
            authId
        );
        relay.relay(
            returnReceiver, uint256(CHAIN_ARB), address(0), ack, _noTokens()
        );
        // A re-sent ACK reverts on the Diamond (no longer PENDING) — an
        // inert failed CCIP delivery, releasing nothing twice.
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationAuthNotPending.selector,
                authId,
                3
            )
        );
        relay.relay(
            returnReceiver, uint256(CHAIN_ARB), address(0), ack, _noTokens()
        );
    }

    // ── Receiver: kind dispatch + rollout fail-closed ───────────────────────

    function test_Receiver_UnknownKindFailsClosed() public {
        _armBase();
        uint256 futureKind =
            uint256(keccak256("vaipakam.return.wire.some-future-mode"));
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiReturnReceiver.UnknownReturnWireKind.selector, futureKind
            )
        );
        relay.relay(
            returnReceiver,
            uint256(CHAIN_ARB),
            address(0),
            abi.encode(futureKind, address(diamond), uint256(1)),
            _noTokens()
        );
    }

    function test_Receiver_RejectsMalformedDeliveries() public {
        uint256 authId = _authorized(40 ether);
        bytes memory ret = abi.encode(
            ReturnWire.RETURN_WIRE_TAG_REPAT_A1,
            address(diamond),
            authId,
            uint256(40 ether)
        );

        // Non-messenger caller.
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiReturnReceiver.NotMessenger.selector, address(this)
            )
        );
        returnReceiver.onCrossChainMessage(
            uint256(CHAIN_ARB), address(0), ret, _oneToken(40 ether)
        );

        // Return kind with no tokens.
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiReturnReceiver.WrongTokenCount.selector, 0
            )
        );
        relay.relay(
            returnReceiver, uint256(CHAIN_ARB), address(0), ret, _noTokens()
        );

        // Declared/delivered mismatch.
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiReturnReceiver.AmountMismatch.selector,
                40 ether,
                39 ether
            )
        );
        relay.relay(
            returnReceiver,
            uint256(CHAIN_ARB),
            address(0),
            ret,
            _oneToken(39 ether)
        );

        // Truncated return payload (right kind, wrong size — two words).
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiReturnReceiver.PayloadSizeMismatch.selector, 64, 128
            )
        );
        relay.relay(
            returnReceiver,
            uint256(CHAIN_ARB),
            address(0),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_REPAT_A1, address(diamond)
            ),
            _oneToken(40 ether)
        );

        // Token-bearing cancel ACK.
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiReturnReceiver.WrongTokenCount.selector, 1
            )
        );
        relay.relay(
            returnReceiver,
            uint256(CHAIN_ARB),
            address(0),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_REPAT_CANCEL_ACK_A1,
                address(diamond),
                authId
            ),
            _oneToken(40 ether)
        );

        // Source chain id beyond the ledger's uint32 domain.
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiReturnReceiver.ChainIdTooLarge.selector,
                uint256(type(uint32).max) + 1
            )
        );
        relay.relay(
            returnReceiver,
            uint256(type(uint32).max) + 1,
            address(0),
            ret,
            _oneToken(40 ether)
        );
    }

    // ── Full round trips (one deployment playing both roles) ────────────────

    function test_RoundTrip_AuthorizeExecuteSettle() public {
        // Base: authorize against the seeded availability.
        uint256 authId = _authorized(40 ether);
        address issuingBase = address(diamond);
        assertEq(_avail(CHAIN_ARB), 60 ether);

        // Mirror: record + execute the instruction; capture the wire.
        _armMirror();
        _mut().setRecycleBucketRaw(100 ether);
        vpfi.mint(address(diamond), 100 ether);
        messenger.deliverRepatriationInstruction(issuingBase, authId, 40 ether);
        _repat().executeRepatriation(issuingBase, authId, payable(address(this)));
        bytes memory wire = ccip.lastPayload();
        uint256 bridged = ccip.lastTokenAmount();

        // Base again: the bridged VPFI + payload land on the receiver.
        _armBase();
        // Play the CCIP token pool: the adapter's pulled tokens arrive at
        // the Base-side receiver ahead of the callback.
        vm.prank(address(ccip));
        vpfi.transfer(address(returnReceiver), bridged);
        uint256 bucketBefore = _mut().getRecycleBucketRaw();
        relay.relay(
            returnReceiver,
            uint256(CHAIN_ARB),
            address(0),
            wire,
            _oneToken(bridged)
        );
        (uint8 status, , , , ) = _repat().getRepatriationAuthorization(authId);
        assertEq(status, 2, "settled by the executed return");
        assertEq(_mut().getRecycleBucketRaw(), bucketBefore + 40 ether);
        // The draw REMAINS charged on settlement — only a cancellation ACK
        // releases it; settled value is accounted by the relocation credit.
        (uint256 netDraw, ) = _repat().getChainRepatriationDraw(CHAIN_ARB);
        assertEq(netDraw, 40 ether, "settled draw stays charged");
    }

    function test_RoundTrip_CancelTombstoneAck() public {
        uint256 authId = _authorized(40 ether);
        address issuingBase = address(diamond);
        _repat().requestRepatriationCancel(authId, payable(address(this)));

        // Mirror: the cancel lands (before any instruction), pre-tombstones,
        // and the ACK goes out.
        _armMirror();
        messenger.deliverRepatriationCancel(issuingBase, authId);
        _repat().sendRepatriationCancelAck(
            issuingBase, authId, payable(address(this))
        );
        bytes memory ackWire = ccip.lastPayload();

        // Base: the ACK releases the draw.
        _armBase();
        relay.relay(
            returnReceiver,
            uint256(CHAIN_ARB),
            address(0),
            ackWire,
            _noTokens()
        );
        (uint8 status, , , , ) = _repat().getRepatriationAuthorization(authId);
        assertEq(status, 3, "released");
        assertEq(_avail(CHAIN_ARB), 100 ether, "availability restored");
    }
    // ── #1434 P2-w5: the Mode-B stranded return ─────────────────────────────

    function _rlens() internal view returns (RewardRemittanceLensFacet) {
        return RewardRemittanceLensFacet(address(diamond));
    }

    /// Mirror fixture: armed, one stranded record, tokens physically held.
    function _stranded(
        address remitter,
        uint256 remitId,
        uint256 amount
    ) internal {
        _armMirror();
        vpfi.mint(address(diamond), amount);
        _mut().setStrandedRecoveryRaw(remitter, remitId, amount, 7, 1);
    }

    /// §8-5 — the return retires the record EXACTLY ONCE, releases the
    /// earmark, advances the outflow cumulative, and puts the recorded
    /// amount (never a caller figure) on the B1 wire.
    function test_StrandedReturn_RetiresRecordAndSends() public {
        address base = address(0xBA5E);
        _stranded(base, 11, 5 ether);
        ccip.setFee(0.1 ether);
        vm.prank(STRANGER); // permissionless: evidence is the stored record
        _repat().sendStrandedReturn{value: 0.1 ether}(
            base, 11, 5 ether, payable(STRANGER)
        );
        assertEq(
            _rlens().getStrandedRecovery(base, 11).amount,
            0,
            "record retired"
        );
        assertEq(
            _rlens().getStrandedRecoveryReserved(), 0, "earmark released"
        );
        assertEq(
            _rlens().getStrandedReturnedCumulative(),
            5 ether,
            "outflow recorded"
        );
        assertEq(vpfi.balanceOf(address(diamond)), 0, "tokens left custody");
        assertEq(vpfi.balanceOf(address(returnSender)), 0, "nothing stranded");
        assertEq(vpfi.balanceOf(address(ccip)), 5 ether, "pulled by CCIP");
        assertEq(ccip.lastDst(), uint256(CHAIN_BASE));
        assertEq(
            ccip.lastPayload(),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_STRANDED_B1,
                base,
                uint256(11),
                uint256(7),
                uint256(5 ether),
                uint256(0)
            )
        );
        // Retire-once: the record is gone.
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.StrandedReturnNothingRecorded.selector,
                base,
                uint256(11)
            )
        );
        _repat().sendStrandedReturn(base, 11, 1, payable(address(this)));
    }

    function test_StrandedReturn_UnknownRecordReverts() public {
        _armMirror();
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.StrandedReturnNothingRecorded.selector,
                address(0xBA5E),
                uint256(99)
            )
        );
        _repat().sendStrandedReturn(
            address(0xBA5E), 99, 1 ether, payable(address(this))
        );
    }

    /// Lane capacity is checked BEFORE the one-shot retire: an
    /// over-capacity return fails retryably with the record intact.
    function test_StrandedReturn_LaneCapacityRetryable() public {
        address base = address(0xBA5E);
        _stranded(base, 11, 40 ether);
        pool.setOutbound(SEL_BASE, true, 10 ether);
        vm.expectRevert();
        _repat().sendStrandedReturn(base, 11, 40 ether, payable(address(this)));
        assertEq(
            _rlens().getStrandedRecovery(base, 11).amount,
            40 ether,
            "record intact after a failed send"
        );
        pool.setOutbound(SEL_BASE, true, 100 ether);
        _repat().sendStrandedReturn(base, 11, 40 ether, payable(address(this)));
        assertEq(_rlens().getStrandedRecovery(base, 11).amount, 0);
    }

    /// Receiver leg: the B1 branch decodes, forwards the tokens to the
    /// Diamond, and the ingress credits ENTITLEMENT-BOUNDED, quarantining
    /// the excess in the overage position and clearing the R6 gate held
    /// by exactly this receipt.
    function test_StrandedReturn_BaseCreditsAndClearsGate() public {
        _armBase();
        _mut().setRemitReservationCompRaw(11, CHAIN_ARB, 2, 4 ether, 1);
        _mut().setCompensationGateRaw(CHAIN_ARB, 11);
        vpfi.mint(address(returnReceiver), 5 ether);
        relay.relay(
            returnReceiver,
            CHAIN_ARB,
            address(0),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_STRANDED_B1,
                address(diamond),
                uint256(11),
                uint256(1),
                uint256(5 ether),
                uint256(0)
            ),
            _oneToken(5 ether)
        );
        (uint256 recovered, uint256 redispatched, uint256 overage) =
            _rlens().getRecoveryPosition();
        assertEq(recovered, 4 ether, "credited to entitlement");
        assertEq(redispatched, 0);
        assertEq(overage, 1 ether, "excess quarantined, not credited");
        assertEq(_rlens().getRecoveredForReceipt(11), 4 ether);
        assertEq(
            _rlens().getCompensationOutstanding(CHAIN_ARB),
            0,
            "return settlement cleared the gate"
        );
        assertEq(vpfi.balanceOf(address(diamond)), 5 ether, "tokens home");
    }

    /// Chain binding: a return authenticated from the WRONG chain cannot
    /// consume another chain's one-shot recovery.
    function test_StrandedReturn_WrongSourceChainRefused() public {
        _armBase();
        _mut().setRemitReservationCompRaw(11, CHAIN_ARB, 2, 4 ether, 1);
        vpfi.mint(address(returnReceiver), 4 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.StrandedReturnWrongSourceChain.selector,
                CHAIN_OP,
                CHAIN_ARB
            )
        );
        relay.relay(
            returnReceiver,
            CHAIN_OP,
            address(0),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_STRANDED_B1,
                address(diamond),
                uint256(11),
                uint256(1),
                uint256(4 ether),
                uint256(0)
            ),
            _oneToken(4 ether)
        );
    }

    /// Era binding: a stale-era receipt (another issuing deployment)
    /// fails closed and re-executable — the R6e runbook's case.
    function test_StrandedReturn_WrongEraRefused() public {
        _armBase();
        vpfi.mint(address(returnReceiver), 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.StrandedReturnWrongEra.selector,
                address(0xDEAD)
            )
        );
        relay.relay(
            returnReceiver,
            CHAIN_ARB,
            address(0),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_STRANDED_B1,
                address(0xDEAD),
                uint256(11),
                uint256(7),
                uint256(1 ether),
                uint256(0)
            ),
            _oneToken(1 ether)
        );
    }
    /// #1660 r2 — returns are CHUNKABLE: partial retirement keeps the
    /// remainder retryable against a destination lane ceiling the mirror
    /// cannot read; the wire carries the post-chunk remainder; zero and
    /// over-record amounts refuse.
    function test_StrandedReturn_ChunkedPartialRetirement() public {
        address base = address(0xBA5E);
        _stranded(base, 11, 5 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.StrandedReturnBadAmount.selector,
                uint256(6 ether),
                uint256(5 ether)
            )
        );
        _repat().sendStrandedReturn(base, 11, 6 ether, payable(address(this)));

        _repat().sendStrandedReturn(base, 11, 2 ether, payable(address(this)));
        assertEq(
            _rlens().getStrandedRecovery(base, 11).amount,
            3 ether,
            "remainder retained"
        );
        assertEq(_rlens().getStrandedRecoveryReserved(), 3 ether);
        assertEq(_rlens().getStrandedReturnedCumulative(), 2 ether);
        assertEq(
            ccip.lastPayload(),
            abi.encode(
                ReturnWire.RETURN_WIRE_TAG_STRANDED_B1,
                base,
                uint256(11),
                uint256(7),
                uint256(2 ether),
                uint256(3 ether)
            )
        );
        // The terminal chunk retires the record.
        _repat().sendStrandedReturn(base, 11, 3 ether, payable(address(this)));
        assertEq(_rlens().getStrandedRecovery(base, 11).amount, 0);
        assertEq(_rlens().getStrandedReturnedCumulative(), 5 ether);
    }
}

