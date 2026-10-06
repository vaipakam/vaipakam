// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title RewardForfeitWalkFacet
 * @notice #1566 transport epochs 3b-ii-A2 (#2305) — the HOST of the forfeit
 *         sweep's entry walk, reached through ONE self-call from
 *         `InteractionRewardsFacet`, which used to inline it. The claim's walk
 *         and the expiry sweep's walk have hosts of their own
 *         (`RewardClaimWalkFacet`, `RewardSweepWalkFacet`): each walk carries
 *         the day primitive, and no two of them fit one facet beside a facade.
 * @dev Why. `InteractionRewardsFacet` sat 152 bytes under EIP-170 at the A2-i
 *      head and 258 OVER it once a loan-side staging reservation became a
 *      deferral inside the day primitive (Codex #2308 r4) — the same primitive
 *      every walk inlines, so every change the A2 design makes to a day lands
 *      in this walk too. The walk is hosted once, here, and the facet keeps
 *      its facade and its own accounting (the pool, the delivered ledger, the
 *      commitment retirement, the reserved-shortfall deferral). Same storage,
 *      same Diamond, same call surface for the caller; only the runtime
 *      bytecode is apart. Hosting it is the owner's standing rule for a facet
 *      at the ceiling — a clean seam before any byte-shaving.
 *
 *      The entry is gated to the Diamond itself — it moves value on a loan's
 *      behalf and takes the loan as an argument — and takes no reentrancy
 *      guard of its own, because the facade that self-calls it already holds
 *      the Diamond's (the `completeOffsetInternal` shape). The legs the walk
 *      folds are returned and copied back by the seam, so the facade's struct
 *      reads as the inlined walk left it.
 *
 *      #1566 sanctions slice — the owner forfeit sweep
 *      (`RewardHorizonSweepFacet.forfeitFlaggedOwnerRewards`) settles through
 *      {epochForfeitEntryChunk}, the SAME evented chunk the loan sweep's three
 *      sites call, so the two forfeit routes price, bound, settle and announce
 *      a chunk by one body.
 */
contract RewardForfeitWalkFacet is IVaipakamErrors {
    function epochSweepForfeitedByLoanId(
        uint256 loanId,
        uint256 freshHeadroom,
        uint256 deliveredAllowance,
        LibInteractionRewards.TransportLegs memory tp
    )
        external
        returns (
            uint256 freshCredited,
            uint256 recycledReleased,
            uint256 armedOwed,
            uint256 armedDelivered,
            LibInteractionRewards.TransportLegs memory legs
        )
    {
        _requireDiamondInternal();
        (freshCredited, recycledReleased, armedOwed, armedDelivered) =
            LibInteractionRewards.sweepForfeitedByLoanId(loanId, freshHeadroom, deliveredAllowance, tp);
        legs = tp;
    }

    /// @notice 3b-ii-B (B-6) — the zero-priced remainder's retirement, hosted here
    ///         (this facet already carries the day primitive; the sweep walk's has
    ///         no room). Reached by Diamond self-call from
    ///         {RewardHorizonSweepFacet.retireZeroPricedRemainders}; gated.
    function epochRetireZeroPricedRemainder(
        uint256 id,
        uint256 freshHeadroom,
        uint256 deliveredAllowance,
        LibInteractionRewards.TransportLegs memory tp
    )
        external
        returns (
            bool retired,
            LibInteractionRewards.EntrySplit memory expired,
            uint256 freshCredited,
            uint256 armedDelivered,
            LibInteractionRewards.TransportLegs memory legs
        )
    {
        _requireDiamondInternal();
        (retired, expired, freshCredited, armedDelivered) =
            LibInteractionRewards.retireZeroPricedRemainder(id, freshHeadroom, deliveredAllowance, tp);
        legs = tp;
    }

    /// @notice #1566 sanctions slice — ONE forfeited entry's settlement chunk for the
    ///         owner forfeit sweep ({RewardHorizonSweepFacet.forfeitFlaggedOwnerRewards}),
    ///         reached by Diamond self-call
    ///         ({LibInteractionRewards.callForfeitEntryChunkWalk}); gated.
    /// @dev    Hosted here because this facet already carries the forfeit chunk and its
    ///         day primitive for the loan sweep: the owner sweep reuses
    ///         {LibInteractionRewards.forfeitEntryChunkEvented} rather than inlining a
    ///         second copy onto the sweep facet. That wrapper refuses an entry that is
    ///         not forfeited (zeros, nothing moved), so no self-call can route a live
    ///         entry's value to the bucket, and it announces every moved chunk with
    ///         `RewardEntryForfeitSettled`. Diamond-internal and unguarded for the
    ///         reasons the contract header gives; the legs are returned for the seam.
    function epochForfeitEntryChunk(
        uint256 id,
        uint256 freshHeadroom,
        uint256 deliveredAllowance,
        LibInteractionRewards.TransportLegs memory tp
    )
        external
        returns (
            uint256 freshCredited,
            uint256 recycledReleased,
            uint256 armedOwed,
            uint256 armedDelivered,
            LibInteractionRewards.TransportLegs memory legs
        )
    {
        _requireDiamondInternal();
        (freshCredited, recycledReleased, armedOwed, armedDelivered) = LibInteractionRewards
            .forfeitEntryChunkEvented(LibVaipakam.storageSlot(), id, freshHeadroom, deliveredAllowance, tp);
        legs = tp;
    }

    function _requireDiamondInternal() private view {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
    }
}
