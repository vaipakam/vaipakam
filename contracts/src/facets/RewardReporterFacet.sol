// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IRewardOApp} from "../interfaces/IRewardOApp.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";

/**
 * @title RewardReporterFacet
 * @author Vaipakam Developer Team
 * @notice Every-chain half of the cross-chain reward accounting mesh
 *         described in docs/TokenomicsTechSpec.md §4a. Owns the mirror-
 *         side day-close emission AND the broadcast ingress that lets
 *         mirrors know the finalized global denominator for each day.
 *
 * @dev Runs on BOTH canonical (Base) and mirror Diamonds. Behaviour forks
 *      by `isCanonicalRewardChain`:
 *        - Base:   {closeDay} writes the local chain's `(lender, borrower)`
 *                  Numeraire18 pair directly into the aggregator sub-storage
 *                  keyed by `localEid`; no LayerZero packet is needed
 *                  because Base is its own aggregator.
 *        - Mirror: {closeDay} forwards the pair via `IRewardOApp.sendChainReport`
 *                  to the Base-side OApp, paying LZ native fee out of
 *                  `msg.value`. The OApp delivers into
 *                  `RewardAggregatorFacet.onChainReportReceived` on Base.
 *
 *      {onRewardBroadcastReceived} is the mirror-side trusted ingress
 *      handler: when Base finalizes day `D`, its OApp broadcasts the
 *      pair back and the mirror's OApp invokes this method, which
 *      populates `knownGlobal*InterestNumeraire18[D]` used by the §4 formula.
 *      Gated to `rewardOApp` — no other address may write these values.
 *
 *      Admin surface configures the cross-chain wiring (OApp address,
 *      local/Base eids, canonical flag, grace window) under
 *      `ADMIN_ROLE`. Each setter is one-shot + replaceable.
 */
contract RewardReporterFacet is
    DiamondAccessControl,
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    /// @notice Default grace window applied when the admin has not set
    ///         `rewardGraceSeconds` — 4 hours for Phase 1. Admin may
    ///         widen or tighten per spec §4a via {setRewardGraceSeconds}.
    uint64 internal constant DEFAULT_REWARD_GRACE_SECONDS = 4 hours;

    /// @notice Emitted when the local chain reports its day-`D` interest
    ///         totals — directly to aggregator storage on Base, or via
    ///         the OApp on a mirror.
    /// @param dayId                 Interaction day being reported.
    /// @param sourceEid             LayerZero eid of the source (local) chain.
    /// @param lenderNumeraire18           Local lender USD-18 interest on `dayId`.
    /// @param borrowerNumeraire18         Local borrower USD-18 interest on `dayId`.
    /// @param viaOApp               False iff recorded directly (Base path).
    event ChainInterestReported(
        uint256 indexed dayId,
        uint32 indexed sourceEid,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        bool viaOApp
    );

    /// @notice Emitted when the mirror-side ingress writes the finalized
    ///         global denominator for `dayId`. On Base this event also
    ///         fires during {RewardAggregatorFacet.finalizeDay} via the
    ///         shared write path.
    /// @param dayId                 Day whose denominator landed.
    /// @param globalLenderNumeraire18     Finalized global lender denominator.
    /// @param globalBorrowerNumeraire18   Finalized global borrower denominator.
    event KnownGlobalInterestSet(
        uint256 indexed dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18
    );

    /// @notice Emitted on any admin setter touching the cross-chain wiring.
    event RewardReporterConfigUpdated(
        bytes32 indexed key,
        bytes32 oldValue,
        bytes32 newValue
    );

    // ─── Day-close emission (public, permissionless) ────────────────────────

    /**
     * @notice Snapshot this chain's local `(lender, borrower)` Numeraire18
     *         interest totals for `dayId` and publish them to the
     *         canonical aggregator.
     * @dev Permissionless — any address may close a day once it is fully
     *      elapsed. Idempotent per `dayId` via `chainReportSentAt`.
     *
     *      Behaviour by chain kind:
     *        - Canonical (Base): writes the pair directly into
     *          `chainDaily{Lender,Borrower}InterestNumeraire18[dayId][localEid]`
     *          and increments `chainDailyReportCount[dayId]`. No
     *          LayerZero fee required; any `msg.value` is refunded.
     *        - Mirror: forwards the pair via
     *          {IRewardOApp.sendChainReport}. `msg.value` MUST cover the
     *          LZ native fee; the OApp refunds leftover to the caller.
     *
     *      Reverts:
     *        - `RewardDayNotElapsed` if `dayId` ≥ `currentDay`.
     *        - `ChainDayAlreadyReported` if the local report already fired.
     *        - `RewardOAppNotSet` / `BaseEidNotSet` on mirror chains that
     *          have not been wired yet.
     *
     *      Whenever the write is recorded into aggregator storage on the
     *      Base path, this facet updates `dailyFirstReportAt[dayId]` so
     *      the grace-window clock starts ticking.
     * @param dayId Day index (spec §4 emission schedule) to close.
     */
    function closeDay(
        uint256 dayId
    ) external payable nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        (uint256 today, bool active) = LibInteractionRewards.currentDayOrZero();
        // Only CLOSED (strictly past) days may be reported — the current
        // day is still accruing, reporting it would be lossy.
        if (!active || dayId >= today) revert RewardDayNotElapsed();
        if (s.chainReportSentAt[dayId] != 0) revert ChainDayAlreadyReported();

        // Fold entry-driven deltas into `totalLenderInterestNumeraire18[dayId]` /
        // `totalBorrowerInterestNumeraire18[dayId]` before snapshotting so the
        // cross-chain numerator reflects every accrued loan-day, not just
        // the legacy per-day counters.
        LibInteractionRewards.advanceLenderThrough(dayId);
        LibInteractionRewards.advanceBorrowerThrough(dayId);

        uint256 lenderNumeraire18 = s.totalLenderInterestNumeraire18[dayId];
        uint256 borrowerNumeraire18 = s.totalBorrowerInterestNumeraire18[dayId];

        s.chainReportSentAt[dayId] = uint64(block.timestamp);

        if (s.isCanonicalRewardChain) {
            // Base writes directly — bypass LayerZero for its own numbers.
            uint32 eid = s.localEid;
            _recordChainReportLocal(s, dayId, eid, lenderNumeraire18, borrowerNumeraire18);
            emit ChainInterestReported(
                dayId,
                eid,
                lenderNumeraire18,
                borrowerNumeraire18,
                /* viaOApp */ false
            );

            // Refund any stray msg.value — canonical path is LZ-free.
            if (msg.value != 0) {
                (bool ok, ) = msg.sender.call{value: msg.value}("");
                require(ok, "refund failed");
            }
        } else {
            address oApp = s.rewardOApp;
            if (oApp == address(0)) revert RewardOAppNotSet();
            if (s.baseEid == 0) revert BaseEidNotSet();

            emit ChainInterestReported(
                dayId,
                s.localEid,
                lenderNumeraire18,
                borrowerNumeraire18,
                /* viaOApp */ true
            );

            // Forward full msg.value; OApp refunds the caller directly.
            IRewardOApp(oApp).sendChainReport{value: msg.value}(
                dayId,
                lenderNumeraire18,
                borrowerNumeraire18,
                payable(msg.sender)
            );
        }
    }

    /// @dev Shared write path for Base-side "my own chain's report"
    ///      and for the aggregator's LayerZero-ingress record hook.
    ///      NOT public — the aggregator calls it through its own trusted
    ///      path. Left `internal` so RewardAggregatorFacet's sibling code
    ///      (same Diamond, same storage) can reuse it by re-implementing
    ///      the body — every facet compiles separately.
    function _recordChainReportLocal(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint32 sourceEid,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18
    ) internal {
        s.chainDailyLenderInterestNumeraire18[dayId][sourceEid] = lenderNumeraire18;
        s.chainDailyBorrowerInterestNumeraire18[dayId][sourceEid] = borrowerNumeraire18;
        if (!s.chainDailyReported[dayId][sourceEid]) {
            s.chainDailyReported[dayId][sourceEid] = true;
            unchecked {
                s.chainDailyReportCount[dayId] += 1;
            }
        }
        if (s.dailyFirstReportAt[dayId] == 0) {
            s.dailyFirstReportAt[dayId] = uint64(block.timestamp);
        }
    }

    // ─── Mirror-side trusted broadcast ingress ──────────────────────────────

    /**
     * @notice Trusted ingress: the OApp delivers Base's finalized global
     *         denominator for `dayId` and this function stamps it into
     *         `knownGlobal{Lender,Borrower}InterestNumeraire18` so local
     *         {LibInteractionRewards.claimForUserWindow} can use it.
     * @dev Gated to the Diamond's registered `rewardOApp`. First call for
     *      `dayId` writes the pair; repeat calls must carry the SAME
     *      numbers (idempotent on match, revert `KnownGlobalAlreadySet`
     *      on divergence).
     *
     *      Works on Base too: {RewardAggregatorFacet.finalizeDay} funnels
     *      Base's own finalization through the same storage slot (via a
     *      direct write, not this function), so Base-side claims read
     *      the identical denominator without needing a LayerZero packet.
     * @param dayId                 Day being broadcast.
     * @param globalLenderNumeraire18     Finalized global lender denominator.
     * @param globalBorrowerNumeraire18   Finalized global borrower denominator.
     */
    function onRewardBroadcastReceived(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardOApp || s.rewardOApp == address(0)) {
            revert NotAuthorizedRewardOApp();
        }

        if (s.knownGlobalSet[dayId]) {
            // Idempotent re-delivery is fine — LayerZero retries can
            // duplicate a packet. Divergent values must never overwrite.
            if (
                s.knownGlobalLenderInterestNumeraire18[dayId] != globalLenderNumeraire18 ||
                s.knownGlobalBorrowerInterestNumeraire18[dayId] != globalBorrowerNumeraire18
            ) {
                revert KnownGlobalAlreadySet();
            }
            return;
        }

        s.knownGlobalLenderInterestNumeraire18[dayId] = globalLenderNumeraire18;
        s.knownGlobalBorrowerInterestNumeraire18[dayId] = globalBorrowerNumeraire18;
        s.knownGlobalSet[dayId] = true;

        emit KnownGlobalInterestSet(
            dayId,
            globalLenderNumeraire18,
            globalBorrowerNumeraire18
        );
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    /// @notice Register (or rotate) the LayerZero OApp authorized to
    ///         deliver cross-chain reward messages on this Diamond.
    /// @dev ADMIN_ROLE-gated. Passing `address(0)` disables the OApp
    ///      ingress until a new one is wired.
    /// @param oApp VaipakamRewardOApp proxy address on this chain.
    function setRewardOApp(
        address oApp
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address old = s.rewardOApp;
        s.rewardOApp = oApp;
        emit RewardReporterConfigUpdated(
            bytes32("rewardOApp"),
            bytes32(uint256(uint160(old))),
            bytes32(uint256(uint160(oApp)))
        );
    }

    /// @notice Set this Diamond's own LayerZero endpoint id — the key the
    ///         Base aggregator uses to index this chain's reports.
    /// @param eid LayerZero V2 endpoint id of the active chain.
    function setLocalEid(
        uint32 eid
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint32 old = s.localEid;
        s.localEid = eid;
        emit RewardReporterConfigUpdated(
            bytes32("localEid"),
            bytes32(uint256(old)),
            bytes32(uint256(eid))
        );
    }

    /// @notice Set the canonical (Base) LayerZero endpoint id — the
    ///         destination for mirror-side chain reports. Zero on Base.
    /// @param eid LayerZero V2 endpoint id of the canonical reward chain.
    function setBaseEid(
        uint32 eid
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint32 old = s.baseEid;
        s.baseEid = eid;
        emit RewardReporterConfigUpdated(
            bytes32("baseEid"),
            bytes32(uint256(old)),
            bytes32(uint256(eid))
        );
    }

    /// @notice Flip this Diamond's canonical-reward-chain flag.
    ///         Must be `true` on exactly one Diamond in the mesh (Base).
    /// @param on Canonical flag value.
    function setIsCanonicalRewardChain(
        bool on
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bool old = s.isCanonicalRewardChain;
        s.isCanonicalRewardChain = on;
        emit RewardReporterConfigUpdated(
            bytes32("isCanonicalRewardChain"),
            bytes32(uint256(old ? 1 : 0)),
            bytes32(uint256(on ? 1 : 0))
        );
    }

    /// @notice Adjust the grace window after the first chain report for
    ///         day `D` within which `finalizeDay(D)` may be called even
    ///         if not every expected mirror has reported.
    /// @param secondsValue Grace duration in seconds (default 4h when
    ///                     zero — see {DEFAULT_REWARD_GRACE_SECONDS}).
    function setRewardGraceSeconds(
        uint64 secondsValue
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        // Setter-range audit (2026-05-02): added bounds. Without
        // them, a compromised admin could set `secondsValue=0`
        // (collapsing grace to instant) or `type(uint64).max`
        // (effectively infinite grace, defeating the purpose).
        // Zero is rejected — operators wanting "library default"
        // can pass {LibVaipakam.REWARD_GRACE_MIN_SECONDS} explicitly.
        if (
            secondsValue < LibVaipakam.REWARD_GRACE_MIN_SECONDS ||
            secondsValue > LibVaipakam.REWARD_GRACE_MAX_SECONDS
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "rewardGraceSeconds",
                uint256(secondsValue),
                uint256(LibVaipakam.REWARD_GRACE_MIN_SECONDS),
                uint256(LibVaipakam.REWARD_GRACE_MAX_SECONDS)
            );
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint64 old = s.rewardGraceSeconds;
        s.rewardGraceSeconds = secondsValue;
        emit RewardReporterConfigUpdated(
            bytes32("rewardGraceSeconds"),
            bytes32(uint256(old)),
            bytes32(uint256(secondsValue))
        );
    }

    /// @notice Single-field getter for the reward grace seconds. Added
    ///         for the protocol-console knob schema (per-knob single-
    ///         value getters).
    function getRewardGraceSeconds() external view returns (uint64) {
        return LibVaipakam.storageSlot().rewardGraceSeconds;
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice Returns the local (this chain's) unreported totals on `dayId`.
    /// @param dayId Day being queried.
    /// @return lenderNumeraire18   Local lender USD-18 on `dayId`.
    /// @return borrowerNumeraire18 Local borrower USD-18 on `dayId`.
    function getLocalChainInterestNumeraire18(
        uint256 dayId
    ) external view returns (uint256 lenderNumeraire18, uint256 borrowerNumeraire18) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.totalLenderInterestNumeraire18[dayId],
            s.totalBorrowerInterestNumeraire18[dayId]
        );
    }

    /// @notice `block.timestamp` at which {closeDay} succeeded for `dayId`
    ///         on this chain (0 ⇒ not yet closed).
    function getChainReportSentAt(
        uint256 dayId
    ) external view returns (uint64) {
        return LibVaipakam.storageSlot().chainReportSentAt[dayId];
    }

    /// @notice Finalized global denominator pair known on this chain for
    ///         `dayId` (zero pair ⇒ not yet broadcast here).
    /// @return globalLenderNumeraire18   Finalized lender denominator on `dayId`.
    /// @return globalBorrowerNumeraire18 Finalized borrower denominator on `dayId`.
    /// @return isSet               True iff the pair was populated for `dayId`.
    function getKnownGlobalInterestNumeraire18(
        uint256 dayId
    )
        external
        view
        returns (
            uint256 globalLenderNumeraire18,
            uint256 globalBorrowerNumeraire18,
            bool isSet
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.knownGlobalLenderInterestNumeraire18[dayId],
            s.knownGlobalBorrowerInterestNumeraire18[dayId],
            s.knownGlobalSet[dayId]
        );
    }

    /// @notice Snapshot the cross-chain reward wiring in one call — for
    ///         deploy / ops dashboards.
    /// @return rewardOApp              Registered OApp address.
    /// @return localEid                This chain's LZ eid.
    /// @return baseEid                 Canonical chain's LZ eid.
    /// @return isCanonicalRewardChain  Canonical flag.
    /// @return rewardGraceSeconds      Grace window (0 ⇒ default 4h).
    function getRewardReporterConfig()
        external
        view
        returns (
            address rewardOApp,
            uint32 localEid,
            uint32 baseEid,
            bool isCanonicalRewardChain,
            uint64 rewardGraceSeconds
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.rewardOApp,
            s.localEid,
            s.baseEid,
            s.isCanonicalRewardChain,
            s.rewardGraceSeconds == 0
                ? DEFAULT_REWARD_GRACE_SECONDS
                : s.rewardGraceSeconds
        );
    }
}
