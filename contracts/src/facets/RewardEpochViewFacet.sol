// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";

/**
 * @title  RewardEpochViewFacet
 * @notice The READ side of the transport epochs that prices a claimant's
 *         days: the claim's dry run, the allocation domain's needs, and
 *         whether that domain has an epoch in reach. Every entry is a view.
 * @dev    #1566 transport epochs PR 3b-ii-A (Codex #2276 r2). These views
 *         inline the whole day-pricing engine — the side worklists, the
 *         cursor machinery, `processUserSideDay` — which is the bulk of any
 *         facet that carries them: the lens facet did once and stood at
 *         25 KB, and the ledger facet ({RewardEpochFacet}) hosted them next
 *         and went over EIP-170 the moment the domain probe joined. So the
 *         engine is inlined ONCE, here, and reached by staticcall through the
 *         Diamond ({LibRewardCustody.callDryRunShareOfPoolDays},
 *         {LibRewardCustody.callDomainNeeds}); the ledger facet keeps the
 *         writes and the ledger-only reads. A2's staging reads belong beside
 *         these, not on the ledger facet. No access control: nothing here
 *         writes, and every caller is a preview or a gate.
 */
contract RewardEpochViewFacet {
    /// @notice The preview's dry run of `user`'s ShareOfPool days against the
    ///         given delivered cap and fresh budget — what a claim would pay,
    ///         the full capped armed fresh it would charge, the part of it the
    ///         live delivery must fund, its draw on the recycle bucket net of
    ///         what the epochs pay (a deferred day included), and whether it
    ///         would defer a day on the transport scan window.
    /// @dev    See {LibInteractionRewards.dryRunShareOfPoolDaysView}.
    function getDryRunShareOfPoolDays(
        address user,
        uint256 deliveredCap,
        uint256 freshBudget
    )
        external
        view
        returns (uint256 userTotal, uint256 armedTotal, uint256 liveArmed, uint256 bucketRecycled, bool capHit)
    {
        return LibInteractionRewards.dryRunShareOfPoolDaysView(user, deliveredCap, freshBudget);
    }

    /// @notice The allocation DOMAIN's gross needs for `user`'s next claim
    ///         call — the fresh and recycled the days it would settle need
    ///         before any source is applied. Prices the chunk regardless of
    ///         whether an epoch is in reach; {getObligationDomainListsAnEpoch}
    ///         is that question.
    /// @dev    See {LibInteractionRewards.userDomainNeedsView}.
    function getObligationDomainNeeds(address user) external view returns (uint256 needFresh, uint256 needRecycled) {
        return LibInteractionRewards.userDomainNeedsView(user);
    }

    /// @notice Whether any day `user`'s next claim call could price has an
    ///         epoch listed — read from the ledger, the chunk's own days
    ///         enumerated without pricing them. False means "the day is the
    ///         domain" and the needs view need not run.
    /// @dev    See {LibInteractionRewards.chunkListsAnEpochView}. Its own
    ///         question, so the needs view stays a pure pricing view and a
    ///         chain with no epochs pays this enumeration and no pricing
    ///         (Codex #2276 r2 P1: a counter appended for this purpose read
    ///         zero over epochs that predate the release).
    function getObligationDomainListsAnEpoch(address user) external view returns (bool) {
        return LibInteractionRewards.chunkListsAnEpochView(user);
    }
}
