// src/facets/RateModelFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IRateModel} from "../interfaces/IRateModel.sol";

/**
 * @title RateModelFacet
 * @author Vaipakam Developer Team
 * @notice The #400 quote-time rate model, in one place: registering and
 *         disabling the model, the band its quotes are clamped to (#2748),
 *         and the quote itself.
 * @dev Part of the Diamond Standard (EIP-2535).
 *
 *      WHY A FACET OF ITS OWN (#2748): the registration and band lived in
 *      `AdminFacet` and the quote in `OfferCreateFacet`, so one behaviour (the
 *      band a setter writes and the clamp reads) was split across two facets
 *      that had to be refreshed together. Widening the clamp to the three-knob
 *      band then pushed `OfferCreateFacet` 49 bytes over the EIP-170 limit.
 *      The quote is not offer creation: the manual create path never calls it,
 *      and a typed rate is binding. So the whole subsystem moves here, the
 *      setter beside its only reader. Selectors are unchanged by the move.
 *
 *      Storage stays in `LibVaipakam` (`rateModel` and the three band knobs,
 *      read through its `cfg*` helpers).
 */
contract RateModelFacet is DiamondAccessControl {
    /// @notice Emitted on every change to the #400 quote-time rate model.
    /// @custom:event-category informational/config
    event RateModelSet(address indexed previousModel, address indexed newModel);

    /// @notice Emitted on every change to the #400 / #2748 rate-model band.
    ///         Each value is as stored: `0` means that knob's default.
    /// @param  maxPointsBps  The points cap, in absolute APR basis points.
    /// @param  relativeBps   The share of the reference rate, in basis points of it.
    /// @param  minPointsBps  The points floor, in absolute APR basis points.
    /// @custom:event-category informational/config
    event RateModelBandSet(uint16 maxPointsBps, uint16 relativeBps, uint16 minPointsBps);

    /// @notice REGISTER (or change) the active #400 quote-time {IRateModel}.
    /// @dev    The ENABLE direction (risk-INCREASING — a model can shift the
    ///         rate automated offers post at), so ADMIN_ROLE-only → governance
    ///         **timelock** after handover. The fast risk-DECREASING direction
    ///         is `disableRateModel()` (a WATCHER/guardian can flip it off
    ///         instantly) — the #393 §4 enable-slow / disable-fast asymmetry.
    ///         A non-zero model must have bytecode (catches an EOA paste).
    ///         The model is consumed ONLY by this facet's resolver
    ///         (`quoteOfferRateBps`), whose output is clamped to the band
    ///         around the caller's reference rate (`setRateModelBand`); it
    ///         never re-prices a matched/live loan (E2) and never overwrites a
    ///         manually-typed offer rate.
    /// @param  newModel The rate-model contract (non-zero). Use
    ///         `disableRateModel()` to turn it off.
    function setRateModel(address newModel) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (newModel == address(0)) revert UseDisableRateModel();
        if (newModel.code.length == 0) revert RateModelNotContract();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        emit RateModelSet(s.rateModel, newModel);
        s.rateModel = newModel;
    }

    /// @notice FAST-disable the rate model → revert to the IDENTITY model (the
    ///         user-supplied rate stands). The risk-DECREASING half of the
    ///         enable-slow / disable-fast asymmetry: callable by WATCHER_ROLE
    ///         (the constrained fast-incident key, like `autoPause`) as well as
    ///         ADMIN_ROLE, so a misbehaving model can be killed without waiting
    ///         on the enable-side timelock.
    function disableRateModel() external {
        if (
            !LibAccessControl.hasRole(LibAccessControl.WATCHER_ROLE, msg.sender) &&
            !LibAccessControl.hasRole(LibAccessControl.ADMIN_ROLE, msg.sender)
        ) revert NotWatcherOrAdmin();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.rateModel != address(0)) {
            emit RateModelSet(s.rateModel, address(0));
            s.rateModel = address(0);
        }
    }

    /// @notice The active #400 rate model, or `address(0)` for identity.
    function getRateModel() external view returns (address) {
        return LibVaipakam.cfgRateModel();
    }

    /// @notice Set the #400 / #2748 rate-model band: how far a registered
    ///         model may move an automated quote from the caller's reference
    ///         (market) rate. The band is `ref ± halfWidth` (floored at 0), with
    ///         `halfWidth = max(minPoints, min(maxPoints, ref × relative / 10_000))`
    ///         — the tighter of a points cap and a share of the reference,
    ///         never narrower than a points floor. With the defaults (5 points,
    ///         50%, 1 point) a 1% market allows 0%–2%, a 4% market 2%–6% and a
    ///         12% market 7%–17%.
    /// @dev    ADMIN_ROLE-only. Each argument `0` resets that knob to its
    ///         library default; a non-zero value is range-checked:
    ///         `maxPointsBps` to [50, 2_500] (± 0.5 to ± 25 points),
    ///         `relativeBps` to [500, 10_000] (± 5% to ± 100% of the reference),
    ///         `minPointsBps` to [10, 500] (± 0.1 to ± 5 points). The effective
    ///         floor must not exceed the effective cap.
    /// @param  maxPointsBps The points cap, in absolute APR basis points.
    /// @param  relativeBps  The share of the reference rate, in basis points of it.
    /// @param  minPointsBps The points floor, in absolute APR basis points.
    function setRateModelBand(
        uint16 maxPointsBps,
        uint16 relativeBps,
        uint16 minPointsBps
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (
            !_inRangeOrZero(maxPointsBps, LibVaipakam.MIN_RATE_MODEL_MAX_DEVIATION_BPS, LibVaipakam.MAX_RATE_MODEL_MAX_DEVIATION_BPS) ||
            !_inRangeOrZero(relativeBps, LibVaipakam.MIN_RATE_MODEL_RELATIVE_DEVIATION_BPS, LibVaipakam.MAX_RATE_MODEL_RELATIVE_DEVIATION_BPS) ||
            !_inRangeOrZero(minPointsBps, LibVaipakam.MIN_RATE_MODEL_MIN_DEVIATION_BPS, LibVaipakam.MAX_RATE_MODEL_MIN_DEVIATION_BPS)
        ) revert InvalidRateModelDeviation();
        uint256 cap = maxPointsBps == 0 ? LibVaipakam.RATE_MODEL_MAX_DEVIATION_BPS_DEFAULT : maxPointsBps;
        uint256 floor = minPointsBps == 0 ? LibVaipakam.RATE_MODEL_MIN_DEVIATION_BPS_DEFAULT : minPointsBps;
        if (floor > cap) revert InvalidRateModelDeviation();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.rateModelMaxDeviationBps = maxPointsBps;
        s.rateModelRelativeDeviationBps = relativeBps;
        s.rateModelMinDeviationBps = minPointsBps;
        emit RateModelBandSet(maxPointsBps, relativeBps, minPointsBps);
    }

    /// @dev `v` is zero (the knob's default) or inside `[lo, hi]`.
    function _inRangeOrZero(uint16 v, uint256 lo, uint256 hi) private pure returns (bool) {
        return v == 0 || (v >= lo && v <= hi);
    }

    /// @notice The effective points cap of the rate-model band, in absolute
    ///         APR basis points.
    function getRateModelMaxDeviationBps() external view returns (uint256) {
        return LibVaipakam.cfgRateModelMaxDeviationBps();
    }

    /// @notice The effective share of the rate-model band, in basis points of
    ///         the reference rate.
    function getRateModelRelativeDeviationBps() external view returns (uint256) {
        return LibVaipakam.cfgRateModelRelativeDeviationBps();
    }

    /// @notice The effective points floor of the rate-model band, in absolute
    ///         APR basis points.
    function getRateModelMinDeviationBps() external view returns (uint256) {
        return LibVaipakam.cfgRateModelMinDeviationBps();
    }

    /// @notice A non-zero rate model address had no bytecode (likely an EOA).
    error RateModelNotContract();
    /// @notice `setRateModel(address(0))` — use `disableRateModel()` instead.
    error UseDisableRateModel();
    /// @notice Caller is neither WATCHER_ROLE nor ADMIN_ROLE.
    error NotWatcherOrAdmin();
    /// @notice A rate-model band knob is outside its range, or the floor
    ///         exceeds the cap (`setRateModelBand`).
    error InvalidRateModelDeviation();

    /// @notice #400 — resolve the active quote-time {IRateModel} for a given
    ///         input. Returns `input.referenceRateBps` verbatim when no model
    ///         is registered (the IDENTITY default), else the model's quote.
    /// @dev    PURE READ — this never mutates an offer and is never called by
    ///         the manual create path (a human's typed rate is binding). It is
    ///         the single resolver the dApp calls for rate *guidance* and the
    ///         automated/delegated-pricing flows (#393 auto-lend / auto-roll /
    ///         keeper-posted intents, #394 risk premiums) call to price the
    ///         offers they create on a user's behalf — they then pass the
    ///         result as that offer's rate via the normal create path. Keeping
    ///         pricing in the *caller* (not forced on every offer) is what
    ///         preserves the human order book's market-driven price discovery.
    ///         The returned value is still subject to the usual
    ///         range-ordering + `MAX_INTEREST_BPS` checks when an offer is
    ///         actually created with it.
    function quoteOfferRateBps(
        IRateModel.RateModelInput calldata input
    ) external view returns (uint256 rateBps) {
        address rateModel = LibVaipakam.cfgRateModel();
        if (rateModel == address(0)) return input.referenceRateBps; // identity

        uint256 quoted = IRateModel(rateModel).quoteRateBps(input);

        // #400 (hardening) — CLAMP the model to a band around the reference
        // (market) rate. This is the anti-rate-setting guarantee: a registered
        // model — even a buggy or adversarial one — can only nudge the rate
        // around the market anchor the caller supplies, never drive an
        // automated offer far off-market (instant-loss-fill if too low,
        // idle-capital if too high). Enforced HERE in the substrate so every
        // consumer inherits it, not trusted to each caller. #2748 — the band's
        // half-width is the tighter of a points cap and a share of the
        // reference, never below a points floor (`cfgRateModelBandHalfWidthBps`).
        uint256 ref = input.referenceRateBps;
        uint256 dev = LibVaipakam.cfgRateModelBandHalfWidthBps(ref);
        uint256 lo = ref > dev ? ref - dev : 0;
        uint256 hi = ref + dev;
        if (quoted < lo) quoted = lo;
        else if (quoted > hi) quoted = hi;
        // The usual protocol ceiling still binds when an offer is created with
        // this rate; mirror it here so a guidance read never returns above it.
        if (quoted > LibVaipakam.MAX_INTEREST_BPS) quoted = LibVaipakam.MAX_INTEREST_BPS;
        return quoted;
    }
}
