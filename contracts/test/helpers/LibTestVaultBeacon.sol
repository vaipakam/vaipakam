// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ArtifactDeploy} from "../../script/lib/ArtifactDeploy.sol";
import {VaipakamVaultImplementation} from "../../src/VaipakamVaultImplementation.sol";
import {VaultBeacon} from "../../src/VaultBeacon.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {LibTestPositionNFT} from "./LibTestPositionNFT.sol";
import {MockProtocolRegistry} from "../mocks/MockProtocolRegistry.sol";

/// @title  LibTestVaultBeacon
/// @notice #3204 — the test-side counterpart of `DeployDiamond` step 5c:
///         deploys a vault implementation and a VaultBeacon with it as
///         version 1, and records the beacon on `diamond`. Replaces the
///         retired `initializeVaultImplementation()` in every suite that
///         builds its own Diamond. `owner` (the beacon's owner and guardian)
///         is usually the test contract itself.
library LibTestVaultBeacon {
    /// @dev #3205 part 2 — the vault code reads the PositionNFT core and the
    ///      protocol registry as immutables, so both exist before it: the core
    ///      is installed here (idempotently) and a {MockProtocolRegistry} is
    ///      deployed for `diamond` (it answers TREASURY with the Diamond's own
    ///      treasury; {registryOf} returns it for a test that sets more).
    function install(address diamond, address owner) internal returns (VaultBeacon beacon) {
        address nft = address(LibTestPositionNFT.install(diamond, owner));
        MockProtocolRegistry registry = new MockProtocolRegistry(diamond);
        address impl = ArtifactDeploy.deploy(
            type(VaipakamVaultImplementation).name, abi.encode(nft, address(registry))
        );
        beacon = VaultBeacon(
            ArtifactDeploy.deploy(type(VaultBeacon).name, abi.encode(owner, diamond, owner, impl))
        );
        VaultFactoryFacet(diamond).initializeVaultBeacon(address(beacon));
    }

    /// @notice The registry the vault code of `diamond`'s current beacon reads.
    function registryOf(address diamond) internal view returns (MockProtocolRegistry) {
        address impl = VaultBeacon(VaultFactoryFacet(diamond).getVaultBeacon()).implementation();
        return MockProtocolRegistry(VaipakamVaultImplementation(impl).REGISTRY());
    }
}
