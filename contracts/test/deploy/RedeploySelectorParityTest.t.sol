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

    /// @dev Assert `libSelectors` equals the facet's compiled-ABI selector set.
    function _assertParity(string memory facet, bytes4[] memory libSelectors)
        private
        view
    {
        bytes4[] memory abiSelectors = _abiSelectors(facet);

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

    /// @dev The facet's authoritative selectors from its compiled artifact.
    function _abiSelectors(string memory facet)
        private
        view
        returns (bytes4[] memory sels)
    {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(
            string.concat("out/", facet, ".sol/", facet, ".json")
        );
        string[] memory sigs = vm.parseJsonKeys(json, ".methodIdentifiers");
        sels = new bytes4[](sigs.length);
        for (uint256 i; i < sigs.length; ++i) {
            sels[i] = bytes4(keccak256(bytes(sigs[i])));
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
