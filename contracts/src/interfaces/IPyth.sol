// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IPyth
 * @notice Narrow slice of the Pyth Network oracle interface — only the
 *         functions Vaipakam needs as a secondary oracle source under the
 *         Phase 3.2 deviation-check model.
 *
 * @dev Pyth is a pull oracle: an off-chain signed update payload must be
 *      posted on-chain (via {updatePriceFeeds}) before the stored price
 *      refreshes. Reads via {getPriceNoOlderThan} revert if the stored
 *      price is older than the supplied `age` bound, so our call chain
 *      is always `updatePriceFeeds(...)` → `getPriceNoOlderThan(...)` in
 *      the same outer tx.
 *
 *      Canonical deployment addresses by chain are published at
 *      https://docs.pyth.network/price-feeds/contract-addresses/evm.
 *      Vaipakam stores the per-chain endpoint in its own Diamond
 *      storage (set by {OracleAdminFacet.setPythEndpoint}), not baked
 *      into the interface or the facet code.
 */

/// @notice On-chain representation of a Pyth price update. All fields
///         are returned in Pyth's native scaling: `price` and `conf` are
///         `int64` / `uint64` scaled by `10^expo` (expo is typically a
///         small negative number, e.g. -8 for most USD pairs).
struct PythPrice {
    int64 price;
    uint64 conf;
    int32 expo;
    uint256 publishTime;
}

interface IPyth {
    /// @notice Returns the most recently-stored price for `id` iff its
    ///         `publishTime` is within `age` seconds of the current
    ///         block timestamp. Reverts otherwise — exact revert shape
    ///         varies by Pyth impl, which is why callers wrap this in a
    ///         try/catch when they want custom revert semantics.
    /// @param id   Pyth feed id (the 32-byte price-feed identifier
    ///             published in Pyth's feed catalogue).
    /// @param age  Max acceptable staleness in seconds.
    /// @return     The Pyth price struct.
    function getPriceNoOlderThan(
        bytes32 id,
        uint256 age
    ) external view returns (PythPrice memory);

    /// @notice Accept a signed update payload from Pyth's off-chain
    ///         network (Hermes) and write the updated prices to storage.
    ///         Required before any subsequent read that wants fresher
    ///         data than the last on-chain state.
    /// @param updateData Array of signed price-update payloads.
    /// @dev    Requires `msg.value >= getUpdateFee(updateData)`. Excess
    ///         is refunded to `msg.sender` per the standard Pyth impl.
    function updatePriceFeeds(bytes[] calldata updateData) external payable;

    /// @notice Quote the native-token fee needed to post `updateData`.
    ///         The protocol's update-wrapper function uses this to take
    ///         the fee from the caller's `msg.value` before forwarding
    ///         the remainder back.
    function getUpdateFee(
        bytes[] calldata updateData
    ) external view returns (uint256 feeAmount);
}
