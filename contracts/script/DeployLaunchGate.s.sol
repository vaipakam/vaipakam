// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {LaunchGate} from "../src/governance/LaunchGate.sol";
import {LaunchGateDeployment} from "./lib/LaunchGateDeployment.sol";

/**
 * @title DeployLaunchGate
 * @notice Deploys {LaunchGate} at its deterministic address, or confirms it
 *         is already there (#945).
 *
 * @dev The gate is stateless and ownerless, so deploying it grants nothing
 *      to anyone; any key may send it and a second run is a no-op. The
 *      contracts phase of `deploy-{mainnet,testnet}.sh` runs this right
 *      after the Timelock, so the launch phase — which on a production
 *      chain broadcasts nothing — finds the gate its proposal calls.
 *
 *      Run:
 *        forge script script/DeployLaunchGate.s.sol --rpc-url $RPC --broadcast
 *
 * @dev Env: DEPLOYER_PRIVATE_KEY — the key that sends the deployment.
 */
contract DeployLaunchGate is Script {
    function run() external returns (address) {
        return deploy(vm.envUint("DEPLOYER_PRIVATE_KEY"));
    }

    /// @notice Deploys the gate from `deployerKey` unless it is already at
    ///         its address. Returns that address.
    function deploy(uint256 deployerKey) public returns (address gate) {
        gate = LaunchGateDeployment.predicted();
        if (gate.code.length != 0) {
            console.log("LaunchGate already deployed at", gate);
            return gate;
        }
        require(
            LaunchGateDeployment.CREATE2_FACTORY.code.length != 0,
            "DeployLaunchGate: the deterministic-deployment proxy is not on this chain"
        );
        vm.broadcast(deployerKey);
        (bool ok,) = LaunchGateDeployment.CREATE2_FACTORY.call(
            abi.encodePacked(LaunchGateDeployment.SALT, type(LaunchGate).creationCode)
        );
        require(
            ok && gate.code.length != 0, "DeployLaunchGate: the CREATE2 deployment did not land at the predicted address"
        );
        console.log("LaunchGate deployed at", gate);
    }
}
