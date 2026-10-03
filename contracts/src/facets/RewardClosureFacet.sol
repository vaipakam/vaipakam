// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRewardClosure} from "../libraries/LibRewardClosure.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/// @title RewardClosureFacet
/// @notice 3b-ii-B (#1566) — the per-day CLOSURE PROOF: anyone proves, in bounded
///         pages, that every reward obligation covering a past day has terminated,
///         and the day is stamped closed once, for ever. The release of an old-wire
///         delivery's remainder (its park) requires every day it listed to be
///         stamped so — this is the machine check the design states and #2258 chose
///         (Reading B): no batch is released while an obligation on a listed day
///         could still draw from it.
///
///         A walk is the starter's (keyed by day, starter and a nonce the starter's
///         calls derive), so an omission poisons only its author's walk; the day is
///         stamped by the first walk that completes. See {LibRewardClosure}.
contract RewardClosureFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    event ClosureWalkStarted(uint256 indexed day, address indexed starter, uint64 nonce, bytes32 key);
    event ClosureWalkAdvanced(bytes32 indexed key, uint8 side, uint256 cursor, uint256 sum, bool sideComplete);
    event DayObligationsClosed(uint256 indexed day, address indexed starter, uint64 nonce);

    /// @notice Open a closure walk for `day` under the caller's next nonce. Admissible
    ///         only for an elapsed day this chain has closed and both interest
    ///         frontiers have reached (#2277), and not yet proven closed. A day with
    ///         no obligation on either side closes here.
    /// @return key       The walk's key.
    /// @return nonce     The caller's nonce for it.
    /// @return dayClosed Whether the day closed at once (nothing to visit).
    function startDayClosure(uint256 day)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 key, uint64 nonce, bool dayClosed)
    {
        return LibRewardClosure.start(LibVaipakam.storageSlot(), day, msg.sender);
    }

    /// @notice One page of the caller's walk `nonce` for `day` on `side`: ascending
    ///         entry ids past the side's cursor, each covering the day and terminated
    ///         on it. The side completes when the visited per-day figures sum to the
    ///         day's folded side total; the day closes when both sides have.
    /// @return dayClosed Whether this page completed the proof.
    function proveDayClosurePage(uint256 day, uint64 nonce, uint8 side, uint256[] calldata entryIds)
        external
        nonReentrant
        whenNotPaused
        returns (bool dayClosed)
    {
        // Enum bounds-check reverts a side outside {0,1}.
        return LibRewardClosure.provePage(
            LibVaipakam.storageSlot(), day, msg.sender, nonce, LibVaipakam.RewardSide(side), entryIds
        );
    }

    /// @notice Whether every obligation covering `day` has been proven terminated.
    function isDayObligationsClosed(uint256 day) external view returns (bool) {
        return LibVaipakam.storageSlot().dayObligationsClosed[day];
    }

    /// @notice A walk by (day, starter, nonce): cursors, conservation sums, completeness.
    function getClosureWalk(uint256 day, address starter, uint64 nonce)
        external
        view
        returns (LibVaipakam.ClosureWalk memory)
    {
        return LibVaipakam.storageSlot().closureWalks[LibRewardClosure.walkKey(day, starter, nonce)];
    }

    /// @notice The last walk nonce `starter` used (the next start uses the next).
    function getClosureWalkNonce(address starter) external view returns (uint64) {
        return LibVaipakam.storageSlot().closureWalkNonce[starter];
    }

    /// @notice Whether entry `entryId` counts as terminated on `day` for the proof.
    function isEntryTerminatedOn(uint256 entryId, uint256 day) external view returns (bool) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return LibRewardClosure.entryTerminatedOn(s, entryId, s.rewardEntries[entryId], day);
    }
}
