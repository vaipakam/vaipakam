// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title BootstrapAnvil
 * @notice Anvil-only post-deploy script: flips the three Range Orders
 *         Phase 1 master kill-switch flags ON so the matching detector
 *         in `vaipakam-keeper-bot` can exercise the full create-offer +
 *         match-offers flow against a local node.
 *
 *         Sequence the operator runs when bringing up an anvil
 *         playground (see `script/anvil-bootstrap.sh`):
 *           1. anvil --chain-id 31337
 *           2. forge script DeployDiamond.s.sol            (PRIVATE_KEY)
 *           3. forge script DeployTestnetLiquidityMocks    (PRIVATE_KEY,
 *                                                            ADMIN_PRIVATE_KEY)
 *           4. forge script BootstrapAnvil.s.sol  ←  this file
 *           5. forge script SeedAnvilOffers.s.sol         (test data)
 *           6. cd ../vaipakam-keeper-bot && npm start
 *
 * @dev Hard-gated to `block.chainid == 31337`. A misfire on a real
 *      network would mutate governance config; the chain check
 *      eliminates that footgun.
 *
 *      Required env vars:
 *        - ADMIN_PRIVATE_KEY : holds ADMIN_ROLE on the Diamond.
 *
 *      Reads the Diamond address from `deployments/anvil/addresses.json`
 *      via `Deployments.readDiamond()` (with `ANVIL_DIAMOND_ADDRESS`
 *      env fallback per the standard Deployments convention).
 *
 *      Idempotent — safe to re-run; the setters are pure flag writes.
 */
contract BootstrapAnvil is Script {
    function run() external {
        require(
            block.chainid == 31337,
            "BootstrapAnvil: refusing to run outside anvil (chainid != 31337)"
        );

        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        require(
            diamond != address(0),
            "BootstrapAnvil: diamond address not found - run DeployDiamond first"
        );

        console.log("=== Bootstrap Anvil (Range Orders Phase 1) ===");
        console.log("Chain id: ", block.chainid);
        console.log("Diamond:  ", diamond);
        console.log("Admin:    ", vm.addr(adminKey));

        vm.startBroadcast(adminKey);
        ConfigFacet cfg = ConfigFacet(diamond);
        cfg.setRangeAmountEnabled(true);
        cfg.setRangeRateEnabled(true);
        cfg.setPartialFillEnabled(true);
        vm.stopBroadcast();

        // Verify with a single bundle read so the script can't return
        // success on a silently-failed setter.
        (
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            bool rangeAmount,
            bool rangeRate,
            bool partialFill
        ) = cfg.getProtocolConfigBundle();
        require(
            rangeAmount && rangeRate && partialFill,
            "BootstrapAnvil: one or more master flags failed to flip on"
        );

        console.log("Master flags ON: rangeAmount, rangeRate, partialFill");
        console.log("Anvil playground ready. Next: forge script SeedAnvilOffers.s.sol");
    }
}
