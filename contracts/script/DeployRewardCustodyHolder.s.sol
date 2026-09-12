// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {RewardCustodyHolder} from "../src/RewardCustodyHolder.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title  DeployRewardCustodyHolder — bind a `RewardCustodyHolder` to a
 *         LIVE Diamond that predates it (#1566 slice 4 PR A, design §5d)
 * @notice Runs ONCE per live chain, after the in-place facet refresh that
 *         cut `RewardCustodyFacet`. A fresh `DeployDiamond` binds its own
 *         holder and never needs this script.
 *
 * @dev    Why this is its own script and not a block inside
 *         `RefreshAllFacetsInPlace`: a refresh is re-runnable, and a holder
 *         must be deployed and bound exactly once. A refresh that deployed
 *         one would, on its next run, leave every attributed balance at the
 *         old address while the Diamond read an empty one. The holder's
 *         lifecycle is part of the design, not of the refresh.
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
 *             wasted deploy into a clear message before any broadcast;
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
            "DeployRewardCustodyHolder: artifact already records a holder -- replacement is the paused ceremony, not a re-run"
        );
        address bound = RewardCustodyFacet(diamond).rewardCustodyHolder();
        require(
            bound == address(0),
            "DeployRewardCustodyHolder: the Diamond already has a holder bound -- record it in the artifact instead of deploying another"
        );

        console.log("=== Reward custody holder ===");
        console.log("Diamond:", diamond);
        console.log("Admin:  ", vm.addr(adminKey));

        vm.startBroadcast(adminKey);
        RewardCustodyHolder holder = new RewardCustodyHolder(diamond);
        RewardCustodyFacet(diamond).bindRewardCustodyHolder(address(holder));
        vm.stopBroadcast();

        console.log("RewardCustodyHolder:", address(holder));
        require(
            RewardCustodyFacet(diamond).rewardCustodyHolder() == address(holder),
            "DeployRewardCustodyHolder: bind did not take"
        );

        if (!Deployments.artifactWritesEnabled()) {
            console.log("artifact writes are off for this run -- skipping .rewardCustodyHolder write.");
            return;
        }
        Deployments.writeRewardCustodyHolder(address(holder));
        console.log("Recorded .rewardCustodyHolder in", Deployments.path());
    }
}
