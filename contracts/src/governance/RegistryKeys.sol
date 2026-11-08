// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  RegistryKeys
 * @author Vaipakam Developer Team
 * @notice The names of the entries {ProtocolRegistry} holds. A key names
 *         either a single pointer or a membership set, and no name is used
 *         for both. Adding an entry is adding a constant here, never a change to
 *         the registry's code.
 */
library RegistryKeys {
    /// @notice Pointer: the standalone price guard every price read goes
    ///         through, on the Diamond and in every vault (#3272).
    bytes32 internal constant PRICE_GUARD = keccak256("vaipakam.registry.priceGuard");

    /// @notice Pointer: the protocol treasury, the one address a vault's
    ///         treasury-class outflow may pay (#3205 part 2, §3.6). Must equal
    ///         the Diamond's treasury; the launch refuses otherwise.
    bytes32 internal constant TREASURY = keccak256("vaipakam.registry.treasury");

    /// @notice Pointer: the backstop vault's owner account, whose vault a
    ///         backstop-class outflow pays (#3205 part 2).
    bytes32 internal constant BACKSTOP = keccak256("vaipakam.registry.backstop");

    /// @notice Set: the swap adapters and order protocols (the 1inch limit
    ///         order protocol among them) a vault may pay or grant to inside a
    ///         fill (#3205 part 2, §3.5).
    bytes32 internal constant SWAP_ADAPTERS = keccak256("vaipakam.registry.swapAdapters");

    /// @notice Set: the marketplace conduits (every Seaport conduit a listing
    ///         executor uses) a vault may approve inside a fill (#3205 part 2).
    bytes32 internal constant CONDUITS = keccak256("vaipakam.registry.conduits");
}
