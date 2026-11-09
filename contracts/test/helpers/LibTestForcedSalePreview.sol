// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {ArtifactDeploy} from "../../script/lib/ArtifactDeploy.sol";
import {ForcedSalePreviewFacet} from "../../src/facets/ForcedSalePreviewFacet.sol";
import {FacetSelectors} from "../../script/lib/FacetSelectors.sol";

/// @title  LibTestForcedSalePreview
/// @notice #3205 part 2 — the forced-sale previews moved off ForcedSaleFacet
///         onto ForcedSalePreviewFacet (the two are one refresh family). A
///         suite that builds its own Diamond and cuts ForcedSaleFacet calls
///         {install} after its cut, so the previews a keeper quotes from are
///         routed too, from one selector list.
library LibTestForcedSalePreview {
    function install(address diamond) internal {
        bytes4[] memory sel = selectors();
        // A Diamond without the loupe cannot say; the cut then decides.
        try IDiamondLoupe(diamond).facetAddress(sel[0]) returns (address host) {
            if (host != address(0)) return;
        } catch {}
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(ForcedSalePreviewFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        IDiamondCut(diamond).diamondCut(cut, address(0), "");
    }

    function selectors() internal pure returns (bytes4[] memory) {
        return FacetSelectors.forcedSalePreview();
    }
}
