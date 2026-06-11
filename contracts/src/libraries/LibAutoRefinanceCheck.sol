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
        uint256 offerDurationDays
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
