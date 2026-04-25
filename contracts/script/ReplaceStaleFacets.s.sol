// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title ReplaceStaleFacets
 * @notice Redeploys OfferFacet, OracleFacet and EscrowFactoryFacet and Replaces
 *         every selector they own. Targets the createOffer failure surfacing
 *         `CrossFacetCallFailed(string)` (0x573c3147) on Sepolia — that legacy
 *         error is only reachable through the non-typed `LibRevert.bubbleOnFailure`
 *         path, which current source no longer uses. Replacing these three
 *         facets with freshly-compiled bytecode removes any pre-refactor copy
 *         left on chain.
 *
 * Env vars: PRIVATE_KEY, DIAMOND_ADDRESS
 *
 * Usage:
 *   forge script script/ReplaceStaleFacets.s.sol \
 *     --rpc-url $SEPOLIA_RPC_URL --broadcast -vvv
 */
contract ReplaceStaleFacets is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        // Same env-var-prefix normalisation as RedeployFacets — read
        // from deployments/<chain>/addresses.json with chain-prefixed
        // env fallback rather than the bare DIAMOND_ADDRESS.
        address diamond = Deployments.readDiamond();

        console.log("Diamond:", diamond);

        vm.startBroadcast(deployerKey);

        OfferFacet offerFacet = new OfferFacet();
        OracleFacet oracleFacet = new OracleFacet();
        EscrowFactoryFacet escrowFactoryFacet = new EscrowFactoryFacet();

        console.log("OfferFacet:          ", address(offerFacet));
        console.log("OracleFacet:         ", address(oracleFacet));
        console.log("EscrowFactoryFacet:  ", address(escrowFactoryFacet));

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);
        cuts[0] = _replace(address(offerFacet), _offerSelectors());
        cuts[1] = _replace(address(oracleFacet), _oracleSelectors());
        cuts[2] = _replace(address(escrowFactoryFacet), _escrowFactorySelectors());

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        vm.stopBroadcast();

        console.log("DiamondCut applied: 3 facets replaced.");
    }

    function _replace(address facet, bytes4[] memory selectors)
        internal
        pure
        returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: selectors
        });
    }

    function _offerSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](6);
        s[0] = OfferFacet.createOffer.selector;
        s[1] = OfferFacet.acceptOffer.selector;
        s[2] = OfferFacet.cancelOffer.selector;
        s[3] = OfferFacet.getCompatibleOffers.selector;
        s[4] = OfferFacet.getUserEscrow.selector;
        s[5] = OfferFacet.getOffer.selector;
    }

    function _oracleSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = OracleFacet.checkLiquidity.selector;
        s[1] = OracleFacet.getAssetPrice.selector;
        s[2] = OracleFacet.calculateLTV.selector;
        s[3] = OracleFacet.checkLiquidityOnActiveNetwork.selector;
    }

    function _escrowFactorySelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](18);
        s[0] = EscrowFactoryFacet.initializeEscrowImplementation.selector;
        s[1] = EscrowFactoryFacet.getOrCreateUserEscrow.selector;
        s[2] = EscrowFactoryFacet.upgradeEscrowImplementation.selector;
        s[3] = EscrowFactoryFacet.escrowDepositERC20.selector;
        s[4] = EscrowFactoryFacet.escrowWithdrawERC20.selector;
        s[5] = EscrowFactoryFacet.escrowDepositERC721.selector;
        s[6] = EscrowFactoryFacet.escrowWithdrawERC721.selector;
        s[7] = EscrowFactoryFacet.escrowDepositERC1155.selector;
        s[8] = EscrowFactoryFacet.escrowWithdrawERC1155.selector;
        s[9] = EscrowFactoryFacet.escrowApproveNFT721.selector;
        s[10] = EscrowFactoryFacet.escrowSetNFTUser.selector;
        s[11] = EscrowFactoryFacet.escrowGetNFTUserOf.selector;
        s[12] = EscrowFactoryFacet.escrowGetNFTUserExpires.selector;
        s[13] = EscrowFactoryFacet.getOfferAmount.selector;
        s[14] = EscrowFactoryFacet.getVaipakamEscrowImplementationAddress.selector;
        s[15] = EscrowFactoryFacet.getDiamondAddress.selector;
        s[16] = EscrowFactoryFacet.setMandatoryEscrowUpgrade.selector;
        s[17] = EscrowFactoryFacet.upgradeUserEscrow.selector;
    }
}
