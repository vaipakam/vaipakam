// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ArtifactDeploy} from "../../script/lib/ArtifactDeploy.sol";
import {VaipakamVaultImplementation} from "../../src/VaipakamVaultImplementation.sol";
import {VaultBeacon} from "../../src/VaultBeacon.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {LibTestPositionNFT} from "./LibTestPositionNFT.sol";
import {MockProtocolRegistry} from "../mocks/MockProtocolRegistry.sol";
import {LibTestPriceGuard} from "./LibTestPriceGuard.sol";
import {VaultOutflowFacet} from "../../src/facets/VaultOutflowFacet.sol";
import {VaultDepositoryFacet} from "../../src/facets/VaultDepositoryFacet.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";

/// @title  LibTestVaultBeacon
/// @notice #3204 — the test-side counterpart of `DeployDiamond` step 5c:
///         deploys a vault implementation and a VaultBeacon with it as
///         version 1, and records the beacon on `diamond`. Replaces the
///         retired `initializeVaultImplementation()` in every suite that
///         builds its own Diamond. `owner` (the beacon's owner and guardian)
///         is usually the test contract itself.
library LibTestVaultBeacon {
    /// @dev #3205 part 2 — the vault code reads the PositionNFT core and the
    ///      protocol registry as immutables, so both exist before it (and, from
    ///      #3272 part 2, the Diamond records the same registry and prices
    ///      through the guard it names; see {LibTestPriceGuard}): the core
    ///      is installed here (idempotently) and a {MockProtocolRegistry} is
    ///      deployed for `diamond` (it answers TREASURY with the Diamond's own
    ///      treasury; {registryOf} returns it for a test that sets more).
    function install(address diamond, address owner) internal returns (VaultBeacon beacon) {
        address nft = address(LibTestPositionNFT.install(diamond, owner));
        MockProtocolRegistry registry = new MockProtocolRegistry(diamond);
        // #3272 part 2 - the same registry names the price guard the Diamond
        // prices through, and the Diamond records it (one registry on chain).
        LibTestPriceGuard.install(diamond, owner, registry);
        address impl = ArtifactDeploy.deploy(
            type(VaipakamVaultImplementation).name, abi.encode(nft, address(registry))
        );
        beacon = VaultBeacon(
            ArtifactDeploy.deploy(type(VaultBeacon).name, abi.encode(owner, diamond, owner, impl))
        );
        VaultFactoryFacet(diamond).initializeVaultBeacon(address(beacon));
        installOutflowPolicy(diamond);
    }

    /// @notice #3205 part 2 — the vault moves value only at the call of the
    ///         Diamond's policy host, so a Diamond with vault code and no host
    ///         can move nothing out of any vault. A suite that builds its own
    ///         Diamond from a hand-picked facet list (CLAUDE.md: such a list
    ///         goes stale when a facet is added) gets the host here, with the
    ///         vault code, unless its list already routes it.
    function installOutflowPolicy(address diamond) internal {
        bytes4[] memory sel = outflowSelectors();
        // A Diamond without the loupe cannot say; the cut then decides (an
        // already-routed selector makes it revert, which the suite would see).
        try IDiamondLoupe(diamond).facetAddress(sel[0]) returns (address host) {
            if (host != address(0)) return;
        } catch {}
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(VaultOutflowFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        IDiamondCut(diamond).diamondCut(cut, address(0), "");
    }

    /// @notice The owner's own deposit and withdrawal route (#3205 part 2:
    ///      claims and payouts land in the payee's vault as free money, which
    ///      the payee withdraws through it), for a hand-built test Diamond
    ///      whose facet list does not route it. Call it after the suite's cut.
    function installDepository(address diamond) internal {
        bytes4[] memory sel = depositorySelectors();
        try IDiamondLoupe(diamond).facetAddress(sel[0]) returns (address host) {
            if (host != address(0)) return;
        } catch {}
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(VaultDepositoryFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        IDiamondCut(diamond).diamondCut(cut, address(0), "");
    }

    /// @notice The depository facet's whole routed surface, the one test-side
    ///      list (HelperTest's getter returns it).
    function depositorySelectors() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](17);
        selectors[0] = VaultDepositoryFacet.adoptUntracked.selector;
        selectors[1] = VaultDepositoryFacet.adoptionAckTextHash.selector;
        selectors[2] = VaultDepositoryFacet.adoptionDigest.selector;
        selectors[3] = VaultDepositoryFacet.adoptionDomainSeparator.selector;
        selectors[4] = VaultDepositoryFacet.adoptionNonce.selector;
        selectors[5] = VaultDepositoryFacet.depositToVault.selector;
        selectors[6] = VaultDepositoryFacet.disownUntracked.selector;
        selectors[7] = VaultDepositoryFacet.freeHolding.selector;
        selectors[8] = VaultDepositoryFacet.pinVaultVersion.selector;
        selectors[9] = VaultDepositoryFacet.unpinVaultVersion.selector;
        selectors[10] = VaultDepositoryFacet.untrackedHolding.selector;
        selectors[11] = VaultDepositoryFacet.vaultBannedSource.selector;
        selectors[12] = VaultDepositoryFacet.withdrawFromVault.selector;
        selectors[13] = VaultDepositoryFacet.withdrawableNow.selector;
        selectors[14] = VaultDepositoryFacet.getDepositoryHolding.selector;
        selectors[15] = VaultDepositoryFacet.getDepositoryAssets.selector;
        selectors[16] = VaultDepositoryFacet.getVaultOwner.selector;
    }

    /// @notice The policy host's whole routed surface, the one test-side
    ///         list (HelperTest's getter returns it).
    function outflowSelectors() internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](6);
        selectors[0] = VaultOutflowFacet.vaultOutflow.selector;
        selectors[1] = VaultOutflowFacet.vaultGrant.selector;
        selectors[2] = VaultOutflowFacet.vaultCloseGrant.selector;
        selectors[3] = VaultOutflowFacet.vaultOutflowToOwner.selector;
        selectors[4] = VaultOutflowFacet.vaultOutflowArgs.selector;
        selectors[5] = VaultOutflowFacet.vaultOutflowToDiamondERC20.selector;
    }

    /// @notice The registry the vault code of `diamond`'s current beacon reads.
    function registryOf(address diamond) internal view returns (MockProtocolRegistry) {
        address impl = VaultBeacon(VaultFactoryFacet(diamond).getVaultBeacon()).implementation();
        return MockProtocolRegistry(VaipakamVaultImplementation(impl).REGISTRY());
    }
}
