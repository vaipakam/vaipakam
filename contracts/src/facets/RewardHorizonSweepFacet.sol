// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {LibRewardSanctions} from "../libraries/LibRewardSanctions.sol";

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
 *
 *      #1566 sanctions rule — the sanctions evidence host
 *      ({recordRewardSanctionsEvidence}) lives here too: the self-call target
 *      the owner settlement (`RewardClaimFacet.settleSanctionedInteractionRewards`)
 *      and `LibRewardStaging._pay`'s claimant screen observe through, so the
 *      classifier's writes are hosted once, here, instead of inlined into
 *      those facets. Refresh this facet together with `RewardClaimFacet`,
 *      `RewardStagingSettleFacet` and `RewardSweepWalkFacet` — a settle or
 *      claim facet refreshed without the evidence host reverts every
 *      observation it makes.
 *      The expiry walk no longer screens sanctions itself: its barred-owner
 *      test moved into the seam inlined HERE (`_barredObservation`, at the
 *      head of `LibInteractionRewards.callSweepExpiredEntryWalk`). A new walk
 *      facet behind an old copy of this one screens on neither side, so a
 *      barred owner's expiry clock would run while the claim gate refuses
 *      them and their entries could expire into the bucket. That breaks the
 *      clock's rule that nothing is reaped while its claimant cannot claim,
 *      and it hits an unconfirmed (Hold) owner who is later delisted. The
 *      walk is therefore never refreshed without this facet.
 */
contract RewardHorizonSweepFacet is
    DiamondAccessControl,
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    /// @notice Declared for the exported ABI: `LibInteractionRewards.forfeitEntryChunkEvented`
    ///         emits it on `RewardForfeitWalkFacet` (Diamond-internal, outside the
    ///         exported ABI set) for every settled chunk of the per-loan forfeit
    ///         sweep. Without this declaration no
    ///         consumer ABI (DIAMOND_ABI, or the indexer EVENT_ABI derived from it) can
    ///         decode the per-entry settlement row. Same signature as the library event.
    /// @dev    UNTRIMMED FORFEIT PRICING: `fresh` / `recycledReleased` are the forfeit
    ///         route's pricing of the entry's day, which the loan-side reward cap never
    ///         binds (a forfeit pays no side), so they can exceed what the same day would
    ///         have paid the owner as a claim. This row is per-entry PROVENANCE, not the
    ///         ledger: reconcile amounts from `VpfiRecycled` (source `ForfeitedReward`)
    ///         and the custody-row events, never from this.
    /// @custom:event-category state-change/reward-claim
    event RewardEntryForfeitSettled(
        uint256 indexed entryId,
        address indexed user,
        uint256 indexed loanId,
        uint256 fresh,
        uint256 recycledReleased
    );

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
    /// @dev Batch loop accumulators. A LOCAL memory struct, never an ABI
    ///      type — it exists to hold the loop's running totals behind a
    ///      single stack slot (see the viaIR note at its use site).
    struct SweepTotals {
        uint256 fresh;
        uint256 recycled;
        uint256 armedFresh;
    }

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
        uint256 headroom;
        uint256 backingCap;
        {
        // Block-scoped so `reserved` and `backingRoom` die before the loop —
        // the loop frame sits exactly at the viaIR stack ceiling.
        uint256 reserved = paidOut + s.rewardBudgetRemittedGlobal;
        headroom = LibVaipakam.VPFI_INTERACTION_POOL_CAP > reserved
            ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - reserved
            : 0;
        // The fresh credit also grows the recycle bucket, so it must stay
        // within the bucket's BACKING headroom — {LibVpfiRecycle.credit}
        // reverts unless `balance >= recycleBucket + freshTotal`, and a
        // reverting credit would poison the whole permissionless batch
        // (Codex #1317 r9). The pool cap bounds ALL credited fresh; the
        // backing room bounds the LIVE-paid fresh, so since 3b-ii-A it is
        // folded into the delivered allowance, which the loop depletes by
        // exactly that live-paid figure.
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
        uint256 backingRoom = LibVpfiRecycle.freshBackingRoom(s);
        // Pre-merge adversarial review (2026-08-17) P1 — the two bounds have
        // opposite recovery semantics: the pool-cap room is MONOTONE (only
        // ever shrinks; waiting on it livelocks), the backing room is a
        // HELD-BALANCE constraint that recovers with any custody inflow.
        // Folding both into one number once made the settlement attribute a
        // transient backing dip to `freshShortfall`, the quantity the
        // post-removal rule truncates PERMANENTLY. They are therefore carried
        // to the engine SEPARATELY — the pool cap as `headroom`, backing
        // inside the delivered allowance below — and the engine attributes
        // each day's shortfall to its own bound. The per-batch flag that used
        // to say which bound made a folded minimum is gone (Codex #2276 r2
        // P2): computed once at batch start, it went stale as soon as an
        // epoch-paid entry depleted `headroom` without touching the backing
        // allowance, and a later pool-trimmed removed entry deferred on a
        // bound that cannot recover.
        // 3b-ii-A — backing bounds the LIVE-paid fresh only, so it rides the
        // delivered term below rather than the pool budget: an epoch-paid
        // expiry is backed by the epoch's own custody and must be able to
        // settle while the live row is empty. A backing shortfall still
        // DEFERS, now as a delivered-caused one.
        backingCap = backingRoom;
        }
        // Loop accumulators packed into ONE stack slot (a memory pointer) —
        // the sweep loop frame sits exactly at the viaIR stack ceiling, and
        // four scalar totals held live across the loop tipped it over.
        SweepTotals memory t;
        // Codex #1699 r2 P1 — the delivered allowance is threaded and depleted
        // per entry, exactly as `headroom` above it. `sweepExpiredEntry` used
        // to read the storage figure itself, which is stale for every entry
        // after the first because this facet only accumulates
        // `rewardBudgetArmedFreshPaid` AFTER the loop: two 0.4 entries against
        // 0.5 remaining both passed and 0.8 was credited from unrelated
        // custody. Same defect the walk had one round earlier — one fix, two
        // sites, and I shipped only the first.
        // #1566 closure 3 — the twin of the forfeit sweep's allowance in
        // {InteractionRewardsFacet}. Same collapse for the same reason: the
        // bound already answers for every role, and the negation's "not a
        // mirror" arm handed `Detached` an unbounded expiry allowance.
        uint256 allowance = LibInteractionRewards.deliveredFreshBound(s);
        if (backingCap < allowance) allowance = backingCap;
        // 3b-ii-A — the epoch-paid legs the sweep draws, absorbed net below.
        LibInteractionRewards.TransportLegs memory tp;
        for (uint256 i = 0; i < entryIds.length; ) {
            uint256 tBefore = tp.treasuryFresh + tp.userFresh + tp.treasuryEraFresh + tp.userEraFresh;
            (
                LibInteractionRewards.EntrySplit memory ex,
                uint256 freshCredited,
                /* armedDelivered — the engine's per-day attribution; the
                   allowance depletes by the fresh credited (#1566 closure 2) */
            ) = LibInteractionRewards.callSweepExpiredEntryWalk(
                entryIds[i], headroom, allowance, tp
            );
            // #1566 sanctions slice (S3-A3) — FLOORED: a chunk reports its live
            // credit PLUS the epoch-funded leg riding on top of it, so the figure
            // can exceed the headroom it was handed, and an unfloored subtraction
            // panicked (0x11) the whole permissionless batch. The 69M cap itself is
            // still enforced inside the engine; this is only the running budget.
            headroom = headroom > freshCredited ? headroom - freshCredited : 0;
            // #1566 closure 2 — the allowance depletes by the FRESH credited,
            // legacy and armed alike: that is exactly what the reward
            // operation charges against the delivered ledger below. (Codex
            // #1699 r5 P2 had it deplete by the armed share the engine
            // attributed — right while only armed fresh was charged; the
            // credited figure is already the cap-trimmed amount that moves.)
            // 3b-ii-A — and NET of the epoch-paid fresh, which the delivered
            // ledger never received.
            uint256 liveFresh =
                freshCredited - (tp.treasuryFresh + tp.userFresh + tp.treasuryEraFresh + tp.userEraFresh - tBefore);
            allowance = allowance > liveFresh ? allowance - liveFresh : 0;
            t.fresh += freshCredited;
            t.recycled += ex.recycled;
            t.armedFresh += ex.armedFresh;
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
            unchecked { ++i; }
        }
        // Codex #1699 r10 P1 — a CAPPED-ONLY terminal chunk still has a
        // commitment to retire.
        //
        // Once removal has begun a shortfall truncates and terminalises, so a
        // final chunk can move NO tokens (`freshTotal` and `recycledTotal`
        // both zero) while carrying the whole remaining obligation in
        // `armedFreshTotal` via `cappedOff`. Returning here on the token
        // totals alone skipped `consumeArmedFresh` for exactly that chunk, and
        // the commitment stayed in `outstandingCommitFresh` forever —
        // depressing fundability for every later day even after backing
        // recovered, on an entry nobody can claim any more.
        //
        // The comment below already promised this retirement happens "even
        // when the pool cap truncated the creditable fresh". This is the
        // guard that was contradicting it.
        expiredTotal = _settleSweepTotals(s, paidOut, t, tp);
    }

    /// @dev The sweep's post-loop settle: the pool reservation check, the paid-out
    ///      and armed-commitment bookkeeping, and the one leg settle under the
    ///      expired-reward source. (The retirement, B-6, settles its own: it draws
    ///      and credits nothing.)
    function _settleSweepTotals(
        LibVaipakam.Storage storage s,
        uint256 paidOut,
        SweepTotals memory t,
        LibInteractionRewards.TransportLegs memory tp
    ) private returns (uint256 total) {
        if (t.fresh + t.recycled == 0 && t.armedFresh == 0) return 0;

        // Fresh share: consumes the 69M pool (tokens leave the fresh
        // budget) exactly like a forfeit — already per-entry capped above.
        // A staging reservation binds as a deferral, never a truncation
        // (3b-ii-A2, #2305): the batch waits rather than spend headroom a
        // standing record holds.
        {
            uint256 available = LibInteractionRewards.poolAvailable();
            if (t.fresh > available) revert InteractionPoolReservedShortfall(t.fresh, available);
        }
        s.interactionPoolPaidOut = paidOut + t.fresh;
        // Every swept entry is terminally `processed`, so its ENTIRE armed
        // fresh commitment retires here even when the pool cap truncated the
        // creditable fresh — otherwise the truncated remainder would sit
        // in the outstanding-commitment sum forever (same rule as the claim
        // and forfeit paths).
        LibInteractionRewards.consumeArmedFresh(t.armedFresh);
        // #1566 closure 2 — the paid ledger is charged by the reward
        // operation below with the FRESH total that expires into the bucket,
        // legacy and armed days alike, and the credit is refused if that
        // exceeds the remaining delivered headroom. The armed-only,
        // mirror-only `+= t.armedFreshPaid` that stood here charged by
        // vintage, and the accumulator that fed it is gone with it; the
        // per-entry `allowance` decrement above is the only consumer of
        // `armedDelivered` now.
        // 3b-ii-A — the LIVE-funded fresh absorbs as before; the epoch-funded
        // legs recycle in place from the epochs' custody (§5c); see the
        // forfeit sweep for why the user legs are folded in.
        uint256 epochFresh = tp.treasuryFresh + tp.userFresh;
        uint256 eraFresh = tp.treasuryEraFresh + tp.userEraFresh; // PR C-2: era-funded, absorbed by the hosted settle with no bound charge
        // ONE leg settle for every close-out (A2-ii): the live-funded fresh
        // absorbed as expired reward, the epoch-funded legs recycled in
        // place, the recycled commitment released — the same implementation
        // the forfeit, the claim and a staged expiry day's payout use.
        LibRewardCustody.callSettleLegs(
            uint8(LibVpfiRecycle.RecycleSource.ExpiredReward),
            t.fresh > epochFresh + eraFresh ? t.fresh - epochFresh - eraFresh : 0,
            epochFresh + tp.treasuryRecycled + tp.userRecycled,
            t.recycled,
            0,
            eraFresh, // PR C-2 - the era-funded legs: absorbed by the host, no bound charge
            0
        );
        total = t.fresh + t.recycled;
    }

    /// @notice 3b-ii-B (B-6) — retire ZERO-PRICED remainders, permissionless: for each
    ///         entry, if it is closed, not forfeited, and its remaining window prices
    ///         to nothing payable — an empty window, or one the loan-side cap trims to
    ///         a zero user split while its raw split stands — the entry is retired
    ///         (marked processed, or one day of it retired as a claim retires a capped
    ///         day; repeat until processed). Anything payable, open, forfeited or not
    ///         yet priceable is left as it is. A retirement moves no value: the
    ///         capped-off commitments retire, the pool is not drawn and nothing is
    ///         credited to the recycle bucket (#1566 PR 1 review: the cap had refused
    ///         that value, so it is retired, never recycled).
    /// @return retiredCount How many of `entryIds` this call moved.
    /// @return settledTotal The commitments the retired days released (fresh and recycled).
    function retireZeroPricedRemainders(uint256[] calldata entryIds)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 retiredCount, uint256 settledTotal)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.interactionLaunchTimestamp == 0) revert InteractionEmissionsNotStarted();
        if (s.vpfiToken == address(0)) revert VPFITokenNotSet();
        uint256 paidOut = s.interactionPoolPaidOut;
        uint256 headroom;
        {
            uint256 reserved = paidOut + s.rewardBudgetRemittedGlobal;
            headroom = LibVaipakam.VPFI_INTERACTION_POOL_CAP > reserved
                ? LibVaipakam.VPFI_INTERACTION_POOL_CAP - reserved
                : 0;
        }
        uint256 allowance = LibInteractionRewards.deliveredFreshBound(s);
        {
            uint256 backingCap = LibVpfiRecycle.freshBackingRoom(s);
            if (backingCap < allowance) allowance = backingCap;
        }
        SweepTotals memory t;
        LibInteractionRewards.TransportLegs memory tp;
        for (uint256 i = 0; i < entryIds.length; ) {
            uint256 tBefore = tp.treasuryFresh + tp.userFresh + tp.treasuryEraFresh + tp.userEraFresh;
            (bool retired, LibInteractionRewards.EntrySplit memory ex, uint256 freshCredited, ) =
                LibInteractionRewards.callRetireZeroPricedRemainderWalk(entryIds[i], headroom, allowance, tp);
            if (retired) ++retiredCount;
            // A retirement credits nothing (`freshCredited` is zero since the
            // #1566 PR 1 review), so the headroom and allowance the walk prices
            // the capped day against stay at their opening values.
            headroom -= freshCredited;
            uint256 liveFresh =
                freshCredited - (tp.treasuryFresh + tp.userFresh + tp.treasuryEraFresh + tp.userEraFresh - tBefore);
            allowance = allowance > liveFresh ? allowance - liveFresh : 0;
            t.fresh += freshCredited;
            t.recycled += ex.recycled;
            t.armedFresh += ex.armedFresh;
            unchecked { ++i; }
        }
        // Nothing was credited (`t.fresh == 0`): retire the commitments as the
        // claim retires a capped day, and draw nothing.
        LibInteractionRewards.consumeArmedFresh(t.armedFresh);
        LibRewardCustody.callSettleLegs(
            uint8(LibVpfiRecycle.RecycleSource.ForfeitedReward), 0, 0, t.recycled, 0, 0, 0
        );
        settledTotal = t.armedFresh + t.recycled;
    }

    // ─── #1566 sanctions rule — the evidence host ────────────────────────────

    /// @notice #1566 sanctions rule — record ONE committed sanctions observation of
    ///         `who`. Permissionless. Returns the verdict (0 Deliver, 1 Hold,
    ///         2 Confirmed) as {LibRewardSanctions.observe} wrote it.
    /// @dev    WHY it exists: confirmation needs observations no more than
    ///         `MAX_OBS_GAP_SECS` apart, and the owner settlement's own observation
    ///         (`RewardClaimFacet.settleSanctionedInteractionRewards`) is lost
    ///         whenever that settlement reverts — this entry only observes, so a
    ///         keeper can keep a chain alive without settling anything. An
    ///         observation that ends a CONFIRMED chain records its window here too,
    ///         so the days the owner earned while flagged stay forfeitable after
    ///         the flag is revoked. It is also the ONE host of the classifier's
    ///         writes for every other caller — the settlement and
    ///         `LibRewardStaging._pay`'s claimant screen reach it by Diamond
    ///         self-call ({LibRewardSanctions.callObserve}) instead of inlining it.
    ///
    ///         NO reentrancy guard, deliberately: its callers reach it from inside a
    ///         frame that already holds the Diamond's guard, so `nonReentrant` here
    ///         would revert every staged claim's last page and every settlement.
    ///         Safe without one — it moves no value, and its only external calls
    ///         are the oracle STATICCALLs. Nobody can forge or break a chain
    ///         through it: every write follows from an authoritative oracle read.
    ///         `whenNotPaused` freezes the evidence with the sweeps; a pause longer
    ///         than the gap restarts the window, by design.
    /// @param  who The wallet to observe.
    /// @return The verdict, `uint8(LibRewardSanctions.Decision)`.
    function recordRewardSanctionsEvidence(address who) external whenNotPaused returns (uint8) {
        return uint8(LibRewardSanctions.observe(LibVaipakam.storageSlot(), who));
    }

    /// @notice #1566 sanctions rule — whether reward `who` earned on day `d` was
    ///         earned while a CONFIRMED flag stood, and so is forfeited whenever
    ///         it settles. The ONE host of the window loop
    ///         ({LibRewardSanctions.dayForfeitedFull}): the reward walks (at
    ///         EIP-170) inline only the two-read fast path and reach this by
    ///         self-staticcall for a wallet with sanctions history. A plain read,
    ///         also for keepers and apps.
    function rewardSanctionsDayForfeited(address who, uint256 d) external view returns (bool) {
        return LibRewardSanctions.dayForfeitedFull(LibVaipakam.storageSlot(), who, d);
    }

    /// @notice #1566 sanctions rule — the part of entry `id`'s legacy (pre-`D*`)
    ///         slice over the days `[lo, hi)`, capped at `slice`, that its owner
    ///         earned while a CONFIRMED flag stood. The ONE host of that loop
    ///         ({LibInteractionRewards.legacyWindowShareFull}), reached by the
    ///         legacy slice's settle (`RewardStagingDomainFacet`, at EIP-170) by
    ///         self-staticcall, only for an owner with sanctions history. A plain
    ///         read.
    function rewardSanctionsLegacyWindowShare(uint256 id, uint256 lo, uint256 hi, uint256 slice)
        external
        view
        returns (uint256)
    {
        return LibInteractionRewards.legacyWindowShareFull(LibVaipakam.storageSlot(), id, lo, hi, slice);
    }
}
