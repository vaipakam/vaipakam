// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";

/**
 * @title LenderIntentFacet
 * @author Vaipakam Developer Team
 * @notice #393 v1 — the LenderIntentVault standing-terms surface. A lender
 *         registers a set-and-forget lending INTENT for an ERC-20 asset-pair
 *         (bounds: max exposure, min APR, max init-LTV, max term, min slice);
 *         a permissioned solver later materializes concrete offers within those
 *         bounds via `OfferMatchFacet.matchIntent` (v1-b), consuming the
 *         lender's EXISTING per-user vault balance. The lender-of-record stays
 *         the depositing user (`loan.lender` = the intent owner), so the vault
 *         is never the on-chain lender and every downstream claim / VPFI / KYC /
 *         sanctions path is the existing, audited one — unchanged. See
 *         docs/DesignsAndPlans/LenderIntentVaultV1Design.md §1 + §3.1.
 *
 * @dev    This facet is the set/cancel/read surface ONLY — no funds move here.
 *         Principal stays in the user's per-user vault; the fill path
 *         (`matchIntent`) reserves it via the encumbrance sub-ledger (#407) at
 *         fill time, exactly as a normal offer does. ERC-20-on-ERC-20 only.
 *         One intent per (owner, lendingAsset, collateralAsset).
 */
contract LenderIntentFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    DiamondAccessControl
{
    /// @notice A lender registered / updated a standing intent for an asset-pair.
    event LenderIntentSet(
        address indexed owner,
        address indexed lendingAsset,
        address indexed collateralAsset,
        uint256 maxExposure,
        uint256 minRateBps,
        uint16 maxInitLtvBps,
        uint32 maxDurationDays,
        uint256 minFillAmount,
        bool requiresKeeperAuth
    );

    /// @notice A lender tore down a standing intent for an asset-pair.
    event LenderIntentCancelled(
        address indexed owner,
        address indexed lendingAsset,
        address indexed collateralAsset
    );

    /// @notice The LenderIntentVault fill-path master kill-switch toggled.
    event LenderIntentEnabledSet(bool enabled);

    /// @notice A required address argument was the zero address.
    error LenderIntentZeroAddress();
    /// @notice `lendingAsset == collateralAsset` — a self-collateralized intent
    ///         the fill path's `createOffer` would reject (`SelfCollateralizedOffer`).
    error LenderIntentSelfCollateralized();
    /// @notice `maxExposure`, `minRateBps`, `maxInitLtvBps`, or `minFillAmount`
    ///         was outside its valid range (see `setLenderIntent`).
    error LenderIntentInvalidBounds();
    /// @notice `requiresKeeperAuth == true` is not yet honoured — the
    ///         permissioned-solver gate ships in a later v1 increment. Rejecting
    ///         it here prevents a lender registering a "keeper-only" intent that
    ///         an as-yet-ungated fill path would treat as openly fillable.
    error LenderIntentKeeperGateNotEnabled();
    /// @notice No active intent exists for the (owner, asset-pair) to cancel.
    error LenderIntentNotActive();

    /// @notice Register or overwrite the caller's standing lending intent for an
    ///         ERC-20 asset-pair.
    /// @dev    Tier-1 sanctions-gated (the intent is a new lending commitment).
    ///         Re-calling with the same pair overwrites the bounds in place
    ///         (live `matchIntent` reads always see the latest terms, so there
    ///         is no stale-terms window to invalidate — no nonce needed). The
    ///         bounds are a HARD band a solver's concrete terms must satisfy;
    ///         the protocol HF/LTV init gate still applies on top at fill.
    /// @param lendingAsset       The ERC-20 the lender supplies.
    /// @param collateralAsset    The ERC-20 collateral the lender will accept.
    /// @param maxExposure        Hard cap on aggregate LIVE principal from this
    ///                           intent (> 0).
    /// @param minRateBps         APR floor in basis points; a fill below reverts.
    /// @param maxInitLtvBps      The lender's own init-LTV ceiling in BPS
    ///                           (1..=BPS_DENOMINATOR); the protocol gate is the
    ///                           min of this and the per-asset/tier cap.
    /// @param maxDurationDays    Longest loan term the lender accepts (> 0).
    /// @param minFillAmount      Smallest slice a solver may fill (> 0,
    ///                           <= maxExposure).
    /// @param requiresKeeperAuth When true, only a solver the lender has
    ///                           authorized (v1-c keeper bit) may fill; when
    ///                           false the intent is openly fillable.
    /// @param riskAndTermsConsent Must be `true`. Mirrors the mandatory
    ///                           `creatorRiskAndTermsConsent` every offer-create
    ///                           path records: a standing intent is a lending
    ///                           commitment, so the lender consents to the
    ///                           risk/terms framework here, once, at registration
    ///                           (the loans it later materializes inherit it).
    function setLenderIntent(
        address lendingAsset,
        address collateralAsset,
        uint256 maxExposure,
        uint256 minRateBps,
        uint16 maxInitLtvBps,
        uint32 maxDurationDays,
        uint256 minFillAmount,
        bool requiresKeeperAuth,
        bool riskAndTermsConsent
    ) external nonReentrant whenNotPaused {
        LibVaipakam._assertNotSanctioned(msg.sender);

        // Mandatory risk/terms consent — same gate as every offer-create path
        // (`RiskAndTermsConsentRequired`), captured once for the standing intent.
        if (!riskAndTermsConsent) revert IVaipakamErrors.RiskAndTermsConsentRequired();

        if (lendingAsset == address(0) || collateralAsset == address(0)) {
            revert LenderIntentZeroAddress();
        }
        // A self-collateralized pair is unfillable: the fill path's `createOffer`
        // rejects `lendingAsset == collateralAsset` (`SelfCollateralizedOffer`),
        // so an intent advertised as active could never produce a loan.
        if (lendingAsset == collateralAsset) {
            revert LenderIntentSelfCollateralized();
        }
        // The permissioned-solver gate is not wired yet (later v1 increment);
        // until it is, a "keeper-only" intent would be indistinguishable from an
        // open one at the fill path. Reject the flag so no lender registers a
        // false sense of protection. Lifted when the gate ships.
        if (requiresKeeperAuth) revert LenderIntentKeeperGateNotEnabled();
        // Bounds sanity: exposure + slice positive, slice within exposure, an
        // LTV ceiling in (0, 100%], a positive term, and a rate floor at or
        // below the protocol interest ceiling so a materialized offer can
        // actually clear `createOffer` (which rejects rates > MAX_INTEREST_BPS).
        // `minRateBps == 0` is permitted (a 0% floor = "any rate").
        if (
            maxExposure == 0
                || minFillAmount == 0
                || minFillAmount > maxExposure
                || minRateBps > LibVaipakam.MAX_INTEREST_BPS
                || maxInitLtvBps == 0
                || maxInitLtvBps > LibVaipakam.BASIS_POINTS
                || maxDurationDays == 0
        ) {
            revert LenderIntentInvalidBounds();
        }

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.lenderIntent[msg.sender][lendingAsset][collateralAsset] = LibVaipakam
            .LenderIntent({
            active: true,
            maxExposure: maxExposure,
            minRateBps: minRateBps,
            maxInitLtvBps: maxInitLtvBps,
            maxDurationDays: maxDurationDays,
            minFillAmount: minFillAmount,
            requiresKeeperAuth: requiresKeeperAuth
        });

        emit LenderIntentSet(
            msg.sender,
            lendingAsset,
            collateralAsset,
            maxExposure,
            minRateBps,
            maxInitLtvBps,
            maxDurationDays,
            minFillAmount,
            requiresKeeperAuth
        );
    }

    /// @notice Tear down the caller's standing intent for an asset-pair. No new
    ///         fills can materialize against it; loans already open from prior
    ///         fills are unaffected (they settle through the normal path) and
    ///         their live-principal is released at their own terminal close.
    /// @dev    Tier-2-style close-out: NOT sanctions-gated on the canceller, so a
    ///         flagged lender can always WIND DOWN their standing exposure.
    function cancelLenderIntent(address lendingAsset, address collateralAsset)
        external
        nonReentrant
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.LenderIntent storage intent =
            s.lenderIntent[msg.sender][lendingAsset][collateralAsset];
        if (!intent.active) revert LenderIntentNotActive();
        intent.active = false;
        emit LenderIntentCancelled(msg.sender, lendingAsset, collateralAsset);
    }

    /// @notice Master kill-switch for the standing-intent fill path
    ///         (`OfferMatchFacet.matchIntent`). Default `false`: lenders can
    ///         register intents but no fill executes until governance flips
    ///         this on post-bake. Same ship-off / governance-on / break-glass-
    ///         off pattern as `partialFillEnabled` / `internalMatchEnabled`.
    /// @dev    ADMIN_ROLE-only (TimelockController post-handover). Lives on this
    ///         facet (not `ConfigFacet`) because `ConfigFacet` is at the EIP-170
    ///         ceiling; the kill-switch sits with its feature.
    function setLenderIntentEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.lenderIntentEnabled = enabled;
        emit LenderIntentEnabledSet(enabled);
    }

    /// @notice Whether the standing-intent fill path is currently enabled
    ///         (the `setLenderIntentEnabled` kill-switch state).
    function isLenderIntentEnabled() external view returns (bool) {
        return LibVaipakam.cfgLenderIntentEnabled();
    }

    /// @notice Read a standing intent. `active == false` ⇒ none / cancelled.
    function getLenderIntent(
        address owner,
        address lendingAsset,
        address collateralAsset
    ) external view returns (LibVaipakam.LenderIntent memory) {
        return LibVaipakam.storageSlot().lenderIntent[owner][lendingAsset][
            collateralAsset
        ];
    }
}
