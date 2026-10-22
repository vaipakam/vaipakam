// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";
import {IERC173} from "@diamond-3/interfaces/IERC173.sol";
import {LibAccessControl} from "../libraries/LibAccessControl.sol";

/**
 * @title OwnershipFacet
 * @notice ERC-173 ownership surface for the Vaipakam Diamond.
 * @dev Single-owner model (distinct from AccessControlFacet's role-based model).
 *      The owner held here is the Diamond owner recognised by LibDiamond —
 *      required for `diamondCut` and for `LibDiamond.enforceIsContractOwner`
 *      checks (e.g., OracleAdminFacet setters). Role-based permissions
 *      (ADMIN_ROLE, PAUSER_ROLE, …) are managed separately via
 *      AccessControlFacet.
 *
 *      The two authorities are kept in step (#906): the owner is always a
 *      `DEFAULT_ADMIN_ROLE` holder. {transferOwnership} only hands ownership
 *      to an address that already holds the role, and `LibAccessControl`
 *      refuses to take the role from whoever is the owner. So ownership can
 *      never move to `address(0)` or to an address governance has not
 *      already made its root admin, and moving ownership can never leave the
 *      role root behind on a different address.
 */
contract OwnershipFacet is IERC173 {
    /// @dev {transferOwnership} called with `address(0)`. Would leave
    ///      `diamondCut` and every owner-gated setter permanently
    ///      unreachable.
    error OwnershipTransferToZero();

    /// @dev {transferOwnership} called with an address that does not hold
    ///      `DEFAULT_ADMIN_ROLE`. Grant the role first (a separate,
    ///      deliberate governance action), then move ownership — the same
    ///      order `transferAdmin` and the handover scripts use.
    /// @param newOwner The rejected target.
    error NewOwnerNotRootAdmin(address newOwner);

    /**
     * @notice Transfers Diamond ownership to a new address.
     * @dev Caller must be the current Diamond owner. `_newOwner` must be
     *      non-zero and must already hold `DEFAULT_ADMIN_ROLE`, so ownership
     *      only ever moves between root admins (#906). A typo cannot land
     *      ownership on an unintended address unless the same address was
     *      first made root admin in its own transaction. Prefer
     *      `AccessControlFacet.transferAdmin` for a full handover; this
     *      function moves ownership alone and leaves the caller's roles
     *      where they are. Emits IERC173.OwnershipTransferred via
     *      LibDiamond.setContractOwner.
     * @param _newOwner The address that will become the new Diamond owner.
     */
    function transferOwnership(address _newOwner) external override {
        LibDiamond.enforceIsContractOwner();
        if (_newOwner == address(0)) revert OwnershipTransferToZero();
        if (!LibAccessControl.hasRole(LibAccessControl.DEFAULT_ADMIN_ROLE, _newOwner)) {
            revert NewOwnerNotRootAdmin(_newOwner);
        }
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
