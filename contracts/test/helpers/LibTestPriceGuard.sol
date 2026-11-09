// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ArtifactDeploy} from "../../script/lib/ArtifactDeploy.sol";
import {PriceGuard} from "../../src/oracle/PriceGuard.sol";
import {OracleAdminFacet} from "../../src/facets/OracleAdminFacet.sol";
import {RegistryKeys} from "../../src/governance/RegistryKeys.sol";
import {MockProtocolRegistry} from "../mocks/MockProtocolRegistry.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {Vm} from "forge-std/Vm.sol";

/// @title  LibTestPriceGuard
/// @notice #3272 part 2 — the test-side counterpart of `DeployDiamond` steps
///         5c-ii and 5c-iii: a price guard named by the Diamond's protocol
///         registry, and the registry recorded on the Diamond. Every price the
///         Diamond reads comes from this guard, so a suite that mocks a price
///         mocks it on the guard ({guardOf}), where the Diamond's status read and the
///         guard's own read both see it.
/// @dev    The guard starts with no feeds and a zero delay (chain 31337 is a
///         testnet), owned and guarded by `owner`, so a suite applies a config
///         change with a propose and an execute in the same block.
library LibTestPriceGuard {
    /// @dev The Chainlink denominators the feed registry keys prices by.
    address internal constant USD = 0x0000000000000000000000000000000000000348;
    address internal constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Deploy a guard, name it in `registry` and record `registry` on
    ///         `diamond`. Idempotent: a Diamond that already records a
    ///         registry keeps it, and its guard is returned.
    function install(address diamond, address owner, MockProtocolRegistry registry)
        internal
        returns (PriceGuard guard)
    {
        installRegistrySurface(diamond);
        address recorded = OracleAdminFacet(diamond).getProtocolRegistry();
        if (recorded != address(0)) return PriceGuard(OracleAdminFacet(diamond).getPriceGuard());
        guard = deployGuard(owner);
        registry.setPointer(RegistryKeys.PRICE_GUARD, address(guard));
        OracleAdminFacet(diamond).initializeProtocolRegistry(address(registry));
    }

    /// @notice {install} for a suite Diamond with no vault beacon: a fresh
    ///         registry for `diamond`, and a guard in identity `id`.
    function installWith(address diamond, address owner, PriceGuard.Identity memory id)
        internal
        returns (PriceGuard guard)
    {
        installRegistrySurface(diamond);
        MockProtocolRegistry registry = new MockProtocolRegistry(diamond);
        guard = deployGuard(owner, id);
        registry.setPointer(RegistryKeys.PRICE_GUARD, address(guard));
        OracleAdminFacet(diamond).initializeProtocolRegistry(address(registry));
    }

    /// @notice The retail identity, keyed by `usd` and `eth` denominators.
    function identity(address usd, address eth) internal pure returns (PriceGuard.Identity memory) {
        return PriceGuard.Identity({
            numeraireDenominator: usd,
            numeraireSymbol: bytes32("usd"),
            padDenominator: address(0),
            ethDenominator: eth
        });
    }

    /// @notice A guard in the retail USD identity, with no feeds set.
    function deployGuard(address owner) internal returns (PriceGuard) {
        return deployGuard(owner, identity(USD, ETH));
    }

    /// @notice A guard in identity `id`, with no feeds set and a zero delay.
    function deployGuard(address owner, PriceGuard.Identity memory id) internal returns (PriceGuard) {
        return PriceGuard(
            ArtifactDeploy.deploy(
                type(PriceGuard).name, abi.encode(owner, owner, id, uint64(0), new PriceGuard.Change[](0))
            )
        );
    }

    /// @notice The guard `diamond` prices through now.
    function guardOf(address diamond) internal view returns (address) {
        return OracleAdminFacet(diamond).getPriceGuard();
    }

    /// @notice Apply one config change at once (the guard's delay is zero).
    function set(address diamond, PriceGuard.Kind kind, bytes32 subject, bytes32 value) internal {
        setOn(PriceGuard(guardOf(diamond)), kind, subject, value);
    }

    /// @notice {set} on a guard no Diamond names (a guard-level suite).
    function setOn(PriceGuard g, PriceGuard.Kind kind, bytes32 subject, bytes32 value) internal {
        g.proposeChange(kind, subject, value);
        g.executeChange(kind, subject);
    }

    /// @notice {setAddress} on a guard no Diamond names.
    function setAddressOn(PriceGuard g, PriceGuard.Kind kind, address value) internal {
        _code(value);
        setOn(g, kind, bytes32(0), bytes32(uint256(uint160(value))));
    }

    /// @notice {set} for an address-valued entry with no subject. A mock
    ///         address with no code gets a one-byte body first: the guard
    ///         refuses a config address without code, and a suite's feeds are
    ///         `vm.mockCall` targets.
    function setAddress(address diamond, PriceGuard.Kind kind, address value) internal {
        _code(value);
        set(diamond, kind, bytes32(0), bytes32(uint256(uint160(value))));
    }

    /// @notice {set} for a number-valued entry with no subject.
    function setUint(address diamond, PriceGuard.Kind kind, uint256 value) internal {
        set(diamond, kind, bytes32(0), bytes32(value));
    }

    /// @notice A secondary source (Tellor, API3 or DIA).
    function setSource(address diamond, PriceGuard.Source source, address value) internal {
        _code(value);
        set(diamond, PriceGuard.Kind.SecondarySource, bytes32(uint256(source)), bytes32(uint256(uint160(value))));
    }

    /// @notice A stable reference feed for `symbol` (zero removes it).
    function setStableRef(address diamond, string memory symbol, address feed) internal {
        _code(feed);
        set(diamond, PriceGuard.Kind.StableRef, bytes32(bytes(symbol)), bytes32(uint256(uint160(feed))));
    }

    /// @notice A per-feed staleness and minimum-answer override.
    function setFeedOverride(address diamond, address feed, uint256 maxStaleness, int256 minAnswer) internal {
        bytes32 subject = bytes32(uint256(uint160(feed)));
        set(diamond, PriceGuard.Kind.FeedMaxStaleness, subject, bytes32(maxStaleness));
        set(diamond, PriceGuard.Kind.FeedMinAnswer, subject, bytes32(uint256(minAnswer)));
    }

    /// @notice A per-asset direct numeraire feed (zero removes it).
    function setAssetDirectFeed(address diamond, address asset, address feed) internal {
        _code(feed);
        set(diamond, PriceGuard.Kind.AssetDirectFeed, bytes32(uint256(uint160(asset))), bytes32(uint256(uint160(feed))));
    }

    function _code(address a) private {
        if (a != address(0) && a.code.length == 0) vm.etch(a, hex"00");
    }

    /// @notice The three registry selectors, for a hand-built suite Diamond
    ///         whose facet list does not route them (the same pattern as
    ///         `LibTestVaultBeacon.installOutflowPolicy`).
    function installRegistrySurface(address diamond) internal {
        bytes4[] memory sel = new bytes4[](3);
        sel[0] = OracleAdminFacet.initializeProtocolRegistry.selector;
        sel[1] = OracleAdminFacet.getProtocolRegistry.selector;
        sel[2] = OracleAdminFacet.getPriceGuard.selector;
        // Probe the route itself, not the loupe: a hand-built suite Diamond
        // may carry no loupe facet, and its OracleAdminFacet cut may already
        // route all three.
        try OracleAdminFacet(diamond).getProtocolRegistry() returns (address) {
            return;
        } catch {}
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(OracleAdminFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        IDiamondCut(diamond).diamondCut(cut, address(0), "");
    }
}
