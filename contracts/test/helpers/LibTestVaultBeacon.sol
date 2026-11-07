// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ArtifactDeploy} from "../../script/lib/ArtifactDeploy.sol";
import {VaipakamVaultImplementation} from "../../src/VaipakamVaultImplementation.sol";
import {VaultBeacon} from "../../src/VaultBeacon.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";

/// @title  LibTestVaultBeacon
/// @notice #3204 — the test-side counterpart of `DeployDiamond` step 5c:
///         deploys a vault implementation and a VaultBeacon with it as
///         version 1, and records the beacon on `diamond`. Replaces the
///         retired `initializeVaultImplementation()` in every suite that
///         builds its own Diamond. `owner` (the beacon's owner and guardian)
///         is usually the test contract itself.
library LibTestVaultBeacon {
    function install(address diamond, address owner) internal returns (VaultBeacon beacon) {
        address impl = ArtifactDeploy.deploy(type(VaipakamVaultImplementation).name);
        beacon = VaultBeacon(
            ArtifactDeploy.deploy(type(VaultBeacon).name, abi.encode(owner, diamond, owner, impl))
        );
        VaultFactoryFacet(diamond).initializeVaultBeacon(address(beacon));
    }
}
