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
        // Codex #1699 r1 P1 — ENFORCE the delivered bound here, before any of
        // this sweep's effects become final.
        //
        // `sweepForfeitedByLoanId` above has already processed the entries, so
        // charging the bound afterwards (as the first revision did) records an
        // overspend instead of preventing one: a permissionless caller could
        // absorb armed fresh that was never delivered, backed by VPFI the
        // Diamond holds for other obligations. Reverting rolls the whole
        // sweep back, which is the right shape for a DELIVERED shortfall —
        // it is a satisfiable wait, retryable the moment funding lands, not a
        // permanent refusal.
        //
        // Armed fresh only: a forfeit's PRE-`D*` fresh predates arming and no
        // remittance ever funded it, so bounding that would strand ordinary
        // forfeits on every mirror. And the recycled leg is untouched for the
        // same reason the exhaustion check above spares it — it never left the
        // bucket, so it needs no delivered backing and its commitment must
        // still be releasable.
        uint256 freshWanted = freshSwept;
        if (freshSwept > remaining) freshSwept = remaining;

        // Codex #1699 r2 P2 — gate on what this sweep will ACTUALLY charge,
        // not on its nominal armed share.
        //
        // The clamp above may truncate the fresh spend, and the charge below
        // is the resulting pro-rata armed portion. Testing the nominal share
        // made the gate too STRICT in the opposite direction: near 69M
        // exhaustion a mixed pre-/post-arming forfeiture could revert even
        // though the amount it would really charge fits the allowance, leaving
        // the entry AND its commitment stuck waiting for delivery that is
        // unnecessary — and that could never help, since the binding limit
        // there is the monotone cap. A bound can fail by refusing too much as
        // well as by permitting too much; the first revision only guarded the
        // second.
        //
        // Computed here so the gate and the charge below cannot diverge: one
        // expression, read twice.
        uint256 armedPaid;
        if (freshSwept != 0 && sweepSplit.armedFresh != 0) {
            if (freshSwept >= freshWanted) {
                armedPaid = sweepSplit.armedFresh;
            } else {
                // Codex #1699 r1 P2 — round the pro-rata share UP. Flooring
                // per sweep discards the remainder every call
                // (`armedFresh = 1, freshWanted = 2, freshSwept = 1` records
                // ZERO), and repeating that shape lets delivered funding be
                // reused without limit. Carrying dust across calls would need
                // a stored accumulator and a retry-reconciliation rule;
                // ceiling is the closed-form alternative and errs by at most
                // one wei in the direction that TIGHTENS the bound.
                uint256 num0 = sweepSplit.armedFresh * freshSwept;
                armedPaid = (num0 + freshWanted - 1) / freshWanted;
                if (armedPaid > sweepSplit.armedFresh) {
                    armedPaid = sweepSplit.armedFresh;
                }
            }
        }
        if (armedPaid != 0 && LibVaipakam.isMirrorRewardChain(s)) {
            uint256 allowance = LibInteractionRewards.deliveredFreshBound(s);
            if (armedPaid > allowance) {
                revert DeliveredFreshShortfall(armedPaid, allowance);
            }
        }
        swept = freshSwept + sweepSplit.recycled;
        s.interactionPoolPaidOut = paidOut + freshSwept;

        // PR-3c consume-at-sweep: retire the FULL armed-fresh commitment —
        // the entries are processed either way (see the claim path note).
        LibInteractionRewards.consumeArmedFresh(sweepSplit.armedFresh);

        // #1434 P1-b — charge the mirror's delivered-fresh bound with the
        // ARMED portion of what this sweep actually spent.
        //
        // Unlike the expiry batch (all-or-nothing per entry), the cap here can
        // truncate PARTIALLY, so the armed share of the surviving spend has to
        // be attributed. This uses PRO-RATA, deliberately:
        //
        //   • The truncation is a pool-exhaustion clamp on the aggregate. It
        //     expresses no preference between the armed and unarmed days
        //     inside the sweep, so scaling both by the same factor is the
        //     neutral reading of what was paid.
        //   • The FRESH-FIRST precedent nearby ({_applyLoanSideCap}, and the
        //     trim in {_dayCaps}) is NOT authority for armed-first here: it
        //     attributes fresh-vs-RECYCLED, and it is fresh-first only because
        //     `_applyLoanSideCap` genuinely fills headroom from fresh before
        //     recycled. No comparable ordering exists between armed and
        //     unarmed fresh, so borrowing that rule would invent one.
        //
        // Both mis-attributions are harmful, which is why this is stated
        // rather than defaulted: over-charging shrinks the bound permanently
        // and would eventually defer fully-funded days (a wedge), while
        // under-charging lets a mirror pay armed fresh it never received.
        // `consumeArmedFresh`'s argument is again NOT the figure — it is the
        // full commitment, cap-truncated remainder included.
        // Charge the SAME figure the gate above tested — computed once,
        // read twice, so the amount refused and the amount recorded can never
        // diverge. (The rounding rationale lives with that computation.)
        if (armedPaid != 0 && LibVaipakam.isMirrorRewardChain(s)) {
            s.rewardBudgetArmedFreshPaid += armedPaid;
        }

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
     * @notice RL-3 (#1305, ratified §10.2; Codex #1317 r7) — permissionless
     *         claim-horizon sweep. For each entry it advances an
     *         EXECUTABLE-ELAPSED accumulator: it starts on the first touch
     *         that finds the entry claim-executable, and only intervals
     *         during which the entry stayed claimable (with no observation
     *         gap over `REWARD_CLAIM_NOTICE_MAX_OBS_GAP_DAYS`) are credited.
     *         Once an entry has accrued a full `H + notice` of genuinely-
     *         claimable time it is EXPIRED into the recycle bucket. Keepers
     *         drive this on a heartbeat cadence; missed intervals only slow
     *         accrual (safe), and no unobserved outage can reap an entry the
     *         claimant could not actually claim.
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

        // Fresh headroom is tracked PER ENTRY across the batch (Codex
        // #1317 r4): each processed entry's creditable fresh share is
        // capped inside {sweepExpiredEntry} against what the batch has
        // left, so several fresh entries can never all go terminal
        // against one remaining-capacity sliver — at most one bounded
        // boundary entry is partially credited, then the rest defer.
        uint256 paidOut = s.interactionPoolPaidOut;
        uint256 reserved = paidOut + s.rewardBudgetRemittedGlobal;
        uint256 headroom = LibVaipakam.VPFI_INTERACTION_POOL_CAP > reserved
            ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - reserved
            : 0;
        // The fresh credit also grows the recycle bucket, so it must stay
        // within the bucket's BACKING headroom — {LibVpfiRecycle.credit}
        // reverts unless `balance >= recycleBucket + freshTotal`, and a
        // reverting credit would poison the whole permissionless batch
        // (Codex #1317 r9). Cap fresh to the smaller of the pool cap and
        // the backing room; both shrink by the same credited amount, so a
        // single running minimum tracks them.
        //
        // #1498 — the un-earmarked figure comes from
        // {LibVpfiRecycle.backingPosition}, the ONE definition the bucket's
        // owning library exports, rather than being recomputed here. BOTH
        // enforcement sites — this sweep cap and the claim-time reject —
        // inlined `balanceOf − recycleBucket` instead of calling the
        // definition, and the comments stating its limits then drifted
        // apart. Duplicated arithmetic is the drift class. The zero-token
        // case cannot reach the helper's own revert — this function's
        // {VPFITokenNotSet} guard has already rejected it.
        (, , uint256 backingRoom) = LibVpfiRecycle.backingPosition(s);
        if (backingRoom < headroom) headroom = backingRoom;
        uint256 freshTotal;
        uint256 recycledTotal;
        uint256 armedFreshTotal;
        uint256 armedFreshPaid;
        // Codex #1699 r2 P1 — the delivered allowance is threaded and depleted
        // per entry, exactly as `headroom` above it. `sweepExpiredEntry` used
        // to read the storage figure itself, which is stale for every entry
        // after the first because this facet only accumulates
        // `rewardBudgetArmedFreshPaid` AFTER the loop: two 0.4 entries against
        // 0.5 remaining both passed and 0.8 was credited from unrelated
        // custody. Same defect the walk had one round earlier — one fix, two
        // sites, and I shipped only the first.
        uint256 allowance = LibVaipakam.isMirrorRewardChain(s)
            ? LibInteractionRewards.deliveredFreshBound(s)
            : type(uint256).max;
        for (uint256 i = 0; i < entryIds.length; ) {
            (
                LibInteractionRewards.EntrySplit memory ex,
                uint256 freshCredited
            ) = LibInteractionRewards.sweepExpiredEntry(
                entryIds[i], headroom, allowance
            );
            headroom -= freshCredited;
            // All-or-nothing per entry, so a credited entry consumed exactly
            // its armed share of the allowance.
            if (freshCredited != 0 && ex.armedFresh != 0) {
                allowance = allowance > ex.armedFresh
                    ? allowance - ex.armedFresh
                    : 0;
            }
            freshTotal += freshCredited;
            recycledTotal += ex.recycled;
            armedFreshTotal += ex.armedFresh;
            // #1434 P1-b — charge the mirror's delivered-fresh bound with the
            // ARMED portion actually credited.
            //
            // Exact here, with no new per-entry figure needed, because this
            // sweep is ALL-OR-NOTHING per entry (Codex #1317): it terminalises
            // only if the entry's FULL fresh share fits the remaining
            // creditable headroom, and otherwise blocks and credits ZERO. So
            // `freshCredited` is never a partial share, and when it is
            // non-zero the armed portion credited is exactly `ex.armedFresh`
            // — which the entry path builds strictly armed-only from
            // `cumArmEnd - cumArmStart`, so an entry straddling
            // `armedFromDay` already contributes only its armed part.
            //
            // NOT `armedFreshTotal`: that is the full COMMITMENT retired by
            // `consumeArmedFresh` below, which deliberately includes the
            // cap-truncated remainder that moved no tokens. Charging it would
            // shrink the bound for value never paid out of a delivery — the
            // same defect `interactionPoolPaidOut` was rejected for.
            if (freshCredited != 0) armedFreshPaid += ex.armedFresh;
            unchecked { ++i; }
        }
        if (freshTotal + recycledTotal == 0) return 0;

        // Fresh share: consumes the 69M pool (tokens leave the fresh
        // budget) exactly like a forfeit — already per-entry capped above.
        s.interactionPoolPaidOut = paidOut + freshTotal;
        // Every swept entry is terminally `processed`, so its ENTIRE armed
        // fresh commitment retires here even when the pool cap truncated the
        // creditable fresh — otherwise the truncated remainder would sit
        // in the outstanding-commitment sum forever (same rule as the claim
        // and forfeit paths).
        LibInteractionRewards.consumeArmedFresh(armedFreshTotal);
        // #1434 P1-b — mirror-only: Base funds its armed days from the 69M cap
        // directly and receives no remittances, so it has no delivered bound
        // to charge (and charging one would read zero and brick it).
        if (armedFreshPaid != 0 && LibVaipakam.isMirrorRewardChain(s)) {
            s.rewardBudgetArmedFreshPaid += armedFreshPaid;
        }

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
