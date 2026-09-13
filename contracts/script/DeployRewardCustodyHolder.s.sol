// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title  DeployRewardCustodyHolder — bind a `RewardCustodyHolder` on a
 *         LIVE Diamond that predates it (#1566 slice 4 PR A, design §5d)
 * @notice Runs ONCE per live chain, after the in-place facet refresh that
 *         cut `RewardCustodyFacet`. A fresh `DeployDiamond` binds its own
 *         holder and never needs this script.
 *
 * @dev    The Diamond CONSTRUCTS the holder inside `bindRewardCustodyHolder`
 *         — this script deploys nothing itself and supplies no address, so
 *         there is nothing here that could be pointed at the wrong contract.
 *         It reads the bound address back and records it.
 *
 *         Why this is its own script and not a block inside
 *         `RefreshAllFacetsInPlace`: a refresh is re-runnable, and a holder
 *         must be bound exactly once. A refresh that bound one would, on its
 *         next run, leave every attributed balance at the old address while
 *         the Diamond read an empty one. The holder's lifecycle is part of
 *         the design, not of the refresh.
 *
 *         Reads:
 *           - `ADMIN_PRIVATE_KEY` — broadcast key; must hold `ADMIN_ROLE` on
 *             the Diamond, since `bindRewardCustodyHolder` is ADMIN-gated.
 *           - the Diamond address from
 *             `contracts/deployments/<chain-slug>/addresses.json`.
 *
 *         Refuses when:
 *           - the artifact already records a holder, or the Diamond already
 *             has one bound — binding is one-shot on-chain
 *             (`RewardCustodyHolderAlreadyBound`), and this guard turns a
 *             wasted transaction into a clear message before any broadcast;
 *           - `RewardCustodyFacet` is not routed yet (the read reverts
 *             `FunctionDoesNotExist`) — run the facet refresh first.
 *
 *         Writes `.rewardCustodyHolder` into the artifact under the same
 *         dry-run / `DEPLOY_SKIP_ARTIFACTS` rule every deploy script
 *         follows.
 */
contract DeployRewardCustodyHolder is Script {
    function run() external {
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();

        address recorded = Deployments.readRewardCustodyHolderOptional();
        require(
            recorded == address(0),
            "DeployRewardCustodyHolder: artifact already records a holder -- replacement is the paused ceremony (ReplaceRewardCustodyHolder), not a re-run"
        );
        address bound = RewardCustodyFacet(diamond).rewardCustodyHolder();
        require(
            bound == address(0),
            "DeployRewardCustodyHolder: the Diamond already has a holder bound -- record it in the artifact instead of binding another"
        );

        console.log("=== Reward custody holder ===");
        console.log("Diamond:", diamond);
        console.log("Admin:  ", vm.addr(adminKey));

        vm.startBroadcast(adminKey);
        address holder = RewardCustodyFacet(diamond).bindRewardCustodyHolder();
        vm.stopBroadcast();

        console.log("RewardCustodyHolder:", holder);
        require(
            RewardCustodyFacet(diamond).rewardCustodyHolder() == holder && holder != address(0),
            "DeployRewardCustodyHolder: bind did not take"
        );

        if (!Deployments.artifactWritesEnabled()) {
            console.log("artifact writes are off for this run -- skipping .rewardCustodyHolder write.");
            return;
        }
        Deployments.writeRewardCustodyHolder(holder);
        console.log("Recorded .rewardCustodyHolder in", Deployments.path());
    }
}
