// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibERC721} from "./LibERC721.sol";

/**
 * @title  LibAutoRefinanceCheck
 * @notice T-092 Phase 2b (#506) — shared cap-enforcement helper for
 *         offers tagged with a `refinanceTargetLoanId`. Used at BOTH
 *         `OfferCreateFacet.createOffer` AND
 *         `OfferAcceptFacet._acceptOffer` so the borrower's per-loan
 *         `autoRefinanceCaps[loanId]` consent surface binds BEFORE the
 *         replacement loan is created — closing the Phase 2 timing
 *         hole Codex flagged on PR #504 (caps at refinance time bound
 *         too late because the new loan already exists).
 *
 * @dev    Factored into a library so it can be reused by both facets
 *         without inlining the read into the call sites' bytecode.
 *         Each facet only emits the three-slot storage read + the
 *         couple of comparisons.
 */
library LibAutoRefinanceCheck {
    /// @notice The targeted loan is not Active (zeroed-out, already
    ///         repaid/defaulted/settled). A refinance-tagged offer
    ///         must point at a live loan or it has nothing to refinance.
    error RefinanceTargetNotActive();
    /// @notice The offer creator is not the current borrower-NFT
    ///         owner of the targeted loan. Catches both
    ///         (a) malicious offer-create attempts by non-borrowers, and
    ///         (b) the NFT-transfer staleness case at accept time when
    ///         the borrower sold the position between create + accept.
    error RefinanceTargetNotBorrower();
    /// @notice Borrower has not set caps on this loan (caps.enabled
    ///         == false) OR the caps were set by a previous NFT owner
    ///         (staleness fence). The new owner must explicitly re-set
    ///         caps to re-enable refinance-tagged offers against this
    ///         loan.
    error RefinanceCapsRequired();
    /// @notice The new offer's max rate exceeds the borrower's
    ///         pre-approved `autoRefinanceCaps.maxRateBps`.
    error RefinanceRateExceedsCap();
    /// @notice The new loan's implied end time exceeds the borrower's
    ///         pre-approved `autoRefinanceCaps.maxNewExpiry`.
    error RefinanceExpiryExceedsCap();
    /// @notice Codex round-1 P2 — the targeted old loan isn't
    ///         refinance-compatible: NFT-rental loan (Refinance only
    ///         supports ERC20), or the new offer's lending /
    ///         collateral asset doesn't match the old loan's, or
    ///         the offer's `amountMax` can't cover the old loan's
    ///         principal. Failing fast at create rejects the offer
    ///         BEFORE a lender can be enticed into accepting it
    ///         (and getting the principal stranded mid-refinance).
    error RefinanceTargetIncompatible();

    /// @notice Validate that the offer creator + terms satisfy the
    ///         per-loan auto-refinance caps stored under
    ///         `autoRefinanceCaps[loanId]`. Caller resolves the
    ///         offer creator (= `msg.sender` at create time, or the
    ///         already-stored `offer.creator` at accept time).
    /// @param  s              Storage slot pointer.
    /// @param  loanId         The targeted loan id (from
    ///                        `offer.refinanceTargetLoanId`).
    /// @param  offerCreator   The offer's creator address.
    /// @param  offerMaxRate   The offer's `interestRateBpsMax`
    ///                        (collapsed to `interestRateBps` if 0 —
    ///                        caller handles that collapse).
    /// @param  offerDurationDays The offer's `durationDays`.
    function validate(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address offerCreator,
        uint256 offerMaxRate,
        uint256 offerDurationDays,
        address offerLendingAsset,
        address offerCollateralAsset,
        LibVaipakam.AssetType offerAssetType,
        LibVaipakam.AssetType offerCollateralAssetType,
        address offerPrepayAsset,
        uint256 offerMinAmount,
        uint256 offerMaxAmount
    ) internal view {
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) {
            revert RefinanceTargetNotActive();
        }
        // Bind identity to the CURRENT NFT owner — not `loan.borrower`
        // (the original at init). Matches the staleness fence pattern
        // used by AutoLifecycleFacet's per-loan cap getters.
        address currentBorrowerNftOwner =
            LibERC721.ownerOf(loan.borrowerTokenId);
        if (currentBorrowerNftOwner != offerCreator) {
            revert RefinanceTargetNotBorrower();
        }
        // Codex round-1 P2 — fail-fast on refinance-incompatible
        // targets so a refinance-tagged offer can't pass create,
        // attract a lender, and then strand the principal when
        // `RefinanceFacet.refinanceLoan` rejects the mismatched
        // shape. NFT-rental refinance is out of scope (Refinance
        // gates on `loan.assetType == ERC20`); the asset pair must
        // match the old loan's; the offer's amountMax must cover
        // the old loan's principal.
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            revert RefinanceTargetIncompatible();
        }
        // Codex round-2 P2 — collateral CONTRACT match alone isn't
        // enough: an NFT contract can also serve as an ERC20-typed
        // declaration in a refinance-tagged offer. Verify the asset
        // TYPE matches too so a refinance-tagged offer can't sneak
        // an NFT-collateralised loan past as ERC20 (or vice-versa).
        // Codex round-3 P2 — also require the new offer's principal
        // assetType == ERC20. The old-loan-ERC20 check above only
        // proves the OLD principal; without this guard, a hybrid
        // contract that satisfies both branches could let a
        // refinance-tagged ERC721 offer slip through.
        // Codex round-3 P2 — prepayAsset must also match. The
        // RefinanceFacet later routes prepay-asset flows via
        // `LibOfferMatch.assertAssetContinuity`; a mismatch would
        // surface as a delayed refinance failure with the new loan
        // already created.
        if (
            offerLendingAsset != loan.principalAsset ||
            offerCollateralAsset != loan.collateralAsset ||
            offerCollateralAssetType != loan.collateralAssetType ||
            offerAssetType != LibVaipakam.AssetType.ERC20 ||
            offerPrepayAsset != loan.prepayAsset
        ) {
            revert RefinanceTargetIncompatible();
        }
        // Codex round-2 P2 — RefinanceFacet's later check is
        // `offer.amount <= oldLoan.principal <= offer.amountMax`.
        // Both bounds must be on the right side of the old principal,
        // otherwise the refinance-tagged offer can be accepted but
        // can never satisfy the refinance path.
        if (
            offerMinAmount > loan.principal || offerMaxAmount < loan.principal
        ) {
            revert RefinanceTargetIncompatible();
        }
        LibVaipakam.AutoRefinanceCaps storage caps =
            s.autoRefinanceCaps[loanId];
        bool capsFresh =
            caps.setter == address(0) || caps.setter == currentBorrowerNftOwner;
        if (!caps.enabled || !capsFresh) revert RefinanceCapsRequired();
        if (offerMaxRate > caps.maxRateBps) revert RefinanceRateExceedsCap();
        // Compute the worst-case end time the new loan could have if
        // accepted right now: `block.timestamp + durationDays * 1 days`.
        // At create-time this is conservative (the loan starts later);
        // at accept-time this is exact (start = block.timestamp).
        // Either way, validating against the cap on the conservative
        // end-time gives the borrower the safety they consented to.
        uint256 worstCaseEndTime = block.timestamp + offerDurationDays * 1 days;
        if (
            caps.maxNewExpiry != 0 &&
            worstCaseEndTime > uint256(caps.maxNewExpiry)
        ) {
            revert RefinanceExpiryExceedsCap();
        }
    }
}
