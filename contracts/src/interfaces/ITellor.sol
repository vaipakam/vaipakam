// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title ITellor — Phase 7b.2 minimal Tellor consumer interface.
 *
 * Tellor is a decentralized oracle network with disputed-data
 * resolution. Reporters submit data under a 32-byte queryId derived
 * deterministically from the query specification:
 *
 *   queryData = abi.encode("SpotPrice", abi.encode(string symbol, "usd"))
 *   queryId   = keccak256(queryData)
 *
 * The `symbol` is a lowercase asset symbol string (e.g. "eth", "btc",
 * "usdc"). Reading from Tellor on-chain therefore requires the
 * consumer to derive the queryId at call time — which the OracleFacet
 * does by reading {IERC20.symbol()} from the asset contract,
 * lowercasing it, and packing the standard SpotPrice query.
 *
 * `getDataBefore` returns the most recent value reported before
 * `_timestamp`. The OracleFacet calls it with `block.timestamp` to
 * pick up the latest data and applies its own staleness guard
 * against the returned `_timestampRetrieved`.
 */
interface ITellor {
    /// @notice Read the most recent value reported before `_timestamp`.
    /// @param _queryId Standard 32-byte Tellor query id.
    /// @param _timestamp Upper bound on report time. Pass
    ///                   `block.timestamp` to get the latest data.
    /// @return _value Encoded report payload. SpotPrice format = a
    ///                left-padded `uint256` price with 18-decimal
    ///                scaling (0xUUUU...PPPP, where PPPP is the
    ///                price in 1e18 units).
    /// @return _timestampRetrieved Unix time the returned value was
    ///                             reported. Zero if no data exists
    ///                             before `_timestamp`.
    function getDataBefore(
        bytes32 _queryId,
        uint256 _timestamp
    ) external view returns (bytes memory _value, uint256 _timestampRetrieved);
}
