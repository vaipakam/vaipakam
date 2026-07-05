// src/facets/MetricsFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibMetricsTypes} from "../libraries/LibMetricsTypes.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title MetricsFacet
 * @author Vaipakam Developer Team
 * @notice Aggregated public read-only analytics surface — README §13
 *         "Public View Functions for Analytics, Transparency, and
 *         Integrations". Consumed by DefiLlama-style TVL trackers, Dune/
 *         Nansen SQL aggregates, wallets/portfolio apps, auditors, and
 *         composable DeFi integrations. All entry points are pure `view`
 *         and multicall-friendly; callers incur zero gas when invoked via
 *         RPC.
 * @dev Analytics are backed by two complementary layers:
 *        1. O(1) counters and per-key mappings maintained by
 *           `LibMetricsHooks` at every lifecycle edge
 *           (loan create/status change, offer create/accept/cancel).
 *        2. Append/swap-pop-maintained active-set lists
 *           (`activeLoanIdsList`, `activeOfferIdsList`) — these bound every
 *           "live snapshot" aggregator by the CURRENT active count rather
 *           than the lifetime sequence `nextLoanId/nextOfferId`. Inactive
 *           or historical loans are never scanned for live metrics.
 *
 *      The previous MAX_ITER-based silent truncation has been removed —
 *      no view returns a wrong answer because the sequence grew past a
 *      hidden cap. Lifetime aggregators that inherently span every loan
 *      ever created (e.g. `getProtocolStats.totalVolumeLentNumeraire`,
 *      `getTotalInterestEarnedNumeraire`) iterate `[1 .. nextLoanId)` without a
 *      cap; on very large deployments prefer the paginated reverse-index
 *      views (`getAllLoansPaginated`, `getLoansByStatusPaginated`) and
 *      aggregate off-chain.
 *
 *      Cross-facet reads for numeraire-quoted pricing go through
 *      `address(this)` so the Diamond routes to OracleFacet (getAssetPrice)
 *      at runtime. Pricing failures (no feed / stale) are treated as 0 for
 *      the affected leg so the aggregate metrics never revert due to a
 *      single misbehaving asset. The protocol is currency-agnostic — every
 *      `*Numeraire` figure below is denominated in whatever numeraire
 *      governance has configured (USD by post-deploy default).
 */
contract MetricsFacet {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.UintSet; // #625 WI-2c intent-loan registry

    uint256 private constant NUMERAIRE_SCALE = 1e18;

    // ─── 1. Protocol-Wide Metrics ───────────────────────────────────────────

    /**
     * @notice Aggregated TVL across active loans, priced live at current
     *         Chainlink rates.
     * @dev Iterates `activeLoanIdsList` (bounded by `activeLoansCount`), so
     *      closed loans no longer contribute. Numeraire-quoted values are
     *      repriced on every call — a loan priced at 100 today may be priced
     *      at 80 tomorrow if the underlying asset moves; this is the
     *      intended semantic of "TVL" as a live market snapshot.
     * @return tvlInNumeraire Sum of `principalNumeraireLocked` + `erc20CollateralTvl`.
     * @return erc20CollateralTvl Numeraire-quoted value of ERC-20 collateral on active loans.
     * @return nftCollateralTvl NFT collateral is priced at $0 (no on-chain oracle);
     *         returns the COUNT of active loans with NFT collateral instead.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function getProtocolTVL()
        external
        view
        returns (uint256 tvlInNumeraire, uint256 erc20CollateralTvl, uint256 nftCollateralTvl)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage active = s.activeLoanIdsList;
        uint256 len = active.length;
        uint256 principalNumeraire;
        uint256 nftCount;
        for (uint256 i = 0; i < len; i++) {
            LibVaipakam.Loan storage l = s.loans[active[i]];
            if (l.assetType == LibVaipakam.AssetType.ERC20) {
                principalNumeraire += _priceAmount(l.principalAsset, l.principal);
            }
            if (l.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                erc20CollateralTvl += _priceAmount(l.collateralAsset, l.collateralAmount);
            } else {
                nftCount += 1;
            }
        }
        tvlInNumeraire = principalNumeraire + erc20CollateralTvl;
        nftCollateralTvl = nftCount;
    }

    /**
     * @notice Protocol-wide aggregate counters and rate summaries.
     * @dev Counter-backed fields (`totalUniqueUsers`, `activeLoansCount`,
     *      `activeOffersCount`, `totalLoansEverCreated`, `defaultRateBps`,
     *      `averageApr`) resolve to single SLOADs — O(1). `totalVolumeLentNumeraire`
     *      and `totalInterestEarnedNumeraire` are repriced live and require a full
     *      scan over `[1 .. nextLoanId)`; the numbers are never truncated
     *      (no silent MAX_ITER cap), and dashboards that need to call this
     *      on deployments with very large loan histories should aggregate
     *      off-chain from `getAllLoansPaginated`.
     */
    function getProtocolStats()
        external
        view
        returns (
            uint256 totalUniqueUsers,
            uint256 activeLoansCount,
            uint256 activeOffersCount,
            uint256 totalLoansEverCreated,
            uint256 totalVolumeLentNumeraire,
            uint256 totalInterestEarnedNumeraire,
            uint256 defaultRateBps,
            uint256 averageApr
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        totalUniqueUsers = s.uniqueUserCount;
        activeLoansCount = s.activeLoansCount;
        activeOffersCount = s.activeOffersCount;
        totalLoansEverCreated = s.totalLoansEverCreated;
        defaultRateBps = totalLoansEverCreated == 0
            ? 0
            : (s.terminalBadOrSettledCount * LibVaipakam.BASIS_POINTS) / totalLoansEverCreated;
        averageApr = totalLoansEverCreated == 0 ? 0 : s.interestRateBpsSum / totalLoansEverCreated;

        // IDs are pre-incremented in LoanFacet (`loanId = ++s.nextLoanId`),
        // so `nextLoanId` is the highest id ever assigned — iterate inclusive
        // to cover it. Matches the [1..nextLoanId] pattern used by
        // {getAllLoansPaginated} and {getLoansByStatusPaginated}.
        uint256 lEnd = s.nextLoanId;
        for (uint256 i = 1; i <= lEnd; i++) {
            LibVaipakam.Loan storage l = s.loans[i];
            if (l.id == 0) continue;
            if (l.assetType != LibVaipakam.AssetType.ERC20) continue;
            uint256 pNumeraire = _priceAmount(l.principalAsset, l.principal);
            totalVolumeLentNumeraire += pNumeraire;
            if (
                l.status != LibVaipakam.LoanStatus.Active &&
                l.status != LibVaipakam.LoanStatus.FallbackPending
            ) {
                totalInterestEarnedNumeraire += (pNumeraire * l.interestRateBps) / LibVaipakam.BASIS_POINTS;
            }
        }
    }

    /// @notice Total count of unique wallets that have participated as lender,
    ///         borrower, or offer creator. Counter-backed — O(1).
    function getUserCount() external view returns (uint256) {
        return LibVaipakam.storageSlot().uniqueUserCount;
    }

    /// @notice Number of loans currently in Active or FallbackPending status.
    ///         Counter-backed — O(1).
    function getActiveLoansCount() external view returns (uint256) {
        return LibVaipakam.storageSlot().activeLoansCount;
    }

    /// @notice Number of offers still in the book (created, not yet accepted
    ///         or cancelled). Counter-backed — O(1).
    function getActiveOffersCount() external view returns (uint256) {
        return LibVaipakam.storageSlot().activeOffersCount;
    }

    /**
     * @notice Cumulative interest earned across all completed loans, priced
     *         at current Chainlink rates.
     * @dev Iterates `[1 .. nextLoanId]` with no cap — lifetime scan. On
     *      deployments with very large histories prefer the paginated
     *      reverse-index views (`getLoansByStatusPaginated(Repaid|Defaulted|
     *      Settled, ..)`) and aggregate off-chain with event-time pricing.
     */
    function getTotalInterestEarnedNumeraire() external view returns (uint256 total) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 end = s.nextLoanId;
        for (uint256 i = 1; i <= end; i++) {
            LibVaipakam.Loan storage l = s.loans[i];
            if (l.id == 0) continue;
            if (l.assetType != LibVaipakam.AssetType.ERC20) continue;
            if (
                l.status == LibVaipakam.LoanStatus.Active ||
                l.status == LibVaipakam.LoanStatus.FallbackPending
            ) continue;
            uint256 pNumeraire = _priceAmount(l.principalAsset, l.principal);
            total += (pNumeraire * l.interestRateBps) / LibVaipakam.BASIS_POINTS;
        }
    }

    // ─── 2. Treasury & Revenue Metrics ──────────────────────────────────────

    /**
     * @notice Treasury balance snapshot plus lifetime and rolling-window
     *         revenue metrics, all priced in the active numeraire.
     * @dev Asset discovery scans only the active-loan list (not the full
     *      lifetime sequence) unioning `principalAsset`, `collateralAsset`,
     *      and `prepayAsset` per live loan — bounded by `activeLoansCount`.
     *      Deployments with treasury balances in assets no longer represented
     *      by any active loan should supplement off-chain with direct reads
     *      of `treasuryBalances(asset)`. Rolling windows are backed by the
     *      append-only `feeEventsLog` populated by
     *      `LibFacet.recordTreasuryAccrual`. Values are frozen in the active
     *      numeraire at the moment of accrual (currency-agnostic — USD by
     *      post-deploy default, governance-rotatable). Window scan is capped
     *      at `LibVaipakam.MAX_FEE_EVENTS_ITER` from the tail; older events
     *      are skipped from the window count but still counted in
     *      `totalFeesCollectedNumeraire` via the O(1)
     *      `cumulativeFeesNumeraire` accumulator.
     */
    function getTreasuryMetrics()
        external
        view
        returns (
            uint256 treasuryBalanceNumeraire,
            uint256 totalFeesCollectedNumeraire,
            uint256 feesLast24hNumeraire,
            uint256 feesLast7dNumeraire
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage active = s.activeLoanIdsList;
        uint256 aLen = active.length;
        address[] memory assets = new address[](aLen * 3);
        uint256 n;
        for (uint256 i = 0; i < aLen; i++) {
            LibVaipakam.Loan storage l = s.loans[active[i]];
            if (l.principalAsset != address(0)) n = _pushUnique(assets, n, l.principalAsset);
            if (l.collateralAsset != address(0)) n = _pushUnique(assets, n, l.collateralAsset);
            if (l.prepayAsset != address(0)) n = _pushUnique(assets, n, l.prepayAsset);
        }
        for (uint256 k = 0; k < n; k++) {
            // T-087 Sub 3 add-on #473 round-3 P2 — include externally-
            // deployed treasury so the dashboard reflects the
            // diamond's TOTAL economic position, not just the
            // in-diamond portion. Without this, deploying to Aave /
            // Lido would silently drop the displayed treasury balance
            // even though the principal is still owned by the diamond.
            uint256 totalForAsset = s.treasuryBalances[assets[k]]
                + s.treasuryDeployedExternal[assets[k]];
            treasuryBalanceNumeraire += _priceAmount(assets[k], totalForAsset);
        }
        totalFeesCollectedNumeraire = s.cumulativeFeesNumeraire;
        uint256 since24h = block.timestamp > 1 days ? block.timestamp - 1 days : 0;
        uint256 since7d = block.timestamp > 7 days ? block.timestamp - 7 days : 0;
        (feesLast24hNumeraire, feesLast7dNumeraire) = _sumFeesInWindows(since24h, since7d);
    }

    /**
     * @notice Revenue over the last `days_` days, priced in the active
     *         numeraire at accrual time.
     * @dev Sums `feeEventsLog` entries whose timestamp is within the window.
     *      Scan is bounded by `LibVaipakam.MAX_FEE_EVENTS_ITER` entries from
     *      the tail so the call stays cheap on long-lived deployments; on
     *      exceeding that bound the returned figure is a lower bound on the
     *      true window revenue. `days_ == 0` returns 0.
     * @param days_ Look-back window in days.
     * @return totalRevenueNumeraire Fees accrued to treasury in the window.
     */
    function getRevenueStats(uint256 days_)
        external
        view
        returns (uint256 totalRevenueNumeraire)
    {
        if (days_ == 0) return 0;
        uint256 windowSpan = days_ * 1 days;
        uint256 windowStart = block.timestamp > windowSpan ? block.timestamp - windowSpan : 0;
        totalRevenueNumeraire = _sumFeesSince(windowStart);
    }

    /// @notice `windowDays` must be in `[1, 365]`.
    error InvalidWindow();
    error WindowTooLong(uint16 requested, uint16 max);

    /// @notice Per-asset rolling-window treasury accrual.
    ///         AnalyticalGettersDesign §3.2 (decisions D5–D6).
    /// @dev    Reads from `treasuryAccrualByDay[asset][dayIndex]` —
    ///         a running ring-buffer maintained by
    ///         {LibFacet.recordTreasuryAccrual} on every accrual.
    ///         Sums the most recent `windowDays` UTC-day buckets
    ///         (inclusive of today). O(windowDays) SLOADs.
    ///
    ///         Pre-deploy revenue is NOT backfilled (D5) — windows
    ///         spanning the deploy boundary read 0 for the pre-
    ///         deploy days. The lifetime aggregate stays correct via
    ///         the legacy {getRevenueStats(uint256)} which scans the
    ///         feeEventsLog.
    /// @param  asset       The treasury-receiving asset to query.
    /// @param  windowDays  Look-back length in days, `1..365`.
    /// @return totalAccrued Sum of accruals over the window, in the
    ///         asset's native units.
    /// @return dayCount    Echo of `windowDays` for caller convenience.
    function getRevenueStats(address asset, uint16 windowDays)
        external
        view
        returns (uint256 totalAccrued, uint16 dayCount)
    {
        if (windowDays == 0) revert InvalidWindow();
        if (windowDays > 365) revert WindowTooLong(windowDays, 365);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 today = block.timestamp / 1 days;
        for (uint256 i = 0; i < windowDays; i++) {
            // Guard against underflow when the window stretches past
            // epoch — relevant in tests where `block.timestamp` may be
            // tiny. The mapping returns 0 for unwritten days, including
            // pre-deploy days. No backfill (D5).
            if (i > today) break;
            totalAccrued += s.treasuryAccrualByDay[asset][today - i];
        }
        dayCount = windowDays;
    }

    // ─── 3. Lending & Offer Metrics ─────────────────────────────────────────

    /// @notice Paginated slice of the active-loan list. O(limit) — the
    ///         underlying list is maintained swap-and-pop by LibMetricsHooks.
    function getActiveLoansPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory loanIds)
    {
        uint256[] storage src = LibVaipakam.storageSlot().activeLoanIdsList;
        loanIds = _slice(src, offset, limit);
    }

    /// @notice Paginated active-loan IDs filtered by current LTV in
    ///         `[minLtvBps, maxLtvBps]`. Internal-liquidation match
    ///         (B.2) bot uses this to discover match-eligible
    ///         candidates per block — see
    ///         `docs/DesignsAndPlans/InternalLiquidationLedger.md`.
    /// @dev    Iterates `s.activeLoanIdsList` from `startIdx`, calls
    ///         `RiskFacet.calculateLTV(loanId)` per row, returns up
    ///         to `pageSize` hits where the live LTV lies in the
    ///         requested band. Illiquid loans (LTV math reverts)
    ///         are skipped silently — bots scan only HF-eligible
    ///         positions anyway. The view is gas-bounded only by
    ///         `pageSize` × oracle-read cost; callers that need
    ///         to walk the whole active-loan set must paginate via
    ///         the returned `nextIdx`. Returns `nextIdx == src.length`
    ///         when the scan reached the end.
    ///
    ///         While `internalMatchEnabled == false` returns an empty
    ///         array — keeps the protocol's match-advertise surface
    ///         off until governance flips the kill-switch (PR3 of
    ///         the internal-match scaffold work).
    /// @param  minLtvBps  Inclusive lower bound on current LTV (BPS).
    /// @param  maxLtvBps  Inclusive upper bound on current LTV (BPS).
    /// @param  startIdx   Index into `activeLoanIdsList` to begin from.
    /// @param  pageSize   Max number of match-eligible IDs returned.
    /// @return loanIds    The match-eligible loan IDs in order.
    /// @return nextIdx    Resume index for the next page; equals
    ///                    `activeLoanIdsList.length` when exhausted.
    function getMatchEligibleLoans(
        uint16 minLtvBps,
        uint16 maxLtvBps,
        uint256 startIdx,
        uint256 pageSize
    ) external view returns (uint256[] memory loanIds, uint256 nextIdx) {
        if (!LibVaipakam.cfgInternalMatchEnabled()) {
            // Kill-switch off — surface stays inert.
            return (new uint256[](0), 0);
        }
        if (minLtvBps > maxLtvBps || pageSize == 0) {
            return (new uint256[](0), startIdx);
        }
        uint256[] storage src = LibVaipakam.storageSlot().activeLoanIdsList;
        uint256 len = src.length;
        if (startIdx >= len) {
            return (new uint256[](0), len);
        }
        uint256[] memory buf = new uint256[](pageSize);
        uint256 filled;
        uint256 i = startIdx;
        for (; i < len && filled < pageSize; ++i) {
            uint256 id = src[i];
            try RiskFacet(address(this)).calculateLTV(id) returns (uint256 ltv) {
                if (ltv >= uint256(minLtvBps) && ltv <= uint256(maxLtvBps)) {
                    buf[filled++] = id;
                }
            } catch {
                // Illiquid loan or other LTV-calc revert. bot
                // doesn't match against these — skip silently.
            }
        }
        loanIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; ++k) loanIds[k] = buf[k];
        nextIdx = i;
    }

    /// @notice EC-003 Phase 2 — does `loanId` have an opposing-direction
    ///         internal-match candidate right now?
    /// @dev    Reads `s.assetPairActiveLoanIds[collateralAsset][principalAsset]`
    ///         (the OPPOSING-direction key relative to `loanId`'s own
    ///         asset pair). Returns the first candidate that:
    ///           (a) is not `loanId` itself,
    ///           (b) is in a matchable status (`Active` or `FallbackPending`),
    ///           (c) has a fresh oracle reading on its `collateralAsset`
    ///               (mirror of the gate `LibFallback.collateralEquivalent`
    ///               uses — `tryGetAssetPrice` returns `ok=true` with a
    ///               non-zero price; quorum disagreement surfaces here
    ///               as `ok=false`).
    ///
    ///         Off-chain callers (keeper bot, frontend) can pre-flight
    ///         the check before submitting `triggerInternalMatchLiquidation`
    ///         or any of the Phase 3 auto-dispatch entry-points
    ///         (`triggerLiquidation` / `triggerDefault` /
    ///         `claimAsLenderWithRetry`). On-chain auto-dispatch in
    ///         Phase 3 calls this same view internally.
    ///
    ///         Complexity: O(K) reads + O(K) oracle probes, where K is
    ///         the length of the opposing-pair list. Bounded; not
    ///         O(N) over all active loans.
    ///
    ///         Returns `(false, 0)` when:
    ///           - the internal-match kill-switch is off,
    ///           - the loan isn't in a matchable status itself,
    ///           - no opposing-pair candidate passes the gates.
    /// @param  loanId         The loan looking for a counterparty.
    /// @return found          `true` iff at least one eligible candidate
    ///                        was found in the opposing-pair list.
    /// @return candidateId    The first eligible candidate's loan ID,
    ///                        or `0` when `found` is false.
    function hasInternalMatchCandidate(uint256 loanId)
        external
        view
        returns (bool found, uint256 candidateId)
    {
        if (!LibVaipakam.cfgInternalMatchEnabled()) return (false, 0);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.id == 0) return (false, 0);
        LibVaipakam.LoanStatus st = loan.status;
        if (
            st != LibVaipakam.LoanStatus.Active &&
            st != LibVaipakam.LoanStatus.FallbackPending
        ) return (false, 0);

        // #591 (Codex #605 round-2 P2) — also filter the SUBJECT. A topped-up
        // FallbackPending subject whose Diamond portion is exhausted has nothing
        // to contribute, so the direct trigger reverts and auto-dispatch
        // declines it. Without this guard the public view would still advertise
        // a counterparty no entry point accepts. (Active/non-topped-up subjects
        // have matchable == collateralAmount, unaffected.)
        if (LibVaipakam.internalMatchableCollateral(loanId) == 0) return (false, 0);

        uint256[] storage candidates = s.assetPairActiveLoanIds[
            loan.collateralAsset
        ][loan.principalAsset];
        uint256 n = candidates.length;
        for (uint256 i = 0; i < n; ++i) {
            uint256 cid = candidates[i];
            if (cid == loanId) continue;

            LibVaipakam.Loan storage cand = s.loans[cid];
            LibVaipakam.LoanStatus cst = cand.status;
            if (
                cst != LibVaipakam.LoanStatus.Active &&
                cst != LibVaipakam.LoanStatus.FallbackPending
            ) continue;

            // #591 — topped-up FallbackPending candidates are no longer
            // filtered out. Internal-match settlement now sizes a topped-up
            // leg's contribution against its Diamond portion only and returns
            // the vault top-up to the borrower side, so such candidates are
            // eligible.
            //
            // #591 (Codex #605 P1) — EXCEPT a candidate whose Diamond portion
            // is exhausted (topped-up FallbackPending whose snapshot a prior
            // partial match consumed; only the vault top-up remains). It has
            // nothing to contribute — matching it would drain THIS loan's
            // collateral one-sidedly. Filter it WHILE scanning so it can't mask
            // a later eligible candidate. Cheap storage read; do it before the
            // oracle gate. (Active candidates have matchable == collateralAmount.)
            if (LibVaipakam.internalMatchableCollateral(cid) == 0) continue;

            // Oracle gate — internal match settles at oracle price, so
            // both of the candidate's assets need a fresh reading.
            (bool ok, uint256 price, ) = OracleFacet(address(this))
                .tryGetAssetPrice(cand.collateralAsset);
            if (!ok || price == 0) continue;
            (ok, price, ) = OracleFacet(address(this))
                .tryGetAssetPrice(cand.principalAsset);
            if (!ok || price == 0) continue;

            // Liquidation-eligibility gate. The same B.2 semantic that
            // `triggerInternalMatchLiquidation` enforces via
            // `_requireLtvAboveFloor` — internal match must only settle
            // pairs where BOTH legs are liquidatable. FallbackPending
            // is past the threshold by definition; Active candidates
            // need a fresh LTV >= floor check. `calculateLTV` reverts
            // on illiquid collateral, so a `try/catch` keeps the view
            // safe in pathological pool states.
            if (cst == LibVaipakam.LoanStatus.Active) {
                uint256 floor = uint256(cand.liquidationLtvBpsAtInit);
                if (floor == 0) continue; // unsnapshotted — skip
                try RiskFacet(address(this)).calculateLTV(cid) returns (uint256 ltv) {
                    if (ltv < floor) continue;
                } catch {
                    continue;
                }
            }

            return (true, cid);
        }
        return (false, 0);
    }

    /// @notice Paginated slice of the active-offer list. O(limit) — the
    ///         underlying list is maintained swap-and-pop by LibMetricsHooks.
    /// @dev Symmetric with `getActiveLoansPaginated` so off-chain consumers
    ///      (matching bot, indexers) can scan the order book the same way
    ///      they scan the loan book. Asset-agnostic; for filtered scans use
    ///      `getActiveOffersByAsset` below.
    function getActiveOffersPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory offerIds)
    {
        uint256[] storage src = LibVaipakam.storageSlot().activeOfferIdsList;
        offerIds = _slice(src, offset, limit);
    }

    /// @notice Paginated list of open offer IDs filtered by lending asset.
    /// @dev Walks `activeOfferIdsList` — bounded by `activeOffersCount`.
    function getActiveOffersByAsset(address asset, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory offerIds)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage src = s.activeOfferIdsList;
        uint256 len = src.length;
        uint256[] memory buf = new uint256[](limit);
        uint256 skipped;
        uint256 filled;
        for (uint256 i = 0; i < len && filled < limit; i++) {
            uint256 id = src[i];
            LibVaipakam.Offer storage o = s.offers[id];
            if (o.lendingAsset != asset) continue;
            if (skipped < offset) { skipped += 1; continue; }
            buf[filled] = id;
            filled += 1;
        }
        offerIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; k++) offerIds[k] = buf[k];
    }

    /// @notice Paginated list of open offer IDs filtered by BOTH the
    ///         lending asset AND the collateral asset — the OfferBook's
    ///         2-filter UX.
    /// @dev    O(asset-pair active count) — reads directly from the
    ///         `assetPairActiveOfferIds[lending][collateral]` swap-pop
    ///         array maintained by LibMetricsHooks. At protocol scale
    ///         (10k+ active offers across 100+ pairs) this is a 100x+
    ///         improvement vs the per-row filter walk in
    ///         {getActiveOffersByAsset}. Cost: one extra SSTORE per
    ///         offer create / accept / cancel edge.
    /// @param  lendingAsset    Required filter (no wildcard).
    /// @param  collateralAsset Required filter (no wildcard).
    /// @param  offset          Skip this many entries.
    /// @param  limit           Max page size.
    /// @return offerIds        Page of matching active offer IDs.
    /// @return total           Total active offers for this pair (for
    ///                         the page-count UI).
    function getActiveOffersByAssetPair(
        address lendingAsset,
        address collateralAsset,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory offerIds, uint256 total) {
        uint256[] storage src = LibVaipakam.storageSlot()
            .assetPairActiveOfferIds[lendingAsset][collateralAsset];
        total = src.length;
        offerIds = _slice(src, offset, limit);
    }

    /// @notice Skinny ranking row returned by
    ///         {getActiveOffersByAssetPairRanked}. Holds only the
    ///         fields the OfferBook needs for client-side sorting +
    ///         anchor-distance ranking — NOT the full Offer struct.
    /// @dev   ABI-encoded width: 8 × 32 bytes = 256 bytes per row.
    ///        The full Offer struct is ~17 slots; surfacing only the
    ///        rank-relevant subset keeps the payload manageable even
    ///        for buckets in the hundreds.
    struct OfferRanking {
        uint256 id;
        LibVaipakam.OfferType offerType; // 0 = Lender, 1 = Borrower
        uint256 amount;                  // Range Orders: amountMin
        uint256 amountMax;
        uint256 interestRateBps;         // Range Orders: rateBpsMin
        uint256 interestRateBpsMax;
        uint256 durationDays;
        uint64 createdAt;
    }

    /// @notice Skinny ranking view of every active offer in the
    ///         (lendingAsset, collateralAsset) bucket, returned in
    ///         one round trip. Pairs with {getActiveOffersByAssetPair}
    ///         (id-only, paged) and {getOffer} (full struct, single-id).
    ///
    /// @dev    Designed for the frontend OfferBook 2-filter UX:
    ///         - One call returns the full bucket's sortable shape
    ///           (~256 bytes per offer × bucket size).
    ///         - Frontend sorts / slices client-side across the entire
    ///           bucket without paying a per-offer hydration cost.
    ///         - Only the page-N slice the user is viewing then gets
    ///           hydrated via per-id `getOffer` multicalls.
    ///         The on-chain alternative (maintaining sorted indices
    ///         per sort-key × direction) was rejected — it adds a
    ///         per-edge gas tax to every offer create / accept /
    ///         cancel for a feature that's purely a read-side
    ///         optimisation.
    ///
    /// @dev    No offset / limit — the whole bucket is returned. The
    ///         pair-keyed index keeps buckets bounded by the number
    ///         of currently-active offers in a given pair (typically
    ///         tens, even at protocol scale only the few canonical
    ///         pairs reach the low hundreds). For pathologically
    ///         large buckets the frontend is expected to fall back
    ///         to {getActiveOffersByAssetPair}'s paged id list.
    ///
    /// @param  lendingAsset    Required filter (no wildcard).
    /// @param  collateralAsset Required filter (no wildcard).
    /// @return rankings        Skinny ranking row per active offer.
    /// @return total           `rankings.length`; surfaced for UI
    ///                         total-count rendering without a
    ///                         second `.length` round trip.
    function getActiveOffersByAssetPairRanked(
        address lendingAsset,
        address collateralAsset
    ) external view returns (OfferRanking[] memory rankings, uint256 total) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage src = s.assetPairActiveOfferIds[lendingAsset][collateralAsset];
        total = src.length;
        rankings = new OfferRanking[](total);
        for (uint256 i = 0; i < total; i++) {
            LibVaipakam.Offer storage o = s.offers[src[i]];
            rankings[i] = OfferRanking({
                id: o.id,
                offerType: o.offerType,
                amount: o.amount,
                amountMax: o.amountMax,
                interestRateBps: o.interestRateBps,
                interestRateBpsMax: o.interestRateBpsMax,
                durationDays: o.durationDays,
                createdAt: o.createdAt
            });
        }
    }

    /**
     * @notice Aggregate summary across active loans.
     * @return totalActiveLoanValueNumeraire Sum of priced principal across ERC-20 loans.
     * @return averageLoanDuration Simple mean of durationDays across active loans.
     * @return averageLtv Simple mean of per-loan LTV (bps) via RiskFacet; 0 for NFT legs.
     */
    function getLoanSummary()
        external
        view
        returns (
            uint256 totalActiveLoanValueNumeraire,
            uint256 averageLoanDuration,
            uint256 averageLtv
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage active = s.activeLoanIdsList;
        uint256 len = active.length;
        uint256 durSum;
        uint256 ltvSum;
        uint256 ltvCount;
        for (uint256 i = 0; i < len; i++) {
            LibVaipakam.Loan storage l = s.loans[active[i]];
            durSum += l.durationDays;
            if (l.assetType == LibVaipakam.AssetType.ERC20) {
                totalActiveLoanValueNumeraire += _priceAmount(l.principalAsset, l.principal);
            }
            if (
                l.assetType == LibVaipakam.AssetType.ERC20 &&
                l.collateralAssetType == LibVaipakam.AssetType.ERC20
            ) {
                try RiskFacet(address(this)).calculateLTV(l.id) returns (uint256 ltv) {
                    ltvSum += ltv;
                    ltvCount += 1;
                } catch { }
            }
        }
        averageLoanDuration = len == 0 ? 0 : durSum / len;
        averageLtv = ltvCount == 0 ? 0 : ltvSum / ltvCount;
    }

    // ─── 4. NFT & Vault Metrics ────────────────────────────────────────────

    /**
     * @notice NFT/vault activity summary. Iterates the active-loan list
     *         (bounded by `activeLoansCount`). A "rental" here is any
     *         active loan whose principal (lending) asset is an NFT.
     *         `totalRentalVolumeNumeraire` is the current-term
     *         numeraire-quoted price of each active rental's principal where
     *         the `prepayAsset` has a live feed.
     */
    function getVaultStats()
        external
        view
        returns (
            uint256 totalNftsInVault,
            uint256 activeRentalsCount,
            uint256 totalRentalVolumeNumeraire
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage active = s.activeLoanIdsList;
        uint256 len = active.length;
        for (uint256 i = 0; i < len; i++) {
            LibVaipakam.Loan storage l = s.loans[active[i]];
            if (l.assetType != LibVaipakam.AssetType.ERC20) {
                activeRentalsCount += 1;
                if (l.prepayAsset != address(0) && l.prepayAmount > 0) {
                    totalRentalVolumeNumeraire += _priceAmount(l.prepayAsset, l.prepayAmount);
                }
                totalNftsInVault += 1;
            }
            if (l.collateralAssetType != LibVaipakam.AssetType.ERC20) {
                totalNftsInVault += 1;
            }
        }
    }

    /// @notice Loan corresponding to a rented Vaipakam position NFT.
    /// @dev O(1): resolves via `loanIdByPositionTokenId` reverse mapping
    ///      maintained by LibMetricsHooks. Returns empty Loan when the
    ///      position is not an NFT-rental leg or no longer active.
    // forge-lint: disable-next-line(mixed-case-function)
    function getNFTRentalDetails(uint256 tokenId) external view returns (LibVaipakam.Loan memory) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 id = s.loanIdByPositionTokenId[tokenId];
        if (id != 0) {
            LibVaipakam.Loan storage l = s.loans[id];
            if (l.assetType != LibVaipakam.AssetType.ERC20) {
                return l;
            }
        }
        LibVaipakam.Loan memory empty;
        return empty;
    }

    /// @notice Count of active loan legs whose contract matches `collection`.
    ///         Counter-backed via `nftsInVaultByCollection` — O(1).
    // forge-lint: disable-next-line(mixed-case-function)
    function getTotalNFTsInVaultByCollection(address collection) external view returns (uint256) {
        return LibVaipakam.storageSlot().nftsInVaultByCollection[collection];
    }

    // ─── 6. User-Specific Metrics ───────────────────────────────────────────

    /**
     * @notice Per-user position summary.
     * @dev Walks `userLoanIds[user]` filtered to active loans — bounded
     *      by the user's lifetime loan count, not the protocol-wide
     *      active count. At scale (10k+ active loans) this is the
     *      1000× win the per-key index was built for.
     *      `healthFactor` returned is the MINIMUM HF across the user's
     *      borrower-side active loans (worst-case). If the user has no
     *      borrower legs, returns `type(uint256).max` (i.e. infinitely
     *      safe). `availableToClaimNumeraire` currently returns 0 —
     *      claim valuations require ClaimInfo iteration with per-asset
     *      pricing beyond the scope of this snapshot; integrators
     *      should call `ClaimFacet.getClaimable` per loan.
     */
    function getUserSummary(address user)
        external
        view
        returns (
            uint256 totalCollateralNumeraire,
            uint256 totalBorrowedNumeraire,
            uint256 availableToClaimNumeraire,
            uint256 healthFactor,
            uint256 activeLoanCount
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage userLoans = s.userLoanIds[user];
        uint256 len = userLoans.length;
        uint256 minHf = type(uint256).max;
        bool anyBorrow;
        for (uint256 i = 0; i < len; i++) {
            LibVaipakam.Loan storage l = s.loans[userLoans[i]];
            // Per-user index covers lifetime; filter to active.
            if (l.status != LibVaipakam.LoanStatus.Active) continue;
            bool isBorrower = l.borrower == user;
            bool isLender = l.lender == user;
            if (!isBorrower && !isLender) continue;
            activeLoanCount += 1;
            if (isBorrower) {
                if (l.assetType == LibVaipakam.AssetType.ERC20) {
                    totalBorrowedNumeraire += _priceAmount(l.principalAsset, l.principal);
                }
                if (l.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                    totalCollateralNumeraire += _priceAmount(l.collateralAsset, l.collateralAmount);
                }
                if (
                    l.assetType == LibVaipakam.AssetType.ERC20 &&
                    l.collateralAssetType == LibVaipakam.AssetType.ERC20
                ) {
                    try RiskFacet(address(this)).calculateHealthFactor(l.id) returns (uint256 hf) {
                        anyBorrow = true;
                        if (hf < minHf) minHf = hf;
                    } catch { }
                }
            }
        }
        healthFactor = anyBorrow ? minHf : type(uint256).max;
        availableToClaimNumeraire = 0;
    }

    /// @notice Active loan IDs where `user` is lender or borrower.
    /// @dev O(user's lifetime loan count) — walks `userLoanIds[user]`
    ///      filtered to Active status. For all-status (lifetime),
    ///      use {getUserLoansPaginated} which returns the same index
    ///      without the status filter.
    function getUserActiveLoans(address user) external view returns (uint256[] memory loanIds) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage userLoans = s.userLoanIds[user];
        uint256 len = userLoans.length;
        uint256[] memory buf = new uint256[](len);
        uint256 n;
        for (uint256 i = 0; i < len; i++) {
            uint256 id = userLoans[i];
            LibVaipakam.Loan storage l = s.loans[id];
            if (l.status != LibVaipakam.LoanStatus.Active) continue;
            if (l.lender == user || l.borrower == user) { buf[n] = id; n += 1; }
        }
        loanIds = new uint256[](n);
        for (uint256 k = 0; k < n; k++) loanIds[k] = buf[k];
    }

    /// @notice Open offer IDs created by `user`.
    /// @dev O(user's offer count) — walks `userOfferIds[user]`
    ///      filtered to non-accepted (= currently open). For
    ///      lifetime offers regardless of state, use
    ///      {getUserOffersPaginated}.
    function getUserActiveOffers(address user) external view returns (uint256[] memory offerIds) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage userOffers = s.userOfferIds[user];
        uint256 len = userOffers.length;
        uint256[] memory buf = new uint256[](len);
        uint256 n;
        for (uint256 i = 0; i < len; i++) {
            uint256 id = userOffers[i];
            LibVaipakam.Offer storage o = s.offers[id];
            // Per-user index already filters by creator; keep only
            // currently-OPEN (un-accepted) offers for this surface.
            if (!o.accepted) { buf[n] = id; n += 1; }
        }
        offerIds = new uint256[](n);
        for (uint256 k = 0; k < n; k++) offerIds[k] = buf[k];
    }

    /**
     * @notice Token IDs of Vaipakam position NFTs representing NFT-asset legs
     *         that currently belong to `user`.
     * @dev O(activeLoansCount) — iterates the active-loan list. Does not
     *      reach into per-user vault proxies.
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function getUserNFTsInVault(address user) external view returns (uint256[] memory tokenIds) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Walk the user's lifetime loan index, filter to active +
        // NFT-leg. O(user's loan count).
        uint256[] storage userLoans = s.userLoanIds[user];
        uint256 len = userLoans.length;
        uint256[] memory buf = new uint256[](len * 2);
        uint256 n;
        for (uint256 i = 0; i < len; i++) {
            LibVaipakam.Loan storage l = s.loans[userLoans[i]];
            if (l.status != LibVaipakam.LoanStatus.Active) continue;
            bool isNftLoan = l.assetType != LibVaipakam.AssetType.ERC20 ||
                l.collateralAssetType != LibVaipakam.AssetType.ERC20;
            if (!isNftLoan) continue;
            if (l.lender == user) { buf[n] = l.lenderTokenId; n += 1; }
            if (l.borrower == user) { buf[n] = l.borrowerTokenId; n += 1; }
        }
        tokenIds = new uint256[](n);
        for (uint256 k = 0; k < n; k++) tokenIds[k] = buf[k];
    }

    // ─── 7. Compliance & Transparency ───────────────────────────────────────

    /**
     * @notice Protocol-level health snapshot over active loans, priced live.
     * @return utilizationRateBps totalDebt / totalCollateral (bps); 0 if no collateral.
     * @return totalCollateralNumeraire Numeraire-quoted value of ERC-20 collateral on active loans.
     * @return totalDebtNumeraire Numeraire-quoted value of principal on active ERC-20 loans.
     * @return isPaused True iff the protocol is currently paused.
     */
    function getProtocolHealth()
        external
        view
        returns (
            uint256 utilizationRateBps,
            uint256 totalCollateralNumeraire,
            uint256 totalDebtNumeraire,
            bool isPaused
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage active = s.activeLoanIdsList;
        uint256 len = active.length;
        for (uint256 i = 0; i < len; i++) {
            LibVaipakam.Loan storage l = s.loans[active[i]];
            if (l.assetType == LibVaipakam.AssetType.ERC20) {
                totalDebtNumeraire += _priceAmount(l.principalAsset, l.principal);
            }
            if (l.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                totalCollateralNumeraire += _priceAmount(l.collateralAsset, l.collateralAmount);
            }
        }
        utilizationRateBps = totalCollateralNumeraire == 0
            ? 0
            : (totalDebtNumeraire * LibVaipakam.BASIS_POINTS) / totalCollateralNumeraire;
        isPaused = LibPausable.paused();
    }

    /// @notice Current block timestamp. Useful for freshness checks.
    function getBlockTimestamp() external view returns (uint256) {
        return block.timestamp;
    }

    // ─── 8. Reverse-Index Enumeration (indexer-independent) ─────────────────
    //
    // The views below are O(results) rather than O(nextLoanId/nextOfferId).
    // They let frontends, indexers and bots enumerate protocol state without
    // scanning logs — Alchemy / public RPCs that cap event scans to 10 blocks
    // no longer affect reads. The reverse indexes are append-only (see
    // LibVaipakam.Storage.userLoanIds / userOfferIds) and the position NFT
    // enumeration lives in LibERC721.ERC721Storage.allTokens / ownedTokens.

    /// @notice Global loan/offer counts. `nextLoanId - 1` is the highest ever
    ///         assigned ID; IDs are sequential and start at 1.
    function getGlobalCounts()
        external
        view
        returns (uint256 totalLoansCreated, uint256 totalOffersCreated)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        totalLoansCreated = s.nextLoanId;
        totalOffersCreated = s.nextOfferId;
    }

    /// @notice Count of loans the user has ever appeared on (lender or borrower).
    function getUserLoanCount(address user) external view returns (uint256) {
        return LibVaipakam.storageSlot().userLoanIds[user].length;
    }

    /// @notice Count of offers the user has ever created.
    function getUserOfferCount(address user) external view returns (uint256) {
        return LibVaipakam.storageSlot().userOfferIds[user].length;
    }

    /// @notice Whether `offerId` was cancelled. Survives the hard-delete in
    ///         {OfferFacet.cancelOffer} so history stays reconstructable.
    function isOfferCancelled(uint256 offerId) external view returns (bool) {
        return LibVaipakam.storageSlot().offerCancelled[offerId];
    }

    /**
     * @notice Paginated slice of every loan the user has ever participated in.
     * @dev Reads the append-only `userLoanIds[user]` index. Returned IDs
     *      include all lifecycle states — filter client-side via
     *      `LoanFacet.getLoanDetails` or use {getUserLoansByStatusPaginated}.
     */
    function getUserLoansPaginated(address user, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory loanIds, uint256 total)
    {
        uint256[] storage src = LibVaipakam.storageSlot().userLoanIds[user];
        total = src.length;
        loanIds = _slice(src, offset, limit);
    }

    /// @notice Paginated slice of every offer the user has ever created.
    function getUserOffersPaginated(address user, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory offerIds, uint256 total)
    {
        uint256[] storage src = LibVaipakam.storageSlot().userOfferIds[user];
        total = src.length;
        offerIds = _slice(src, offset, limit);
    }

    /// @notice Struct-returning variant of {getUserOffersPaginated} —
    ///         saves frontends a second round-trip for the per-offer
    ///         struct fetch that they were doing after the IDs came back.
    /// @dev    O(limit) — page slice of the user's lifetime offer
    ///         index `userOfferIds[user]`. Returns a lean flat
    ///         {LibMetricsTypes.OfferSummary} per row including state
    ///         flags (`accepted`, `amountFilled`), letting consumers
    ///         filter active vs filled client-side without a follow-up
    ///         read. The summary omits rental/listing/snapshot fields to
    ///         keep the viaIR array-coder shallow — consumers needing
    ///         those call the single-struct getOffer view.
    /// @param  user   The offer creator.
    /// @param  offset Skip this many entries.
    /// @param  limit  Max page size.
    /// @return offers Page of {LibMetricsTypes.OfferSummary} records.
    /// @return total  Total offers in the user's lifetime index.
    function getUserAllOffersWithDetails(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (LibMetricsTypes.OfferSummary[] memory offers, uint256 total) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage src = s.userOfferIds[user];
        total = src.length;
        if (offset >= total) return (new LibMetricsTypes.OfferSummary[](0), total);
        uint256 endExcl = offset + limit;
        if (endExcl > total) endExcl = total;
        uint256 size = endExcl - offset;
        offers = new LibMetricsTypes.OfferSummary[](size);
        for (uint256 i = 0; i < size; i++) {
            offers[i] = LibMetricsTypes.toOfferSummary(s.offers[src[offset + i]]);
        }
    }

    /// @notice #625 WI-2a — paginated ACTIVE lender intents: the discovery source the
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
    /// @return intents Page of active-intent summaries.
    /// @return total   Count of active intents at this block.
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
        intents = new LibMetricsTypes.LenderIntentSummary[](size);
        for (uint256 i = 0; i < size; i++) {
            LibVaipakam.IntentKey memory key =
                s.intentKeyTuple[s.activeIntentKeys.at(offset + i)];
            intents[i] = LibMetricsTypes.toLenderIntentSummary(
                key,
                s.lenderIntent[key.owner][key.lendingAsset][key.collateralAsset],
                s.lenderIntentLivePrincipal[key.owner][key.lendingAsset][
                    key.collateralAsset
                ],
                s.lenderIntentCapital[key.owner][key.lendingAsset][
                    key.collateralAsset
                ]
            );
        }
    }

    /// @notice #625 WI-2c — paginated view of fully-repaid intent-originated
    ///         loans a keeper can AUTO-ROLL (`LenderIntentFacet.rollIntentLoan`).
    ///         Pages the `activeIntentLoans` registry (every live intent loan)
    ///         and returns only those at `LoanStatus.Repaid` — the roll
    ///         candidates — keyed off each loan's `intentOrigin` (so a sold
    ///         lender position is still surfaced; `rollIntentLoan` then rejects
    ///         it, and the keeper keys AUTO_ROLL auth off `owner`).
    /// @param  offset / limit  Window over the registry. `total` is the FULL
    ///         registry size (Active + Repaid); the keeper pages until
    ///         `offset >= total`, accumulating the Repaid rows each page yields.
    /// @return loans  The Repaid intent loans within `[offset, offset+limit)`.
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
            if (s.loans[loanId].status == LibVaipakam.LoanStatus.Repaid) {
                buf[n] = LibMetricsTypes.toRollableIntentLoan(
                    loanId, s.intentOrigin[loanId]
                );
                n++;
            }
        }
        loans = new LibMetricsTypes.RollableIntentLoan[](n);
        for (uint256 i = 0; i < n; i++) {
            loans[i] = buf[i];
        }
    }

    /**
     * @notice Paginated slice of the user's loans filtered by `status`.
     * @dev O(userLoanIds[user].length) — still cheap vs. the protocol-wide
     *      scans above. `offset`/`limit` refer to positions within the
     *      filtered result, not the raw index.
     */
    function getUserLoansByStatusPaginated(
        address user,
        LibVaipakam.LoanStatus status,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory loanIds, uint256 matched) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage src = s.userLoanIds[user];
        uint256 len = src.length;
        uint256[] memory buf = new uint256[](limit);
        uint256 skipped;
        uint256 filled;
        for (uint256 i = 0; i < len; i++) {
            uint256 id = src[i];
            if (s.loans[id].status != status) continue;
            matched += 1;
            if (skipped < offset) { skipped += 1; continue; }
            if (filled < limit) { buf[filled] = id; filled += 1; }
        }
        loanIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; k++) loanIds[k] = buf[k];
    }

    /// @dev Offer lifecycle state used by {getUserOffersByStatePaginated}.
    ///      Open = created, not accepted, not cancelled; Accepted = a loan
    ///      was spun up; Cancelled = creator exited before acceptance.
    ///      T-086 Round-8 (#358) §19.7e — `ConsumedBySale` is the
    ///      no-loan-branch parallel-sale terminal (Scenario A: buyer-
    ///      side won the race). Mirror of `Cancelled` but distinct so
    ///      the frontend can render "Sold via OpenSea — no loan was
    ///      opened" instead of the generic "Cancelled" copy. Added at
    ///      the end of the enum so existing indexed value bindings are
    ///      preserved.
    /// @dev  #1025 — the `OfferState` enum + its derivation were hoisted into
    ///       {LibMetricsTypes} so the bulk `MetricsDashboardFacet.getOffersWithState`
    ///       shares ONE terminal-precedence definition with this facet. The enum
    ///       is now `LibMetricsTypes.OfferState`; `getOfferState`'s wire ABI is
    ///       unchanged (enum = uint8), only the exported `internalType` string
    ///       moves. `_offerStateOf` below is a thin delegate kept so this facet's
    ///       internal call sites read unchanged.

    /**
     * @notice Paginated slice of the user's offers filtered by lifecycle state.
     */
    function getUserOffersByStatePaginated(
        address user,
        LibMetricsTypes.OfferState state,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory offerIds, uint256 matched) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage src = s.userOfferIds[user];
        uint256 len = src.length;
        uint256[] memory buf = new uint256[](limit);
        uint256 skipped;
        uint256 filled;
        for (uint256 i = 0; i < len; i++) {
            uint256 id = src[i];
            LibMetricsTypes.OfferState actual = _offerStateOf(s, id);
            if (actual != state) continue;
            matched += 1;
            if (skipped < offset) { skipped += 1; continue; }
            if (filled < limit) { buf[filled] = id; filled += 1; }
        }
        offerIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; k++) offerIds[k] = buf[k];
    }

    // ─── 8b. NFT-Holder Enumeration (secondary-market-safe) ────────────────
    //
    // The §8 views above (getUserLoansPaginated / getUserOffersPaginated)
    // walk the `userLoanIds[user]` / `userOfferIds[user]` storage indexes,
    // which are populated at LoanInitiated / OfferCreated time. They do NOT
    // track ownership AFTER the position NFT changes hands on the
    // secondary market. The views below close that gap: they enumerate
    // loans/offers whose position NFT the user CURRENTLY holds via
    // ERC721Enumerable, regardless of who originally created the loan or
    // posted the offer.
    //
    // Performance: O(user's NFT count) — bounded by `balanceOf(user)`.
    // For a typical participant who holds 1-20 position NFTs, each call
    // is a constant-time enumeration vs. an O(all loans) scan. Pairs
    // with the indexer's `/loans/by-current-holder/{addr}` /
    // `/offers/by-current-holder/{addr}` endpoints (cached projection
    // of the same data) for the indexer-first → on-chain-fallback
    // layered pattern in the frontend hooks.
    //
    // Naming convention: `getUserPosition*` — distinguishes from
    // `getUser*` views above which are LoanInitiated/OfferCreated-keyed.

    /**
     * @notice Loans whose lender- or borrower-position NFT `user` currently
     *         holds (resolved via ERC721Enumerable + the
     *         `loanIdByPositionTokenId` reverse map).
     * @dev    Catches secondary-market NFT recipients that
     *         `getUserLoansPaginated` misses. Each tokenId resolves to
     *         exactly one loan; if the NFT was minted but no loan exists
     *         for it (e.g. an open offer's creator-NFT), the slot is
     *         skipped — see {getUserPositionOffers} for that surface.
     * @return loanIds  Loan IDs whose position NFT `user` currently holds.
     *                  Each entry is unique (one entry per tokenId, but a
     *                  user holding both lender+borrower NFTs of the same
     *                  loan appears twice — once per role; downstream can
     *                  dedupe via the loanIds set if it wants the loan
     *                  count rather than the role-tally).
     * @return tokenIds The position NFT id corresponding to each loanId
     *                  entry, aligned 1:1. Lets callers infer the role
     *                  by comparing against `loan.lenderTokenId` /
     *                  `loan.borrowerTokenId`.
     */
    function getUserPositionLoans(address user)
        external
        view
        returns (uint256[] memory loanIds, uint256[] memory tokenIds)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 balance = LibERC721.balanceOf(user);
        uint256[] memory loanBuf = new uint256[](balance);
        uint256[] memory tokenBuf = new uint256[](balance);
        uint256 filled;
        for (uint256 i = 0; i < balance; i++) {
            uint256 tokenId = LibERC721.tokenOfOwnerByIndex(user, i);
            uint256 lid = s.loanIdByPositionTokenId[tokenId];
            if (lid != 0) {
                loanBuf[filled] = lid;
                tokenBuf[filled] = tokenId;
                filled += 1;
            }
        }
        loanIds = new uint256[](filled);
        tokenIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; k++) {
            loanIds[k] = loanBuf[k];
            tokenIds[k] = tokenBuf[k];
        }
    }

    /**
     * @notice Offers whose creator-position NFT `user` currently holds
     *         (resolved via ERC721Enumerable + the
     *         `offerIdByPositionTokenId` reverse map).
     * @dev    Catches secondary-market offer NFT recipients that
     *         `getUserOffersPaginated` misses. Only OPEN offers are
     *         returned — `offerIdByPositionTokenId` is cleared at
     *         cancel time and at offer-acceptance (when the tokenId
     *         transitions to a loan position; `getUserPositionLoans`
     *         surfaces it from then on).
     * @return offerIds Offer IDs whose creator-NFT `user` currently
     *                  holds.
     * @return tokenIds Position NFT id per offerId entry, aligned 1:1.
     */
    function getUserPositionOffers(address user)
        external
        view
        returns (uint256[] memory offerIds, uint256[] memory tokenIds)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 balance = LibERC721.balanceOf(user);
        uint256[] memory offerBuf = new uint256[](balance);
        uint256[] memory tokenBuf = new uint256[](balance);
        uint256 filled;
        for (uint256 i = 0; i < balance; i++) {
            uint256 tokenId = LibERC721.tokenOfOwnerByIndex(user, i);
            uint256 oid = s.offerIdByPositionTokenId[tokenId];
            if (oid != 0) {
                offerBuf[filled] = oid;
                tokenBuf[filled] = tokenId;
                filled += 1;
            }
        }
        offerIds = new uint256[](filled);
        tokenIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; k++) {
            offerIds[k] = offerBuf[k];
            tokenIds[k] = tokenBuf[k];
        }
    }

    /**
     * @notice Paginated form of {getUserPositionLoans} — bounded iteration over
     *         `[offset, offset + limit)` of `user`'s ERC721Enumerable inventory.
     * @dev    #769 — {getUserPositionLoans} loops the WHOLE `balanceOf(user)`, so
     *         a wallet griefed with a huge position-NFT inventory (ERC721
     *         transfers need no recipient consent) can make that single
     *         `eth_call` exceed an RPC's gas/time/response limit and revert,
     *         breaking the holder's loan/claimable reads. This bounds the
     *         worst-case work to O(limit). The caller paginates with
     *         `offset += limit` until `offset >= totalBalance`. NB the slice
     *         indexes the wallet's NFT slots at call time — a concurrent transfer
     *         that changes `balanceOf` mid-pagination can shift indices
     *         (eventually consistent; callers re-read on the next render).
     * @param user   Holder to enumerate.
     * @param offset First NFT index (in ERC721Enumerable order) to scan.
     * @param limit  Max NFT slots to scan this page (`0` ⇒ empty page).
     * @return loanIds      Loan IDs whose position NFT `user` holds in the slice.
     * @return tokenIds     Position NFT id per loanId, aligned 1:1.
     * @return totalBalance `balanceOf(user)` — the pagination bound.
     */
    function getUserPositionLoansPaginated(
        address user,
        uint256 offset,
        uint256 limit
    )
        external
        view
        returns (
            uint256[] memory loanIds,
            uint256[] memory tokenIds,
            uint256 totalBalance
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        totalBalance = LibERC721.balanceOf(user);
        if (offset >= totalBalance || limit == 0) {
            return (new uint256[](0), new uint256[](0), totalBalance);
        }
        // Overflow-safe span: offset < totalBalance, so `remaining` is positive.
        uint256 remaining = totalBalance - offset;
        uint256 span = limit < remaining ? limit : remaining;
        uint256 end = offset + span;
        uint256[] memory loanBuf = new uint256[](span);
        uint256[] memory tokenBuf = new uint256[](span);
        uint256 filled;
        for (uint256 i = offset; i < end; i++) {
            uint256 tokenId = LibERC721.tokenOfOwnerByIndex(user, i);
            uint256 lid = s.loanIdByPositionTokenId[tokenId];
            if (lid != 0) {
                loanBuf[filled] = lid;
                tokenBuf[filled] = tokenId;
                filled += 1;
            }
        }
        loanIds = new uint256[](filled);
        tokenIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; k++) {
            loanIds[k] = loanBuf[k];
            tokenIds[k] = tokenBuf[k];
        }
    }

    /**
     * @notice Paginated form of {getUserPositionOffers} — bounded iteration over
     *         `[offset, offset + limit)` of `user`'s ERC721Enumerable inventory.
     * @dev    Same #769 large-inventory rationale + pagination contract as
     *         {getUserPositionLoansPaginated}; resolves OPEN offers via
     *         `offerIdByPositionTokenId`.
     * @param user   Holder to enumerate.
     * @param offset First NFT index (in ERC721Enumerable order) to scan.
     * @param limit  Max NFT slots to scan this page (`0` ⇒ empty page).
     * @return offerIds     Offer IDs whose creator-NFT `user` holds in the slice.
     * @return tokenIds     Position NFT id per offerId, aligned 1:1.
     * @return totalBalance `balanceOf(user)` — the pagination bound.
     */
    function getUserPositionOffersPaginated(
        address user,
        uint256 offset,
        uint256 limit
    )
        external
        view
        returns (
            uint256[] memory offerIds,
            uint256[] memory tokenIds,
            uint256 totalBalance
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        totalBalance = LibERC721.balanceOf(user);
        if (offset >= totalBalance || limit == 0) {
            return (new uint256[](0), new uint256[](0), totalBalance);
        }
        uint256 remaining = totalBalance - offset;
        uint256 span = limit < remaining ? limit : remaining;
        uint256 end = offset + span;
        uint256[] memory offerBuf = new uint256[](span);
        uint256[] memory tokenBuf = new uint256[](span);
        uint256 filled;
        for (uint256 i = offset; i < end; i++) {
            uint256 tokenId = LibERC721.tokenOfOwnerByIndex(user, i);
            uint256 oid = s.offerIdByPositionTokenId[tokenId];
            if (oid != 0) {
                offerBuf[filled] = oid;
                tokenBuf[filled] = tokenId;
                filled += 1;
            }
        }
        offerIds = new uint256[](filled);
        tokenIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; k++) {
            offerIds[k] = offerBuf[k];
            tokenIds[k] = tokenBuf[k];
        }
    }

    /**
     * @notice Paginated slice of every loan ever created, regardless of status.
     * @dev Sequential ID scan bounded by `limit`. Loans with `id == 0`
     *      (shouldn't happen post-initiation) are skipped.
     */
    function getAllLoansPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory loanIds, uint256 total)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        total = s.nextLoanId; // highest valid id (1-indexed; sequence starts at 1)
        uint256[] memory buf = new uint256[](limit);
        uint256 filled;
        uint256 start = offset + 1; // IDs start at 1
        for (uint256 id = start; id <= total && filled < limit; id++) {
            if (s.loans[id].id == 0) continue;
            buf[filled] = id; filled += 1;
        }
        loanIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; k++) loanIds[k] = buf[k];
    }

    /// @notice Paginated slice of every offer ever created (including cancelled).
    function getAllOffersPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory offerIds, uint256 total)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        total = s.nextOfferId;
        uint256[] memory buf = new uint256[](limit);
        uint256 filled;
        uint256 start = offset + 1;
        for (uint256 id = start; id <= total && filled < limit; id++) {
            // Include both live offers (offers[id].id != 0) and cancelled
            // offers (offers[id].id == 0 && offerCancelled[id] == true) so
            // indexers can reconstruct full history via a single view.
            // T-086 Round-8 (#358) §19.7e — consumed-by-sale offers
            // (Scenario A terminal) also belong in the indexer's full-
            // history view, mirror of the cancelled branch.
            if (
                s.offers[id].id == 0
                && !s.offerCancelled[id]
                && !s.offerConsumedBySale[id]
            ) continue;
            buf[filled] = id; filled += 1;
        }
        offerIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; k++) offerIds[k] = buf[k];
    }

    /// @notice Paginated slice of loans in a given status.
    function getLoansByStatusPaginated(
        LibVaipakam.LoanStatus status,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory loanIds, uint256 matched) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 end = s.nextLoanId;
        uint256[] memory buf = new uint256[](limit);
        uint256 skipped;
        uint256 filled;
        for (uint256 id = 1; id <= end; id++) {
            if (s.loans[id].status != status) continue;
            matched += 1;
            if (skipped < offset) { skipped += 1; continue; }
            if (filled < limit) { buf[filled] = id; filled += 1; }
        }
        loanIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; k++) loanIds[k] = buf[k];
    }

    /// @notice Paginated slice of offers in a given lifecycle state.
    function getOffersByStatePaginated(
        LibMetricsTypes.OfferState state,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory offerIds, uint256 matched) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 end = s.nextOfferId;
        uint256[] memory buf = new uint256[](limit);
        uint256 skipped;
        uint256 filled;
        for (uint256 id = 1; id <= end; id++) {
            LibMetricsTypes.OfferState actual = _offerStateOf(s, id);
            if (actual != state) continue;
            matched += 1;
            if (skipped < offset) { skipped += 1; continue; }
            if (filled < limit) { buf[filled] = id; filled += 1; }
        }
        offerIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; k++) offerIds[k] = buf[k];
    }

    /// @notice #955 (#921 item 4) — the canonical lifecycle {OfferState} of a
    ///         single offer, with terminal precedence (Accepted > Cancelled >
    ///         ConsumedBySale > Open). Companion to the state-filtered paginated
    ///         views {getOffersByStatePaginated} / {getUserOffersByStatePaginated}
    ///         for the single-id case.
    /// @dev    Promotes the previously-private `_offerStateOf` derivation.
    ///         `getOffer` / `getOfferDetails` return only the raw `Offer` struct,
    ///         so a Scenario-A `offerConsumedBySale` terminal (the sale fill
    ///         closed an UNACCEPTED offer) is invisible there — the row still
    ///         reads open (nonzero creator, not accepted, not expired). This view
    ///         surfaces that terminal directly, so integrators no longer need the
    ///         indirect burned-position-NFT (`ownerOf`-reverts) liveness
    ///         heuristic. A never-existed / cancel-deleted id returns `Cancelled`
    ///         (see the derivation's legacy-compat note); callers that must
    ///         distinguish "never existed" pre-filter via {getGlobalCounts}.
    /// @param  offerId The offer to classify.
    /// @return state   The offer's canonical {OfferState}.
    function getOfferState(uint256 offerId)
        external view returns (LibMetricsTypes.OfferState state)
    {
        return _offerStateOf(LibVaipakam.storageSlot(), offerId);
    }

    // ─── Internal helpers ───────────────────────────────────────────────────

    function _slice(uint256[] storage src, uint256 offset, uint256 limit)
        private
        view
        returns (uint256[] memory out)
    {
        uint256 len = src.length;
        if (offset >= len || limit == 0) return new uint256[](0);
        uint256 end = offset + limit;
        if (end > len) end = len;
        out = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) out[i - offset] = src[i];
    }

    /// @dev #1025 — thin delegate to the hoisted single source of truth
    ///      {LibMetricsTypes.deriveOfferState} (terminal precedence Accepted >
    ///      Cancelled > ConsumedBySale > Open; never-existed → Cancelled). Kept
    ///      as a private wrapper so this facet's internal call sites
    ///      ({getUserOffersByStatePaginated}, {getOffersByStatePaginated},
    ///      {getOfferState}) read unchanged. The derivation body — and its full
    ///      terminal-precedence rationale — now lives in the library so the bulk
    ///      `MetricsDashboardFacet.getOffersWithState` cannot drift from it.
    function _offerStateOf(LibVaipakam.Storage storage s, uint256 offerId)
        private
        view
        returns (LibMetricsTypes.OfferState)
    {
        return LibMetricsTypes.deriveOfferState(s, offerId);
    }

    /// @dev Safe numeraire-quoted valuation. Returns 0 if feed missing or stale.
    function _priceAmount(address asset, uint256 amount) private view returns (uint256) {
        if (asset == address(0) || amount == 0) return 0;
        try OracleFacet(address(this)).getAssetPrice(asset) returns (uint256 price, uint8 decimals) {
            return (amount * price) / (10 ** decimals);
        } catch {
            return 0;
        }
    }

    function _pushUnique(address[] memory arr, uint256 n, address v) private pure returns (uint256) {
        for (uint256 k = 0; k < n; k++) {
            if (arr[k] == v) return n;
        }
        arr[n] = v;
        return n + 1;
    }

    /// @dev Tail-scans `feeEventsLog` summing `numeraireValue` for events
    ///      with `timestamp >= since`. Stops early once an older event is hit
    ///      (log is chronologically append-only). Bounded by
    ///      LibVaipakam.MAX_FEE_EVENTS_ITER.
    function _sumFeesSince(uint256 since) private view returns (uint256 sum) {
        LibVaipakam.FeeEvent[] storage log = LibVaipakam.storageSlot().feeEventsLog;
        uint256 len = log.length;
        uint256 maxIter = LibVaipakam.MAX_FEE_EVENTS_ITER;
        uint256 scanned;
        for (uint256 i = len; i > 0 && scanned < maxIter; ) {
            unchecked { i -= 1; scanned += 1; }
            LibVaipakam.FeeEvent storage ev = log[i];
            if (ev.timestamp < since) break;
            sum += uint256(ev.numeraireValue);
        }
    }

    /// @dev Two-window variant — computes 24h and 7d sums in one tail scan so
    ///      `getTreasuryMetrics` only pays one iteration.
    ///      `since24h >= since7d` (24h window is the tighter one).
    function _sumFeesInWindows(uint256 since24h, uint256 since7d)
        private
        view
        returns (uint256 sum24h, uint256 sum7d)
    {
        LibVaipakam.FeeEvent[] storage log = LibVaipakam.storageSlot().feeEventsLog;
        uint256 len = log.length;
        uint256 maxIter = LibVaipakam.MAX_FEE_EVENTS_ITER;
        uint256 scanned;
        for (uint256 i = len; i > 0 && scanned < maxIter; ) {
            unchecked { i -= 1; scanned += 1; }
            LibVaipakam.FeeEvent storage ev = log[i];
            if (ev.timestamp < since7d) break;
            uint256 v = uint256(ev.numeraireValue);
            sum7d += v;
            if (ev.timestamp >= since24h) sum24h += v;
        }
    }

    // ─── 6. NFT Position Summary (Range Orders Phase 1 follow-up) ──────────

    /// @notice Live snapshot of everything an NFT-holder needs to know about
    ///         the position represented by a Vaipakam position NFT — the
    ///         loan's current state, what's locked in vault against it,
    ///         and what (if anything) is claimable right now.
    /// @dev    Pure view. Consumed by:
    ///           1. `VaipakamNFTFacet.tokenURI` for marketplace metadata
    ///              (OpenSea reads the JSON returned there).
    ///           2. The frontend's NFT verifier UI for a structured render
    ///              that doesn't need to parse JSON.
    ///         Reads from `loan` storage when `loanId != 0` so a partial-
    ///         fill NFT shows the matched principal/rate/collateral, NOT
    ///         the lender offer's range bounds. Pre-Range-Orders the NFT
    ///         derived from `offer.amount`; that's incorrect after PR3-B.
    // forge-lint: disable-next-line(pascal-case-struct)
    struct NFTPositionSummary {
        uint256 tokenId;
        uint256 offerId;
        uint256 loanId;
        bool isLender;
        LibVaipakam.LoanPositionStatus nftStatus;
        LibVaipakam.LoanStatus loanStatus;
        // The realized loan terms (or offer terms for offer-only NFTs,
        // though Phase 1 only mints NFTs at loan-init).
        address principalAsset;
        string principalSymbol;
        uint8 principalDecimals;
        uint256 principalAmount;
        uint256 interestRateBps;
        uint256 durationDays;
        address collateralAsset;
        string collateralSymbol;
        uint8 collateralDecimals;
        uint256 collateralAmount;
        LibVaipakam.AssetType collateralAssetType;
        // Live vault + claim state.
        uint256 collateralLockedNow;     // collateral still in borrower vault against this loan; 0 once claimed/forfeit
        address claimableAsset;          // asset the holder receives at terminal (0x0 if none)
        uint256 claimableAmount;
        bool    isClaimable;             // !claim.claimed && something to claim
        uint256 vpfiHeld;                // borrower-side: still in Diamond custody (Active loans on VPFI path)
        uint256 vpfiRebatePending;       // borrower-side: claimable VPFI after proper close
        // #954 (§2.3) — borrower-side frozen swap-to-repay principal SURPLUS lane
        // (parked in loan.borrower's vault for THIS holder when the holder was
        // sanctioned at the swap-to-repay-full close). A SECOND claimable lane
        // in the principal asset, distinct from the collateral `claimableAmount`
        // above — a claim can owe BOTH. Discoverable here because this view is
        // keyed by the position NFT (current holder), not the stored borrower.
        address surplusClaimAsset;       // principal asset of the frozen surplus (0x0 if none)
        uint256 surplusClaimAmount;      // pending surplus amount; 0 once claimed / none
        uint256 createdAt;               // Unix timestamp from offer.createdAt — display_type "date"
        uint256 chainId;
    }

    /// @notice Full position summary for a Vaipakam position NFT.
    /// @param tokenId Position NFT id (works for both lender + borrower
    ///                NFTs; the `isLender` flag in the return shape
    ///                disambiguates).
    /// @return s     The structured summary; see {NFTPositionSummary}.
    // forge-lint: disable-next-line(mixed-case-function)
    function getNFTPositionSummary(uint256 tokenId)
        external
        view
        returns (NFTPositionSummary memory s)
    {
        LibERC721.ERC721Storage storage es = LibERC721._storage();
        // Reverts when token doesn't exist — same UX as ownerOf.
        if (es.owners[tokenId] == address(0)) revert("NFT does not exist");

        s.tokenId = tokenId;
        s.offerId = es.offerIds[tokenId];
        s.loanId = es.loanIds[tokenId];
        s.isLender = es.isLenderRoles[tokenId];
        s.nftStatus = es.nftStatuses[tokenId];
        s.chainId = block.chainid;

        LibVaipakam.Storage storage vs = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = vs.offers[s.offerId];
        s.createdAt = offer.createdAt;

        // Resolve realized loan terms when a loan exists (the common case
        // since Phase 1 only mints NFTs at loan-init); otherwise fall back
        // to the offer's bounds as a defensive default.
        if (s.loanId != 0) {
            LibVaipakam.Loan storage loan = vs.loans[s.loanId];
            s.loanStatus = loan.status;
            s.principalAsset = loan.principalAsset;
            s.principalAmount = loan.principal;
            s.interestRateBps = loan.interestRateBps;
            s.durationDays = loan.durationDays;
            s.collateralAsset = loan.collateralAsset;
            s.collateralAmount = loan.collateralAmount;
            s.collateralAssetType = loan.collateralAssetType;
        } else {
            s.principalAsset = offer.lendingAsset;
            s.principalAmount = offer.amount;
            s.interestRateBps = offer.interestRateBps;
            s.durationDays = offer.durationDays;
            s.collateralAsset = offer.collateralAsset;
            s.collateralAmount = offer.collateralAmount;
            s.collateralAssetType = offer.collateralAssetType;
        }

        // Symbol + decimals — try/catch each so any non-standard token
        // doesn't block the whole tokenURI render. Falls back to "?" /
        // 18 which is what a marketplace would render anyway for a
        // contract that doesn't implement IERC20Metadata.
        (s.principalSymbol, s.principalDecimals) = _erc20Meta(s.principalAsset);
        if (s.collateralAssetType == LibVaipakam.AssetType.ERC20) {
            (s.collateralSymbol, s.collateralDecimals) = _erc20Meta(s.collateralAsset);
        } else {
            // NFT collateral: surface the contract's name() if available
            // for marketplace display; decimals is a no-op for NFTs.
            s.collateralSymbol = _erc721Name(s.collateralAsset);
            s.collateralDecimals = 0;
        }

        // Claim state — read whichever side this NFT represents.
        if (s.loanId != 0) {
            LibVaipakam.ClaimInfo storage claim = s.isLender
                ? vs.lenderClaims[s.loanId]
                : vs.borrowerClaims[s.loanId];
            s.claimableAsset = claim.asset;
            s.claimableAmount = claim.amount;
            // A claim is actionable when it's been recorded (claim.asset != 0)
            // and not yet collected. Mirrors the gate in claimAsLender /
            // claimAsBorrower; doesn't capture every nuance (heldForLender,
            // rental-NFT-return) but is the right top-line signal for the
            // marketplace card.
            s.isClaimable = claim.asset != address(0) && !claim.claimed;

            // Borrower-side: live vault custody + pending VPFI rebate + the
            // frozen swap-surplus lane (#954 §2.3). Surfaced here so a delisted
            // transferee holder (this NFT's owner) can discover the surplus even
            // though it sits in the STORED borrower's vault and isn't in their
            // `userLoanIds` index.
            if (!s.isLender) {
                LibVaipakam.BorrowerLifRebate storage r =
                    vs.borrowerLifRebate[s.loanId];
                s.vpfiHeld = r.vpfiHeld;
                s.vpfiRebatePending = r.rebateAmount;
                LibVaipakam.ClaimInfo storage sc = vs.borrowerSurplusClaims[s.loanId];
                if (!sc.claimed && sc.amount > 0) {
                    s.surplusClaimAsset = sc.asset;
                    s.surplusClaimAmount = sc.amount;
                    // A pending surplus alone makes the position actionable.
                    s.isClaimable = true;
                }
            }

            // Locked-collateral signal: still in vault against this loan
            // until terminal + claimed/forfeit. Conservative: shows
            // `loan.collateralAmount` while loan is Active or
            // FallbackPending; zero once the loan is in any terminal
            // state (the actual vault accounting at terminal is
            // governed by the swap / claim path and not directly
            // reflected by a single mapping read).
            if (
                s.loanStatus == LibVaipakam.LoanStatus.Active ||
                s.loanStatus == LibVaipakam.LoanStatus.FallbackPending
            ) {
                s.collateralLockedNow = s.collateralAmount;
            }
        }
    }

    /// @dev Best-effort ERC-20 symbol + decimals lookup. Falls back to
    ///      `("?" , 18)` when the asset doesn't implement IERC20Metadata
    ///      (rare on production tokens but possible on bespoke deploys).
    function _erc20Meta(address asset)
        private
        view
        returns (string memory symbol, uint8 decimals)
    {
        if (asset == address(0)) return ("", 18);
        try IERC20Metadata(asset).symbol() returns (string memory s) {
            symbol = s;
        } catch {
            symbol = "?";
        }
        try IERC20Metadata(asset).decimals() returns (uint8 d) {
            decimals = d;
        } catch {
            decimals = 18;
        }
    }

    // ─── #407 (2026-06-12) — Vault encumbrance sub-ledger views ────
    //
    // Public read surface for the per-loan collateral lien + (future)
    // offer-principal lock work. These selectors give the dapp +
    // lenders + auditors an on-chain way to prove "this exact
    // collateral / principal backs this exact loan / offer" and to
    // compute `freeBalance = totalVaultBalance − Σ(activeLiens)`
    // ahead of any withdraw.
    //
    // Hosted on MetricsFacet rather than a dedicated facet so the
    // selector surface lands without registering a new facet (the
    // existing read-only views fit naturally here).
    //
    // See `docs/DesignsAndPlans/PerLoanCollateralLien.md` §3.6
    // (Provability surface) and §7 (offer-principal extension).

    /// @notice Read the collateral lien for `loanId`. Returns an
    ///         empty `Encumbrance` (zero-filled) when no active
    ///         lien exists (loan never existed, was never wired
    ///         through the create hook, or was released on a
    ///         terminal status transition).
    function getLoanCollateralLien(uint256 loanId)
        external
        view
        returns (LibVaipakam.Encumbrance memory)
    {
        return LibVaipakam.storageSlot().loanCollateralLien[loanId];
    }

    /// @notice Read the offer-principal lock for `offerId`. Returns
    ///         an empty `Encumbrance` when no active lock exists.
    ///         Only ERC20 Lender offers can have a non-empty entry
    ///         (the create call sites in
    ///         `OfferCreateFacet._pullCreatorAssetsClassic` will be
    ///         wired in the offer-principal-lock impl PR).
    function getOfferPrincipalLien(uint256 offerId)
        external
        view
        returns (LibVaipakam.Encumbrance memory)
    {
        return LibVaipakam.storageSlot().offerPrincipalLien[offerId];
    }

    /// @notice Sum of every active lien for `(user, asset, tokenId)`.
    ///         The withdraw guard in
    ///         `VaultFactoryFacet.vaultWithdrawERC20` (separate PR)
    ///         consults this same map; reading it directly here
    ///         lets the dapp render "available to withdraw" before
    ///         a tx is composed. ERC20 uses `tokenId = 0`.
    function getEncumbered(address user, address asset, uint256 tokenId)
        external
        view
        returns (uint256)
    {
        return LibVaipakam.storageSlot().encumbered[user][asset][tokenId];
    }

    /// @notice Convenience: `rawBalance − Σ(activeLiens)` (saturating
    ///         at 0). Caller supplies `rawBalance` so this reuses
    ///         across ERC20 / ERC721 / ERC1155 without re-implementing
    ///         the staticcall pattern at every consumer.
    function getFreeBalance(
        address user,
        address asset,
        uint256 tokenId,
        uint256 rawBalance
    ) external view returns (uint256) {
        return LibEncumbrance.freeBalance(user, asset, tokenId, rawBalance);
    }

    /// @dev Best-effort ERC-721 collection name lookup for NFT-collateral
    ///      offers. ERC-721 metadata is optional; falls back to "?".
    function _erc721Name(address asset)
        private
        view
        returns (string memory)
    {
        if (asset == address(0)) return "";
        // Interface signature `name() returns (string)` — same selector
        // as IERC20Metadata.name, which we reuse here to avoid a second
        // import.
        try IERC20Metadata(asset).symbol() returns (string memory s) {
            return s;
        } catch {
            return "?";
        }
    }
}
