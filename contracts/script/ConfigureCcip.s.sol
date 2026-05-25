// script/ConfigureCcip.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";
import {TokenPool} from "@chainlink/contracts-ccip/contracts/pools/TokenPool.sol";
import {TokenAdminRegistry} from
    "@chainlink/contracts-ccip/contracts/tokenAdminRegistry/TokenAdminRegistry.sol";
import {RegistryModuleOwnerCustom} from
    "@chainlink/contracts-ccip/contracts/tokenAdminRegistry/RegistryModuleOwnerCustom.sol";
import {IOwner} from "@chainlink/contracts-ccip/contracts/interfaces/IOwner.sol";

import {CcipMessenger} from "../src/crosschain/CcipMessenger.sol";
import {VPFIMirrorToken} from "../src/crosschain/VPFIMirrorToken.sol";
import {VpfiPoolRateGovernor} from "../src/crosschain/VpfiPoolRateGovernor.sol";
import {VaipakamRewardMessenger} from "../src/crosschain/VaipakamRewardMessenger.sol";
import {GuardianPausable} from "../src/crosschain/GuardianPausable.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title ConfigureCcip
 * @notice T-068 Phase 6 — wires the Chainlink CCIP cross-chain stack on
 *         ONE chain after `DeployCrosschain.s.sol` has run on it (and on
 *         every chain it talks to). Run once per chain, in a second pass
 *         AFTER every chain in the deployment has been deployed — the
 *         lane / channel-peer wiring reads each remote chain's
 *         `deployments/<slug>/addresses.json`.
 *
 * @dev    Idempotent: every step is a "set" or is guarded by an on-chain
 *         read, so a re-run after a partial failure is safe.
 *
 *         Canonical (Base) vs mirror is decided by `block.chainid`, the
 *         same rule `DeployCrosschain.s.sol` uses: 8453 / 84532 are
 *         canonical; every other chain is a mirror.
 *
 *         What it wires, EVERY chain:
 *           - `CcipMessenger` — chainId↔CCIP-selector, the remote
 *             messenger allowlist, the `vpfi-buy` + `vpfi-reward`
 *             channels (local handler + remote peers), the guardian.
 *           - The VPFI CCIP `TokenPool` — accepts the pending ownership
 *             handover from the deployer, registers the governor as
 *             `rateLimitAdmin`, adds a lane per remote chain
 *             (`applyChainUpdates`), then sets each lane's rate limits
 *             through `VpfiPoolRateGovernor` (the bounds-checked path).
 *           - Registers the VPFI token + its pool in the CCIP
 *             `TokenAdminRegistry` (CCT enablement).
 *         Canonical only:
 *           - `VaipakamRewardMessenger.setBroadcastDestinations` — the
 *             mirror chain-id list the daily reward broadcast fans out to.
 *         Mirror only:
 *           - `VPFIMirrorToken.setTokenPool` — points the mirror VPFI at
 *             its Burn/Mint pool (the only contract allowed to mint/burn).
 *
 *         Channel topology is hub-and-spoke: the `vpfi-buy` and
 *         `vpfi-reward` channels always pair a mirror with canonical Base,
 *         never mirror↔mirror. The TokenPool *lane* topology, by contrast,
 *         is whatever `CCIP_LANE_CHAIN_IDS` lists — pass Base-only on each
 *         mirror for a hub-spoke token graph, or the full chain set for a
 *         full mesh (direct mirror↔mirror VPFI transfers).
 *
 *         Required env:
 *           - ADMIN_PRIVATE_KEY              : the admin EOA — owner of
 *             every deployed proxy, and (after the handover this script
 *             accepts) of the TokenPool. On a testnet rehearsal this is
 *             the same key as the deployer; on mainnet the equivalent
 *             calls are a multisig batch — see the cutover runbook.
 *           - CCIP_TOKEN_ADMIN_REGISTRY      : this chain's CCIP
 *             `TokenAdminRegistry`.
 *           - CCIP_REGISTRY_MODULE_OWNER_CUSTOM : this chain's CCIP
 *             `RegistryModuleOwnerCustom` (the owner-based CCT registrar).
 *           - CCIP_LANE_CHAIN_IDS            : comma-separated EVM chain
 *             ids of every REMOTE chain to wire a TokenPool lane to.
 *         Mirror chains also need:
 *           - BASE_CHAIN_ID                  : EVM chain id of canonical
 *             Base — the hub the buy / reward channels peer with.
 *         Optional:
 *           - CCIP_GUARDIAN     : guardian address set on every
 *             `GuardianPausable` contract (default: unset → skipped).
 *           - CCIP_RATE_CAPACITY: per-lane token-bucket capacity
 *             (default 50,000 VPFI — design §10).
 *           - CCIP_RATE_REFILL  : per-lane refill rate, VPFI/s
 *             (default 5.8 VPFI/s — design §10).
 *
 *         Every deployed-contract address is read from the per-chain
 *         artifacts `DeployCrosschain.s.sol` wrote.
 *
 *         Usage:
 *           CCIP_LANE_CHAIN_IDS=11155111,421614 \
 *           forge script script/ConfigureCcip.s.sol \
 *             --rpc-url $RPC_URL --broadcast -vvv
 */
contract ConfigureCcip is Script {
    /// @dev The `ICrossChainMessenger` channel ids. These MUST match the
    ///      canonical constants in `IVpfiBuyCcipMessages` (`vpfi-buy`) and
    ///      `VaipakamRewardMessenger` (`vpfi-reward`) — the channel id is
    ///      a `keccak256` of a fixed string in both, and the wiring here
    ///      pins the same value.
    bytes32 internal constant VPFI_BUY_CHANNEL =
        keccak256("vaipakam.ccip.channel.vpfi-buy");
    bytes32 internal constant VPFI_REWARD_CHANNEL =
        keccak256("vaipakam.ccip.channel.vpfi-reward");

    /// @dev Everything `run()` resolves once, threaded through the wiring
    ///      steps — keeps each step a small, readable unit.
    struct Ctx {
        address admin;
        bool canonical;
        uint256 baseChainId;
        address messenger;
        address pool;
        address rateGovernor;
        address rewardMessenger;
        address localToken;
        address localBuyContract;
        address registry;
        address moduleOwner;
        address guardian;
        uint128 rateCapacity;
        uint128 rateRefill;
        uint256[] laneChainIds;
    }

    function run() external {
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");

        Ctx memory c;
        c.admin = vm.addr(adminKey);
        c.canonical = block.chainid == 8453 || block.chainid == 84532;
        c.baseChainId = c.canonical ? block.chainid : vm.envUint("BASE_CHAIN_ID");
        c.registry = vm.envAddress("CCIP_TOKEN_ADMIN_REGISTRY");
        c.moduleOwner = vm.envAddress("CCIP_REGISTRY_MODULE_OWNER_CUSTOM");
        c.laneChainIds = vm.envUint("CCIP_LANE_CHAIN_IDS", ",");
        c.guardian = vm.envOr("CCIP_GUARDIAN", address(0));
        c.rateCapacity =
            uint128(vm.envOr("CCIP_RATE_CAPACITY", uint256(50_000 ether)));
        c.rateRefill =
            uint128(vm.envOr("CCIP_RATE_REFILL", uint256(5.8 ether)));

        // Local deployed addresses — written by `DeployCrosschain.s.sol`.
        c.messenger =
            Deployments.readAddress(".ccipMessenger", "CCIP_MESSENGER_ADDRESS");
        c.pool =
            Deployments.readAddress(".vpfiTokenPool", "VPFI_TOKEN_POOL_ADDRESS");
        c.rateGovernor = Deployments.readAddress(
            ".vpfiPoolRateGovernor", "VPFI_POOL_RATE_GOVERNOR_ADDRESS"
        );
        // Typed reader: tries `.rewardMessenger` first, falls back to
        // the LayerZero-era `.rewardOApp` for pre-PR-#272 artifacts.
        // Without the typed reader (the prior generic
        // `readAddress(".rewardMessenger", env)` call) ConfigureCcip
        // would hard-fail every wiring against a legacy artifact even
        // though the address is unchanged.
        c.rewardMessenger = Deployments.readRewardMessenger();
        if (c.canonical) {
            c.localToken = Deployments.readVpfiToken();
            c.localBuyContract = Deployments.readVpfiBuyReceiver();
        } else {
            c.localToken =
                Deployments.readAddress(".vpfiMirror", "VPFI_MIRROR_ADDRESS");
            c.localBuyContract = Deployments.readVpfiBuyAdapter();
        }

        require(c.laneChainIds.length > 0, "ConfigureCcip: no lanes given");

        // On a mirror the buy + reward channels peer with canonical Base,
        // so the messenger MUST get Base's chain-selector + remote-messenger
        // wired — and that only happens for chain ids listed in
        // CCIP_LANE_CHAIN_IDS. A lane list that omits Base still passes
        // `ccip-wire` and `verify`, but then every outbound buy / reward
        // send reverts `UnconfiguredChain(baseChainId)`. Fail loud here.
        if (!c.canonical) {
            bool baseInLanes;
            for (uint256 i; i < c.laneChainIds.length; ++i) {
                if (c.laneChainIds[i] == c.baseChainId) {
                    baseInLanes = true;
                    break;
                }
            }
            require(
                baseInLanes,
                "ConfigureCcip: CCIP_LANE_CHAIN_IDS must include BASE_CHAIN_ID on a mirror chain"
            );
        }

        console.log("=== T-068 Phase 6 - CCIP wiring ===");
        console.log("Chain id:        ", block.chainid);
        console.log("Canonical:       ", c.canonical);
        console.log("Admin:           ", c.admin);
        console.log("CcipMessenger:   ", c.messenger);
        console.log("VPFI TokenPool:  ", c.pool);
        console.log("Rate governor:   ", c.rateGovernor);
        console.log("Reward messenger:", c.rewardMessenger);
        console.log("Local VPFI token:", c.localToken);
        console.log("Lanes to wire:   ", c.laneChainIds.length);

        vm.startBroadcast(adminKey);

        _acceptPoolOwnership(c);
        _wireMessengerLanes(c);
        _registerChannels(c);
        _wireChannelPeers(c);
        _setGuardians(c);
        _pointMirrorTokenAtPool(c);
        _wirePoolLanes(c);
        _registerCct(c);
        _setBroadcastDestinations(c);

        vm.stopBroadcast();

        console.log("");
        console.log("CCIP wiring complete for this chain.");
        console.log("Re-run on every other chain in CCIP_LANE_CHAIN_IDS.");
    }

    // ── Steps ────────────────────────────────────────────────────────────

    /// @dev Complete the `Ownable2Step` handover `DeployCrosschain.s.sol`
    ///      opened: the pool was deployed by the EOA and `transferOwnership`'d
    ///      to `admin`; `admin` now accepts it. Skipped if already owned.
    function _acceptPoolOwnership(Ctx memory c) internal {
        if (TokenPool(c.pool).owner() == c.admin) {
            console.log("Pool ownership: already admin-owned, skip.");
            return;
        }
        TokenPool(c.pool).acceptOwnership();
        console.log("Pool ownership: accepted by admin.");
    }

    /// @dev Map every remote chain id → its CCIP selector and register
    ///      that chain's `CcipMessenger` as the allowlisted peer. Done for
    ///      every lane uniformly — an unused selector/messenger entry is
    ///      harmless; the channel-peer wiring below decides who actually
    ///      talks to whom.
    function _wireMessengerLanes(Ctx memory c) internal {
        CcipMessenger m = CcipMessenger(c.messenger);
        for (uint256 i; i < c.laneChainIds.length; ++i) {
            uint256 cid = c.laneChainIds[i];
            uint64 selector = Deployments.ccipSelectorForChainId(cid);
            address remoteMessenger =
                Deployments.readAddressForChain(cid, ".ccipMessenger");
            m.setChainSelector(cid, selector);
            m.setRemoteMessenger(cid, remoteMessenger);
            console.log("  messenger lane wired -> chain", cid);
        }
    }

    /// @dev Register the local handler for each channel: the buy contract
    ///      on the `vpfi-buy` channel, the reward messenger on
    ///      `vpfi-reward`. Both ends of a channel must be configured for
    ///      the messenger to accept its traffic.
    function _registerChannels(Ctx memory c) internal {
        CcipMessenger m = CcipMessenger(c.messenger);
        m.registerChannel(VPFI_BUY_CHANNEL, c.localBuyContract);
        m.registerChannel(VPFI_REWARD_CHANNEL, c.rewardMessenger);
        console.log("Channels registered: vpfi-buy, vpfi-reward.");
    }

    /// @dev Set the remote business peer for each channel. Hub-and-spoke:
    ///      canonical Base peers with every mirror; a mirror peers only
    ///      with Base.
    function _wireChannelPeers(Ctx memory c) internal {
        CcipMessenger m = CcipMessenger(c.messenger);
        if (c.canonical) {
            for (uint256 i; i < c.laneChainIds.length; ++i) {
                uint256 cid = c.laneChainIds[i];
                if (_isCanonical(cid)) continue; // Base ↔ mirror only.
                m.setChannelPeer(
                    VPFI_BUY_CHANNEL,
                    cid,
                    Deployments.readAddressForChain(cid, ".vpfiBuyAdapter")
                );
                m.setChannelPeer(
                    VPFI_REWARD_CHANNEL,
                    cid,
                    // Typed reader: legacy `.rewardOApp` fallback per PR #272.
                    Deployments.readRewardMessengerForChain(cid)
                );
                console.log("  channel peers wired -> mirror", cid);
            }
        } else {
            m.setChannelPeer(
                VPFI_BUY_CHANNEL,
                c.baseChainId,
                Deployments.readAddressForChain(
                    c.baseChainId, ".vpfiBuyReceiver"
                )
            );
            m.setChannelPeer(
                VPFI_REWARD_CHANNEL,
                c.baseChainId,
                // Typed reader: legacy `.rewardOApp` fallback per PR #272.
                Deployments.readRewardMessengerForChain(c.baseChainId)
            );
            console.log("  channel peers wired -> Base", c.baseChainId);
        }
    }

    /// @dev Set the guardian — the detect-to-freeze fast lever — on every
    ///      cross-chain `GuardianPausable` contract on this chain.
    ///      Skipped when `CCIP_GUARDIAN` is unset (the guardian can
    ///      always be set later, owner-only).
    ///
    ///      Coverage map per chain class:
    ///        - Canonical (Base): `CcipMessenger`, `VaipakamRewardMessenger`,
    ///          `VpfiBuyReceiver`. The canonical VPFI ERC-20
    ///          (`VPFIToken`) does NOT extend `GuardianPausable` — it's
    ///          the long-lived OFT token, paused via its own
    ///          AccessControl path, not the cross-chain guardian. The
    ///          rate governor (`VpfiPoolRateGovernor`) is the
    ///          rate-limit admin only — no runtime send/receive path
    ///          of its own, no `GuardianPausable` inheritance (see
    ///          ADR-0004's "*VpfiPoolRateGovernor exception*" note).
    ///        - Mirrors: `CcipMessenger`, `VaipakamRewardMessenger`,
    ///          `VpfiBuyAdapter`, plus the mirror VPFI ERC-20
    ///          (`VPFIMirrorToken`), which DOES extend
    ///          `GuardianPausable`. Pre-#200 the mirror token was
    ///          left to the operator's memory; #200 wires it here.
    function _setGuardians(Ctx memory c) internal {
        if (c.guardian == address(0)) {
            console.log("Guardian: CCIP_GUARDIAN unset, skip.");
            return;
        }
        GuardianPausable(c.messenger).setGuardian(c.guardian);
        GuardianPausable(c.rewardMessenger).setGuardian(c.guardian);
        GuardianPausable(c.localBuyContract).setGuardian(c.guardian);
        if (!c.canonical) {
            // #200 — mirror-only: `VPFIMirrorToken` extends
            // `GuardianPausable` for the same incident-response
            // fast-pause reason the messenger + buy adapter do.
            // Wiring it here closes the operator-memory footgun
            // documented in #201.
            GuardianPausable(c.localToken).setGuardian(c.guardian);
            console.log("Guardian set on messenger / reward / buy / mirrorToken:", c.guardian);
        } else {
            console.log("Guardian set on messenger / reward / buyReceiver:", c.guardian);
        }
    }

    /// @dev Mirror only: point the mirror VPFI ERC20 at its Burn/Mint
    ///      pool — the pool is the sole address allowed to mint/burn it.
    function _pointMirrorTokenAtPool(Ctx memory c) internal {
        if (c.canonical) return;
        VPFIMirrorToken(c.localToken).setTokenPool(c.pool);
        console.log("Mirror VPFI token pool set:", c.pool);
    }

    /// @dev Wire the TokenPool lanes: register the governor as
    ///      `rateLimitAdmin`, add a lane per remote chain, then set each
    ///      lane's rate limits through the bounds-checked governor.
    function _wirePoolLanes(Ctx memory c) internal {
        TokenPool pool = TokenPool(c.pool);

        if (pool.getRateLimitAdmin() != c.rateGovernor) {
            pool.setRateLimitAdmin(c.rateGovernor);
            console.log("Pool rateLimitAdmin set:", c.rateGovernor);
        }

        // `applyChainUpdates` requires a *valid* rate-limit config; pass a
        // disabled (zero) one and let the governor set the real, enabled
        // limits immediately after — the governor is Vaipakam's
        // ET-008-bounded rate-limit path and the single source of truth.
        RateLimiter.Config memory off =
            RateLimiter.Config({isEnabled: false, capacity: 0, rate: 0});
        RateLimiter.Config memory on = RateLimiter.Config({
            isEnabled: true,
            capacity: c.rateCapacity,
            rate: c.rateRefill
        });

        for (uint256 i; i < c.laneChainIds.length; ++i) {
            uint256 cid = c.laneChainIds[i];
            uint64 selector = Deployments.ccipSelectorForChainId(cid);

            if (!pool.isSupportedChain(selector)) {
                TokenPool.ChainUpdate[] memory adds =
                    new TokenPool.ChainUpdate[](1);
                adds[0] = TokenPool.ChainUpdate({
                    remoteChainSelector: selector,
                    remotePoolAddresses: _wrap(
                        abi.encode(
                            Deployments.readAddressForChain(
                                cid, ".vpfiTokenPool"
                            )
                        )
                    ),
                    remoteTokenAddress: abi.encode(_remoteToken(cid)),
                    outboundRateLimiterConfig: off,
                    inboundRateLimiterConfig: off
                });
                pool.applyChainUpdates(new uint64[](0), adds);
                console.log("  pool lane added -> chain", cid);
            }

            // Idempotent: re-asserts the limits on every run.
            VpfiPoolRateGovernor(c.rateGovernor).setLaneRateLimits(
                selector, on, on
            );
            console.log("  pool lane rate limits set -> chain", cid);
        }
    }

    /// @dev Enable VPFI as a Cross-Chain Token: register `admin` as the
    ///      token's CCIP administrator (via the owner-based module),
    ///      accept the role, and point the registry at the pool. Each
    ///      sub-step is guarded so a re-run after a partial failure is
    ///      safe.
    function _registerCct(Ctx memory c) internal {
        TokenAdminRegistry reg = TokenAdminRegistry(c.registry);

        // `registerAdminViaOwner` requires the caller to be the token's
        // `owner()`. The mirror VPFI is owned by `admin`, so that holds;
        // but the canonical `VPFIToken`'s owner can be a separate
        // governance / timelock key — in which case the call would revert
        // mid-broadcast and block `ccip-wire`. Pre-check ownership: if the
        // broadcasting admin is not the token owner, skip CCT registration
        // with a clear instruction (the token owner runs it separately —
        // see the cutover runbook §8) rather than reverting the whole pass.
        address tokenOwner = IOwner(c.localToken).owner();
        if (tokenOwner != c.admin) {
            console.log("CCT: SKIPPED - broadcasting admin is not the token owner.");
            console.log("  VPFI token:  ", c.localToken);
            console.log("  token owner: ", tokenOwner);
            console.log("  broadcaster: ", c.admin);
            console.log("  Register VPFI as a CCT as the token owner:");
            console.log("  registerAdminViaOwner, acceptAdminRole, setPool.");
            return;
        }

        TokenAdminRegistry.TokenConfig memory cfg =
            reg.getTokenConfig(c.localToken);

        if (cfg.administrator == address(0) && cfg.pendingAdministrator == address(0)) {
            RegistryModuleOwnerCustom(c.moduleOwner).registerAdminViaOwner(
                c.localToken
            );
            console.log("CCT: admin proposed via owner module.");
            cfg = reg.getTokenConfig(c.localToken);
        }

        if (cfg.pendingAdministrator == c.admin) {
            reg.acceptAdminRole(c.localToken);
            console.log("CCT: admin role accepted.");
        }

        if (reg.getPool(c.localToken) != c.pool) {
            reg.setPool(c.localToken, c.pool);
            console.log("CCT: registry pool set:", c.pool);
        } else {
            console.log("CCT: registry pool already set, skip.");
        }
    }

    /// @dev Canonical Base only: record the mirror chain ids the daily
    ///      reward broadcast fans out to. On Base every lane *is* a
    ///      mirror; the filter is belt-and-braces.
    function _setBroadcastDestinations(Ctx memory c) internal {
        if (!c.canonical) return;

        uint256 n;
        for (uint256 i; i < c.laneChainIds.length; ++i) {
            if (!_isCanonical(c.laneChainIds[i])) ++n;
        }
        uint256[] memory mirrors = new uint256[](n);
        uint256 k;
        for (uint256 i; i < c.laneChainIds.length; ++i) {
            if (!_isCanonical(c.laneChainIds[i])) {
                mirrors[k++] = c.laneChainIds[i];
            }
        }
        VaipakamRewardMessenger(payable(c.rewardMessenger))
            .setBroadcastDestinations(mirrors);
        console.log("Reward broadcast destinations set:", n);
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _isCanonical(uint256 chainId) internal pure returns (bool) {
        return chainId == 8453 || chainId == 84532;
    }

    /// @dev A remote chain's VPFI token address — `.vpfiToken` on a
    ///      canonical chain, `.vpfiMirror` on a mirror.
    function _remoteToken(uint256 chainId) internal view returns (address) {
        return _isCanonical(chainId)
            ? Deployments.readAddressForChain(chainId, ".vpfiToken")
            : Deployments.readAddressForChain(chainId, ".vpfiMirror");
    }

    /// @dev Wrap one `bytes` value into a single-element `bytes[]` — the
    ///      shape `TokenPool.ChainUpdate.remotePoolAddresses` expects.
    function _wrap(bytes memory b) internal pure returns (bytes[] memory arr) {
        arr = new bytes[](1);
        arr[0] = b;
    }
}
