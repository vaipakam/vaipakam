// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/// @title LibMetricsHooks
/// @notice Central bookkeeping for the MetricsFacet O(1) counter / active-set
///         index layer. Every loan/offer lifecycle edge that affects analytics
///         routes through one of the hook entry points here — no facet writes
///         to the counter storage directly.
///
/// @dev Hook coverage (must stay exhaustive):
///        • {onLoanInitialized}     — called from LoanFacet after the loan
///          struct is fully populated (lender, borrower, asset fields all set).
///        • {onLoanStatusChanged}   — called from LibLifecycle.transition /
///          transitionFromAny for every status edge. FallbackPending ↔ Active
///          is a no-op for counts because both states are "active" under
///          MetricsFacet._isActive.
///        • {onOfferCreated}        — called from OfferFacet.createOffer once
///          the offer struct is populated.
///        • {onOfferAccepted}       — called from OfferFacet.acceptOffer,
///          PrecloseFacet acceptance, and EarlyWithdrawalFacet acceptance.
///        • {onOfferCancelled}      — called from OfferFacet.cancelOffer.
///
/// @dev Active-set indices use the swap-and-pop pattern with a 1-based position
///      map so a stored `0` unambiguously means "not in the list." List
///      mutations are O(1); enumeration is O(results).
///
/// @dev Migration: if this library is introduced on a diamond that already
///      holds live loans/offers, the counters will reflect only NEW activity
///      until a one-time backfill runs. Pre-mainnet deployments are unaffected.
library LibMetricsHooks {
    // ───────────────────────── Loan hooks ─────────────────────────

    /// @notice Registers a freshly-created loan in every analytics index.
    /// @dev Call from LoanFacet after the loan struct has been fully
    ///      populated (lender, borrower, asset fields, tokenIds). Safe to
    ///      call exactly once per loan id.
    function onLoanInitialized(LibVaipakam.Loan storage loan) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 id = loan.id;

        s.activeLoansCount += 1;
        s.totalLoansEverCreated += 1;
        s.interestRateBpsSum += loan.interestRateBps;

        // Active-set list for O(results) global enumeration.
        s.activeLoanIdsList.push(id);
        s.activeLoanIdsListPos[id] = s.activeLoanIdsList.length; // 1-based

        // Unique-user tracking — both sides counted exactly once across
        // all their lifetime activity (offers + loans).
        _markUserSeen(s, loan.lender);
        _markUserSeen(s, loan.borrower);

        // Per-collection NFT escrow counts (active legs only).
        if (
            loan.assetType != LibVaipakam.AssetType.ERC20 &&
            loan.principalAsset != address(0)
        ) {
            s.nftsInEscrowByCollection[loan.principalAsset] += 1;
        }
        if (
            loan.collateralAssetType != LibVaipakam.AssetType.ERC20 &&
            loan.collateralAsset != address(0)
        ) {
            s.nftsInEscrowByCollection[loan.collateralAsset] += 1;
        }

        // Position NFT → loan id reverse mapping (O(1) NFT-rental lookup).
        if (loan.lenderTokenId != 0) s.loanIdByPositionTokenId[loan.lenderTokenId] = id;
        if (loan.borrowerTokenId != 0) s.loanIdByPositionTokenId[loan.borrowerTokenId] = id;
    }

    /// @notice Updates counters and the active-set list for a loan status edge.
    /// @dev Called by LibLifecycle on every transition. Uses the legal-edge
    ///      invariant: Active ↔ FallbackPending preserves "active", every
    ///      other transition either enters or leaves the active set.
    function onLoanStatusChanged(
        LibVaipakam.Loan storage loan,
        LibVaipakam.LoanStatus from,
        LibVaipakam.LoanStatus to
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 id = loan.id;

        bool wasActive = _isActive(from);
        bool isActive = _isActive(to);

        if (wasActive && !isActive) {
            // Loan exits the active set → decrement count, swap-pop, and
            // release per-collection NFT counts for any NFT legs.
            if (s.activeLoansCount > 0) s.activeLoansCount -= 1;
            _removeFromActiveLoanList(s, id);

            if (
                loan.assetType != LibVaipakam.AssetType.ERC20 &&
                loan.principalAsset != address(0) &&
                s.nftsInEscrowByCollection[loan.principalAsset] > 0
            ) {
                s.nftsInEscrowByCollection[loan.principalAsset] -= 1;
            }
            if (
                loan.collateralAssetType != LibVaipakam.AssetType.ERC20 &&
                loan.collateralAsset != address(0) &&
                s.nftsInEscrowByCollection[loan.collateralAsset] > 0
            ) {
                s.nftsInEscrowByCollection[loan.collateralAsset] -= 1;
            }
        }

        // terminalBadOrSettledCount tracks the "defaulted or settled" set
        // that MetricsFacet.getProtocolStats' defaultRateBps consumes. Only
        // the transition INTO the set counts — Defaulted → Settled stays
        // within the set and must not double-count.
        bool wasTerminal = from == LibVaipakam.LoanStatus.Defaulted ||
            from == LibVaipakam.LoanStatus.Settled;
        bool isTerminal = to == LibVaipakam.LoanStatus.Defaulted ||
            to == LibVaipakam.LoanStatus.Settled;
        if (!wasTerminal && isTerminal) {
            s.terminalBadOrSettledCount += 1;
        }
    }

    // ───────────────────────── Offer hooks ────────────────────────

    /// @notice Registers a newly-created offer in the active-offer index.
    function onOfferCreated(LibVaipakam.Offer storage offer) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 id = offer.id;

        s.activeOffersCount += 1;
        s.activeOfferIdsList.push(id);
        s.activeOfferIdsListPos[id] = s.activeOfferIdsList.length;

        _markUserSeen(s, offer.creator);
    }

    /// @notice Removes an offer from the active-offer index when accepted.
    /// @dev Idempotent — a re-entry via a second acceptance path is a no-op.
    function onOfferAccepted(uint256 offerId) internal {
        _removeFromActiveOfferList(LibVaipakam.storageSlot(), offerId);
    }

    /// @notice Removes an offer from the active-offer index when cancelled.
    function onOfferCancelled(uint256 offerId) internal {
        _removeFromActiveOfferList(LibVaipakam.storageSlot(), offerId);
    }

    // ───────────────────────── Internal helpers ───────────────────

    function _isActive(LibVaipakam.LoanStatus st) private pure returns (bool) {
        return
            st == LibVaipakam.LoanStatus.Active ||
            st == LibVaipakam.LoanStatus.FallbackPending;
    }

    function _markUserSeen(LibVaipakam.Storage storage s, address u) private {
        if (u == address(0) || s.userSeen[u]) return;
        s.userSeen[u] = true;
        s.uniqueUserCount += 1;
    }

    /// @dev Swap-and-pop removal from `activeLoanIdsList`. Position map is
    ///      1-based; a stored 0 means "not present."
    function _removeFromActiveLoanList(
        LibVaipakam.Storage storage s,
        uint256 id
    ) private {
        uint256 pos = s.activeLoanIdsListPos[id]; // 1-based
        if (pos == 0) return; // not in list
        uint256 lastIdx = s.activeLoanIdsList.length - 1;
        uint256 idx = pos - 1;
        if (idx != lastIdx) {
            uint256 tail = s.activeLoanIdsList[lastIdx];
            s.activeLoanIdsList[idx] = tail;
            s.activeLoanIdsListPos[tail] = pos;
        }
        s.activeLoanIdsList.pop();
        delete s.activeLoanIdsListPos[id];
    }

    function _removeFromActiveOfferList(
        LibVaipakam.Storage storage s,
        uint256 id
    ) private {
        uint256 pos = s.activeOfferIdsListPos[id];
        if (pos == 0) return;
        uint256 lastIdx = s.activeOfferIdsList.length - 1;
        uint256 idx = pos - 1;
        if (idx != lastIdx) {
            uint256 tail = s.activeOfferIdsList[lastIdx];
            s.activeOfferIdsList[idx] = tail;
            s.activeOfferIdsListPos[tail] = pos;
        }
        s.activeOfferIdsList.pop();
        delete s.activeOfferIdsListPos[id];

        if (s.activeOffersCount > 0) s.activeOffersCount -= 1;
    }
}
