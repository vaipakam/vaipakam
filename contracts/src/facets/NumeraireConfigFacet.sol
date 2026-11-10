// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title NumeraireConfigFacet
 * @author Vaipakam Developer Team
 * @notice The numeraire-denominated thresholds and the periodic-interest
 *         configuration surface, carved out of {ConfigFacet} (#394 / Codex
 *         #647) to keep ConfigFacet's runtime bytecode under the EIP-170
 *         24,576-byte limit. Shares the same `LibVaipakam` storage and the
 *         same ADMIN_ROLE gating.
 *
 *         The numeraire itself is not configured here (#3272 part 2, owner
 *         decision 2026-11-09 "Fix numeraire at deploy"): it is the price
 *         guard's identity, fixed when the guard is built, and the Diamond
 *         records it when it records the protocol registry. A guard swapped
 *         in later must carry the same numeraire, or every price read
 *         refuses ({LibPriceGuard.guard}). So these thresholds and the
 *         prices are always in one unit; a different numeraire is a new
 *         deployment.
 * @dev    Every setter is ADMIN_ROLE-gated (routed through the governance
 *         timelock after handover). Getters resolve the effective value
 *         (override or library default). All functions operate on the shared
 *         Diamond storage via `LibVaipakam.storageSlot()`.
 */
contract NumeraireConfigFacet is DiamondAccessControl {
    // ── T-034 — Periodic Interest Payment setters + getters ──────────────
    // See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md
    // §6 (numeraire abstraction), §10 (kill-switches).

    /// @notice Emitted when the principal threshold for finer cadences
    ///         is updated within the same numeraire.
    /// @custom:event-category informational/config
    event MinPrincipalForFinerCadenceSet(uint256 newThreshold);

    /// @notice Emitted when the shared maturity / periodic-checkpoint
    ///         pre-notify lead time is updated.
    /// @custom:event-category informational/config
    event PreNotifyDaysSet(uint8 newDays);

    /// @notice Emitted when the master kill-switch for the entire
    ///         Periodic Interest Payment mechanic is toggled.
    /// @custom:event-category informational/config
    event PeriodicInterestEnabledSet(bool enabled);

    /// @notice #3242 — the floor on an offer principal's value changed.
    ///         `minimum` is the effective floor after the write (the default
    ///         when zero was written, or when a numeraire rotation reset it).
    /// @custom:event-category informational/config
    event MinOfferValueNumeraireSet(uint256 minimum);

    /**
     * @notice #3242 — set the floor on the value of an offer's principal, in
     *         the active numeraire (1e18-scaled). Zero restores the default
     *         ({LibVaipakam.MIN_OFFER_VALUE_NUMERAIRE_DEFAULT}, $10).
     * @dev ADMIN_ROLE-only (the Timelock after handover). A non-zero value must
     *      lie in [{LibVaipakam.MIN_OFFER_VALUE_NUMERAIRE_FLOOR},
     *      {LibVaipakam.MIN_OFFER_VALUE_NUMERAIRE_CEIL}]. Applied when an offer
     *      is created or its amount is changed; an offer already open is not
     *      re-checked. A principal that cannot be priced is never refused.
     * @param minimum The new floor; pass 0 to reset to the default.
     */
    function setMinOfferValueNumeraire(uint256 minimum)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (
            minimum != 0 &&
            (minimum < LibVaipakam.MIN_OFFER_VALUE_NUMERAIRE_FLOOR ||
                minimum > LibVaipakam.MIN_OFFER_VALUE_NUMERAIRE_CEIL)
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes32("minOfferValueNumeraire"),
                minimum,
                LibVaipakam.MIN_OFFER_VALUE_NUMERAIRE_FLOOR,
                LibVaipakam.MIN_OFFER_VALUE_NUMERAIRE_CEIL
            );
        }
        LibVaipakam.storageSlot().minOfferValueNumeraire = minimum;
        emit MinOfferValueNumeraireSet(LibVaipakam.cfgMinOfferValueNumeraire());
    }

    /// @notice #3242 — the floor on an offer principal's value in effect
    ///         (1e18 numeraire): the governance value, or the default while
    ///         unset.
    function getMinOfferValueNumeraire() external view returns (uint256) {
        return LibVaipakam.cfgMinOfferValueNumeraire();
    }

    /// @notice Update only the principal threshold for finer cadences,
    ///         within the same numeraire. NOT gated by
    ///         `numeraireSwapEnabled` — governance can tune the
    ///         threshold without unlocking numeraire swap.
    /// @dev Range `[FLOOR, CEIL]`; zero accepted as "reset to default".
    /// @param newThreshold Threshold in numeraire-units (1e18-scaled).
    function setMinPrincipalForFinerCadence(uint256 newThreshold)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (
            newThreshold != 0 &&
            (
                newThreshold <
                    LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR ||
                newThreshold >
                    LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes32("minPrincipalForFinerCadence"),
                newThreshold,
                LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR,
                LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL
            );
        }
        LibVaipakam.storageSlot().protocolCfg.minPrincipalForFinerCadence = newThreshold;
        emit MinPrincipalForFinerCadenceSet(newThreshold);
    }

    /// @notice Update the shared pre-notify lead time (days) consumed
    ///         by the off-chain hf-watcher for both maturity and
    ///         periodic-checkpoint pre-notify lanes.
    /// @dev Range `[FLOOR, CEIL]`; zero accepted as "reset to default".
    /// @param newDays Lead time in days; pass `0` to reset.
    function setPreNotifyDays(uint8 newDays)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (
            newDays != 0 &&
            (
                newDays < LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_FLOOR ||
                newDays > LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_CEIL
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes32("preNotifyDays"),
                uint256(newDays),
                uint256(LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_FLOOR),
                uint256(LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_CEIL)
            );
        }
        LibVaipakam.storageSlot().protocolCfg.preNotifyDays = newDays;
        emit PreNotifyDaysSet(newDays);
    }

    /// @notice Master kill-switch for the entire Periodic Interest
    ///         Payment mechanic. Default `false` — feature ships
    ///         dormant; flipped on by governance when ready.
    function setPeriodicInterestEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.periodicInterestEnabled = enabled;
        emit PeriodicInterestEnabledSet(enabled);
    }

    /// @notice The lower-case ASCII symbol of the numeraire every price and
    ///         every numeraire-denominated threshold is in (`bytes32("usd")`
    ///         on retail): the price guard's identity, recorded with the
    ///         protocol registry at deploy (#3272). Zero until then.
    function getNumeraireSymbol() external view returns (bytes32) {
        return LibVaipakam.storageSlot().numeraireSymbol;
    }

    /// @notice Individual getter for `minPrincipalForFinerCadence`.
    ///         Returns the effective value (override or library default).
    function getMinPrincipalForFinerCadence() external view returns (uint256) {
        uint256 v = LibVaipakam.storageSlot().protocolCfg.minPrincipalForFinerCadence;
        return v == 0
            ? LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_DEFAULT
            : v;
    }

    /// @notice Individual getter for `preNotifyDays`. Returns the
    ///         effective value (override or library default).
    function getPreNotifyDays() external view returns (uint8) {
        uint8 v = LibVaipakam.storageSlot().protocolCfg.preNotifyDays;
        return v == 0 ? LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_DEFAULT : v;
    }

    /// @notice Individual getter for `periodicInterestEnabled` master
    ///         kill-switch. Cards / hooks that gate UI on the flag use
    ///         this rather than fan out the bundle.
    function getPeriodicInterestEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().protocolCfg.periodicInterestEnabled;
    }

    /// @notice Bundled getter for the entire T-034 config surface,
    ///         intended for the frontend `usePeriodicInterestConfig`
    ///         hook.
    /// @return symbol Lowercase ASCII bytes32 of the numeraire: the price
    ///         guard's, recorded once with the protocol registry
    ///         ({getNumeraireSymbol}).
    /// @return threshold The effective `minPrincipalForFinerCadence`
    ///         (override or library default), in numeraire-units.
    /// @return preNotify The effective `preNotifyDays` (override or
    ///         library default).
    /// @return periodicEnabled Master kill-switch state.
    function getPeriodicInterestConfig()
        external
        view
        returns (
            bytes32 symbol,
            uint256 threshold,
            uint8 preNotify,
            bool periodicEnabled
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ProtocolConfig storage c = s.protocolCfg;
        symbol = s.numeraireSymbol;
        threshold = c.minPrincipalForFinerCadence == 0
            ? LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_DEFAULT
            : c.minPrincipalForFinerCadence;
        preNotify = c.preNotifyDays == 0
            ? LibVaipakam.PERIODIC_PRE_NOTIFY_DAYS_DEFAULT
            : c.preNotifyDays;
        periodicEnabled = c.periodicInterestEnabled;
    }
}
