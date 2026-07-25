// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
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
