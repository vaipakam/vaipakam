// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";

/**
 * @title GrantOpsRoles
 * @notice Pre-handover step that seeds the operational roles held outside
 *         the timelock. Run once per chain, **before** `TransferAdminToTimelock`.
 *
 * @dev Two operational roles are deliberately kept off the 48h Timelock path
 *      because their response budget is measured in minutes, not days:
 *
 *        - PAUSER_ROLE    : the Guardian incident-response multi-sig. Gates
 *                           {AdminFacet.pause/unpause} and
 *                           {pauseAsset/unpauseAsset}. Exists to close the
 *                           detect-to-freeze gap that a 48h timelock would
 *                           otherwise introduce.
 *        - KYC_ADMIN_ROLE : the Ops multi-sig. Gates per-user tier bumps, a
 *                           same-hour operational surface.
 *
 *      These two addresses MAY be the same Safe or different Safes depending
 *      on the security model — configurable independently below.
 *
 *      Script is idempotent: skips grants where the role is already held.
 *      Re-running after rotation is safe; to fully rotate a role the prior
 *      holder still needs to be revoked (see {RotateOpsRoles} or a manual
 *      multi-sig tx).
 *
 *      Required env vars:
 *        - PRIVATE_KEY                 : current DEFAULT_ADMIN_ROLE holder
 *        - <CHAIN>_DIAMOND_ADDRESS     : target Diamond
 *        - GOVERNANCE_GUARDIAN         : address that will hold PAUSER_ROLE
 *        - GOVERNANCE_KYC_OPS          : optional, defaults to GOVERNANCE_GUARDIAN
 *                                        if unset (single-Safe deployments)
 */
contract GrantOpsRoles is Script {
    function _diamondAddress() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) return vm.envAddress("BASE_SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 8453) return vm.envAddress("BASE_DIAMOND_ADDRESS");
        if (chainId == 11155111) return vm.envAddress("SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 421614) return vm.envAddress("ARB_SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 11155420) return vm.envAddress("OP_SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 1) return vm.envAddress("ETHEREUM_DIAMOND_ADDRESS");
        if (chainId == 42161) return vm.envAddress("ARBITRUM_DIAMOND_ADDRESS");
        if (chainId == 10) return vm.envAddress("OPTIMISM_DIAMOND_ADDRESS");
        if (chainId == 56) return vm.envAddress("BNB_DIAMOND_ADDRESS");
        if (chainId == 97) return vm.envAddress("BNB_TESTNET_DIAMOND_ADDRESS");
        if (chainId == 1101) return vm.envAddress("POLYGON_ZKEVM_DIAMOND_ADDRESS");
        if (chainId == 2442) return vm.envAddress("POLYGON_ZKEVM_CARDONA_DIAMOND_ADDRESS");
        revert(string.concat("GrantOpsRoles: unsupported chainId ", vm.toString(chainId)));
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address diamond = _diamondAddress();
        address guardian = vm.envAddress("GOVERNANCE_GUARDIAN");
        // Fall back to the guardian address for single-Safe deployments.
        address kycOps = vm.envOr("GOVERNANCE_KYC_OPS", guardian);

        require(guardian != address(0), "GrantOpsRoles: guardian is zero");
        require(kycOps != address(0), "GrantOpsRoles: kyc-ops is zero");

        console.log("=== Grant ops roles on Diamond ===");
        console.log("Chain id:  ", block.chainid);
        console.log("Diamond:   ", diamond);
        console.log("Guardian:  ", guardian);
        console.log("KYC ops:   ", kycOps);

        AccessControlFacet ac = AccessControlFacet(diamond);

        vm.startBroadcast(deployerKey);

        if (!ac.hasRole(LibAccessControl.PAUSER_ROLE, guardian)) {
            ac.grantRole(LibAccessControl.PAUSER_ROLE, guardian);
            console.log("granted PAUSER_ROLE       -> guardian");
        } else {
            console.log("PAUSER_ROLE already held by guardian; skip");
        }

        if (!ac.hasRole(LibAccessControl.KYC_ADMIN_ROLE, kycOps)) {
            ac.grantRole(LibAccessControl.KYC_ADMIN_ROLE, kycOps);
            console.log("granted KYC_ADMIN_ROLE    -> kyc-ops");
        } else {
            console.log("KYC_ADMIN_ROLE already held by kyc-ops; skip");
        }

        vm.stopBroadcast();

        console.log("Done. Safe to run TransferAdminToTimelock next.");
    }
}
