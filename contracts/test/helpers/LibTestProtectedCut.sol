// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {ProtectedAccountFacet} from "../../src/facets/ProtectedAccountFacet.sol";
import {ArtifactDeploy} from "../../script/lib/ArtifactDeploy.sol";

/**
 * @title  LibTestProtectedCut
 * @notice #3379 B2 — every owner action, offer and payout reads protected
 *         mode through small hosts on `ProtectedAccountFacet` (self-calls that
 *         keep the vault reads out of each caller's bytecode), so a test
 *         Diamond built from a hand-picked facet list must cut that facet too
 *         or those paths revert `FunctionDoesNotExist`. This is the one test
 *         copy of its selector list (HelperTest reads it) and the one way a
 *         hand-built Diamond adds it.
 */
library LibTestProtectedCut {
    function selectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](14);
        s[0] = ProtectedAccountFacet.applyProtection.selector;
        s[1] = ProtectedAccountFacet.cancelSettingChange.selector;
        s[2] = ProtectedAccountFacet.finalizeSettingChanges.selector;
        s[3] = ProtectedAccountFacet.getProtection.selector;
        s[4] = ProtectedAccountFacet.getProtectedDelayBounds.selector;
        s[5] = ProtectedAccountFacet.getRetiredAccountsOf.selector;
        s[6] = ProtectedAccountFacet.isListingLegAllowed.selector;
        s[7] = ProtectedAccountFacet.lockPositionNfts.selector;
        s[8] = ProtectedAccountFacet.lockVaultFor.selector;
        s[9] = ProtectedAccountFacet.setRequireCosign.selector;
        s[10] = ProtectedAccountFacet.isProtectionOn.selector;
        s[11] = ProtectedAccountFacet.protectionManagerOf.selector;
        s[12] = ProtectedAccountFacet.requireCanOpenFor.selector;
        s[13] = ProtectedAccountFacet.protectsNftsOf.selector;
    }

    /// @dev The facet's Add cut, deployed from its artifact.
    function cut() internal returns (IDiamondCut.FacetCut memory) {
        return IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(ProtectedAccountFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors()
        });
    }

    /// @dev `cuts` with the facet appended.
    function withProtected(IDiamondCut.FacetCut[] memory cuts) internal returns (IDiamondCut.FacetCut[] memory out) {
        out = new IDiamondCut.FacetCut[](cuts.length + 1);
        for (uint256 i; i < cuts.length; ++i) out[i] = cuts[i];
        out[cuts.length] = cut();
    }
}
