// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";

/**
 * @title  TrackedHoldingRollout
 * @notice Every in-place refresh script refuses a Diamond from before the
 *         per-token tracked vault ledger, so that ledger reaches a chain only
 *         by a fresh deploy.
 * @dev    The ledger the vault withdraw routes bound every payout by moved
 *         from a per-(user, token) ERC-20 balance to a per-(user, asset,
 *         tokenId) holding that also covers ERC-721 and ERC-1155 assets. The
 *         old balances are not migrated (prelive: every chain is deployed
 *         fresh), so refreshing code in place across the change would read
 *         every existing vault as holding nothing tracked and refuse every
 *         withdrawal from it until each user adopted their own assets back.
 *         The marker is the retired getter
 *         `getProtocolTrackedVaultBalance(address,address)`: the change removed
 *         it, so a Diamond that still routes it predates the ledger.
 */
library TrackedHoldingRollout {
    /// @dev The getter the per-token ledger retired. Spelled as a signature
    ///      because the function no longer exists to take a `.selector` from.
    bytes4 internal constant RETIRED_TRACKED_BALANCE_GETTER =
        bytes4(keccak256("getProtocolTrackedVaultBalance(address,address)"));

    /// @notice Refuse `diamond` when it predates the per-token tracked ledger.
    function assertInstalled(address diamond) internal view {
        require(
            IDiamondLoupe(diamond).facetAddress(RETIRED_TRACKED_BALANCE_GETTER) == address(0),
            "tracked vault ledger: this Diamond predates the per-token ledger - it reaches a chain only by a fresh deploy"
        );
    }
}
