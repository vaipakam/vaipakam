// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ArtifactDeploy} from "../../script/lib/ArtifactDeploy.sol";
import {VaipakamVaultImplementation} from "../../src/VaipakamVaultImplementation.sol";
import {VaultBeacon} from "../../src/VaultBeacon.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {LibTestPositionNFT} from "./LibTestPositionNFT.sol";
import {VaultOutflowTypes} from "../../src/vault/VaultOutflowTypes.sol";
import {VaultProtection} from "../../src/vault/VaultProtection.sol";
import {Vm} from "forge-std/Vm.sol";

/// @dev The Diamond reads the test-side endpoint sync makes (each optional:
///      a hand-built suite Diamond may route none of them).
interface IEndpointReads {
    function getTreasury() external view returns (address);
    function getBackstopVault() external view returns (address);
    function getFusionLimitOrderProtocol() external view returns (address);
    function getCollateralListingExecutor() external view returns (address);
}

interface IExecutorSeaport {
    function seaport() external view returns (address);
}
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
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev #3205 part 2 / #3431 — the vault code fixes the PositionNFT core
    ///      and its endpoints as immutables, so both exist before it: the core
    ///      is installed here (idempotently) and the endpoints start as the
    ///      test convention (the Diamond its own treasury, nothing else set).
    ///      A suite that configures more calls {sync} (live Diamond reads) or
    ///      {setEndpoints} afterwards. #3272 part 2 — the Diamond records a
    ///      protocol registry and prices through the guard it names
    ///      ({LibTestPriceGuard}); the vault code fixes the same guard.
    function install(address diamond, address owner) internal returns (VaultBeacon beacon) {
        address nft = address(LibTestPositionNFT.install(diamond, owner));
        MockProtocolRegistry registry = new MockProtocolRegistry(diamond);
        LibTestPriceGuard.install(diamond, owner, registry);
        VaultOutflowTypes.VaultEndpoints memory e;
        e.treasury = diamond;
        e.priceGuard = LibTestPriceGuard.guardOf(diamond);
        e.protection = ArtifactDeploy.deploy(type(VaultProtection).name);
        address impl = ArtifactDeploy.deploy(type(VaipakamVaultImplementation).name, abi.encode(nft, e));
        beacon = VaultBeacon(
            ArtifactDeploy.deploy(type(VaultBeacon).name, abi.encode(owner, diamond, owner, impl))
        );
        VaultFactoryFacet(diamond).initializeVaultBeacon(address(beacon));
        installOutflowPolicy(diamond);
    }

    /// @notice The endpoints the vault code of `diamond`'s current beacon fixes.
    function endpointsOf(address diamond) internal view returns (VaultOutflowTypes.VaultEndpoints memory) {
        return VaipakamVaultImplementation(_impl(diamond)).vaultEndpoints();
    }

    /// @notice TEST CONVENIENCE — replace the endpoints the current vault code
    ///         fixes, in place: a fresh implementation is built with `e` and
    ///         its code is etched over the current implementation's address,
    ///         so every vault (a BeaconProxy) runs it at once. On a chain the
    ///         same change is new vault code through the beacon's delay.
    function setEndpoints(address diamond, VaultOutflowTypes.VaultEndpoints memory e) internal {
        address impl = _impl(diamond);
        address fresh = ArtifactDeploy.deploy(
            type(VaipakamVaultImplementation).name,
            abi.encode(VaipakamVaultImplementation(impl).POSITION_NFT(), e)
        );
        vm.etch(impl, fresh.code);
    }

    /// @notice TEST CONVENIENCE — bring the vault code's treasury, backstop,
    ///         1inch order protocol and Seaport to what `diamond` is
    ///         configured with now (each read only where the Diamond routes
    ///         it); the conduit, its key and the price guard are kept.
    function sync(address diamond) internal {
        VaultOutflowTypes.VaultEndpoints memory e = endpointsOf(diamond);
        try IEndpointReads(diamond).getTreasury() returns (address t) {
            e.treasury = t;
        } catch {}
        try IEndpointReads(diamond).getBackstopVault() returns (address b) {
            e.backstop = b;
        } catch {}
        try IEndpointReads(diamond).getFusionLimitOrderProtocol() returns (address lop) {
            if (lop != address(0)) e.orderProtocol = lop;
        } catch {}
        try IEndpointReads(diamond).getCollateralListingExecutor() returns (address x) {
            if (x != address(0)) {
                try IExecutorSeaport(x).seaport() returns (address sp) {
                    e.seaport = sp;
                } catch {}
            }
        } catch {}
        setEndpoints(diamond, e);
    }

    /// @notice TEST CONVENIENCE — set the vault code's listing conduit and key.
    function setConduit(address diamond, address conduit, bytes32 conduitKey) internal {
        VaultOutflowTypes.VaultEndpoints memory e = endpointsOf(diamond);
        e.conduit = conduit;
        e.conduitKey = conduitKey;
        setEndpoints(diamond, e);
    }

    function _impl(address diamond) private view returns (address) {
        return VaultBeacon(VaultFactoryFacet(diamond).getVaultBeacon()).implementation();
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

}
