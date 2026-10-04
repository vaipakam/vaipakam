// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DiamondFacetNames} from "./DiamondFacetNames.sol";

/**
 * @title  ExportedFacetParityTest
 * @notice #2394 guardrail. Asserts that the facets whose ABIs make up the
 *         combined Diamond ABI (`packages/contracts/scripts/diamond-facets.json`
 *         `facets`) are EXACTLY the Diamond's facets: every facet in
 *         {DiamondFacetNames.cutFacetNames} plus `DiamondCutFacet`, which the
 *         `VaipakamDiamond` constructor installs outside `cuts[]`.
 *
 * @dev    Why exact, not curated (owner decision 2026-10-04). The export list
 *         used to leave "internal" facets out on purpose. A facet carries its
 *         EVENTS and ERRORS as well as its functions, and leaving one out
 *         dropped those from the union: RewardSweepWalkFacet's reward-expiry
 *         events, which the indexer derives its event ABI from the union to
 *         decode, ReceiverFacet's `UnexpectedNFTReceipt` revert, and the
 *         role/ownership events. Listing an internal function in an ABI
 *         authorizes nothing, so the exclusion list bought nothing and is
 *         gone — which is also why this test needs no exemption list.
 *
 *         Why the manifest and not `FACETS=(...)`. The export's own checks
 *         already hold the shell array, the ABI files on disk and the
 *         manifest together (`build-diamond-abi.mjs` `classificationProblems`
 *         fails on an ABI file in neither list or a listed name with no
 *         file). The one link nothing held was manifest ↔ Diamond, because
 *         the Diamond's facet set lives in Solidity. Reading the manifest
 *         JSON here keeps the check where both lists are visible without
 *         parsing any source as text.
 */
contract ExportedFacetParityTest is Test, DiamondFacetNames {
    string internal constant MANIFEST = "../packages/contracts/scripts/diamond-facets.json";

    function _diamondFacets() internal pure returns (string[] memory all) {
        string[87] memory cut = cutFacetNames();
        all = new string[](cut.length + 1);
        for (uint256 i = 0; i < cut.length; i++) all[i] = cut[i];
        all[cut.length] = "DiamondCutFacet";
    }

    function _contains(string[] memory list, string memory name) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(name));
        for (uint256 i = 0; i < list.length; i++) {
            if (keccak256(bytes(list[i])) == h) return true;
        }
        return false;
    }

    function _exported() internal view returns (string[] memory) {
        return vm.parseJsonStringArray(vm.readFile(MANIFEST), ".facets");
    }

    /// Every Diamond facet is exported — the omission this file exists for.
    function test_EveryDiamondFacetIsExported() public view {
        string[] memory exported = _exported();
        string[] memory facets = _diamondFacets();
        for (uint256 i = 0; i < facets.length; i++) {
            assertTrue(
                _contains(exported, facets[i]),
                string.concat(
                    facets[i],
                    " is cut into the Diamond but missing from diamond-facets.json `facets` ",
                    "(and so from FACETS in exportFrontendAbis.sh and the combined Diamond ABI)"
                )
            );
        }
    }

    /// Nothing exported as a facet is absent from the Diamond: a standalone
    /// contract belongs under `standalone`, and a removed facet must leave.
    function test_EveryExportedFacetIsADiamondFacet() public view {
        string[] memory exported = _exported();
        string[] memory facets = _diamondFacets();
        for (uint256 i = 0; i < exported.length; i++) {
            assertTrue(
                _contains(facets, exported[i]),
                string.concat(
                    exported[i],
                    " is listed as a Diamond facet in diamond-facets.json but is not cut into the Diamond"
                )
            );
        }
    }

    /// Same size as well as mutual containment, so a duplicate entry cannot
    /// hide a missing one.
    function test_ExportedFacetCountMatchesDiamond() public view {
        assertEq(_exported().length, _diamondFacets().length, "diamond-facets.json `facets` count");
    }
}
