// src/VaipakamDiamond.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
 // For ownership
import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";
import {LibPausable} from "./libraries/LibPausable.sol";

/**
 * @title VaipakamDiamond
 * @author Vaipakam Developer Team
 * @notice This is the central proxy contract for the Vaipakam platform using the Diamond Standard (EIP-2535).
 * @dev Acts as the entry point for all calls, delegating to facets based on function selectors.
 *      Supports modular upgrades via diamondCut.
 *      Constructor initializes ownership and adds the DiamondCutFacet.
 *      Fallback handles delegation to facets; reverts if function not found.
 *      Receive allows ETH reception.
 *      No additional storage or logic; all in libraries/facets.
 *      Custom errors via LibDiamond.
 *      Deploy with owner (deployer/multi-sig) and DiamondCutFacet address.
 */
contract VaipakamDiamond {
    error FunctionDoesNotExist();

    /**
     * @notice Constructs the VaipakamDiamond proxy.
     * @dev Sets the contract owner and initializes with an empty cut (facets added post-deployment).
     *      Requires the DiamondCutFacet to be pre-deployed.
     * @param contractOwner The initial owner address (e.g., deployer or multi-sig).
     * @param diamondCutFacet The address of the deployed DiamondCutFacet.
     */

    constructor(address contractOwner, address diamondCutFacet) {
        LibDiamond.setContractOwner(contractOwner);

        // Add DiamondCutFacet via initial cut (empty facets array)
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](0);
        LibDiamond.diamondCut(cut, address(0), "");
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        ds
            .selectorToFacetAndPosition[IDiamondCut.diamondCut.selector]
            .facetAddress = diamondCutFacet;

        // Born paused. The half-cut window between `diamondCut 1/2` and
        // `diamondCut 2/2` leaves half-2 selectors unmapped — today
        // calls to those selectors clean-revert via {FunctionDoesNotExist},
        // but a future fallback that swallowed revert reasons would
        // turn that into a foot-gun. Defence in depth: protocol stays
        // frozen until the deploy script's final {AdminFacet.unpause}
        // call lands after every facet is cut, every Step-5 init has
        // run, and the post-cut facet-count assertion has passed. The
        // deploy script holds {PAUSER_ROLE} from
        // {AccessControlFacet.initializeAccessControl}, so it can flip
        // the bit back without an extra grant. See deploy-chain.sh
        // step `[5d]` health check — `paused()` must be `false` at the
        // end of a healthy deploy.
        LibPausable.pause();
    }

    /**
     * @dev Fallback function to delegate calls to the appropriate facet.
     *      Looks up the facet for msg.sig and delegates if found.
     *      Reverts if no facet supports the selector.
     */
    fallback() external payable {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        address facet = ds.selectorToFacetAndPosition[msg.sig].facetAddress;
        // console.log("msg.sig: ");
        // console.logBytes4(msg.sig);
        if (facet == address(0)) {
            revert FunctionDoesNotExist();
        }
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }

    /**
     * @dev Receive function to accept ETH transfers.
     */
    receive() external payable {}
}
