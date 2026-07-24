// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {
    IRewardMessenger,
    RewardBroadcastV2
} from "../interfaces/IRewardMessenger.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice #1222 M3 B1 (Codex #1413 r3) — the pre-widening sender shape, the
///         `closeDay` fallback target when the bound messenger has not been
///         upgraded to the six-argument surface yet. Both messenger
///         generations expose it (the pre-#1222 build natively, the widened
///         build via its legacy overload).
interface IRewardMessengerLegacySend {
    function sendChainReport(
        uint256 dayId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        address payable refundAddress
    ) external payable;
}

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
 *                  keyed by `block.chainid`; no cross-chain message is
 *                  needed because Base is its own aggregator.
 *        - Mirror: {closeDay} forwards the pair via `IRewardMessenger.sendChainReport`
 *                  to the Base-side reward messenger, paying the CCIP
 *                  native fee out of `msg.value`. The messenger delivers
 *                  into `RewardAggregatorFacet.onChainReportReceived` on Base.
 *
 *      {onRewardBroadcastReceived} is the mirror-side trusted ingress
 *      handler: when Base finalizes day `D`, its messenger broadcasts the
 *      pair back and the mirror's messenger invokes this method, which
 *      populates `knownGlobal*InterestNumeraire18[D]` used by the §4 formula.
 *      Gated to `rewardMessenger` — no other address may write these values.
 *
 *      Admin surface configures the cross-chain wiring (messenger address,
 *      canonical Base chain id, canonical flag, grace window) under
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
    ///         the messenger on a mirror.
    /// @param dayId                 Interaction day being reported.
    /// @param sourceChainId         EVM chain id of the source (local) chain.
    /// @param lenderNumeraire18           Local lender USD-18 interest on `dayId`.
    /// @param borrowerNumeraire18         Local borrower USD-18 interest on `dayId`.
    /// @param viaMessenger               False iff recorded directly (Base path).
    /// @custom:event-category informational/reward-transport
    event ChainInterestReported(
        uint256 indexed dayId,
        uint32 indexed sourceChainId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        bool viaMessenger
    );

    /// @notice Emitted when the mirror-side ingress writes the finalized
    ///         global denominator for `dayId`. On Base this event also
    ///         fires during {RewardAggregatorFacet.finalizeDay} via the
    ///         shared write path.
    /// @param dayId                 Day whose denominator landed.
    /// @param globalLenderNumeraire18     Finalized global lender denominator.
    /// @param globalBorrowerNumeraire18   Finalized global borrower denominator.
    /// @custom:event-category informational/reward-transport
    event KnownGlobalInterestSet(
        uint256 indexed dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18
    );

    /// @notice Emitted on any admin setter touching the cross-chain wiring.
    /// @custom:event-category informational/config
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
     *          `chainDaily{Lender,Borrower}InterestNumeraire18[dayId][block.chainid]`
     *          and increments `chainDailyReportCount[dayId]`. No
     *          cross-chain fee required; any `msg.value` is refunded.
     *        - Mirror: forwards the pair via
     *          {IRewardMessenger.sendChainReport}. `msg.value` MUST cover the
     *          CCIP native fee; the messenger refunds leftover to the caller.
     *
     *      Reverts:
     *        - `RewardDayNotElapsed` if `dayId` ≥ `currentDay`.
     *        - `ChainDayAlreadyReported` if the local report already fired.
     *        - `RewardMessengerNotSet` / `BaseChainIdNotSet` on mirror chains that
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
        // #1195 E3 (Pass-2) — reject a late self-report AFTER the day has been
        // finalized, matching the mirror ingress guard in `RewardAggregatorFacet`
        // (`onChainReportReceived`). Storing a post-finalization report is
        // payout-benign but poisons the `backfillDayInclusion` predicate and the
        // audit trail; the Base path must fail-loud like the mirror path.
        if (s.dailyGlobalFinalized[dayId]) revert ReportAfterFinalization();

        // Fold entry-driven deltas into `totalLenderInterestNumeraire18[dayId]` /
        // `totalBorrowerInterestNumeraire18[dayId]` before snapshotting so the
        // cross-chain numerator reflects every accrued loan-day, not just
        // the legacy per-day counters.
        LibInteractionRewards.advanceLenderThrough(dayId);
        LibInteractionRewards.advanceBorrowerThrough(dayId);

        uint256 lenderNumeraire18 = s.totalLenderInterestNumeraire18[dayId];
        uint256 borrowerNumeraire18 = s.totalBorrowerInterestNumeraire18[dayId];
        // #1222 M3 B1 — this chain's recycled figures ride the same day-close:
        // the MONOTONIC cumulative (Base's availability ledger self-heals from
        // it across missed reports) and the day-bucketed credit total for the
        // closing day (`Ā`'s per-day attribution). `dayId` is strictly past,
        // so its `recycledCreditedByDay` bucket is complete. Read through the
        // library helper so a diamond refreshed over live pre-#1222 state
        // reports its pre-upgrade absorption too (Codex #1413 r5).
        uint256 recycledCumulative18 = LibVpfiRecycle.creditedCumulative(s);
        uint256 recycledForDay18 = s.recycledCreditedByDay[dayId];

        s.chainReportSentAt[dayId] = uint64(block.timestamp);

        if (s.isCanonicalRewardChain) {
            // Base writes directly — no cross-chain hop for its own numbers.
            uint32 chainId = uint32(block.chainid);
            _recordChainReportLocal(
                s,
                dayId,
                chainId,
                lenderNumeraire18,
                borrowerNumeraire18,
                recycledCumulative18,
                recycledForDay18
            );
            emit ChainInterestReported(
                dayId,
                chainId,
                lenderNumeraire18,
                borrowerNumeraire18,
                /* viaMessenger */ false
            );

            // Refund any stray msg.value — canonical path is fee-free.
            if (msg.value != 0) {
                (bool ok, ) = msg.sender.call{value: msg.value}("");
                require(ok, "refund failed");
            }
        } else {
            address messenger = s.rewardMessenger;
            if (messenger == address(0)) revert RewardMessengerNotSet();
            if (s.baseChainId == 0) revert BaseChainIdNotSet();

            emit ChainInterestReported(
                dayId,
                uint32(block.chainid),
                lenderNumeraire18,
                borrowerNumeraire18,
                /* viaMessenger */ true
            );

            // Forward full msg.value; messenger refunds the caller directly.
            // Codex #1413 r3 — rollout shim: an upgraded mirror diamond in
            // front of a not-yet-upgraded messenger falls back to the legacy
            // four-argument send (recycled figures simply don't travel until
            // the messenger is current), so the permissionless day-close
            // never reverts through the upgrade window. Codex r4 P1 — the
            // fallback fires ONLY on the missing-selector shape (a pre-#1222
            // messenger has no receive path for the unknown selector and
            // reverts with EMPTY data); every reasoned failure — paused,
            // InsufficientFee from a caller who quoted the legacy shape —
            // bubbles unchanged, because downgrading a current messenger's
            // real failure to a legacy send would permanently strip the
            // day's recycled fields (`chainReportSentAt` blocks a resend).
            try IRewardMessenger(messenger).sendChainReport{value: msg.value}(
                dayId,
                lenderNumeraire18,
                borrowerNumeraire18,
                recycledCumulative18,
                recycledForDay18,
                payable(msg.sender)
            ) {} catch (bytes memory reason) {
                if (reason.length != 0) {
                    assembly ("memory-safe") {
                        revert(add(reason, 0x20), mload(reason))
                    }
                }
                // A failed six-argument attempt returned its full value;
                // the fallback re-forwards it.
                IRewardMessengerLegacySend(messenger).sendChainReport{
                    value: msg.value
                }(
                    dayId,
                    lenderNumeraire18,
                    borrowerNumeraire18,
                    payable(msg.sender)
                );
            }
        }
    }

    /// @dev Shared write path for Base-side "my own chain's report"
    ///      and for the aggregator's cross-chain-ingress record hook.
    ///      NOT public — the aggregator calls it through its own trusted
    ///      path. Left `internal` so RewardAggregatorFacet's sibling code
    ///      (same Diamond, same storage) can reuse it by re-implementing
    ///      the body — every facet compiles separately.
    function _recordChainReportLocal(
        LibVaipakam.Storage storage s,
        uint256 dayId,
        uint32 sourceChainId,
        uint256 lenderNumeraire18,
        uint256 borrowerNumeraire18,
        uint256 recycledCumulative18,
        uint256 recycledForDay18
    ) internal {
        s.chainDailyLenderInterestNumeraire18[dayId][sourceChainId] = lenderNumeraire18;
        s.chainDailyBorrowerInterestNumeraire18[dayId][sourceChainId] = borrowerNumeraire18;
        // #1222 M3 B1 — Base records its OWN chain in the per-chain recycled
        // ledger through the same helper the mirror ingress uses, so both
        // paths write identically and B2/B3's netting sees one uniform ledger.
        LibVpfiRecycle.recordChainRecycled(
            s, sourceChainId, dayId, recycledCumulative18, recycledForDay18
        );
        if (!s.chainDailyReported[dayId][sourceChainId]) {
            s.chainDailyReported[dayId][sourceChainId] = true;
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
     * @notice Trusted ingress: the messenger delivers Base's finalized global
     *         denominator for `dayId` and this function stamps it into
     *         `knownGlobal{Lender,Borrower}InterestNumeraire18` so local
     *         {LibInteractionRewards.claimForUserWindow} can use it.
     * @dev Gated to the Diamond's registered `rewardMessenger`. First call for
     *      `dayId` writes the pair; repeat calls must carry the SAME
     *      numbers (idempotent on match, revert `KnownGlobalAlreadySet`
     *      on divergence).
     *
     *      Works on Base too: {RewardAggregatorFacet.finalizeDay} funnels
     *      Base's own finalization through the same storage slot (via a
     *      direct write, not this function), so Base-side claims read
     *      the identical denominator without needing a CCIP message.
     * @param dayId                 Day being broadcast.
     * @param globalLenderNumeraire18     Finalized global lender denominator.
     * @param globalBorrowerNumeraire18   Finalized global borrower denominator.
     */
    function onRewardBroadcastReceived(
        uint256 dayId,
        uint256 globalLenderNumeraire18,
        uint256 globalBorrowerNumeraire18,
        uint256 capThreshold18,
        uint256 scheduleFloorHalf,
        uint256 recycledHalf,
        uint256 armedFromDay
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardMessenger || s.rewardMessenger == address(0)) {
            revert NotAuthorizedRewardMessenger();
        }

        if (s.knownGlobalSet[dayId]) {
            // Idempotent re-delivery is fine — CCIP retries can
            // duplicate a packet. Divergent values must never overwrite.
            // #1008 (S13) — `capThreshold18` is part of the broadcast's
            // consensus value, so a divergent-threshold replay reverts too
            // (Codex #1147 r7 K6). PR-3c — the composition halves join the
            // consensus tuple for the same reason.
            LibVaipakam.DayPoolStamp storage prior = s.dayPoolStamp[dayId];
            if (
                s.knownGlobalLenderInterestNumeraire18[dayId] != globalLenderNumeraire18 ||
                s.knownGlobalBorrowerInterestNumeraire18[dayId] != globalBorrowerNumeraire18 ||
                s.dayCapThreshold18[dayId] != capThreshold18 ||
                (prior.stamped &&
                    (uint256(prior.scheduleFloor) != scheduleFloorHalf * 2 ||
                        uint256(prior.recycledBudget) != recycledHalf * 2))
            ) {
                revert KnownGlobalAlreadySet();
            }
            return;
        }

        s.knownGlobalLenderInterestNumeraire18[dayId] = globalLenderNumeraire18;
        s.knownGlobalBorrowerInterestNumeraire18[dayId] = globalBorrowerNumeraire18;
        // #1008 (S13) — store the CANONICAL threshold from Base; mirrors never
        // recompute locally, so Base + every mirror cap identically.
        LibInteractionRewards.setBroadcastDayCapThreshold(dayId, capThreshold18);
        // Governor PR-3c (#1217 §6/§8) — store the Base-stamped day-pool
        // composition verbatim so the mirror's dual accumulators price the
        // IDENTICAL dailyPool (never recomputed locally; margin/Ā stay 0 —
        // they are Base-side transparency fields). The arming day travels
        // in-band too, so mirrors arm on the same D* with zero operator
        // drift (a mirror only ever moves it forward from unset).
        s.dayPoolStamp[dayId] = LibVaipakam.DayPoolStamp({
            scheduleFloor: SafeCast.toUint128(scheduleFloorHalf * 2),
            recycledBudget: SafeCast.toUint128(recycledHalf * 2),
            aBarAtFinalize: 0,
            marginBpsAtFinalize: 0,
            stamped: true
        });
        if (armedFromDay != 0 && s.governorCommitArmedFromDay == 0) {
            s.governorCommitArmedFromDay = armedFromDay;
        }
        s.knownGlobalSet[dayId] = true;

        emit KnownGlobalInterestSet(
            dayId,
            globalLenderNumeraire18,
            globalBorrowerNumeraire18
        );
    }

    /// @notice #1222 M3 B2-b — a V2 broadcast was applied on this mirror:
    ///         the consensus pair + cap family landed, the chain's own
    ///         funded stamp was written, and the local recycle bucket
    ///         surrendered its instructed slice (consume-on-arrival).
    /// @custom:event-category informational/reward-governor
    event RewardBroadcastV2Applied(
        uint256 indexed dayId,
        uint256 recycleConsume
    );

    /**
     * @notice #1222 M3 B2-b — trusted ingress for the per-destination V2
     *         broadcast: Base's finalized consensus fields plus THIS
     *         chain's own funded figures for `dayId`.
     * @dev Messenger-gated. Applies, in order:
     *
     *      1. Replay-stable binding — the packet's embedded `destChainId`
     *         must equal `block.chainid` (a delayed delivery after a
     *         destination-list edit or a governance replay must never
     *         apply another chain's figures here).
     *      2. Whole-day idempotency — the first application sets
     *         `broadcastV2Applied[dayId]`; a re-delivered packet must
     *         match EVERY applied field (revert on divergence) and is
     *         otherwise a no-op, so the consume-on-arrival debit can
     *         never run twice.
     *      3. Consensus pair — written, or verified against a value a
     *         legacy kind-2 delivery already set (mixed-generation days).
     *      4. Cap family, atomic with the mode (#1351 2a pairing):
     *         ShareOfPool ⇒ legacy threshold disabled (max) + the
     *         per-side D1 ceilings, verbatim from Base; Legacy ⇒ the §4
     *         threshold verbatim.
     *      5. The chain's own `ChainDayFunding` stamp — what the armed-day
     *         accumulators price with. (`fundedLender`/`fundedBorrower`
     *         stay 0 here: they are Base-side records; the equivalent
     *         halves already encode the funded budgets exactly.)
     *      6. `armedFromDay` — forward-only, as in the legacy ingress.
     *      7. Consume-on-arrival — the local bucket surrenders
     *         `recycleConsume` exactly once, mirroring the
     *         `chainConsumedRecycled[c]` mark Base booked at finalization
     *         (same figure, both ledgers).
     */
    function onRewardBroadcastV2Received(RewardBroadcastV2 calldata b)
        external
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardMessenger || s.rewardMessenger == address(0))
        {
            revert NotAuthorizedRewardMessenger();
        }
        if (b.destChainId != block.chainid) {
            revert BroadcastDestinationMismatch(b.destChainId);
        }

        uint32 selfId = uint32(block.chainid);
        if (s.broadcastV2Applied[b.dayId]) {
            LibVaipakam.ChainDayFunding storage prior =
                s.chainDayRecycledFunding[b.dayId][selfId];
            if (
                s.knownGlobalLenderInterestNumeraire18[b.dayId]
                    != b.globalLenderNumeraire18
                    || s.knownGlobalBorrowerInterestNumeraire18[b.dayId]
                        != b.globalBorrowerNumeraire18
                    || !_capFamilyMatches(s, b)
                    || prior.freshLenderHalf != b.freshLenderHalf
                    || prior.freshBorrowerHalf != b.freshBorrowerHalf
                    || prior.lenderHalfEquiv != b.recycledLenderHalfEquiv
                    || prior.borrowerHalfEquiv != b.recycledBorrowerHalfEquiv
                    || prior.recycleConsume != b.recycleConsume
                    || prior.keeperAllocate != b.keeperAllocate
            ) {
                revert KnownGlobalAlreadySet();
            }
            return;
        }

        // Mixed-generation same-day: a legacy kind-2 delivery may already
        // have set the consensus pair — this packet must agree, then its
        // V2-only records layer on top.
        if (s.knownGlobalSet[b.dayId]) {
            if (
                s.knownGlobalLenderInterestNumeraire18[b.dayId]
                    != b.globalLenderNumeraire18
                    || s.knownGlobalBorrowerInterestNumeraire18[b.dayId]
                        != b.globalBorrowerNumeraire18
            ) {
                revert KnownGlobalAlreadySet();
            }
        } else {
            s.knownGlobalLenderInterestNumeraire18[b.dayId] =
                b.globalLenderNumeraire18;
            s.knownGlobalBorrowerInterestNumeraire18[b.dayId] =
                b.globalBorrowerNumeraire18;
            s.knownGlobalSet[b.dayId] = true;
        }

        if (b.capMode == uint8(LibVaipakam.CapMode.ShareOfPool)) {
            LibInteractionRewards.setBroadcastDayCapThreshold(
                b.dayId, type(uint256).max
            );
            s.dayCapMode[b.dayId] = LibVaipakam.CapMode.ShareOfPool;
            s.dayUserSideCapLenderVpfi18[b.dayId] = b.capPayloadLender;
            s.dayUserSideCapBorrowerVpfi18[b.dayId] = b.capPayloadBorrower;
        } else {
            LibInteractionRewards.setBroadcastDayCapThreshold(
                b.dayId, b.capPayloadLender
            );
        }

        s.chainDayRecycledFunding[b.dayId][selfId] = LibVaipakam
            .ChainDayFunding({
            fundedLender: 0,
            fundedBorrower: 0,
            lenderHalfEquiv: b.recycledLenderHalfEquiv,
            borrowerHalfEquiv: b.recycledBorrowerHalfEquiv,
            recycleConsume: b.recycleConsume,
            keeperAllocate: b.keeperAllocate,
            stamped: true,
            freshLenderHalf: b.freshLenderHalf,
            freshBorrowerHalf: b.freshBorrowerHalf
        });

        if (b.armedFromDay != 0 && s.governorCommitArmedFromDay == 0) {
            s.governorCommitArmedFromDay = b.armedFromDay;
        }

        // #1222 M3 B2-b (re-slice): the mirror does NOT consume its bucket on
        // arrival — `recycleConsume` rides the wire as 0 today and mirror
        // local consumption arms in B2-d, once the delivered-backing ledger
        // makes it safe. The stamp is stored (above) so B2-d can price/arm
        // against it; nothing debits the bucket here.
        s.broadcastV2Applied[b.dayId] = true;
        emit RewardBroadcastV2Applied(b.dayId, b.recycleConsume);
        emit KnownGlobalInterestSet(
            b.dayId,
            b.globalLenderNumeraire18,
            b.globalBorrowerNumeraire18
        );
    }

    /// @dev Idempotent-re-delivery comparison for the cap family (mode-
    ///      dependent fields).
    function _capFamilyMatches(
        LibVaipakam.Storage storage s,
        RewardBroadcastV2 calldata b
    ) private view returns (bool) {
        if (b.capMode == uint8(LibVaipakam.CapMode.ShareOfPool)) {
            return s.dayCapMode[b.dayId] == LibVaipakam.CapMode.ShareOfPool
                && s.dayUserSideCapLenderVpfi18[b.dayId] == b.capPayloadLender
                && s.dayUserSideCapBorrowerVpfi18[b.dayId]
                    == b.capPayloadBorrower;
        }
        return s.dayCapThreshold18[b.dayId] == b.capPayloadLender;
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    /// @notice Register (or rotate) the cross-chain messenger authorized to
    ///         deliver cross-chain reward messages on this Diamond.
    /// @dev ADMIN_ROLE-gated. Passing `address(0)` disables the messenger
    ///      ingress until a new one is wired.
    /// @param messenger VaipakamRewardMessenger proxy address on this chain.
    function setRewardMessenger(
        address messenger
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address old = s.rewardMessenger;
        s.rewardMessenger = messenger;
        emit RewardReporterConfigUpdated(
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes32("rewardMessenger"),
            bytes32(uint256(uint160(old))),
            bytes32(uint256(uint160(messenger)))
        );
    }

    // NOTE: there is no `setLocalChainId` — a chain's own identity is
    // `block.chainid`, read directly. T-068 dropped the old settable
    // `localEid`; its storage slot is retained as
    // `localEidLegacyDoNotUse` for layout stability.

    /// @notice Set the canonical (Base) reward chain's EVM chain id —
    ///         the destination for mirror-side chain reports. Zero on Base.
    /// @param chainId EVM chain id of the canonical reward chain.
    function setBaseChainId(
        uint32 chainId
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint32 old = s.baseChainId;
        s.baseChainId = chainId;
        emit RewardReporterConfigUpdated(
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes32("baseChainId"),
            bytes32(uint256(old)),
            bytes32(uint256(chainId))
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
            // forge-lint: disable-next-line(unsafe-typecast)
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
            // forge-lint: disable-next-line(unsafe-typecast)
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
    /// @return rewardMessenger              Registered reward messenger address.
    /// @return localChainId           This chain's EVM chain id.
    /// @return baseChainId            Canonical reward chain's EVM chain id.
    /// @return isCanonicalRewardChain  Canonical flag.
    /// @return rewardGraceSeconds      Grace window (0 ⇒ default 4h).
    function getRewardReporterConfig()
        external
        view
        returns (
            address rewardMessenger,
            uint32 localChainId,
            uint32 baseChainId,
            bool isCanonicalRewardChain,
            uint64 rewardGraceSeconds
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.rewardMessenger,
            uint32(block.chainid),
            s.baseChainId,
            s.isCanonicalRewardChain,
            s.rewardGraceSeconds == 0
                ? DEFAULT_REWARD_GRACE_SECONDS
                : s.rewardGraceSeconds
        );
    }
}
