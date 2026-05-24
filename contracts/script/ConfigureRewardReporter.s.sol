// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {Deployments} from "./lib/Deployments.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title ConfigureRewardReporter
 * @notice One-shot post-deploy script that wires the Diamond's cross-chain
 *         reward plumbing (RewardReporterFacet + RewardAggregatorFacet) to
 *         the deployed reward messenger.
 * @dev Runs per chain. Caller must hold `ADMIN_ROLE`.
 *
 *      T-068 (LayerZero→CCIP): the reward facets key chains by EVM chain
 *      id, not by a LayerZero endpoint id. A chain's own identity is
 *      `block.chainid` — there is no `setLocalEid` any more. This script
 *      therefore configures the canonical chain id and the expected
 *      source chain ids as plain EVM chain ids.
 *
 *      Steps (all idempotent):
 *        1. setBaseChainId(canonicalBaseChainId)
 *        2. setRewardOApp(rewardMessengerProxy)
 *        3. setRewardGraceSeconds(default 14400 unless env overrides)
 *        4. setIsCanonicalRewardChain(true on Base only)
 *        5. (Base only) setExpectedSourceChainIds(list of source chain ids)
 *
 *      Required env vars:
 *        - ADMIN_PRIVATE_KEY        : ADMIN_ROLE-holding EOA. The
 *                                      RewardReporterFacet setters this
 *                                      script broadcasts (`setBaseChainId`,
 *                                      `setRewardOApp`,
 *                                      `setIsCanonicalRewardChain`,
 *                                      `setExpectedSourceChainIds`) all
 *                                      gate on `ADMIN_ROLE`.
 *        - <CHAIN>_DIAMOND_ADDRESS  : Diamond proxy for this chain
 *        - REWARD_OAPP_PROXY        : reward messenger proxy address
 *        - BASE_CHAIN_ID            : EVM chain id of the canonical (Base)
 *                                      reward chain — e.g. 8453 mainnet,
 *                                      84532 Base Sepolia
 *        - REWARD_GRACE_SECONDS     : optional, default 14400 (4h)
 *        - REWARD_EXPECTED_SOURCE_CHAIN_IDS : comma-separated EVM chain
 *                                      ids (only needed on Base). Example
 *                                      "8453,42161,10,137".
 */
contract ConfigureRewardReporter is Script {
    /// @dev Base chainIds (8453 mainnet, 84532 sepolia) are canonical.
    function _isCanonicalRewardChain() internal view returns (bool) {
        uint256 chainId = block.chainid;
        return chainId == 84532 || chainId == 8453;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("ADMIN_PRIVATE_KEY");
        // Read prior deploy artifacts. Diamond reads from
        // deployments/<chain>/addresses.json with chain-prefixed env
        // fallback. The reward messenger (`VaipakamRewardMessenger`,
        // T-068 CCIP) is recorded under `.rewardMessenger`; an explicit
        // `REWARD_OAPP_PROXY` env var, when set, overrides the artifact
        // read — the multi-chain orchestrators pass it so this script
        // never has to depend on the artifact key staying in step.
        address diamond = Deployments.readDiamond();
        address rewardOApp = vm.envOr("REWARD_OAPP_PROXY", address(0));
        if (rewardOApp == address(0)) {
            rewardOApp = Deployments.readRewardMessenger();
        }
        // EVM chain id of the canonical (Base) reward chain — the
        // destination for mirror-side chain reports. The reward facets
        // key by chain id (T-068), so this MUST be a real chain id
        // (8453 / 84532), never a LayerZero endpoint id.
        uint32 baseChainId = uint32(vm.envUint("BASE_CHAIN_ID"));
        uint64 grace = uint64(vm.envOr("REWARD_GRACE_SECONDS", uint256(14400)));
        bool canonical = _isCanonicalRewardChain();

        console.log("=== Configure Reward Reporter ===");
        console.log("Chain id:      ", block.chainid);
        console.log("Diamond:       ", diamond);
        console.log("RewardOApp:    ", rewardOApp);
        console.log("Base chain id: ", uint256(baseChainId));
        console.log("Grace secs:    ", uint256(grace));
        console.log("Canonical:     ", canonical);

        vm.startBroadcast(deployerKey);
        RewardReporterFacet rr = RewardReporterFacet(diamond);
        // No `setLocalEid` — a chain's identity is `block.chainid`.
        rr.setBaseChainId(baseChainId);
        rr.setRewardOApp(rewardOApp);
        rr.setRewardGraceSeconds(grace);
        rr.setIsCanonicalRewardChain(canonical);

        if (canonical) {
            string memory csv =
                vm.envOr("REWARD_EXPECTED_SOURCE_CHAIN_IDS", string(""));
            if (bytes(csv).length == 0) {
                console.log(
                    "WARNING: canonical chain but REWARD_EXPECTED_SOURCE_CHAIN_IDS empty; skipping aggregator wiring."
                );
            } else {
                uint32[] memory chainIds = _parseChainIdCsv(csv);
                RewardAggregatorFacet(diamond).setExpectedSourceChainIds(chainIds);
                console.log("Expected source chains set:", chainIds.length);
            }
        }
        vm.stopBroadcast();

        // Mirror the per-chain reward-mesh config into the artifact so
        // downstream scripts + the frontend env builder don't have to
        // re-read env vars or query the Diamond.
        Deployments.writeRewardMessenger(rewardOApp);
        Deployments.writeRewardBaseChainId(baseChainId);
        Deployments.writeRewardGraceSeconds(grace);
        Deployments.writeIsCanonicalReward(canonical);

        console.log("Reward reporter configuration applied.");
    }

    /// @dev Parse "8453,42161" → [8453, 42161]. No whitespace tolerance
    ///      (ops-only input; the runbook shows the exact format).
    function _parseChainIdCsv(string memory s)
        internal
        pure
        returns (uint32[] memory out)
    {
        bytes memory b = bytes(s);
        uint256 count = 1;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == ",") count++;
        }
        out = new uint32[](count);
        uint256 acc = 0;
        uint256 idx = 0;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == ",") {
                out[idx++] = SafeCast.toUint32(acc);
                acc = 0;
            } else {
                require(
                    c >= 0x30 && c <= 0x39,
                    "ConfigureRewardReporter: non-digit in chain-id csv"
                );
                acc = acc * 10 + (uint8(c) - 0x30);
            }
        }
        out[idx] = SafeCast.toUint32(acc);
    }
}
