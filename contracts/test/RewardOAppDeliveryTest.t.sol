// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {TestHelperOz5} from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OptionsBuilder} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import {Origin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {VaipakamRewardOApp} from "../src/token/VaipakamRewardOApp.sol";

/// @title RewardOAppDeliveryTest
/// @notice End-to-end cross-chain delivery test for the cross-chain
///         reward messaging layer. Builds a two-chain LayerZero mesh with
///         mock endpoints and wires a canonical OApp (Base-ish, eidA) to a
///         mirror OApp (L2-ish, eidB). Exercises both message directions:
///           - mirror → canonical REPORT (via `sendChainReport`)
///           - canonical → mirror BROADCAST (via `broadcastGlobal`)
///
///         On receipt, the target OApp's `_lzReceive` forwards into the
///         paired Diamond ingress. A tiny mock diamond (`MockDiamond`)
///         captures the forwarded calldata so we can assert the payload
///         was decoded correctly and delivered to the intended ingress.
/// @dev Purposefully an in-memory LZ mesh, NOT a forked mainnet — LZ test
///      devtools spin up a full EndpointV2 mock pair and a simulated DVN,
///      giving hermetic delivery semantics that match how production LZ
///      packets flow. Fork tests against a real endpoint are deferred to
///      a staging runbook step (they require live DVN keys and an
///      executor funding line — see DeploymentRunbook §5 smoke tests).
contract RewardOAppDeliveryTest is TestHelperOz5 {
    using OptionsBuilder for bytes;

    uint32 private constant CANONICAL_EID = 1;
    uint32 private constant MIRROR_EID = 2;

    VaipakamRewardOApp private canonical;
    VaipakamRewardOApp private mirror;
    MockDiamond private canonicalDiamond;
    MockDiamond private mirrorDiamond;

    function setUp() public override {
        super.setUp();
        setUpEndpoints(2, LibraryType.UltraLightNode);

        bytes memory reportOpts = OptionsBuilder.newOptions().addExecutorLzReceiveOption(300_000, 0);
        bytes memory broadcastOpts = OptionsBuilder.newOptions().addExecutorLzReceiveOption(300_000, 0);

        // ── Deploy diamond shims (one per chain) ────────────────────────
        canonicalDiamond = new MockDiamond();
        mirrorDiamond = new MockDiamond();

        // ── Canonical OApp on eidA (isCanonical=true, baseEid=0) ────────
        VaipakamRewardOApp canonicalImpl = new VaipakamRewardOApp(address(endpoints[CANONICAL_EID]));
        ERC1967Proxy canonicalProxy = new ERC1967Proxy(
            address(canonicalImpl),
            abi.encodeCall(
                VaipakamRewardOApp.initialize,
                (address(this), address(canonicalDiamond), true, 0, reportOpts, broadcastOpts)
            )
        );
        canonical = VaipakamRewardOApp(payable(address(canonicalProxy)));

        // ── Mirror OApp on eidB (isCanonical=false, baseEid=CANONICAL_EID)
        VaipakamRewardOApp mirrorImpl = new VaipakamRewardOApp(address(endpoints[MIRROR_EID]));
        ERC1967Proxy mirrorProxy = new ERC1967Proxy(
            address(mirrorImpl),
            abi.encodeCall(
                VaipakamRewardOApp.initialize,
                (address(this), address(mirrorDiamond), false, CANONICAL_EID, reportOpts, broadcastOpts)
            )
        );
        mirror = VaipakamRewardOApp(payable(address(mirrorProxy)));

        // ── Peer wiring both ways ───────────────────────────────────────
        address[] memory oapps = new address[](2);
        oapps[0] = address(canonical);
        oapps[1] = address(mirror);
        this.wireOApps(oapps);

        // Canonical must know which mirrors to broadcast to.
        uint32[] memory dests = new uint32[](1);
        dests[0] = MIRROR_EID;
        canonical.setBroadcastDestinationEids(dests);
    }

    // ─── Mirror → Canonical REPORT ──────────────────────────────────────

    function test_sendChainReport_deliversToCanonicalDiamond() public {
        uint256 dayId = 20260419;
        uint256 lenderUSD18 = 1_234e18;
        uint256 borrowerUSD18 = 5_678e18;

        uint256 fee = mirror.quoteSendChainReport(dayId, lenderUSD18, borrowerUSD18);
        assertGt(fee, 0, "REPORT fee should be non-zero");

        vm.deal(address(mirrorDiamond), fee);
        vm.prank(address(mirrorDiamond));
        mirror.sendChainReport{value: fee}(
            dayId,
            lenderUSD18,
            borrowerUSD18,
            payable(address(mirrorDiamond))
        );

        // Before delivery the canonical diamond has recorded nothing.
        assertEq(canonicalDiamond.reportCount(), 0, "pre-delivery: no report yet");

        // Deliver the pending packet to the canonical endpoint.
        verifyPackets(CANONICAL_EID, addressToBytes32(address(canonical)));

        // After delivery the canonical diamond's ingress was hit exactly once.
        assertEq(canonicalDiamond.reportCount(), 1, "post-delivery: one report");
        (uint32 srcEid, uint256 dId, uint256 a, uint256 b) = canonicalDiamond.lastReport();
        assertEq(srcEid, MIRROR_EID, "srcEid should match sender chain");
        assertEq(dId, dayId);
        assertEq(a, lenderUSD18);
        assertEq(b, borrowerUSD18);

        // Mirror was never touched on its own ingress.
        assertEq(mirrorDiamond.reportCount(), 0, "mirror diamond should be untouched");
    }

    // ─── Canonical → Mirror BROADCAST ───────────────────────────────────

    function test_broadcastGlobal_deliversToMirrorDiamond() public {
        uint256 dayId = 20260419;
        uint256 globalLenderUSD18 = 99_999e18;
        uint256 globalBorrowerUSD18 = 88_888e18;

        uint256 fee = canonical.quoteBroadcastGlobal(dayId, globalLenderUSD18, globalBorrowerUSD18);
        assertGt(fee, 0, "BROADCAST fee should be non-zero");

        vm.deal(address(canonicalDiamond), fee);
        vm.prank(address(canonicalDiamond));
        canonical.broadcastGlobal{value: fee}(
            dayId,
            globalLenderUSD18,
            globalBorrowerUSD18,
            payable(address(canonicalDiamond))
        );

        assertEq(mirrorDiamond.broadcastCount(), 0, "pre-delivery: no broadcast yet");

        verifyPackets(MIRROR_EID, addressToBytes32(address(mirror)));

        assertEq(mirrorDiamond.broadcastCount(), 1, "post-delivery: one broadcast");
        (uint256 dId, uint256 gl, uint256 gb) = mirrorDiamond.lastBroadcast();
        assertEq(dId, dayId);
        assertEq(gl, globalLenderUSD18);
        assertEq(gb, globalBorrowerUSD18);

        // Canonical never receives its own broadcast.
        assertEq(canonicalDiamond.broadcastCount(), 0, "canonical diamond should be untouched");
    }

    // ─── Negative: canonical cannot send a REPORT (would-be loop) ───────

    function test_sendChainReport_fromCanonical_reverts() public {
        // Canonical OApp has baseEid == 0 by design — the quote should fail
        // with BaseEidNotConfigured, preventing a canonical-to-canonical loop.
        vm.expectRevert();
        canonical.quoteSendChainReport(1, 2, 3);
    }

    // ─── Negative: mirror cannot broadcast (no destinations) ────────────

    function test_broadcastGlobal_fromMirror_quotesZero() public view {
        // Mirror has no broadcast destinations configured — quote is 0 and
        // `broadcastGlobal` would no-op. Regression guard against
        // accidentally enabling mirror→mirror fan-out.
        uint256 fee = mirror.quoteBroadcastGlobal(1, 2, 3);
        assertEq(fee, 0, "mirror should quote zero for broadcastGlobal");
    }

    // ─── Negative: oversized / undersized payload rejected ─────────────
    //
    // The canonical REPORT and BROADCAST shapes both encode to 4 × 32 = 128
    // bytes (`abi.encode(uint8, uint256, uint256, uint256)`). The strict
    // size pin in `_lzReceive` rejects anything else. These tests forge a
    // packet directly against the OApp's `lzReceive` from the endpoint
    // (skipping the legitimate send + DVN verify path) — what an attacker
    // would land if they ever bypassed peer + DVN auth.

    function test_lzReceive_oversizedPayload_reverts() public {
        // 5-field encode = 160 bytes. abi.decode would silently ignore the
        // trailing word; the size pin rejects it outright.
        bytes memory bad = abi.encode(
            uint8(1),
            uint256(20260419),
            uint256(1e18),
            uint256(2e18),
            uint256(0xdeadbeef)
        );
        assertEq(bad.length, 160, "5-field abi.encode is 160 bytes");

        Origin memory origin = Origin({
            srcEid: MIRROR_EID,
            sender: addressToBytes32(address(mirror)),
            nonce: 1
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardOApp.PayloadSizeMismatch.selector,
                uint256(160),
                uint256(128)
            )
        );
        vm.prank(address(endpoints[CANONICAL_EID]));
        canonical.lzReceive(origin, bytes32(0), bad, address(0), "");
    }

    function test_lzReceive_undersizedPayload_reverts() public {
        // 3-field encode = 96 bytes. Without the size pin, abi.decode of
        // a (uint8, uint256, uint256, uint256) tuple from a too-short
        // calldata would revert deep in the decoder; the explicit error
        // here gives off-chain monitoring something correlatable.
        bytes memory bad = abi.encode(
            uint8(1),
            uint256(20260419),
            uint256(1e18)
        );
        assertEq(bad.length, 96, "3-field abi.encode is 96 bytes");

        Origin memory origin = Origin({
            srcEid: MIRROR_EID,
            sender: addressToBytes32(address(mirror)),
            nonce: 1
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                VaipakamRewardOApp.PayloadSizeMismatch.selector,
                uint256(96),
                uint256(128)
            )
        );
        vm.prank(address(endpoints[CANONICAL_EID]));
        canonical.lzReceive(origin, bytes32(0), bad, address(0), "");
    }
}

/// @notice Minimal ingress recorder used in place of the full Vaipakam
///         Diamond. Implements just the two receiver-side hooks the
///         RewardOApp calls after decoding an inbound packet.
contract MockDiamond {
    struct Report {
        uint32 srcEid;
        uint256 dayId;
        uint256 lenderUSD18;
        uint256 borrowerUSD18;
    }
    struct Broadcast {
        uint256 dayId;
        uint256 globalLenderUSD18;
        uint256 globalBorrowerUSD18;
    }

    uint256 public reportCount;
    uint256 public broadcastCount;
    Report internal _lastReport;
    Broadcast internal _lastBroadcast;

    function onChainReportReceived(
        uint32 sourceEid,
        uint256 dayId,
        uint256 lenderUSD18,
        uint256 borrowerUSD18
    ) external {
        _lastReport = Report(sourceEid, dayId, lenderUSD18, borrowerUSD18);
        reportCount += 1;
    }

    function onRewardBroadcastReceived(
        uint256 dayId,
        uint256 globalLenderUSD18,
        uint256 globalBorrowerUSD18
    ) external {
        _lastBroadcast = Broadcast(dayId, globalLenderUSD18, globalBorrowerUSD18);
        broadcastCount += 1;
    }

    function lastReport() external view returns (uint32, uint256, uint256, uint256) {
        Report memory r = _lastReport;
        return (r.srcEid, r.dayId, r.lenderUSD18, r.borrowerUSD18);
    }

    function lastBroadcast() external view returns (uint256, uint256, uint256) {
        Broadcast memory b = _lastBroadcast;
        return (b.dayId, b.globalLenderUSD18, b.globalBorrowerUSD18);
    }

    // Accept ETH refunds from LZ if any.
    receive() external payable {}
}
