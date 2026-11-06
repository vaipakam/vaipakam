// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/// @dev The three reads the funding guard needs, declared here rather than
///      imported from their facets so the script does not compile them.
interface IRewardFundingReads {
    function getRewardRole() external view returns (uint8 role);
    function armedFreshLedger() external view returns (uint256 received, uint256 paid);
    function getDeliveredFreshBound() external view returns (uint256 paid, uint256 remaining);
}

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
 *        - ADMIN_PRIVATE_KEY           : ADMIN_ROLE-holding EOA. The
 *                                         setters here
 *                                         (`setInteractionLaunchTimestamp`,
 *                                         `setInteractionCapVpfiPerEth`)
 *                                         gate on `ADMIN_ROLE`. Same key
 *                                         the sibling `ConfigureOracle` /
 *                                         `ConfigureVPFIBuy` /
 *                                         `ConfigureNFTImageURIs` scripts
 *                                         use. Post-handover the deployer
 *                                         EOA holds zero roles, so the
 *                                         legacy `DEPLOYER_PRIVATE_KEY` would
 *                                         revert here.
 *        - <CHAIN>_DIAMOND_ADDRESS     : Diamond proxy for this chain
 *        - INTERACTION_LAUNCH_TIMESTAMP: unix seconds of day 0, same on every chain
 *        - INTERACTION_CAP_VPFI_PER_ETH: optional, 1e18-scaled cap
 *                                         (omit to leave unchanged)
 *
 *      On the CANONICAL chain the anchor is refused while the reward pool
 *      has no delivered-fresh headroom (#3253). The 69M interaction pool is
 *      an allocation, not a balance: the canonical delivered-fresh bound is
 *      `received − (paid + reserved)`, and `received` is credited only by
 *      `RewardCustodyFacet.fundRewardPool` and the custody era transfers. A
 *      chain launched unfunded refuses every reward-budget remittance to the
 *      mirrors with `DeliveredFreshBoundExceeded`, so no day reaches them.
 *      Fund first; the anchor is one-shot, so it cannot be set and fixed
 *      afterwards. A mirror is funded by those remittances and is not
 *      checked here.
 */
contract SetInteractionLaunch is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        uint256 launchTs = vm.envUint("INTERACTION_LAUNCH_TIMESTAMP");
        uint256 cap = vm.envOr("INTERACTION_CAP_VPFI_PER_ETH", uint256(0));

        console.log("=== Set Interaction Launch ===");
        console.log("Chain id:       ", block.chainid);
        console.log("Diamond:        ", diamond);
        console.log("Launch ts:      ", launchTs);
        console.log("Cap VPFI/ETH:   ", cap);
        _requireCanonicalFunded(diamond);

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

    /// @notice Refuses to open the reward schedule on the canonical chain
    ///         while its delivered-fresh bound is zero (#3253). A read that
    ///         reverts halts the script too: it is never read as funded.
    function _requireCanonicalFunded(address diamond) internal view {
        IRewardFundingReads d = IRewardFundingReads(diamond);
        uint8 role = d.getRewardRole();
        // `LibVaipakam.RewardRole.Canonical` is 0.
        if (role != 0) {
            console.log("Reward role:     not canonical - funded by Base's remittances, not checked here");
            return;
        }
        (uint256 received, uint256 paid) = d.armedFreshLedger();
        (, uint256 remaining) = d.getDeliveredFreshBound();
        console.log("Fresh received: ", received);
        console.log("Fresh paid:     ", paid);
        console.log("Fresh remaining:", remaining);
        require(
            remaining > 0,
            "SetInteractionLaunch: the canonical reward pool has no delivered-fresh headroom - fund it with RewardCustodyFacet.fundRewardPool (ADMIN) before setting the one-shot launch anchor, or no day reaches the mirrors"
        );
    }
}
