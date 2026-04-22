// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;
/******************************************************************************\
* Author: Nick Mudge <nick@perfectabstractions.com> (https://twitter.com/mudgen)
* EIP-2535 Diamonds: https://eips.ethereum.org/EIPS/eip-2535
/******************************************************************************/

// import { LibDiamond } from  "../libraries/LibDiamond.sol";
// import { IDiamondLoupe } from "../interfaces/IDiamondLoupe.sol";
// import { IERC165 } from "../interfaces/IERC165.sol";

import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";
import {IERC165} from "@diamond-3/interfaces/IERC165.sol";

// The functions in DiamondLoupeFacet MUST be added to a diamond.
// The EIP-2535 Diamond standard requires these functions.

/**
 * @title DiamondLoupeFacet
 * @notice EIP-2535 introspection surface for the Vaipakam Diamond. Returns
 *         the live facet → selector mapping. Used by tools, explorers, and
 *         off-chain clients to discover which facet currently serves each
 *         function selector. Also implements ERC-165.
 * @dev All functions are read-only views. Data is derived from LibDiamond's
 *      authoritative facet table written by {DiamondCutFacet.diamondCut}.
 */
contract DiamondLoupeFacet is IDiamondLoupe, IERC165 {
    // Diamond Loupe Functions
    ////////////////////////////////////////////////////////////////////
    /// These functions are expected to be called frequently by tools.
    //
    // struct Facet {
    //     address facetAddress;
    //     bytes4[] functionSelectors;
    // }

    /// @notice Gets all facets and their selectors.
    /// @return facets_ Array of Facet structs, each pairing a facet address
    ///         with the list of selectors currently routed to it.
    function facets() external view override returns (Facet[] memory facets_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        uint256 numFacets = ds.facetAddresses.length;
        facets_ = new Facet[](numFacets);
        for (uint256 i; i < numFacets; ) {
            address facetAddress_ = ds.facetAddresses[i];
            facets_[i].facetAddress = facetAddress_;
            facets_[i].functionSelectors = ds
                .facetFunctionSelectors[facetAddress_]
                .functionSelectors;
            unchecked { ++i; }
        }
    }

    /// @notice Gets all the function selectors provided by a facet.
    /// @param _facet The facet address to query.
    /// @return facetFunctionSelectors_ Array of 4-byte selectors currently
    ///         routed to `_facet` (empty if the facet is not registered).
    function facetFunctionSelectors(
        address _facet
    ) external view override returns (bytes4[] memory facetFunctionSelectors_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetFunctionSelectors_ = ds
            .facetFunctionSelectors[_facet]
            .functionSelectors;
    }

    /// @notice Get all the facet addresses used by a diamond.
    /// @return facetAddresses_ Array of every distinct facet address
    ///         currently registered on the diamond.
    function facetAddresses()
        external
        view
        override
        returns (address[] memory facetAddresses_)
    {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetAddresses_ = ds.facetAddresses;
    }

    /// @notice Gets the facet that supports the given selector.
    /// @dev If facet is not found return address(0).
    /// @param _functionSelector The function selector.
    /// @return facetAddress_ The facet address.
    function facetAddress(
        bytes4 _functionSelector
    ) external view override returns (address facetAddress_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetAddress_ = ds
            .selectorToFacetAndPosition[_functionSelector]
            .facetAddress;
    }

    /// @notice ERC-165 interface detection.
    /// @dev Returns true for interfaces explicitly registered in LibDiamond's
    ///      `supportedInterfaces` table (set during deployment / diamondCut
    ///      init). Standard IDs (IERC165, IDiamondCut, IDiamondLoupe, IERC173,
    ///      ERC-721 family) are registered at deploy time.
    /// @param _interfaceId The 4-byte ERC-165 interface identifier.
    /// @return True iff the interface is advertised as supported.
    function supportsInterface(
        bytes4 _interfaceId
    ) external view override returns (bool) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        return ds.supportedInterfaces[_interfaceId];
    }
}
