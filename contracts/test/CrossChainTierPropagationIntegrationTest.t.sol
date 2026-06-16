// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ProtocolBroadcastFacet} from "../src/facets/ProtocolBroadcastFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {CcipMessenger} from "../src/crosschain/CcipMessenger.sol";
import {VaipakamRewardMessenger} from "../src/crosschain/VaipakamRewardMessenger.sol";
import {MockCcipRouter} from "./mocks/MockCcipRouter.sol";

/// @title CrossChainTierPropagationIntegrationTest
/// @notice T-087 Sub 2.E — end-to-end happy-path probe of the Sub 2.A–D
///         rollup → broadcast → messenger chain. Verifies the canonical
///         Base diamond actually emits a CCIP message when a user
///         deposits VPFI + their tier resolution produces a new push
///         tuple. Sub 2.B + 2.C unit tests already cover the message
///         shape + the mirror inbound; this test adds the missing link
///         that the rollup actually triggers a broadcast.
contract CrossChainTierPropagationIntegrationTest is SetupTest {
    VPFIToken internal vpfiToken;
    MockCcipRouter internal router;
    CcipMessenger internal messenger;
    VaipakamRewardMessenger internal rewardMsgr;
    address internal user;
    address internal mockMirrorMessenger;

    uint256 internal constant MIRROR_CHAIN = 11_155_111; // Sepolia
    uint64 internal constant SEL_BASE = 15971525489660198786;
    uint64 internal constant SEL_MIRROR = 5009297550715157269;
    bytes32 internal constant CHANNEL =
        keccak256("vaipakam.ccip.channel.vpfi-reward");

    function setUp() public {
        setupHelper();
        user = makeAddr("user");

        // ── VPFI token deploy + canonical-chain wiring ──────────
        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfiToken = VPFIToken(address(proxy));

        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiToken));
        VPFIDiscountFacet(address(diamond)).setVPFIBuyRate(1e15);

        // ── CCIP scaffolding ────────────────────────────────────
        router = new MockCcipRouter();
        router.setSupported(SEL_MIRROR, true);
        router.setSupported(SEL_BASE, true);

        // Single CcipMessenger on Base (the messenger acts as the
        // cross-chain port; this test exercises the SEND side only).
        CcipMessenger msgrImpl = new CcipMessenger(address(router));
        messenger = CcipMessenger(
            address(
                new ERC1967Proxy(
                    address(msgrImpl),
                    abi.encodeCall(CcipMessenger.initialize, (address(this)))
                )
            )
        );

        mockMirrorMessenger = makeAddr("mirrorMessenger");

        // ── Reward messenger on Base ────────────────────────────
        VaipakamRewardMessenger rmImpl = new VaipakamRewardMessenger();
        rewardMsgr = VaipakamRewardMessenger(
            payable(
                address(
                    new ERC1967Proxy(
                        address(rmImpl),
                        abi.encodeCall(
                            VaipakamRewardMessenger.initialize,
                            (address(this), address(messenger),
                             address(diamond), true /* canonical */,
                             0 /* baseChainId */, 400_000)
                        )
                    )
                )
            )
        );

        messenger.setChainSelector(MIRROR_CHAIN, SEL_MIRROR);
        messenger.setRemoteMessenger(MIRROR_CHAIN, mockMirrorMessenger);
        messenger.registerChannel(CHANNEL, address(rewardMsgr));
        messenger.setChannelPeer(CHANNEL, MIRROR_CHAIN, mockMirrorMessenger);

        uint256[] memory dests = new uint256[](1);
        dests[0] = MIRROR_CHAIN;
        rewardMsgr.setBroadcastDestinations(dests);

        // ── Diamond-side broadcast wiring ───────────────────────
        RewardReporterFacet(address(diamond)).setRewardMessenger(address(rewardMsgr));

        // Fund the protocol broadcast budget so the rollup can pay
        // the fan-out fee.
        vm.deal(address(this), 10 ether);
        ProtocolBroadcastFacet(payable(address(diamond)))
            .topUpBroadcastBudget{value: 1 ether}();
    }

    function test_DepositVPFI_TriggersBroadcastToMirror() public {
        // Stake enough VPFI to clear tier 1. The FIRST deposit
        // resolves to effective tier 0 (min-history gate not yet
        // elapsed) so the de-dup gate silent-skips the broadcast —
        // that's the round-2 P1 #3 dust-drain defense kicking in.
        uint256 amt = 500 ether;
        vpfiToken.transfer(user, amt);
        vm.startPrank(user);
        // Opt into the VPFI discount program. The broadcast path's
        // consent gate (ProtocolBroadcastFacet — Sub 4 round-3 P2 #2)
        // forces the resolved tuple to (0, 0) for any user who has NOT
        // consented, so their tier is never mirrored cross-chain. Without
        // this opt-in the accumulator still resolves the correct tier
        // (1, 1000) but the broadcast suppresses it as a consent-gated
        // zero — the integration test must model a consented staker to
        // exercise the rollup → broadcast → messenger chain at all.
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(true);
        IERC20(address(vpfiToken)).approve(address(diamond), amt);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(amt);
        vm.stopPrank();
        assertEq(router.pendingCount(), 0, "pre-gate deposit silent-skips");

        // Warp past the min-history gate (default 3 days, +1 sec for
        // boundary cleanliness).
        vm.warp(block.timestamp + 3 days + 1);

        // Trigger another rollup via a 1-wei top-up. NOW the user's
        // effective tier resolves to 1 — the de-dup gate sees the
        // tuple differ from the (0, 0, *, *) prior, and the broadcast
        // fires through the full chain (rollup → ProtocolBroadcastFacet
        // → VaipakamRewardMessenger → CcipMessenger → mock router).
        vpfiToken.transfer(user, 1);
        vm.startPrank(user);
        IERC20(address(vpfiToken)).approve(address(diamond), 1);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(1);
        vm.stopPrank();

        assertEq(
            router.pendingCount(),
            1,
            "post-gate rollup fans out exactly one CCIP message"
        );

        // The user's first-push counter on the diamond rose to 1.
        assertEq(
            ProtocolBroadcastFacet(payable(address(diamond)))
                .getUserTierPushNonce(user),
            1,
            "diamond-side push nonce should bump"
        );
    }

    function test_DepositVPFI_DustTier0_SilentSkip() public {
        // A dust deposit that doesn't clear tier 1 resolves to (0, 0)
        // effective. Sub 2.D round-2 P1 #3 silent-skips this. Mock
        // router should record ZERO outbound messages — closing the
        // drain vector where every dust deposit would otherwise burn
        // CCIP fees.
        uint256 dust = 1; // 1 wei of VPFI — far below tier 1
        vpfiToken.transfer(user, dust);
        vm.startPrank(user);
        IERC20(address(vpfiToken)).approve(address(diamond), dust);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(dust);
        vm.stopPrank();

        assertEq(
            router.pendingCount(),
            0,
            "first-zero-tier deposit must NOT fan out"
        );
    }
}
