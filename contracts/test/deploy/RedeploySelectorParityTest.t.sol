// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {FacetSelectors} from "../../script/lib/FacetSelectors.sol";

/**
 * @title  RedeploySelectorParityTest
 * @notice Findings #778 / #779 guardrail. The curated upgrade scripts
 *         (`ReplaceStaleFacets`, `RedeployFacets`, `UpgradeOracleFacet`) now
 *         source their per-facet selector sets from the single
 *         {FacetSelectors} library instead of drift-prone local hand-lists. A
 *         `Replace` diamondCut must carry a facet's WHOLE routed surface — a
 *         partial subset leaves the unlisted selectors pointed at stale
 *         bytecode, splitting the Diamond.
 *
 * @dev    This test pins {FacetSelectors} to ground truth: for each covered
 *         facet it reads the compiled ABI's `methodIdentifiers` (the exact
 *         external/public selector set the compiler emitted) and asserts the
 *         library returns that set EXACTLY — same size, no missing, no extra.
 *         So a facet that grows or loses an external function fails CI here
 *         until the one shared list is updated. Same ABI-reading mechanism as
 *         `SelectorCoverageTest`.
 *
 *         When {FacetSelectors} gains another facet, add a matching case here.
 */
contract RedeploySelectorParityTest is Test {
    function test_OracleSelectors_MatchCompiledAbi() public view {
        _assertParity("OracleFacet", FacetSelectors.oracle());
    }

    function test_VaultFactorySelectors_MatchCompiledAbi() public view {
        _assertParity("VaultFactoryFacet", FacetSelectors.vaultFactory());
    }

    function test_ProfileSelectors_MatchCompiledAbi() public view {
        _assertParity("ProfileFacet", FacetSelectors.profile());
    }

    /// @dev #1123 wires the fail-closed movement gate INLINE into
    ///      `transferFrom`/`safeTransferFrom`, so the curated redeploy re-cuts
    ///      this facet from `FacetSelectors.vaipakamNFT()`. Pin that list to the
    ///      facet's ROUTED surface so a future NFT selector change can't silently
    ///      leave it incomplete and reintroduce the stale-bytecode split.
    ///
    ///      `supportsInterface(bytes4)` is compiled into this facet's ABI but is
    ///      deliberately NOT cut to it — `DiamondLoupeFacet` owns that selector
    ///      (see `DeployDiamond._getNFTSelectors`). So the routed surface is the
    ///      compiled ABI MINUS that one loupe-owned selector; assert against that.
    function test_VaipakamNFTSelectors_MatchRoutedSurface() public view {
        bytes4 loupeOwned = bytes4(keccak256("supportsInterface(bytes4)"));
        _assertParityExcept("VaipakamNFTFacet", FacetSelectors.vaipakamNFT(), loupeOwned);
    }

    /// @dev #1221 — the keeper action bitmask widened uint8→uint16, changing the
    ///      selectors of `approveKeeper`/`setKeeperActions`. `RedeployFacets`
    ///      Removes the OLD uint8 selectors from a pre-widen diamond. Pin the
    ///      widen's completeness: the legacy uint8 selectors must be GONE from
    ///      the facet's compiled surface (so the Remove targets genuinely-retired
    ///      entries, and no dual entry point survives a fresh deploy) while the
    ///      new uint16 selectors are present. If a future change reintroduced a
    ///      uint8 keeper signature, this fails before it could re-split routing.
    function test_LegacyKeeperUint8Selectors_Retired() public view {
        bytes4[] memory abiSels = _abiSelectorsExcept("ProfileFacet", bytes4(0));

        bytes4 oldApprove = bytes4(keccak256("approveKeeper(address,uint8)"));
        bytes4 oldSet = bytes4(keccak256("setKeeperActions(address,uint8)"));
        assertFalse(
            _contains(abiSels, oldApprove),
            "legacy approveKeeper(address,uint8) still on ProfileFacet - widen incomplete"
        );
        assertFalse(
            _contains(abiSels, oldSet),
            "legacy setKeeperActions(address,uint8) still on ProfileFacet - widen incomplete"
        );

        bytes4 newApprove = bytes4(keccak256("approveKeeper(address,uint16)"));
        bytes4 newSet = bytes4(keccak256("setKeeperActions(address,uint16)"));
        assertTrue(
            _contains(abiSels, newApprove),
            "widened approveKeeper(address,uint16) missing from ProfileFacet"
        );
        assertTrue(
            _contains(abiSels, newSet),
            "widened setKeeperActions(address,uint16) missing from ProfileFacet"
        );
    }

    /// @dev Assert `libSelectors` equals the facet's compiled-ABI selector set.
    function _assertParity(string memory facet, bytes4[] memory libSelectors)
        private
        view
    {
        _assertParityExcept(facet, libSelectors, bytes4(0));
    }

    /// @dev Same as {_assertParity} but drops `excluded` from the compiled-ABI
    ///      set first — for a facet that exposes a selector routed to ANOTHER
    ///      facet in the Diamond (so its routed surface is the ABI minus that
    ///      selector). `bytes4(0)` excludes nothing.
    function _assertParityExcept(
        string memory facet,
        bytes4[] memory libSelectors,
        bytes4 excluded
    ) private view {
        bytes4[] memory abiSelectors = _abiSelectorsExcept(facet, excluded);

        assertEq(
            libSelectors.length,
            abiSelectors.length,
            string.concat(
                "FacetSelectors.",
                facet,
                " count != compiled ABI methodIdentifiers count"
            )
        );

        // Every compiled-ABI selector must be present in the library list.
        for (uint256 i; i < abiSelectors.length; ++i) {
            assertTrue(
                _contains(libSelectors, abiSelectors[i]),
                string.concat(
                    "FacetSelectors.",
                    facet,
                    " is MISSING a compiled selector -> a Replace cut would ",
                    "leave it on stale bytecode; add it to script/lib/FacetSelectors.sol"
                )
            );
        }
        // ...and every library selector must exist on the facet (no phantom).
        for (uint256 i; i < libSelectors.length; ++i) {
            assertTrue(
                _contains(abiSelectors, libSelectors[i]),
                string.concat(
                    "FacetSelectors.",
                    facet,
                    " lists a selector the facet no longer exposes; remove it"
                )
            );
        }
    }

    /// @dev The facet's authoritative selectors from its compiled artifact,
    ///      minus `excluded` (pass `bytes4(0)` to exclude nothing).
    function _abiSelectorsExcept(string memory facet, bytes4 excluded)
        private
        view
        returns (bytes4[] memory sels)
    {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(
            string.concat("out/", facet, ".sol/", facet, ".json")
        );
        string[] memory sigs = vm.parseJsonKeys(json, ".methodIdentifiers");
        uint256 n;
        bytes4[] memory buf = new bytes4[](sigs.length);
        for (uint256 i; i < sigs.length; ++i) {
            bytes4 sel = bytes4(keccak256(bytes(sigs[i])));
            if (sel == excluded) continue;
            buf[n++] = sel;
        }
        sels = new bytes4[](n);
        for (uint256 i; i < n; ++i) {
            sels[i] = buf[i];
        }
    }

    function _contains(bytes4[] memory set, bytes4 needle)
        private
        pure
        returns (bool)
    {
        for (uint256 i; i < set.length; ++i) {
            if (set[i] == needle) return true;
        }
        return false;
    }
}
