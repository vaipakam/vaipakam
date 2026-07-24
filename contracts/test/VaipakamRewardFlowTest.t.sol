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
    RewardBroadcastV2
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

    uint256 public lastBcastDay;
    uint256 public lastBcastLender;
    uint256 public lastBcastBorrower;
    uint256 public bcastCount;

    function onChainReportReceived(
        uint32 src,
        uint256 day,
        uint256 l,
        uint256 b,
        uint256 recycledCum,
        uint256 recycledForDay
    ) external {
        lastReportChain = src;
        lastReportDay = day;
        lastReportLender = l;
        lastReportBorrower = b;
        lastReportRecycledCum = recycledCum;
        lastReportRecycledForDay = recycledForDay;
        ++reportCount;
    }

    /// Codex #1413 r3 — the legacy ingress overload the production facet
    /// also keeps: a decoded four-word wire report dispatches THIS selector.
    function onChainReportReceived(
        uint32 src,
        uint256 day,
        uint256 l,
        uint256 b
    ) external {
        lastReportChain = src;
        lastReportDay = day;
        lastReportLender = l;
        lastReportBorrower = b;
        lastReportRecycledCum = 0;
        lastReportRecycledForDay = 0;
        ++reportCount;
    }

    function onRewardBroadcastReceived(
        uint256 day,
        uint256 l,
        uint256 b,
        uint256, /* capThreshold18 */
        uint256, /* scheduleFloorHalf (PR-3c) */
        uint256, /* recycledHalf */
        uint256 /* armedFromDay */
    ) external {
        lastBcastDay = day;
        lastBcastLender = l;
        lastBcastBorrower = b;
        ++bcastCount;
    }

    // #1222 M3 B2-b — V2 broadcast ingress spy (the production diamond's
    // `RewardReporterFacet.onRewardBroadcastV2Received`).
    RewardBroadcastV2 public lastV2;
    uint256 public v2Count;

    function onRewardBroadcastV2Received(RewardBroadcastV2 calldata b)
        external
    {
        lastV2 = b;
        ++v2Count;
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

/// @notice Codex #1413 r3 — a stand-in for a PRE-#1222 Base diamond: only
///         the four-argument ingress exists. Proves the messenger routes a
///         legacy wire report to the legacy selector (and that the six-word
///         shape genuinely requires the widened diamond).
contract MockLegacyOnlyRewardDiamond {
    error FunctionDoesNotExist();

    uint256 public lastReportChain;
    uint256 public lastReportDay;
    uint256 public reportCount;

    function onChainReportReceived(
        uint32 src,
        uint256 day,
        uint256,
        uint256
    ) external {
        lastReportChain = src;
        lastReportDay = day;
        ++reportCount;
    }

    /// Mimic the production Diamond's fallback: an unrouted selector
    /// reverts with the explicit error, never empty data — the ONLY shape
    /// the messenger's r5 downgrade gate accepts.
    fallback() external payable {
        revert FunctionDoesNotExist();
    }
}

/// @notice Codex #1413 r5 — a stub whose widened-ingress call reverts with
///         EMPTY data (no such selector, no diamond-style fallback): the
///         OOG-analog shape. The messenger must NOT downgrade — only the
///         diamond's explicit FunctionDoesNotExist() qualifies.
contract MockEmptyRevertingRewardDiamond {
    uint256 public legacyCalls;

    function onChainReportReceived(uint32, uint256, uint256, uint256)
        external
    {
        ++legacyCalls;
    }
}

/// @notice Codex #1413 r4 — a diamond stub whose WIDENED ingress reverts
///         with a reasoned custom error: the messenger must bubble it, never
///         downgrade to the legacy selector.
contract MockRevertingRewardDiamond {
    error DuplicateReport();

    uint256 public legacyCalls;

    function onChainReportReceived(
        uint32,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256
    ) external pure {
        revert DuplicateReport();
    }

    function onChainReportReceived(uint32, uint256, uint256, uint256)
        external
    {
        ++legacyCalls;
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
    uint8 internal constant BROADCAST = 2;

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

    function test_Report_MirrorToBase() public {
        vm.prank(address(diamondMirror));
        rewardMirror.sendChainReport{value: fee}(
            42,
            1_000 ether,
            500 ether,
            77 ether,
            7 ether,
            payable(address(diamondMirror))
        );
        assertEq(router.pendingCount(), 1, "report captured");

        router.deliver(0, SEL_MIRROR);

        assertEq(diamondBase.reportCount(), 1, "Base aggregator got the report");
        assertEq(diamondBase.lastReportChain(), SafeCast.toUint32(MIRROR), "source chain tagged");
        assertEq(diamondBase.lastReportDay(), 42, "dayId");
        assertEq(diamondBase.lastReportLender(), 1_000 ether, "lender numeraire");
        assertEq(diamondBase.lastReportBorrower(), 500 ether, "borrower numeraire");
        // #1222 M3 B1 — the recycled pair rides the same six-word report.
        assertEq(diamondBase.lastReportRecycledCum(), 77 ether, "recycled cumulative");
        assertEq(diamondBase.lastReportRecycledForDay(), 7 ether, "recycled for-day");
    }

    /// #1222 M3 B1 — Base keeps ACCEPTING the legacy four-word report shape
    /// (a delayed CCIP delivery or a not-yet-upgraded mirror): recycled
    /// fields decode as zero, everything else lands unchanged.
    function test_Report_LegacyFourWordShape_StillAccepted() public {
        vm.prank(address(messengerBase));
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            abi.encode(REPORT, uint256(42), uint256(1_000 ether), uint256(500 ether)),
            _empty()
        );

        assertEq(diamondBase.reportCount(), 1, "legacy report accepted");
        assertEq(diamondBase.lastReportDay(), 42, "dayId");
        assertEq(diamondBase.lastReportLender(), 1_000 ether, "lender numeraire");
        assertEq(diamondBase.lastReportRecycledCum(), 0, "recycled cum defaults 0");
        assertEq(diamondBase.lastReportRecycledForDay(), 0, "recycled for-day defaults 0");
    }

    /// Codex #1413 r1 — the LEGACY four-argument sender overload stays
    /// callable (a not-yet-upgraded mirror diamond on an upgraded
    /// messenger) and emits the legacy four-word payload, which every Base
    /// version accepts.
    function test_Report_LegacySenderOverload_StillWorks() public {
        vm.prank(address(diamondMirror));
        rewardMirror.sendChainReport{value: fee}(
            42, 1_000 ether, 500 ether, payable(address(diamondMirror))
        );
        assertEq(router.pendingCount(), 1, "legacy send captured");

        router.deliver(0, SEL_MIRROR);

        assertEq(diamondBase.reportCount(), 1, "Base accepted the legacy report");
        assertEq(diamondBase.lastReportLender(), 1_000 ether, "lender numeraire");
        assertEq(diamondBase.lastReportRecycledCum(), 0, "no recycled figures travel");
        assertEq(diamondBase.lastReportRecycledForDay(), 0, "no recycled figures travel");
    }

    /// Codex #1413 r3 — a LEGACY wire report dispatches the LEGACY ingress
    /// selector, so an upgraded messenger in front of a PRE-#1222 Base
    /// diamond (which only exposes the four-argument ingress) keeps
    /// delivering in-flight legacy reports through the rollout window.
    function test_Report_LegacyWire_DispatchesLegacyIngressSelector() public {
        // A diamond stub exposing ONLY the pre-#1222 four-argument ingress.
        MockLegacyOnlyRewardDiamond legacyDiamond =
            new MockLegacyOnlyRewardDiamond();
        vm.prank(owner);
        rewardBase.setDiamond(address(legacyDiamond));

        vm.prank(address(messengerBase));
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            abi.encode(REPORT, uint256(7), uint256(11 ether), uint256(3 ether)),
            _empty()
        );
        assertEq(legacyDiamond.reportCount(), 1, "legacy diamond got the report");
        assertEq(legacyDiamond.lastReportDay(), 7);

        // Codex r4 — a SIX-word report against the legacy-only diamond
        // downgrades to the legacy ingress selector (recycled figures
        // dropped for the window) instead of failing toward a grace-zeroed
        // day: the missing-selector revert is recognized, nothing else is.
        vm.prank(address(messengerBase));
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            abi.encode(
                REPORT, uint256(8), uint256(1 ether), uint256(1 ether), uint256(9 ether), uint256(9 ether)
            ),
            _empty()
        );
        assertEq(legacyDiamond.reportCount(), 2, "six-word report downgraded, not lost");
        assertEq(legacyDiamond.lastReportDay(), 8);
    }

    /// Codex #1413 r5 — an EMPTY ingress revert (the OOG-analog: the real
    /// diamond's missing-selector path always carries FunctionDoesNotExist)
    /// must NOT downgrade — the report stays failed/retryable.
    function test_Report_EmptyRevertIngressDoesNotDowngrade() public {
        MockEmptyRevertingRewardDiamond stub =
            new MockEmptyRevertingRewardDiamond();
        vm.prank(owner);
        rewardBase.setDiamond(address(stub));

        vm.prank(address(messengerBase));
        vm.expectRevert();
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            abi.encode(
                REPORT, uint256(9), uint256(1 ether), uint256(1 ether), uint256(0), uint256(0)
            ),
            _empty()
        );
        assertEq(stub.legacyCalls(), 0, "no downgrade on an empty revert");
    }

    /// Codex #1413 r4 — a REASONED ingress failure must NOT downgrade: only
    /// the missing-selector shape does. A reverting widened ingress with a
    /// custom error bubbles unchanged.
    function test_Report_ReasonedIngressFailureBubbles() public {
        MockRevertingRewardDiamond revDiamond = new MockRevertingRewardDiamond();
        vm.prank(owner);
        rewardBase.setDiamond(address(revDiamond));

        vm.prank(address(messengerBase));
        vm.expectRevert(MockRevertingRewardDiamond.DuplicateReport.selector);
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            abi.encode(
                REPORT, uint256(9), uint256(1 ether), uint256(1 ether), uint256(0), uint256(0)
            ),
            _empty()
        );
        assertEq(revDiamond.legacyCalls(), 0, "no downgrade on a reasoned failure");
    }

    /// #1222 M3 B1 — a five-word report is neither the legacy nor the current
    /// shape: rejected as a padded/truncated packet.
    function test_Report_FiveWordShape_Rejected() public {
        bytes memory padded = abi.encode(
            REPORT, uint256(42), uint256(1 ether), uint256(1 ether), uint256(1 ether)
        );
        vm.prank(address(messengerBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.PayloadSizeMismatch.selector,
                uint256(5 * 32),
                uint256(6 * 32)
            )
        );
        rewardBase.onCrossChainMessage(
            MIRROR, address(rewardMirror), padded, _empty()
        );
    }

    // ─── BROADCAST: Base → mirror ───────────────────────────────────────────

    function test_Broadcast_BaseToMirror() public {
        vm.prank(address(diamondBase));
        rewardBase.broadcastGlobal{value: fee}(
            42, 9_000 ether, 4_000 ether, type(uint256).max,
            0, 0, 0, payable(address(diamondBase))
        );
        assertEq(router.pendingCount(), 1, "broadcast captured");

        router.deliver(0, SEL_BASE);

        assertEq(diamondMirror.bcastCount(), 1, "mirror reporter got the broadcast");
        assertEq(diamondMirror.lastBcastDay(), 42, "dayId");
        assertEq(diamondMirror.lastBcastLender(), 9_000 ether, "global lender");
        assertEq(diamondMirror.lastBcastBorrower(), 4_000 ether, "global borrower");
    }

    // ─── #1222 M3 B2-b — per-destination broadcast V2 ───────────────────────

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
    function test_BroadcastV2_BaseToMirror() public {
        IRewardMessenger.BroadcastV2PerDest[] memory dests =
            new IRewardMessenger.BroadcastV2PerDest[](1);
        dests[0] = _v2Dest(MIRROR);

        vm.prank(address(diamondBase));
        rewardBase.broadcastDayV2{value: fee}(
            _v2Shared(), dests, payable(address(diamondBase))
        );
        assertEq(router.pendingCount(), 1, "one packet per destination");

        router.deliver(0, SEL_BASE);

        assertEq(diamondMirror.v2Count(), 1, "mirror got the V2 broadcast");
        assertEq(diamondMirror.bcastCount(), 0, "legacy ingress untouched");
        (
            uint256 dayId,
            uint256 gL,
            uint256 gB,
            uint8 capMode,
            uint256 capL,
            uint256 capB,
            uint256 armedFrom,
            uint256 freshL,
            uint256 freshB,
            uint256 recL,
            uint256 recB,
            uint256 consume,
            uint256 keeper,
            uint256 destChainId
        ) = diamondMirror.lastV2();
        assertEq(dayId, 42);
        assertEq(gL, 9_000 ether);
        assertEq(gB, 4_000 ether);
        assertEq(capMode, 1);
        assertEq(capL, 11 ether);
        assertEq(capB, 7 ether);
        assertEq(armedFrom, 40);
        assertEq(freshL, 20 ether);
        assertEq(freshB, 20 ether);
        assertEq(recL, 9 ether);
        assertEq(recB, 4 ether);
        assertEq(consume, 5 ether);
        assertEq(keeper, 0);
        assertEq(destChainId, MIRROR, "replay-stable destination binding");
    }

    /// The per-destination array must cover the configured set exactly.
    function test_BroadcastV2_RevertWhen_DestinationSetMismatch() public {
        IRewardMessenger.BroadcastV2PerDest[] memory dests =
            new IRewardMessenger.BroadcastV2PerDest[](2);
        dests[0] = _v2Dest(MIRROR);
        dests[1] = _v2Dest(999);

        vm.deal(address(diamondBase), 1 ether);
        vm.prank(address(diamondBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.BroadcastDestinationSetMismatch.selector,
                2,
                1
            )
        );
        rewardBase.broadcastDayV2{value: fee}(
            _v2Shared(), dests, payable(address(diamondBase))
        );
    }

    /// A configured destination with no funded entry reverts — never a
    /// silent skip (a mirror left unbroadcast would halt its armed days).
    function test_BroadcastV2_RevertWhen_MissingDestinationEntry() public {
        IRewardMessenger.BroadcastV2PerDest[] memory dests =
            new IRewardMessenger.BroadcastV2PerDest[](1);
        dests[0] = _v2Dest(999); // right length, wrong chain

        vm.prank(address(diamondBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.MissingDestinationFunding.selector,
                MIRROR
            )
        );
        rewardBase.broadcastDayV2{value: fee}(
            _v2Shared(), dests, payable(address(diamondBase))
        );
    }

    function test_BroadcastV2_RevertWhen_NotDiamond() public {
        IRewardMessenger.BroadcastV2PerDest[] memory dests =
            new IRewardMessenger.BroadcastV2PerDest[](1);
        dests[0] = _v2Dest(MIRROR);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(VaipakamRewardMessenger.OnlyDiamond.selector);
        rewardBase.broadcastDayV2{value: fee}(
            _v2Shared(), dests, payable(owner)
        );
    }

    function test_Receive_BroadcastV2_RevertOnCanonical() public {
        RewardBroadcastV2 memory b;
        b.dayId = 1;
        b.destChainId = BASE;
        vm.prank(address(messengerBase));
        vm.expectRevert(VaipakamRewardMessenger.BroadcastOnCanonical.selector);
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            abi.encode(uint8(5), b),
            _empty()
        );
    }

    /// The 15-word pin: a truncated kind-5 payload is rejected before any
    /// decode (14 words is not in the size union at all).
    function test_Receive_BroadcastV2_WrongSize_Rejected() public {
        bytes memory truncated = new bytes(14 * 32);
        truncated[31] = bytes1(uint8(5));
        vm.prank(address(messengerMirror));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.PayloadSizeMismatch.selector,
                14 * 32,
                6 * 32
            )
        );
        rewardMirror.onCrossChainMessage(
            BASE, address(rewardBase), truncated, _empty()
        );
    }

    function test_QuoteBroadcastDayV2() public view {
        IRewardMessenger.BroadcastV2PerDest[] memory dests =
            new IRewardMessenger.BroadcastV2PerDest[](1);
        dests[0] = _v2Dest(MIRROR);
        assertEq(
            rewardBase.quoteBroadcastDayV2(_v2Shared(), dests),
            fee,
            "one lane, one fee"
        );
    }

    // ─── Sender access control ──────────────────────────────────────────────

    function test_SendChainReport_RevertWhen_NotDiamond() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(VaipakamRewardMessenger.OnlyDiamond.selector);
        rewardMirror.sendChainReport{value: fee}(1, 0, 0, 0, 0, payable(owner));
    }

    function test_BroadcastGlobal_RevertWhen_NotDiamond() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(VaipakamRewardMessenger.OnlyDiamond.selector);
        rewardBase.broadcastGlobal{value: fee}(1, 0, 0, type(uint256).max, 0, 0, 0, payable(owner));
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
            abi.encode(REPORT, uint256(1), uint256(0), uint256(0)),
            _empty()
        );
    }

    function test_Receive_RevertWhen_ReportOnMirror() public {
        // A REPORT-kind payload delivered to a mirror instance.
        vm.prank(address(messengerMirror));
        vm.expectRevert(VaipakamRewardMessenger.ReportOnMirror.selector);
        rewardMirror.onCrossChainMessage(
            BASE,
            address(rewardBase),
            abi.encode(REPORT, uint256(1), uint256(0), uint256(0)),
            _empty()
        );
    }

    function test_Receive_RevertWhen_BroadcastOnCanonical() public {
        vm.prank(address(messengerBase));
        vm.expectRevert(VaipakamRewardMessenger.BroadcastOnCanonical.selector);
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            // PR-3c (#1217) — broadcast payload is 8 words (+ capThreshold18
            // + composition halves + arming day).
            abi.encode(
                BROADCAST,
                uint256(1),
                uint256(0),
                uint256(0),
                uint256(0),
                uint256(0),
                uint256(0),
                uint256(0)
            ),
            _empty()
        );
    }

    function test_Receive_RevertWhen_PayloadSizeWrong() public {
        // A short (padded-attack-shaped) payload — the length pin rejects it.
        bytes memory short = abi.encode(REPORT);
        vm.prank(address(messengerBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.PayloadSizeMismatch.selector,
                short.length,
                uint256(192)
            )
        );
        rewardBase.onCrossChainMessage(
            MIRROR, address(rewardMirror), short, _empty()
        );
    }

    function test_Receive_RevertWhen_UnknownMessageType() public {
        vm.prank(address(messengerBase));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.UnknownMessageType.selector, uint8(9)
            )
        );
        rewardBase.onCrossChainMessage(
            MIRROR,
            address(rewardMirror),
            abi.encode(uint8(9), uint256(1), uint256(0), uint256(0)),
            _empty()
        );
    }

    // ─── Quotes ─────────────────────────────────────────────────────────────

    function test_Quotes() public view {
        assertEq(
            rewardMirror.quoteSendChainReport(1, 0, 0, 0, 0), fee, "report quote"
        );
        // Codex #1413 r2 — the legacy three-argument quote overload stays
        // callable for old-ABI callers during the rollout window.
        assertEq(
            rewardMirror.quoteSendChainReport(1, 0, 0), fee, "legacy report quote"
        );
        // One broadcast destination → one fee.
        assertEq(
            rewardBase.quoteBroadcastGlobal(1, 0, 0), fee, "broadcast quote"
        );
    }

    // ─── Pause ──────────────────────────────────────────────────────────────

    function test_Pause_FreezesReport() public {
        vm.prank(owner);
        rewardMirror.pause();
        vm.prank(address(diamondMirror));
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        rewardMirror.sendChainReport{value: fee}(
            1, 0, 0, 0, 0, payable(address(diamondMirror))
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
            abi.encode(REPORT, uint256(1), uint256(0), uint256(0)),
            _empty()
        );
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
            abi.encode(REPORT, uint256(1), uint256(0), uint256(0)),
            toks
        );
    }

    // ─── T-087 Sub 2.B — TierUpdated + VersionBumped surface ────────────────

    uint8 internal constant TIER_UPDATED = 3;
    uint8 internal constant VERSION_BUMPED = 4;

    function test_SendTierUpdate_HappyPath() public {
        address user = makeAddr("user");
        // `sendTierUpdate` is a Base → mirror push, so the Diamond-paired
        // instance is `rewardBase`.
        vm.prank(address(diamondBase));
        rewardBase.sendTierUpdate{value: fee}(
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
        rewardBase.sendTierUpdate{value: fee}(
            address(this), 1, 1000, 0, 1, 0, 1, payable(owner)
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
        );
    }

    function test_Receive_VersionBumped_RevertOnCanonical() public {
        bytes memory payload = abi.encode(VERSION_BUMPED, uint16(7));
        vm.prank(address(messengerBase));
        vm.expectRevert(VaipakamRewardMessenger.BroadcastOnCanonical.selector);
        rewardBase.onCrossChainMessage(
            MIRROR, address(rewardMirror), payload, _empty()
        );
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
        );
    }

    function test_Receive_RevertOnInvalidSize() public {
        // A 3-word payload — not in {2, 4, 6, 8}. The outer size gate
        // catches it before decode.
        bytes memory threeWords = abi.encode(REPORT, uint256(1), uint256(2));
        vm.prank(address(messengerMirror));
        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardMessenger.PayloadSizeMismatch.selector,
                threeWords.length,
                uint256(6 * 32)
            )
        );
        rewardMirror.onCrossChainMessage(
            BASE, address(rewardBase), threeWords, _empty()
        );
    }

    function test_QuoteSendTierUpdate_ReturnsNonZero() public view {
        uint256 quoted = rewardBase.quoteSendTierUpdate(
            address(0xbeef), 1, 1000, 0, 1, 0, 1
        );
        assertEq(quoted, fee, "quote covers the single configured destination");
    }

    function test_QuoteSendVersionBumped_ReturnsNonZero() public view {
        uint256 quoted = rewardBase.quoteSendVersionBumped(uint16(1));
        assertEq(quoted, fee, "quote covers the single configured destination");
    }
}
