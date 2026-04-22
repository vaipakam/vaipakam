// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";

/**
 * @title ConfigureRewardReporter
 * @notice One-shot post-deploy script that wires the Diamond's cross-chain
 *         reward plumbing (RewardReporterFacet + RewardAggregatorFacet) to
 *         the deployed VaipakamRewardOApp proxy.
 * @dev Runs per chain. Caller must hold `ADMIN_ROLE`.
 *
 *      Steps (all idempotent):
 *        1. setLocalEid(thisChainEid)
 *        2. setBaseEid(baseEid)
 *        3. setRewardOApp(rewardOAppProxy)
 *        4. setRewardGraceSeconds(default 14400 unless env overrides)
 *        5. setIsCanonicalRewardChain(true on Base only)
 *        6. (Base only) setExpectedSourceEids(list of mirror eids)
 *
 *      Required env vars:
 *        - PRIVATE_KEY              : admin-role key
 *        - <CHAIN>_DIAMOND_ADDRESS  : Diamond proxy for this chain
 *        - REWARD_OAPP_PROXY        : VaipakamRewardOApp proxy address
 *                                      (deterministic across chains under
 *                                      the CREATE2 bootstrap pattern)
 *        - LOCAL_EID                : LZ eid of this chain
 *        - BASE_EID                 : LZ eid of Base (e.g. 40245 for
 *                                      Base Sepolia)
 *        - REWARD_GRACE_SECONDS     : optional, default 14400 (4h)
 *        - REWARD_EXPECTED_SOURCE_EIDS : comma-separated mirror eids
 *                                        (only needed on Base). Example
 *                                        "40161,40231,40232,40267".
 */
contract ConfigureRewardReporter is Script {
    function _diamondAddress() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) return vm.envAddress("BASE_SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 8453) return vm.envAddress("BASE_DIAMOND_ADDRESS");
        if (chainId == 11155111) return vm.envAddress("SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 421614) return vm.envAddress("ARB_SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 11155420) return vm.envAddress("OP_SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 80002) return vm.envAddress("POLYGON_AMOY_DIAMOND_ADDRESS");
        revert(string.concat("ConfigureRewardReporter: unsupported chainId ", vm.toString(chainId)));
    }

    /// @dev Base chainIds (8453 mainnet, 84532 sepolia) are canonical.
    function _isCanonicalRewardChain() internal view returns (bool) {
        uint256 chainId = block.chainid;
        return chainId == 84532 || chainId == 8453;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = _diamondAddress();
        address rewardOApp = vm.envAddress("REWARD_OAPP_PROXY");
        uint32 localEid = uint32(vm.envUint("LOCAL_EID"));
        uint32 baseEid = uint32(vm.envUint("BASE_EID"));
        uint64 grace = uint64(vm.envOr("REWARD_GRACE_SECONDS", uint256(14400)));
        bool canonical = _isCanonicalRewardChain();

        console.log("=== Configure Reward Reporter ===");
        console.log("Chain id:     ", block.chainid);
        console.log("Diamond:      ", diamond);
        console.log("RewardOApp:   ", rewardOApp);
        console.log("Local eid:    ", uint256(localEid));
        console.log("Base eid:     ", uint256(baseEid));
        console.log("Grace secs:   ", uint256(grace));
        console.log("Canonical:    ", canonical);

        vm.startBroadcast(deployerKey);
        RewardReporterFacet rr = RewardReporterFacet(diamond);
        rr.setLocalEid(localEid);
        rr.setBaseEid(baseEid);
        rr.setRewardOApp(rewardOApp);
        rr.setRewardGraceSeconds(grace);
        rr.setIsCanonicalRewardChain(canonical);

        if (canonical) {
            string memory csv = vm.envOr("REWARD_EXPECTED_SOURCE_EIDS", string(""));
            if (bytes(csv).length == 0) {
                console.log("WARNING: canonical chain but REWARD_EXPECTED_SOURCE_EIDS empty; skipping aggregator wiring.");
            } else {
                uint32[] memory eids = _parseEidCsv(csv);
                RewardAggregatorFacet(diamond).setExpectedSourceEids(eids);
                console.log("Expected source eids set:", eids.length);
            }
        }
        vm.stopBroadcast();

        console.log("Reward reporter configuration applied.");
    }

    /// @dev Parse "40161,40232" → [40161, 40232]. No whitespace tolerance
    ///      (ops-only input, the runbook shows the exact format).
    function _parseEidCsv(string memory s) internal pure returns (uint32[] memory out) {
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
                out[idx++] = uint32(acc);
                acc = 0;
            } else {
                require(c >= 0x30 && c <= 0x39, "ConfigureRewardReporter: non-digit in eid csv");
                acc = acc * 10 + (uint8(c) - 0x30);
            }
        }
        out[idx] = uint32(acc);
    }
}
