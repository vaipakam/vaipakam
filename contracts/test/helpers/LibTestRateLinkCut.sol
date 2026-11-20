// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {RateLinkFacet} from "../../src/facets/RateLinkFacet.sol";
import {ArtifactDeploy} from "../../script/lib/ArtifactDeploy.sol";

/**
 * @title LibTestRateLinkCut
 * @notice #3635 A / #3713 — the rate-link host every hand-built test Diamond
 *         that posts an offer or opens a loan needs: the offer book, offer
 *         edits, Auto-lend, the match core and loan creation ask
 *         `RateLinkFacet` by self-call (the band, the link bound, the
 *         origination rate). A Diamond that cuts a caller without it reverts
 *         `FunctionDoesNotExist` at that self-call. With no rate reference
 *         registered the host checks nothing and changes no rate.
 */
library LibTestRateLinkCut {
    /// @notice RateLinkFacet's routed surface; mirrors
    ///         `DeployDiamond._getRateLinkSelectors`.
    function rateLinkSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](15);
        s[0] = RateLinkFacet.getRateReference.selector;
        s[1] = RateLinkFacet.rateLinkBound.selector;
        s[2] = RateLinkFacet.offerRateBounds.selector;
        s[3] = RateLinkFacet.rateWarnings.selector;
        s[4] = RateLinkFacet.checkRateWrite.selector;
        s[5] = RateLinkFacet.offerCheckedRate.selector;
        s[6] = RateLinkFacet.admitOfferRate.selector;
        s[7] = RateLinkFacet.originationRate.selector;
        s[8] = RateLinkFacet.loanRateWarnings.selector;
        s[9] = RateLinkFacet.requireLinkAdmissible.selector;
        s[10] = bytes4(keccak256("WARN_FAR_ABOVE()"));
        s[11] = bytes4(keccak256("WARN_FAR_BELOW()"));
        s[12] = RateLinkFacet.matchRate.selector;
        s[13] = RateLinkFacet.linkedFloor.selector;
        s[14] = RateLinkFacet.effectiveRateBounds.selector;
    }

    /// @notice `cuts` with the rate-link host appended.
    function withRateLinkHost(IDiamondCut.FacetCut[] memory cuts)
        internal
        returns (IDiamondCut.FacetCut[] memory out)
    {
        out = new IDiamondCut.FacetCut[](cuts.length + 1);
        for (uint256 i; i < cuts.length; ++i) out[i] = cuts[i];
        out[cuts.length] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(RateLinkFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: rateLinkSelectors()
        });
    }
}
