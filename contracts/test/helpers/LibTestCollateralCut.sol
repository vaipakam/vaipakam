// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {CollateralConcentrationFacet} from "../../src/facets/CollateralConcentrationFacet.sol";
import {CollateralLienFacet} from "../../src/facets/CollateralLienFacet.sol";
import {ArtifactDeploy} from "../../script/lib/ArtifactDeploy.sol";

/**
 * @title LibTestCollateralCut
 * @notice #3685 — two hosts every hand-built test Diamond that opens or
 *         changes a loan needs:
 *         - `CollateralConcentrationFacet`: loan creation, the match and
 *           accept previews and the offer book read the new-loan init-LTV
 *           cap from it by self-call;
 *         - `CollateralLienFacet`: every collateral lien change (release,
 *           decrement, increment, re-create) runs there by self-call, split
 *           off `EncumbranceMutateFacet`.
 *         A Diamond that cuts a caller without them reverts
 *         `FunctionDoesNotExist` at that self-call.
 */
library LibTestCollateralCut {
    function concentrationSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](7);
        s[0] = CollateralConcentrationFacet.setConcentrationConfig.selector;
        s[1] = CollateralConcentrationFacet.setAssetConcentrationConfig.selector;
        s[2] = CollateralConcentrationFacet.getConcentrationConfig.selector;
        s[3] = CollateralConcentrationFacet.getAssetConcentrationThresholds.selector;
        s[4] = CollateralConcentrationFacet.getConcentration.selector;
        s[5] = CollateralConcentrationFacet.newLoanInitLtvCapBps.selector;
        s[6] = CollateralConcentrationFacet.loanConcentrationAtInit.selector;
    }

    function lienSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = CollateralLienFacet.releaseCollateralLien.selector;
        s[1] = CollateralLienFacet.decrementCollateralLien.selector;
        s[2] = CollateralLienFacet.incrementCollateralLien.selector;
        s[3] = CollateralLienFacet.recreateCollateralLien.selector;
    }

    /// @notice `cuts` with both collateral hosts appended.
    function withCollateralHosts(IDiamondCut.FacetCut[] memory cuts)
        internal
        returns (IDiamondCut.FacetCut[] memory out)
    {
        out = new IDiamondCut.FacetCut[](cuts.length + 2);
        for (uint256 i; i < cuts.length; ++i) out[i] = cuts[i];
        out[cuts.length] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(CollateralConcentrationFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: concentrationSelectors()
        });
        out[cuts.length + 1] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(CollateralLienFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: lienSelectors()
        });
    }
}
