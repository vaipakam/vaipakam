// src/VaipakamDiamond.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
 // For ownership
import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";
import {LibPausable} from "./libraries/LibPausable.sol";
import {LibFillLock} from "./libraries/LibFillLock.sol";
import {IPostInteraction} from "@1inch/limit-order-protocol/contracts/interfaces/IPostInteraction.sol";

/**
 * @title VaipakamDiamond
 * @author Vaipakam Developer Team
 * @notice This is the central proxy contract for the Vaipakam platform using the Diamond Standard (EIP-2535).
 * @dev Acts as the entry point for all calls, delegating to facets based on function selectors.
 *      Supports modular upgrades via diamondCut.
 *      Constructor initializes ownership and adds the DiamondCutFacet.
 *      Fallback handles delegation to facets; reverts if function not found. It first enforces the
 *      fill-state lock (#1566 slice 3, {LibFillLock}): mid-fill, only self-calls and the LOP
 *      post-hook get through.
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
        // frozen through the whole deploy. The deploy itself never
        // unpauses (#945): the first unpause is the launch step
        // (`Launch.s.sol`), after every launch requirement has been read
        // off the chain, and on production it is a Timelock operation.
        // This pause is the Diamond's birth pause epoch (one transition),
        // which the launch step reads as "never unpaused".
        LibPausable.pause();
    }

    /**
     * @dev Fallback function to delegate calls to the appropriate facet.
     *      Looks up the facet for msg.sig and delegates if found.
     *      Reverts if no facet supports the selector.
     */
    fallback() external payable {
        // #1566 slice 3 -- the fill-state lock ({LibFillLock}). While a 1inch fill of a Vaipakam order
        // is between its pre-hook and its post-hook, only the Diamond's own self-calls and that
        // post-hook may enter. Every other entry -- mutators, views, multicall, whatever the selector
        // -- is refused here, before the selector lookup, so no facet has to remember to check
        // (owner decision O5 = (i), 2026-10-07). Cost: one TLOAD on every call.
        bytes32 fillLock = LibFillLock.heldBy();
        if (
            fillLock != bytes32(0) && msg.sender != address(this)
                && msg.sig != IPostInteraction.postInteraction.selector
        ) {
            revert LibFillLock.FillInProgress(fillLock);
        }
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
