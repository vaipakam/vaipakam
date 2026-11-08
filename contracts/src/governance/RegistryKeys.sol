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
}
