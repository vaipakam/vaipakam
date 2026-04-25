// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title IApi3ServerV1 — Phase 7b.2 minimal API3 consumer interface.
 *
 * API3 publishes "dAPIs" — managed feeds with a stable name keyed by
 * a `dapiName` 32-byte string padded right with zeros (e.g. the
 * literal `"ETH/USD"` packed into `bytes32`). The consumer reads via
 * the dAPI name HASH:
 *
 *   dapiNameHash = keccak256(abi.encodePacked(bytes32 dapiName))
 *
 * The OracleFacet derives the dapi name from `IERC20.symbol()` at
 * call time — uppercase symbol followed by `/USD`, packed to bytes32,
 * hashed. Symbol naming follows API3's convention for canonical
 * pairs (ETH/USD, USDC/USD, WBTC/USD, ...).
 *
 * `readDataFeedWithDapiNameHash` returns `(int224 value, uint32 timestamp)`.
 * Value scaling is fixed 18 decimals; the OracleFacet applies its
 * own staleness guard against the returned timestamp.
 */
interface IApi3ServerV1 {
    /// @notice Read the most recent (value, timestamp) pair for a dAPI
    ///         identified by its name hash.
    /// @param dapiNameHash `keccak256(abi.encodePacked(bytes32 dapiName))`.
    /// @return value 18-decimal int224 price.
    /// @return timestamp Unix time the value was last updated.
    function readDataFeedWithDapiNameHash(
        bytes32 dapiNameHash
    ) external view returns (int224 value, uint32 timestamp);
}
