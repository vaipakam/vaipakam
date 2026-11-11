// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibRefinanceRequest} from "../libraries/LibRefinanceRequest.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibTiming} from "../libraries/LibTiming.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {InteractionRewardsFacet} from "./InteractionRewardsFacet.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibInterestLedger} from "../libraries/LibInterestLedger.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OfferCreateFacet} from "./OfferCreateFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {LibPreclose} from "../libraries/LibPreclose.sol";

/**
 * @title PrecloseOffsetFacet
 * @author Vaipakam Developer Team
 * @notice The borrower's offset route out of a loan (Option 3 of the early
 *         close): the borrower posts a new lender offer that offsets the
 *         loan ({offsetWithNewOffer}), and once a new borrower accepts it the
 *         original loan closes ({completeOffset}, or
 *         {completeOffsetInternal}, which `_acceptOffer` reaches through a
 *         self-call when a third party accepts the offset offer).
 * @dev    Split out of {PrecloseFacet} (#3410), which had run out of
 *         EIP-170 room, along the route boundary that was already there: the
 *         offset route shares no entry point with the direct preclose or the
 *         obligation handover, and its completion was already reached across
 *         the Diamond by selector. Same storage, same Diamond, same selectors
 *         and call surface; only the runtime bytecode is separate. The steps
 *         both facets take (who may act, the payment asset, the lender
 *         yield-fee discount, the renter reset, the position marking) live
 *         once in {LibPreclose}. **Refreshed together with PrecloseFacet**:
 *         the early-close routes are one behaviour, and refreshing either
 *         alone runs part of it on pre-split code.
 *         Reentrancy-guarded, pausable; supports ERC-20 loans and NFT rentals.
 */
contract PrecloseOffsetFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    // ─── Events ──────────────────────────────────────────────────────────────

    /// @custom:event-category state-change/offer-mutation
    event OffsetOfferCreated(
        uint256 indexed originalLoanId,
        uint256 indexed newOfferId,
        address indexed borrower,
        uint256 shortfallPaid
    );

    /// @param newStatus The original loan's `LoanStatus` after offset
    ///        completion — always `Repaid` (1). Carried explicitly so an
    ///        indexer flips status from the payload rather than inferring
    ///        it from the event name (uniform with `LoanRepaid.newStatus`,
    ///        `LoanDefaulted.newStatus`).
    /// @custom:event-category state-change/loan-mutation
    event OffsetCompleted(
        uint256 indexed originalLoanId,
        uint256 indexed newOfferId,
        address indexed borrower,
        uint8 newStatus
    );

    // ─── Errors ──────────────────────────────────────────────────────────────

    // Facet-specific errors (shared errors inherited from IVaipakamErrors).
    // Same names as PrecloseFacet's, so the same selectors.
    error InvalidOfferTerms();
    error InsufficientCollateral();
    error OffsetNotLinked();
    error OffsetOfferNotAccepted();
    /// @dev Pass-2 A1/D5 (#1189) — the offset completion blocks strictly past
    ///      the grace window, matching {RepayFacet.repayLoan}; post-grace
    ///      resolution goes through DefaultedFacet.
    error RepaymentPastGracePeriod();
    /// #1001 (S3) — a loan may have at most ONE live offset offer at a time.
    /// A second `offsetWithNewOffer` while `loanToOffsetOfferId[loanId] != 0`
    /// would prepay the old lender a SECOND `heldForLender` slice (monotone
    /// accumulator), so it is rejected until the first offer is completed or
    /// cancelled (which clears the link + unwinds the prepay).
    error OffsetAlreadyActive();
    /// #1001 (S3, Codex #1070) — an offset can't be opened while a lender sale
    /// listing (`loanToSaleOfferId`) is live on the same loan; the two close-out
    /// flows would race and leave one vehicle stale. Symmetric to
    /// `EarlyWithdrawalFacet.OffsetActiveOnLoan`.
    error SaleListingActiveOnLoan();

    /// @dev The maturity/grace gate of the offset completion, the same as
    ///      PrecloseFacet's for the direct preclose: reverts strictly past the
    ///      effective grace end ({LibLoanClock.graceEnd}).
    function _assertWithinGrace(LibVaipakam.Loan storage loan) private view {
        if (block.timestamp > LibLoanClock.graceEnd(loan)) {
            revert RepaymentPastGracePeriod();
        }
    }

    // ─── Option 3: Offset with New Lender Offer (two-step) ─────────────────

    /**
     * @notice Step 1: Creates a lender offer to offset the original loan (Option 3).
     * @dev WARNING — front-ends MUST surface this to the caller before they
     *      sign: the borrower-side position NFT for `loanId` is NATIVELY
     *      LOCKED against transfer/approve from the moment this call
     *      succeeds. The lock persists until either {completeOffset}
     *      (successful completion) or {OfferFacet.cancelOffer} (initiator
     *      cancels the linked offset offer) releases it. During that
     *      window the holder cannot list, sell, transfer, or approve the
     *      NFT on any marketplace. See LibPositionNFT.RouteReason.PrecloseOffset.
     *
     *      Per README Section 8, Option 3:
     *      - alice deposits principal and creates a Lender Offer via OfferFacet.
     *      - alice pays accrued interest (treasury fee + lender share) to lender's vault.
     *      - Shortfall (expected interest difference) is pre-paid to lender's vault.
     *      - The new offer is linked to the original loan via offsetOfferToLoanId.
     *      - When a new borrower (charlie) accepts the offer normally, call completeOffset()
     *        to release alice's collateral and close the original loan.
     * @param loanId The original loan ID to offset.
     * @param interestRateBps The interest rate for alice's new lender offer.
     * @param durationDays The duration for the new offer (<= remaining).
     * @param collateralAsset The collateral asset for the new offer (can match original).
     * @param collateralAmount The collateral amount required from the new borrower.
     * @param creatorRiskAndTermsConsent Consent for illiquid assets in new offer.
     * @param prepayAsset Prepay asset for NFT loans (address(0) for ERC20).
     * @param validUntil The caller's MANDATORY transaction deadline (#3412):
     *        an offset posts a new offer and pays the shortfall at the moment
     *        it lands, so it is price-exposed and one landing after this
     *        reverts.
     * @return newOfferId The ID of the newly created offset lender offer.
     */
    function offsetWithNewOffer(
        uint256 loanId,
        uint256 interestRateBps,
        uint256 durationDays,
        address collateralAsset,
        uint256 collateralAmount,
        bool creatorRiskAndTermsConsent,
        address prepayAsset,
        uint64 validUntil
    ) external nonReentrant whenNotPaused returns (uint256 newOfferId) {
        LibTiming.requireDeadline(validUntil);
        // T-090 v1.1 (#389) §5.8 — offset writes a new offer that
        // settles against `loan.collateralAmount`; same custody-
        // conflict rationale as the other PrecloseFacet entry
        // points.
        LibVaipakam.assertNoLiveIntentCommit(loanId);
        // #2407 — refused while a live refinance request targets the loan.
        LibRefinanceRequest.assertNone(loanId);
        // #1001 (S3, Codex #1070 r6 P2) — Tier-1 caller screen. This creates and
        // funds an offset offer as the borrower-NFT holder (not msg.sender), so
        // `createOfferInternal`'s create-time screen only catches the borrower
        // holder. A keeper approved before being sanctioned could otherwise still
        // trigger the delegated creation and move the clean borrower's approved
        // funds — the sibling entry points (`precloseDirect`,
        // `transferObligationViaOffer`) all screen the caller here, so match them.
        LibVaipakam._assertNotSanctioned(msg.sender);
        // Cache the storage pointer once (EIP-170: PrecloseFacet is size-tight —
        // three separate `storageSlot()` inlines here cost bytecode).
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // #1001 (S3) — one live offset offer per loan. A second offset would
        // create a second linked offer racing the same loan; the second's
        // completion would revert anyway (loan no longer Active), but rejecting
        // up front is a clean error.
        if (s.loanToOffsetOfferId[loanId] != 0)
            revert OffsetAlreadyActive();
        // #1001 (S3, Codex #1070 r8 P2) — SYMMETRIC to the round-4 guard that
        // blocks `createLoanSaleOffer` while an offset is live. If a lender sale
        // listing is already open on this loan, don't let the borrower open an
        // offset too: both flows would be live on one loan, and whichever closes
        // first leaves the other's vehicle + NFT lock stale (a later accept of the
        // stale one reverts after the counterparty commits). Require the sale
        // listing be cancelled first.
        if (s.loanToSaleOfferId[loanId] != 0)
            revert SaleListingActiveOnLoan();
        _validateOffsetRequest(
            loan,
            durationDays,
            collateralAsset,
            collateralAmount,
            prepayAsset
        );

        // ── 1. NO settlement at posting (Codex #1070 redesign) ──────────────
        // The old lender's payoff is settled AT COMPLETION, from live terms
        // (`_settleOldLenderAtCompletion`). Posting moves no settlement funds and
        // parks nothing in shared state — so an interleaving lender-sale,
        // close-out, obligation-transfer or term-mutation can't corrupt a prepay
        // (there is none). The `OffsetOfferCreated.accruedShortfall` field is a
        // posting-time PREVIEW only; since the redesign settles nothing here it is
        // emitted as 0 (the authoritative figure is computed + charged at
        // completion). Skipping the read-only `_computeOffsetSettlement` preview
        // also keeps this size-tight god-facet under the EIP-170 limit.

        // ── 2. Create lender offer via cross-facet call ─────────────────────
        // alice deposits principal into her vault (handled by createOffer).
        // alice must have approved principalAsset to the diamond before calling.
        newOfferId = _submitOffsetOffer(
            loan,
            interestRateBps,
            durationDays,
            collateralAsset,
            collateralAmount,
            creatorRiskAndTermsConsent,
            prepayAsset
        );

        // ── 3+4. Link, lock, emit ─ all moved to a helper so the outer frame
        // has room for the storage-write / lock / emit triplet under
        // --ir-minimum. See _finalizeOffsetLink for details.
        _finalizeOffsetLink(loan, loanId, newOfferId, 0);
    }

    /**
     * @dev Common guard clauses for {offsetWithNewOffer}. Extracted so the
     *      outer function has fewer locals in scope when it reaches the
     *      storage-link + lock tail (stack-too-deep under --ir-minimum).
     *      #1219 (S-4) -- not `view`: when a delegated keeper is the actor, the
     *      authority check is where that identity is established, so the
     *      keeper's one-action capacity charge lives here with it.
     */
    function _validateOffsetRequest(
        LibVaipakam.Loan storage loan,
        uint256 durationDays,
        address collateralAsset,
        uint256 collateralAmount,
        address prepayAsset
    ) private {
        // Phase 6: borrower-entitled strategic flow (Preclose Option 3).
        // Authority binds to current borrower-NFT owner OR a keeper with
        // the InitPreclose action bit.
        LibPreclose.authorizeBorrowerSide(LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE, loan); // #1219 — a keeper action is charged
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();
        // NFT rentals cannot use the offset path: the NFT is in the lender's
        // vault, not the borrower's, so createOffer would fail trying to
        // transfer it from alice.
        if (loan.assetType != LibVaipakam.AssetType.ERC20)
            revert InvalidOfferTerms();
        // Enforce same asset types as original loan (README General Rules)
        if (collateralAsset != loan.collateralAsset) revert InvalidOfferTerms();
        if (prepayAsset != loan.prepayAsset) revert InvalidOfferTerms();
        // #1032 (L-c) — seconds-precise maturity bound (not the up-rounded
        // whole-day `_remainingDays`): the replacement term must not carry the
        // new loan's maturity past the original loan's maturity. This is a
        // cheap request-time FIRST-LINE guard (fail fast at `offsetWithNewOffer`
        // rather than at accept); equality is allowed here — a same-term offset
        // whose replacement matures exactly at the original maturity is fine.
        // The LOAD-BEARING anti-drift guarantee is re-checked at acceptance in
        // `_completeOffsetImpl` (the replacement loan re-originates at accept
        // time, which can be later than this request), where a drift reverts the
        // whole acceptance atomically.
        if (
            block.timestamp + durationDays * LibVaipakam.ONE_DAY
                > LibLoanClock.maturity(loan)
        ) revert InvalidOfferTerms();
        // Lender-favorability: collateral from new borrower must not be less than original
        if (collateralAmount < loan.collateralAmount)
            revert InsufficientCollateral();
    }

    /**
     * @dev Writes the offer↔loan link mappings, native-locks the borrower-
     *      side position NFT, and emits {OffsetOfferCreated}. Runs in its
     *      own frame so the caller's stack stays shallow enough for
     *      `forge coverage --ir-minimum`.
     */
    function _finalizeOffsetLink(
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        uint256 newOfferId,
        uint256 accruedShortfallSum
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.offsetOfferToLoanId[newOfferId] = loanId;
        s.loanToOffsetOfferId[loanId] = newOfferId;
        // #1814 — the vehicle's expiry is stamped on the PARAMS path in
        // `_buildOffsetParams`, deliberately NOT written here after creation.
        // See the reasoning there; the short version is that
        // `createOfferInternal` emits the self-sufficient
        // `OfferCreatedDetails` before this frame runs, so a post-create
        // write would leave that event advertising the GTC sentinel to
        // event-driven consumers while storage held the real deadline.
        // The NFT stays with the initiator, but ERC-721 transfer/approve is
        // blocked at the library level for the duration of the offset flow.
        // Lock is cleared in completeOffset (success) or OfferFacet.cancelOffer
        // (cancel). See LibPositionNFT.RouteReason.
        LibPositionNFT.openRoute(loan.borrowerTokenId, LibPositionNFT.RouteReason.PrecloseOffset, true);
        // #1001 (S3, Codex #1070 r6 P3) — emit the ACTUAL offset creator (the
        // borrower-position holder that owns + funds the offer and can cancel it),
        // NOT `msg.sender` — which on the keeper-triggered path is the keeper.
        // Matches the `offsetCreator` passed to `createOfferInternal` so indexers
        // attribute the pending offset to the right party.
        emit OffsetOfferCreated(
            loanId,
            newOfferId,
            LibPositionNFT.ownerOf(loan.borrowerTokenId),
            accruedShortfallSum
        );
    }

    /**
     * @dev Settles alice's accrued-interest + shortfall payments for an
     *      offset. Returns accruedShortfallSum so the caller can emit it.
     *      Extracted so all payment-side locals (treasuryFee, payAsset,
     *      lenderTotal, lenderVault, etc.) stay in their own frame —
     *      otherwise `forge coverage --ir-minimum` runs out of stack slots
     *      when the outer function continues with the offer-creation path.
     */
    /// @dev #1001 (S3, Codex #1070 redesign) — PURE computation of the old
    ///      lender's offset payoff from the CURRENT loan + replacement terms.
    ///      Split out so it can be evaluated read-only at posting (for the
    ///      informational event) and again at completion (for the actual
    ///      transfers), always against live state. `elapsed` is read at call
    ///      time, so evaluating at completion naturally pays the old lender for
    ///      the FULL time the loan actually ran (posting→completion included),
    ///      and the shortfall reflects the replacement offer's live rate/term —
    ///      which is why a later term mutation can't undercompensate the lender.
    /// @return treasuryFee        the treasury cut on accrued interest
    /// @return lenderTotal        principal + (accrued − fee) + shortfall owed
    ///                            to the old lender
    /// @return interestBase       #1391 — the treasury-split base
    ///                            (`accruedInterest + lateFee`). Threaded out
    ///                            because the lender yield-fee discount must be
    ///                            sized on the SAME base the treasury cut was
    ///                            taken from, but can only be DELIVERED at
    ///                            completion (this helper is `view`, and the
    ///                            delivery may debit a VPFI vault). Excludes
    ///                            `shortfall`, which is a pure lender top-up the
    ///                            treasury never touches.
    function _computeOffsetSettlement(
        LibVaipakam.Loan storage loan,
        uint256 interestRateBps,
        uint256 durationDays,
        uint256 lateFee
    )
        private
        view
        returns (uint256 treasuryFee, uint256 lenderTotal, uint256 interestBase)
    {
        // #641 — read the interest clock, not the immutable term tuple.
        uint256 elapsed = block.timestamp - LibVaipakam.interestAccrualStartOf(loan);
        // #668 / #935 — the remaining term runs to the pause-moved end.
        uint256 remainingSecs = LibLoanClock.remainingInterestSeconds(loan, block.timestamp);
        uint256 accruedInterest = LibEntitlement.proRataInterestSeconds(
            loan.principal, loan.interestRateBps, elapsed
        );
        // #1001 (S3, Codex #1070 r9 P2) / #915 (M7) — NET already-settled
        // periodic interest. A loan on a periodic-interest cadence may have
        // auto-liquidated some interest into `loan.interestSettled` (already
        // paid to the lender). The gross accrual above covers the FULL elapsed
        // window, so without crediting the settled portion the offset would
        // charge the borrower — and pay the lender — that interest twice.
        // Shared saturating helper (also used by the Option 2 transfer +
        // proper-close `settlementInterestNet`).
        accruedInterest = LibEntitlement.creditSettledInterest(loan, accruedInterest);
        uint256 originalExpectedRemaining = LibEntitlement.proRataInterestSeconds(
            loan.principal, loan.interestRateBps, remainingSecs
        );
        uint256 newExpectedEarning = LibEntitlement.proRataInterestSeconds(
            loan.principal, interestRateBps, durationDays * 1 days
        );
        uint256 shortfall = originalExpectedRemaining > newExpectedEarning
            ? originalExpectedRemaining - newExpectedEarning
            : 0;

        // Pass-2 A1/D5 (#1189) — fold the late fee (0 within term) into the
        // treasury split base and the lender's total so an overdue offset
        // completion carries the same penalty as the other early-close paths.
        // Defensive parity: the #1032 anti-drift guard in `_completeOffsetImpl`
        // already blocks any at/post-maturity completion, so `lateFee` is 0 in
        // practice today; this keeps the term correct should that guard relax.
        interestBase = accruedInterest + lateFee;
        (treasuryFee, ) = LibEntitlement.splitTreasury(loan, interestBase);
        lenderTotal = loan.principal + (interestBase - treasuryFee) + shortfall;
    }

    /// @dev #1001 (S3, Codex #1070 redesign) — settle the old lender AT
    ///      COMPLETION (not at posting). Runs inside the acceptor's atomic
    ///      `acceptOffer` tx. This is the ONLY point the offset touches the old
    ///      loan's settlement state: nothing is parked between posting and
    ///      accept/cancel, so an interleaving lender-sale / close-out / mutate
    ///      can't corrupt a prepay (there is none). The payer is `loan.borrower`
    ///      (Alice) via her standing allowance — NOT `msg.sender`, which at
    ///      completion is the accepting counterparty / keeper / Diamond. The
    ///      recipient is `loan.lender` — read live, so a lender that SOLD the
    ///      position is paid to the current holder's vault.
    function _settleOldLenderAtCompletion(
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        LibVaipakam.Offer storage offer
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Pass-2 A1/D5 (#1189) — late fee off the original loan's maturity
        // (effective, with any pause credit — #668 / #935)
        // (0 within term). Defensive parity with the other early-close paths.
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId);
        (uint256 treasuryFee, uint256 lenderTotal, uint256 interestBase) =
            _computeOffsetSettlement(
                loan, offer.interestRateBps, offer.durationDays, lateFee
            );

        // Lender Yield Fee discount (Tokenomics §6 / §F2, #1354 / #1391) — the
        // offset close-out took its treasury cut undiscounted, so a Full-stamped
        // (or consent-holding) old lender lost the discount purely by exiting
        // through an offset instead of a repay/preclose.
        //
        // This is the one settlement site where the split is COMPUTED in a `view`
        // and DELIVERED later, so the base is threaded out of
        // `_computeOffsetSettlement` and the delivery runs here, inside the
        // acceptor's atomic tx. That is safe for both delivery modes: the
        // direct-reduction path moves no tokens (it just shifts the split), and
        // the VPFI-payment path is already gated on the CHARGED party's own
        // stored consent inside `quoteYieldFee` — so a non-consenting old lender
        // can never have their vault debited by someone else's accept tx; they
        // simply receive the bump via direct reduction.
        //
        // Keyed on the CURRENT lender-NFT holder, NOT the stored `loan.lender`:
        // `_completeOffsetImpl`'s `eagerConsolidateBothSides` is Tier2
        // skip-not-block (it declines to re-anchor for a sanctions-frozen holder
        // or the #597 `heldForLender` exclusion), so a consolidation call is not
        // proof the field is fresh, and `ClaimFacet.claimAsLender` is
        // `ownerOf(lenderTokenId)`-gated — the current holder is who is paid
        // (Codex #1390 P1, same reasoning as the other preclose legs).
        {
            (uint256 offLenderExtra, uint256 offNewTreasury) =
                LibPreclose.resolveLenderYieldFee(
                    loanId,
                    LibPositionNFT.ownerOf(loan.lenderTokenId),
                    interestBase,
                    treasuryFee
                );
            if (offLenderExtra > 0) {
                lenderTotal += offLenderExtra;
                treasuryFee = offNewTreasury;
            }
        }

        address payAssetOffset = LibPreclose.paymentAsset(loan);
        // #1281-011 — the one payer -> treasury pull (refuses a short arrival);
        // the payer is Alice, on her standing allowance.
        LibFacet.transferFromPayerToTreasury(loan.borrower, payAssetOffset, treasuryFee);
        // #1209 / #1808 — the payoff lands in the held balance, not in the
        // lender claim row the terminal split ranks, so the open seller claims
        // are paid first here, out of the interest, from Alice into each
        // seller's vault. Whatever the interest cannot cover closes unpaid at
        // the terminal split, as on any other close.
        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            (, uint256 sellersNet) = LibInterestLedger.paySellersFirst(
                s, loan, loan.borrower, payAssetOffset, interestBase, interestBase - treasuryFee
            );
            lenderTotal -= sellersNet;
        }
        // Repay original principal + interest/shortfall into the CURRENT old
        // lender's vault via the cross-payer chokepoint (keeps the Diamond out
        // of the funds path AND ticks protocolTrackedVaultBalance under the
        // lender). Alice returns Liam's principal here; her separate new-offer
        // capital was pre-vaulted at `createOffer` when she posted.
        //
        // #1001 (S3, Codex #1070 r5 P2) — vault-lock the receive side. Because
        // this redesign moved the old-lender payoff from posting to completion, a
        // lender flagged AFTER posting but BEFORE acceptance would otherwise brick
        // `acceptOffer`/`completeOffsetInternal` on the receiving-vault sanctions
        // screen — stranding the whole offset even though the proceeds land in the
        // lender's OWN vault, frozen behind the Tier-1 claim gate. Pin the
        // receive-side exemption to `loan.lender` so the close-out completes; the
        // parked-proceeds audit event fires from `end(...)` when flagged. Same
        // pattern as `RepayFacet`'s terminal lender deposit.
        // Park the old-lender payoff + apply the fail-closed freeze in ONE
        // cross-facet call (#998 S10 / S3 #1001). The host folds the receive-side
        // exemption pin, the cross-payer `vaultDepositERC20From` (payer = Alice →
        // current old-lender's vault, Diamond out of the funds path), the
        // parked-proceeds audit event, and the lender-side frozen-claimant marker.
        // Consolidated here (vs the inline `begin`/deposit/`end`/marker sequence
        // roomier facets like RefinanceFacet use) because PrecloseFacet is at the
        // EIP-170 wall — one CALL instead of two keeps it under the limit.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.parkLenderPayoffAndFreeze.selector,
                loan.borrower,               // payer — Alice
                loanId,
                payAssetOffset,
                lenderTotal
            ),
            bytes4(0)
        );
        s.heldForLender[loanId] += lenderTotal;
        // #597 — reserve the held VPFI against the old lender's unstake path for
        // the (now brief) window between this write and `claimAsLender`. VPFI is
        // the one principal asset with a user-facing tracked-balance exit; no-op
        // otherwise. Released path-agnostically in `ClaimFacet._claimAsLenderImpl`.
        if (payAssetOffset == s.vpfiToken) {
            LibEncumbrance.encumberLenderProceeds(
                loanId, loan.lender, payAssetOffset, lenderTotal
            );
        }
    }

    /**
     * @dev Builds the 16-field `CreateOfferParams` struct in its own frame
     *      and fires the cross-facet call. Extracted from
     *      {offsetWithNewOffer} so `forge coverage --ir-minimum` doesn't pile
     *      every `loan.X` SLOAD onto the caller's stack.
     */
    function _submitOffsetOffer(
        LibVaipakam.Loan storage loan,
        uint256 interestRateBps,
        uint256 durationDays,
        address collateralAsset,
        uint256 collateralAmount,
        bool creatorRiskAndTermsConsent,
        address prepayAsset
    ) private returns (uint256 newOfferId) {
        LibVaipakam.CreateOfferParams memory params = _buildOffsetParams(
            loan,
            interestRateBps,
            durationDays,
            collateralAsset,
            collateralAmount,
            creatorRiskAndTermsConsent,
            prepayAsset
        );
        // Use `createOfferInternal` not `createOffer`: the outer
        // `offsetWithNewOffer` already holds the diamond's
        // `nonReentrant` lock, so a second `nonReentrant` entry via
        // `createOffer` would revert `ReentrancyGuardReentrantCall`.
        // The internal entry skips that modifier and is gated on
        // `msg.sender == address(this)` so EOAs can't call it
        // through the diamond fallback. Same pattern as
        // `OfferFacet.acceptOfferInternal` for matchOffers.
        //
        // #1001 (S3, Codex #1070 r5 P2) — create AND fund the offset offer as the
        // BORROWER-position holder, NOT `msg.sender`. `offsetWithNewOffer` is a
        // borrower-entitled action a keeper (INIT_PRECLOSE) may trigger; if the
        // creator were `msg.sender`, a keeper would own the new lender NFT + fund
        // its principal, yet completion pulls the old-loan payoff from
        // `loan.borrower` — so a keeper could strand a fillable offer that later
        // spends the borrower's allowance while the keeper pockets the lender
        // position. Binding the creator to the borrower holder keeps the economics
        // coherent: the borrower funds + owns the new lender position AND pays the
        // payoff, and the keeper is a pure trigger. For a self-initiated offset
        // `ownerOf(borrowerTokenId) == msg.sender`, so this is a no-op there.
        // (The borrower NFT is locked for the offset, so this holder is fixed from
        // posting through completion.) The #671 create-time risk-access gate still
        // runs inside `createOfferInternal` on this creator.
        address offsetCreator = LibPositionNFT.ownerOf(loan.borrowerTokenId);
        (bool success, bytes memory result) = address(this).call(
            abi.encodeWithSelector(
                OfferCreateFacet.createOfferInternal.selector,
                offsetCreator,
                params
            )
        );
        if (!success) revert OfferCreationFailed();
        newOfferId = abi.decode(result, (uint256));
    }

    function _buildOffsetParams(
        LibVaipakam.Loan storage loan,
        uint256 interestRateBps,
        uint256 durationDays,
        address collateralAsset,
        uint256 collateralAmount,
        bool creatorRiskAndTermsConsent,
        address prepayAsset
    ) private view returns (LibVaipakam.CreateOfferParams memory params) {
        params.offerType = LibVaipakam.OfferType.Lender;
        params.lendingAsset = loan.principalAsset;
        params.amount = loan.principal;
        params.interestRateBps = interestRateBps;
        params.collateralAsset = collateralAsset;
        params.collateralAmount = collateralAmount;
        params.durationDays = durationDays;
        params.assetType = loan.assetType;
        params.tokenId = loan.tokenId;
        params.quantity = loan.quantity;
        params.creatorRiskAndTermsConsent = creatorRiskAndTermsConsent;
        params.prepayAsset = prepayAsset;
        params.collateralAssetType = loan.collateralAssetType;
        params.collateralTokenId = loan.collateralTokenId;
        params.collateralQuantity = loan.collateralQuantity;
        // #183 (PR #187 Codex P1) — Phase 2 OfferCreateFacet rejects
        // `amountMax == 0` / `interestRateBpsMax == 0` (and
        // `collateralAmountMax == 0` for ERC20+ERC20 non-sale-vehicle
        // offers). The offset vehicle is a Lender single-value offer
        // matching the original loan's principal + collateral
        // exactly, so the explicit max fields mirror their floors and
        // preserve single-value semantics byte-identically.
        params.amountMax = loan.principal;
        params.interestRateBpsMax = interestRateBps;
        params.collateralAmountMax = collateralAmount;
        // #408 / #410 / #413 (2026-06-12), Codex PR #559 round-1
        // P2: inherit the source loan's floor-model election so
        // the replacement (offset) loan settles under the same
        // interest model. See `EarlyWithdrawalFacet._buildSaleParams`
        // for the parallel rationale on the sale-vehicle builder.
        params.useFullTermInterest = loan.useFullTermInterest;
        // #1032 (L-c) — the LOAD-BEARING anti-drift guarantee is not enforced
        // via `expiresAt`; it is re-checked at ACCEPTANCE inside
        // `_completeOffsetImpl`, which fires atomically in the accepting tx (so
        // `block.timestamp` there IS the replacement loan's fresh start): a
        // drifting term reverts the whole acceptance, rolling the replacement
        // loan back cleanly. See the guard there. The expiry stamped below does
        // not substitute for it and does not tighten it.
        //
        // #1814 — the vehicle is NOT posted GTC. Left open-ended
        // (`expiresAt == 0`) it is cancellable only by its creator —
        // `cancelOffer`'s permissionless branch runs through `isOfferExpired`,
        // which short-circuits false on the GTC sentinel forever — while
        // `loanToOffsetOfferId` keeps both lender exits refusing
        // (`OffsetActiveOnLoan`). That is an unbounded borrower veto over the
        // lender's early exit. Stamping a real expiry is the whole fix: it opts
        // the vehicle back into the ordinary offer lifecycle, where an expired
        // offer is clearable by ANYONE — unlocking the borrower NFT, dropping
        // both link mappings, and refunding the creator's principal to
        // `offer.creator` regardless of who called.
        //
        // The bound is the LAST TIMESTAMP AT WHICH THE VEHICLE CAN STILL BE
        // ACCEPTED, and getting that boundary right is the whole point.
        // Acceptance needs `acceptTime + durationDays·1day <= originalMaturity`,
        // so the last acceptable instant is
        // `originalMaturity - durationDays·1day` — NOT the maturity itself.
        // `isOfferExpired` is `now >= expiresAt`, so `lastAcceptable + 1` keeps
        // the offer live for exactly `now <= lastAcceptable` and expires it the
        // instant acceptance becomes impossible.
        //
        // Stamping the maturity instead would leave the vehicle unfillable but
        // UNEXPIRED for a further `durationDays` — and since only an EXPIRED
        // offer admits the permissionless cancel, the veto would simply persist
        // across that window (for a same-term-at-start offset, the loan's entire
        // remaining term). That is the bug this stamp exists to remove, merely
        // shortened rather than fixed.
        //
        // This can never land in the past, so `createOffer`'s
        // `expiresAt <= block.timestamp` screen never fires:
        // `_validateOffsetRequest` (already run) required
        // `now + durationDays·1day <= maturity`, i.e. `lastAcceptable >= now`,
        // making the stamp `>= now + 1`. The subtraction cannot underflow for
        // the same reason. It is also strictly earlier than the maturity
        // (`durationDays >= 1` for every offer), so the vehicle can never
        // outlive the loan it offsets.
        //
        // That the value is always strictly future is exactly what lets it be
        // set HERE, on the params path, rather than written to storage after
        // creation — and setting it here is what puts the real deadline into
        // the self-sufficient `OfferCreatedDetails` event, whose `expiresAt`
        // field event-driven consumers read as authoritative. A post-create
        // write would leave that event advertising the GTC sentinel with no
        // later event correcting it.
        //
        // #1032's abandoned attempt is the near-miss worth naming: it produced
        // `expiresAt == now` for a legitimate same-term-at-start offset, which
        // `createOffer` rejects outright, breaking a valid lender-swap. The
        // `+ 1` is the difference. Such an offset is now created successfully
        // and carries a one-second fill window — the honest answer, because
        // with `durationDays == the remaining term` the replacement only fits
        // if it starts in that very instant. The anti-drift guard, not this
        // stamp, is what makes that so. A borrower wanting a usable window
        // picks a duration strictly shorter than the remaining term and gets
        // exactly `remaining - durationDays` of it.
        //
        // The horizon clamp is for a deployment that has raised
        // `cfgMaxOfferDurationDays` above the 365-day
        // `MAX_OFFER_EXPIRY_HORIZON` (the setter's ceiling is 4385 days): there
        // a long loan's `lastAcceptable` can sit further out than `createOffer`
        // accepts, and an unclamped stamp would REVERT offset creation
        // outright. Clamping only ever shortens the vehicle's life, which opens
        // the permissionless teardown earlier and never later — the safe
        // direction.
        {
            uint256 lastAcceptable = LibLoanClock.maturity(loan) -
                durationDays * LibVaipakam.ONE_DAY;
            uint256 horizonCap = block.timestamp +
                LibVaipakam.MAX_OFFER_EXPIRY_HORIZON;
            uint256 stamped = lastAcceptable + 1;
            params.expiresAt = uint64(
                stamped < horizonCap ? stamped : horizonCap
            );
        }
        // Phase 6: keeper enables are per-keeper via
        // `offerKeeperEnabled[offerId][keeper]`. The borrower (offset-offer
        // creator) can enable specific keepers on this offset offer via
        // `ProfileFacet.setOfferKeeperEnabled` after creation.
    }

    /**
     * @notice Step 2: Completes an offset after the replacement offer has been accepted.
     * @dev Normally invoked atomically from {OfferFacet.acceptOffer} in the
     *      same transaction as acceptance — users do NOT click a separate
     *      "Complete Offset" button under the happy path. This entry point is
     *      retained as a manual recovery hook (e.g., to rescue a loan that
     *      was accepted before auto-completion was introduced, or to be
     *      driven by a keeper if needed). Callable by the current
     *      borrower-NFT holder OR a keeper with the COMPLETE_OFFSET
     *      action bit and the per-loan enable for this loan (borrower-
     *      entitled action).
     *      Verifies the linked offer was accepted, then:
     *      - Releases alice's original collateral from vault.
     *      - Closes alice's original loan with liam (status = Repaid).
     *      - Updates NFTs to Claimable.
     * @param originalLoanId The original loan ID that was offset.
     */
    function completeOffset(
        uint256 originalLoanId
    ) external nonReentrant whenNotPaused {
        // #1001 (S3, Codex #1070 r7 P2) — Tier-1 caller screen on the EXTERNAL
        // recovery hook. This path pulls the old-loan payoff from the borrower and
        // deposits it to the lender, so a keeper (COMPLETE_OFFSET) approved before
        // being sanctioned must not be able to trigger the value-moving close-out —
        // matching `completeLoanSale` + the sibling preclose entry points. The
        // internal auto-complete path (`completeOffsetInternal`) is intentionally
        // NOT screened here: its caller is the diamond itself and the accepting
        // counterparty was already screened at `acceptOffer`.
        LibVaipakam._assertNotSanctioned(msg.sender);
        _completeOffsetImpl(originalLoanId);
    }

    /// @notice Cross-facet entry consumed exclusively by
    ///         `OfferFacet._acceptOffer`'s auto-link block when a
    ///         third party accepts an offset offer. Skips the outer
    ///         `nonReentrant` modifier because the calling facet
    ///         already holds the diamond's reentrancy guard — a second
    ///         `_enter()` would revert and the entire Option-3 flow
    ///         would be unusable. Same `address(this)`-only gate as
    ///         `OfferFacet.acceptOfferInternal` /
    ///         `createOfferInternal`.
    function completeOffsetInternal(
        uint256 originalLoanId
    ) external whenNotPaused {
        if (msg.sender != address(this)) {
            revert UnauthorizedCrossFacetCall();
        }
        _completeOffsetImpl(originalLoanId);
    }

    /// @dev Shared body for `completeOffset` (external,
    ///      `nonReentrant`) and `completeOffsetInternal` (cross-facet,
    ///      no guard). Single source of truth for the offset close-out.
    function _completeOffsetImpl(uint256 originalLoanId) private {
        // T-090 v1.1 (#389) §5.8 — shared body for `completeOffset`
        // (external) and `completeOffsetInternal` (cross-facet, no
        // outer guard). Gate here so both entry points are covered
        // by a single check; covers the case where the offset close-
        // out fires while the original loan still has a live v1.1
        // commit.
        LibVaipakam.assertNoLiveIntentCommit(originalLoanId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[originalLoanId];
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();

        // Pass-2 A1/D5 (#1189) — defensive parity: block a strictly-post-grace
        // offset completion, matching the other early-close paths. The #1032
        // anti-drift guard below already rejects any at/post-maturity completion
        // (the replacement can't mature after the original), so this is
        // belt-and-suspenders should that guard ever relax.
        _assertWithinGrace(loan);

        // Find the linked offset offer via the dedicated offset mapping
        uint256 newOfferId = s.loanToOffsetOfferId[originalLoanId];
        if (newOfferId == 0) revert OffsetNotLinked();

        // #3205 — checked once the offset is known to exist, so an unlinked
        // loan says so. The offset completes only for the holder that opened it:
        // the borrower position must not have moved since (the PositionNFT
        // core's transfer count), or the completion reverts and the offset
        // stays cancellable.
        LibPositionNFT.requireUnmoved(loan.borrowerTokenId, LibPositionNFT.RouteReason.PrecloseOffset);

        // Verify the offer was accepted
        LibVaipakam.Offer storage offer = s.offers[newOfferId];
        if (!offer.accepted) revert OffsetOfferNotAccepted();

        // #1032 (L-c, Codex #1069 round-3) — LOAD-BEARING anti-drift guard.
        // The replacement loan re-originates with `startTime = its accept time`,
        // so its maturity is `acceptTime + offer.durationDays·1day`. This
        // completion runs ATOMICALLY inside the accepting `acceptOffer` tx (via
        // `completeOffsetInternal`), so `block.timestamp` here IS that fresh
        // start. Reject if the replacement would mature past the original loan's
        // maturity — a drift the request-time gate in `_validateOffsetRequest`
        // can't catch when acceptance lands later than the request. Reverting
        // here rolls the whole acceptance (and the just-minted replacement loan)
        // back cleanly, so the original loan is left untouched rather than
        // silently extended. Equality (matures exactly at the original) is fine.
        if (
            block.timestamp + offer.durationDays * LibVaipakam.ONE_DAY
                > LibLoanClock.maturity(loan)
        ) revert InvalidOfferTerms();

        // Phase 6: borrower-entitled action. Authority resolves against
        // the current borrower-NFT holder OR a keeper with the
        // CompleteOffset action bit.
        LibPreclose.authorizeBorrowerSide(LibVaipakam.KEEPER_ACTION_COMPLETE_OFFSET, loan); // #1219 — a keeper action is charged

        // #1001 (S3, Codex #1070 r8 P2) — clear any parallel-sale listing BEFORE
        // the consolidation below. A borrower-side listing (`prepayListingOrderHash`
        // / offer-keyed) makes `_isExcludedLive` SKIP the borrower-side
        // consolidation, which would leave `loan.borrower` stale and let
        // `_settleOldLenderAtCompletion` pull the payoff from the prior holder
        // instead of the current NFT owner. Ordering it first (as `precloseDirect`
        // does) guarantees consolidation isn't excluded by a live listing.
        // Idempotent no-op in the normal flow (the offset lock blocks a listing).
        LibPrepayCleanup.clearActiveListing(loan, originalLoanId);

        // #1001 (S3, Codex #1070 r3 P1/P2) — re-anchor BOTH sides to their
        // current NFT holders BEFORE settling, exactly as `precloseDirect` and
        // `RepayFacet` do at their close-outs. A position NFT transferred before
        // (borrower) or during (lender — the offset locks only the borrower NFT)
        // the offset leaves `loan.borrower`/`loan.lender` stale; without this the
        // completion would pull the payoff from / deposit it to the wrong party
        // (charging the original borrower, or paying a stale lender that a current
        // clean holder can't then claim from). Consolidation re-anchors the stored
        // anchors to `ownerOf(tokenId)` + moves any vaulted assets; the offset's
        // borrower-NFT lock is untouched (consolidation never moves the NFT).
        // Best-effort (Tier-2 close-out semantics live inside).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.eagerConsolidateBothSides.selector,
                originalLoanId
            ),
            bytes4(0)
        );

        // #1001 (S3, Codex #1070 redesign) — settle the old lender HERE, from
        // live terms, pulling from the CURRENT borrower holder (`loan.borrower`,
        // just re-anchored) into the CURRENT lender holder's vault. This is the
        // sole point the offset touches the old loan's settlement state; posting
        // parked nothing. Runs before the borrower-collateral claim + the
        // Active→Repaid transition below.
        _settleOldLenderAtCompletion(loan, originalLoanId, offer);

        // Record borrower's claimable (collateral stays in borrower's vault)
        s.borrowerClaims[originalLoanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: loan.collateralAmount,
            assetType: loan.collateralAssetType,
            tokenId: loan.collateralTokenId,
            quantity: loan.collateralQuantity,
            claimed: false
        });
        // #998 S10 (#1006 / #1132) — Class A: the lender side is registered by
        // `_settleOldLenderAtCompletion`'s park; this deferred BORROWER collateral
        // claim's fail-closed marker is recorded centrally at the `Repaid`
        // transition below (terminalize records BOTH holders), so a later
        // oracle-outage `claimAsBorrower` fail-closes on a flagged holder.

        // The old lender's payoff was just deposited into their vault and
        // recorded in `heldForLender[loanId]` by `_settleOldLenderAtCompletion`.
        // It is withdrawn via `ClaimFacet.claimAsLender`, which reads
        // `s.heldForLender[loanId]` + the correct payment asset. Do NOT record it
        // in `lenderClaims` to avoid double-counting.

        // If NFT lending: Reset renter
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            LibPreclose.resetNftRenter(loan);
        }
        // (Parallel-sale listing cleanup moved ABOVE the consolidation — see the
        // Codex #1070 r8 P2 note there.)

        // Close original loan — offset completion transitions Active -> Repaid.
        LibPreclose.setLoanClaimable(loan, originalLoanId);
        // #1132 (S10 central enforcement) — route through the terminalize host.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.terminalize.selector,
                originalLoanId,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Repaid
            ),
            bytes4(0)
        );
        // #969 / S5 — the ORIGINAL loan is terminal here (the borrower's
        // obligation rolled into a fresh offset loan with its own entries), so
        // close the original loan's reward entries. The old lender is paid off in
        // full and never forfeits. The borrower side is CLEAN only when the offset
        // completes IN GRACE — an offset (default `expiresAt == 0`) accepted after
        // the old loan's grace window is a non-clean close and forfeits the old
        // borrower reward, matching the preclose/refinance grace checks (Codex
        // #1061 P2). Bubbling (#2739), like every terminal reward close.
        uint256 offsetGraceEnd = LibLoanClock.graceEnd(loan);
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                InteractionRewardsFacet.precloseRewardClose.selector,
                originalLoanId,
                block.timestamp <= offsetGraceEnd // borrowerClean
            ),
            RewardHookCallFailed.selector
        );

        // Release the native transfer lock on the borrower-side NFT. The
        // original loan is now Repaid; the initiator retains the NFT to
        // later claim back the original collateral via ClaimFacet.
        LibPositionNFT.closeRouteIfHeldBy(loan.borrowerTokenId, LibPositionNFT.RouteReason.PrecloseOffset);

        // Clear offset link mappings on both sides now that the flow
        // has fully settled (prevents stale offset references).
        delete s.offsetOfferToLoanId[newOfferId];
        delete s.loanToOffsetOfferId[originalLoanId];

        emit OffsetCompleted(
            originalLoanId,
            newOfferId,
            loan.borrower,
            uint8(LibVaipakam.LoanStatus.Repaid)
        );
    }
}
