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


    // Governor PR-3a (#1217) — the former `InteractionForfeitedToTreasury`
    // event and its treasury transfer are REPLACED: forfeited reward
    // accruals now stay in Diamond custody and credit the recycle bucket
    // (owner directive: no burning — recycle absorbed VPFI into the reward
    // stream). {LibVpfiRecycle.VpfiRecycled} is the observability signal.
    // No off-chain consumer read the old event (grep-verified at removal).


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
        if (s.vpfiToken == address(0)) revert VPFITokenNotSet();

        // #1699 r18 — the forfeit armed leg settles through the day engine
        // (see {LibInteractionRewards.sweepForfeitedByLoanId}). This facet
        // now only assembles the engine's budgets — identically to the
        // expiry facet, one bound per source — and books what the engine
        // reports back. The hand-rolled gate, pro-rata attribution and
        // aggregate pool clamp are gone: the engine caps, splits and bounds
        // PER DAY, defers what is recoverable (delivered, backing) and
        // truncates only against the monotone 69M cap.
        uint256 paidOut = s.interactionPoolPaidOut;
        uint256 headroom;
        bool freshRecoverable;
        {
            uint256 reserved = paidOut + s.rewardBudgetRemittedGlobal;
            headroom = LibVaipakam.VPFI_INTERACTION_POOL_CAP > reserved
                ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - reserved
                : 0;
            (, , uint256 backingRoom) = LibVpfiRecycle.backingPosition(s);
            freshRecoverable = backingRoom < headroom;
            if (backingRoom < headroom) headroom = backingRoom;
        }
        uint256 allowance = LibVaipakam.isMirrorRewardChain(s)
            ? LibInteractionRewards.deliveredFreshBound(s)
            : type(uint256).max;

        (
            uint256 freshCredited,
            uint256 recycledReleased,
            uint256 armedOwed,
            uint256 armedDelivered
        ) = LibInteractionRewards.sweepForfeitedByLoanId(
            loanId, headroom, allowance, freshRecoverable
        );
        // r18 P2 — NO unconditional exhaustion revert: a zero-liability
        // forfeit (dust cap, zero-flooring days) must still retire at pool
        // exhaustion, and a deferred day is a retryable wait, not an error.
        // "Nothing happened" is a zero return, exactly like the expiry batch.
        swept = freshCredited + recycledReleased;
        if (swept == 0 && armedOwed == 0) return 0;

        s.interactionPoolPaidOut = paidOut + freshCredited;
        // The commitment retires by what each chunk OWED (cappedOff
        // included) — never merely what moved (the r10 rule).
        if (armedOwed != 0) {
            LibInteractionRewards.consumeArmedFresh(armedOwed);
        }
        // #1434 P1-b — charge the mirror's delivered bound with the armed
        // fresh that actually moved, which the engine attributed per day.
        if (armedDelivered != 0 && LibVaipakam.isMirrorRewardChain(s)) {
            s.rewardBudgetArmedFreshPaid += armedDelivered;
        }

        // Governor PR-3a/PR-3c (#1217 §4) — forfeit source split: the
        // FRESH share stays in Diamond custody and credits the recycle
        // bucket (genuine absorption); the RECYCLED share never left the
        // bucket, so its commitment releases with ZERO new credit.
        if (freshCredited > 0) {
            LibVpfiRecycle.credit(
                LibVpfiRecycle.RecycleSource.ForfeitedReward,
                loanId,
                freshCredited
            );
        }
        if (recycledReleased > 0) {
            LibVpfiRecycle.releaseCommitment(
                LibVpfiRecycle.RecycleSource.ForfeitedReward,
                loanId,
                recycledReleased
            );
        }
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

    // The read-only view/getter surface — the interaction getters
    // (previewInteractionRewards, getInteractionSnapshot, etc.) PLUS the RL-3
    // reads getRewardEntryExpiry + getUserRewardEntryIds — was EXTRACTED into
    // {InteractionRewardsLensFacet} to reclaim EIP-170 runtime-bytecode
    // headroom on this facet. Both facets share the same LibVaipakam storage,
    // so the Diamond routes those selectors to the sibling lens facet with no
    // behaviour change. This facet keeps only the mutating claim/sweep/admin
    // surface + the diamond-internal reward-lifecycle hooks.

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
