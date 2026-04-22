// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {VaipakamRewardOApp} from "../src/token/VaipakamRewardOApp.sol";
import {VaipakamRewardOAppBootstrap} from "../src/token/VaipakamRewardOAppBootstrap.sol";
import {LibCreate2Deploy} from "./lib/LibCreate2Deploy.sol";

/// @title DeployRewardOAppCreate2
/// @notice Cross-chain-deterministic deployment of the VaipakamRewardOApp
///         proxy using a bootstrap-proxy pattern.
/// @dev The real {VaipakamRewardOApp} has a chain-specific immutable
///      (the LayerZero `EndpointV2` address), so its init code is NOT
///      byte-identical across chains and plain CREATE2 cannot yield a
///      shared address. The workaround: deploy a tiny chain-agnostic
///      UUPS impl ({VaipakamRewardOAppBootstrap}) via CREATE2, deploy an
///      {ERC1967Proxy} pointed at that bootstrap via CREATE2, and then
///      atomically `upgradeToAndCall` to the real, chain-specific impl
///      inside the SAME script run. Because the bootstrap's init code is
///      identical everywhere, and the proxy's init code embeds only the
///      bootstrap address (also identical), the resulting proxy address
///      is identical on every chain.
///
///      ⚠️  The bootstrap's `_authorizeUpgrade` is intentionally
///      permissionless — the proxy is safe only because we upgrade it to
///      the real impl in the same broadcast. Do NOT split this script in
///      half; do NOT leave the bootstrap-stage proxy live on-chain.
///
///      Required env vars:
///        - PRIVATE_KEY          : deployer key (broadcaster)
///        - REWARD_VERSION       : version string baked into all three
///                                 CREATE2 salts. Bump on breaking
///                                 redeploys so new addresses don't
///                                 collide with old slots.
///        - REWARD_OWNER         : timelock/multisig owning the OApp
///                                 proxy (same address on every chain if
///                                 possible — Safe Singleton Factory).
///        - DIAMOND_ADDRESS      : local Vaipakam Diamond (read from
///                                 `<CHAIN>_DIAMOND_ADDRESS`; injected
///                                 here so the same script works per chain)
///        - IS_CANONICAL_REWARD  : "true" only on Base, else "false".
///        - BASE_EID             : LayerZero EID of Base. Pass 0 on Base
///                                 itself (canonical); pass Base's EID
///                                 on every mirror.
///        - LZ_ENDPOINT          : LayerZero EndpointV2 for the active
///                                 chain.
///        - REPORT_OPTIONS_HEX   : executor options for mirror→Base REPORT
///                                 packets (empty 0x is acceptable at
///                                 init; must be set later before
///                                 sendChainReport is usable).
///        - BROADCAST_OPTIONS_HEX: executor options for Base→mirror
///                                 BROADCAST packets (empty 0x
///                                 acceptable at init).
///
///      Verification: after running on each chain, compare the logged
///      `RewardOAppProxy` address against other chains — it MUST match
///      byte-for-byte, or one of (REWARD_VERSION, bootstrap init code)
///      drifted.
contract DeployRewardOAppCreate2 is Script {
    address public bootstrapImpl;
    address public rewardOAppProxy;
    address public realImpl;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        string memory version = vm.envString("REWARD_VERSION");
        address owner = vm.envAddress("REWARD_OWNER");
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        bool isCanonical = vm.envBool("IS_CANONICAL_REWARD");
        uint32 baseEid = uint32(vm.envUint("BASE_EID"));
        address lzEndpoint = vm.envAddress("LZ_ENDPOINT");
        bytes memory reportOptions = vm.envBytes("REPORT_OPTIONS_HEX");
        bytes memory broadcastOptions = vm.envBytes("BROADCAST_OPTIONS_HEX");

        console.log("=== Vaipakam RewardOApp Deploy (CREATE2 bootstrap) ===");
        console.log("Version:        ", version);
        console.log("Owner:          ", owner);
        console.log("Diamond:        ", diamond);
        console.log("Is canonical:   ", isCanonical);
        console.log("Base EID:       ", uint256(baseEid));
        console.log("LZ endpoint:    ", lzEndpoint);
        console.log("Deployer:       ", vm.addr(deployerKey));

        require(
            LibCreate2Deploy.factoryIsDeployed(),
            "Singleton CREATE2 factory not on this chain; bootstrap it first."
        );
        if (isCanonical) {
            require(baseEid == 0, "Canonical chain must pass BASE_EID=0");
        } else {
            require(baseEid != 0, "Mirror chain must pass non-zero BASE_EID");
        }

        // ── Pre-compute the cross-chain-constant addresses ───────────────
        bytes32 bootstrapSalt = LibCreate2Deploy.protocolSalt(version, "RewardOAppBootstrap");
        bytes32 proxySalt = LibCreate2Deploy.protocolSalt(version, "RewardOAppProxy");

        bytes memory bootstrapInitCode = type(VaipakamRewardOAppBootstrap).creationCode;
        address expectedBootstrap = LibCreate2Deploy.computeAddress(
            bootstrapSalt,
            keccak256(bootstrapInitCode)
        );

        // The proxy ctor: (address impl, bytes initCallData). We leave
        // init data empty here — the real impl's `initialize` is invoked
        // via `upgradeToAndCall` in step 4 below. Empty init data keeps
        // the proxy's init code byte-identical across chains.
        bytes memory proxyInitCode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(expectedBootstrap, bytes(""))
        );
        address expectedProxy = LibCreate2Deploy.computeAddress(
            proxySalt,
            keccak256(proxyInitCode)
        );

        console.log("Predicted bootstrap impl:", expectedBootstrap);
        console.log("Predicted OApp proxy:    ", expectedProxy);

        vm.startBroadcast(deployerKey);

        // ── Step 1: chain-agnostic bootstrap impl via CREATE2 ────────────
        // Idempotent on redeploy of the same version: if the bootstrap
        // already exists, skip re-deploy and reuse.
        if (expectedBootstrap.code.length == 0) {
            bootstrapImpl = LibCreate2Deploy.deployExpecting(
                bootstrapSalt,
                bootstrapInitCode,
                expectedBootstrap
            );
        } else {
            bootstrapImpl = expectedBootstrap;
            console.log("Bootstrap impl already live, reusing.");
        }

        // ── Step 2: ERC1967 proxy pointed at bootstrap, via CREATE2 ──────
        rewardOAppProxy = LibCreate2Deploy.deployExpecting(
            proxySalt,
            proxyInitCode,
            expectedProxy
        );
        console.log("Deployed OApp proxy:     ", rewardOAppProxy);

        // ── Step 3: real impl (chain-specific, regular new) ──────────────
        // This IS chain-dependent — the LZ endpoint is an immutable of
        // the impl. That's fine; only the proxy address needs parity.
        VaipakamRewardOApp real = new VaipakamRewardOApp(lzEndpoint);
        realImpl = address(real);
        console.log("Real impl (chain-local): ", realImpl);

        // ── Step 4: atomic upgrade + initialize ──────────────────────────
        // After this, the permissionless bootstrap `_authorizeUpgrade` is
        // gone — the real impl's `_authorizeUpgrade` is `onlyOwner`.
        bytes memory initData = abi.encodeCall(
            VaipakamRewardOApp.initialize,
            (owner, diamond, isCanonical, baseEid, reportOptions, broadcastOptions)
        );
        UUPSUpgradeable(rewardOAppProxy).upgradeToAndCall(realImpl, initData);
        console.log("Proxy upgraded + initialized.");

        vm.stopBroadcast();

        // ── Summary ──────────────────────────────────────────────────────
        console.log("");
        console.log("=== RewardOApp CREATE2 Summary ===");
        console.log("Bootstrap impl:", bootstrapImpl);
        console.log("RewardOAppProxy (CROSS-CHAIN IDENTICAL):", rewardOAppProxy);
        console.log("Real impl (chain-local):", realImpl);
        console.log("");
        console.log(
            "VERIFY on every other chain in the mesh: RewardOAppProxy MUST match byte-for-byte."
        );
        console.log("If it diverges, REWARD_VERSION drifted OR a non-owner deployer produced a different bootstrap init code.");
        console.log("");
        console.log("NEXT STEPS (owner-only, outside this script):");
        console.log(" - RewardReporterFacet.setRewardOApp(<proxy>)  [on every chain]");
        console.log(" - RewardReporterFacet.setLocalEid(<local eid>) [on every chain]");
        console.log(" - RewardReporterFacet.setBaseEid(<base eid>)  [on mirror chains]");
        console.log(" - RewardReporterFacet.setIsCanonicalRewardChain(true) [Base only]");
        console.log(" - RewardAggregatorFacet.setExpectedSourceEids([...]) [Base only]");
        console.log(" - oapp.setPeer(remote eid, bytes32(uint256(uint160(proxy)))) [between every chain pair]");
        console.log(" - oapp.setDelegate(<owner>) for DVN/executor config [per LZ docs]");
    }
}
