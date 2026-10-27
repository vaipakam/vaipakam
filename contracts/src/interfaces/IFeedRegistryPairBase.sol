// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/// @title IFeedRegistryPairBase
/// @notice The one read the Diamond makes of a `VaipakamFeedRegistry` beyond
///         Chainlink's own `getFeed`: the asset's price identity as its
///         registered feed names it (#2745).
interface IFeedRegistryPairBase {
    /// @notice The base symbol of the registered (`base`, `quote`) pair as its
    ///         feed names it ("LINK" for "LINK / USD"), left-aligned in a
    ///         word, or zero when the pair is not registered or the symbol
    ///         does not fit in 32 bytes.
    function pairBase(address base, address quote) external view returns (bytes32 symbol);
}
