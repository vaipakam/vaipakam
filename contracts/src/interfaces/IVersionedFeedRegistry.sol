// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  IVersionedFeedRegistry
 * @notice The reads the price guard makes of a `VaipakamFeedRegistry` beyond
 *         Chainlink's `getFeed` and {IFeedRegistryPairBase}: its epoch and the
 *         bindings as of an epoch (#3437), and its rate entries (#3683).
 */
interface IVersionedFeedRegistry {
    /// @dev `VaipakamFeedRegistry.Entry`, field for field (`category` is its
    ///      `Category` enum).
    struct Entry {
        address feed;
        uint8 feedDecimals;
        uint8 category;
        uint32 heartbeat;
        uint32 directoryDate;
        uint64 updatedAt;
        uint64 sinceEpoch;
        bytes32 directorySha256;
        string pair;
    }

    /// @notice The registry's config epoch: raised by one per executed proposal.
    function epoch() external view returns (uint64);

    /// @notice The price feed (`base`, `quote`) had at epoch `at`; zero for none.
    function getFeedAt(address base, address quote, uint64 at) external view returns (address);

    /// @notice The pair's base symbol at epoch `at`; zero for none.
    function pairBaseAt(address base, address quote, uint64 at) external view returns (bytes32);

    /// @notice The live price entry for (`base`, `quote`).
    function entry(address base, address quote) external view returns (Entry memory);

    /// @notice The live rate entry for `token` into `underlying`.
    function rateEntry(address token, address underlying) external view returns (Entry memory);
}
