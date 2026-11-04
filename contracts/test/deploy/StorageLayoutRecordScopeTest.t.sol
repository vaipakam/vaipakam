// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {StorageLayoutRecord} from "../../script/lib/StorageLayoutRecord.sol";

/// @dev Any contract with code: a proxy's implementation.
contract ScopeImpl {
    function ping() external pure returns (uint256) {
        return 1;
    }
}

/// @dev A Diamond with none of the walk's getters, so every candidate comes
///      from the artifact.
contract BareDiamond {}

/// @dev Exposes the library's internal reads to the test.
contract StorageLayoutRecordScopeHarness {
    function liveProxies(address diamond, string memory json)
        external
        view
        returns (address[] memory proxies, address[] memory impls)
    {
        return StorageLayoutRecord.liveProxies(diamond, json);
    }

    function governs(string memory source) external pure returns (bool) {
        return StorageLayoutRecord.governs(source);
    }
}

/**
 * @title StorageLayoutRecordScopeTest
 * @notice The storage-layout record governs the proxies Vaipakam deploys, not
 *         the chain's own WETH. On Arbitrum Sepolia that WETH is a
 *         TransparentUpgradeableProxy under Arbitrum's ProxyAdmin, and
 *         anchoring it refused the first in-place refresh after the
 *         2026-11-03 deploy while every Vaipakam address was unchanged.
 */
contract StorageLayoutRecordScopeTest is Test {
    StorageLayoutRecordScopeHarness internal h;
    address internal diamond;
    ScopeImpl internal impl;

    function setUp() public {
        h = new StorageLayoutRecordScopeHarness();
        diamond = address(new BareDiamond());
        impl = new ScopeImpl();
    }

    function test_governs_everySourceButTheChainsWeth() public view {
        assertFalse(h.governs(".weth"));
        assertTrue(h.governs(".rewardMessenger"));
        assertTrue(h.governs(".testnetMocks.weth"), "only the top-level key is the chain's");
        assertTrue(h.governs("getCrossChainMessenger()"));
        assertTrue(h.governs("weth"), "an artifact key always starts with a dot");
    }

    /// @dev The chain's WETH is a proxy, and it is still not governed. Our
    ///      proxy beside it, and a proxy under the same leaf name deeper in
    ///      the artifact, still are.
    function test_liveProxies_leaveOutTheChainsWethProxy() public {
        address chainWeth = address(new TransparentUpgradeableProxy(address(impl), makeAddr("arbitrumAdmin"), ""));
        address ours = address(new ERC1967Proxy(address(impl), ""));
        address nested = address(new ERC1967Proxy(address(impl), ""));

        string memory rig = vm.serializeAddress("rig", "weth", nested);
        vm.serializeAddress("art", "weth", chainWeth);
        vm.serializeAddress("art", "rewardMessenger", ours);
        string memory json = vm.serializeString("art", "testnetMocks", rig);

        (address[] memory proxies, address[] memory impls) = h.liveProxies(diamond, json);
        assertEq(proxies.length, 2, "ours and the nested one; not the chain's WETH");
        for (uint256 i; i < proxies.length; ++i) {
            assertTrue(proxies[i] != chainWeth, "the chain's WETH is not anchored");
            assertEq(impls[i], address(impl));
        }
        assertTrue(uint160(proxies[0]) < uint160(proxies[1]), "sorted by address");
        assertTrue(proxies[0] == ours || proxies[1] == ours);
        assertTrue(proxies[0] == nested || proxies[1] == nested);
    }

    /// @dev With no `.weth`, the governed set is every proxy the walk finds,
    ///      as before.
    function test_liveProxies_withoutWethKeepEveryProxy() public {
        address a = address(new ERC1967Proxy(address(impl), ""));
        address b = address(new ERC1967Proxy(address(impl), ""));
        vm.serializeAddress("plain", "ccipMessenger", a);
        string memory json = vm.serializeAddress("plain", "vpfiMirror", b);

        (address[] memory proxies,) = h.liveProxies(diamond, json);
        assertEq(proxies.length, 2);
    }
}
