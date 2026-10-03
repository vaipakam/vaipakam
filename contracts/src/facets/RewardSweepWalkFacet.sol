// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title RewardSweepWalkFacet
 * @notice #1566 transport epochs 3b-ii-A2 (#2305) — the HOST of the expiry
 *         sweep's entry walk, reached through ONE self-call from
 *         `RewardHorizonSweepFacet`, which used to inline it. The claim's walk
 *         has its own host, `RewardClaimWalkFacet`: each walk carries the day
 *         primitive, and two of them beside one another do not fit one facet.
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
contract RewardSweepWalkFacet is IVaipakamErrors {
    /// @notice The expiry sweep's walk for one entry, run for the sweep entry
    ///         on `RewardHorizonSweepFacet` that self-calls it. The transport
    ///         legs are folded in place by the walk, so they are returned.
    function epochSweepExpiredEntry(
        uint256 id,
        uint256 freshHeadroom,
        uint256 deliveredAllowance,
        LibInteractionRewards.TransportLegs memory tp
    )
        external
        returns (
            LibInteractionRewards.EntrySplit memory expired,
            uint256 freshCredited,
            uint256 armedDelivered,
            LibInteractionRewards.TransportLegs memory legs
        )
    {
        _requireDiamondInternal();
        (expired, freshCredited, armedDelivered) =
            LibInteractionRewards.sweepExpiredEntry(id, freshHeadroom, deliveredAllowance, tp);
        legs = tp;
    }

    function _requireDiamondInternal() private view {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
    }
}
