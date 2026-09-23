// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title RewardClaimWalkFacet
 * @notice #1566 transport epochs 3b-ii-A2 (#2305) — the HOST of the claim's
 *         entry walk, reached through ONE self-call from `RewardClaimFacet`,
 *         which used to inline it. The expiry sweep's walk has its own host,
 *         `RewardSweepWalkFacet`: each walk carries the day primitive, and two
 *         of them beside one another do not fit one facet.
 * @dev Why. `RewardClaimFacet` sat 61 bytes under EIP-170 and
 *      `RewardHorizonSweepFacet` 223 at the A1 head, each inlining a walk that
 *      carries the day primitive, the persistence and the transport seam.
 *      Every change the A2 design makes lands inside those walks — a cap-hit
 *      deferral that stages, a standing-record guard on the day, capacity
 *      reads net of what records have reserved — so the walks are hosted once,
 *      here, where they share one copy of the primitive, and the facets keep
 *      their facades and their own accounting. Same storage, same Diamond,
 *      same call surface for the caller; only the runtime bytecode is apart.
 *
 *      Both entries are gated to the Diamond itself — they move value on a
 *      party's behalf and take that party or its entry as an argument — and
 *      take no reentrancy guard of their own, because the entry that self-calls
 *      them already holds the Diamond's (the `completeOffsetInternal` shape).
 *      The staging lifecycle a walk hands a day to lives on
 *      `RewardStagingFacet`; the two are refreshed together.
 */
contract RewardClaimWalkFacet is IVaipakamErrors {
    /// @notice The claim's entry walk for `user`, run for the claim entry on
    ///         `RewardClaimFacet` that self-calls it.
    /// @dev    The walk the claim facet inlined before this slice, with the A2
    ///         seam: a day with a standing record defers, a cap-hit deferral
    ///         stages. The claimant, the fresh budget and the window's reserved
    ///         fresh are passed in rather than read from the caller, which is
    ///         the Diamond here.
    function epochClaimEntriesWalk(address user, uint256 freshBudget, uint256 windowFreshReserved)
        external
        returns (LibInteractionRewards.ClaimEntriesResult memory)
    {
        _requireDiamondInternal();
        return LibInteractionRewards.claimForUserEntries(user, freshBudget, windowFreshReserved);
    }

    function _requireDiamondInternal() private view {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
    }
}
