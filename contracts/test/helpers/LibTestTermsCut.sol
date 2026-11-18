// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {LegalFacet} from "../../src/facets/LegalFacet.sol";
import {ArtifactDeploy} from "../../script/lib/ArtifactDeploy.sol";

/**
 * @title LibTestTermsCut
 * @notice #3734 — the Terms host every hand-built test Diamond that opens a
 *         position needs: loan creation, both position takeovers, the offer
 *         book, Auto-lend, standing instructions and the extension ask
 *         `LegalFacet.requireCurrentTerms` by self-call, and the previews ask
 *         `termsBlocker`. A Diamond that cuts a caller without it reverts
 *         `FunctionDoesNotExist` at that self-call. With no Terms version in
 *         force (a fresh Diamond) the host checks nothing.
 */
library LibTestTermsCut {
    /// @notice LegalFacet's routed surface; mirrors
    ///         `DeployDiamond._getLegalSelectors`.
    function legalSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](18);
        s[0] = LegalFacet.acceptTerms.selector;
        s[1] = LegalFacet.announceTos.selector;
        s[2] = LegalFacet.withdrawTosAnnouncement.selector;
        s[3] = LegalFacet.requireCurrentTerms.selector;
        s[4] = LegalFacet.isTermsCurrent.selector;
        s[5] = LegalFacet.termsBlocker.selector;
        s[6] = LegalFacet.hasAcceptedCurrentTerms.selector;
        s[7] = LegalFacet.getCurrentTos.selector;
        s[8] = LegalFacet.getAnnouncedTos.selector;
        s[9] = LegalFacet.getUserTosAcceptance.selector;
        s[10] = LegalFacet.getUserTosAcceptanceOf.selector;
        s[11] = bytes4(keccak256("MIN_TOS_NOTICE()"));
        s[12] = LegalFacet.publishTos.selector;
        s[13] = LegalFacet.announceTosMinimum.selector;
        s[14] = LegalFacet.getTosVersions.selector;
        s[15] = LegalFacet.getTosVersionInForceAt.selector;
        s[16] = LegalFacet.getUserAcceptedTosVersions.selector;
        s[17] = bytes4(keccak256("MAX_TOS_WINDOW()"));
    }

    /// @notice `cuts` with the Terms host appended.
    function withTermsHost(IDiamondCut.FacetCut[] memory cuts)
        internal
        returns (IDiamondCut.FacetCut[] memory out)
    {
        out = new IDiamondCut.FacetCut[](cuts.length + 1);
        for (uint256 i; i < cuts.length; ++i) out[i] = cuts[i];
        out[cuts.length] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(LegalFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: legalSelectors()
        });
    }
}
