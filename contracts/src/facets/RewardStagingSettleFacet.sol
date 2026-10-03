// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
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
