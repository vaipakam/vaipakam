// src/facets/MetricsFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

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
     * @return tvlInNumeraire Sum of `principalNumeraireLocked` + `erc20CollateralTVL`.
     * @return erc20CollateralTVL Numeraire-quoted value of ERC-20 collateral on active loans.
     * @return nftCollateralTVL NFT collateral is priced at $0 (no on-chain oracle);
     *         returns the COUNT of active loans with NFT collateral instead.
     */
    function getProtocolTVL()
        external
        view
        returns (uint256 tvlInNumeraire, uint256 erc20CollateralTVL, uint256 nftCollateralTVL)
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
                erc20CollateralTVL += _priceAmount(l.collateralAsset, l.collateralAmount);
            } else {
                nftCount += 1;
            }
        }
        tvlInNumeraire = principalNumeraire + erc20CollateralTVL;
        nftCollateralTVL = nftCount;
    }

    /**
     * @notice Protocol-wide aggregate counters and rate summaries.
     * @dev Counter-backed fields (`totalUniqueUsers`, `activeLoansCount`,
     *      `activeOffersCount`, `totalLoansEverCreated`, `defaultRateBps`,
     *      `averageAPR`) resolve to single SLOADs — O(1). `totalVolumeLentNumeraire`
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
            uint256 averageAPR
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
        averageAPR = totalLoansEverCreated == 0 ? 0 : s.interestRateBpsSum / totalLoansEverCreated;

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
            treasuryBalanceNumeraire += _priceAmount(assets[k], s.treasuryBalances[assets[k]]);
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

    /**
     * @notice Aggregate summary across active loans.
     * @return totalActiveLoanValueNumeraire Sum of priced principal across ERC-20 loans.
     * @return averageLoanDuration Simple mean of durationDays across active loans.
     * @return averageLTV Simple mean of per-loan LTV (bps) via RiskFacet; 0 for NFT legs.
     */
    function getLoanSummary()
        external
        view
        returns (
            uint256 totalActiveLoanValueNumeraire,
            uint256 averageLoanDuration,
            uint256 averageLTV
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
        averageLTV = ltvCount == 0 ? 0 : ltvSum / ltvCount;
    }

    // ─── 4. NFT & Escrow Metrics ────────────────────────────────────────────

    /**
     * @notice NFT/escrow activity summary. Iterates the active-loan list
     *         (bounded by `activeLoansCount`). A "rental" here is any
     *         active loan whose principal (lending) asset is an NFT.
     *         `totalRentalVolumeNumeraire` is the current-term
     *         numeraire-quoted price of each active rental's principal where
     *         the `prepayAsset` has a live feed.
     */
    function getEscrowStats()
        external
        view
        returns (
            uint256 totalNFTsInEscrow,
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
                totalNFTsInEscrow += 1;
            }
            if (l.collateralAssetType != LibVaipakam.AssetType.ERC20) {
                totalNFTsInEscrow += 1;
            }
        }
    }

    /// @notice Loan corresponding to a rented Vaipakam position NFT.
    /// @dev O(1): resolves via `loanIdByPositionTokenId` reverse mapping
    ///      maintained by LibMetricsHooks. Returns empty Loan when the
    ///      position is not an NFT-rental leg or no longer active.
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
    ///         Counter-backed via `nftsInEscrowByCollection` — O(1).
    function getTotalNFTsInEscrowByCollection(address collection) external view returns (uint256) {
        return LibVaipakam.storageSlot().nftsInEscrowByCollection[collection];
    }

    // ─── 6. User-Specific Metrics ───────────────────────────────────────────

    /**
     * @notice Per-user position summary.
     * @dev Iterates `activeLoanIdsList` filtered by the user — bounded by
     *      `activeLoansCount`, not lifetime loan count. `healthFactor` returned
     *      is the MINIMUM HF across the user's borrower-side active loans
     *      (worst-case). If the user has no borrower legs, returns
     *      `type(uint256).max` (i.e. infinitely safe).
     *      `availableToClaimNumeraire` currently returns 0 — claim valuations
     *      require ClaimInfo iteration with per-asset pricing beyond the
     *      scope of this snapshot; integrators should call
     *      `ClaimFacet.getClaimable` per loan.
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
        uint256[] storage active = s.activeLoanIdsList;
        uint256 len = active.length;
        uint256 minHF = type(uint256).max;
        bool anyBorrow;
        for (uint256 i = 0; i < len; i++) {
            LibVaipakam.Loan storage l = s.loans[active[i]];
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
                        if (hf < minHF) minHF = hf;
                    } catch { }
                }
            }
        }
        healthFactor = anyBorrow ? minHF : type(uint256).max;
        availableToClaimNumeraire = 0;
    }

    /// @notice Active loan IDs where `user` is lender or borrower.
    /// @dev O(activeLoansCount) — iterates the active-loan list rather than
    ///      the lifetime sequence. For historical loans, use
    ///      {getUserLoansPaginated} or {getUserLoansByStatusPaginated}.
    function getUserActiveLoans(address user) external view returns (uint256[] memory loanIds) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage active = s.activeLoanIdsList;
        uint256 len = active.length;
        uint256[] memory buf = new uint256[](len);
        uint256 n;
        for (uint256 i = 0; i < len; i++) {
            uint256 id = active[i];
            LibVaipakam.Loan storage l = s.loans[id];
            if (l.lender == user || l.borrower == user) { buf[n] = id; n += 1; }
        }
        loanIds = new uint256[](n);
        for (uint256 k = 0; k < n; k++) loanIds[k] = buf[k];
    }

    /// @notice Open offer IDs created by `user`.
    /// @dev O(activeOffersCount) — iterates the active-offer list.
    function getUserActiveOffers(address user) external view returns (uint256[] memory offerIds) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage active = s.activeOfferIdsList;
        uint256 len = active.length;
        uint256[] memory buf = new uint256[](len);
        uint256 n;
        for (uint256 i = 0; i < len; i++) {
            uint256 id = active[i];
            LibVaipakam.Offer storage o = s.offers[id];
            if (o.creator == user) { buf[n] = id; n += 1; }
        }
        offerIds = new uint256[](n);
        for (uint256 k = 0; k < n; k++) offerIds[k] = buf[k];
    }

    /**
     * @notice Token IDs of Vaipakam position NFTs representing NFT-asset legs
     *         that currently belong to `user`.
     * @dev O(activeLoansCount) — iterates the active-loan list. Does not
     *      reach into per-user escrow proxies.
     */
    function getUserNFTsInEscrow(address user) external view returns (uint256[] memory tokenIds) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256[] storage active = s.activeLoanIdsList;
        uint256 len = active.length;
        uint256[] memory buf = new uint256[](len * 2);
        uint256 n;
        for (uint256 i = 0; i < len; i++) {
            LibVaipakam.Loan storage l = s.loans[active[i]];
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
    enum OfferState { Open, Accepted, Cancelled }

    /**
     * @notice Paginated slice of the user's offers filtered by lifecycle state.
     */
    function getUserOffersByStatePaginated(
        address user,
        OfferState state,
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
            OfferState actual = _offerStateOf(s, id);
            if (actual != state) continue;
            matched += 1;
            if (skipped < offset) { skipped += 1; continue; }
            if (filled < limit) { buf[filled] = id; filled += 1; }
        }
        offerIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; k++) offerIds[k] = buf[k];
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
            if (s.offers[id].id == 0 && !s.offerCancelled[id]) continue;
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
        OfferState state,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory offerIds, uint256 matched) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 end = s.nextOfferId;
        uint256[] memory buf = new uint256[](limit);
        uint256 skipped;
        uint256 filled;
        for (uint256 id = 1; id <= end; id++) {
            OfferState actual = _offerStateOf(s, id);
            if (actual != state) continue;
            matched += 1;
            if (skipped < offset) { skipped += 1; continue; }
            if (filled < limit) { buf[filled] = id; filled += 1; }
        }
        offerIds = new uint256[](filled);
        for (uint256 k = 0; k < filled; k++) offerIds[k] = buf[k];
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

    /// @dev Derives the {OfferState} of `offerId` from storage. Matches the
    ///      terminal flags set by {OfferFacet.acceptOffer} (accepted) and
    ///      {OfferFacet.cancelOffer} (offerCancelled). Never-existed IDs
    ///      also return Cancelled — callers filter via
    ///      {getGlobalCounts}/{getAllOffersPaginated} before reading state.
    function _offerStateOf(LibVaipakam.Storage storage s, uint256 offerId)
        private
        view
        returns (OfferState)
    {
        if (s.offerCancelled[offerId]) return OfferState.Cancelled;
        LibVaipakam.Offer storage o = s.offers[offerId];
        if (o.id == 0) return OfferState.Cancelled; // treated as non-matchable
        if (o.accepted) return OfferState.Accepted;
        return OfferState.Open;
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
    ///         loan's current state, what's locked in escrow against it,
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
        // Live escrow + claim state.
        uint256 collateralLockedNow;     // collateral still in borrower escrow against this loan; 0 once claimed/forfeit
        address claimableAsset;          // asset the holder receives at terminal (0x0 if none)
        uint256 claimableAmount;
        bool    isClaimable;             // !claim.claimed && something to claim
        uint256 vpfiHeld;                // borrower-side: still in Diamond custody (Active loans on VPFI path)
        uint256 vpfiRebatePending;       // borrower-side: claimable VPFI after proper close
        uint256 createdAt;               // Unix timestamp from offer.createdAt — display_type "date"
        uint256 chainId;
    }

    /// @notice Full position summary for a Vaipakam position NFT.
    /// @param tokenId Position NFT id (works for both lender + borrower
    ///                NFTs; the `isLender` flag in the return shape
    ///                disambiguates).
    /// @return s     The structured summary; see {NFTPositionSummary}.
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

            // Borrower-side: live escrow custody + pending VPFI rebate.
            if (!s.isLender) {
                LibVaipakam.BorrowerLifRebate storage r =
                    vs.borrowerLifRebate[s.loanId];
                s.vpfiHeld = r.vpfiHeld;
                s.vpfiRebatePending = r.rebateAmount;
            }

            // Locked-collateral signal: still in escrow against this loan
            // until terminal + claimed/forfeit. Conservative: shows
            // `loan.collateralAmount` while loan is Active or
            // FallbackPending; zero once the loan is in any terminal
            // state (the actual escrow accounting at terminal is
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
