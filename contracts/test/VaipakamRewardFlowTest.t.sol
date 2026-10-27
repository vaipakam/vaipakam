// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {CcipMessenger} from "../src/crosschain/CcipMessenger.sol";
import {VaipakamRewardMessenger} from "../src/crosschain/VaipakamRewardMessenger.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {MockCcipRouter} from "./mocks/MockCcipRouter.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {
    IRewardMessenger,
    ChainDayReport,
    RewardBroadcastV3
} from "../src/interfaces/IRewardMessenger.sol";

/// @dev Records the reward-ingress calls — stands in for a Vaipakam Diamond.
contract MockRewardDiamond {
    uint32 public lastReportChain;
    uint256 public lastReportDay;
    uint256 public lastReportLender;
    uint256 public lastReportBorrower;
    uint256 public reportCount;
    // #1222 M3 B1 — recycled-field spies.
    uint256 public lastReportRecycledCum;
    uint256 public lastReportRecycledForDay;

    // #2621 — the one report shape's remaining fields.
    uint64 public lastReportCustodyEra;
    uint256 public lastReportCommitRetired;
    uint256 public lastReportCommitReleased;
    uint256 public lastReportRewardLaunch;

    function onChainReportReceived(uint32 src, ChainDayReport calldata r) external {
        lastReportChain = src;
        lastReportDay = r.dayId;
        lastReportLender = r.lenderNumeraire18;
        lastReportBorrower = r.borrowerNumeraire18;
        lastReportRecycledCum = r.recycledCumulative18;
        lastReportRecycledForDay = r.recycledForDay18;
        lastReportCommitRetired = r.commitRetiredCumulative18;
        lastReportCommitReleased = r.commitReleasedCumulative18;
        lastReportCustodyEra = r.custodyEra;
        lastReportRewardLaunch = r.rewardLaunchTimestamp;
        ++reportCount;
    }

    // The V3 broadcast ingress spy — the one broadcast wire (#1944; the
    // production diamond's
    // `RewardReporterFacet.onRewardBroadcastV3Received`). Stored internal +
    // explicit accessor: the auto-getter of a nested-struct member flattens
    // awkwardly.
    RewardBroadcastV3 internal lastV3Stored;
    uint256 public v3Count;

    function onRewardBroadcastV3Received(RewardBroadcastV3 calldata b)
        external
    {
        lastV3Stored = b;
        ++v3Count;
    }

    function lastV3() external view returns (RewardBroadcastV3 memory) {
        return lastV3Stored;
    }

    // #1434 P2-w3 — compensation-quote ingress spy (the production
    // diamond's `RewardCommitmentFacet.onCompQuoteReceived`).
    uint32 public lastQuoteSrcChain;
    uint256 public lastQuoteDay;
    uint256 public lastQuoteLender;
    uint256 public lastQuoteBorrower;
    address public lastQuoteEra;
    uint256 public quoteCount;

    function onCompQuoteReceived(
        uint32 srcChainId,
        uint256 dayId,
        uint256 quotedLender18,
        uint256 quotedBorrower18,
        address sourceEra
    ) external {
        lastQuoteSrcChain = srcChainId;
        lastQuoteDay = dayId;
        lastQuoteLender = quotedLender18;
        lastQuoteBorrower = quotedBorrower18;
        lastQuoteEra = sourceEra;
        ++quoteCount;
    }

    // T-087 Sub 2.C — mirror-side tier ingress capture. The mock simply
    // records the most-recent call so tests can assert the messenger
    // forwarded the right args; the production Diamond's
    // {MirrorTierReceiverFacet} writes `s.userTierCache[user]` here.
    uint256 public lastTierSrcChain;
    address public lastTierUser;
    uint8 public lastTierEffTier;
    uint16 public lastTierEffBps;
    uint40 public lastTierComputedAt;
    uint256 public lastTierNonce;
    uint40 public lastTierExpiry;
    uint16 public lastTierVersion;
    uint256 public tierUpdateCount;

    function onTierUpdateReceived(
        uint256 srcChainId,
        address user,
        uint8 effTier,
        uint16 effBps,
        uint40 computedAt,
        uint256 nonce,
        uint40 expiry,
        uint16 version
    ) external {
        lastTierSrcChain = srcChainId;
        lastTierUser = user;
        lastTierEffTier = effTier;
        lastTierEffBps = effBps;
        lastTierComputedAt = computedAt;
        lastTierNonce = nonce;
        lastTierExpiry = expiry;
        lastTierVersion = version;
        ++tierUpdateCount;
    }

    uint256 public lastBumpSrcChain;
    uint16 public lastBumpVersion;
    uint256 public bumpCount;

    function onVersionBumpedReceived(uint256 srcChainId, uint16 newVersion)
        external
    {
        lastBumpSrcChain = srcChainId;
        lastBumpVersion = newVersion;
        ++bumpCount;
    }

    receive() external payable {}
}

/// @notice Codex #1413 r4 — a diamond stub whose ingress reverts with a
///         reasoned custom error: the messenger must bubble it unchanged.
contract MockRevertingRewardDiamond {
    error DuplicateReport();

    function onChainReportReceived(uint32, ChainDayReport calldata) external pure {
        revert DuplicateReport();
    }
}

/**
 * @title VaipakamRewardFlowTest
 * @notice T-068 Phase 4 — end-to-end tests for the CCIP reward flow.
 *         Two real {CcipMessenger}s carry REPORT (mirror→Base) and
 *         BROADCAST (Base→mirror) between two {VaipakamRewardMessenger}s.
 */
contract VaipakamRewardFlowTest is Test {
    uint256 internal constant MIRROR = 1;
    uint256 internal constant BASE = 8453;
    uint64 internal constant SEL_MIRROR = 5009297550715157269;
    uint64 internal constant SEL_BASE = 15971525489660198786;
    bytes32 internal constant CHANNEL =
        keccak256("vaipakam.ccip.channel.vpfi-reward");
    uint256 internal constant GAS = 400_000;

    // Payload msgType tags (internal constants on the contract).
    uint8 internal constant REPORT = 1;

    address internal owner = makeAddr("owner");

    MockCcipRouter internal router;
    CcipMessenger internal messengerMirror;
    CcipMessenger internal messengerBase;
    VaipakamRewardMessenger internal rewardMirror;
    VaipakamRewardMessenger internal rewardBase;
    MockRewardDiamond internal diamondMirror;
    MockRewardDiamond internal diamondBase;

    uint256 internal fee;

    function setUp() public {
        router = new MockCcipRouter();
        router.setSupported(SEL_MIRROR, true);
        router.setSupported(SEL_BASE, true);
        fee = router.fixedFee();

        diamondMirror = new MockRewardDiamond();
        diamondBase = new MockRewardDiamond();

        messengerMirror = _deployMessenger();
        messengerBase = _deployMessenger();
        rewardMirror = _deployReward(messengerMirror, diamondMirror, false, BASE);
        rewardBase = _deployReward(messengerBase, diamondBase, true, 0);

        vm.startPrank(owner);
        messengerMirror.setChainSelector(BASE, SEL_BASE);
        messengerMirror.setRemoteMessenger(BASE, address(messengerBase));
        messengerMirror.registerChannel(CHANNEL, address(rewardMirror));
        messengerMirror.setChannelPeer(CHANNEL, BASE, address(rewardBase));

        messengerBase.setChainSelector(MIRROR, SEL_MIRROR);
        messengerBase.setRemoteMessenger(MIRROR, address(messengerMirror));
        messengerBase.registerChannel(CHANNEL, address(rewardBase));
        messengerBase.setChannelPeer(CHANNEL, MIRROR, address(rewardMirror));

        uint256[] memory dests = new uint256[](1);
        dests[0] = MIRROR;
        rewardBase.setBroadcastDestinations(dests);
        vm.stopPrank();

        vm.deal(address(diamondMirror), 10 ether);
        vm.deal(address(diamondBase), 10 ether);
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

    function _deployReward(
        CcipMessenger m,
        MockRewardDiamond d,
        bool canonical,
        uint256 baseChainId
    ) internal returns (VaipakamRewardMessenger) {
        VaipakamRewardMessenger impl = new VaipakamRewardMessenger();
        return VaipakamRewardMessenger(
            payable(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        VaipakamRewardMessenger.initialize,
                        (owner, address(m), address(d), canonical, baseChainId, GAS)
                    )
                )
            )
        );
    }

    function _empty()
        internal
        pure
        returns (ICrossChainMessenger.TokenAmount[] memory)
    {
        return new ICrossChainMessenger.TokenAmount[](0);
    }

    // ─── REPORT: mirror → Base ──────────────────────────────────────────────

    function _report(uint256 dayId) internal pure returns (ChainDayReport memory r) {
        r.dayId = dayId;
        r.lenderNumeraire18 = 1_000 ether;
        r.borrowerNumeraire18 = 500 ether;
        r.recycledCumulative18 = 77 ether;
        r.recycledForDay18 = 7 ether;
        r.commitRetiredCumulative18 = 3 ether;
        r.commitReleasedCumulative18 = 1 ether;
        r.custodyEra = 5;
        r.rewardLaunchTimestamp = 1_792_540_800;
    }

    /// #2621 — every field of the one report shape crosses intact, the
    /// reporter's reward-launch clock with it, and the quote prices exactly
    /// the bytes the send emits.
    function test_Report_MirrorToBase() public {
        vm.prank(address(diamondMirror));
        rewardMirror.sendChainReport{value: fee}(
            BASE, _report(42), payable(address(diamondMirror))
        );
        assertEq(router.pendingCount(), 1, "report captured");

        router.deliver(0, SEL_MIRROR);

        assertEq(diamondBase.reportCount(), 1, "Base aggregator got the report");
        assertEq(diamondBase.lastReportChain(), SafeCast.toUint32(MIRROR), "source chain tagged");
        assertEq(diamondBase.lastReportDay(), 42, "dayId");
        assertEq(diamondBase.lastReportLender(), 1_000 ether, "lender numeraire");
        assertEq(diamondBase.lastReportBorrower(), 500 ether, "borrower numeraire");
        assertEq(diamondBase.lastReportRecycledCum(), 77 ether, "recycled cumulative");
        assertEq(diamondBase.lastReportRecycledForDay(), 7 ether, "recycled for-day");
        assertEq(diamondBase.lastReportCommitRetired(), 3 ether, "commit retired");
        assertEq(diamondBase.lastReportCommitReleased(), 1 ether, "commit released");
        assertEq(diamondBase.lastReportCustodyEra(), 5, "custody era");
        assertEq(diamondBase.lastReportRewardLaunch(), 1_792_540_800, "reward-launch clock");
        assertEq(rewardMirror.quoteSendChainReport(BASE, _report(42)), fee, "quote prices the send");
    }

    /// #2621 — a report goes only to the Base the caller names AND this
    /// messenger holds. A disagreeing route reverts the send (and so the
    /// Diamond's close, atomically with its stamp) and the quote alike.
    function test_Report_RevertWhen_RouteMismatch() public {
        vm.prank(address(diamondMirror));
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamRewardMessenger.ReportRouteMismatch.selector, uint256(10), BASE)
        );
        rewardMirror.sendChainReport{value: fee}(10, _report(42), payable(address(diamondMirror)));
        assertEq(router.pendingCount(), 0, "nothing sent along the wrong route");

        vm.expectRevert(
            abi.encodeWithSelector(VaipakamRewardMessenger.ReportRouteMismatch.selector, uint256(10), BASE)
        );
        rewardMirror.quoteSendChainReport(10, _report(42));
    }

    /// #2621 — the canonical messenger holds no Base of its own: it never
    /// sends a report.
    function test_Report_RevertWhen_SentFromCanonical() public {
        vm.prank(address(diamondBase));
        vm.expectRevert(VaipakamRewardMessenger.BaseChainNotConfigured.selector);
        rewardBase.sendChainReport{value: fee}(BASE, _report(42), payable(address(diamondBase)));
    }

    /// #1660 r7 — the kind-7 ack's classification word is validated on
    /// the RAW uint256 before any narrowing: uint8(258) == 2 would forge
    /// quarantine evidence from a malformed peer packet.
    function test_RemitAck_OutOfRangeClassificationRejected() public {
        vm.prank(address(messengerBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.AckClassificationOutOfRange.selector,
                uint256(258)
            )
        );
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            abi.encode(
                uint8(7),
                uint256(1),
                uint256(1 ether),
                address(0xB0B),
                uint256(258)
            ),
            _empty()
        , bytes32(0));
        // The unassigned value 0 fails closed too.
        vm.prank(address(messengerBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.AckClassificationOutOfRange.selector,
                uint256(0)
            )
        );
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            abi.encode(
                uint8(7),
                uint256(1),
                uint256(1 ether),
                address(0xB0B),
                uint256(0)
            ),
            _empty()
        , bytes32(0));
    }

    /// #2621 — the retired report shapes (four-word legacy, six-word B1,
    /// nine-word B4) are refused before decode: there is one report shape,
    /// and prelive rollout is a fresh deploy (no in-flight old reports).
    function test_Report_RetiredShapes_Rejected() public {
        bytes[3] memory retired = [
            abi.encode(REPORT, uint256(42), uint256(1 ether), uint256(1 ether)),
            abi.encode(REPORT, uint256(42), uint256(1 ether), uint256(1 ether), uint256(0), uint256(0)),
            abi.encode(
                REPORT, uint256(42), uint256(1 ether), uint256(1 ether), uint256(0), uint256(0), uint256(0), uint256(0), uint256(5)
            )
        ];
        for (uint256 i; i < retired.length; ++i) {
            vm.prank(address(messengerBase));
            vm.expectRevert(
                abi.encodeWithSelector(
                    VaipakamRewardMessenger.PayloadSizeMismatch.selector,
                    retired[i].length,
                    uint256(10 * 32)
                )
            );
            rewardBase.onCrossChainMessage(MIRROR, address(rewardMirror), retired[i], _empty(), bytes32(0));
        }
        assertEq(diamondBase.reportCount(), 0, "no retired shape reached the ingress");
    }

    /// Codex #1413 r4 — a REASONED ingress failure bubbles unchanged, so CCIP
    /// records the message failed and re-executable.
    function test_Report_ReasonedIngressFailureBubbles() public {
        MockRevertingRewardDiamond revDiamond = new MockRevertingRewardDiamond();
        vm.prank(owner);
        rewardBase.setDiamond(address(revDiamond));

        vm.prank(address(messengerBase));
        vm.expectRevert(MockRevertingRewardDiamond.DuplicateReport.selector);
        rewardBase.onCrossChainMessage(
            MIRROR, address(rewardMirror), abi.encode(REPORT, _report(9)), _empty(), bytes32(0)
        );
    }

    // ─── BROADCAST: Base → mirror (kind 10, the one broadcast wire) ─────────

    function _v2Shared()
        internal
        pure
        returns (IRewardMessenger.BroadcastV2Shared memory)
    {
        return IRewardMessenger.BroadcastV2Shared({
            dayId: 42,
            globalLenderNumeraire18: 9_000 ether,
            globalBorrowerNumeraire18: 4_000 ether,
            capMode: 1,
            capPayloadLender: 11 ether,
            capPayloadBorrower: 7 ether,
            armedFromDay: 40
        });
    }

    function _v2Dest(uint256 chainId)
        internal
        pure
        returns (IRewardMessenger.BroadcastV2PerDest memory)
    {
        return IRewardMessenger.BroadcastV2PerDest({
            destChainId: chainId,
            freshLenderHalf: 20 ether,
            freshBorrowerHalf: 20 ether,
            recycledLenderHalfEquiv: 9 ether,
            recycledBorrowerHalfEquiv: 4 ether,
            recycleConsume: 5 ether,
            keeperAllocate: 0
        });
    }

    /// Full round trip: Base assembles one kind-5 payload for the mirror,
    /// the mirror messenger decodes it into the SAME struct and forwards it
    /// to the V2 diamond ingress — shared consensus fields + this chain's
    /// own funded figures + the embedded destination binding, verbatim.
    /// The per-destination array must cover the configured set exactly.
    function test_BroadcastV3_RevertWhen_DestinationSetMismatch() public {
        IRewardMessenger.BroadcastV3PerDest[] memory dests =
            new IRewardMessenger.BroadcastV3PerDest[](2);
        dests[0] = _v3Dest(MIRROR, false);
        dests[1] = _v3Dest(999, false);

        vm.deal(address(diamondBase), 1 ether);
        vm.prank(address(diamondBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.BroadcastDestinationSetMismatch.selector,
                2,
                1
            )
        );
        rewardBase.broadcastDayV3{value: fee}(
            _v2Shared(), _v3Extras(), dests, payable(address(diamondBase))
        );
    }

    /// A configured destination with no funded entry reverts — never a
    /// silent skip (a mirror left unbroadcast would halt its armed days).
    function test_BroadcastV3_RevertWhen_MissingDestinationEntry() public {
        IRewardMessenger.BroadcastV3PerDest[] memory dests =
            new IRewardMessenger.BroadcastV3PerDest[](1);
        dests[0] = _v3Dest(999, false); // right length, wrong chain

        vm.prank(address(diamondBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.MissingDestinationFunding.selector,
                MIRROR
            )
        );
        rewardBase.broadcastDayV3{value: fee}(
            _v2Shared(), _v3Extras(), dests, payable(address(diamondBase))
        );
    }

    // ─── the retired split attestation (kind 12) ─────────────────────────────

    /// Kind 12 was the Base → mirror split attestation, retired with the
    /// pre-d6 remit wires (generation 7): a stale sender's attestation is
    /// refused as an unknown kind, and nothing reaches the mirror's ingress.
    function test_Receive_RetiredSplitAttestation_IsAnUnknownKind() public {
        vm.prank(address(messengerMirror));
        vm.expectRevert(abi.encodeWithSelector(VaipakamRewardMessenger.UnknownMessageType.selector, uint8(12)));
        rewardMirror.onCrossChainMessage(
            BASE,
            address(rewardBase),
            abi.encode(uint8(12), address(0xBA5E), uint256(7), uint256(60), uint256(40)),
            _empty()
        , bytes32(0));
    }

    // ─── the retired broadcast kinds (2 and 5, #1944) ─────────────────────────

    /// Kinds 2 (the flat broadcast) and 5 (the per-destination V2 broadcast)
    /// are retired with wire generation 8, and never reused: a stale sender's
    /// packet carrying either tag is refused as an unknown kind, and nothing
    /// reaches the mirror's ingress. Kind 2's eight words share the
    /// TierUpdated size, so it passes the size gate and meets the kind
    /// dispatch; kind 5 is padded to the kind-10 size for the same reason.
    function test_Receive_RetiredBroadcastKinds_AreUnknownKinds() public {
        bytes memory kind2 = abi.encode(
            uint8(2), uint256(1), uint256(0), uint256(0), uint256(0), uint256(0), uint256(0), uint256(0)
        );
        bytes memory kind5 = new bytes(23 * 32);
        kind5[31] = bytes1(uint8(5));
        bytes[2] memory retired = [kind2, kind5];
        uint8[2] memory kinds = [uint8(2), uint8(5)];
        for (uint256 i; i < retired.length; ++i) {
            vm.prank(address(messengerMirror));
            vm.expectRevert(
                abi.encodeWithSelector(VaipakamRewardMessenger.UnknownMessageType.selector, kinds[i])
            );
            rewardMirror.onCrossChainMessage(BASE, address(rewardBase), retired[i], _empty(), bytes32(0));
        }
        assertEq(diamondMirror.v3Count(), 0, "no retired kind reached the ingress");
    }

    /// The old fifteen-word kind-5 payload is no longer in the size union at
    /// all, so it is refused before any decode.
    function test_Receive_RetiredKind5Shape_Rejected() public {
        bytes memory legacy = new bytes(15 * 32);
        legacy[31] = bytes1(uint8(5));
        vm.prank(address(messengerMirror));
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamRewardMessenger.PayloadSizeMismatch.selector, 15 * 32, 10 * 32)
        );
        rewardMirror.onCrossChainMessage(BASE, address(rewardBase), legacy, _empty(), bytes32(0));
    }

    // ─── #1434 P2-w1 — per-destination broadcast V3 (kind-10) ───────────────

    function _v3Extras()
        internal
        pure
        returns (IRewardMessenger.BroadcastV3Extras memory)
    {
        return IRewardMessenger.BroadcastV3Extras({
            finalizedAt: 1_700_000_000,
            lapseScheduleVersion: 2,
            lapseWindowSeconds: 7 days,
            dispatchCutoffGap: 24 hours,
            dayScheduleFloorHalf: 20e18,
            dayRecycledBudgetHalf: 10e18
        });
    }

    function _v3Dest(uint256 chainId, bool zeroed)
        internal
        pure
        returns (IRewardMessenger.BroadcastV3PerDest memory)
    {
        return IRewardMessenger.BroadcastV3PerDest({
            base: _v2Dest(chainId),
            zeroedForDest: zeroed
        });
    }

    /// Full round trip: Base assembles one kind-10 payload for the mirror,
    /// the mirror messenger decodes it and forwards it to the V3 diamond
    /// ingress — the nested V2 fields verbatim PLUS the frozen clock facts,
    /// with `baseDeployment` stamped by the SENDING messenger from its own
    /// Diamond binding (never caller-supplied).
    function test_BroadcastV3_BaseToMirror() public {
        IRewardMessenger.BroadcastV3PerDest[] memory dests =
            new IRewardMessenger.BroadcastV3PerDest[](1);
        dests[0] = _v3Dest(MIRROR, true);

        vm.prank(address(diamondBase));
        rewardBase.broadcastDayV3{value: fee}(
            _v2Shared(), _v3Extras(), dests, payable(address(diamondBase))
        );
        assertEq(router.pendingCount(), 1, "one packet per destination");

        router.deliver(0, SEL_BASE);

        assertEq(diamondMirror.v3Count(), 1, "mirror got the V3 broadcast");
        RewardBroadcastV3 memory got = diamondMirror.lastV3();
        assertEq(got.v2.dayId, 42);
        assertEq(got.v2.globalLenderNumeraire18, 9_000 ether);
        assertEq(got.v2.globalBorrowerNumeraire18, 4_000 ether);
        assertEq(got.v2.capMode, 1);
        assertEq(got.v2.armedFromDay, 40);
        assertEq(got.v2.recycleConsume, 5 ether);
        assertEq(got.v2.destChainId, MIRROR, "destination binding");
        assertEq(got.finalizedAt, 1_700_000_000, "frozen clock");
        assertEq(got.lapseScheduleVersion, 2, "frozen version");
        assertEq(got.lapseWindowSeconds, 7 days, "inline window");
        assertEq(got.dispatchCutoffGap, 24 hours, "inline gap");
        assertTrue(got.zeroedForDest, "frozen zeroed marker");
        assertEq(
            got.baseDeployment,
            address(diamondBase),
            "era identity stamped from the sender's Diamond binding"
        );
    }

    /// The heal path sends to a lane OUTSIDE the configured broadcast set —
    /// deliberately exempt from set coverage (a mirror removed from the
    /// list must remain reachable for a heal).
    function test_BroadcastV3Single_IgnoresConfiguredSet() public {
        vm.prank(owner);
        rewardBase.setBroadcastDestinations(new uint256[](0));

        vm.prank(address(diamondBase));
        bytes32 id = rewardBase.broadcastDayV3Single{value: fee}(
            _v2Shared(), _v3Extras(), _v3Dest(MIRROR, false),
            payable(address(diamondBase))
        );
        assertTrue(id != bytes32(0), "messageId returned");
        assertEq(router.pendingCount(), 1, "single packet dispatched");

        router.deliver(0, SEL_BASE);
        assertEq(diamondMirror.v3Count(), 1, "mirror got the single V3");
    }

    function test_BroadcastV3_RevertWhen_NotDiamond() public {
        IRewardMessenger.BroadcastV3PerDest[] memory dests =
            new IRewardMessenger.BroadcastV3PerDest[](1);
        dests[0] = _v3Dest(MIRROR, false);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(VaipakamRewardMessenger.OnlyDiamond.selector);
        rewardBase.broadcastDayV3{value: fee}(
            _v2Shared(), _v3Extras(), dests, payable(owner)
        );
    }

    function test_BroadcastV3Single_RevertWhen_NotDiamond() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(VaipakamRewardMessenger.OnlyDiamond.selector);
        rewardBase.broadcastDayV3Single{value: fee}(
            _v2Shared(), _v3Extras(), _v3Dest(MIRROR, false), payable(owner)
        );
    }

    function test_Receive_BroadcastV3_RevertOnCanonical() public {
        RewardBroadcastV3 memory b;
        b.v2.dayId = 1;
        b.v2.destChainId = BASE;
        b.finalizedAt = 1;
        vm.prank(address(messengerBase));
        vm.expectRevert(VaipakamRewardMessenger.BroadcastOnCanonical.selector);
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            abi.encode(uint8(10), b),
            _empty()
        , bytes32(0));
    }

    /// The 21-word pin: a truncated kind-10 payload is rejected before any
    /// decode (20 words is not in the size union at all).
    function test_Receive_BroadcastV3_WrongSize_Rejected() public {
        bytes memory truncated = new bytes(20 * 32);
        truncated[31] = bytes1(uint8(10));
        vm.prank(address(messengerMirror));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.PayloadSizeMismatch.selector,
                20 * 32,
                10 * 32
            )
        );
        rewardMirror.onCrossChainMessage(
            BASE, address(rewardBase), truncated, _empty()
        , bytes32(0));
    }

    function test_QuoteBroadcastDayV3_AndSingle() public view {
        IRewardMessenger.BroadcastV3PerDest[] memory dests =
            new IRewardMessenger.BroadcastV3PerDest[](1);
        dests[0] = _v3Dest(MIRROR, false);
        assertEq(
            rewardBase.quoteBroadcastDayV3(_v2Shared(), _v3Extras(), dests),
            fee,
            "one lane, one fee"
        );
        assertEq(
            rewardBase.quoteBroadcastDayV3Single(
                _v2Shared(), _v3Extras(), dests[0]
            ),
            fee,
            "single lane fee"
        );
    }

    // ─── Sender access control ──────────────────────────────────────────────

    function test_SendChainReport_RevertWhen_NotDiamond() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(VaipakamRewardMessenger.OnlyDiamond.selector);
        rewardMirror.sendChainReport{value: fee}(BASE, _report(1), payable(owner));
    }

    /// @dev #1434 P2-w3 — the quote send is Diamond-only like every other
    ///      mirror-side dispatch (the Diamond enforces the zeroed-day +
    ///      completeness preconditions).
    function test_SendCompQuote_RevertWhen_NotDiamond() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(VaipakamRewardMessenger.OnlyDiamond.selector);
        rewardMirror.sendCompQuote{value: fee}(1, 0, 0, payable(owner));
    }

    /// @dev #1434 P2-w3 — kind 11 end to end: mirror dispatch → CCIP →
    ///      Base messenger → the diamond's comp-quote ingress, args intact.
    function test_CompQuote_FullFlow_MirrorToBase() public {
        vm.prank(address(diamondMirror));
        rewardMirror.sendCompQuote{value: fee}(
            42, 5e18, 2e18, payable(address(diamondMirror))
        );
        assertEq(router.pendingCount(), 1, "quote captured");

        router.deliver(0, SEL_MIRROR);

        assertEq(diamondBase.quoteCount(), 1, "Base ingress fired");
        assertEq(
            uint256(diamondBase.lastQuoteSrcChain()),
            MIRROR,
            "source chain preserved"
        );
        assertEq(diamondBase.lastQuoteDay(), 42, "day");
        assertEq(diamondBase.lastQuoteLender(), 5e18, "lender quote");
        assertEq(diamondBase.lastQuoteBorrower(), 2e18, "borrower quote");
        // #1636 r1 — the messenger stamped its own paired diamond as the
        // era word.
        assertEq(
            diamondBase.lastQuoteEra(),
            address(diamondMirror),
            "sending-era stamp"
        );
    }

    /// @dev #1434 P2-w3 — a quote-kind payload delivered to a MIRROR
    ///      instance is refused (canonical-only, like every mirror→Base
    ///      kind).
    function test_Receive_RevertWhen_CompQuoteOnMirror() public {
        vm.prank(address(messengerMirror));
        vm.expectRevert(VaipakamRewardMessenger.ReportOnMirror.selector);
        rewardMirror.onCrossChainMessage(
            BASE,
            address(rewardBase),
            // 5 words (#1636 r1 era word) so the size pin passes and the
            // canonical-only check is what fires.
            abi.encode(
                uint8(11), uint256(1), uint256(0), uint256(0), address(0)
            ),
            _empty()
        , bytes32(0));
    }

    // ─── Inbound routing + integrity guards ─────────────────────────────────

    function test_Receive_RevertWhen_NotMessenger() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.NotMessenger.selector, address(this)
            )
        );
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            abi.encode(REPORT, _report(1)),
            _empty()
        , bytes32(0));
    }

    function test_Receive_RevertWhen_ReportOnMirror() public {
        // A REPORT-kind payload delivered to a mirror instance.
        vm.prank(address(messengerMirror));
        vm.expectRevert(VaipakamRewardMessenger.ReportOnMirror.selector);
        rewardMirror.onCrossChainMessage(
            BASE,
            address(rewardBase),
            abi.encode(REPORT, _report(1)),
            _empty()
        , bytes32(0));
    }

    function test_Receive_RevertWhen_PayloadSizeWrong() public {
        // A short (padded-attack-shaped) payload — the length pin rejects it.
        bytes memory short = abi.encode(REPORT);
        vm.prank(address(messengerBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.PayloadSizeMismatch.selector,
                short.length,
                uint256(10 * 32)
            )
        );
        rewardBase.onCrossChainMessage(
            MIRROR, address(rewardMirror), short, _empty()
        , bytes32(0));
    }

    function test_Receive_RevertWhen_UnknownMessageType() public {
        // The tag allocation reaches LAST, not the lowest free one. Kinds are
        // handed out upward from 1, so 255 is the only tag a future kind
        // cannot quietly claim — and quietly claiming it is exactly what
        // happened here: this test named kind 12 with a comment telling the
        // next author to re-point it, #1566 transport epochs PR 3a took 12
        // for the split attestation, and the test silently stopped asserting
        // the default branch (it began asserting that kind's payload-size
        // check instead). A test of "no handler matched" must name a tag no
        // handler will ever match.
        vm.prank(address(messengerBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.UnknownMessageType.selector, type(uint8).max
            )
        );
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            abi.encode(type(uint8).max, uint256(1), uint256(0), uint256(0)),
            _empty()
        , bytes32(0));
    }

    // ─── Quotes ─────────────────────────────────────────────────────────────

    function test_Quotes() public view {
        assertEq(
            rewardMirror.quoteSendChainReport(BASE, _report(1)), fee, "report quote"
        );
        // #1434 P2-w3 — the compensation-quote dispatch fee.
        assertEq(
            rewardMirror.quoteSendCompQuote(1, 0, 0), fee, "comp-quote fee"
        );
        // One broadcast destination → one fee.
        IRewardMessenger.BroadcastV3PerDest[] memory dests =
            new IRewardMessenger.BroadcastV3PerDest[](1);
        dests[0] = _v3Dest(MIRROR, false);
        assertEq(
            rewardBase.quoteBroadcastDayV3(_v2Shared(), _v3Extras(), dests),
            fee,
            "broadcast quote"
        );
    }

    // ─── Pause ──────────────────────────────────────────────────────────────

    function test_Pause_FreezesReport() public {
        vm.prank(owner);
        rewardMirror.pause();
        vm.prank(address(diamondMirror));
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        rewardMirror.sendChainReport{value: fee}(
            BASE, _report(1), payable(address(diamondMirror))
        );
    }

    // ─── Lossy chain-id cast guard (Codex review) ───────────────────────────

    function test_Receive_RevertWhen_ReportChainIdTooLarge() public {
        // A source chain id beyond uint32 would silently alias onto
        // another chain's reward aggregation — rejected before ingress.
        uint256 bigChain = uint256(type(uint32).max) + 1;
        vm.prank(address(messengerBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.ChainIdTooLarge.selector, bigChain
            )
        );
        rewardBase.onCrossChainMessage(
            bigChain,
            address(rewardMirror),
            abi.encode(REPORT, _report(1)),
            _empty()
        , bytes32(0));
    }

    // ─── Token-bearing message rejected (Codex review) ──────────────────────

    function test_Receive_RevertWhen_TokensAttached() public {
        // The reward channel is data-only — a token-bearing message has
        // no recovery path here, so it must revert (CCIP keeps it
        // re-executable) rather than strand the tokens on this contract.
        ICrossChainMessenger.TokenAmount[] memory toks =
            new ICrossChainMessenger.TokenAmount[](1);
        toks[0] = ICrossChainMessenger.TokenAmount({
            token: address(0xBEEF),
            amount: 1
        });
        vm.prank(address(messengerBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.UnexpectedTokens.selector, uint256(1)
            )
        );
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            abi.encode(REPORT, _report(1)),
            toks
        , bytes32(0));
    }

    // ─── T-087 Sub 2.B — TierUpdated + VersionBumped surface ────────────────

    uint8 internal constant TIER_UPDATED = 3;
    uint8 internal constant VERSION_BUMPED = 4;

    function test_SendTierUpdate_HappyPath() public {
        address user = makeAddr("user");
        // `sendTierUpdateTo` is a Base → mirror push, one lane at a time,
        // so the Diamond-paired instance is `rewardBase`.
        vm.prank(address(diamondBase));
        rewardBase.sendTierUpdateTo{value: fee}(
            MIRROR,
            user,
            uint8(2),     // effective tier
            uint16(1500), // effective bps
            uint40(123),  // computedAt
            uint256(7),   // nonce
            type(uint40).max, // tierExpirySec sentinel
            uint16(3),    // tierTableVersion
            payable(address(diamondBase))
        );
        assertEq(router.pendingCount(), 1, "tier push captured");

        // Confirm the mirror's inbound emits TierUpdateReceived with the
        // round-tripped payload. Sub 2.C wires the Diamond forwarding; for
        // Sub 2.B the receive event is the contract's visible artefact.
        vm.expectEmit(true, true, false, true, address(rewardMirror));
        emit VaipakamRewardMessenger.TierUpdateReceived(
            BASE,
            user,
            2,
            1500,
            123,
            7,
            type(uint40).max,
            3
        );
        router.deliver(0, SEL_BASE);
    }

    function test_SendVersionBumped_HappyPath() public {
        vm.prank(address(diamondBase));
        rewardBase.sendVersionBumped{value: fee}(
            uint16(42),
            payable(address(diamondBase))
        );
        assertEq(router.pendingCount(), 1, "version bump captured");

        vm.expectEmit(true, true, false, true, address(rewardMirror));
        emit VaipakamRewardMessenger.VersionBumpReceived(BASE, 42);
        router.deliver(0, SEL_BASE);
    }

    function test_SendTierUpdate_RevertWhen_NotDiamond() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(VaipakamRewardMessenger.OnlyDiamond.selector);
        rewardBase.sendTierUpdateTo{value: fee}(
            MIRROR, address(this), 1, 1000, 0, 1, 0, 1, payable(owner)
        );
    }

    /// @dev #911 — a single-lane tier push refuses a chain the owner did not
    ///      put on the broadcast list.
    function test_SendTierUpdateTo_RevertWhen_NotBroadcastDestination() public {
        vm.deal(address(diamondBase), 1 ether);
        vm.prank(address(diamondBase));
        vm.expectRevert(
            abi.encodeWithSelector(VaipakamRewardMessenger.NotBroadcastDestination.selector, uint256(999))
        );
        rewardBase.sendTierUpdateTo{value: fee}(
            999, address(this), 1, 1000, 0, 1, 0, 1, payable(owner)
        );
    }

    function test_SendVersionBumped_RevertWhen_NotDiamond() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(VaipakamRewardMessenger.OnlyDiamond.selector);
        rewardBase.sendVersionBumped{value: fee}(1, payable(owner));
    }

    function test_Receive_TierUpdated_RevertOnCanonical() public {
        // A TIER_UPDATED-kind payload delivered to the canonical instance
        // (Base) — only mirrors honour these.
        bytes memory payload = abi.encode(
            TIER_UPDATED,
            address(0xdead),
            uint8(2),
            uint16(1500),
            uint40(123),
            uint256(7),
            type(uint40).max,
            uint16(3)
        );
        vm.prank(address(messengerBase));
        vm.expectRevert(VaipakamRewardMessenger.BroadcastOnCanonical.selector);
        rewardBase.onCrossChainMessage(
            MIRROR, address(rewardMirror), payload, _empty()
        , bytes32(0));
    }

    function test_Receive_VersionBumped_RevertOnCanonical() public {
        bytes memory payload = abi.encode(VERSION_BUMPED, uint16(7));
        vm.prank(address(messengerBase));
        vm.expectRevert(VaipakamRewardMessenger.BroadcastOnCanonical.selector);
        rewardBase.onCrossChainMessage(
            MIRROR, address(rewardMirror), payload, _empty()
        , bytes32(0));
    }

    function test_Receive_TierUpdated_RevertOnWrongSize() public {
        // A REPORT-shaped payload (4 words) tagged with TIER_UPDATED kind.
        // The per-type size check catches the mismatch (a packed 4-word
        // tier push WOULD pass the outer 3-shape size gate but fail the
        // inner exact-size check).
        bytes memory wrongSize = abi.encode(
            TIER_UPDATED, uint256(1), uint256(2), uint256(3)
        );
        vm.prank(address(messengerMirror));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.PayloadSizeMismatch.selector,
                wrongSize.length,
                uint256(8 * 32)
            )
        );
        rewardMirror.onCrossChainMessage(
            BASE, address(rewardBase), wrongSize, _empty()
        , bytes32(0));
    }

    function test_Receive_RevertOnInvalidSize() public {
        // A 7-word payload — not in the accepted union {2, 3, 4, 5, 6, 8,
        // 15, 21}. The outer size gate catches it before decode. (This
        // test used a 3-word payload until #1568 C2 claimed 3 words for
        // the repatriation cancel, then a 5-word one until #1434 P2-w3
        // claimed 5 for the comp quote; #1434 P2-w1 claimed 21 for the V3
        // broadcast.)
        bytes memory sevenWords = abi.encode(
            REPORT,
            uint256(1),
            uint256(2),
            uint256(3),
            uint256(4),
            uint256(5),
            uint256(6)
        );
        vm.prank(address(messengerMirror));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.PayloadSizeMismatch.selector,
                sevenWords.length,
                uint256(10 * 32)
            )
        );
        rewardMirror.onCrossChainMessage(
            BASE, address(rewardBase), sevenWords, _empty()
        , bytes32(0));
    }

    function test_QuoteSendTierUpdateTo_ReturnsNonZero() public view {
        uint256 quoted = rewardBase.quoteSendTierUpdateTo(
            MIRROR, address(0xbeef), 1, 1000, 0, 1, 0, 1
        );
        assertEq(quoted, fee, "quote covers the one lane");
    }

    function test_QuoteSendVersionBumped_ReturnsNonZero() public view {
        uint256 quoted = rewardBase.quoteSendVersionBumped(uint16(1));
        assertEq(quoted, fee, "quote covers the single configured destination");
    }
}
