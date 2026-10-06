// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";

/**
 * @title  RewardEpochViewFacet
 * @notice The static armed-need reads (A2-iii, row 13): the user's aggregate
 *         armed-fresh requirement, the same with its legs, and one entry's.
 *         #1566 sanctions slice — the staging records' reads that used to
 *         live here (a record, its pages, a batch's priority window, the
 *         encumbrance count) moved to {RewardStagingDomainFacet}, with the
 *         same selectors: these three reads inline most of the claim engine,
 *         and viaIR's inlining is non-local, so library growth elsewhere moved
 *         this facet's size by hundreds of bytes and tipped it over EIP-170
 *         with none of its own code changed. A host split gives it lasting
 *         headroom; byte-shaving would not.
 * @dev    #1566 transport epochs PR 3b-ii-A (Codex #2276 r2) hosted the
 *         claim's dry run, the allocation domain's needs and the domain
 *         probe here. A2-iii retired all three: a preview is now the claim
 *         itself run in a reverting frame
 *         ({RewardClaimFacet.simulateClaimInteractionRewards}), the static
 *         consumers read row 13's O(1) prepared-coverage figure on the lens
 *         ({InteractionRewardsLensFacet.getUserArmedFreshNeedWithLegs},
 *         {InteractionRewardsLensFacet.getRewardEntryArmedNeed}), and the
 *         domain pre-pass was inert under the round-26 rule. Their selectors
 *         carry Remove legs in the in-place refresh. The ledger facet
 *         ({RewardEpochFacet}) keeps the writes and the ledger-only reads.
 *         No access control: nothing here writes.
 */
contract RewardEpochViewFacet {
    // ───────── A2-iii — the static armed-need reads (row 13), hosted here ─────────

    /**
     * @notice #1434 P1-b (Codex #1699 r4) — the user's AGGREGATE capped
     *         armed-fresh requirement, as the claim itself computes it.
     * @dev    Hosted HERE, on the roomy view facet (A2-iii): the static read
     *         inlines the day pricing engine, and every facet that reaches it
     *         directly carries a copy — the expiry path once blew EIP-170 by
     *         5,037 bytes that way, and the lens, which hosted the three
     *         armed-need reads until A2-iii, by 1,023. One host; every other
     *         consumer — the lens's preview, the clock, the sweeps — reaches
     *         it by Diamond staticcall on the unchanged selectors.
     *
     *         Grouped and D1-capped, NOT a sum of per-entry prices: entries
     *         sharing a `(user, side, day)` ceiling would otherwise overstate
     *         the need and pause the expiry clock on funding nobody owes.
     *
     *         Measured with the delivered allowance SLACK. This is what the
     *         group needs; clamping it by the allowance it is then compared
     *         against would be circular and report every user as exactly
     *         affordable.
     * @param  user The claimant.
     * @return armed Capped armed fresh the user's open claim would consume.
     */
    function getUserArmedFreshNeed(address user)
        external
        view
        returns (uint256 armed)
    {
        return LibInteractionRewards.userArmedFreshNeedView(user);
    }

    /**
     * @notice Codex #1499 r6 P2 — the armed need together with the legacy legs
     *         its budget is derived from.
     * @dev    The horizon predicate reaches this by staticcall (an EIP-170
     *         requirement, see {LibInteractionRewards}), and it needs the same
     *         two legacy legs the walk's budget already computed. Returning
     *         them here is what keeps that O(entries) pass to ONE per swept
     *         entry instead of one on each side of the Diamond boundary. The
     *         scan runs before the unarmed early return, so the duplicate was
     *         paid on every chain rather than only on armed ones.
     *
     *         Additive on purpose: {getUserArmedFreshNeed} keeps its selector
     *         and its callers, so no routed selector is retired here.
     * @param  user The claimant.
     *         The shape stays FLAT and the first four outputs stay where they
     *         were (Codex #2276 r2 P2): the three readings 3b-ii-A added are
     *         appended, so a caller regenerated against the package keeps
     *         `armed` / `userLegs` / `treasuryLegs` / `legacyFresh` by name
     *         and by position. The library reads the same words as one
     *         struct ({LibInteractionRewards.ArmedNeed}, whose members are in
     *         this order), so the gates decode one shape.
     * @param  user The claimant.
     * @return armed        Capped armed fresh the user's open claim would
     *                      consume — the FULL figure, epoch-paid fresh
     *                      included (what the emission cap and the armed
     *                      commitment are charged).
     * @return userLegs     Legacy legs bound for the user.
     * @return treasuryLegs Legacy legs bound for treasury (they reserve too).
     * @return legacyFresh  #1566 closure 2 — the FRESH part of both legacy
     *                      legs PLUS the legacy window the claim settles
     *                      first. The executability predicate and the sweeps
     *                      measure the claimant's aggregate VINTAGE-BLIND fresh
     *                      need (the live-funded armed part plus this, capped
     *                      at the pool) against the delivered bound, because
     *                      the claim's delivery chokepoint refuses on the
     *                      TOTAL fresh component: a predicate that measured
     *                      only the armed part would read a legacy-only
     *                      claimant executable while their claim reverts, and
     *                      run their expiry clock.
     * @return bucketRecycled The read's days' draw on the recycle bucket,
     *                      net of what their prepared coverage pays.
     * @return capHit       A read day is NOT a day this claim would pay now —
     *                      a wide unprepared day, or a day a staging record
     *                      holds in any phase — so the claim would defer it;
     *                      preparation clears the former, the record's own
     *                      resolution the latter.
     * @return liveArmed    The part of `armed` the live delivery must fund;
     *                      the delivered and backing gates' figure.
     * @return userPaid     What the read's days would pay the USER, every
     *                      source — the conservative preview's armed part.
     *
     *         A2-iii SPECIFICATION CHANGE: the armed figures are row 13's
     *         STATIC read — per side, the FIRST pending armed day priced
     *         against PREPARED coverage (the one batch at the day's cursor;
     *         a day a staging record holds reads `capHit`) and the live
     *         sources, stopping at the first side that reads `capHit` — not
     *         a simulated walk of the whole chunk, which a view cannot run
     *         now that a preview is the settlement in a reverting frame.
     *         Conservative: never over-counts; a day no preparation has
     *         covered reads `capHit`. Eight outputs; the eighth is appended.
     */
    function getUserArmedFreshNeedWithLegs(address user)
        external
        view
        returns (
            uint256 armed,
            uint256 userLegs,
            uint256 treasuryLegs,
            uint256 legacyFresh,
            uint256 bucketRecycled,
            bool capHit,
            uint256 liveArmed,
            uint256 userPaid
        )
    {
        LibInteractionRewards.ArmedNeed memory n = LibInteractionRewards.userArmedFreshNeedWithLegsView(user);
        return (n.armed, n.userLegs, n.treasuryLegs, n.legacyFresh, n.bucketRecycled, n.capHit, n.liveArmed, n.userPaid);
    }

    /**
     * @notice The same static read for ONE reward entry's own pending day —
     *         the per-obligation figure the expiry clock and the sweeps read
     *         (A2-iii, row 13): the entry's day priced against its prepared
     *         coverage, the user's legacy figures beside it, same eight
     *         outputs. An entry not on its side's armed worklist (a purely
     *         legacy one) carries zero armed figures.
     * @dev    Reached by the clock through a Diamond staticcall for the same
     *         EIP-170 reason as its user-level sibling: ONE implementation,
     *         hosted here, never inlined into a settle facet.
     * @param  entryId The reward entry.
     */
    function getRewardEntryArmedNeed(uint256 entryId)
        external
        view
        returns (
            uint256 armed,
            uint256 userLegs,
            uint256 treasuryLegs,
            uint256 legacyFresh,
            uint256 bucketRecycled,
            bool capHit,
            uint256 liveArmed,
            uint256 userPaid
        )
    {
        LibInteractionRewards.ArmedNeed memory n = LibInteractionRewards.entryArmedNeedView(entryId);
        return (n.armed, n.userLegs, n.treasuryLegs, n.legacyFresh, n.bucketRecycled, n.capHit, n.liveArmed, n.userPaid);
    }
}
