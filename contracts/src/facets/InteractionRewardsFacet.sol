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

/**
 * @title InteractionRewardsFacet
 * @author Vaipakam Developer Team
 * @notice Phase-1 platform-interaction rewards claim surface
 *         (docs/TokenomicsTechSpec.md §4). Emissions are driven by the
 *         8-band schedule in {LibInteractionRewards}; per-day per-user
 *         USD interest counters are credited from RepayFacet's clean
 *         settlement hook.
 *
 * @dev Claim walks `[lastClaimedDay+1 .. min(today-1, lastClaimedDay + MAX)]`
 *      — only FINALIZED days are claimable so the per-day totals are
 *      stable. `MAX = LibVaipakam.MAX_INTERACTION_CLAIM_DAYS` bounds the
 *      gas cost; long-dormant users can reclaim in follow-up txs until
 *      caught up.
 *
 *      Pool-cap enforcement is at claim time: the diamond pays VPFI from
 *      its own balance, up to `VPFI_INTERACTION_POOL_CAP - paidOut`.
 *      Residual pending beyond the cap is truncated.
 *
 *      Emissions don't auto-start — admin sets the launch timestamp
 *      once via {setInteractionLaunchTimestamp}. Before that, record
 *      hooks no-op and claims revert `InteractionEmissionsNotStarted`.
 */
contract InteractionRewardsFacet is
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

    // Governor PR-3a (#1217) — the former `InteractionForfeitedToTreasury`
    // event and its treasury transfer are REPLACED: forfeited reward
    // accruals now stay in Diamond custody and credit the recycle bucket
    // (owner directive: no burning — recycle absorbed VPFI into the reward
    // stream). {LibVpfiRecycle.VpfiRecycled} is the observability signal.
    // No off-chain consumer read the old event (grep-verified at removal).

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

    /// @notice Emitted when admin seeds the launch timestamp (once).
    /// @param timestamp UNIX epoch seconds at which day 0 begins.
    /// @custom:event-category informational/config
    event InteractionLaunchTimestampSet(uint256 timestamp);

    /// @notice Emitted when admin updates the per-user daily VPFI cap
    ///         (docs/TokenomicsTechSpec.md §4). `value` is "whole VPFI per
    ///         1 ETH of eligible interest". Zero resets to the default
    ///         (500 → 0.5 VPFI / 0.001 ETH); `type(uint256).max` disables
    ///         the cap entirely.
    /// @param value New ratio value (whole VPFI per ETH); zero = default.
    /// @custom:event-category informational/config
    event InteractionCapVpfiPerEthSet(uint256 value);

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
        if (pending == 0 && treasuryDelta == 0) {
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
    function sweepForfeitedInteractionRewards(uint256 loanId)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 swept)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.interactionLaunchTimestamp == 0) {
            revert InteractionEmissionsNotStarted();
        }
        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();

        LibInteractionRewards.EntrySplit memory sweepSplit =
            LibInteractionRewards.sweepForfeitedByLoanId(loanId);
        uint256 treasuryDelta = sweepSplit.total;
        if (treasuryDelta == 0) return 0;

        uint256 paidOut = s.interactionPoolPaidOut;
        // #776 — reserve remitted-to-mirror VPFI (see {claimInteractionRewards}).
        uint256 reserved = paidOut + s.rewardBudgetRemittedGlobal;
        uint256 remaining = LibVaipakam.VPFI_INTERACTION_POOL_CAP > reserved
            ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - reserved
            : 0;

        // PR-3c — the 69M cap + truncation govern the FRESH share only;
        // the recycled share is bucket-backed. Exhaustion blocks the sweep
        // ONLY when there is nothing recycled to release (Codex #1315 P2:
        // a post-arming forfeit with a recycled component must still be
        // sweepable at fresh exhaustion, or its commitment stays stuck).
        uint256 freshSwept = sweepSplit.total - sweepSplit.recycled;
        if (remaining == 0 && sweepSplit.recycled == 0) {
            revert InteractionPoolExhausted();
        }
        if (freshSwept > remaining) freshSwept = remaining;
        swept = freshSwept + sweepSplit.recycled;
        s.interactionPoolPaidOut = paidOut + freshSwept;

        // PR-3c consume-at-sweep: retire the FULL armed-fresh commitment —
        // the entries are processed either way (see the claim path note).
        LibInteractionRewards.consumeArmedFresh(sweepSplit.armedFresh);

        // Governor PR-3a/PR-3c (#1217 §4) — forfeit source split: the
        // FRESH share stays in Diamond custody and credits the recycle
        // bucket (genuine absorption); the RECYCLED share never left the
        // bucket, so its commitment releases with ZERO new credit.
        // refId = the swept loan for per-loan observability.
        if (freshSwept > 0) {
            LibVpfiRecycle.credit(
                LibVpfiRecycle.RecycleSource.ForfeitedReward,
                loanId,
                freshSwept
            );
        }
        if (sweepSplit.recycled > 0) {
            LibVpfiRecycle.releaseCommitment(
                LibVpfiRecycle.RecycleSource.ForfeitedReward,
                loanId,
                sweepSplit.recycled
            );
        }
    }

    /**
     * @notice RL-3 (#1305, ratified §10.2) — permissionless claim-horizon
     *         sweep. For each entry: starts the horizon clock on first
     *         observed claimability, and once `H` days have passed since
     *         that stamp, EXPIRES the entry into the recycle bucket.
     *
     *         Source-split per the ratified split-signals rule: the
     *         fresh-funded share genuinely leaves the fresh budget into
     *         protocol custody — it consumes the 69M pool and credits the
     *         bucket as `ExpiredReward` absorption (feeds `credited[D]`/Ā);
     *         the recycled-funded share never left the bucket, so it is a
     *         pure commitment RELEASE with zero new credit.
     *
     *         Forfeited entries are out of scope (the forfeit sweep owns
     *         them); a claim landing before expiry always wins (an expired
     *         entry is simply `processed`, identical to a claimed one).
     * @param  entryIds Entries to advance/expire (keeper batches).
     * @return expiredTotal VPFI wei expired into the bucket by this call.
     */
    function sweepExpiredInteractionRewards(uint256[] calldata entryIds)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 expiredTotal)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.interactionLaunchTimestamp == 0) {
            revert InteractionEmissionsNotStarted();
        }
        if (s.vpfiToken == address(0)) revert VPFITokenNotSet();

        uint256 freshTotal;
        uint256 recycledTotal;
        uint256 armedFreshTotal;
        for (uint256 i = 0; i < entryIds.length; ) {
            LibInteractionRewards.EntrySplit memory ex =
                LibInteractionRewards.sweepExpiredEntry(entryIds[i]);
            freshTotal += ex.total - ex.recycled;
            recycledTotal += ex.recycled;
            armedFreshTotal += ex.armedFresh;
            unchecked { ++i; }
        }
        if (freshTotal + recycledTotal == 0) return 0;

        // Fresh share: consumes the 69M pool (tokens leave the fresh
        // budget) exactly like a forfeit, capped at what remains.
        uint256 paidOut = s.interactionPoolPaidOut;
        uint256 reserved = paidOut + s.rewardBudgetRemittedGlobal;
        uint256 remaining = LibVaipakam.VPFI_INTERACTION_POOL_CAP > reserved
            ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - reserved
            : 0;
        if (freshTotal > remaining) freshTotal = remaining;
        s.interactionPoolPaidOut = paidOut + freshTotal;
        LibInteractionRewards.consumeArmedFresh(
            armedFreshTotal < freshTotal ? armedFreshTotal : freshTotal
        );

        if (freshTotal > 0) {
            LibVpfiRecycle.credit(
                LibVpfiRecycle.RecycleSource.ExpiredReward,
                0,
                freshTotal
            );
        }
        if (recycledTotal > 0) {
            LibVpfiRecycle.releaseCommitment(
                LibVpfiRecycle.RecycleSource.ExpiredReward,
                0,
                recycledTotal
            );
        }
        expiredTotal = freshTotal + recycledTotal;
    }

    /// @notice RL-3 — claim-center countdown view: the horizon state of a
    ///         reward entry.
    /// @param  entryId Entry to inspect.
    /// @return firstClaimableAt Clock start (0 = not started / dark).
    /// @return expiresAt        Expiry timestamp (0 = dark or unstarted).
    function getRewardEntryExpiry(uint256 entryId)
        external
        view
        returns (uint64 firstClaimableAt, uint64 expiresAt)
    {
        return LibInteractionRewards.rewardEntryExpiry(entryId);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    /**
     * @notice One-shot admin configuration that opens the emissions
     *         window. Subsequent calls revert once a non-zero timestamp
     *         has been recorded — the schedule is committed at deploy
     *         time and the per-day counters reference this value.
     * @dev ADMIN_ROLE-gated. Setting a value in the past effectively
     *      skips forward into the schedule (useful for testnets); set
     *      `block.timestamp` for a clean launch.
     * @param timestamp UNIX epoch seconds at which day 0 begins.
     */
    function setInteractionLaunchTimestamp(uint256 timestamp)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        require(
            s.interactionLaunchTimestamp == 0,
            "launch already set"
        );
        require(timestamp > 0, "zero timestamp");
        s.interactionLaunchTimestamp = timestamp;
        emit InteractionLaunchTimestampSet(timestamp);
    }

    /**
     * @notice Update the per-user daily VPFI payout cap used by the
     *         interaction reward claim + preview math
     *         (docs/TokenomicsTechSpec.md §4).
     * @dev ADMIN_ROLE-gated. `value` is "whole VPFI per 1 ETH of eligible
     *      interest". The spec default is 500 (0.5 VPFI per 0.001 ETH);
     *      passing `0` resets to that default. Passing
     *      `type(uint256).max` disables the cap entirely (emergency knob
     *      — reverts back to the uncapped proportional share). The new
     *      value applies at the NEXT claim; already-accrued per-day
     *      USD counters are unaffected.
     * @param value Whole VPFI per ETH ratio, or the sentinel values above.
     */
    function setInteractionCapVpfiPerEth(uint256 value)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        // Setter-range audit (2026-05-02): bound the in-range
        // regime to `[INTERACTION_CAP_VPFI_PER_ETH_MIN,
        // INTERACTION_CAP_VPFI_PER_ETH_MAX]`. The two documented
        // sentinels are preserved: `value == 0` resets to the
        // library default at read time, `value == type(uint256).max`
        // is the emergency "disable cap" knob.
        if (
            value != 0 &&
            value != type(uint256).max &&
            (
                value < LibVaipakam.INTERACTION_CAP_VPFI_PER_ETH_MIN ||
                value > LibVaipakam.INTERACTION_CAP_VPFI_PER_ETH_MAX
            )
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "interactionCapVpfiPerEth",
                value,
                LibVaipakam.INTERACTION_CAP_VPFI_PER_ETH_MIN,
                LibVaipakam.INTERACTION_CAP_VPFI_PER_ETH_MAX
            );
        }
        LibVaipakam.storageSlot().interactionCapVpfiPerEth = value;
        emit InteractionCapVpfiPerEthSet(value);
    }

    // ─── Public views ────────────────────────────────────────────────────────

    /// @notice UNIX seconds at which day 0 of the emission schedule
    ///         begins. Zero means admin has not seeded emissions yet.
    /// @return UNIX seconds of the emissions launch; zero if unseeded.
    function getInteractionLaunchTimestamp()
        external
        view
        returns (uint256)
    {
        return LibVaipakam.storageSlot().interactionLaunchTimestamp;
    }

    /// @notice Effective per-user daily VPFI cap (whole VPFI per 1 ETH of
    ///         eligible interest). Reflects the admin override when set,
    ///         otherwise {LibVaipakam.INTERACTION_CAP_DEFAULT_VPFI_PER_ETH}.
    /// @return The ratio currently applied in claim + preview math.
    function getInteractionCapVpfiPerEth() external view returns (uint256) {
        return LibVaipakam.getInteractionCapVpfiPerEth();
    }

    /// @notice Raw (unresolved) admin override for the cap. Zero means
    ///         "use default"; otherwise matches the last value passed to
    ///         {setInteractionCapVpfiPerEth}.
    /// @return The stored override value (0 when unset).
    function getInteractionCapVpfiPerEthRaw() external view returns (uint256) {
        return LibVaipakam.storageSlot().interactionCapVpfiPerEth;
    }

    /// @notice Current day index and active flag.
    /// @return day    Zero-based index of today relative to the launch timestamp.
    /// @return active True iff emissions have been seeded and day is in-schedule.
    function getInteractionCurrentDay()
        external
        view
        returns (uint256 day, bool active)
    {
        return LibInteractionRewards.currentDayOrZero();
    }

    /// @notice Annual emission rate (bps) applied on `day` of the schedule.
    /// @param day Zero-based day index.
    /// @return    Annual rate (basis points) for that day's band.
    function getInteractionAnnualRateBps(uint256 day)
        external
        pure
        returns (uint256)
    {
        return LibInteractionRewards.annualRateBpsForDay(day);
    }

    /// @notice VPFI split on either the lender or borrower side for `day`.
    /// @param day Zero-based day index.
    /// @return    Half-pool VPFI wei reserved per side for that day.
    function getInteractionHalfPoolForDay(uint256 day)
        external
        pure
        returns (uint256)
    {
        return LibInteractionRewards.halfPoolForDay(day);
    }

    /// @notice Last day the caller has fully claimed. Zero means they've
    ///         never claimed.
    /// @param user User to query.
    /// @return    Highest day index already claimed by `user`.
    function getInteractionLastClaimedDay(address user)
        external
        view
        returns (uint256)
    {
        return LibVaipakam.storageSlot().interactionLastClaimedDay[user];
    }

    /// @notice `user`'s raw per-day USD counters and the day totals — for
    ///         transparency + frontend reconciliation.
    /// @param day  Zero-based day index to inspect.
    /// @param user User whose per-day contribution is returned.
    /// @return userLenderNumeraire18    USD-18 lender interest credited to `user` on `day`.
    /// @return userBorrowerNumeraire18  USD-18 borrower interest credited to `user` on `day`.
    /// @return totalLenderNumeraire18   USD-18 lender total for `day` across all users.
    /// @return totalBorrowerNumeraire18 USD-18 borrower total for `day` across all users.
    function getInteractionDayEntry(uint256 day, address user)
        external
        view
        returns (
            uint256 userLenderNumeraire18,
            uint256 userBorrowerNumeraire18,
            uint256 totalLenderNumeraire18,
            uint256 totalBorrowerNumeraire18
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.userLenderInterestNumeraire18[day][user],
            s.userBorrowerInterestNumeraire18[day][user],
            s.totalLenderInterestNumeraire18[day],
            s.totalBorrowerInterestNumeraire18[day]
        );
    }

    /**
     * @notice Preview the caller's claimable reward across the next
     *         claim window WITHOUT mutating state. Walks the same
     *         `[lastClaimedDay+1 .. min(today-1, lastClaimedDay + MAX)]`
     *         range the live claim would use.
     * @param user    User whose next-window claim is previewed.
     * @return amount  VPFI wei the user would receive now
     *                 (before pool-cap truncation at live claim).
     * @return fromDay First day index the preview walks (inclusive).
     * @return toDay   Last day index the preview walks (inclusive).
     */
    function previewInteractionRewards(address user)
        external
        view
        returns (uint256 amount, uint256 fromDay, uint256 toDay)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.interactionLaunchTimestamp == 0) return (0, 0, 0);
        (uint256 today, bool active) = LibInteractionRewards.currentDayOrZero();
        if (!active || today == 0) return (0, 0, 0);

        // Entry-path reward always contributes to the preview regardless
        // of the legacy-window state.
        amount = LibInteractionRewards.previewForUserEntries(user);

        uint256 last = s.interactionLastClaimedDay[user];
        uint256 lastFinalized = today - 1;
        if (last >= lastFinalized) return (amount, 0, 0);

        fromDay = last + 1;
        uint256 windowLast = fromDay + LibVaipakam.MAX_INTERACTION_CLAIM_DAYS - 1;
        toDay = windowLast < lastFinalized ? windowLast : lastFinalized;

        // Mirror the live claim path's §4a gate: only walk the contiguous
        // finalized prefix for the legacy window.
        (uint256 effectiveTo, bool any) = LibInteractionRewards.clampToFinalized(
            fromDay,
            toDay
        );
        if (!any) {
            fromDay = 0;
            toDay = 0;
            return (amount, 0, 0);
        }
        toDay = effectiveTo;
        amount += LibInteractionRewards.previewForUserWindow(user, fromDay, toDay);
    }

    /**
     * @notice Inspect the §4a finalization gate for `user`'s next claim
     *         window. Lets frontends distinguish "nothing to claim yet"
     *         from "claim blocked waiting for the cross-chain global
     *         denominator to be broadcast" without a round-trip through
     *         {RewardReporterFacet.getKnownGlobalInterestNumeraire18}.
     * @param user    User whose next-window status is inspected.
     * @return fromDay           First day the next claim would walk
     *                           (inclusive); 0 when nothing is claimable.
     * @return windowToDay       Last day the uncropped window would walk
     *                           (inclusive); 0 when nothing is claimable.
     * @return effectiveTo       Last day inside the contiguous finalized
     *                           prefix; equals `fromDay - 1` when
     *                           `fromDay` itself is not yet finalized.
     * @return finalizedPrefix  True iff `fromDay` has its global broadcast
     *                           — i.e. at least one day is claimable now.
     * @return waitingForDay    When `finalizedPrefix == false`, the day
     *                           the claim is waiting on; zero otherwise.
     */
    function getInteractionClaimability(address user)
        external
        view
        returns (
            uint256 fromDay,
            uint256 windowToDay,
            uint256 effectiveTo,
            bool finalizedPrefix,
            uint256 waitingForDay
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.interactionLaunchTimestamp == 0) return (0, 0, 0, false, 0);
        (uint256 today, bool active) = LibInteractionRewards.currentDayOrZero();
        if (!active || today == 0) return (0, 0, 0, false, 0);
        uint256 last = s.interactionLastClaimedDay[user];
        uint256 lastFinalized = today - 1;
        if (last >= lastFinalized) return (0, 0, 0, false, 0);

        fromDay = last + 1;
        uint256 windowLast = fromDay + LibVaipakam.MAX_INTERACTION_CLAIM_DAYS - 1;
        windowToDay = windowLast < lastFinalized ? windowLast : lastFinalized;
        (uint256 eTo, bool any) = LibInteractionRewards.clampToFinalized(
            fromDay,
            windowToDay
        );
        if (!any) {
            return (fromDay, windowToDay, 0, false, fromDay);
        }
        return (fromDay, windowToDay, eTo, true, 0);
    }

    /// @notice Remaining VPFI reservable from the 69M interaction pool.
    /// @return Remaining VPFI wei (`cap - paidOut`) the pool can still pay out.
    function getInteractionPoolRemaining() external view returns (uint256) {
        return LibInteractionRewards.poolRemaining();
    }

    /// @notice Cumulative VPFI already paid out from the interaction pool.
    /// @return Cumulative VPFI wei paid to claimers so far.
    function getInteractionPoolPaidOut() external view returns (uint256) {
        return LibVaipakam.storageSlot().interactionPoolPaidOut;
    }

    /// @notice Interaction pool transparency snapshot.
    /// @return cap        69M VPFI hard cap.
    /// @return paidOut    Cumulative VPFI claimed so far.
    /// @return remaining  Reservable pool: `cap − paidOut −
    ///                    rewardBudgetRemittedGlobal` (#776 — matches
    ///                    {getInteractionPoolRemaining} and the live claim cap,
    ///                    so the three never disagree).
    /// @return launch     Launch timestamp (0 if not started).
    /// @return today      Current day index (0 if not started).
    /// @return aprBps     Annual rate for today (from schedule).
    function getInteractionSnapshot()
        external
        view
        returns (
            uint256 cap,
            uint256 paidOut,
            uint256 remaining,
            uint256 launch,
            uint256 today,
            uint256 aprBps
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        cap = LibVaipakam.VPFI_INTERACTION_POOL_CAP;
        paidOut = s.interactionPoolPaidOut;
        remaining = LibInteractionRewards.poolRemaining();
        launch = s.interactionLaunchTimestamp;
        (uint256 d, bool active) = LibInteractionRewards.currentDayOrZero();
        if (active) {
            today = d;
            aprBps = LibInteractionRewards.annualRateBpsForDay(d);
        }
    }

    /// @notice Enumerate every reward entry registered for `user` —
    ///         lender-side and borrower-side rows for each loan they
    ///         participated in. Frontends use this to render a
    ///         "contributing loans" breakdown alongside the
    ///         {previewInteractionRewards} headline so users can see
    ///         which loans drove their daily share of the pool.
    /// @dev    Storage is sequential (`userRewardEntryIds[user]` →
    ///         `rewardEntries[id]`); this view materialises both in one
    ///         call. A loan that involved the user on both sides has
    ///         two entries — one per side. Closed entries (`endDay > 0`)
    ///         are still surfaced so the breakdown reads as a lifetime
    ///         participation list, not just an open-now snapshot. The
    ///         array length is bounded by the user's loan-participation
    ///         count, so unbounded growth isn't a concern in practice.
    /// @param  user Address whose entries to enumerate.
    /// @return entries Full {RewardEntry} struct array in registration order.
    function getUserRewardEntries(address user)
        external
        view
        returns (LibVaipakam.RewardEntry[] memory entries)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage ids = s.userRewardEntryIds[user];
        entries = new LibVaipakam.RewardEntry[](ids.length);
        for (uint256 i = 0; i < ids.length; ++i) {
            entries[i] = s.rewardEntries[ids[i]];
        }
    }

    // ─── #969 / S5 — diamond-internal reward-lifecycle hooks ─────────────────
    //
    // PrecloseFacet must close / re-point reward entries when it flips a loan's
    // lifecycle, but it is a god-facet already at the EIP-170 ceiling, so
    // inlining the {LibInteractionRewards.closeLoan} / {repointRewardEntry} call
    // graph there tips it over the limit. These thin `external` hooks keep that
    // graph HERE (this facet has headroom) and PrecloseFacet reaches them with a
    // cheap `address(this).call` cross-facet hop. They are strictly
    // diamond-internal: only the Diamond itself (a routed cross-facet call) may
    // invoke them — a direct external caller reverts.

    /// @notice Diamond-internal: emitted signal is none — reverts if not self.
    error RewardHookCallerNotSelf();

    /// @notice Close a loan's reward entries on a terminal preclose. The lender
    ///         is always repaid (never forfeits); `borrowerClean` is false for a
    ///         LATE preclose (past grace — a non-clean close forfeits the
    ///         borrower reward, matching the repay/default convention) and true
    ///         for an in-grace full early repayment. (Codex #1061 P2)
    /// @param  loanId       The loan being terminally preclosed.
    /// @param  borrowerClean Whether the borrower side keeps its reward.
    function precloseRewardClose(uint256 loanId, bool borrowerClean) external {
        if (msg.sender != address(this)) revert RewardHookCallerNotSelf();
        LibInteractionRewards.closeLoan(loanId, borrowerClean, false);
    }

    /// @notice Preclose Option-2 obligation transfer (loan stays Active under a
    ///         re-originated term + incoming borrower). SPLITS the reward windows
    ///         at the transfer day (Codex #1061 P2): closes the exiting parties'
    ///         entries at today — the exiting borrower paid the accrued interest
    ///         to complete the transfer so keeps its earned portion (clean, no
    ///         forfeit) and the unchanged lender keeps its earned portion — then
    ///         re-registers fresh entries for the continuing loan under the new
    ///         rate/duration, so the INCOMING borrower only earns from the
    ///         transfer forward (never the previous borrower's history) and the
    ///         lender accrues at the re-originated rate.
    /// @param  loanId The loan whose obligation transferred.
    function precloseRewardTransferObligation(uint256 loanId) external {
        if (msg.sender != address(this)) revert RewardHookCallerNotSelf();
        LibVaipakam.Loan storage l = LibVaipakam.storageSlot().loans[loanId];
        // #1067 — `closeLoan` re-anchors the EXITING entries to their live NFT
        // holders (centralized) then closes them clean, so the buyer of a
        // transferred position keeps the slice they earned pre-transfer.
        LibInteractionRewards.closeLoan(loanId, /* borrowerClean */ true, false);
        // Fresh continuing-loan entries. Codex #1147 r1 F4 — the LENDER side
        // anchors to the CURRENT lender-NFT holder, not the (possibly stale)
        // l.lender, so post-transfer lender rewards don't accrue to a prior
        // stored lender who sold their NFT. The BORROWER side is the incoming
        // obligor l.borrower (migrateBorrowerPosition re-mints the borrower NFT
        // to it right AFTER this hook, so l.borrower is both the obligor and the
        // post-tx NFT holder — Codex r2 F7).
        address freshLender = _currentHolderOr(l.lenderTokenId, l.lender);
        LibInteractionRewards.registerLoan(
            loanId,
            freshLender,
            l.borrower, // == incoming borrower (set before this hook)
            l.principalAsset,
            l.principal,
            l.interestRateBps,
            l.durationDays
        );
    }

    /// @notice #1067 — terminal reward close for a LIQUIDATION-class terminal
    ///         (borrower forfeits DURABLY, lender keeps). Diamond-internal.
    ///         Stamping `forfeited + closed` here is the one fix no status-based
    ///         fallback can cover: a later `InternalMatched → Settled` transition
    ///         would otherwise drop the status-derived forfeit and pay the
    ///         liquidated borrower (Codex #1061 P1). `closeLoan` also re-anchors
    ///         the (kept) lender side to its live holder.
    function liquidationRewardClose(uint256 loanId) external {
        if (msg.sender != address(this)) revert RewardHookCallerNotSelf();
        LibInteractionRewards.closeLoan(loanId, /* borrowerClean */ false, false);
    }

    /// @notice #1067 — terminal reward close for a PROPER close / window-shrink
    ///         (lender never forfeits; the SALE path is the only lender-forfeit
    ///         route). Diamond-internal. Used by the prepay-sale + periodic
    ///         auto-deduct terminal paths. `closeLoan` re-anchors both sides to
    ///         their live holders before shrinking + closing.
    function terminalRewardClose(uint256 loanId, bool borrowerClean) external {
        if (msg.sender != address(this)) revert RewardHookCallerNotSelf();
        LibInteractionRewards.closeLoan(loanId, borrowerClean, false);
    }

    /// @notice #1067 — lender-position SALE reward transfer (early-withdrawal):
    ///         forfeit the exiting lender's entry to treasury and open a fresh
    ///         entry for `newLender` over the residual window. Diamond-internal.
    ///         Hosted here (not inlined at the {EarlyWithdrawalFacet} call sites)
    ///         so the O(1)-indexed transfer body lives once, off that
    ///         EIP-170-tight facet. Called via a BUBBLING self cross-facet call
    ///         (the sale forfeit must not be silently dropped), so the caller-self
    ///         guard is the trust boundary.
    function transferLenderRewardEntry(uint256 loanId, address newLender) external {
        if (msg.sender != address(this)) revert RewardHookCallerNotSelf();
        LibInteractionRewards.transferLenderEntry(loanId, newLender);
    }

    /// @dev #1067 — current holder of `tokenId` (falls back to `fallbackAddr`
    ///      on a burned/absent token). Used only for the fresh continuing-loan
    ///      lender anchor in {precloseRewardTransferObligation}.
    function _currentHolderOr(uint256 tokenId, address fallbackAddr)
        private
        view
        returns (address)
    {
        try IERC721(address(this)).ownerOf(tokenId) returns (address holder) {
            return holder == address(0) ? fallbackAddr : holder;
        } catch {
            return fallbackAddr;
        }
    }
}
