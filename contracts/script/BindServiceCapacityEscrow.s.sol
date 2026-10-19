// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {Deployments} from "./lib/Deployments.sol";
import {ServiceCapacityFacet} from "../src/facets/ServiceCapacityFacet.sol";

/**
 * @title  BindServiceCapacityEscrow
 * @notice Bind this chain's service-capacity deposit escrow if it is not bound
 *         yet, and record the bound address in the deployment artifact as
 *         `.serviceCapacityEscrow` (#2583).
 *
 *         `bindServiceCapacityEscrow()` deploys a `RewardCustodyHolder` instance
 *         of its own, the contract that custodies operators' refundable capacity
 *         principal, and binds it ONCE. Recording it in the artifact lets
 *         monitoring and explorer tooling find it from the canonical deployments
 *         bundle, as they find `rewardCustodyHolder`.
 *
 * @dev    The recorded address is ALWAYS the one the Diamond reports
 *         (`getServiceCapacityEscrow()`), read back after any bind, never a
 *         value computed or remembered by this script. So the artifact cannot
 *         name a holder the Diamond does not use. On a chain already bound, the
 *         script sends nothing and only records; run it with `--broadcast` so
 *         the artifact write is not treated as a dry run.
 *
 *         Env: ADMIN_PRIVATE_KEY (holds ADMIN_ROLE on the Diamond; needed only
 *         when a bind is due). Usage, from contracts/ on main:
 *           forge script script/BindServiceCapacityEscrow.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
 */
contract BindServiceCapacityEscrow is Script {
    function run() external {
        address diamond = Deployments.readDiamond();
        (address escrow,,) = ServiceCapacityFacet(diamond).getServiceCapacityEscrow();
        uint256 adminKey = escrow == address(0) ? vm.envUint("ADMIN_PRIVATE_KEY") : 0;
        runWith(diamond, adminKey);
    }

    /// @notice Parameterised entry: the same body as {run}, with the Diamond and
    ///         the admin key passed in (tests drive this, not the environment).
    function runWith(address diamond, uint256 adminKey) public returns (address escrow) {
        ServiceCapacityFacet capacity = ServiceCapacityFacet(diamond);
        (escrow,,) = capacity.getServiceCapacityEscrow();
        if (escrow == address(0)) {
            require(adminKey != 0, "BindServiceCapacityEscrow: a bind is due and no admin key was given");
            vm.startBroadcast(adminKey);
            capacity.bindServiceCapacityEscrow();
            vm.stopBroadcast();
            (escrow,,) = capacity.getServiceCapacityEscrow();
            require(escrow != address(0), "BindServiceCapacityEscrow: the bind did not take");
            console.log("bound service-capacity escrow:", escrow);
        } else {
            console.log("service-capacity escrow already bound:", escrow);
        }
        if (Deployments.artifactWritesEnabled()) {
            Deployments.writeServiceCapacityEscrow(escrow);
            console.log("recorded .serviceCapacityEscrow in addresses.json; next: bash script/exportFrontendDeployments.sh");
        } else {
            console.log("dry run: addresses.json NOT written");
        }
    }
}
