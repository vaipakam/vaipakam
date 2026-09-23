// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibRewardStaging} from "../libraries/LibRewardStaging.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title RewardStagingFacet
 * @notice #1566 transport epochs 3b-ii-A2 (#2305) — the STAGING lifecycle: a
 *         claim day one call could not settle keeps what it drew,
 *         obligation-bound and unpaid, until the call that can.
 * @dev The walks that hand a day to a record are hosted apart, on
 *      `RewardClaimWalkFacet`; this facet carries the record's own lifecycle
 *      — prepare, reserve, resolve, unwind and the venue — which
 *      re-prices a day through the same primitive the walks use. The two are
 *      refreshed together. The staging entries are PERMISSIONLESS and take a
 *      record key only: everything else is derived from storage, re-priced
 *      through the same day primitive, never trusted from calldata. Each takes
 *      the Diamond's guard and the pause, as the claim does. The reads are on
 *      `RewardEpochViewFacet`, beside the epochs' other reads.
 *
 *      Every value movement a record makes is explicit — a row move with an
 *      event, or a reserved count written on the record — see
 *      {LibRewardStaging}. Staging never settles.
 */
contract RewardStagingFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    // ────────────────────────── the staging lifecycle ──────────────────────────

    /// @notice Permissionless: continue staging the record's day — its late
    ///         chain first, then the list from its continuation, one window —
    ///         and re-size its deadline from the work the day's list needs.
    /// @return stagedFresh    Fresh staged by this call.
    /// @return stagedRecycled Recycled staged by this call.
    function prepareStagedDay(bytes32 key)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 stagedFresh, uint256 stagedRecycled)
    {
        return LibRewardStaging.prepare(LibVaipakam.storageSlot(), key);
    }

    /// @notice Permissionless: if the day is covered — staged transport plus
    ///         what the live sources can bear meets the priced need — reserve
    ///         the residual legs and the cap headroom, per source. Nothing is
    ///         paid; the record is `Reserved`, still unwindable.
    function reserveStagedDay(bytes32 key) external nonReentrant whenNotPaused {
        LibRewardStaging.reserve(LibVaipakam.storageSlot(), key);
    }

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

}
