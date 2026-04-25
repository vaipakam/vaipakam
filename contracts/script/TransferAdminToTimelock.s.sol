// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {IERC173} from "@diamond-3/interfaces/IERC173.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title TransferAdminToTimelock
 * @notice Hands Diamond privileged control to a previously-deployed
 *         TimelockController. After this script the deployer EOA can still
 *         schedule operations only by going through the multi-sig proposer;
 *         direct admin calls from the EOA will revert.
 *
 * @dev Steps performed, in order:
 *        1. Grant DEFAULT_ADMIN_ROLE to timelock (so it can manage all roles)
 *        2. Grant ADMIN_ROLE        to timelock (AdminFacet / Profile gates)
 *        3. Grant ORACLE_ADMIN_ROLE to timelock (oracle config changes)
 *        4. Grant RISK_ADMIN_ROLE   to timelock (risk param changes)
 *        5. Grant ESCROW_ADMIN_ROLE to timelock (escrow impl upgrades)
 *        6. Transfer LibDiamond ownership (ERC-173) to the timelock
 *        7. Renounce every role held by the deployer EOA
 *
 *      Step 7 is intentionally last — if any earlier step reverts, the
 *      deployer keeps the ability to retry. Do NOT run this script with
 *      `--broadcast` until the timelock wiring has been rehearsed on a
 *      testnet Diamond first.
 *
 *      PAUSER_ROLE and KYC_ADMIN_ROLE are deliberately NOT handed to the
 *      timelock:
 *        - PAUSER_ROLE gates {AdminFacet.pause/unpause} and
 *          {pauseAsset/unpauseAsset} — an incident-response surface that
 *          cannot tolerate a 48h delay.
 *        - KYC_ADMIN_ROLE gates per-user tier bumps — an operational
 *          surface that needs same-hour response.
 *      Both stay on a dedicated operations multi-sig. This script expects
 *      the caller to have already granted both roles to that ops address
 *      *before* handover, so the EOA renounce at step 7 doesn't strand
 *      either role.
 *
 *      Required env vars:
 *        - PRIVATE_KEY                 : current Diamond owner / DEFAULT_ADMIN
 *        - <CHAIN>_DIAMOND_ADDRESS     : target Diamond
 *        - <CHAIN>_TIMELOCK_ADDRESS    : target timelock (from DeployTimelock)
 *        - CONFIRM_HANDOVER            : must equal "YES" — guard against
 *                                        accidental mainnet broadcast
 */
contract TransferAdminToTimelock is Script {
    function run() external {
        string memory confirm = vm.envOr("CONFIRM_HANDOVER", string(""));
        require(
            keccak256(bytes(confirm)) == keccak256(bytes("YES")),
            "TransferAdminToTimelock: set CONFIRM_HANDOVER=YES to proceed"
        );

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        // Diamond + timelock both come from
        // deployments/<chain>/addresses.json with chain-prefixed env
        // fallback. Operators no longer need to chain-prefix
        // <CHAIN>_DIAMOND_ADDRESS / <CHAIN>_TIMELOCK_ADDRESS once
        // the file is committed.
        address diamond = Deployments.readDiamond();
        address timelock = Deployments.readTimelock();

        require(timelock != address(0), "TransferAdminToTimelock: timelock is zero");
        require(timelock != deployer, "TransferAdminToTimelock: timelock == deployer");

        console.log("=== Transfer Diamond Admin to Timelock ===");
        console.log("Chain id:       ", block.chainid);
        console.log("Diamond:        ", diamond);
        console.log("Timelock:       ", timelock);
        console.log("Deployer (EOA): ", deployer);

        AccessControlFacet ac = AccessControlFacet(diamond);
        IERC173 ownership = IERC173(diamond);

        // Roles that migrate TO the timelock (48h-gated). These are the
        // slow / governance-grade admin surfaces.
        bytes32[5] memory timelockRoles = [
            LibAccessControl.DEFAULT_ADMIN_ROLE,
            LibAccessControl.ADMIN_ROLE,
            LibAccessControl.ORACLE_ADMIN_ROLE,
            LibAccessControl.RISK_ADMIN_ROLE,
            LibAccessControl.ESCROW_ADMIN_ROLE
        ];

        // Roles that do NOT migrate to the timelock — they stay on the
        // Guardian / ops multi-sigs (set up by GrantOpsRoles). The
        // deployer's hold on them must still be renounced here, otherwise
        // the deploy EOA retains PAUSER + KYC_ADMIN after handover, which
        // is a hot-wallet hole the GovernanceHandover.t.sol invariant
        // catches. Pre-condition: GrantOpsRoles has already granted these
        // to their intended holders (a sanity-check assertion below).
        bytes32[2] memory opsRoles = [
            LibAccessControl.PAUSER_ROLE,
            LibAccessControl.KYC_ADMIN_ROLE
        ];

        vm.startBroadcast(deployerKey);

        // 1-5: grant every timelocked role to the timelock.
        for (uint256 i = 0; i < timelockRoles.length; i++) {
            if (!ac.hasRole(timelockRoles[i], timelock)) {
                ac.grantRole(timelockRoles[i], timelock);
            }
        }

        // 6: transfer ERC-173 Diamond ownership (gates diamondCut +
        // LibDiamond.enforceIsContractOwner).
        ownership.transferOwnership(timelock);

        // 7: renounce every role the deployer still holds. Order matters:
        //    - Renounce the ops roles (PAUSER, KYC_ADMIN) first — if
        //      GrantOpsRoles was skipped they'd be stranded, so require
        //      at least one other holder exists before renouncing. The
        //      assertion below makes the skipped-GrantOpsRoles mistake
        //      obvious at tx-execution time rather than silently leaving
        //      a functional role unowned.
        //    - Then renounce the timelock roles in reverse. DEFAULT_ADMIN
        //      LAST so any revert above still leaves the deployer able to
        //      retry without being locked out of role management.
        for (uint256 i = 0; i < opsRoles.length; i++) {
            bytes32 role = opsRoles[i];
            if (ac.hasRole(role, deployer)) {
                require(
                    _roleHasAnotherHolder(ac, role, deployer),
                    "TransferAdminToTimelock: run GrantOpsRoles first - ops role would be stranded"
                );
                ac.renounceRole(role, deployer);
            }
        }
        for (uint256 i = timelockRoles.length; i > 0; i--) {
            bytes32 role = timelockRoles[i - 1];
            if (ac.hasRole(role, deployer)) {
                ac.renounceRole(role, deployer);
            }
        }

        vm.stopBroadcast();

        console.log("Handover complete. Diamond owner:", ownership.owner());
    }

    /// @dev Returns true iff at least one address other than `excluded`
    ///      currently holds `role`. Used to guard renouncing an ops role
    ///      when no replacement holder exists (i.e. the prior
    ///      GrantOpsRoles step was skipped). AccessControl doesn't
    ///      expose a member count, so we rely on the caller specifying
    ///      the expected replacement in an env hint.
    function _roleHasAnotherHolder(
        AccessControlFacet ac,
        bytes32 role,
        address excluded
    ) internal view returns (bool) {
        string memory guardianEnv = vm.envOr("GOVERNANCE_GUARDIAN", string(""));
        string memory kycOpsEnv = vm.envOr("GOVERNANCE_KYC_OPS", guardianEnv);
        address guardian = _parseAddressOrZero(guardianEnv);
        address kycOps = _parseAddressOrZero(kycOpsEnv);
        if (guardian != address(0) && guardian != excluded && ac.hasRole(role, guardian)) {
            return true;
        }
        if (kycOps != address(0) && kycOps != excluded && ac.hasRole(role, kycOps)) {
            return true;
        }
        return false;
    }

    function _parseAddressOrZero(string memory s) internal pure returns (address) {
        if (bytes(s).length == 0) return address(0);
        return vm.parseAddress(s);
    }
}
