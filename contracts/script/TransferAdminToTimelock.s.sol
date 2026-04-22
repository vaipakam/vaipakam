// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {IERC173} from "@diamond-3/interfaces/IERC173.sol";

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
    function _diamondAddress() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) return vm.envAddress("BASE_SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 8453) return vm.envAddress("BASE_DIAMOND_ADDRESS");
        if (chainId == 11155111) return vm.envAddress("SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 421614) return vm.envAddress("ARB_SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 11155420) return vm.envAddress("OP_SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 80002) return vm.envAddress("POLYGON_AMOY_DIAMOND_ADDRESS");
        revert(string.concat("TransferAdminToTimelock: unsupported chainId ", vm.toString(chainId)));
    }

    function _timelockAddress() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) return vm.envAddress("BASE_SEPOLIA_TIMELOCK_ADDRESS");
        if (chainId == 8453) return vm.envAddress("BASE_TIMELOCK_ADDRESS");
        if (chainId == 11155111) return vm.envAddress("SEPOLIA_TIMELOCK_ADDRESS");
        if (chainId == 421614) return vm.envAddress("ARB_SEPOLIA_TIMELOCK_ADDRESS");
        if (chainId == 11155420) return vm.envAddress("OP_SEPOLIA_TIMELOCK_ADDRESS");
        if (chainId == 80002) return vm.envAddress("POLYGON_AMOY_TIMELOCK_ADDRESS");
        revert(string.concat("TransferAdminToTimelock: unsupported chainId ", vm.toString(chainId)));
    }

    function run() external {
        string memory confirm = vm.envOr("CONFIRM_HANDOVER", string(""));
        require(
            keccak256(bytes(confirm)) == keccak256(bytes("YES")),
            "TransferAdminToTimelock: set CONFIRM_HANDOVER=YES to proceed"
        );

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address diamond = _diamondAddress();
        address timelock = _timelockAddress();

        require(timelock != address(0), "TransferAdminToTimelock: timelock is zero");
        require(timelock != deployer, "TransferAdminToTimelock: timelock == deployer");

        console.log("=== Transfer Diamond Admin to Timelock ===");
        console.log("Chain id:       ", block.chainid);
        console.log("Diamond:        ", diamond);
        console.log("Timelock:       ", timelock);
        console.log("Deployer (EOA): ", deployer);

        AccessControlFacet ac = AccessControlFacet(diamond);
        IERC173 ownership = IERC173(diamond);

        // PAUSER_ROLE and KYC_ADMIN_ROLE are NOT in this array — they stay
        // on the ops multi-sig (see natspec).
        bytes32[5] memory roles = [
            LibAccessControl.DEFAULT_ADMIN_ROLE,
            LibAccessControl.ADMIN_ROLE,
            LibAccessControl.ORACLE_ADMIN_ROLE,
            LibAccessControl.RISK_ADMIN_ROLE,
            LibAccessControl.ESCROW_ADMIN_ROLE
        ];

        vm.startBroadcast(deployerKey);

        // 1-5: grant every timelocked role to the timelock
        for (uint256 i = 0; i < roles.length; i++) {
            if (!ac.hasRole(roles[i], timelock)) {
                ac.grantRole(roles[i], timelock);
            }
        }

        // 6: transfer ERC-173 Diamond ownership (gates diamondCut + LibDiamond.enforceIsContractOwner)
        ownership.transferOwnership(timelock);

        // 7: renounce EOA roles. DEFAULT_ADMIN_ROLE last, so any revert
        //    above leaves the deployer able to retry.
        for (uint256 i = roles.length; i > 0; i--) {
            bytes32 role = roles[i - 1];
            if (ac.hasRole(role, deployer)) {
                ac.renounceRole(role, deployer);
            }
        }

        vm.stopBroadcast();

        console.log("Handover complete. Diamond owner:", ownership.owner());
    }
}
