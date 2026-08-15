// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  RewardHorizonSweepFacet
 * @author Vaipakam Developer Team
 * @notice #1434 — the permissionless claim-horizon sweep, on its own facet.
 *
 * @dev WHY THIS FACET EXISTS (EIP-170, measured — do not fold it back).
 *
 *      Expiry settles through `processUserSideDay` + `_persistDay`, the SAME
 *      ShareOfPool engine the claim walk uses. That unification is the point:
 *      expiry previously re-derived the D1-capped obligation by hand and got
 *      it wrong three review rounds running, because owning a second
 *      implementation of settlement — not the arithmetic — was the defect.
 *
 *      Sharing the engine costs bytecode wherever the sweep lives, and in a
 *      Diamond reuse and inlining pull in opposite directions:
 *
 *        • hosted on InteractionRewardsFacet the engine inlines fresh, so the
 *          sweep costs ~12.8 KB and took that facet to 28,607 / 24,576;
 *        • hosted on RewardClaimFacet the engine is already present, so the
 *          marginal cost drops to ~6.8 KB — still 4,224 over, because that
 *          facet had only 2,593 B of headroom.
 *
 *      Neither existing host fits, so the sweep gets its own: engine + sweep
 *      standalone is ~12.8 KB, comfortably inside the limit. This is the same
 *      remedy already applied twice here — the #1306 lens split and the #1351
 *      slice-2c claim move — for the same reason.
 *
 *      The 4-byte selector is unchanged throughout, so on-chain callers at the
 *      Diamond address are unaffected; only the per-facet ABI json and the
 *      deploy wiring move.
 */
contract RewardHorizonSweepFacet is
    DiamondAccessControl,
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
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
                uint256 freshCredited,
                uint256 armedDelivered
            ) = LibInteractionRewards.sweepExpiredEntry(
                entryIds[i], headroom, allowance
            );
            headroom -= freshCredited;
            // All-or-nothing per entry, so a credited entry consumed exactly
            // its armed share of the allowance.
            // Codex #1699 r5 P2 — deplete by what was DELIVERED-funded, not
            // by the raw commitment. On a mirror the two differ whenever the
            // D1 group cap bit, and charging the raw figure here would retire
            // allowance for value the entry never received.
            if (freshCredited != 0 && armedDelivered != 0) {
                allowance = allowance > armedDelivered
                    ? allowance - armedDelivered
                    : 0;
            }
            freshTotal += freshCredited;
            recycledTotal += ex.recycled;
            armedFreshTotal += ex.armedFresh;
            // #1434 — charge the mirror's delivered-fresh bound with the ARMED
            // portion actually credited.
            //
            // `armedDelivered` is now supplied by the settlement itself rather
            // than inferred here. The inference this replaces was correct only
            // under the old all-or-nothing-per-ENTRY rule, and that rule is
            // gone: since expiry settles through the day primitive, a sweep
            // terminalises only the days it PRICED, so `freshCredited` IS
            // routinely a partial share and `ex.armedFresh` is no longer the
            // amount that moved. Reading it here would over-charge the bound
            // by the 69M-truncated remainder on every chunked expiry.
            //
            // NOT `armedFreshTotal` either: that is the full COMMITMENT
            // retired by `consumeArmedFresh` below, which deliberately
            // includes the truncated remainder that moved no tokens. Charging
            // it would shrink the bound for value never paid out of a
            // delivery — the defect `interactionPoolPaidOut` was rejected for.
            if (freshCredited != 0) armedFreshPaid += armedDelivered;
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
}
