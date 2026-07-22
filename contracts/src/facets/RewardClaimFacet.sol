// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  RewardClaimFacet
/// @notice The interaction-reward CLAIM surface, split out of
///         {InteractionRewardsFacet} by #1351 slice 2c.
///
/// @dev    WHY THIS FACET EXISTS — EIP-170, not taste.
///
///         Slice 2c prices a ShareOfPool `(user, side, day)` per-day against
///         the D1 ceiling, and that day walk is an `internal` library function,
///         so Solidity INLINES it into every facet that calls it. It adds
///         ~5.8 KB. `InteractionRewardsFacet` sat at 24,095 B against the
///         24,576 B limit — 481 B of headroom — so the walk could not live
///         there at any size.
///
///         The claim entry points and the walk therefore move here TOGETHER.
///         Keeping them in one contract deliberately avoids a cross-facet call
///         on the hot claim path: a routing hop would make the payout depend on
///         the Diamond resolving a second selector, which is a failure mode a
///         fund-moving path should not acquire just to satisfy a size limit.
///
///         What stays behind in {InteractionRewardsFacet}: the forfeit/expiry
///         sweeps, the admin setters, and the self-call reward hooks.
contract RewardClaimFacet is
    DiamondAccessControl,
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;

    /// @notice Emitted when a user claims interaction rewards.
    /// @param user     Claimer.
    /// @param fromDay  First day included in the legacy-window walk (inclusive).
    /// @param toDay    Last day included in the legacy-window walk (inclusive).
    /// @param amount   Total VPFI wei transferred to the user (entry + window).
    /// @custom:event-category state-change/reward-claim
    event InteractionRewardsClaimed(
        address indexed user,
        uint256 fromDay,
        uint256 toDay,
        uint256 amount
    );

    /// @notice RL-1 (VpfiRecyclingLoopClosureDesign §6) — emitted when a
    ///         claim's payout was delivered into the claimant's per-user
    ///         vault instead of their wallet. One aggregate event per
    ///         vault-delivered claim, stamped with the CLAIM day (the day
    ///         the tokens actually left protocol custody) — never one of
    ///         the underlying finalized reward days. The RL-2 loop-closure
    ///         metric's retention ledger is driven off this event, and both
    ///         sides of that ratio are claim-day based, so no per-reward-day
    ///         split is emitted or needed.
    /// @param user       Claimant whose vault was credited.
    /// @param amount     VPFI wei credited to the vault.
    /// @param claimDayId Schedule day index on which the claim executed.
    /// @custom:event-category state-change/reward-claim
    event RewardDeliveredToVault(
        address indexed user,
        uint256 amount,
        uint256 claimDayId
    );
    // ─── User entry point ────────────────────────────────────────────────────

    /**
     * @notice Claim accrued interaction rewards across finalized days
     *         since the caller's last claim. Windowed by
     *         `MAX_INTERACTION_CLAIM_DAYS`; repeat the call to catch up
     *         beyond one window.
     *
     *      Reverts `InteractionEmissionsNotStarted` before launch,
     *      `VPFITokenNotSet` when VPFI isn't registered,
     *      `NoInteractionRewardsToClaim` when no finalized unclaimed
     *      day exists, and `InteractionPoolExhausted` when the 69M cap
     *      has been fully paid out.
     *
     *      Pausable + reentrancy-guarded. Emits {InteractionRewardsClaimed}.
     *
     *      RL-1 delivery default: a direct EOA-style claim delivers the
     *      payout into the claimant's per-user VAULT (closing the reward
     *      loop — see {claimInteractionRewardsTo}); a contract caller gets
     *      the raw wallet transfer every pre-RL-1 integration observed.
     *      Pass an explicit venue via {claimInteractionRewardsTo} to
     *      override either default.
     * @return paid    VPFI wei transferred to the caller.
     * @return fromDay First day walked (inclusive).
     * @return toDay   Last day walked (inclusive).
     */
    function claimInteractionRewards()
        external
        nonReentrant
        whenNotPaused
        returns (uint256 paid, uint256 fromDay, uint256 toDay)
    {
        return _claimInteractionRewards(LibVaipakam.RewardDelivery.Default);
    }

    /**
     * @notice RL-1 (VpfiRecyclingLoopClosureDesign §6) — claim with an
     *         explicit delivery venue. Identical accrual/cap/forfeit
     *         semantics to {claimInteractionRewards}; only where the payout
     *         lands differs:
     *
     *         - `Vault`: the payout is credited into the claimant's
     *           per-user vault via the Diamond-funded credit primitive, so
     *           it immediately counts toward protocol-tracked balance and
     *           fee-discount tier standing. NOT a lockup — the vault is the
     *           user's own custody surface and withdrawal stays available
     *           at any time. Available to every caller: a smart-contract
     *           wallet (Safe, AA account) passes `Vault` to get the same
     *           loop-closing credit as an EOA.
     *         - `Wallet`: raw `safeTransfer` to `msg.sender` (the pre-RL-1
     *           behaviour; the EOA opt-out and the integration default).
     *         - `Default`: resolves by caller shape — EOA-style → `Vault`,
     *           contract caller → `Wallet`.
     *
     *         Delivery is best-effort and NEVER reduces claim availability:
     *         if the vault credit cannot complete (no vault yet, mandatory
     *         vault upgrade pending, or the tier bookkeeping reverts), the
     *         whole vault-side frame rolls back and the payout falls back
     *         to the wallet transfer — never a double-pay, never untracked
     *         vault dust, never a bubbled revert.
     *
     * @param  deliverTo Delivery venue selector.
     * @return paid    VPFI wei paid out (vault-credited or transferred).
     * @return fromDay First day walked (inclusive).
     * @return toDay   Last day walked (inclusive).
     */
    function claimInteractionRewardsTo(LibVaipakam.RewardDelivery deliverTo)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 paid, uint256 fromDay, uint256 toDay)
    {
        return _claimInteractionRewards(deliverTo);
    }

    /// @dev Shared claim body. See {claimInteractionRewards} for the
    ///      accrual/window/cap semantics and {claimInteractionRewardsTo}
    ///      for the RL-1 delivery rules.
    function _claimInteractionRewards(LibVaipakam.RewardDelivery deliverTo)
        private
        returns (uint256 paid, uint256 fromDay, uint256 toDay)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // #921 item 1 — Tier-1 sanctions gate. This is a direct VPFI payout to
        // `msg.sender`; every other payout/claim path screens the caller, but
        // this one did not, leaving the "payouts blocked while flagged" policy
        // enforced only by the alpha02 UI. Arrest it at the contract level so
        // every integrator (keeper bots, third-party frontends, direct callers)
        // gets the same protection. (The sibling `sweepForfeitedInteractionRewards`
        // routes to treasury, not the caller, so it stays ungated by design.)
        LibVaipakam._assertNotSanctioned(msg.sender);
        if (s.interactionLaunchTimestamp == 0) {
            revert InteractionEmissionsNotStarted();
        }
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();

        (uint256 today, bool active) = LibInteractionRewards.currentDayOrZero();
        if (!active || today == 0) revert NoInteractionRewardsToClaim();

        // Fold new entry-path rewards first. Forfeited entries accumulate
        // in the treasury split; PR-3c surfaces each aggregate's RECYCLED
        // and ARMED-FRESH components (governor dual accumulator) so
        // consumption can split fresh-vs-recycled below.
        (
            LibInteractionRewards.EntrySplit memory userSplit,
            LibInteractionRewards.EntrySplit memory forfeitSplit
        ) = LibInteractionRewards.claimForUserEntries(msg.sender);
        uint256 entryReward = userSplit.total;
        uint256 treasuryDelta = forfeitSplit.total;
        uint256 paidRecycled = userSplit.recycled;
        uint256 forfeitRecycled = forfeitSplit.recycled;

        uint256 last = s.interactionLastClaimedDay[msg.sender];
        uint256 lastFinalized = today - 1;

        uint256 windowReward;
        bool walkedWindow;
        if (last < lastFinalized) {
            fromDay = last + 1;
            uint256 windowLast = fromDay + LibVaipakam.MAX_INTERACTION_CLAIM_DAYS - 1;
            toDay = windowLast < lastFinalized ? windowLast : lastFinalized;

            // Spec §4a: only walk the contiguous finalized prefix. If
            // `fromDay` itself is unfinalized, skip the legacy walk but
            // still honour entry-path rewards accrued so far.
            (uint256 effectiveTo, bool any) = LibInteractionRewards.clampToFinalized(
                fromDay,
                toDay
            );
            if (any) {
                toDay = effectiveTo;
                windowReward = LibInteractionRewards.claimForUserWindow(
                    msg.sender,
                    fromDay,
                    toDay
                );
                s.interactionLastClaimedDay[msg.sender] = toDay;
                walkedWindow = true;
            }
        }

        uint256 pending = entryReward + windowReward;
        // #1353 (M2 PR-5c) — a fully loan-side-capped entry pays 0 yet still
        // carries a finalized `armedFresh` commitment that MUST be retired
        // (`consumeArmedFresh` below); reverting here would roll back its
        // processing + the paid/day accumulators and strand the commitment,
        // letting a solo zero-payout entry be retried forever (Codex #1371 r6).
        // So only surface the "nothing to claim" states when there is ALSO no
        // commitment to retire — otherwise fall through to a valid zero-payout
        // claim that clears the entry and retires its commitment. (Inlined, no
        // extra local, to stay within the at-viaIR-budget claim frame.)
        if (
            pending == 0 &&
            treasuryDelta == 0 &&
            userSplit.armedFresh == 0 &&
            forfeitSplit.armedFresh == 0
        ) {
            // No legacy claim possible AND nothing to sweep — surface the
            // same waiting / empty states the prior API used.
            if (!walkedWindow) {
                if (last >= lastFinalized) revert NoInteractionRewardsToClaim();
                revert InteractionDayGlobalNotFinalized(last + 1);
            }
            revert NoInteractionRewardsToClaim();
        }

        uint256 paidOut = s.interactionPoolPaidOut;
        // #776 — reserve VPFI already remitted to mirrors: it funds mirror-side
        // claims and must not be re-lent to Base claimants (Base-only counter;
        // 0 on mirrors). Keeps the global 69M cap coherent across chains.
        uint256 reserved = paidOut + s.rewardBudgetRemittedGlobal;
        uint256 remaining = LibVaipakam.VPFI_INTERACTION_POOL_CAP > reserved
            ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - reserved
            : 0;

        // PR-3c (#1217 §3.1) — the 69M hard cap governs the FRESH term
        // only. The recycled components are bucket-backed (sized by the
        // finalize stamp against `fundable`) and NEVER consume the fresh
        // pool — at fresh exhaustion the recycled term keeps paying: the
        // promised steady state. Truncation therefore scales only the
        // fresh shares. (The legacy window reward is fresh by
        // construction — pre-cutover math.)
        uint256 freshPending = pending - paidRecycled;
        uint256 freshTreasury = treasuryDelta - forfeitRecycled;
        uint256 freshSpend = freshPending + freshTreasury;
        if (freshSpend > remaining) {
            if (remaining == 0 && paidRecycled + forfeitRecycled == 0) {
                revert InteractionPoolExhausted();
            }
            uint256 scaledFreshPending =
                freshSpend > 0 ? (freshPending * remaining) / freshSpend : 0;
            freshTreasury = remaining - scaledFreshPending;
            freshPending = scaledFreshPending;
            pending = freshPending + paidRecycled;
            treasuryDelta = freshTreasury + forfeitRecycled;
        }

        paid = pending;
        // Fresh-pool accounting: interactionPoolPaidOut remains the
        // FRESH-only counter (recycled payouts debit the bucket instead).
        s.interactionPoolPaidOut = paidOut + freshPending + freshTreasury;

        // PR-3c consume-at-claim — retire the FULL armed-fresh commitment
        // of every entry processed by this claim, paid OR truncated (Codex
        // #1315 P2): a processed entry can never be claimed or forfeited
        // again, so any truncated remainder is gone for good — leaving its
        // commitment outstanding would permanently depress freshAvailable
        // for value nobody can ever draw.
        LibInteractionRewards.consumeArmedFresh(
            userSplit.armedFresh + forfeitSplit.armedFresh
        );
        if (paidRecycled > 0) {
            LibVpfiRecycle.consume(paidRecycled);
        }

        if (paid > 0) {
            _deliverReward(vpfi, paid, deliverTo, today);
        }
        if (treasuryDelta > 0) {
            // Governor PR-3a/PR-3c (#1217 §4) — the forfeit's source split:
            // the FRESH-funded share is genuine absorption and credits the
            // recycle bucket; the RECYCLED-funded share never physically
            // left the bucket, so it is a pure commitment RELEASE with
            // ZERO new credit (crediting it would inflate Ā on every
            // forfeit while absorbing nothing).
            if (freshTreasury > 0) {
                LibVpfiRecycle.credit(
                    LibVpfiRecycle.RecycleSource.ForfeitedReward,
                    0,
                    freshTreasury
                );
            }
            if (forfeitRecycled > 0) {
                LibVpfiRecycle.releaseCommitment(
                    LibVpfiRecycle.RecycleSource.ForfeitedReward,
                    0,
                    forfeitRecycled
                );
            }
        }
        emit InteractionRewardsClaimed(msg.sender, fromDay, toDay, paid);
    }

    /**
     * @dev RL-1 payout delivery. Resolves `Default` by caller shape (an
     *      EOA-style claimant — `msg.sender.code.length == 0` — joins the
     *      loop by default; a contract caller keeps the raw transfer every
     *      pre-RL-1 integration observed), then attempts the Diamond-funded
     *      vault credit for `Vault` deliveries.
     *
     *      The credit runs as ONE revert-isolated unit: the cross-facet
     *      self-call routes through the Diamond's fallback into
     *      {VaultFactoryFacet.vaultCreditFromDiamondERC20} in its own call
     *      frame, so a failure at ANY step (no vault, mandatory-upgrade
     *      gate, transfer, tracked-balance record, tier rollup) rolls back
     *      every vault-side effect before the wallet fallback pays — never
     *      a double-pay, never untracked vault dust, and never a bubbled
     *      revert that regresses claim availability relative to the
     *      pre-RL-1 wallet claim. `abi.encodeWithSignature` (not
     *      `.selector`) keeps the heavy VaultFactoryFacet source out of
     *      this facet's import graph; the deploy-sanity selector-coverage
     *      suite pins the routed signature.
     *
     *      NOTE deliberately NOT nonReentrant-guarded on the inner call:
     *      the claim entry holds the shared diamond guard and the credit
     *      primitive is onlyDiamondInternal, running inside this frame.
     */
    function _deliverReward(
        address vpfi,
        uint256 amount,
        LibVaipakam.RewardDelivery deliverTo,
        uint256 claimDayId
    ) private {
        bool toVault = deliverTo == LibVaipakam.RewardDelivery.Vault
            || (
                deliverTo == LibVaipakam.RewardDelivery.Default
                    && msg.sender.code.length == 0
            );
        if (toVault) {
            // slither-disable-next-line low-level-calls
            (bool ok, ) = address(this).call(
                abi.encodeWithSignature(
                    "vaultCreditFromDiamondERC20(address,address,uint256)",
                    msg.sender,
                    vpfi,
                    amount
                )
            );
            if (ok) {
                emit RewardDeliveredToVault(msg.sender, amount, claimDayId);
                return;
            }
        }
        IERC20(vpfi).safeTransfer(msg.sender, amount);
    }

    /**
     * @notice Permissionless sweep of a specific loan's forfeited reward
     *         entries into the treasury. Covers defaulted/liquidated loans
     *         whose borrower never comes back to call
     *         {claimInteractionRewards}.
     * @param loanId Loan id whose forfeited accruals to sweep.
     * @return swept VPFI wei routed to treasury by this call.
     */
}
