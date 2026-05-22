// src/libraries/LibUserVault.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {VaultFactoryFacet} from "../facets/VaultFactoryFacet.sol";

/**
 * @title  LibUserVault
 * @author Vaipakam Developer Team
 * @notice Shared per-user vault resolution helper for the offer facets.
 * @dev    `OfferFacet` was split into `OfferCreateFacet` and
 *         `OfferAcceptFacet` (Issue #67 — EIP-170 headroom). Both halves
 *         resolve a user's vault, so the cross-facet wrapper that used
 *         to be `OfferFacet.getUserVault` lives here as one shared
 *         `internal` function — a single source of truth instead of a
 *         duplicated helper.
 *
 *         The function is `internal`, so it is inlined into the calling
 *         facet: `address(this)` therefore resolves to the Diamond, and
 *         the `address(this).call(...)` routes through the Diamond
 *         fallback to {VaultFactoryFacet.getOrCreateUserVault} exactly
 *         as the original `getUserVault` did (the fallback sets
 *         `msg.sender == address(this)` for the factory method).
 */
library LibUserVault {
    /// @notice Raised when the cross-facet call to the vault factory
    ///         fails.
    error GetUserVaultFailed(string reason);

    /**
     * @notice Resolve a user's per-user vault proxy, creating it lazily.
     * @param  user  The user whose vault to resolve.
     * @return proxy The user's vault proxy address.
     */
    function getOrCreate(address user) internal returns (address proxy) {
        (bool success, bytes memory result) = address(this).call(
            abi.encodeWithSelector(
                VaultFactoryFacet.getOrCreateUserVault.selector,
                user
            )
        );
        if (!success) revert GetUserVaultFailed("Get User Vault failed");
        proxy = abi.decode(result, (address));
    }
}
