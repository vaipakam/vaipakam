// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibRewardStaging} from "../libraries/LibRewardStaging.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title RewardStagingSettleFacet
 * @notice #1566 transport epochs 3b-ii-A2 (#2305) — a staging record's
 *         SETTLEMENT half: the paginated resolution that pays the day on its
 *         last page, the paginated unwind that returns exactly what was held,
 *         and the claimant's venue.
 * @dev Split from `RewardStagingFacet`, which carries the half that re-prices
 *      a day through the day primitive (prepare, reserve) and had reached
 *      EIP-170 with both halves inlined. Nothing here prices anything: the
 *      resolution consumes what the reservation assigned and runs the A1
 *      claim's own delivery and treasury paths for one day; the unwind
 *      reverses each source by its recorded figure. Every entry is
 *      permissionless and takes a record key only. The three staging facets
 *      are refreshed together.
 */
contract RewardStagingSettleFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    /// @notice A2-ii — emitted by the staging library from the unwind page this
    ///         facet hosts; declared here for the exported ABI.
    event TransportBatchWindowOpened(bytes32 indexed batchId, bytes32 indexed releasedBy, uint64 closesAt);
    /// @notice Declared for the exported ABI: the staging library emits these
    ///         through the record-opening seam and the registration entry this
    ///         facet hosts (A2-ii; moved here from `RewardStagingFacet`, which
    ///         sits within 400 bytes of EIP-170).
    event StagingRecordOpened(bytes32 indexed key, address indexed user, uint8 side, uint64 day, bytes32 commitment);
    event TransportStaged(bytes32 indexed batchId, bytes32 indexed key, uint256 fresh, uint256 recycled);
    event TransportBatchWaiterRegistered(bytes32 indexed batchId, bytes32 indexed key, uint64 openedAt);
    event TransportBatchPriorityStaged(bytes32 indexed batchId, bytes32 indexed key);

    /// @notice Permissionless: one page of resolution. The first page makes the
    ///         record irrevocable; the page that consumes its last batch pays
    ///         the day and closes the record.
    /// @return done Whether the record was paid and closed by this page.
    function resolveStagedDayPage(bytes32 key) external nonReentrant whenNotPaused returns (bool done) {
        return LibRewardStaging.resolvePage(LibVaipakam.storageSlot(), key);
    }

    /// @notice One page of unwind: past the deadline anyone, before it the
    ///         claimant. The page that returns the last batch releases the
    ///         reservation by its recorded provenance and closes the record.
    /// @return done Whether the record was closed by this page.
    function unwindStagedDayPage(bytes32 key) external nonReentrant returns (bool done) {
        return LibRewardStaging.unwindPage(LibVaipakam.storageSlot(), key, msg.sender);
    }

    /// @notice The claimant binds the record's delivery venue, before it is
    ///         reserved. Unset, the claimant's default applies at payout.
    function setStagingVenue(bytes32 key, LibVaipakam.RewardDelivery venue) external nonReentrant {
        LibRewardStaging.setVenue(LibVaipakam.storageSlot(), key, msg.sender, venue);
    }

    /// @notice Permissionless: register the record under `key` for `batchId`'s
    ///         open priority window (A2-ii). The record must have found the
    ///         batch contested and not have used its one priority reservation
    ///         there; the oldest registrant by opening time stages the batch
    ///         first once the window closes.
    function registerForBatchWindow(bytes32 key, bytes32 batchId) external nonReentrant whenNotPaused {
        LibRewardStaging.register(LibVaipakam.storageSlot(), key, batchId);
    }

    /// @notice The record-opening seam, hosted ONCE (A2-ii): a walk that
    ///         prices a cap-hit day — the claim's, a forfeit's, an expiry's
    ///         — stages the plan it found under its operation's commitment
    ///         through this entry, by Diamond self-call
    ///         ({LibRewardCustody.callStageDayFromPlan}), so no walk's facet
    ///         carries the record machinery. Gated to the Diamond; no
    ///         reentrancy guard of its own, since the caller holds the
    ///         Diamond's.
    function stageDayFromPlanInternal(
        address user,
        uint8 side,
        uint256 day,
        uint256[] calldata entryIds,
        bytes32[] calldata ids,
        uint256[] calldata fresh,
        uint256[] calldata recycled,
        uint8 deliverTo,
        uint8 op,
        bytes32 domainKey
    ) external returns (bytes32 key, uint256 staged) {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
        return LibRewardCustody.stageDayFromPlan(
            LibVaipakam.storageSlot(),
            user,
            LibVaipakam.RewardSide(side),
            day,
            entryIds,
            ids,
            fresh,
            recycled,
            LibVaipakam.RewardDelivery(deliverTo),
            LibVaipakam.StagingOp(op),
            domainKey
        );
    }

    /// @notice A domain record's resolution page, hosted here (A2-ii; EIP-170):
    ///         the domain facet's resolution page reaches it by Diamond
    ///         self-call, so the resolution machinery is compiled into one
    ///         facet. Gated to the Diamond; no reentrancy guard or pause check
    ///         of its own — the page that calls it carries both.
    function resolveRecordInDomainInternal(bytes32 key) external returns (bool done) {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
        return LibRewardStaging.resolvePageInDomain(LibVaipakam.storageSlot(), key);
    }

    /// @notice A domain record's unwind page, hosted here (A2-ii; EIP-170): the
    ///         domain facet's unwind page reaches it by Diamond self-call. The
    ///         domain decided the unwind, so the record's own deadline and
    ///         stale-record gates do not apply here. Gated to the Diamond.
    function unwindRecordInDomainInternal(bytes32 key) external returns (bool done) {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
        return LibRewardStaging.unwindPageInDomain(LibVaipakam.storageSlot(), key);
    }

    /// @notice One page of a legacy-slice record's consumption, hosted here
    ///         (A2-ii (c); EIP-170): the slice's consumption page reaches it by
    ///         Diamond self-call, so the batch resolution is compiled into one
    ///         facet. Gated to the Diamond; the step that calls it carries the
    ///         guards.
    function consumeRecordInLegacyInternal(bytes32 key) external returns (uint256 held, bool done, bool unsettled) {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
        return LibRewardStaging.consumeInLegacy(LibVaipakam.storageSlot(), key);
    }
}
