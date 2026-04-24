// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title ISanctionsList
 * @notice Shape of the on-chain sanctions oracle used by Vaipakam's
 *         compliance gate. Chainalysis publishes an oracle at a
 *         deterministic address on every chain it supports; the
 *         address is surfaced at
 *         https://go.chainalysis.com/chainalysis-oracle-docs.html.
 *
 * @dev The oracle exposes a single read that returns true iff the
 *      queried address is on any sanctions programme Chainalysis is
 *      currently monitoring (the OFAC SDN list is the primary driver,
 *      but the oracle also covers UK / EU / UN / others). Reads are
 *      free gas-wise because they hit a static mapping in the oracle
 *      contract.
 *
 *      Chainalysis ships the oracle on most major chains but NOT on
 *      every L2 or testnet. For chains where no oracle is deployed
 *      Vaipakam sets `sanctionsOracle = address(0)`, which disables
 *      the check entirely (see `LibVaipakam.isSanctionedAddress`). A
 *      no-oracle chain is NOT fail-closed — the alternative is
 *      blocking every user on chains Chainalysis doesn't cover, which
 *      would be an over-reaction to a vendor gap.
 */
interface ISanctionsList {
    /// @notice Returns true iff `addr` is currently flagged by the
    ///         oracle's sanctions programme data. Pure view, no gas
    ///         impact beyond the surrounding tx.
    function isSanctioned(address addr) external view returns (bool);
}
