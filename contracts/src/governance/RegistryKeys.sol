// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  RegistryKeys
 * @author Vaipakam Developer Team
 * @notice The keys of the protocol registry. Append-only; each key names one
 *         pointer or one set, never both.
 */
library RegistryKeys {
    bytes32 internal constant PRICE_GUARD = keccak256("vaipakam.registry.priceGuard");
    /// @notice Pointer: the treasury a vault may pay (#3205 part 2).
    bytes32 internal constant TREASURY = keccak256("vaipakam.registry.treasury");
    /// @notice Pointer: the backstop a vault may pay (#3205 part 2).
    bytes32 internal constant BACKSTOP = keccak256("vaipakam.registry.backstop");
    /// @notice Set: the swap adapters and order protocols a vault may pay or approve (#3205 part 2).
    bytes32 internal constant SWAP_ADAPTERS = keccak256("vaipakam.registry.swapAdapters");
    /// @notice Set: the marketplace conduits a vault may approve (#3205 part 2).
    bytes32 internal constant CONDUITS = keccak256("vaipakam.registry.conduits");
}
