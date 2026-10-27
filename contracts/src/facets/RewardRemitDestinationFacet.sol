// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRemitDayLedger} from "../libraries/LibRemitDayLedger.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title RewardRemitDestinationFacet — what Base does when a remit
 *        destination leaves its expected-source list (#2963).
 *
 * @notice Taking a mirror off Base's list ends Base's remittances to it for
 *         every day up to and including the removal day, and releases in the
 *         same write the pool room Base held for those days: a partly sent
 *         day's unsent rest, and an armed day's booked commitments. Owner
 *         decision 2026-10-27 ("On removal"): only Base releases, each day
 *         that releases anything emits its figures, and the removed mirror's
 *         users lose those days.
 *
 * @dev    Its own facet because {RewardRemittanceFacet} had about 1.1 KB of
 *         EIP-170 headroom, and this is a separate concern with a real seam:
 *         the list change is an admin action on the aggregator, the release
 *         walk a permissionless continuation, and neither sends anything. The
 *         per-day release rules live in {LibRemitDayLedger}, next to the
 *         ledger they unwind, so the send path and this one read one source.
 *         Shares LibVaipakam storage through the Diamond. Refreshed together
 *         with {RewardAggregatorFacet} (whose list setter self-calls
 *         {onExpectedSourceListChange}) and {RewardRemittanceFacet} (whose
 *         planner refuses an abandoned day) — the full refresh carries all
 *         three.
 */
contract RewardRemitDestinationFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    /// @dev The pool lives on Base — the release is a Base-only action.
    modifier onlyCanonical() {
        if (!LibVaipakam.storageSlot().isCanonicalRewardChain) {
            revert NotCanonicalRewardChain();
        }
        _;
    }

    /// @dev How many days the list change itself walks for each removed
    ///      chain; the rest finish through {continueRemitDestinationRelease}.
    ///      A settled day costs a few cold reads, an unsent armed one about
    ///      thirty thousand gas, so this keeps the admin write bounded even on
    ///      a chain that stopped remitting long ago.
    uint256 internal constant REMOVAL_RELEASE_DAYS = 128;

    /**
     * @notice Internal (Diamond self-call only): apply Base's expected-source
     *         list change to the remit side, BEFORE the list is rewritten.
     *         Every chain the new list drops has its days abandoned and its
     *         held pool room released (up to {REMOVAL_RELEASE_DAYS} days in
     *         this write); a chain the new list adds is refused while its
     *         last removal's release is unfinished.
     * @dev    Called only by `RewardAggregatorFacet.setExpectedSourceChainIds`
     *         (ADMIN, canonical), which has already validated `newList`. Owner
     *         decision 2026-10-27 ("On removal", #2963): only Base releases,
     *         each released day emits its figures, and the chain's users lose
     *         those days. The re-list refusal is what keeps an abandoned day
     *         from finalizing with the chain counted, which would book a
     *         commitment toward it that no send ever retires.
     * @param newList The list about to be stored.
     */
    function onExpectedSourceListChange(uint32[] calldata newList) external {
        if (msg.sender != address(this)) {
            revert RemitDestinationOnlyDiamondInternal(msg.sender);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        for (uint256 i; i < newList.length; ) {
            uint32 c = newList[i];
            if (LibRemitDayLedger.releasePending(s, c)) {
                revert RemitDestinationReleasePending(
                    c, s.remitReleaseCursor[c], s.remitAbandonedBefore[c]
                );
            }
            unchecked {
                ++i;
            }
        }
        uint32[] storage oldList = s.expectedSourceChainIds;
        uint256 n = oldList.length;
        for (uint256 i; i < n; ) {
            uint32 c = oldList[i];
            if (!_listed(newList, c)) {
                LibRemitDayLedger.abandonDestination(s, c);
                LibRemitDayLedger.walkAbandoned(s, c, REMOVAL_RELEASE_DAYS);
            }
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Permissionless: continue releasing what Base holds for a removed
     *         destination's abandoned days, walking at most `maxDays` days.
     * @dev    Needed when the removal had more days than its own write walked,
     *         or when an abandoned day had not finalized yet (the walk stops
     *         there). Moves no tokens and decides nothing: each day releases
     *         what its own records say it holds, so any caller may run it.
     *         Refused once the release is done.
     * @return releaseCursor   The first day not yet released.
     * @return abandonedBefore The removal's bound; the release is done once the
     *                         cursor reaches it.
     */
    function continueRemitDestinationRelease(
        uint32 dstChainId,
        uint256 maxDays
    )
        external
        nonReentrant
        whenNotPaused
        onlyCanonical
        returns (uint256 releaseCursor, uint256 abandonedBefore)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!LibRemitDayLedger.releasePending(s, dstChainId)) {
            revert RemitDestinationReleaseDone(dstChainId);
        }
        return LibRemitDayLedger.walkAbandoned(s, dstChainId, maxDays);
    }

    /// @dev Whether `list` carries `chainId`.
    function _listed(uint32[] calldata list, uint32 chainId) private pure returns (bool) {
        for (uint256 i; i < list.length; ) {
            if (list[i] == chainId) return true;
            unchecked {
                ++i;
            }
        }
        return false;
    }
}
