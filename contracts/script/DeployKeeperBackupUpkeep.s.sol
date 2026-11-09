// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {KeeperBackupUpkeep} from "../src/keeper/KeeperBackupUpkeep.sol";
import {Deployments} from "./lib/Deployments.sol";

interface ITreasuryRead {
    function getTreasury() external view returns (address);
}

/**
 * @title  DeployKeeperBackupUpkeep
 * @notice Per-chain deploy of the keeper backup runner (#3361), the contract a
 *         Chainlink Automation upkeep drives. See
 *         docs/DesignsAndPlans/KeeperBackupAutomationDesign.md.
 *
 * @dev    Reads:
 *           - `DEPLOYER_PRIVATE_KEY` — broadcast key.
 *           - `KEEPER_BACKUP_OWNER`  — the owner of the runner's settings
 *                                      (the admin multisig on a mainnet).
 *           - the Diamond, from this chain's `addresses.json`.
 *         The treasury the runner sweeps to is read from the Diamond
 *         (`getTreasury`) and fixed in the runner at deployment.
 *
 *         What it does NOT do, on purpose: it switches no step on and sets
 *         no forwarder. The runner deploys with every step off. The forwarder
 *         exists only once the upkeep is registered with Chainlink (which
 *         spends LINK), and the owner then calls `setForwarder` and arms
 *         steps one by one, each an owner decision like arming a keeper pass.
 */
contract DeployKeeperBackupUpkeep is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.envAddress("KEEPER_BACKUP_OWNER");
        require(owner != address(0), "KEEPER_BACKUP_OWNER unset");

        address diamond = Deployments.readDiamond();
        require(diamond != address(0), "diamond not deployed on this chain");
        address treasury = ITreasuryRead(diamond).getTreasury();
        require(treasury != address(0), "the Diamond has no treasury");

        console.log("DeployKeeperBackupUpkeep");
        console.log("  chainId  :", block.chainid);
        console.log("  diamond  :", diamond);
        console.log("  treasury :", treasury);
        console.log("  owner    :", owner);

        vm.startBroadcast(deployerKey);
        KeeperBackupUpkeep backup = new KeeperBackupUpkeep(diamond, treasury, owner);
        vm.stopBroadcast();

        console.log("  deployed :", address(backup));
        console.log("  every step is off; set the forwarder after registering the upkeep");
        Deployments.writeKeeperBackupUpkeep(address(backup));
    }
}
