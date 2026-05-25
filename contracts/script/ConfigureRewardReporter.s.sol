// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {Deployments} from "./lib/Deployments.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @dev Minimal local interface for `VaipakamRewardMessenger.diamond()`.
///      Used by the env-only branch of `run()` to ask the messenger
///      contract whose Diamond it thinks it's bound to. The `diamond`
///      field is plain storage (set in the messenger's
///      `initialize()` and mutable via its `onlyOwner setDiamond`
///      mutator), so this is OPERATIONAL defence against honest
///      stale-env mistakes, NOT a cryptographic anchor against a
///      malicious `diamond()` impl or a compromised messenger owner —
///      see the long-form comment at the call site for the full
///      threat-model breakdown.
///
///      Local declaration avoids dragging the whole
///      `VaipakamRewardMessenger` Solidity import (with its CCIP /
///      OpenZeppelin transitive cost) into this thin configure script.
interface IPeerBoundMessenger {
    function diamond() external view returns (address);
}

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
 *        2. setRewardMessenger(rewardMessengerProxy)
 *        3. setRewardGraceSeconds(default 14400 unless env overrides)
 *        4. setIsCanonicalRewardChain(true on Base only)
 *        5. (Base only) setExpectedSourceChainIds(list of source chain ids)
 *
 *      Required env vars:
 *        - ADMIN_PRIVATE_KEY        : ADMIN_ROLE-holding EOA. The
 *                                      RewardReporterFacet setters this
 *                                      script broadcasts (`setBaseChainId`,
 *                                      `setRewardMessenger`,
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
        //
        // Defence-in-depth (PR #272): when BOTH the env var and the
        // artifact resolve, they must agree. A stale `REWARD_OAPP_PROXY`
        // carried over from a prior chain's run in a multi-chain loop —
        // or an operator running `forge script ConfigureRewardReporter`
        // directly with an old env var — would otherwise silently wire
        // the wrong-chain messenger on this Diamond. The deploy-script
        // wrappers (`deploy-testnet.sh` / `deploy-mainnet.sh`) `unset`
        // the env at the start of phase_configure, but a direct invoke
        // bypasses that. This mismatch check makes the bug loud.
        address diamond = Deployments.readDiamond();
        address envOverride = vm.envOr("REWARD_OAPP_PROXY", address(0));
        // Use the optional reader (returns address(0) on miss) so the
        // env-only path doesn't get blocked by a missing artifact.
        address artifactValue = Deployments.tryReadRewardMessenger();
        address rewardMessenger;
        if (envOverride != address(0) && artifactValue != address(0)) {
            // BOTH set: must agree, else likely stale env from a prior
            // chain's run.
            require(
                envOverride == artifactValue,
                "ConfigureRewardReporter: REWARD_OAPP_PROXY env disagrees with .rewardMessenger artifact "
                "(likely stale env from a prior chain's run; unset and rerun, or fix the artifact)"
            );
            rewardMessenger = envOverride;
        } else if (envOverride != address(0)) {
            // Env-only path (no artifact yet on this chain).
            //
            // Operational peer-binding verification (PR #272 round 3):
            // ask the messenger contract itself whose Diamond it
            // thinks it's bound to. A mismatch means the env override
            // either:
            //   (a) points at a wrong-chain messenger (the most common
            //       stale-env failure mode in multi-chain runs);
            //   (b) points at a contract that isn't a
            //       VaipakamRewardMessenger at all (an EOA, a different
            //       proxy, a typo'd address); or
            //   (c) points at a messenger bound to a different
            //       Diamond (still wrong-Diamond for the chain we're
            //       configuring).
            //
            // The check catches every honest stale-env case INCLUDING
            // the fresh-first-time-set one the on-chain cross-check
            // alternative (Option 1, abandoned) couldn't cover — there,
            // a brand-new Diamond's `currentMessenger == 0` made the
            // check trivially pass and the wrong address went through.
            // Asking the messenger directly doesn't depend on the
            // Diamond's prior state.
            //
            // ── Honest limits of this guard ──────────────────────────
            // The `diamond` field on `VaipakamRewardMessenger` is NOT
            // a constructor-time immutable — the contract is
            // UUPS-upgradeable, `diamond` is plain storage set in
            // `initialize()` with an `onlyOwner setDiamond` mutator
            // (see `VaipakamRewardMessenger.sol` L100 / L500). So this
            // verify is operational defence-in-depth, NOT a
            // cryptographic anchor. It does NOT defend against:
            //   • a malicious env address pointing at an attacker-
            //     controlled contract that implements `diamond()`
            //     returning this Diamond's address; or
            //   • a compromised messenger owner who used `setDiamond`
            //     to spoof the binding back to this Diamond before
            //     the operator runs the script.
            //
            // Both cases require attacker capability the script can't
            // gate around: an attacker with `ADMIN_PRIVATE_KEY` (the
            // key this script broadcasts with) can bypass the script
            // entirely by calling `setRewardMessenger(...)` directly
            // on the Diamond; an attacker who owns the messenger
            // contract has already compromised the cross-chain trust
            // boundary upstream. Operator-mistake protection is the
            // script's actual job; admin-key / messenger-owner
            // compromise is out of scope.
            //
            // Cost: one extra `view` call per configure run. No new
            // env vars, no format change, no back-compat break.
            require(
                envOverride.code.length > 0,
                "ConfigureRewardReporter: REWARD_OAPP_PROXY is not a contract "
                "(env override is either an EOA or an undeployed address)"
            );
            address bound = IPeerBoundMessenger(envOverride).diamond();
            require(
                bound == diamond,
                "ConfigureRewardReporter: REWARD_OAPP_PROXY messenger's .diamond() "
                "does not match this Diamond - env override is bound to a different "
                "Diamond (likely stale env from a prior chain's run; unset and rerun)"
            );
            rewardMessenger = envOverride;
        } else if (artifactValue != address(0)) {
            // Artifact-only path (no env override).
            rewardMessenger = artifactValue;
        } else {
            // Neither — load the reverting reader to produce the usual
            // env-fallback error path (`REWARD_MESSENGER_ADDRESS` env
            // var or addresses.json missing).
            rewardMessenger = Deployments.readRewardMessenger();
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
        console.log("RewardMessenger:    ", rewardMessenger);
        console.log("Base chain id: ", uint256(baseChainId));
        console.log("Grace secs:    ", uint256(grace));
        console.log("Canonical:     ", canonical);

        vm.startBroadcast(deployerKey);
        RewardReporterFacet rr = RewardReporterFacet(diamond);
        // No `setLocalEid` — a chain's identity is `block.chainid`.
        rr.setBaseChainId(baseChainId);
        rr.setRewardMessenger(rewardMessenger);
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
        Deployments.writeRewardMessenger(rewardMessenger);
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
