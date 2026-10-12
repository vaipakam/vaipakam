// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title ISanctionsList
 * @notice Shape of the on-chain sanctions oracle used by Vaipakam's
 *         compliance gate: a single read that returns true iff the
 *         queried address is flagged.
 *
 * @dev This is the interface Chainalysis's on-chain oracle exposed, but
 *      Chainalysis retired that oracle (last updated 2026-03-18, "no
 *      longer supported or maintained") and it must not be configured:
 *      it still answers, so nothing on-chain shows it is frozen. Which
 *      source mainnets use is open (#2443); testnets use the admin's
 *      `TestnetSanctionsOverlay`.
 *
 *      Where no oracle is configured, `sanctionsOracle = address(0)`
 *      disables the check entirely (see `LibVaipakam.isSanctionedAddress`).
 *      That is fail-OPEN by design — the alternative is blocking every
 *      user on a chain with no source — so a retail deploy must not
 *      route real value while it is zero.
 */
interface ISanctionsList {
    /// @notice Returns true iff `addr` is currently flagged by the
    ///         oracle's sanctions programme data. Pure view, no gas
    ///         impact beyond the surrounding tx.
    function isSanctioned(address addr) external view returns (bool);
}
