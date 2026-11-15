// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {ArtifactDeploy} from "../../script/lib/ArtifactDeploy.sol";
import {SettlementLegFacet} from "../../src/facets/SettlementLegFacet.sol";

/// @title  LibTestSettlementLeg
/// @notice #3669 — full repay, the in-kind default and the lender claim
///         self-call SettlementLegFacet (a leg the token refuses parks in the
///         payer's vault; the claim releases it). A suite that builds its own
///         Diamond calls {install} after its cut, so those paths are routed,
///         from one selector list (HelperTest reads it too).
library LibTestSettlementLeg {
    function install(address diamond) internal {
        bytes4[] memory sel = selectors();
        // A Diamond without the loupe cannot say; the cut then decides.
        try IDiamondLoupe(diamond).facetAddress(sel[0]) returns (address host) {
            if (host != address(0)) return;
        } catch {}
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: ArtifactDeploy.deploy(type(SettlementLegFacet).name),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        IDiamondCut(diamond).diamondCut(cut, address(0), "");
    }

    /// @dev Mirrors `DeployDiamond._getSettlementLegSelectors`.
    function selectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](7);
        s[0] = SettlementLegFacet.deliverLenderDueOrPark.selector;
        s[1] = SettlementLegFacet.moveInKindCollateralOrPark.selector;
        s[2] = SettlementLegFacet.inKindMove.selector;
        s[3] = SettlementLegFacet.releaseParkedLeg.selector;
        s[4] = SettlementLegFacet.getParkedLenderLeg.selector;
        s[5] = SettlementLegFacet.depositLenderShareOrPark.selector;
        s[6] = SettlementLegFacet.depositToStoredLender.selector;
    }
}
