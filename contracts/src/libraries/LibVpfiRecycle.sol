// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibInteractionRewards} from "./LibInteractionRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title  LibVpfiRecycle
 * @author Vaipakam Developer Team
 * @notice Governor PR-3a (#1217 / #1222,
 *         `docs/DesignsAndPlans/VpfiRecyclingBalanceGovernorDesign.md` §5) —
 *         the recycle-bucket ledger's single credit chokepoint.
 *
 *         The bucket is a protocol-owned **ledger slice of the Diamond's own
 *         VPFI balance** — crediting it never moves tokens; it re-labels
 *         VPFI that has just terminated in Diamond custody (a recyclable
 *         receipt class) as recycled reward runway. Nothing is burned: every
 *         credited token extends the reward program's life via the
 *         governor's absorption-coupled budget (PR-3b sizes
 *         `recycledBudget[D]` from the trailing average of
 *         `recycledCreditedByDay`).
 *
 * @dev    Every credit MUST route through {credit} — it is the one place the
 *         bucket, the day-bucketed `credited[D]` feed, and the
 *         {VpfiRecycled} observability event stay in lockstep. The caller is
 *         responsible for the custody precondition: the `amount` must
 *         already sit (and remain) on the Diamond — never credit for VPFI
 *         that was transferred out.
 *
 *         Separation invariant (governor §5), preserved by construction at
 *         this chokepoint: `diamondVpfiBalance ≥ userLifCustody +
 *         unclaimedRewardBudget + recycleBucket` — a credit always
 *         corresponds to value LEAVING one of the other two custody classes
 *         (e.g. a forfeited reward leaves the unclaimed reward budget) or
 *         arriving fresh from a user (e.g. a tariff), so the right-hand side
 *         never grows past the balance.
 *
 *         Source-split note (governor §4): pre-PR-3c every distributed
 *         reward is FRESH-funded (the coupled budget doesn't exist yet), so
 *         a forfeit's full amount is genuine absorption and credits here.
 *         PR-3c's dual fresh/recycled accumulator adds the recycled-funded
 *         share's commitment-release path (which must NEVER credit —
 *         releasing a recycled commitment absorbs nothing).
 */
library LibVpfiRecycle {
    /// @notice Recyclable VPFI receipt classes (governor §4). Stable ABI
    ///         ordering — append only. `ExpiredReward` is reserved for the
    ///         RL-3 claim-horizon sweep (#1305).
    enum RecycleSource {
        ForfeitedReward,
        NotificationFee,
        FullTariff,
        BorrowerLifForfeit,
        BorrowerLifTreasuryShare,
        YieldFeeVpfiShare,
        MatcherRemainder,
        ServiceBondSlash,
        ExpiredReward
    }

    /// @notice Emitted once per recycle-bucket credit — the on-chain feed
    ///         for the #1218 transparency metrics (selfFundingRatio) and the
    ///         RL-2 loop-closure ratio's absorption term.
    /// @param source Receipt class (see {RecycleSource}).
    /// @param refId  Class-specific reference (loanId for per-loan classes;
    ///               0 for aggregate credits such as a claim-path forfeit
    ///               batch spanning several entries).
    /// @param amount VPFI wei credited to the bucket.
    /// @param dayId  Interaction-reward schedule day the credit landed in
    ///               (0 pre-launch — aged out of the trailing window once
    ///               emissions start).
    /// @custom:event-category state-change/treasury-mutation
    event VpfiRecycled(
        uint8 indexed source,
        uint256 indexed refId,
        uint256 amount,
        uint256 dayId
    );

    /// @notice The Diamond's live VPFI balance cannot back the post-credit
    ///         bucket — crediting would mint an UNBACKED ledger slice.
    ///         (Codex #1312 P1: the pre-PR-3a treasury `safeTransfer` doubled
    ///         as a solvency check that rolled the whole forfeit back on an
    ///         underfunded Diamond; this restores that revert-on-underfunded
    ///         behaviour, strictly stronger.)
    error InsufficientRecycleBacking(uint256 needed, uint256 available);

    /**
     * @notice Credit `amount` of Diamond-custody VPFI to the recycle bucket.
     * @dev    No-op on zero. Reverts {InsufficientRecycleBacking} when the
     *         Diamond's live VPFI balance cannot cover the post-credit
     *         bucket — the ledger-slice property is enforced HERE, not
     *         assumed, so a caller that marked value as absorbed without the
     *         tokens actually sitting on the Diamond rolls back entirely
     *         (processed flags, pool accounting and all). See the library
     *         natspec for the full separation invariant.
     * @param  source Receipt class being absorbed.
     * @param  refId  Class-specific reference id (0 when aggregate).
     * @param  amount VPFI wei to credit.
     */
    function credit(
        RecycleSource source,
        uint256 refId,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 bal = IERC20(s.vpfiToken).balanceOf(address(this));
        uint256 needed = s.recycleBucket + amount;
        if (bal < needed) revert InsufficientRecycleBacking(needed, bal);
        (uint256 dayId, bool active) = LibInteractionRewards.currentDayOrZero();
        if (!active) dayId = 0;
        s.recycleBucket = needed;
        s.recycledCreditedByDay[dayId] += amount;
        emit VpfiRecycled(uint8(source), refId, amount, dayId);
    }
}
