// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title IDIAOracleV2 — Phase 7b.2 minimal DIA consumer interface.
 *
 * DIA exposes spot-price feeds keyed by a string `key` of the form
 * `"<SYMBOL>/USD"` (e.g. `"ETH/USD"`, `"USDC/USD"`). The OracleFacet
 * derives the key on-chain by reading `asset.symbol()`, uppercasing
 * it, and concatenating `"/USD"`. No per-asset governance config.
 *
 * `getValue(string)` returns `(uint128 value, uint128 timestamp)`.
 * Value is scaled to 8 decimals by DIA convention. The OracleFacet
 * applies a chain-level staleness guard against `timestamp`.
 */
interface IDIAOracleV2 {
    /// @notice Read the most recent (value, timestamp) pair for a
    ///         spot-price key.
    /// @param key DIA key string, e.g. "ETH/USD".
    /// @return value 8-decimal price (uint128).
    /// @return timestamp Unix time the value was last updated.
    function getValue(
        string memory key
    ) external view returns (uint128 value, uint128 timestamp);
}
