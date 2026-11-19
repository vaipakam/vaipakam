// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibPriorityRouting} from "../libraries/LibPriorityRouting.sol";
import {LibServiceCapacity} from "../libraries/LibServiceCapacity.sol";
import {LibIntentTerms} from "../libraries/LibIntentTerms.sol";
import {LibMetricsTypes} from "../libraries/LibMetricsTypes.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title LenderIntentViewFacet
 * @author Vaipakam Developer Team
 * @notice The read side of the standing lender intent (#393): one intent's
 *         terms, its live principal and un-lent capital, its priority-routing
 *         snapshot, and the three paginated feeds (every active intent for
 *         the keeper's fill pass, the intent loans a keeper can roll or
 *         re-commit, and one owner's intents for the app).
 * @dev    Split off {LenderIntentFacet} along its read / write seam, which
 *         had passed EIP-170. The functions are moved unchanged: same
 *         selectors, same return shapes, same storage reads. Every mutator
 *         stays on {LenderIntentFacet}. View-only, so this facet holds no
 *         guard, pause or role state.
 */
contract LenderIntentViewFacet {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.UintSet;

    /// @notice #2550 — the priority-routing state of `owner`'s intent for the pair,
    ///         and what a fill by `solver` (initiated by `initiator`) would do with
    ///         it right now: whether the solver's capacity covers the fill, and
    ///         whether a capacity refusal would instead be lifted by one of the
    ///         owner's credits. A BLOCK-STATE SNAPSHOT: capacity accrues, other fills
    ///         spend it, and the owner may spend a credit or change the opt-in before
    ///         a fill is mined; the mined `IntentPriorityFill` event is the
    ///         authoritative record that a credit was spent.
    /// @return enabled         The intent is opted in.
    /// @return credits         The owner's unspent priority credits.
    /// @return capacityCovers  The solver's capacity covers the fill (or the limiter is dark).
    /// @return creditUnlocks   The fill would be refused for capacity but goes through on a credit.
    function getLenderIntentPriority(
        address owner,
        address lendingAsset,
        address collateralAsset,
        uint8 slot,
        address solver,
        address initiator
    ) external view returns (bool enabled, uint256 credits, bool capacityCovers, bool creditUnlocks) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        enabled = s.lenderIntentPriority[owner][lendingAsset][collateralAsset][slot];
        credits = s.perkCredits[owner][LibPriorityRouting.PERK_ID];
        capacityCovers = LibServiceCapacity.fillCovered(s, solver, initiator);
        creditUnlocks = !capacityCovers && LibPriorityRouting.covers(s, owner, lendingAsset, collateralAsset, slot);
    }

    /// @notice Read a standing intent. `active == false` ⇒ none / cancelled.
    function getLenderIntent(
        address owner,
        address lendingAsset,
        address collateralAsset,
        uint8 slot
    ) external view returns (LibVaipakam.LenderIntent memory) {
        return LibVaipakam.storageSlot().lenderIntent[owner][lendingAsset][
            collateralAsset
        ][slot];
    }

    /// @notice Aggregate LIVE principal currently out from `owner`'s intent on
    ///         the `(lendingAsset, collateralAsset)` pair — the figure
    ///         `matchIntent` checks against `maxExposure` (#393 v1-b). Keyed by
    ///         the full intent. Since #3714 it is exactly the outstanding
    ///         principal of the open loans the intent holds: it falls as
    ///         principal is repaid and drops to nothing when a loan closes,
    ///         not at the lender's claim.
    function getLenderIntentLivePrincipal(
        address owner,
        address lendingAsset,
        address collateralAsset,
        uint8 slot
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().lenderIntentLivePrincipal[owner][
            lendingAsset
        ][collateralAsset][slot];
    }

    /// @notice #393 v1-d — the un-lent, liened working capital `owner` has
    ///         funded for the intent on `(lendingAsset, collateralAsset)`: the
    ///         pool `matchIntent` draws fill slices from, and the amount
    ///         `withdrawLenderIntentCapital` can return to the wallet. Excludes
    ///         capital already lent out (tracked by `lenderIntentLivePrincipal`)
    ///         and repaid proceeds (which return as a Position-NFT claim).
    function getLenderIntentCapital(
        address owner,
        address lendingAsset,
        address collateralAsset,
        uint8 slot
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().lenderIntentCapital[owner][
            lendingAsset
        ][collateralAsset][slot];
    }

    /// @notice #625 WI-2a — paginated ACTIVE lender intents (on this facet since #3618, moved
    ///         off MetricsFacet, which had reached the EIP-170 ceiling): the discovery source the
    ///         keeper's intent-fill pass pages each tick instead of indexing
    ///         `LenderIntentSet`/`Cancelled` events. Pages the `activeIntentKeys`
    ///         enumerable set (cancelled intents drop out), resolving each to a lean
    ///         {LibMetricsTypes.LenderIntentSummary} — the bounds + `requiresKeeperAuth`
    ///         (so the keeper skips an intent it isn't delegated to fill) + the two sizing
    ///         figures: `livePrincipal` (exposure already out) and `availableCapital` (the
    ///         un-lent, liened pool a fill draws from; a fill exceeding it reverts
    ///         `IntentCapitalInsufficient`).
    /// @dev    The set is swap-pop unstable across cancellations, so page over a single
    ///         block's snapshot. O(limit) reads.
    /// @return intents Page of active-intent summaries, leaving out any whose
    ///                 lend-until time can no longer take a one-day loan (#3618),
    ///                 so a page may hold fewer than `limit` rows mid-list.
    /// @return total   Count of active intents at this block (the registry,
    ///                 including any left out above); page by this, not by rows.
    function getActiveLenderIntents(uint256 offset, uint256 limit)
        external
        view
        returns (
            LibMetricsTypes.LenderIntentSummary[] memory intents,
            uint256 total
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        total = s.activeIntentKeys.length();
        if (offset >= total) {
            return (new LibMetricsTypes.LenderIntentSummary[](0), total);
        }
        uint256 endExcl = offset + limit;
        if (endExcl > total) endExcl = total;
        uint256 size = endExcl - offset;
        // #3618 — skip an intent whose lend-until time leaves no room for a
        // new loan: every fill would refuse `LenderIntentPastLendUntil`, so
        // listing it only sends keepers to price fills that cannot land. Its
        // capital stays withdrawable and its live loans settle as before.
        // Over-allocate to the page, then truncate to the listed count
        // (`total` still counts the whole registry, so pagination is unchanged).
        LibMetricsTypes.LenderIntentSummary[] memory buf =
            new LibMetricsTypes.LenderIntentSummary[](size);
        uint256 n = 0;
        for (uint256 i = 0; i < size; i++) {
            LibVaipakam.IntentKey memory key =
                s.intentKeyTuple[s.activeIntentKeys.at(offset + i)];
            LibVaipakam.LenderIntent storage intent =
                s.lenderIntent[key.owner][key.lendingAsset][key.collateralAsset][key.slot];
            if (!LibIntentTerms.windowOpen(intent)) continue;
            buf[n++] = LibMetricsTypes.toLenderIntentSummary(
                key,
                intent,
                s.lenderIntentLivePrincipal[key.owner][key.lendingAsset][
                    key.collateralAsset
                ][key.slot],
                s.lenderIntentCapital[key.owner][key.lendingAsset][
                    key.collateralAsset
                ][key.slot]
            );
        }
        intents = new LibMetricsTypes.LenderIntentSummary[](n);
        for (uint256 i = 0; i < n; i++) {
            intents[i] = buf[i];
        }
    }

    /// @notice #625 WI-2c — paginated view (on this facet since #3618) of the
    ///         intent-originated loans a keeper can act on for the owner:
    ///         fully-repaid loans to AUTO-ROLL (`rollIntentLoan`, `open = false`)
    ///         and, since #3629, open loans with payments held for the lender
    ///         position to re-commit (`recommitHeldToIntent`, `open = true`).
    ///         Pages the `activeIntentLoans` registry (every live intent loan)
    ///         and keeps only rows whose intent can still take capital (active,
    ///         and inside its lend-until time, #3618), keyed off each loan's
    ///         `intentOrigin` (so a sold lender position is still surfaced; the
    ///         step then rejects it, and the keeper keys AUTO_ROLL auth off
    ///         `owner`).
    /// @param  offset / limit  Window over the registry. `total` is the FULL
    ///         registry size; the keeper pages until `offset >= total`,
    ///         accumulating the rows each page yields.
    /// @return loans  The candidates within `[offset, offset+limit)`.
    /// @return total  The registry size, for pagination.
    function getRollableIntentLoans(uint256 offset, uint256 limit)
        external
        view
        returns (
            LibMetricsTypes.RollableIntentLoan[] memory loans,
            uint256 total
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        total = s.activeIntentLoans.length();
        if (offset >= total) {
            return (new LibMetricsTypes.RollableIntentLoan[](0), total);
        }
        uint256 endExcl = offset + limit;
        if (endExcl > total) endExcl = total;
        uint256 window = endExcl - offset;
        // Filter to Repaid (the roll candidates); over-allocate to the window,
        // then truncate to the matched count.
        LibMetricsTypes.RollableIntentLoan[] memory buf =
            new LibMetricsTypes.RollableIntentLoan[](window);
        uint256 n = 0;
        for (uint256 i = 0; i < window; i++) {
            uint256 loanId = s.activeIntentLoans.at(offset + i);
            LibVaipakam.LoanStatus st = s.loans[loanId].status;
            uint256 held = s.heldForLender[loanId];
            bool open = st == LibVaipakam.LoanStatus.Active;
            if (open ? held == 0 : st != LibVaipakam.LoanStatus.Repaid) continue;
            LibVaipakam.IntentOrigin memory io = s.intentOrigin[loanId];
            // #3618 — skip a loan whose intent can no longer take the roll
            // (cancelled, or its lend-until time leaves no room for another
            // loan): `rollIntentLoan` would refuse it, and it settles through
            // the normal claim.
            LibVaipakam.LenderIntent storage intent =
                s.lenderIntent[io.owner][io.lendingAsset][io.collateralAsset][io.slot];
            if (!intent.active || !LibIntentTerms.windowOpen(intent)) continue;
            buf[n] = LibMetricsTypes.toRollableIntentLoan(loanId, io, open, held);
            n++;
        }
        loans = new LibMetricsTypes.RollableIntentLoan[](n);
        for (uint256 i = 0; i < n; i++) {
            loans[i] = buf[i];
        }
    }

    /// @notice #755 — paginated view of ALL standing intents a single lender
    ///         owns across pairs, so the dapp can list and manage them in one
    ///         place. Unlike the owner-agnostic, funded-active-only
    ///         `getActiveLenderIntents` global keeper feed, this
    ///         pages the per-owner registry and ALSO returns PAUSED intents
    ///         (cancelled but still carrying reserved capital) — the `active`
    ///         flag on each `OwnerLenderIntentSummary` row distinguishes active
    ///         from paused, and `availableCapital` / `livePrincipal` show what's
    ///         reserved and what's out on loan. An intent leaves the registry
    ///         only once fully torn down (inactive AND zero reserved capital).
    /// @dev    Returns a per-owner wrapper type ({OwnerLenderIntentSummary}),
    ///         NOT the shared {LenderIntentSummary} the global feed returns, so
    ///         adding the `active` flag here can't perturb that feed's ABI.
    /// @dev    Migration note (Codex #756 P2): `ownerIntentKeys` is populated
    ///         FORWARD-only, at the same `syncIntentRegistry` sites as the
    ///         global `activeIntentKeys` feed — both registries share that
    ///         property. On a from-scratch deployment (every deployment to date)
    ///         that is complete: every intent is registered through a synced
    ///         path. Only an in-place diamond upgrade performed OVER pre-existing
    ///         intent state would start this set empty; the one-time migration is
    ///         a re-sync of the known keys (identical to what the global feed
    ///         would need), not a per-view backfill — so the two registries stay
    ///         consistent and the platform's pre-live status means there is no
    ///         such live state to migrate today.
    /// @param  owner   The lender whose standing intents to list.
    /// @param  offset  Start index into the owner's intent set.
    /// @param  limit   Maximum rows to return from `offset`.
    /// @return intents The owner's intents within `[offset, offset+limit)`.
    /// @return total   The owner's total intent count, for pagination.
    function getLenderIntentsByOwner(
        address owner,
        uint256 offset,
        uint256 limit
    )
        external
        view
        returns (
            LibMetricsTypes.OwnerLenderIntentSummary[] memory intents,
            uint256 total
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        EnumerableSet.Bytes32Set storage keys = s.ownerIntentKeys[owner];
        total = keys.length();
        if (offset >= total) {
            return (new LibMetricsTypes.OwnerLenderIntentSummary[](0), total);
        }
        uint256 endExcl = offset + limit;
        if (endExcl > total) endExcl = total;
        uint256 size = endExcl - offset;
        intents = new LibMetricsTypes.OwnerLenderIntentSummary[](size);
        for (uint256 i = 0; i < size; i++) {
            LibVaipakam.IntentKey memory key =
                s.intentKeyTuple[keys.at(offset + i)];
            intents[i] = LibMetricsTypes.toOwnerLenderIntentSummary(
                key,
                s.lenderIntent[key.owner][key.lendingAsset][key.collateralAsset][key.slot],
                s.lenderIntentLivePrincipal[key.owner][key.lendingAsset][
                    key.collateralAsset
                ][key.slot],
                s.lenderIntentCapital[key.owner][key.lendingAsset][
                    key.collateralAsset
                ][key.slot]
            );
        }
    }
}
