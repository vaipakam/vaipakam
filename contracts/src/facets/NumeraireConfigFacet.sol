// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title NumeraireConfigFacet
 * @author Vaipakam Developer Team
 * @notice Numeraire / Predominant-Available-Denominator (PAD) / periodic-interest
 *         configuration surface, carved out of {ConfigFacet} (#394 / Codex #647)
 *         to keep ConfigFacet's runtime bytecode under the EIP-170 24,576-byte
 *         limit. Shares the same `LibVaipakam` storage and the same
 *         ADMIN_ROLE gating; behaviour is identical to the pre-split code —
 *         this is a pure facet split, not a behaviour change.
 * @dev    Every setter is ADMIN_ROLE-gated (routed through the governance
 *         timelock after handover). Getters resolve the effective value
 *         (override or library default). All functions operate on the shared
 *         Diamond storage via `LibVaipakam.storageSlot()`.
 */
contract NumeraireConfigFacet is DiamondAccessControl {
    // ── T-034 — Periodic Interest Payment setters + getters ──────────────
    // See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md
    // §6 (numeraire abstraction), §10 (kill-switches).

    /// @notice Emitted when the numeraire address AND its companion
    ///         threshold value flip atomically via {setNumeraire}.
    /// @notice Emitted on every atomic numeraire rotation. After
    ///         Numeraire generalization (b1), the numeraire is identified by its
    ///         feed-side config (ETH/<numeraire> Chainlink feed +
    ///         lowercase ASCII symbol that drives Tellor/API3/DIA
    ///         queries) — there is no longer a single numeraireOracle
    ///         contract. Off-chain monitors index `numeraireSymbol` to
    ///         identify which currency the rotation targets ("usd",
    ///         "eur", "xau", etc.).
    /// @param oldEthFeed Previous ETH/<numeraire> Chainlink feed.
    /// @param newEthFeed New ETH/<numeraire> Chainlink feed.
    /// @param numeraireSymbol Lowercase ASCII symbol of the new
    ///        numeraire (e.g. `bytes32("eur")`).
    /// @custom:event-category informational/config
    event NumeraireUpdated(
        address indexed oldEthFeed,
        address indexed newEthFeed,
        bytes32 numeraireSymbol
    );

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

    /// @notice Emitted when the cross-numeraire swap kill-switch is
    ///         toggled.
    /// @custom:event-category informational/config
    event NumeraireSwapEnabledSet(bool enabled);

    /// @notice T-034 Numeraire generalization (b1) — atomic numeraire rotation.
    ///         The struct carries ALL state that defines the protocol's
    ///         reference currency at once. By construction, governance
    ///         cannot rotate the numeraire without simultaneously
    ///         re-anchoring every value denominated in it AND every
    ///         oracle-side input that produces numeraire-quoted prices.
    ///
    ///         Inconsistent intermediate state ("numeraire = EUR but
    ///         notification fee still in USD-units" or "Tellor still
    ///         queries `<symbol>/usd`") is unreachable.
    /// @param ethNumeraireFeed Chainlink ETH/<numeraire> AggregatorV3.
    ///        ETH/USD by default; rotates to ETH/EUR / ETH/XAU / etc.
    ///        as the numeraire changes. Zero address rejected.
    /// @param numeraireChainlinkDenominator Chainlink Feed Registry
    ///        constant for the active numeraire (e.g. `Denominations.USD`,
    ///        `Denominations.EUR`). Drives Path 2 of `_primaryPrice`
    ///        (direct asset/<numeraire> registry lookup). Zero rejected.
    /// @param numeraireSymbol Lowercase ASCII bytes32 of the numeraire's
    ///        symbol (e.g. `bytes32("usd")`, `bytes32("eur")`). Drives
    ///        Tellor / API3 / DIA query construction. Zero rejected.
    /// @param pythCrossCheckFeedId Pyth ETH/<numeraire> feed id for the
    ///        T-033 cross-check gate. Zero is acceptable (disables the
    ///        Pyth gate — soft-skip behaviour).
    /// @param newThresholdInNewNumeraire Finer-cadence principal
    ///        threshold in numeraire-units (1e18-scaled). 0 ⇒ default.
    /// @param newNotificationFeeInNewNumeraire Per-loan-side
    ///        notification fee in numeraire-units (1e18-scaled). 0 ⇒
    ///        default.
    /// @param newKycTier0InNewNumeraire KYC Tier-0 threshold in
    ///        numeraire-units (1e18-scaled). 0 ⇒ default. MUST be <
    ///        `newKycTier1InNewNumeraire` when both non-zero.
    /// @param newKycTier1InNewNumeraire KYC Tier-1 threshold in
    ///        numeraire-units (1e18-scaled). 0 ⇒ default.
    function setNumeraire(
        address ethNumeraireFeed,
        address numeraireChainlinkDenominator,
        bytes32 numeraireSymbol,
        bytes32 pythCrossCheckFeedId,
        uint256 newThresholdInNewNumeraire,
        uint256 newNotificationFeeInNewNumeraire,
        uint256 newKycTier0InNewNumeraire,
        uint256 newKycTier1InNewNumeraire
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.ProtocolConfig storage c =
            LibVaipakam.storageSlot().protocolCfg;
        if (!c.numeraireSwapEnabled) revert IVaipakamErrors.NumeraireSwapDisabled();

        // The three feed-side inputs are load-bearing — without them,
        // `_primaryPrice` and the secondary-quorum query construction
        // would break.
        if (ethNumeraireFeed == address(0)) revert IVaipakamErrors.InvalidAddress();
        if (numeraireChainlinkDenominator == address(0))
            revert IVaipakamErrors.InvalidAddress();
        if (numeraireSymbol == bytes32(0))
            revert IVaipakamErrors.ParameterOutOfRange(
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes32("numeraireSymbol"), 0, 1, type(uint256).max
            );

        // Range checks per value knob — zero accepted as "reset to default".
        if (
            newThresholdInNewNumeraire != 0 &&
            (
                newThresholdInNewNumeraire <
                    LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR ||
                newThresholdInNewNumeraire >
                    LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes32("minPrincipalForFinerCadence"),
                newThresholdInNewNumeraire,
                LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR,
                LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_CEIL
            );
        }
        if (
            newNotificationFeeInNewNumeraire != 0 &&
            (
                newNotificationFeeInNewNumeraire < LibVaipakam.MIN_NOTIFICATION_FEE_FLOOR ||
                newNotificationFeeInNewNumeraire > LibVaipakam.MAX_NOTIFICATION_FEE_CEIL
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes32("notificationFee"),
                newNotificationFeeInNewNumeraire,
                LibVaipakam.MIN_NOTIFICATION_FEE_FLOOR,
                LibVaipakam.MAX_NOTIFICATION_FEE_CEIL
            );
        }
        // KYC tier monotonicity — only enforce when both are non-zero
        // (zero pair = "reset both to defaults", which the lib defaults
        // satisfy by construction).
        if (
            newKycTier0InNewNumeraire != 0 &&
            newKycTier1InNewNumeraire != 0 &&
            newKycTier0InNewNumeraire >= newKycTier1InNewNumeraire
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes32("kycTier0VsTier1"),
                newKycTier0InNewNumeraire,
                0,
                newKycTier1InNewNumeraire
            );
        }
        if (
            newKycTier0InNewNumeraire != 0 &&
            (
                newKycTier0InNewNumeraire < LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR ||
                newKycTier0InNewNumeraire > LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MAX_CEIL
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes32("kycTier0ThresholdNumeraire"),
                newKycTier0InNewNumeraire,
                LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR,
                LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MAX_CEIL
            );
        }
        if (
            newKycTier1InNewNumeraire != 0 &&
            (
                newKycTier1InNewNumeraire < LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR ||
                newKycTier1InNewNumeraire > LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MAX_CEIL
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes32("kycTier1ThresholdNumeraire"),
                newKycTier1InNewNumeraire,
                LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR,
                LibVaipakam.KYC_THRESHOLD_NUMERAIRE_MAX_CEIL
            );
        }

        // Atomic write: feed-side first (so any subsequent oracle read
        // in the same tx sees the new state), then value-side.
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address oldEthFeed = s.ethNumeraireFeed;
        s.ethNumeraireFeed = ethNumeraireFeed;
        s.numeraireChainlinkDenominator = numeraireChainlinkDenominator;
        s.numeraireSymbol = numeraireSymbol;
        s.pythCrossCheckFeedId = pythCrossCheckFeedId;
        c.minPrincipalForFinerCadence = newThresholdInNewNumeraire;
        c.notificationFee = newNotificationFeeInNewNumeraire;
        s.kycTier0ThresholdNumeraire = newKycTier0InNewNumeraire;
        s.kycTier1ThresholdNumeraire = newKycTier1InNewNumeraire;
        emit NumeraireUpdated(oldEthFeed, ethNumeraireFeed, numeraireSymbol);
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

    /// @notice Independent kill-switch gating the cross-numeraire
    ///         batched setter `setNumeraire`. Default `false` — a
    ///         fresh deploy ships USD-as-numeraire and governance
    ///         cannot rotate to a different numeraire until this
    ///         flag flips.
    function setNumeraireSwapEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.numeraireSwapEnabled = enabled;
        emit NumeraireSwapEnabledSet(enabled);
    }

    /// @notice Individual getter for `numeraireSymbol` — the lowercase
    ///         ASCII bytes32 symbol of the active numeraire (e.g.
    ///         `bytes32("usd")`, `bytes32("eur")`). Empty bytes32
    ///         indicates the post-deploy default ("usd"). Frontend
    ///         knob card reads this for currency labels.
    function getNumeraireSymbol() external view returns (bytes32) {
        return LibVaipakam.storageSlot().numeraireSymbol;
    }

    /// @notice Individual getter for `ethNumeraireFeed` — the
    ///         Chainlink ETH/<numeraire> AggregatorV3 address.
    function getEthNumeraireFeed() external view returns (address) {
        return LibVaipakam.storageSlot().ethNumeraireFeed;
    }

    // ─── T-048 — Predominantly Available Denominator (PAD) ─────────────

    /// @notice Emitted when governance rotates the PAD config. Indexes
    ///         the old → new denominator transition for off-chain
    ///         monitoring; the symbol + feeds are non-indexed because
    ///         most chains will never rotate (PAD stays at USD).
    /// @custom:event-category informational/config
    event PredominantDenominatorUpdated(
        address indexed oldDenominator,
        address indexed newDenominator,
        bytes32 newSymbol,
        address newEthPadFeed,
        address newPadNumeraireRateFeed
    );

    /// @notice Emitted when governance sets / clears a per-asset
    ///         numeraire-direct feed override.
    /// @custom:event-category informational/config
    event AssetNumeraireDirectFeedOverrideSet(
        address indexed asset,
        address indexed previous,
        address indexed next
    );

    /// @notice Atomic rotation of the Predominantly Available
    ///         Denominator config — all four slots in one tx so the
    ///         PAD identity is never half-rotated. PAD is the
    ///         universally-covered Chainlink denomination
    ///         (`Denominations.USD` by post-deploy default) the
    ///         protocol pivots through when the active numeraire is
    ///         non-USD. See README §16 / docs/AdminConfigurableKnobsAndSwitches.md.
    /// @dev    Admin-only. The setter accepts:
    ///          - `newDenominator`: the Chainlink Feed Registry
    ///            denomination constant (e.g.
    ///            `0x0000…0000348` for USD). Must be non-zero;
    ///            zeroing the slot would disable the PAD pivot
    ///            entirely and is reachable only via a governance
    ///            decision to revert to a pre-T-048 deploy shape
    ///            (use `clearPredominantDenominator` for that).
    ///          - `newSymbol`: lowercase ASCII bytes32 (e.g.
    ///            `bytes32("usd")`) for symbol-derived secondary
    ///            oracles. Empty bytes32 is interpreted as `"usd"`.
    ///          - `newEthPadFeed`: Chainlink ETH/<PAD> AggregatorV3.
    ///            REQUIRED on every chain because it's the load-
    ///            bearing leg of (a) WETH pricing and (b) the
    ///            derived PAD/<numeraire> rate. Must be non-zero.
    ///          - `newPadNumeraireRateFeed`: optional Chainlink
    ///            PAD/<numeraire> AggregatorV3 (e.g. USD/EUR on
    ///            mainnet). Zero is valid — the protocol derives the
    ///            rate from `ethNumeraireFeed ÷ ethPadFeed`.
    function setPredominantDenominator(
        address newDenominator,
        bytes32 newSymbol,
        address newEthPadFeed,
        address newPadNumeraireRateFeed
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (newDenominator == address(0)) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "predominantDenominator",
                0,
                1,
                type(uint256).max
            );
        }
        if (newEthPadFeed == address(0)) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "ethPadFeed",
                0,
                1,
                type(uint256).max
            );
        }

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address oldDenominator = s.predominantDenominator;
        s.predominantDenominator = newDenominator;
        s.predominantDenominatorSymbol = newSymbol;
        s.ethPadFeed = newEthPadFeed;
        s.padNumeraireRateFeed = newPadNumeraireRateFeed;

        emit PredominantDenominatorUpdated(
            oldDenominator,
            newDenominator,
            newSymbol,
            newEthPadFeed,
            newPadNumeraireRateFeed
        );
    }

    /// @notice Set / clear a per-asset numeraire-direct feed override.
    ///         When set non-zero, `OracleFacet._primaryPrice` reads
    ///         this Chainlink feed directly as the asset's
    ///         numeraire-quoted price and skips the PAD pivot.
    ///         Operator vouches the feed is verified-rated; the
    ///         protocol does NOT cross-check it against Pyth.
    /// @dev    Pass `address(0)` to clear and revert to PAD-pivot
    ///         behaviour for that asset. Admin-only.
    function setAssetNumeraireDirectFeedOverride(address asset, address feed)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (asset == address(0)) revert IVaipakamErrors.InvalidAsset();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address previous = s.assetNumeraireDirectFeedOverride[asset];
        s.assetNumeraireDirectFeedOverride[asset] = feed;
        emit AssetNumeraireDirectFeedOverrideSet(asset, previous, feed);
    }

    /// @notice Read the active PAD denomination — the Chainlink
    ///         Feed Registry denominator that `_primaryPrice` queries
    ///         first. Zero on a pre-T-048 deploy where PAD wasn't set
    ///         (legacy numeraire-direct path active).
    function getPredominantDenominator() external view returns (address) {
        return LibVaipakam.storageSlot().predominantDenominator;
    }

    /// @notice Read the active PAD symbol — bytes32 lowercase ASCII
    ///         used by symbol-derived secondary oracles when querying
    ///         asset/PAD pairs. Empty bytes32 (post-deploy default)
    ///         reads as `"usd"` per `LibVaipakam.effectivePadSymbol()`.
    function getPredominantDenominatorSymbol() external view returns (bytes32) {
        return LibVaipakam.storageSlot().predominantDenominatorSymbol;
    }

    /// @notice Read the Chainlink ETH/<PAD> AggregatorV3 address.
    ///         REQUIRED post-T-048; load-bearing for WETH pricing
    ///         and for the derived PAD/<numeraire> rate.
    function getEthPadFeed() external view returns (address) {
        return LibVaipakam.storageSlot().ethPadFeed;
    }

    /// @notice Read the optional Chainlink PAD/<numeraire>
    ///         AggregatorV3 address. Zero means the protocol derives
    ///         the FX rate from existing ETH-pivot feeds.
    function getPadNumeraireRateFeed() external view returns (address) {
        return LibVaipakam.storageSlot().padNumeraireRateFeed;
    }

    /// @notice Read the per-asset numeraire-direct feed override.
    ///         Zero means the asset routes through the PAD pivot.
    function getAssetNumeraireDirectFeedOverride(address asset)
        external
        view
        returns (address)
    {
        return LibVaipakam.storageSlot().assetNumeraireDirectFeedOverride[asset];
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

    /// @notice Individual getter for `numeraireSwapEnabled` independent
    ///         kill-switch.
    function getNumeraireSwapEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().protocolCfg.numeraireSwapEnabled;
    }

    /// @notice Bundled getter for the entire T-034 config surface,
    ///         intended for the frontend `usePeriodicInterestConfig`
    ///         hook. Numeraire generalization (b1) — the per-knob `numeraireOracle`
    ///         field is gone; the numeraire identity is captured by
    ///         the symbol (`getNumeraireSymbol()`) + ETH feed
    ///         (`getEthNumeraireFeed()`) — both readable individually.
    /// @return symbol Lowercase ASCII bytes32 of the active numeraire.
    /// @return threshold The effective `minPrincipalForFinerCadence`
    ///         (override or library default), in numeraire-units.
    /// @return preNotify The effective `preNotifyDays` (override or
    ///         library default).
    /// @return periodicEnabled Master kill-switch state.
    /// @return numeraireSwapEnabled_ Numeraire-swap kill-switch state.
    function getPeriodicInterestConfig()
        external
        view
        returns (
            bytes32 symbol,
            uint256 threshold,
            uint8 preNotify,
            bool periodicEnabled,
            bool numeraireSwapEnabled_
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
        numeraireSwapEnabled_ = c.numeraireSwapEnabled;
    }
}
