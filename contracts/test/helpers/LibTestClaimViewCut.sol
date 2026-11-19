// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {ClaimViewFacet} from "../../src/facets/ClaimViewFacet.sol";
import {ArtifactDeploy} from "../../script/lib/ArtifactDeploy.sol";

/**
 * @title LibTestClaimViewCut
 * @notice The claim reads every hand-built test Diamond that cuts ClaimFacet
 *         needs beside it: `getClaimable`, `getClaimableAmount`,
 *         `getBorrowerSurplusClaim`, `getFallbackSnapshot`, `getOwedAtDefault`
 *         and `getOwedAtInternalMatch` live on {ClaimViewFacet}, split off
 *         ClaimFacet along its read / write seam (EIP-170).
 */
library LibTestClaimViewCut {
    /// @notice ClaimViewFacet's routed surface; mirrors
    ///         `DeployDiamond._getClaimViewSelectors`.
    function selectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](6);
        s[0] = ClaimViewFacet.getClaimableAmount.selector;
        s[1] = ClaimViewFacet.getClaimable.selector;
        s[2] = ClaimViewFacet.getFallbackSnapshot.selector;
        s[3] = ClaimViewFacet.getBorrowerSurplusClaim.selector;
        s[4] = ClaimViewFacet.getOwedAtDefault.selector;
        s[5] = ClaimViewFacet.getOwedAtInternalMatch.selector;
    }

    /// @notice `cuts` with the claim reads appended.
    function withClaimView(IDiamondCut.FacetCut[] memory cuts)
        internal
        returns (IDiamondCut.FacetCut[] memory out)
    {
        out = new IDiamondCut.FacetCut[](cuts.length + 1);
        for (uint256 i; i < cuts.length; ++i) out[i] = cuts[i];
        out[cuts.length] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(ClaimViewFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors()
        });
    }
}
