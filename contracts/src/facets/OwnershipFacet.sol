// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";
import {IERC173} from "@diamond-3/interfaces/IERC173.sol";

/**
 * @title OwnershipFacet
 * @notice ERC-173 ownership surface for the Vaipakam Diamond.
 * @dev Single-owner model (distinct from AccessControlFacet's role-based model).
 *      The owner held here is the Diamond owner recognised by LibDiamond —
 *      required for `diamondCut` and for `LibDiamond.enforceIsContractOwner`
 *      checks (e.g., OracleAdminFacet setters). Role-based permissions
 *      (ADMIN_ROLE, PAUSER_ROLE, …) are managed separately via
 *      AccessControlFacet and do not flow through this facet.
 */
contract OwnershipFacet is IERC173 {
    /**
     * @notice Transfers Diamond ownership to a new address.
     * @dev Caller must be the current Diamond owner. Emits IERC173.OwnershipTransferred
     *      via LibDiamond.setContractOwner.
     * @param _newOwner The address that will become the new Diamond owner.
     */
    function transferOwnership(address _newOwner) external override {
        LibDiamond.enforceIsContractOwner();
        LibDiamond.setContractOwner(_newOwner);
    }

    /**
     * @notice Returns the current Diamond owner.
     * @return owner_ The address currently recognised as Diamond owner.
     */
    function owner() external view override returns (address owner_) {
        owner_ = LibDiamond.contractOwner();
    }
}
