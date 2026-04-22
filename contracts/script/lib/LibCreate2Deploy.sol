// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/// @title LibCreate2Deploy
/// @notice Thin wrapper around the canonical "Arachnid" Singleton Factory
///         at 0x4e59b44847b379578588920cA78FbF26c0B4956C, which is
///         pre-deployed on every EVM chain we target (Base / Arb / Op /
///         Polygon / Ethereum and their testnets).
/// @dev Using this factory rather than Solidity's `new Foo{salt: S}(...)`
///      is what makes deployments cross-chain-deterministic. The native
///      salt form uses the SCRIPT contract's address as the CREATE2
///      deployer — and that address is nonce-dependent, so it diverges
///      across chains. The Singleton Factory's own address is identical
///      everywhere, so `CREATE2(factory, salt, initCodeHash)` yields the
///      same child address on every chain as long as the init code is
///      byte-identical.
///
///      Factory deployment info: https://github.com/Arachnid/deterministic-deployment-proxy
///      Foundry's `--create2-deployer` flag also points here.
library LibCreate2Deploy {
    /// @dev Canonical Singleton Factory address. Immutable across chains.
    address internal constant SINGLETON_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev Thrown when the singleton factory rejects the deployment
    ///      (usually because the target address already has code, i.e.
    ///      the same (salt, initCode) has already been deployed).
    error Create2DeployFailed(bytes32 salt, bytes32 initCodeHash);

    /// @dev Thrown when the caller expected a specific deployed address
    ///      but the factory returned something else — e.g. because the
    ///      init code provided did not match `expectedInitCodeHash`.
    error Create2AddressMismatch(address expected, address actual);

    /// @notice Deploy `initCode` via the Singleton Factory with `salt`.
    /// @dev Reverts {Create2DeployFailed} on any factory failure. The
    ///      factory's calldata format is `salt (32b) || initCode`, and
    ///      its return data is the 20-byte deployed address left-padded
    ///      into 32 bytes.
    function deploy(bytes32 salt, bytes memory initCode) internal returns (address deployed) {
        (bool success, bytes memory ret) = SINGLETON_FACTORY.call(
            abi.encodePacked(salt, initCode)
        );
        if (!success || ret.length < 20) {
            revert Create2DeployFailed(salt, keccak256(initCode));
        }
        // Factory returns the deployed address as the last 20 bytes.
        deployed = address(uint160(uint256(bytes32(ret))));
        if (deployed == address(0)) {
            revert Create2DeployFailed(salt, keccak256(initCode));
        }
    }

    /// @notice Deploy `initCode` and assert the resulting address equals
    ///         `expected`. Use this when the caller has pre-computed the
    ///         deterministic address and wants a loud failure if anything
    ///         — salt, init code, factory — drifted.
    function deployExpecting(
        bytes32 salt,
        bytes memory initCode,
        address expected
    ) internal returns (address deployed) {
        deployed = deploy(salt, initCode);
        if (deployed != expected) {
            revert Create2AddressMismatch(expected, deployed);
        }
    }

    /// @notice Compute the CREATE2 address for `(salt, initCodeHash)` via
    ///         the Singleton Factory. Pure, off-chain safe.
    function computeAddress(
        bytes32 salt,
        bytes32 initCodeHash
    ) internal pure returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            SINGLETON_FACTORY,
                            salt,
                            initCodeHash
                        )
                    )
                )
            )
        );
    }

    /// @notice Returns true iff the Singleton Factory is deployed on the
    ///         active chain. Call this in a script's `run()` preamble to
    ///         fail fast on chains where the factory hasn't been bootstrapped.
    function factoryIsDeployed() internal view returns (bool) {
        uint256 size;
        address factory = SINGLETON_FACTORY;
        assembly {
            size := extcodesize(factory)
        }
        return size > 0;
    }

    /// @notice Builds a protocol-scoped salt in the form
    ///         `keccak256(abi.encodePacked("Vaipakam", version, label))`.
    ///         Recommended pattern so salts are self-documenting and
    ///         rotations on redeploy (version bump) don't collide with
    ///         the previous deployment.
    function protocolSalt(
        string memory version,
        string memory label
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("Vaipakam", ":", version, ":", label));
    }
}
