// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RewardCustodyFacet} from "../../src/facets/RewardCustodyFacet.sol";
import {RewardRemittanceFacet} from "../../src/facets/RewardRemittanceFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {LibPausable} from "../../src/libraries/LibPausable.sol";

/**
 * @title  ConfigureMeshRewardsFixture
 * @notice The two-chain Anvil fixture (`packages/anvil-harness/src/mesh.ts`),
 *         shared by the keeper's scenarios (`apps/keeper/e2e/mesh`, #2516)
 *         and the protocol's (`packages/protocol-e2e`, #848): the admin steps
 *         no operator SCRIPT performs, run on each chain once the operator
 *         scripts (`E2EOperatorScripts.s.sol`) have deployed and wired it.
 *
 * @dev    On EVERY chain of the mesh:
 *           - `ActivateRewardCustody` (direct path), as the single-chain
 *             fixture does it: pause, activate custody at the epoch the pause
 *             produced, unpause. With custody active a mirror admits each
 *             reward-budget delivery as a transport epoch, which is the
 *             state a delivery proof exists to complete.
 *         On the CANONICAL chain only:
 *           - forward funding of the live fresh row (`fundRewardPool`) from
 *             the admin's VPFI, so Base has budget to remit;
 *           - `setRewardRemittanceKeeper(remitter)`: the address the suite
 *             names (the keeper's EOA in the keeper's suite) may call
 *             `remitRewardBudget`, as the operator authorizes the keeper on
 *             a live Base (no script does this; it is an admin call).
 *
 *         Env: `ADMIN_PRIVATE_KEY`, `DIAMOND_ADDRESS`; on the canonical chain
 *         also `VPFI_TOKEN`, `REWARD_POOL_FUND_WEI`, `REWARD_REMITTANCE_KEEPER`.
 */
contract ConfigureMeshRewardsFixture is Script {
    function run() external {
        bool canonical = block.chainid == 84532;
        require(
            canonical || block.chainid == 11155111,
            "ConfigureMeshRewardsFixture: run on a mesh node presenting 84532 or 11155111"
        );
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        require(diamond.code.length != 0, "ConfigureMeshRewardsFixture: no Diamond at DIAMOND_ADDRESS");

        vm.startBroadcast(adminKey);
        (,,, uint64 epoch) = LibPausable.decodePausableSlot(vm.load(diamond, LibPausable.PAUSABLE_STORAGE_POSITION));
        AdminFacet(diamond).pause();
        RewardCustodyFacet(diamond).activateRewardCustody(epoch + 1, false);
        AdminFacet(diamond).unpause();

        if (canonical) {
            address vpfi = vm.envAddress("VPFI_TOKEN");
            uint256 fund = vm.envUint("REWARD_POOL_FUND_WEI");
            IERC20(vpfi).approve(diamond, fund);
            RewardCustodyFacet(diamond).fundRewardPool(fund);
            RewardRemittanceFacet(diamond).setRewardRemittanceKeeper(vm.envAddress("REWARD_REMITTANCE_KEEPER"));
        }
        vm.stopBroadcast();

        require(RewardCustodyFacet(diamond).rewardCustodyActivated(), "ConfigureMeshRewardsFixture: custody did not activate");
        console.log("Mesh chain configured:", block.chainid, canonical ? "(canonical)" : "(mirror)");
    }
}
