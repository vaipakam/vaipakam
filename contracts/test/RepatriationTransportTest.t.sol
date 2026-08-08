// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SetupTest} from "./SetupTest.t.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RepatriationFacet} from "../src/facets/RepatriationFacet.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {ReturnWire} from "../src/crosschain/ReturnWire.sol";
import {VpfiReturnSender} from "../src/crosschain/VpfiReturnSender.sol";
import {VpfiReturnReceiver} from "../src/crosschain/VpfiReturnReceiver.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Stand-in for the CCIP adapter on the SEND side: quotes a settable
///      fee and, like the real `CcipMessenger._pullTokens`, PULLS each
///      declared token amount from the calling handler — so the sender
///      satellite's escrow + exact-approval mechanics are exercised for
///      real, not assumed.
contract MockCcipChannelMessenger {
    using SafeERC20 for IERC20;

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
    VpfiReturnSender internal returnSender;
    VpfiReturnReceiver internal returnReceiver;
    ERC20Mock internal vpfi;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint32 internal constant CHAIN_OP = 10;
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
                            uint256(CHAIN_BASE),
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

    /// Take the Base role: canonical, receiver satellite armed.
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

    // ── Base side: per-authorization ceiling (lane capacity) ────────────────

    function test_Authorize_BoundedByPerAuthCeiling() public {
        _armBase();
        _seedAvail(1, 100 ether);
        _repat().setRepatriationMaxPerAuth(30 ether);
        assertEq(_repat().getRepatriationMaxPerAuth(), 30 ether);
        // Above the ceiling: refused at ISSUANCE — a single CCIP token
        // message above the lane capacity is rejected permanently, so an
        // over-capacity authorization could only ever strand its draw.
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationExceedsPerAuthMax.selector,
                30 ether + 1,
                30 ether
            )
        );
        _repat().authorizeRepatriation(CHAIN_ARB, 30 ether + 1);
        // Exactly at the ceiling passes; zero re-disables the bound.
        _repat().authorizeRepatriation(CHAIN_ARB, 30 ether);
        _repat().setRepatriationMaxPerAuth(0);
        _repat().authorizeRepatriation(CHAIN_ARB, 60 ether);
    }

    function test_SetMaxPerAuth_AdminOnly() public {
        _armBase();
        vm.prank(STRANGER);
        vm.expectRevert();
        _repat().setRepatriationMaxPerAuth(1 ether);
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
            address(0xBA5E), 1, 1 ether, payable(address(this))
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
}
