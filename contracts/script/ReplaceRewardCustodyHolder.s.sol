// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {RewardCustodyHolder} from "../src/RewardCustodyHolder.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title  ReplaceRewardCustodyHolder — the paused holder-replacement
 *         ceremony, with the deployment artifact kept in step
 *         (#1566 slice 4 PR A, design §5d; Codex #2158 r1 P2)
 * @notice Deploys a successor `RewardCustodyHolder` for the Diamond in
 *         `addresses.json`, runs `replaceRewardCustodyHolder` while the
 *         Diamond is paused (the old holder's WHOLE balance moves to the
 *         successor and the pointer flips in that one transaction), verifies
 *         the pointer, and then rewrites `.rewardCustodyHolder` in the
 *         artifact so no later script or package sync reads the emptied
 *         previous address as custody.
 *
 * @dev    Why the artifact write lives here and nowhere else: the on-chain
 *         ceremony is a single ADMIN call, but `addresses.json` is what
 *         `Deployments` documents as the source of truth for every later
 *         script and for the package sync. A replacement done by hand
 *         leaves the artifact pointing at a holder that no longer holds
 *         anything — monitoring reports stale custody the moment funds
 *         move. This script is the ONLY sanctioned way to replace a holder
 *         so that the two records cannot drift.
 *
 *         Reads:
 *           - `ADMIN_PRIVATE_KEY` — must hold `ADMIN_ROLE` (the ceremony is
 *             ADMIN-gated) and `PAUSER_ROLE` when the Diamond is not already
 *             paused (this script pauses for the ceremony and restores the
 *             prior state afterwards, the way the in-place refresh does).
 *           - the Diamond and the recorded holder from
 *             `contracts/deployments/<chain-slug>/addresses.json`.
 *
 *         Refuses when:
 *           - the Diamond has no holder bound (run `DeployRewardCustodyHolder`);
 *           - the artifact's `.rewardCustodyHolder` disagrees with the bound
 *             holder — the two records are ALREADY out of step and must be
 *             reconciled by an operator before another replacement widens
 *             the gap;
 *           - the bind did not take (the pointer read back differs).
 *
 *         Artifact writes follow the same dry-run / `DEPLOY_SKIP_ARTIFACTS`
 *         rule as every deploy script.
 */
contract ReplaceRewardCustodyHolder is Script {
    function run() external {
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();

        address bound = RewardCustodyFacet(diamond).rewardCustodyHolder();
        require(
            bound != address(0),
            "ReplaceRewardCustodyHolder: no holder is bound -- run DeployRewardCustodyHolder first"
        );
        address recorded = Deployments.readRewardCustodyHolderOptional();
        require(
            recorded == bound,
            "ReplaceRewardCustodyHolder: the artifact's .rewardCustodyHolder does not match the bound holder -- reconcile the record before replacing"
        );

        console.log("=== Reward custody holder replacement ===");
        console.log("Diamond:         ", diamond);
        console.log("Previous holder: ", bound);
        console.log("Admin:           ", vm.addr(adminKey));

        vm.startBroadcast(adminKey);

        bool wasPaused = AdminFacet(diamond).paused();
        if (!wasPaused) AdminFacet(diamond).pause();

        RewardCustodyHolder successor = new RewardCustodyHolder(diamond);
        RewardCustodyFacet(diamond).replaceRewardCustodyHolder(address(successor));

        if (!wasPaused) AdminFacet(diamond).unpause();

        vm.stopBroadcast();

        address now_ = RewardCustodyFacet(diamond).rewardCustodyHolder();
        require(
            now_ == address(successor),
            "ReplaceRewardCustodyHolder: the pointer did not flip to the successor"
        );
        console.log("Successor holder:", address(successor));

        if (!Deployments.artifactWritesEnabled()) {
            console.log("artifact writes are off for this run -- .rewardCustodyHolder NOT rewritten; the artifact is now STALE until it is.");
            return;
        }
        Deployments.writeRewardCustodyHolder(address(successor));
        console.log("Recorded .rewardCustodyHolder =", address(successor), "in", Deployments.path());
    }
}
