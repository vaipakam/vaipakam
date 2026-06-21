// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";

/**
 * @title LibBackstopOracleGate
 * @author Vaipakam Developer Team
 * @notice #638 — the backstop-only minimum-secondary-oracle-coverage gate.
 *         Shared by the two paths that put TREASURY funds at risk on a
 *         collateral asset: Role A ({BackstopFacet.backstopFill}, counterparty-
 *         of-last-resort) and Role B (the {ClaimFacet} cash absorb of a
 *         FallbackPending loan). Both apply the identical, governance-set rule
 *         so the treasury is never left holding single-feed-priced collateral.
 * @dev    BACKSTOP-SCOPED BY DESIGN. This is the ONLY consumer of the
 *         `backstopMinSecondaryOracleCoverage` knob; it must NEVER be wired into
 *         the general `OracleFacet` liquid-classification path or any general
 *         liquidation entry point — the general/retail protocol stays
 *         permissionless on asset eligibility (#638 owner direction,
 *         2026-06-19). The default knob value 0 makes this a no-op, so an
 *         unconfigured backstop behaves exactly as before.
 */
library LibBackstopOracleGate {
    /// @notice The backstop requires `required` live secondary feeds for
    ///         `collateral` but only `available` are live.
    error BackstopOracleCoverageInsufficient(
        address collateral,
        uint8 available,
        uint8 required
    );

    /// @dev Reverts if the configured minimum number of live secondary oracle
    ///      feeds for `collateral` is not met. No-op when the knob is 0 (the
    ///      default — preserves general permissionless behaviour; the
    ///      Soft-2-of-N quorum's single-feed soft fallback still governs
    ///      pricing). Cross-calls the read-only
    ///      {OracleFacet.countLiveSecondaryOracleFeeds} view through the Diamond.
    function assertCoverage(address collateral) internal view {
        uint8 required = LibVaipakam
            .storageSlot()
            .protocolCfg
            .backstopMinSecondaryOracleCoverage;
        if (required == 0) return;
        uint8 live = OracleFacet(address(this)).countLiveSecondaryOracleFeeds(
            collateral
        );
        if (live < required) {
            revert BackstopOracleCoverageInsufficient(
                collateral,
                live,
                required
            );
        }
    }
}
