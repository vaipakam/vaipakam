// src/facets/MetricsDashboardFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibMetricsTypes} from "../libraries/LibMetricsTypes.sol";
import {LibScanPage} from "../libraries/LibScanPage.sol";
import {LibCloseoutFreeze} from "../libraries/LibCloseoutFreeze.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {RiskFacet} from "./RiskFacet.sol";
// #1306 follow-up — previewInteractionRewards moved to the read-only lens.
import {InteractionRewardsLensFacet} from "./InteractionRewardsLensFacet.sol";

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
 *      Iteration: every paginated lister walks the user's own loan or
 *      offer index, and (#2930) reads at most `maxScan` rows of it per
 *      call from a caller-held cursor ({LibScanPage}), so a call's cost
 *      is bounded by the rows it reads, not by the user's history. The
 *      snapshot counts still walk the whole index (O(user's history)).
 */
contract MetricsDashboardFacet {
    /// @notice Pagination cap (D2). Callers asking a paginated lister to
    ///         read more than 100 rows (`maxScan > 100`) revert.
    uint256 public constant MAX_PAGE_LIMIT = 100;

    /// @notice Hard-cap exceeded.
    error LimitTooLarge(uint256 requested, uint256 max);

    /// @notice #1025 — max id-array length for the bulk batch-by-id views
    ///         {getOffersWithState} / {getLoansBatch}. Sized with headroom over
    ///         the frontend's `PAGE = 200` chunk so a correctly-configured
    ///         client never trips it; the cap only bounds worst-case response
    ///         size against a hand-rolled oversized call. A `view` over
    ///         `eth_call` can't OOG the chain, but an unbounded 30-field-per-id
    ///         array can still blow the RPC's response-size / time budget and
    ///         fail the whole refresh — the very large-inventory failure mode
    ///         these views exist to fix (#1025 design §5.2).
    uint256 public constant MAX_BATCH_IDS = 250;

    /// @notice #1025 — batch id array exceeded {MAX_BATCH_IDS}. A NAMED revert
    ///         (not a generic OOG / zero-data) so the frontend's revert-probe
    ///         can tell a cap violation apart from a missing-selector old-deploy
    ///         and surface the config bug instead of silently falling back to
    ///         per-id hydration (design §5.4).
    error BatchTooLarge(uint256 got, uint256 max);

    /// @notice Always-small scalar snapshot for the dashboard's
    ///         headline cards. EventSourcingAudit-friendly: every
    ///         field is recoverable from a single `eth_call` so the
    ///         IPFS-hosted frontend doesn't depend on the indexer
    ///         layer.
    /// @param vaultVpfiBalance         User's vault VPFI (stake +
    ///        fees-not-yet-spent). Drives the discount
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
        try InteractionRewardsLensFacet(address(this)).previewInteractionRewards(user) returns (
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
     * @dev    #2930 — bounded by rows READ ({LibScanPage}): reads at most
     *         `maxScan` rows of the user's loan index from `cursor`. The
     *         cursor is a position in that index, not a count of matches; a
     *         page may be empty with the scan unfinished, and the end is
     *         `nextCursor` reaching the index's length.
     * @param  borrowerSide `true` → loans where user is borrower;
     *                      `false` → loans where user is lender.
     * @param  cursor       Position in the user's loan index to start from.
     * @param  maxScan      Most index rows this call reads
     *                      (≤ {MAX_PAGE_LIMIT}).
     * @return loans        The matching {LoanWithRisk} records among the
     *                      rows read.
     * @return nextCursor   Position to resume from; the index's length once
     *                      the scan has reached the end.
     */
    function getUserDashboardLoans(
        address user,
        bool borrowerSide,
        uint256 cursor,
        uint32 maxScan
    ) external view returns (LoanWithRisk[] memory loans, uint256 nextCursor) {
        if (maxScan > MAX_PAGE_LIMIT) revert LimitTooLarge(maxScan, MAX_PAGE_LIMIT);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Walk the user's lifetime loan index — O(user's loan count)
        // — instead of the protocol-wide `activeLoanIdsList`. At
        // scale (10k+ active loans, user has <10) this is the
        // 1000× win the existing per-key index was built for.
        uint256[] storage userLoans = s.userLoanIds[user];
        (uint256 i, uint256 end) = LibScanPage.window(userLoans.length, cursor, maxScan);

        LoanWithRisk[] memory buf = new LoanWithRisk[](end - i);
        uint256 written;

        for (; i < end; ++i) {
            LibVaipakam.Loan storage l = s.loans[userLoans[i]];
            // Filter to ACTIVE-status loans on the requested side.
            // The per-user index includes lifetime loans (every
            // status); the dashboard's "Your Loans" panel is the
            // active subset.
            // #940 — the active dashboard set is Active OR FallbackPending (a
            // FallbackPending loan is still borrower-curable until the lender
            // claims). Share the protocol-wide predicate instead of a bare
            // `!= Active`, which silently dropped FallbackPending loans and could
            // let a borrower miss the cure window.
            if (!LibMetricsHooks._isActive(l.status)) continue;
            bool sideMatch = borrowerSide ? (l.borrower == user) : (l.lender == user);
            if (!sideMatch) continue;
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
        nextCursor = end;
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
     *
     *         #2930 — bounded by rows READ, with the cursor rule of
     *         {getUserDashboardLoans}.
     * @param  user       The user to query.
     * @param  cursor     Position in the user's loan index to start from.
     * @param  maxScan    Most index rows this call reads
     *                    (≤ {MAX_PAGE_LIMIT}).
     * @return rows       The matching {LoanWithRiskAndSide} records among
     *                    the rows read, each carrying the loan struct, live
     *                    LTV / HF, and the side tag.
     * @return nextCursor Position to resume from; the index's length once
     *                    the scan has reached the end.
     */
    function getUserDashboardLoansBothSides(
        address user,
        uint256 cursor,
        uint32 maxScan
    ) external view returns (LoanWithRiskAndSide[] memory rows, uint256 nextCursor) {
        if (maxScan > MAX_PAGE_LIMIT) revert LimitTooLarge(maxScan, MAX_PAGE_LIMIT);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Walk the user's lifetime loan index — same optimization
        // as {getUserDashboardLoans}. The user's `userLoanIds`
        // includes every loan they're a party to regardless of
        // side, so one walk covers both lender + borrower.
        uint256[] storage userLoans = s.userLoanIds[user];
        (uint256 i, uint256 end) = LibScanPage.window(userLoans.length, cursor, maxScan);

        LoanWithRiskAndSide[] memory buf = new LoanWithRiskAndSide[](end - i);
        uint256 written;

        for (; i < end; ++i) {
            LibVaipakam.Loan storage l = s.loans[userLoans[i]];
            // Filter to ACTIVE only — `userLoanIds` covers lifetime.
            // #940 — the active dashboard set is Active OR FallbackPending (a
            // FallbackPending loan is still borrower-curable until the lender
            // claims). Share the protocol-wide predicate instead of a bare
            // `!= Active`, which silently dropped FallbackPending loans and could
            // let a borrower miss the cure window.
            if (!LibMetricsHooks._isActive(l.status)) continue;
            bool isBorrower = l.borrower == user;
            bool isLender = l.lender == user;
            if (!isBorrower && !isLender) continue;
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
        nextCursor = end;
    }

    /**
     * @notice Paginated user-created offers — open (un-accepted) or
     *         filled (accepted) split by `filledOnly` flag (D4).
     * @param  user       The offer creator to query.
     * @dev    #2930 — bounded by rows READ, with the cursor rule of
     *         {getUserDashboardLoans} over the user's offer index.
     * @param  filledOnly `true` → only accepted offers; `false` →
     *                    only currently open offers.
     * @param  cursor     Position in the user's offer index to start from.
     * @param  maxScan    Most index rows this call reads
     *                    (≤ {MAX_PAGE_LIMIT}).
     * @return offers     The matching {LibMetricsTypes.OfferSummary}
     *                    records among the rows read (lean flat
     *                    projection — see
     *                    {MetricsFacet.getUserAllOffersWithDetails}).
     * @return nextCursor Position to resume from; the index's length once
     *                    the scan has reached the end.
     */
    function getUserDashboardOffers(
        address user,
        bool filledOnly,
        uint256 cursor,
        uint32 maxScan
    ) external view returns (LibMetricsTypes.OfferSummary[] memory offers, uint256 nextCursor) {
        if (maxScan > MAX_PAGE_LIMIT) revert LimitTooLarge(maxScan, MAX_PAGE_LIMIT);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Walk the user's lifetime offer index. The `accepted`
        // boolean partitions the same set into open vs filled —
        // one pass covers both the chip-filter cases without
        // touching the protocol-wide active list or the lifetime
        // offer space. O(user's offer count).
        uint256[] storage userOffers = s.userOfferIds[user];
        (uint256 i, uint256 end) = LibScanPage.window(userOffers.length, cursor, maxScan);
        LibMetricsTypes.OfferSummary[] memory buf = new LibMetricsTypes.OfferSummary[](end - i);
        uint256 written;
        for (; i < end; ++i) {
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
            buf[written] = LibMetricsTypes.toOfferSummary(o);
            written += 1;
        }
        offers = new LibMetricsTypes.OfferSummary[](written);
        for (uint256 j = 0; j < written; j++) offers[j] = buf[j];
        nextCursor = end;
    }

    /**
     * @notice Paginated claimables for a user (lender or borrower
     *         side per D3). Includes lender post-resolution proceeds,
     *         borrower collateral refunds and NFT rental returns.
     * @param  user         The user to query.
     * @dev    #2930 — bounded by rows READ, with the cursor rule of
     *         {getUserDashboardLoans}.
     * @param  borrowerSide `true` → borrower-side claims;
     *                      `false` → lender-side claims.
     * @param  cursor       Position in the user's loan index to start from.
     * @param  maxScan      Most index rows this call reads
     *                      (≤ {MAX_PAGE_LIMIT}).
     * @return loanIds      Loan IDs the claims attach to.
     * @return claims       Aligned page of {LibVaipakam.ClaimInfo}.
     * @return nextCursor   Position to resume from; the index's length once
     *                      the scan has reached the end.
     */
    function getUserDashboardClaimables(
        address user,
        bool borrowerSide,
        uint256 cursor,
        uint32 maxScan
    )
        external
        view
        returns (
            uint256[] memory loanIds,
            LibVaipakam.ClaimInfo[] memory claims,
            uint256 nextCursor
        )
    {
        if (maxScan > MAX_PAGE_LIMIT) revert LimitTooLarge(maxScan, MAX_PAGE_LIMIT);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Walk the user's lifetime loan index. O(user's loan count)
        // instead of O(every loan ever); same optimization
        // pattern as the loans + offers paths above.
        uint256[] storage userLoans = s.userLoanIds[user];
        (uint256 i, uint256 end) = LibScanPage.window(userLoans.length, cursor, maxScan);

        uint256[] memory idBuf = new uint256[](end - i);
        LibVaipakam.ClaimInfo[] memory claimBuf = new LibVaipakam.ClaimInfo[](end - i);
        uint256 written;

        for (; i < end; ++i) {
            uint256 lid = userLoans[i];
            LibVaipakam.Loan storage l = s.loans[lid];
            bool sideMatch = borrowerSide ? (l.borrower == user) : (l.lender == user);
            if (!sideMatch) continue;
            LibVaipakam.ClaimInfo storage ci = borrowerSide
                ? s.borrowerClaims[lid]
                : s.lenderClaims[lid];
            // #941 — list exactly what the claim call would pay: the shared
            // {LibCloseoutFreeze.lenderClaimPending} / {borrowerClaimPending}
            // rules, which count an NFT return (a row with amount 0), held
            // lender funds and a recorded zero-amount close-out, and only on a
            // status the claim accepts.
            if (
                borrowerSide
                    ? !LibCloseoutFreeze.borrowerClaimPending(s, lid)
                    : !LibCloseoutFreeze.lenderClaimPending(s, lid)
            ) continue;
            // #954 (§2.3) — a full swap-to-repay that consumed ALL collateral
            // freezes ONLY a principal surplus, leaving the collateral
            // `borrowerClaims` slot empty. When the collateral lane has nothing
            // to pay, the surplus row takes the entry, so a delisted self-holder
            // still sees the funds. When the collateral lane IS open, it takes
            // the row and the surplus stays discoverable via
            // `ClaimFacet.getBorrowerSurplusClaim`.
            LibVaipakam.ClaimInfo storage emitCi =
                (borrowerSide && !LibCloseoutFreeze.collateralLaneOpen(ci))
                    ? s.borrowerSurplusClaims[lid]
                    : ci;
            idBuf[written] = lid;
            claimBuf[written] = emitCi;
            written += 1;
        }

        loanIds = LibScanPage.trim(idBuf, written);
        claims = new LibVaipakam.ClaimInfo[](written);
        for (uint256 j = 0; j < written; j++) {
            claims[j] = claimBuf[j];
        }
        nextCursor = end;
    }

    // ─── #1025 bulk wallet-dashboard batch-by-id views ───────────────────────

    /**
     * @notice #1025 — hydrate an arbitrary array of offer ids into flat
     *         {LibMetricsTypes.OfferView} DTOs, each already carrying its
     *         canonical {LibMetricsTypes.OfferState}. Aave-`UiPoolDataProvider`
     *         shaped: one `eth_call` replaces the per-id `getOffer` +
     *         `getOfferState` pair the wallet dashboard issues for every
     *         enumerated offer, cutting `2×N` reads to `⌈N/PAGE⌉` chunked calls.
     * @dev    STRICTLY POSITIONAL — `views[i]` corresponds to `offerIds[i]`,
     *         duplicates preserved, NOT deduped (design §5.2). An unknown /
     *         never-existed / cancel-deleted id yields a zero-value element with
     *         `state == Cancelled` (matching {LibMetricsTypes.deriveOfferState}'s
     *         `o.id == 0` legacy-compat contract) — the batch does NOT revert on
     *         a stale id, so one bad id can't blank a whole refresh. The caller
     *         MUST chunk its id set into ≤ {MAX_BATCH_IDS} slices (the frontend's
     *         `PAGE = 200` is well within); an over-cap array reverts
     *         {BatchTooLarge}. Pure `view`.
     * @param  offerIds The offer ids to hydrate (caller-bounded, ≤ MAX_BATCH_IDS).
     * @return views    Positional, non-deduped {OfferView} array.
     */
    function getOffersWithState(uint256[] calldata offerIds)
        external
        view
        returns (LibMetricsTypes.OfferView[] memory views)
    {
        uint256 n = offerIds.length;
        if (n > MAX_BATCH_IDS) revert BatchTooLarge(n, MAX_BATCH_IDS);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        views = new LibMetricsTypes.OfferView[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 id = offerIds[i];
            // Derive state from the SAME source of truth MetricsFacet uses, then
            // project the row once. A never-existed id derives to `Cancelled`
            // and projects a zero-value `Offer` — the frontend filters it
            // exactly as its per-id guard does today.
            LibMetricsTypes.OfferState st = LibMetricsTypes.deriveOfferState(s, id);
            views[i] = LibMetricsTypes.toOfferView(s.offers[id], st);
        }
    }

    /**
     * @notice #1025 — hydrate an arbitrary array of loan ids into flat
     *         {LibMetricsTypes.LoanView} DTOs (lean {LibMetricsTypes.LoanSummary}
     *         + the two counterparty display addresses). One `eth_call` replaces
     *         the per-id `getLoanDetails` fat-struct read the wallet dashboard
     *         issues for every held loan position.
     * @dev    STRICTLY POSITIONAL and NON-DEDUPED — load-bearing for dual-role
     *         holders: when a wallet holds BOTH the lender and borrower position
     *         NFTs for the same loan, the frontend's holder enumeration returns
     *         that `loanId` twice (paired with two `heldTokenId`s); echoing the
     *         duplicate as two identical elements lets the consumer zip each back
     *         to its role. A collapse-on-dedupe would hide one side from
     *         Positions/Claimables (design §5.2/§5.4). An unknown id yields a
     *         zero-value element (`lender == 0 && borrower == 0`) — no revert on a
     *         stale id. Caller MUST chunk to ≤ {MAX_BATCH_IDS}; over-cap reverts
     *         {BatchTooLarge}. Pure `view`.
     * @param  loanIds The loan ids to hydrate (caller-bounded, ≤ MAX_BATCH_IDS).
     * @return views   Positional, non-deduped {LoanView} array.
     */
    function getLoansBatch(uint256[] calldata loanIds)
        external
        view
        returns (LibMetricsTypes.LoanView[] memory views)
    {
        uint256 n = loanIds.length;
        if (n > MAX_BATCH_IDS) revert BatchTooLarge(n, MAX_BATCH_IDS);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        views = new LibMetricsTypes.LoanView[](n);
        for (uint256 i = 0; i < n; i++) {
            views[i] = LibMetricsTypes.toLoanView(s.loans[loanIds[i]]);
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
            // #940 — the active dashboard set is Active OR FallbackPending (a
            // FallbackPending loan is still borrower-curable until the lender
            // claims). Share the protocol-wide predicate instead of a bare
            // `!= Active`, which silently dropped FallbackPending loans and could
            // let a borrower miss the cure window.
            if (!LibMetricsHooks._isActive(l.status)) continue;
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
            // #941 — the same rules the claimables page uses: one count per
            // loan side the claim call would pay (an NFT return, held lender
            // funds, the borrower's collateral or surplus lane).
            if (l.lender == user && LibCloseoutFreeze.lenderClaimPending(s, lid)) {
                lenderCount += 1;
            }
            if (l.borrower == user && LibCloseoutFreeze.borrowerClaimPending(s, lid)) {
                borrowerCount += 1;
            }
        }
    }

    // _walkOffers / _walkOffersFromList helpers were removed when
    // getUserDashboardOffers switched to walking userOfferIds[user]
    // directly — single-pass over the per-user index covers both
    // open and filled chip states.
}
