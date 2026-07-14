// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibERC721} from "./LibERC721.sol";
import {LibPeriodicInterest} from "./LibPeriodicInterest.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";

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
    /// @notice Pass-2 A1/D5 (#1189) — the targeted loan is still Active but
    ///         PAST its grace window. `RefinanceFacet` blocks a post-grace
    ///         refinance (resolution belongs to DefaultedFacet), so admit this
    ///         mirror at create/accept/match time — otherwise a post-grace
    ///         refinance-tagged offer stays creatable / preview-matchable but
    ///         unfillable (and a direct accept does replacement-loan work before
    ///         the execution gate rolls it back).
    error RefinanceTargetPastGrace();
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

    /// @notice #576 — is this refinance-tagged offer eligible for
    ///         COLLATERAL CARRY-OVER (reuse the old loan's collateral in
    ///         place, no fresh pledge)? True only for the clean case the
    ///         carry-over machinery handles end-to-end:
    ///           1. tagged (`refinanceTargetLoanId != 0`),
    ///           2. NON-transferred — `creator == oldLoan.borrower`, i.e.
    ///              the collateral physically sits in the creator's own
    ///              vault (a transferred position's collateral is in the
    ///              ORIGINAL borrower's vault, so carry-over can't skip the
    ///              deposit there — it falls back to legacy return+pledge),
    ///           3. single-value collateral (`collateralAmountMax` collapses
    ///              to `collateralAmount`) — a borrower range would leave a
    ///              residual the carry-over never deposited,
    ///           4. exact collateral identity (amount + tokenId + quantity)
    ///              vs the old loan — a mismatch couldn't satisfy the
    ///              refinance identity gate, so it must pledge fresh instead,
    ///           5. a LIVE old-loan collateral lien — a no-lien legacy loan
    ///              has nothing to retag.
    ///         This is evaluated ONCE at `createOffer` and PERSISTED on
    ///         `Offer.refinanceCarryOver`; every later collateral-deposit /
    ///         lien / refund / retag site reads that stored flag rather than
    ///         re-deriving this predicate (the target loan's borrower + lien
    ///         are mutable, so re-derivation could diverge from the
    ///         create-time deposit decision). Anything not carry-over
    ///         (untagged, transferred, ranged, mismatched or no-lien) takes
    ///         the ordinary deposit + legacy refinance path unchanged.
    function isCarryOver(
        LibVaipakam.Storage storage s,
        uint256 refinanceTargetLoanId,
        address creator,
        uint256 collateralAmount,
        uint256 collateralAmountMax,
        uint256 collateralTokenId,
        uint256 collateralQuantity
    ) internal view returns (bool) {
        if (refinanceTargetLoanId == 0) return false;
        LibVaipakam.Loan storage loan = s.loans[refinanceTargetLoanId];
        // (2) NON-transferred — the collateral physically sits in the
        // creator's own vault. A transferred position's collateral is in the
        // ORIGINAL borrower's vault, so carry-over can't retag it into the
        // refinancer's; it must take the legacy return+pledge path.
        if (creator != loan.borrower) return false;
        // (3) single-value collateral — a borrower range would leave a
        // residual the carry-over never deposited.
        if (collateralAmountMax != 0 && collateralAmountMax != collateralAmount) {
            return false;
        }
        // (4) #576 Codex P3/P2 — the carried collateral must match the old
        // loan's identity EXACTLY (amount + tokenId + quantity; asset +
        // assetType are checked by {validate} before this runs). A mismatch
        // means the skipped deposit could never satisfy RefinanceFacet's
        // identity gate, so a mismatched offer must take the legacy
        // fresh-pledge path (where any compatible collateral is allowed)
        // rather than be advertised as an unfillable carry-over.
        if (
            collateralAmount != loan.collateralAmount ||
            collateralTokenId != loan.collateralTokenId ||
            collateralQuantity != loan.collateralQuantity
        ) {
            return false;
        }
        // (5) #576 Codex P2 — the old loan's collateral lien must be LIVE to
        // retag. A loan originated before the encumbrance ledger (or otherwise
        // carrying an empty/released lien) has nothing to carry over, so it
        // must pledge fresh collateral via the legacy path instead of skipping
        // a deposit against a lien that doesn't exist.
        LibVaipakam.Encumbrance storage lien =
            s.loanCollateralLien[refinanceTargetLoanId];
        if (lien.user == address(0) || lien.released) return false;
        return true;
    }

    /// @notice #595 — NON-REVERTING match-time admission predicate for a
    ///         carry-over refinance offer. Returns true iff a matched fill of
    ///         `offer` against target `oldLoanId` would survive EVERY
    ///         precondition `RefinanceFacet._refinanceLoanLogic` enforces, so
    ///         `LibOfferMatch.previewMatch` and the on-chain `matchOffers` guard
    ///         admit exactly the pairs the atomic retag would accept — no bot
    ///         false positives, no uncollateralized state. This is the single
    ///         shared source of truth for matched-refinance admission (design
    ///         §3.1 "exhaustive mirror"); the atomic path keeps its own reverting
    ///         checks as the final net.
    /// @dev    `offer.accepted` is intentionally NOT checked — it is a
    ///         match-EXECUTION invariant set during the fill (the dust-close
    ///         flip), not an admission precondition (preview runs pre-accept).
    ///         Mirrors, in order: target Active; no live swap-to-repay intent
    ///         (`assertNoLiveIntentCommit`); auto-refinance kill-switch ON
    ///         (matched fills complete via the keeper-driven retag, so the
    ///         `cfgAutoRefinanceEnabled` gate always applies); period-settlement
    ///         current; creator == current borrower-NFT owner; AON single-value
    ///         with `amount == target outstanding principal`; asset continuity;
    ///         caps fresh + rate/expiry within cap; live carry-over eligibility
    ///         (re-derived, not the create-time snapshot); and the STRICT
    ///         same-key retag possible (mirrors
    ///         `LibEncumbrance.rekeyCollateralLienOnRefinance`'s success key).
    function matchAdmissible(
        LibVaipakam.Storage storage s,
        uint256 oldLoanId,
        LibVaipakam.Offer storage offer
    ) internal view returns (bool) {
        if (oldLoanId == 0) return false;
        if (!offer.refinanceCarryOver) return false;
        if (offer.refinanceTargetLoanId != oldLoanId) return false;
        if (offer.offerType != LibVaipakam.OfferType.Borrower) return false;

        LibVaipakam.Loan storage oldLoan = s.loans[oldLoanId];
        if (oldLoan.status != LibVaipakam.LoanStatus.Active) return false;
        // Pass-2 A1/D5 (#1189) — mirror RefinanceFacet's post-grace block: an
        // overdue (Active-but-past-grace) target is unfillable, so drop it from
        // the match-admissible set instead of previewing an unfillable match.
        if (
            block.timestamp >
            uint256(oldLoan.startTime) +
                uint256(oldLoan.durationDays) * 1 days +
                LibVaipakam.gracePeriod(oldLoan.durationDays)
        ) return false;
        // No live swap-to-repay intent commit on the target (mirror
        // `LibVaipakam.assertNoLiveIntentCommit`).
        if (s.intentCommits[oldLoanId].orderHash != bytes32(0)) return false;
        // Matched fills finish through the keeper-driven retag (msg.sender is the
        // Diamond, not the borrower-NFT owner), so the auto-refinance kill-switch
        // always gates them.
        if (!s.protocolCfg.cfgAutoRefinanceEnabled) return false;
        // Period-settlement must be current (not overdue past grace).
        if (
            oldLoan.periodicInterestCadence !=
            LibVaipakam.PeriodicInterestCadence.None
        ) {
            if (
                block.timestamp >=
                LibPeriodicInterest.settleAllowedFromAt(oldLoan)
            ) return false;
        }
        // Creator must still be the current borrower-position-NFT holder.
        address currentOwner = LibERC721.ownerOf(oldLoan.borrowerTokenId);
        if (offer.creator != currentOwner) return false;
        // AON single-value: amount == amountMax == target outstanding principal.
        uint256 effMax = offer.amountMax == 0 ? offer.amount : offer.amountMax;
        if (offer.amount != effMax) return false;
        if (offer.amount != oldLoan.principal) return false;
        // Asset continuity (inlined to avoid a circular LibOfferMatch import).
        if (
            offer.lendingAsset != oldLoan.principalAsset ||
            offer.collateralAsset != oldLoan.collateralAsset ||
            offer.collateralAssetType != oldLoan.collateralAssetType ||
            offer.prepayAsset != oldLoan.prepayAsset ||
            offer.assetType != LibVaipakam.AssetType.ERC20 ||
            oldLoan.assetType != LibVaipakam.AssetType.ERC20
        ) return false;
        // Auto-refinance caps fresh (setter zero or current owner) +
        // rate/expiry within cap.
        LibVaipakam.AutoRefinanceCaps storage caps =
            s.autoRefinanceCaps[oldLoanId];
        if (
            !caps.enabled ||
            !(caps.setter == address(0) || caps.setter == currentOwner)
        ) return false;
        uint256 offerMaxRate = offer.interestRateBpsMax == 0
            ? offer.interestRateBps
            : offer.interestRateBpsMax;
        if (offerMaxRate > caps.maxRateBps) return false;
        if (
            caps.maxNewExpiry != 0 &&
            block.timestamp + uint256(offer.durationDays) * 1 days >
                uint256(caps.maxNewExpiry)
        ) return false;
        // Live carry-over eligibility (non-transferred + single-value collateral
        // + exact identity + live lien), re-derived rather than trusting the
        // create-time `refinanceCarryOver` snapshot.
        if (
            !isCarryOver(
                s,
                oldLoanId,
                offer.creator,
                offer.collateralAmount,
                offer.collateralAmountMax,
                offer.collateralTokenId,
                offer.collateralQuantity
            )
        ) return false;
        // #595 round-2/3 — the atomic refinance runs the new loan's
        // post-refinance calculateLTV / calculateHealthFactor, which reject any
        // loan whose principal OR collateral liquidity isn't Liquid. Reject a
        // carry-over target with a non-liquid principal or collateral up front so
        // preview never admits a match the atomic path would revert (a manually
        // enrolled loan can carry illiquid ERC20 / NFT collateral, and either
        // asset can lose its liquidity/depth after origination).
        if (
            OracleFacet(address(this)).checkLiquidity(offer.collateralAsset) !=
            LibVaipakam.LiquidityStatus.Liquid ||
            OracleFacet(address(this)).checkLiquidity(offer.lendingAsset) !=
            LibVaipakam.LiquidityStatus.Liquid
        ) return false;
        // STRICT same-key retag must be possible — mirror
        // `rekeyCollateralLienOnRefinance`'s success key against the replacement
        // loan (borrower = currentOwner, collateral = the offer's). The lien's
        // `amount` is ENCODED by collateral type exactly as `LibEncumbrance`
        // stores it: 1 for ERC721, `collateralQuantity` for ERC1155, else the
        // ERC20 `collateralAmount` (which is structurally 0 for NFT collateral),
        // so compare against the encoded value, not the raw `collateralAmount`.
        uint256 expectedLienAmount;
        if (offer.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            expectedLienAmount = 1;
        } else if (
            offer.collateralAssetType == LibVaipakam.AssetType.ERC1155
        ) {
            expectedLienAmount = offer.collateralQuantity;
        } else {
            expectedLienAmount = offer.collateralAmount;
        }
        LibVaipakam.Encumbrance storage lien = s.loanCollateralLien[oldLoanId];
        if (
            lien.released ||
            lien.user != currentOwner ||
            lien.asset != offer.collateralAsset ||
            lien.tokenId != offer.collateralTokenId ||
            lien.amount != expectedLienAmount ||
            lien.assetType != offer.collateralAssetType
        ) return false;
        return true;
    }

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
        // Pass-2 A1/D5 (#1189) — mirror RefinanceFacet's post-grace block here so
        // a refinance-tagged offer against an overdue (Active-but-past-grace)
        // target fails fast at create/accept instead of being admitted and then
        // reverted after the replacement-loan work.
        if (
            block.timestamp >
            uint256(loan.startTime) +
                uint256(loan.durationDays) * 1 days +
                LibVaipakam.gracePeriod(loan.durationDays)
        ) {
            revert RefinanceTargetPastGrace();
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
