// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title INumeraireOracle
 * @notice Pluggable price source that decouples the
 *         `minPrincipalForFinerCadence` threshold (T-034) from any
 *         specific currency. The oracle reports how many USD (1e18-
 *         scaled) one unit of the configured numeraire is worth, so
 *         that a threshold value stored in numeraire-units can be
 *         converted into USD-units at compare time and gated against
 *         a Chainlink-priced principal value.
 * @dev   USD-as-numeraire impl returns `1e18` (one USD per one USD).
 *        XAU-as-numeraire impl returns the spot XAU/USD price (e.g.
 *        ~`2400e18` when 1 XAU = $2400). EUR-as-numeraire impl
 *        returns spot EUR/USD (e.g. ~`1.08e18`). The protocol's
 *        `numeraireOracle` storage slot defaults to `address(0)` —
 *        callers MUST treat that as "USD-as-numeraire" and skip the
 *        external call (no IdentityNumeraireOracle deployment
 *        required for the default behavior to work).
 *
 *        The ONLY path to change the numeraire address is the atomic
 *        batched setter `ConfigFacet.setNumeraire(address, uint256)`,
 *        which simultaneously rewrites the threshold value in the
 *        new numeraire's units. By construction the numeraire and
 *        the threshold are never out of sync.
 *
 *        See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md §6.
 */
interface INumeraireOracle {
    /// @notice How many USD (1e18-scaled) is one unit of the numeraire?
    /// @return rate Multiplier such that
    ///         `usdValue1e18 = numeraireValue1e18 × rate / 1e18`.
    ///         Implementations MUST return a strictly positive value;
    ///         zero is treated as a malformed oracle and rejected by
    ///         the setter via `NumeraireOracleInvalid`.
    function numeraireToUsdRate1e18() external view returns (uint256 rate);
}
