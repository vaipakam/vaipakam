// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LaunchGate} from "../../src/governance/LaunchGate.sol";

/**
 * @title LaunchGateDeployment
 * @notice Where {LaunchGate} lives on every chain (#945).
 *
 * @dev The gate is deployed through the canonical deterministic-deployment
 *      proxy (the CREATE2 factory Foundry itself uses), with a fixed salt,
 *      and it takes no constructor arguments. Its address is therefore a
 *      function of its creation bytecode alone: the same on every chain, and
 *      a different address whenever the code changes. Nothing has to record
 *      it, and `Launch.s.sol` targets exactly the gate this checkout
 *      compiles, never one an artifact merely names.
 */
library LaunchGateDeployment {
    /// @notice The deterministic-deployment proxy (Arachnid), present on
    ///         every chain Vaipakam deploys to and on Anvil.
    address internal constant CREATE2_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice The salt every LaunchGate deployment uses.
    bytes32 internal constant SALT = keccak256("vaipakam.launch-gate");

    /// @notice The address this checkout's LaunchGate has (or will have).
    function predicted() internal pure returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, SALT, keccak256(type(LaunchGate).creationCode))
                    )
                )
            )
        );
    }

    /// @notice Whether this checkout's LaunchGate is deployed on this chain.
    function isDeployed() internal view returns (bool) {
        return predicted().code.length != 0;
    }
}
