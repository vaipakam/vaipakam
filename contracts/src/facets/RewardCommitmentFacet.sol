// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {LibCommitmentReport} from "../libraries/LibCommitmentReport.sol";
import {IRewardMessenger} from "../interfaces/IRewardMessenger.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title RewardCommitmentFacet — #1222 M3 B2-c commitment-GATE plumbing.
 *
 * @notice The Base-side surface of the reward-mesh commitment gate: operator
 *         reconciliation of a force-finalized mirror's remit-eligibility, plus
 *         the read views over the per-(day, chain) gate state. The
 *         finalization-readiness gate itself lives in {RewardAggregatorFacet}
 *         (it consults `chainDayCommitments[...].complete`), and the
 *         remit-ineligible skip in {RewardRemittanceFacet}.
 *
 * @dev    B2-c ships this gate as DORMANT plumbing (completion-plan §M3;
 *         owner re-slice 2026-07-25): nothing SETS `complete` in this slice —
 *         the mirror→Base commitment REPORT that populates it, and the D1-
 *         derived per-loan headroom it carries, land in **B2-d** where they
 *         are designed once alongside the coupled mirror consumption +
 *         remitted clamp. Until then the gate is inert on a single-chain
 *         deployment (no mirrors) and on every unarmed day; on an armed
 *         multi-chain day it fails safe (the fast full-coverage close waits;
 *         a force-finalize marks every included mirror remit-ineligible until
 *         reconciled). The earlier B2-c paged commitment report was withdrawn
 *         after review (Codex #1422) showed a paged, permissionless,
 *         active-loan-list report is the wrong mechanism for a mirror's
 *         day-`D` claimable liabilities — see the release note.
 */
contract RewardCommitmentFacet is DiamondAccessControl, IVaipakamErrors {
    /// @notice Emitted when an operator clears a chain's remit-ineligible flag
    ///         after off-chain reconciliation (its ShareOfPool remittance may
    ///         proceed again).
    /// @custom:event-category informational/reward-governor
    event CommitmentRemitEligibilityReconciled(
        uint256 indexed dayId,
        uint32 indexed chainId
    );

    /// @notice #1222 M3 B2-d1 — this mirror dispatched its day-`D` commitment
    ///         report (per-side claimable-liability aggregate) to Base.
    /// @custom:event-category informational/reward-governor
    event CommitmentReported(
        uint256 indexed dayId,
        bytes32 indexed messageId,
        uint256 liabilityLender18,
        uint256 liabilityBorrower18
    );

    // ─── Mirror-side commitment REPORT (B2-d1) ───────────────────────────────

    /// @notice Accumulate one keeper-fed batch of per-user commitment units for
    ///         `(dayId, side)` — the mirror recomputes each unit's contribution
    ///         from its OWN storage, so the keeper cannot inflate the reported
    ///         liability.
    /// @dev MIRROR-only. Permissionless (the mirror verifies everything); the
    ///      keeper drives it. `side` is 0 (Lender) / 1 (Borrower). `users` MUST
    ///      be strictly ascending by address, each with its full day-`dayId`
    ///      entry set. Completeness is proven by demand conservation, so a
    ///      partial submission simply leaves the day incomplete (delays, never
    ///      zeroes). See {LibCommitmentReport}.
    function submitCommitmentBatch(
        uint256 dayId,
        uint8 side,
        address[] calldata users,
        uint256[][] calldata entryIds
    ) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _assertMirror(s);
        // Enum bounds-check reverts a side outside {0,1}.
        LibCommitmentReport.accumulateBatch(
            s, dayId, LibVaipakam.RewardSide(side), users, entryIds
        );
    }

    /// @notice Dispatch this mirror's day-`D` commitment report to Base once
    ///         both sides are complete, lighting the Base finalization gate.
    /// @dev MIRROR-only, payable (covers the CCIP fee — quote via
    ///      {IRewardMessenger.quoteSendCommitmentReport}). Whole-day idempotent
    ///      (`commitmentReportSent`). CEI: the sent flag is set before the
    ///      external dispatch, so a failed send rolls back and stays retryable.
    function sendCommitmentReport(
        uint256 dayId
    ) external payable returns (bytes32 messageId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _assertMirror(s);
        if (s.commitmentReportSent[dayId]) {
            revert CommitmentReportAlreadySent(dayId);
        }
        if (!LibCommitmentReport.isDayComplete(s, dayId)) {
            revert CommitmentDayNotComplete(dayId);
        }
        address messenger = s.rewardMessenger;
        if (messenger == address(0)) revert RewardMessengerNotSet();
        if (s.baseChainId == 0) revert BaseChainIdNotSet();

        uint256 liabilityLender18 = LibCommitmentReport.sideLiability(
            s, dayId, LibVaipakam.RewardSide.Lender
        );
        uint256 liabilityBorrower18 = LibCommitmentReport.sideLiability(
            s, dayId, LibVaipakam.RewardSide.Borrower
        );

        s.commitmentReportSent[dayId] = true;

        messageId = IRewardMessenger(messenger).sendCommitmentReport{
            value: msg.value
        }(dayId, liabilityLender18, liabilityBorrower18, payable(msg.sender));

        emit CommitmentReported(
            dayId, messageId, liabilityLender18, liabilityBorrower18
        );
    }

    /// @notice True iff `dayId`'s per-side commitments are complete and the
    ///         report has not yet been dispatched — the keeper's send trigger.
    function isDayCommitmentReady(
        uint256 dayId
    ) external view returns (bool) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return
            !s.commitmentReportSent[dayId] &&
            LibCommitmentReport.isDayComplete(s, dayId);
    }

    /// @dev The commitment REPORT surface is mirror-only: a mirror computes its
    ///      OWN day-`D` liability and ships it to Base. Reverts on the canonical
    ///      (Base) chain and on a single-chain deploy (no `baseChainId`).
    function _assertMirror(LibVaipakam.Storage storage s) private view {
        if (!LibVaipakam.isMirrorRewardChain(s)) {
            revert CommitmentReportOnlyMirror();
        }
    }

    /**
     * @notice Clear a chain's `remitIneligible` flag for `dayId` after an
     *         off-chain commitment reconciliation, so its ShareOfPool
     *         remittance may proceed again.
     * @dev ADMIN-only. The flag is set by any armed-day finalize (grace or
     *      force) that closed without this mirror's complete commitments (never
     *      sized from a partial set); the operator reconciles the true headroom
     *      off-chain (evidenced) and clears the flag here. Because clearing it
     *      after a long delay can fall outside the keeper's bounded
     *      remit-discovery window (`apps/keeper` re-scans a fixed lookback and
     *      skips zero quotes), the operator that reconciles a day is expected
     *      to remit it explicitly via `RewardRemittanceFacet.remitRewardBudget`
     *      with that day id — the same manual, admin-driven path the force-close
     *      + reconcile already are; the emitted event is the keeper's hook for
     *      the automatic rediscovery that lands with the armed remit flow in
     *      B2-d. Once B2-d supplies the mirror→Base report, an armed day whose
     *      mirrors report complete commitments never reaches this path.
     */
    function reconcileCommitmentRemitEligibility(
        uint256 dayId,
        uint32 chainId
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Canonical-only, matching {RewardAggregatorFacet.finalizeDay} /
        // {RewardRemittanceFacet}: the remit-ineligible flag is authoritative
        // on Base. This facet is cut on mirror Diamonds too, so without the
        // guard a mirror-chain admin's wrong-chain call would clear only the
        // mirror's unused local mapping and emit the event while the Base flag
        // (the one that actually blocks remittance) stayed set — a recovery
        // transaction that looks successful but does nothing (Codex #1422 r4).
        if (!s.isCanonicalRewardChain) revert NotCanonicalRewardChain();
        s.chainDayCommitments[dayId][chainId].remitIneligible = false;
        emit CommitmentRemitEligibilityReconciled(dayId, chainId);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice The Base-side commitment-gate state for `(dayId, chainId)`.
    function getChainDayCommitments(
        uint256 dayId,
        uint32 chainId
    ) external view returns (LibVaipakam.ChainDayCommitments memory) {
        return LibVaipakam.storageSlot().chainDayCommitments[dayId][chainId];
    }

    /// @notice True iff `chainId`'s commitments for `dayId` are complete
    ///         (populated by the B2-d mirror→Base report; false until then).
    function isChainDayCommitmentsComplete(
        uint256 dayId,
        uint32 chainId
    ) external view returns (bool) {
        return LibVaipakam.storageSlot()
            .chainDayCommitments[dayId][chainId].complete;
    }
}
