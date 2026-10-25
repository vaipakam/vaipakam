// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";

/**
 * @title  Deploy a contract from its built artifact
 * @notice The one way the deploy and refresh scripts create a facet, the
 *         Diamond, or a cross-chain implementation: a CREATE of the creation
 *         code Foundry wrote to `out/` for that contract, from the same sender
 *         and nonce a `new` would have used. Under `vm.startBroadcast` it is
 *         broadcast as an ordinary CREATE transaction with the contract's name
 *         attached, so `--verify` and the broadcast log treat it exactly as
 *         they treat a `new`.
 *
 * @dev    WHY NOT `new` (#2718). `new X()` compiles X's whole creation code
 *         into the contract that says it. `DeployDiamond` said it for every
 *         facet, so its own bytecode carried all of them, and so did every
 *         contract that constructed or inherited it: each deploy-sanity test
 *         and probe. Under viaIR solc optimizes that nested code again for
 *         each such contract, and Foundry cannot reuse the facet artifacts a
 *         previous `forge build --skip test` wrote. Measured: one deploy-sanity
 *         suite and its probe took 470 s of solc on a warm cache, two files
 *         of test code. A CREATE from the artifact embeds nothing, so a facet
 *         is code-generated once per build, wherever it is deployed from.
 *
 *         FRESHNESS IS THE IMPORT. The artifact comes from `out/`, so this is
 *         only as current as the build that wrote it. That is why the name
 *         argument must be `type(C).name` and never a string literal:
 *         `type(C).name` does not compile unless the calling file imports C,
 *         and an imported file is part of the caller's build. When C or
 *         anything C imports changes, Foundry recompiles C in that same build
 *         and rewrites its artifact before the script or test runs. A literal
 *         name would compile without the import, and a sparse build that never
 *         looked at C would then deploy whatever C's artifact last held.
 *         `type(C).name` is a compile-time string, so it costs no codegen.
 *
 *         A name two artifacts share reverts in the cheatcode instead of
 *         choosing one. No artifact any of these scripts deploys links an
 *         external library, so nothing here needs linking.
 */
library ArtifactDeploy {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice CREATE `contractName` from its artifact, with no constructor
    ///         arguments.
    /// @param  contractName `type(C).name` of the contract to deploy (see the
    ///         library note: never a literal).
    /// @return deployed The new contract's address.
    function deploy(string memory contractName) internal returns (address deployed) {
        deployed = VM.deployCode(contractName);
    }

    /// @notice CREATE `contractName` from its artifact with ABI-encoded
    ///         constructor arguments.
    /// @param  contractName `type(C).name` of the contract to deploy.
    /// @param  constructorArgs `abi.encode(...)` of the constructor's arguments.
    /// @return deployed The new contract's address.
    function deploy(string memory contractName, bytes memory constructorArgs)
        internal
        returns (address deployed)
    {
        deployed = VM.deployCode(contractName, constructorArgs);
    }
}
