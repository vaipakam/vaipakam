// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// CCIP token-pool types — imported from the same vendored-OZ paths the
// pools themselves use, exactly as `DeployCrosschain.s.sol` does.
import {IERC20} from "@openzeppelin/contracts@4.8.3/token/ERC20/IERC20.sol";
import {IBurnMintERC20} from "@chainlink/contracts/src/v0.8/shared/token/ERC20/IBurnMintERC20.sol";
import {LockReleaseTokenPool} from "@chainlink/contracts-ccip/contracts/pools/LockReleaseTokenPool.sol";
import {BurnMintTokenPool} from "@chainlink/contracts-ccip/contracts/pools/BurnMintTokenPool.sol";
import {TokenPool} from "@chainlink/contracts-ccip/contracts/pools/TokenPool.sol";
import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";

import {CcipMessenger} from "../src/crosschain/CcipMessenger.sol";
import {VPFIMirrorToken} from "../src/crosschain/VPFIMirrorToken.sol";
import {VpfiPoolRateGovernor} from "../src/crosschain/VpfiPoolRateGovernor.sol";
import {VaipakamRewardMessenger} from "../src/crosschain/VaipakamRewardMessenger.sol";

import {MockCcipRouter} from "./mocks/MockCcipRouter.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @dev One mock Vaipakam Diamond serving the canonical chain's cross-chain
 *      ingress points — the reward messenger's report / broadcast callbacks.
 *      (#687-A removed the buy receiver's `processBridgedBuy` flow.)
 */
contract MockRehearsalDiamond {
    ERC20Mock public immutable vpfi;

    uint256 public reportCount;
    uint32 public lastReportChain;
    uint256 public lastReportDay;

    uint256 public bcastCount;
    uint256 public lastBcastDay;

    constructor(ERC20Mock vpfi_) {
        vpfi = vpfi_;
    }

    function onChainReportReceived(uint32 src, uint256 day, uint256, uint256)
        external
    {
        lastReportChain = src;
        lastReportDay = day;
        ++reportCount;
    }

    function onRewardBroadcastReceived(uint256 day, uint256, uint256, uint256) external {
        lastBcastDay = day;
        ++bcastCount;
    }

    receive() external payable {}
}

/**
 * @title CcipDeploymentRehearsalTest
 * @notice T-068 Phase 6.3 — the CCIP deploy + config *rehearsal*. The
 *         individual cross-chain contracts already have dedicated unit
 *         tests ({CcipMessengerTest}, {VaipakamRewardFlowTest}); what
 *         was un-covered is the
 *         *assembly* — that the contract set `DeployCrosschain.s.sol`
 *         deploys, wired by the exact call sequence `ConfigureCcip.s.sol`
 *         emits, holds together as one coherent two-chain system and that
 *         every flow runs on it.
 *
 * @dev    This harness stands up the FULL stack for two logical chains —
 *         a canonical "Base" and one mirror — over a single
 *         {MockCcipRouter}, applying the same constructor / initializer
 *         arguments and the same wiring-call order the two scripts use
 *         (including the `Ownable2Step` pool-ownership handover
 *         `DeployCrosschain` opens and `ConfigureCcip` accepts). It then
 *         exercises the three cross-chain flows end-to-end on that single
 *         shared deployment.
 *
 *         Faithful-to-the-scripts, with two deliberate stand-ins the
 *         scripts' env / filesystem / live-CCIP dependencies force:
 *           - `MockCcipRouter` stands in for the CCIP Router; it moves a
 *             token-bearing message as a plain ERC20 transfer rather than
 *             a pool burn/mint, so a token-bearing flow uses one shared
 *             vpfi ERC20 across both legs. The Cross-Chain
 *             *Token* mint/burn path is rehearsed separately, on the real
 *             {VPFIMirrorToken} + {BurnMintTokenPool}, by
 *             {test_Rehearsal_CctMintBurnAuthority}.
 *           - The CCIP `TokenAdminRegistry` CCT registration step is a
 *             live-CCIP action; it is out of this local rehearsal's scope
 *             (the registry contracts are Chainlink's, exercised on a real
 *             chain). Everything else `ConfigureCcip` does is applied.
 */
contract CcipDeploymentRehearsalTest is Test {
    // ── Two logical chains (the harness runs on the foundry chain id;
    //    routing keys off the configured CCIP selectors). ──
    uint256 internal constant BASE = 8453; // canonical
    uint256 internal constant MIRROR = 1; // a mirror chain
    uint64 internal constant SEL_BASE = 15971525489660198786;
    uint64 internal constant SEL_MIRROR = 5009297550715157269;

    bytes32 internal constant REWARD_CHANNEL =
        keccak256("vaipakam.ccip.channel.vpfi-reward");

    uint256 internal constant GAS = 400_000;
    uint64 internal constant TIMEOUT = 15 minutes;

    // Design §10 starting rate-limit values.
    uint128 internal constant RL_CAPACITY = 50_000 ether;
    uint128 internal constant RL_REFILL = 5.8 ether;

    // `admin` is the single ADMIN_ADDRESS the scripts thread through every
    // proxy initializer and accept as the pools' owner.
    address internal admin = makeAddr("admin");
    address internal rmnProxy = makeAddr("rmnProxy");
    address internal user = makeAddr("user");

    MockCcipRouter internal router;
    ERC20Mock internal vpfi; // canonical vpfi (LockRelease pool)

    // ── Canonical (Base) stack ──
    CcipMessenger internal messengerBase;
    LockReleaseTokenPool internal lockPool;
    VpfiPoolRateGovernor internal govBase;
    VaipakamRewardMessenger internal rewardBase;
    MockRehearsalDiamond internal diamondBase;

    // ── Mirror stack ──
    CcipMessenger internal messengerMirror;
    VPFIMirrorToken internal mirrorToken;
    BurnMintTokenPool internal burnPool;
    VpfiPoolRateGovernor internal govMirror;
    VaipakamRewardMessenger internal rewardMirror;
    MockRehearsalDiamond internal diamondMirror;

    uint256 internal fee;

    function setUp() public {
        router = new MockCcipRouter();
        router.setSupported(SEL_BASE, true);
        router.setSupported(SEL_MIRROR, true);
        fee = router.fixedFee();

        vpfi = new ERC20Mock("Vaipakam DeFi Token", "VPFI", 18);
        diamondBase = new MockRehearsalDiamond(vpfi);
        diamondMirror = new MockRehearsalDiamond(vpfi);

        _deployCanonical(); // mirrors DeployCrosschain.s.sol on Base
        _deployMirror(); //    mirrors DeployCrosschain.s.sol on a mirror
        _configure(); //       mirrors ConfigureCcip.s.sol on both chains

        // Operational funding the runbook prescribes post-deploy.
        vm.deal(address(diamondBase), 10 ether);
        vm.deal(address(diamondMirror), 10 ether);
    }

    // ── DeployCrosschain.s.sol — canonical (Base) ───────────────────────────

    function _deployCanonical() internal {
        messengerBase = _deployMessenger();

        // Base: a Lock/Release pool over the existing canonical vpfi.
        lockPool = new LockReleaseTokenPool(
            IERC20(address(vpfi)), 18, new address[](0), rmnProxy, address(router)
        );
        // DeployCrosschain hands the freshly-deployed pool to `admin`
        // (Ownable2Step pending); ConfigureCcip accepts it in `_configure`.
        lockPool.transferOwnership(admin);

        govBase = _deployGovernor(address(lockPool));
        rewardBase = _deployReward(messengerBase, diamondBase, true, 0);
    }

    // ── DeployCrosschain.s.sol — mirror ─────────────────────────────────────

    function _deployMirror() internal {
        messengerMirror = _deployMessenger();

        VPFIMirrorToken mirrorImpl = new VPFIMirrorToken();
        mirrorToken = VPFIMirrorToken(
            address(
                new ERC1967Proxy(
                    address(mirrorImpl),
                    abi.encodeCall(VPFIMirrorToken.initialize, (admin))
                )
            )
        );
        burnPool = new BurnMintTokenPool(
            IBurnMintERC20(address(mirrorToken)),
            18,
            new address[](0),
            rmnProxy,
            address(router)
        );
        burnPool.transferOwnership(admin);

        govMirror = _deployGovernor(address(burnPool));
        rewardMirror = _deployReward(messengerMirror, diamondMirror, false, BASE);
    }

    // ── ConfigureCcip.s.sol — both chains ───────────────────────────────────

    function _configure() internal {
        vm.startPrank(admin);

        // Accept the Ownable2Step pool-ownership handover.
        lockPool.acceptOwnership();
        burnPool.acceptOwnership();

        // CcipMessenger lanes + channels — canonical Base ⇄ mirror.
        messengerBase.setChainSelector(MIRROR, SEL_MIRROR);
        messengerBase.setRemoteMessenger(MIRROR, address(messengerMirror));
        messengerBase.registerChannel(REWARD_CHANNEL, address(rewardBase));
        messengerBase.setChannelPeer(REWARD_CHANNEL, MIRROR, address(rewardMirror));

        messengerMirror.setChainSelector(BASE, SEL_BASE);
        messengerMirror.setRemoteMessenger(BASE, address(messengerBase));
        messengerMirror.registerChannel(REWARD_CHANNEL, address(rewardMirror));
        messengerMirror.setChannelPeer(REWARD_CHANNEL, BASE, address(rewardBase));

        // Mirror vpfi → its Burn/Mint pool (the sole mint/burn authority).
        mirrorToken.setTokenPool(address(burnPool));

        // TokenPool lanes + bounds-checked rate limits, via the governor.
        _wirePoolLane(lockPool, govBase, SEL_MIRROR, address(burnPool), address(mirrorToken));
        _wirePoolLane(burnPool, govMirror, SEL_BASE, address(lockPool), address(vpfi));

        // Base fans the daily reward broadcast out to the mirror.
        uint256[] memory dests = new uint256[](1);
        dests[0] = MIRROR;
        rewardBase.setBroadcastDestinations(dests);

        vm.stopPrank();
    }

    /// @dev One pool lane: register the governor as `rateLimitAdmin`, add
    ///      the remote chain, then set the lane's rate limits through the
    ///      bounds-checked governor — the exact `ConfigureCcip` sequence.
    function _wirePoolLane(
        TokenPool pool,
        VpfiPoolRateGovernor governor,
        uint64 remoteSelector,
        address remotePool,
        address remoteToken
    ) internal {
        pool.setRateLimitAdmin(address(governor));

        RateLimiter.Config memory off =
            RateLimiter.Config({isEnabled: false, capacity: 0, rate: 0});
        TokenPool.ChainUpdate[] memory adds = new TokenPool.ChainUpdate[](1);
        bytes[] memory remotePools = new bytes[](1);
        remotePools[0] = abi.encode(remotePool);
        adds[0] = TokenPool.ChainUpdate({
            remoteChainSelector: remoteSelector,
            remotePoolAddresses: remotePools,
            remoteTokenAddress: abi.encode(remoteToken),
            outboundRateLimiterConfig: off,
            inboundRateLimiterConfig: off
        });
        pool.applyChainUpdates(new uint64[](0), adds);

        RateLimiter.Config memory on = RateLimiter.Config({
            isEnabled: true,
            capacity: RL_CAPACITY,
            rate: RL_REFILL
        });
        governor.setLaneRateLimits(remoteSelector, on, on);
    }

    // ── Deploy helpers ──────────────────────────────────────────────────────

    function _deployMessenger() internal returns (CcipMessenger) {
        CcipMessenger impl = new CcipMessenger(address(router));
        return CcipMessenger(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(CcipMessenger.initialize, (admin))
                )
            )
        );
    }

    function _deployGovernor(address pool)
        internal
        returns (VpfiPoolRateGovernor)
    {
        VpfiPoolRateGovernor impl = new VpfiPoolRateGovernor();
        return VpfiPoolRateGovernor(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(VpfiPoolRateGovernor.initialize, (admin, pool))
                )
            )
        );
    }

    function _deployReward(
        CcipMessenger m,
        MockRehearsalDiamond d,
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
                        (admin, address(m), address(d), canonical, baseChainId, GAS)
                    )
                )
            )
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Rehearsal 1 — the full stack is internally consistent
    // ════════════════════════════════════════════════════════════════════════

    /// @notice Every cross-reference `ConfigureCcip.s.sol` writes resolves,
    ///         both ways — proof the deploy + config topology holds.
    function test_Rehearsal_FullStackWired() public view {
        // Ownership handover completed — both pools owned by `admin`.
        assertEq(lockPool.owner(), admin, "lock pool admin-owned");
        assertEq(burnPool.owner(), admin, "burn pool admin-owned");

        // Chain-selector maps, both directions.
        assertEq(messengerBase.chainSelectorOf(MIRROR), SEL_MIRROR, "Base->mirror selector");
        assertEq(messengerMirror.chainSelectorOf(BASE), SEL_BASE, "mirror->Base selector");

        // Remote-messenger allowlist.
        assertEq(messengerBase.remoteMessengerOf(MIRROR), address(messengerMirror), "Base remote messenger");
        assertEq(messengerMirror.remoteMessengerOf(BASE), address(messengerBase), "mirror remote messenger");

        // Channel handlers (local) + peers (remote) for the reward channel.
        assertEq(messengerBase.handlerOf(REWARD_CHANNEL), address(rewardBase), "Base reward handler");
        assertEq(messengerMirror.handlerOf(REWARD_CHANNEL), address(rewardMirror), "mirror reward handler");
        assertEq(messengerBase.channelPeerOf(REWARD_CHANNEL, MIRROR), address(rewardMirror), "Base reward peer");
        assertEq(messengerMirror.channelPeerOf(REWARD_CHANNEL, BASE), address(rewardBase), "mirror reward peer");

        // TokenPool lanes + the governor as the bounds-checked rateLimitAdmin.
        assertTrue(lockPool.isSupportedChain(SEL_MIRROR), "lock pool lane to mirror");
        assertTrue(burnPool.isSupportedChain(SEL_BASE), "burn pool lane to Base");
        assertEq(lockPool.getRateLimitAdmin(), address(govBase), "lock pool rate admin = governor");
        assertEq(burnPool.getRateLimitAdmin(), address(govMirror), "burn pool rate admin = governor");

        // Mirror vpfi points at its Burn/Mint pool; reward fan-out set.
        assertEq(mirrorToken.tokenPool(), address(burnPool), "mirror token pool");
        assertEq(rewardBase.getBroadcastDestinations().length, 1, "one broadcast destination");
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Rehearsal 2 — the reward REPORT / BROADCAST round-trip
    // ════════════════════════════════════════════════════════════════════════

    /// @notice A mirror chain reports a closed day to Base; Base broadcasts
    ///         the global totals back to the mirror.
    function test_Rehearsal_RewardRoundTrip() public {
        // REPORT — mirror → Base.
        vm.prank(address(diamondMirror));
        rewardMirror.sendChainReport{value: fee}(
            42, 1_000 ether, 500 ether, payable(address(diamondMirror))
        );
        router.deliver(0, SEL_MIRROR);
        assertEq(diamondBase.reportCount(), 1, "Base aggregator got the report");
        assertEq(diamondBase.lastReportChain(), SafeCast.toUint32(MIRROR), "report source chain");
        assertEq(diamondBase.lastReportDay(), 42, "report day");

        // BROADCAST — Base → mirror.
        vm.prank(address(diamondBase));
        rewardBase.broadcastGlobal{value: fee}(
            42, 9_000 ether, 4_000 ether, type(uint256).max, payable(address(diamondBase))
        );
        router.deliver(1, SEL_BASE);
        assertEq(diamondMirror.bcastCount(), 1, "mirror got the broadcast");
        assertEq(diamondMirror.lastBcastDay(), 42, "broadcast day");
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Rehearsal 3 — the vpfi Cross-Chain Token mint/burn authority
    // ════════════════════════════════════════════════════════════════════════

    /// @notice The CCT wiring leaves the mirror vpfi mintable / burnable by
    ///         its Burn/Mint pool and by nothing else — the property a
    ///         router-driven `releaseOrMint` / `lockOrBurn` relies on.
    function test_Rehearsal_CctMintBurnAuthority() public {
        // Only the pool may mint.
        vm.prank(address(burnPool));
        mirrorToken.mint(user, 100 ether);
        assertEq(mirrorToken.balanceOf(user), 100 ether, "pool minted mirror vpfi");

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(VPFIMirrorToken.NotTokenPool.selector, user)
        );
        mirrorToken.mint(user, 1 ether);

        // Only the pool may burn (it holds the tokens by burn time).
        vm.prank(user);
        mirrorToken.transfer(address(burnPool), 40 ether);
        vm.prank(address(burnPool));
        mirrorToken.burn(40 ether);
        assertEq(mirrorToken.totalSupply(), 60 ether, "pool burned mirror vpfi");

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(VPFIMirrorToken.NotTokenPool.selector, user)
        );
        mirrorToken.burn(1 ether);
    }
}
