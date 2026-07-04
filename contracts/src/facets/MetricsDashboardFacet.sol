// src/facets/MetricsDashboardFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibMetricsTypes} from "../libraries/LibMetricsTypes.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {RiskFacet} from "./RiskFacet.sol";
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
    /// @param vaultVpfiBalance         User's vault VPFI (stake +
    ///        rebate held + fees-not-yet-spent). Drives the discount
    ///        tier indicator.
    /// @param vpfiTier                  Discount tier (0–4) derived
    ///        from `vaultVpfiBalance` against the configured tier
    ///        thresholds.
    /// @param interactionRewardsPending Cross-chain finalized VPFI
    ///        claimable from {InteractionRewardsFacet}.
    /// @param vpfiDiscountConsented     `s.vpfiDiscountConsent[user]`
    ///        — whether vaulted VPFI may be spent on protocol-fee
    ///        discounts.
    /// @param lenderLoanCount           Active loans where user is lender.
    /// @param borrowerLoanCount         Active loans where user is borrower.
    /// @param activeOfferCount          Open (un-accepted) offers user created.
    /// @param filledOfferCount          Accepted offers user created
    ///        (used to drive the "Filled" tab pager).
    /// @param lenderClaimableCount      Pending lender claims for user.
    /// @param borrowerClaimableCount    Pending borrower claims for user.
    struct DashboardScalars {
        uint256 vaultVpfiBalance;
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
    /// @param loan          Lean flat {LibMetricsTypes.LoanSummary}
    ///        projection (omits rental/periodic/snapshot fields to keep
    ///        the viaIR array-coder shallow — consumers needing those
    ///        call the single-struct getLoanDetails view).
    /// @param ltvBps        Current LTV in basis points; 0 if illiquid.
    /// @param healthFactor  Current HF (1e18 scale); 0 if illiquid.
    struct LoanWithRisk {
        LibMetricsTypes.LoanSummary loan;
        uint256 ltvBps;
        uint256 healthFactor;
    }

    /// @notice {LoanWithRisk} extended with a side tag for the
    ///         unified-table dashboard surface — the page renders
    ///         lender + borrower loans together with a role chip,
    ///         so the per-row tag lets it filter / colour without
    ///         a separate per-side fetch.
    /// @param loan          Lean flat {LibMetricsTypes.LoanSummary}
    ///        projection (see {LoanWithRisk}).
    /// @param ltvBps        Current LTV in basis points; 0 if illiquid.
    /// @param healthFactor  Current HF (1e18 scale); 0 if illiquid.
    /// @param borrowerSide  `true` when the queried user is the
    ///        borrower of this loan; `false` when they're the lender.
    struct LoanWithRiskAndSide {
        LibMetricsTypes.LoanSummary loan;
        uint256 ltvBps;
        uint256 healthFactor;
        bool borrowerSide;
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

        // Reward + vault scalars — pulled via cross-facet view so
        // each subsystem stays the source of truth for its own
        // calculations.
        try InteractionRewardsFacet(address(this)).previewInteractionRewards(user) returns (
            uint256 pending,
            uint256 /* finalizedThroughDay */,
            uint256 /* userStartDay */
        ) {
            snap.interactionRewardsPending = pending;
        } catch {}

        snap.vaultVpfiBalance = LibVPFIDiscount.vaultVpfiBalance(user);
        snap.vpfiTier = _tierFor(snap.vaultVpfiBalance);
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
        // Walk the user's lifetime loan index — O(user's loan count)
        // — instead of the protocol-wide `activeLoanIdsList`. At
        // scale (10k+ active loans, user has <10) this is the
        // 1000× win the existing per-key index was built for.
        uint256[] storage userLoans = s.userLoanIds[user];
        uint256 total = userLoans.length;

        LoanWithRisk[] memory buf = new LoanWithRisk[](limit);
        uint256 skipped;
        uint256 written;

        for (uint256 i = 0; i < total && written < limit; i++) {
            LibVaipakam.Loan storage l = s.loans[userLoans[i]];
            // Filter to ACTIVE-status loans on the requested side.
            // The per-user index includes lifetime loans (every
            // status); the dashboard's "Your Loans" panel is the
            // active subset.
            if (l.status != LibVaipakam.LoanStatus.Active) continue;
            bool sideMatch = borrowerSide ? (l.borrower == user) : (l.lender == user);
            if (!sideMatch) continue;
            if (skipped < offset) {
                skipped += 1;
                continue;
            }
            buf[written].loan = LibMetricsTypes.toLoanSummary(l);
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
        }

        // Trim to actual count.
        loans = new LoanWithRisk[](written);
        for (uint256 j = 0; j < written; j++) {
            loans[j] = buf[j];
        }
    }

    /**
     * @notice Paginated view of every active loan the user
     *         participates in — lender side AND borrower side
     *         merged into one stream, with each row tagged
     *         `borrowerSide` so the frontend's unified table can
     *         render + filter without a per-side fetch.
     * @dev    Architectural cleanliness over raw RPC count: the
     *         Dashboard page renders a single role-chip-filterable
     *         table of every loan the wallet touches, so a per-
     *         side {getUserDashboardLoans} forces two parallel
     *         fetches + client-side merge that defeats the
     *         contract-side pagination. This function preserves
     *         the unified UX in one call.
     *
     *         When the user is BOTH lender and borrower on the same
     *         loan (only possible via a borrower-buys-back-from-self
     *         exit path, currently unreachable), the row is emitted
     *         with `borrowerSide = true` (borrower side wins —
     *         matches the role the user is liable for).
     * @param  user    The user to query.
     * @param  offset  Skip this many matching loans.
     * @param  limit   Max page size (≤ {MAX_PAGE_LIMIT}).
     * @return rows    Page of matching {LoanWithRiskAndSide}
     *                 records, each carrying the loan struct, live
     *                 LTV / HF, and the side tag.
     */
    function getUserDashboardLoansBothSides(
        address user,
        uint32 offset,
        uint32 limit
    ) external view returns (LoanWithRiskAndSide[] memory rows) {
        if (limit > MAX_PAGE_LIMIT) revert LimitTooLarge(limit, MAX_PAGE_LIMIT);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Walk the user's lifetime loan index — same optimization
        // as {getUserDashboardLoans}. The user's `userLoanIds`
        // includes every loan they're a party to regardless of
        // side, so one walk covers both lender + borrower.
        uint256[] storage userLoans = s.userLoanIds[user];
        uint256 total = userLoans.length;

        LoanWithRiskAndSide[] memory buf = new LoanWithRiskAndSide[](limit);
        uint256 skipped;
        uint256 written;

        for (uint256 i = 0; i < total && written < limit; i++) {
            LibVaipakam.Loan storage l = s.loans[userLoans[i]];
            // Filter to ACTIVE only — `userLoanIds` covers lifetime.
            if (l.status != LibVaipakam.LoanStatus.Active) continue;
            bool isBorrower = l.borrower == user;
            bool isLender = l.lender == user;
            if (!isBorrower && !isLender) continue;
            if (skipped < offset) {
                skipped += 1;
                continue;
            }
            buf[written].loan = LibMetricsTypes.toLoanSummary(l);
            buf[written].borrowerSide = isBorrower;
            // Best-effort risk read; silent-degrade-to-0 mirrors
            // {getUserDashboardLoans}.
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
        }

        rows = new LoanWithRiskAndSide[](written);
        for (uint256 j = 0; j < written; j++) {
            rows[j] = buf[j];
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
     * @return offers     Page of matching {LibMetricsTypes.OfferSummary}
     *                    records (lean flat projection — see
     *                    {MetricsFacet.getUserAllOffersWithDetails}).
     */
    function getUserDashboardOffers(
        address user,
        bool filledOnly,
        uint32 offset,
        uint32 limit
    ) external view returns (LibMetricsTypes.OfferSummary[] memory offers) {
        if (limit > MAX_PAGE_LIMIT) revert LimitTooLarge(limit, MAX_PAGE_LIMIT);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Walk the user's lifetime offer index. The `accepted`
        // boolean partitions the same set into open vs filled —
        // one pass covers both the chip-filter cases without
        // touching the protocol-wide active list or the lifetime
        // offer space. O(user's offer count).
        uint256[] storage userOffers = s.userOfferIds[user];
        uint256 total = userOffers.length;
        LibMetricsTypes.OfferSummary[] memory buf = new LibMetricsTypes.OfferSummary[](limit);
        uint256 written;
        uint256 skipped;
        for (uint256 i = 0; i < total && written < limit; i++) {
            uint256 offerId = userOffers[i];
            LibVaipakam.Offer storage o = s.offers[offerId];
            // Codex round-3 P2 #5 — exclude offers that landed in the
            // §19.7e ConsumedBySale terminal. They're not "open" (the
            // collateral is gone in a Seaport sale) and not "filled"
            // by an accept (no loan exists), so they don't belong in
            // either bucket the dashboard surfaces. The §19.7e read
            // path uses `MetricsFacet.getUserOffersByStatePaginated`
            // with `OfferState.ConsumedBySale` to render the
            // "Sold via OpenSea" history row.
            if (s.offerConsumedBySale[offerId]) continue;
            if (o.accepted != filledOnly) continue;
            if (skipped < offset) {
                skipped += 1;
                continue;
            }
            buf[written] = LibMetricsTypes.toOfferSummary(o);
            written += 1;
        }
        offers = new LibMetricsTypes.OfferSummary[](written);
        for (uint256 j = 0; j < written; j++) offers[j] = buf[j];
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
        // Walk the user's lifetime loan index. O(user's loan count)
        // instead of O(every loan ever); same optimization
        // pattern as the loans + offers paths above.
        uint256[] storage userLoans = s.userLoanIds[user];
        uint256 total = userLoans.length;

        uint256[] memory idBuf = new uint256[](limit);
        LibVaipakam.ClaimInfo[] memory claimBuf = new LibVaipakam.ClaimInfo[](limit);
        uint256 written;
        uint256 skipped;

        for (uint256 i = 0; i < total && written < limit; i++) {
            uint256 lid = userLoans[i];
            LibVaipakam.Loan storage l = s.loans[lid];
            bool sideMatch = borrowerSide ? (l.borrower == user) : (l.lender == user);
            if (!sideMatch) continue;
            LibVaipakam.ClaimInfo storage ci = borrowerSide
                ? s.borrowerClaims[lid]
                : s.lenderClaims[lid];
            // Skip slots with nothing pending — `claimed` flag is the
            // canonical "this side is settled" marker; absence of any
            // claimable amount AND no held funds also counts as nothing.
            LibVaipakam.ClaimInfo storage emitCi = ci;
            bool pending = !ci.claimed && ci.amount > 0;
            // #954 (§2.3) — a full swap-to-repay that consumed ALL collateral
            // freezes ONLY a principal surplus, leaving the collateral
            // `borrowerClaims` slot empty. Surface that surplus-only lane so a
            // delisted self-holder (`l.borrower == user`) still sees the funds
            // in the dashboard snapshot instead of a zero count. When the
            // collateral lane IS pending, it takes the row and the surplus stays
            // discoverable via `ClaimFacet.getBorrowerSurplusClaim`.
            if (borrowerSide && !pending) {
                LibVaipakam.ClaimInfo storage sc = s.borrowerSurplusClaims[lid];
                if (!sc.claimed && sc.amount > 0) {
                    emitCi = sc;
                    pending = true;
                }
            }
            if (!pending) continue;
            if (skipped < offset) {
                skipped += 1;
                continue;
            }
            idBuf[written] = lid;
            claimBuf[written] = emitCi;
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

    /// @dev Resolves a user's discount tier (0–4) from their vault
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
        // Walk the user's lifetime loan index, filter to active.
        // O(user's loan count) instead of O(protocol active count).
        uint256[] storage userLoans = s.userLoanIds[user];
        uint256 total = userLoans.length;
        for (uint256 i = 0; i < total; i++) {
            LibVaipakam.Loan storage l = s.loans[userLoans[i]];
            if (l.status != LibVaipakam.LoanStatus.Active) continue;
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
        // Walk the user's lifetime offer index — covers both active
        // (accepted=false) and filled (accepted=true) in one pass.
        // O(user's offer count) instead of O(protocol-wide active +
        // protocol-wide lifetime).
        uint256[] storage userOffers = s.userOfferIds[user];
        uint256 total = userOffers.length;
        for (uint256 i = 0; i < total; i++) {
            LibVaipakam.Offer storage o = s.offers[userOffers[i]];
            if (o.accepted) {
                filledCount += 1;
            } else {
                activeCount += 1;
            }
        }
    }

    function _countClaimables(address user)
        internal
        view
        returns (uint32 lenderCount, uint32 borrowerCount)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Walk the user's lifetime loan index — protocol-wide
        // `[1..nextLoanId)` was O(every loan ever); this is
        // O(user's loan count).
        uint256[] storage userLoans = s.userLoanIds[user];
        uint256 total = userLoans.length;
        for (uint256 i = 0; i < total; i++) {
            uint256 lid = userLoans[i];
            LibVaipakam.Loan storage l = s.loans[lid];
            if (l.lender == user) {
                LibVaipakam.ClaimInfo storage ci = s.lenderClaims[lid];
                if (!ci.claimed && ci.amount > 0) lenderCount += 1;
            }
            if (l.borrower == user) {
                LibVaipakam.ClaimInfo storage ci = s.borrowerClaims[lid];
                // #954 (§2.3) — count the loan once if EITHER the collateral
                // lane OR the frozen principal-surplus lane is pending, so a
                // surplus-only close (all collateral consumed) isn't undercounted.
                LibVaipakam.ClaimInfo storage sc = s.borrowerSurplusClaims[lid];
                bool colPending = !ci.claimed && ci.amount > 0;
                bool surPending = !sc.claimed && sc.amount > 0;
                if (colPending || surPending) borrowerCount += 1;
            }
        }
    }

    // _walkOffers / _walkOffersFromList helpers were removed when
    // getUserDashboardOffers switched to walking userOfferIds[user]
    // directly — single-pass over the per-user index covers both
    // open and filled chip states.
}
