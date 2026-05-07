// src/facets/MetricsDashboardFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {StakingRewardsFacet} from "./StakingRewardsFacet.sol";
import {InteractionRewardsFacet} from "./InteractionRewardsFacet.sol";

/**
 * @title MetricsDashboardFacet
 * @author Vaipakam Developer Team
 * @notice Per-user dashboard surface — bundles every read the
 *         frontend Dashboard makes on first paint into one scalar
 *         snapshot call + three paginated list calls.
 *         AnalyticalGettersDesign.md §3.1, decisions D1–D4.
 *
 *         Replaces the ~13 RPC calls (or ~18 on indexer-fallback)
 *         the legacy multi-hook approach issues with **3 reads on the
 *         happy path**: 1 scalar + 1 loans-page + 1 offers-page.
 *
 *         Below-fold tabs (filled offers, claimables history) lazy
 *         fetch on tab-click via the same paginated endpoints with
 *         a different `bool` flag.
 *
 * @dev Carved out of {MetricsFacet} to keep that contract under the
 *      EIP-170 24576-byte runtime ceiling — same precedent as
 *      `OfferMatchFacet` / `OfferCancelFacet`. Same Diamond, same
 *      storage; selectors land identically. All four entry points
 *      are pure `view`.
 *
 *      Pagination: `limit` is hard-capped at 100 server-side per D2;
 *      the frontend's default is 20. The contract enforces the cap
 *      via {LimitTooLarge} so a misbehaving caller can't OOG-itself
 *      across thousands of items.
 *
 *      Iteration: every paginated lister walks `s.activeLoanIdsList`
 *      / `s.activeOfferIdsList` (or `[1, nextLoanId)` for filled-offer
 *      / claimable history) once and accumulates the page in a fixed-
 *      size memory buffer. O(activeCount) per call — fine while the
 *      protocol is in the thousands; revisit when loanIds cross 1e5.
 */
contract MetricsDashboardFacet {
    /// @notice Pagination cap (D2). Callers requesting `limit > 100`
    ///         revert.
    uint256 public constant MAX_PAGE_LIMIT = 100;

    /// @notice Hard-cap exceeded.
    error LimitTooLarge(uint256 requested, uint256 max);

    /// @notice Always-small scalar snapshot for the dashboard's
    ///         headline cards. EventSourcingAudit-friendly: every
    ///         field is recoverable from a single `eth_call` so the
    ///         IPFS-hosted frontend doesn't depend on the indexer
    ///         layer.
    /// @param stakingRewardsPending     VPFI claimable from
    ///        {StakingRewardsFacet.previewStakingRewards}.
    /// @param escrowVpfiBalance         User's escrow VPFI (stake +
    ///        rebate held + fees-not-yet-spent). Drives the discount
    ///        tier indicator.
    /// @param vpfiTier                  Discount tier (0–4) derived
    ///        from `escrowVpfiBalance` against the configured tier
    ///        thresholds.
    /// @param interactionRewardsPending Cross-chain finalized VPFI
    ///        claimable from {InteractionRewardsFacet}.
    /// @param vpfiDiscountConsented     `s.vpfiDiscountConsent[user]`
    ///        — whether escrowed VPFI may be spent on protocol-fee
    ///        discounts.
    /// @param lenderLoanCount           Active loans where user is lender.
    /// @param borrowerLoanCount         Active loans where user is borrower.
    /// @param activeOfferCount          Open (un-accepted) offers user created.
    /// @param filledOfferCount          Accepted offers user created
    ///        (used to drive the "Filled" tab pager).
    /// @param lenderClaimableCount      Pending lender claims for user.
    /// @param borrowerClaimableCount    Pending borrower claims for user.
    struct DashboardScalars {
        uint256 stakingRewardsPending;
        uint256 escrowVpfiBalance;
        uint8 vpfiTier;
        uint256 interactionRewardsPending;
        bool vpfiDiscountConsented;
        uint32 lenderLoanCount;
        uint32 borrowerLoanCount;
        uint32 activeOfferCount;
        uint32 filledOfferCount;
        uint32 lenderClaimableCount;
        uint32 borrowerClaimableCount;
    }

    /// @notice Loan + computed risk for a paginated dashboard row.
    /// @param loan          Full {LibVaipakam.Loan} struct.
    /// @param ltvBps        Current LTV in basis points; 0 if illiquid.
    /// @param healthFactor  Current HF (1e18 scale); 0 if illiquid.
    struct LoanWithRisk {
        LibVaipakam.Loan loan;
        uint256 ltvBps;
        uint256 healthFactor;
    }

    // ─── Scalar snapshot ─────────────────────────────────────────────────

    /**
     * @notice One-call dashboard headline read. Returns the scalar
     *         snapshot the frontend renders above the fold; the
     *         paginated list calls fetch lazily once this lands.
     * @param  user The wallet address whose dashboard is being viewed.
     */
    function getUserDashboardSnapshot(address user)
        external
        view
        returns (DashboardScalars memory snap)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Reward + escrow scalars — pulled via cross-facet view so
        // each subsystem stays the source of truth for its own
        // calculations.
        try StakingRewardsFacet(address(this)).previewStakingRewards(user) returns (uint256 pending) {
            snap.stakingRewardsPending = pending;
        } catch {}
        try InteractionRewardsFacet(address(this)).previewInteractionRewards(user) returns (
            uint256 pending,
            uint256 /* finalizedThroughDay */,
            uint256 /* userStartDay */
        ) {
            snap.interactionRewardsPending = pending;
        } catch {}

        snap.escrowVpfiBalance = LibVPFIDiscount.escrowVPFIBalance(user);
        snap.vpfiTier = _tierFor(snap.escrowVpfiBalance);
        snap.vpfiDiscountConsented = s.vpfiDiscountConsent[user];

        // Per-side counts — the same lists the paginated companions
        // walk, so the count + page reads stay consistent.
        (snap.lenderLoanCount, snap.borrowerLoanCount) = _countActiveLoansBySide(user);
        (snap.activeOfferCount, snap.filledOfferCount) = _countOffersBySide(user);
        (snap.lenderClaimableCount, snap.borrowerClaimableCount) = _countClaimables(user);
    }

    // ─── Paginated companions ────────────────────────────────────────────

    /**
     * @notice Per-side paginated view of active loans for a user,
     *         each with current LTV + Health-Factor pre-computed.
     * @param  user         The user to query.
     * @param  borrowerSide `true` → loans where user is borrower;
     *                      `false` → loans where user is lender.
     * @param  offset       Skip this many matching loans before
     *                      starting the page.
     * @param  limit        Max page size (≤ {MAX_PAGE_LIMIT}).
     * @return loans        Up to `limit` matching {LoanWithRisk}
     *                      records.
     */
    function getUserDashboardLoans(
        address user,
        bool borrowerSide,
        uint32 offset,
        uint32 limit
    ) external view returns (LoanWithRisk[] memory loans) {
        if (limit > MAX_PAGE_LIMIT) revert LimitTooLarge(limit, MAX_PAGE_LIMIT);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage active = s.activeLoanIdsList;
        uint256 total = active.length;

        LoanWithRisk[] memory buf = new LoanWithRisk[](limit);
        uint256 matched;
        uint256 skipped;
        uint256 written;

        for (uint256 i = 0; i < total && written < limit; i++) {
            LibVaipakam.Loan storage l = s.loans[active[i]];
            bool sideMatch = borrowerSide ? (l.borrower == user) : (l.lender == user);
            if (!sideMatch) continue;
            if (skipped < offset) {
                skipped += 1;
                continue;
            }
            buf[written].loan = l;
            // Best-effort risk read; reverts cleanly to 0 for illiquid
            // (no oracle feed). Mirrors AddCollateralFacet pattern.
            (bool okLtv, bytes memory retLtv) = address(this).staticcall(
                abi.encodeWithSelector(RiskFacet.calculateLTV.selector, l.id)
            );
            if (okLtv && retLtv.length > 0) {
                buf[written].ltvBps = abi.decode(retLtv, (uint256));
            }
            (bool okHf, bytes memory retHf) = address(this).staticcall(
                abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, l.id)
            );
            if (okHf && retHf.length > 0) {
                buf[written].healthFactor = abi.decode(retHf, (uint256));
            }
            written += 1;
            matched += 1;
        }

        // Trim to actual count.
        loans = new LoanWithRisk[](written);
        for (uint256 j = 0; j < written; j++) {
            loans[j] = buf[j];
        }
    }

    /**
     * @notice Paginated user-created offers — open (un-accepted) or
     *         filled (accepted) split by `filledOnly` flag (D4).
     * @param  user       The offer creator to query.
     * @param  filledOnly `true` → only accepted offers; `false` →
     *                    only currently open offers.
     * @param  offset     Skip this many matching offers.
     * @param  limit      Max page size (≤ {MAX_PAGE_LIMIT}).
     * @return offers     Page of matching {LibVaipakam.Offer} records.
     */
    function getUserDashboardOffers(
        address user,
        bool filledOnly,
        uint32 offset,
        uint32 limit
    ) external view returns (LibVaipakam.Offer[] memory offers) {
        if (limit > MAX_PAGE_LIMIT) revert LimitTooLarge(limit, MAX_PAGE_LIMIT);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        if (filledOnly) {
            // Filled set: walk the lifetime offer space, filter creator
            // + accepted=true. Bounded by `nextOfferId` rather than the
            // active list — historically-accepted offers are not in the
            // live `activeOfferIdsList`.
            uint256 total = s.nextOfferId;
            offers = _walkOffers(user, /* filledOnly */ true, total, offset, limit, true);
        } else {
            uint256[] storage active = s.activeOfferIdsList;
            uint256 total = active.length;
            offers = _walkOffersFromList(user, active, total, offset, limit);
        }
    }

    /**
     * @notice Paginated claimables for a user (lender or borrower
     *         side per D3). Includes lender post-resolution proceeds,
     *         borrower collateral refunds, NFT rental returns, and
     *         Phase-5 borrower LIF rebates.
     * @param  user         The user to query.
     * @param  borrowerSide `true` → borrower-side claims;
     *                      `false` → lender-side claims.
     * @param  offset       Skip this many matching claims.
     * @param  limit        Max page size (≤ {MAX_PAGE_LIMIT}).
     * @return loanIds      Loan IDs the claims attach to.
     * @return claims       Aligned page of {LibVaipakam.ClaimInfo}.
     */
    function getUserDashboardClaimables(
        address user,
        bool borrowerSide,
        uint32 offset,
        uint32 limit
    )
        external
        view
        returns (uint256[] memory loanIds, LibVaipakam.ClaimInfo[] memory claims)
    {
        if (limit > MAX_PAGE_LIMIT) revert LimitTooLarge(limit, MAX_PAGE_LIMIT);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        uint256[] memory idBuf = new uint256[](limit);
        LibVaipakam.ClaimInfo[] memory claimBuf = new LibVaipakam.ClaimInfo[](limit);
        uint256 written;
        uint256 skipped;
        uint256 total = s.nextLoanId;

        for (uint256 lid = 1; lid < total && written < limit; lid++) {
            LibVaipakam.Loan storage l = s.loans[lid];
            bool sideMatch = borrowerSide ? (l.borrower == user) : (l.lender == user);
            if (!sideMatch) continue;
            LibVaipakam.ClaimInfo storage ci = borrowerSide
                ? s.borrowerClaims[lid]
                : s.lenderClaims[lid];
            // Skip slots with nothing pending — `claimed` flag is the
            // canonical "this side is settled" marker; absence of any
            // claimable amount AND no held funds also counts as nothing.
            if (ci.claimed || ci.amount == 0) continue;
            if (skipped < offset) {
                skipped += 1;
                continue;
            }
            idBuf[written] = lid;
            claimBuf[written] = ci;
            written += 1;
        }

        loanIds = new uint256[](written);
        claims = new LibVaipakam.ClaimInfo[](written);
        for (uint256 j = 0; j < written; j++) {
            loanIds[j] = idBuf[j];
            claims[j] = claimBuf[j];
        }
    }

    // ─── Internal helpers ────────────────────────────────────────────────

    /// @dev Resolves a user's discount tier (0–4) from their escrow
    ///      VPFI balance. Mirrors the inline check in
    ///      `LibVPFIDiscount` — kept local rather than a library
    ///      helper to keep the read path on this facet self-contained.
    function _tierFor(uint256 balance) internal view returns (uint8) {
        (uint256 t1, uint256 t2, uint256 t3, uint256 t4Excl) =
            LibVaipakam.cfgVpfiTierThresholds();
        if (balance < t1) return 0;
        if (balance < t2) return 1;
        if (balance < t3) return 2;
        if (balance < t4Excl) return 3;
        return 4;
    }

    function _countActiveLoansBySide(address user)
        internal
        view
        returns (uint32 lenderCount, uint32 borrowerCount)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage active = s.activeLoanIdsList;
        uint256 total = active.length;
        for (uint256 i = 0; i < total; i++) {
            LibVaipakam.Loan storage l = s.loans[active[i]];
            if (l.lender == user) lenderCount += 1;
            if (l.borrower == user) borrowerCount += 1;
        }
    }

    function _countOffersBySide(address user)
        internal
        view
        returns (uint32 activeCount, uint32 filledCount)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage active = s.activeOfferIdsList;
        uint256 total = active.length;
        for (uint256 i = 0; i < total; i++) {
            if (s.offers[active[i]].creator == user) activeCount += 1;
        }
        // Filled set: walk the lifetime offer-id space once.
        uint256 lifetime = s.nextOfferId;
        for (uint256 oid = 1; oid < lifetime; oid++) {
            LibVaipakam.Offer storage o = s.offers[oid];
            if (o.creator == user && o.accepted) filledCount += 1;
        }
    }

    function _countClaimables(address user)
        internal
        view
        returns (uint32 lenderCount, uint32 borrowerCount)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 total = s.nextLoanId;
        for (uint256 lid = 1; lid < total; lid++) {
            LibVaipakam.Loan storage l = s.loans[lid];
            if (l.lender == user) {
                LibVaipakam.ClaimInfo storage ci = s.lenderClaims[lid];
                if (!ci.claimed && ci.amount > 0) lenderCount += 1;
            }
            if (l.borrower == user) {
                LibVaipakam.ClaimInfo storage ci = s.borrowerClaims[lid];
                if (!ci.claimed && ci.amount > 0) borrowerCount += 1;
            }
        }
    }

    /// @dev Walk an active-offer-list (creator-filter) page without
    ///      the `filledOnly` flag; offers in `activeOfferIdsList` are
    ///      by-definition open (cancelled / accepted ones get
    ///      swap-popped out by `LibMetricsHooks.onOfferAccepted` and
    ///      `onOfferCancelled`).
    function _walkOffersFromList(
        address user,
        uint256[] storage list,
        uint256 total,
        uint32 offset,
        uint32 limit
    ) internal view returns (LibVaipakam.Offer[] memory offers) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer[] memory buf = new LibVaipakam.Offer[](limit);
        uint256 written;
        uint256 skipped;
        for (uint256 i = 0; i < total && written < limit; i++) {
            LibVaipakam.Offer storage o = s.offers[list[i]];
            if (o.creator != user) continue;
            if (skipped < offset) {
                skipped += 1;
                continue;
            }
            buf[written] = o;
            written += 1;
        }
        offers = new LibVaipakam.Offer[](written);
        for (uint256 j = 0; j < written; j++) offers[j] = buf[j];
    }

    /// @dev Walk the lifetime offer-id space, filtering by creator +
    ///      `accepted` flag. Used for the filled-only branch where
    ///      the active list has already swap-popped accepted offers.
    function _walkOffers(
        address user,
        bool wantAccepted,
        uint256 lifetime,
        uint32 offset,
        uint32 limit,
        bool /* placeholder */
    ) internal view returns (LibVaipakam.Offer[] memory offers) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer[] memory buf = new LibVaipakam.Offer[](limit);
        uint256 written;
        uint256 skipped;
        for (uint256 oid = 1; oid < lifetime && written < limit; oid++) {
            LibVaipakam.Offer storage o = s.offers[oid];
            if (o.creator != user) continue;
            if (o.accepted != wantAccepted) continue;
            if (skipped < offset) {
                skipped += 1;
                continue;
            }
            buf[written] = o;
            written += 1;
        }
        offers = new LibVaipakam.Offer[](written);
        for (uint256 j = 0; j < written; j++) offers[j] = buf[j];
    }
}
