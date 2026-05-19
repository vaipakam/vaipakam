// src/libraries/LibUserEscrow.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {EscrowFactoryFacet} from "../facets/EscrowFactoryFacet.sol";

/**
 * @title  LibUserEscrow
 * @author Vaipakam Developer Team
 * @notice Shared per-user escrow resolution helper for the offer facets.
 * @dev    `OfferFacet` was split into `OfferCreateFacet` and
 *         `OfferAcceptFacet` (Issue #67 — EIP-170 headroom). Both halves
 *         resolve a user's escrow, so the cross-facet wrapper that used
 *         to be `OfferFacet.getUserEscrow` lives here as one shared
 *         `internal` function — a single source of truth instead of a
 *         duplicated helper.
 *
 *         The function is `internal`, so it is inlined into the calling
 *         facet: `address(this)` therefore resolves to the Diamond, and
 *         the `address(this).call(...)` routes through the Diamond
 *         fallback to {EscrowFactoryFacet.getOrCreateUserEscrow} exactly
 *         as the original `getUserEscrow` did (the fallback sets
 *         `msg.sender == address(this)` for the factory method).
 */
library LibUserEscrow {
    /// @notice Raised when the cross-facet call to the escrow factory
    ///         fails.
    error GetUserEscrowFailed(string reason);

    /**
     * @notice Resolve a user's per-user escrow proxy, creating it lazily.
     * @param  user  The user whose escrow to resolve.
     * @return proxy The user's escrow proxy address.
     */
    function getOrCreate(address user) internal returns (address proxy) {
        (bool success, bytes memory result) = address(this).call(
            abi.encodeWithSelector(
                EscrowFactoryFacet.getOrCreateUserEscrow.selector,
                user
            )
        );
        if (!success) revert GetUserEscrowFailed("Get User Escrow failed");
        proxy = abi.decode(result, (address));
    }
}
