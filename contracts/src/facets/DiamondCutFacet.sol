// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

/******************************************************************************\
* Author: Nick Mudge <nick@perfectabstractions.com> (https://twitter.com/mudgen)
* EIP-2535 Diamonds: https://eips.ethereum.org/EIPS/eip-2535
/******************************************************************************/

import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";

// Remember to add the loupe functions from DiamondLoupeFacet to the diamond.
// The loupe functions are required by the EIP2535 Diamonds standard

/**
 * @title DiamondCutFacet
 * @notice EIP-2535 cut facet: the sole entry point for adding, replacing, or
 *         removing facet function selectors on the Vaipakam Diamond.
 * @dev Owner-only (LibDiamond.enforceIsContractOwner). Intentionally NOT
 *      pause-gated — cut is the recovery lever during incidents and must
 *      remain callable while the diamond is paused.
 */
contract DiamondCutFacet is IDiamondCut {
    /// @notice Add/replace/remove any number of functions and optionally execute
    ///         a function with delegatecall.
    /// @dev Caller must be the Diamond owner. After the selector table is
    ///      updated, `_calldata` is `delegatecall`ed on `_init` (use for
    ///      initializer functions on freshly-cut facets); pass `address(0)`
    ///      and empty calldata to skip the init step.
    /// @param _diamondCut Array of FacetCut operations (add/replace/remove)
    ///        with facet address and function selectors.
    /// @param _init Address of the contract/facet to delegatecall for init
    ///        (or `address(0)` for no init).
    /// @param _calldata Encoded init call, passed to `_init` via delegatecall.
    function diamondCut(
        FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    ) external override {
        LibDiamond.enforceIsContractOwner();
        LibDiamond.diamondCut(_diamondCut, _init, _calldata);
    }
}
