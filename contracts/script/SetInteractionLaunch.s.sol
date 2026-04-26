// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title SetInteractionLaunch
 * @notice Sets the interaction-rewards day-0 anchor timestamp on every
 *         chain's Diamond so all reward day boundaries align across the
 *         mesh. Must be broadcast by a holder of `ADMIN_ROLE`.
 * @dev The same timestamp MUST be used on every chain — the day index is
 *      derived client-side from `(block.timestamp - launchTs) / 86400`,
 *      so a skewed anchor on one chain means day N closes at different
 *      wall-clock moments across chains and the aggregator would reject
 *      the report with a day-mismatch.
 *
 *      Optionally sets the per-loan interaction-rewards cap
 *      (`vpfi / eth`, scaled to 1e18). Cap is a soft protection against
 *      a single underpriced-loan event forfeiting an outsized slice of
 *      the daily pool.
 *
 *      Required env vars:
 *        - PRIVATE_KEY                 : admin-role key
 *        - <CHAIN>_DIAMOND_ADDRESS     : Diamond proxy for this chain
 *        - INTERACTION_LAUNCH_TIMESTAMP: unix seconds of day 0, same on every chain
 *        - INTERACTION_CAP_VPFI_PER_ETH: optional, 1e18-scaled cap
 *                                         (omit to leave unchanged)
 */
contract SetInteractionLaunch is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        uint256 launchTs = vm.envUint("INTERACTION_LAUNCH_TIMESTAMP");
        uint256 cap = vm.envOr("INTERACTION_CAP_VPFI_PER_ETH", uint256(0));

        console.log("=== Set Interaction Launch ===");
        console.log("Chain id:       ", block.chainid);
        console.log("Diamond:        ", diamond);
        console.log("Launch ts:      ", launchTs);
        console.log("Cap VPFI/ETH:   ", cap);

        vm.startBroadcast(deployerKey);
        InteractionRewardsFacet ir = InteractionRewardsFacet(diamond);
        ir.setInteractionLaunchTimestamp(launchTs);
        if (cap > 0) {
            ir.setInteractionCapVpfiPerEth(cap);
        }
        vm.stopBroadcast();

        // Stamp the day-0 anchor (and optional cap) into the per-chain
        // artifact so cross-chain parity (every chain MUST share the
        // same launch ts) can be audited via `jq '.interactionLaunchTimestamp'
        // deployments/*/addresses.json | sort -u`. A non-singleton in
        // that pipeline is a deploy bug.
        Deployments.writeInteractionLaunchTimestamp(launchTs);
        if (cap > 0) {
            Deployments.writeUint(".interactionCapVpfiPerEth", cap);
        }

        console.log("Interaction launch anchor applied.");
    }
}
