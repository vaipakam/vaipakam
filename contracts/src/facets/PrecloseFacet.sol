// src/facets/PrecloseFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibRefinanceRequest} from "../libraries/LibRefinanceRequest.sol";
import {LibOfferPriceGuard} from "../libraries/LibOfferPriceGuard.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibTiming} from "../libraries/LibTiming.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {InteractionRewardsFacet} from "./InteractionRewardsFacet.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibInterestLedger} from "../libraries/LibInterestLedger.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibCompliance} from "../libraries/LibCompliance.sol";
import {LibLoan} from "../libraries/LibLoan.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {OutflowReason} from "../vault/VaultOutflowTypes.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibPreclose} from "../libraries/LibPreclose.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {RiskPreviewFacet} from "./RiskPreviewFacet.sol";

/**
 * @title PrecloseFacet
 * @author Vaipakam Developer Team
 * @notice Handles early repayment (preclose) for borrowers via three options:
 *      - Option 1: Direct preclose with full term interest.
 *      - Option 2: Transfer loan obligation to a new borrower
 *        (via an existing Borrower Offer).
 *      - Option 3, the offset route (a new lender offer, then completion
 *        once it is accepted), lives in {PrecloseOffsetFacet} since #3410,
 *        split out when this facet ran out of EIP-170 room. The steps the
 *        two facets share live once in {LibPreclose}; the two are refreshed
 *        together.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *      All three options support both ERC-20 loans and NFT rentals.
 *      Settlement math for ERC-20 uses {LibSettlement.computePreclose}
 *      (full-term interest, `TREASURY_FEE_BPS` split); NFT path uses
 *      `principal × durationDays` as full rental and
 *      {LibEntitlement.splitTreasury} for the fee split.
 *      Options 2 and 3 enforce sanctions/KYC via {LibCompliance} and
 *      lender-favorability constraints (collateral ≥ original,
 *      duration ≤ remaining, principal = original).
 */
contract PrecloseFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;

    // ─── Events ────────────────────────────────────��────────────────────────

    /// @custom:event-category state-change/loan-mutation
    event LoanPreclosedDirect(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 interestPaid
    );

    /// @notice Full settlement breakdown for an ERC-20 preclose.
    /// @dev Mirrors RepayFacet.LoanSettlementBreakdown so indexers can use a
    ///      single subscriber across both closing paths. Invariant:
    ///      `treasuryShare + lenderShare == interest + lateFee` (lateFee is
    ///      always 0 for preclose, which is strictly pre-maturity).
    /// @custom:event-category informational/settlement
    event LoanSettlementBreakdown(
        uint256 indexed loanId,
        uint256 principal,
        uint256 interest,
        uint256 lateFee,
        uint256 treasuryShare,
        uint256 lenderShare
    );

    /// @notice Emitted when a borrower's obligation is transferred to a
    ///         new borrower via the preclose offset path. Loan terms
    ///         (rate, duration) DO change here — the offer's terms
    ///         replace the prior loan's.
    /// @param loanId The ID of the loan whose borrower changed.
    /// @param originalBorrower The borrower exiting the loan.
    /// @param newBorrower The borrower stepping in.
    /// @param shortfallPaid Any shortfall paid by the original borrower
    ///        to clear the lender's accrued/principal owed.
    /// @param newBorrowerTokenId Position-NFT id minted for the new borrower.
    /// @param newCollateralAmount Loan's collateral AFTER the transfer
    ///        (= the offer's collateral amount). Carries the post-state
    ///        so an indexer can `UPDATE loans SET collateral_amount = ?`
    ///        without a read-back — the obligation-transfer path also
    ///        resets collateral, duration, rate and startTime.
    /// @param newInterestRateBps Loan's interest rate AFTER the transfer
    ///        (= the offer's interest rate).
    /// @param newDurationDays Loan's duration AFTER the transfer
    ///        (= the offer's duration).
    /// @param newDueTimestamp Computed maturity timestamp
    ///        (`startTime + durationDays * 1 days` after the term reset).
    /// @param newHealthFactor Loan's HF immediately after the transfer
    ///        (1e18 scale; 0 if illiquid). Lets cache surfaces show the
    ///        new HF without a follow-up `RiskFacet.getHealthFactor`
    ///        view-call. EventSourcingAudit §3.16.
    /// @custom:event-category state-change/loan-mutation
    event LoanObligationTransferred(
        uint256 indexed loanId,
        address indexed originalBorrower,
        address indexed newBorrower,
        uint256 shortfallPaid,
        uint256 newBorrowerTokenId,
        uint256 newCollateralAmount,
        uint256 newInterestRateBps,
        uint256 newDurationDays,
        uint64 newDueTimestamp,
        uint256 newHealthFactor
    );

    // ─── Errors ──────────────────────���─────────────────────────────────��────

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidNewBorrower();
    error InvalidOfferTerms();
    error InsufficientCollateral();
    /// @dev Pass-2 A1/D5 (#1189) — early-close paths block strictly past the
    ///      grace window, matching {RepayFacet.repayLoan}; post-grace resolution
    ///      goes through DefaultedFacet. Declared per-facet (not in
    ///      IVaipakamErrors), mirroring RepayFacet/SwapToRepayFacet.
    error RepaymentPastGracePeriod();
    /// #1001 (S3) — a loan may have at most ONE live offset offer at a time.
    /// A second `offsetWithNewOffer` while `loanToOffsetOfferId[loanId] != 0`
    /// would prepay the old lender a SECOND `heldForLender` slice (monotone
    /// accumulator), so it is rejected until the first offer is completed or
    /// cancelled (which clears the link + unwinds the prepay).
    error OffsetAlreadyActive();
    /// @notice The standing borrower offer being consumed as the obligation's
    ///         new home is past its GTT deadline. Mirrors
    ///         `OfferAcceptFacet.OfferExpired` (same name + same args ⇒ same
    ///         EVM selector), so a caller decodes identical revert data
    ///         whichever path refused to bind the offer.
    error OfferExpired(uint256 offerId, uint64 expiresAt);

    /// @dev Pass-2 A1/D5 (#1189) — shared maturity/grace gate for the early-close
    ///      paths (`precloseDirect`, offset completion), matching
    ///      {RepayFacet.repayLoan}. Reverts strictly past the grace window so a
    ///      late borrower can't route around the late-fee penalty (and the
    ///      DefaultedFacet resolution) via an early-close door. The grace end
    ///      is the effective one ({LibLoanClock.graceEnd}), moved by any global
    ///      pause since the loan started (#668 / #935); the late fee reads the
    ///      same clock. `private` so the gate is one JUMP target, not
    ///      inlined at each call site — this facet is EIP-170-maxed (#1124).
    function _assertWithinGrace(LibVaipakam.Loan storage loan) private view {
        if (block.timestamp > LibLoanClock.graceEnd(loan)) {
            revert RepaymentPastGracePeriod();
        }
    }

    // ─── Option 1: Direct Preclose────────────────────────────────��─────────

    /**
     * @notice Directly precloses an active loan (Option 1).
     * @dev Borrower pays principal + full term interest. 99% to lender, 1% to treasury.
     *      Releases collateral, resets NFT renter if applicable.
     *      Updates loan status to Repaid, NFTs to Claimable.
     * @param loanId The active loan ID to preclose.
     */
    function precloseDirect(
        uint256 loanId
    ) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 — borrower can't preclose-direct
        // while the v1.1 intent surface holds the collateral.
        LibVaipakam.assertNoLiveIntentCommit(loanId);
        // #2407 — refused while a live refinance request targets the loan.
        LibRefinanceRequest.assertNone(loanId);
        // Tier-1 sanctions gate — preclose routes funds back to
        // msg.sender (borrower closing early); sanctioned blocked.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // Phase 6: borrower-entitled strategic flow. Authority follows the
        // current borrower-NFT owner OR a keeper with the InitPreclose
        // action bit.
        LibPreclose.authorizeBorrowerSide(LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE, loan); // #1219 — a keeper action is charged
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();

        // Pass-2 A1/D5 (#1189) — block a strictly-post-grace preclose (parity
        // with repayLoan; post-grace resolution goes through DefaultedFacet).
        // Each asset branch below prices the late fee off the same loan clock
        // ({LibLoanClock}) when the close lands in the grace window.
        _assertWithinGrace(loan);

        // #998 S10 (#1006, Codex r1 P1) — record the fail-closed frozen-claimant
        // markers for BOTH sides up front (branch-independent): precloseDirect is
        // a Tier-2-style close-out for the counterparties — it writes a lender
        // payoff claim AND returns the borrower's collateral/refund, each claimed
        // later via ClaimFacet. A keeper-initiated (or outage-window) close can
        // complete while a current position holder is sanctioned, so freeze either
        // side fail-closed when its holder is confirmed flagged.
        // #1132 (S10 central enforcement) — both holders' fail-closed markers are
        // recorded centrally at the `Repaid` transition (terminalize) in each asset
        // branch below; the standalone `recordSanctionsFrozenClaimantBoth` here was
        // folded into those calls.

        // #658 PR-B (Codex #690 round-2 P2) — clear any active prepay /
        // parallel-sale listing BEFORE the consolidation hook below. The
        // consolidation primitive EXCLUDES the borrower side while a listing
        // hash is live (`_isExcludedLive` → Skipped), so consolidating first and
        // clearing later would leave a transferred borrower position going
        // terminal with its lien/reward/VPFI still on the old `loan.borrower` —
        // even though this close-out cancels the listing anyway. Clearing here
        // (still well before the Active→Repaid flip) lets the borrower side
        // consolidate. Idempotent + covers both the ERC20 and NFT-rental
        // branches (replaces the two later per-branch calls).
        LibPrepayCleanup.clearActiveListing(loan, loanId);

        // #658 PR-B (#594 arc) — eagerly consolidate BOTH sides of a
        // transferred position to their current NFT holders while the loan is
        // still Active (the primitive no-ops once terminal), so the collateral
        // lien, reward entry, and VPFI checkpoint follow the live holder before
        // the Active→Repaid flip below. Funds are already current-holder-safe
        // (lender via `lenderClaims` + `encumberLenderProceeds` → ClaimFacet;
        // borrower via `borrowerClaims` → `claimAsBorrower`, both `ownerOf`-
        // gated); this closes the position-effect-accounting gap. PrecloseFacet
        // is size-tight, so it consolidates via the few-byte cross-facet entry
        // (Tier2 skip-not-block — a sanctioned/excluded holder never bricks a
        // close-out). No post-withdraw VPFI restamp is needed here: preclose
        // moves no collateral out of a vault (it stays as `borrowerClaims`);
        // the VPFI restamp lives in `ClaimFacet.claimAsBorrower`, where that
        // collateral actually leaves the vault (Codex #690 round-4 P2).
        //
        // SCOPE: the eager consolidation covers ERC20 loans. NFT-RENTAL
        // precloses are intentionally NOT consolidated — `LibConsolidation`
        // returns `Skipped` for `assetType != ERC20`, so a transferred rental
        // position keeps its position effects on the stored anchor here. This
        // is consistent with the consolidation primitive's design (rentals are
        // excluded across the whole #594/#658 arc, not just this host); rental
        // position-effect consolidation is out of scope for #658.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.eagerConsolidateBothSides.selector,
                loanId
            ),
            bytes4(0)
        );

        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            // ── ERC20 loan preclose ─────────────────────────────────────────
            // Build immutable plan first (phase 1), then execute transfers &
            // claim writes off the same numbers (phase 2). Per README §8
            // Option 1: borrower owes full-term interest on preclose.
            // Pass-2 A1/D5 (#1189) — plus a late fee when the preclose lands in
            // the grace window (0 within term), so a late borrower pays the same
            // penalty repayLoan charges. `computePreclose` splits `interest +
            // lateFee` and folds it into `treasuryShare`/`lenderShare`/`lenderDue`.
            uint256 lateFee = LibVaipakam.calculateLateFee(loanId);
            LibSettlement.ERC20Settlement memory plan = LibSettlement.computePreclose(loan, lateFee);
            // #1832 — terminal seam of the lifetime interest counter.
            LibMetricsHooks.onInterestPaid(loan, plan.interest + plan.lateFee);

            // Lender Yield Fee discount (Tokenomics §6 / §F2, #1354 / #1383):
            // eligibility is `consent OR lenderMode == Full` (a Full lender
            // earns the +10% even without hold-discount consent). The shared
            // resolve helper runs the whole VPFI-payment-then-direct-reduction
            // delivery, sizing the VPFI treasury-cut equivalent on
            // `interest + lateFee` so a yield-discounted grace-window preclose
            // keeps the late fee in the lender's due (Pass-2 A1/D5 #1189).
            // Keyed on the CURRENT lender-NFT holder, NOT the stored
            // `loan.lender` (Codex #1390 P1). The `eagerConsolidateBothSides`
            // hook above is Tier2 SKIP-not-block: it leaves `loan.lender`
            // un-re-anchored when the current holder is sanctions-frozen or the
            // lender side carries the #597 `heldForLender` exclusion, so a
            // consolidation call is NOT proof the field is fresh. Since
            // `ClaimFacet.claimAsLender` is `ownerOf(lenderTokenId)`-gated, the
            // current holder is the party actually paid — resolving against a
            // stale address would price the discount off the previous lender's
            // hold tier and, once the peg is set, DEBIT their VPFI vault for a
            // discount they never receive. Same fix as `swapToRepayFull` (#1387),
            // which is eagerly consolidated on the same skip-not-block terms.
            // #1383 part B3 — routed through the diamond-internal resolve host
            // rather than inlining the delivery, so this size-maxed facet gets
            // the bytecode back (the host also emits the analytics passthrough,
            // which is why the separate emit block below is gone).
            (uint256 lenderExtra, uint256 newTreasury) = LibPreclose.resolveLenderYieldFee(
                loanId,
                LibPositionNFT.ownerOf(loan.lenderTokenId),
                plan.interest + plan.lateFee,
                plan.treasuryShare
            );
            if (lenderExtra > 0) {
                plan.lenderShare += lenderExtra;
                plan.lenderDue = plan.principal + plan.lenderShare;
                plan.treasuryShare = newTreasury;
            }

            // Treasury fee transferred immediately (skipped when satisfied in VPFI).
            // #1281-011 — the one payer -> treasury pull (refuses a short arrival).
            LibFacet.transferFromPayerToTreasury(msg.sender, loan.principalAsset, plan.treasuryShare);

            // T-037 — Lender's due: direct borrower → lender's vault.
            // Routed through the cross-payer chokepoint variant so the
            // protocolTrackedVaultBalance counter ticks under the
            // LENDER (the vault owner) while pulling from the
            // borrower's allowance.
            // #998 S10 note: the frozen-claimant markers recorded at the top of
            // precloseDirect protect the transferred-flagged-HOLDER case (stored
            // `loan.lender` clean → this deposit succeeds → the marker freezes the
            // flagged current holder's later claim). A flagged STORED `loan.lender`
            // still bricks this deposit on `getOrCreateUserVault`'s Tier-1 screen —
            // a PRE-EXISTING #821 completeness gap (the borrower's escape is
            // `repayLoan`, which carries the exemption). Adding the receive-side
            // exemption here overflows this EIP-170-maxed facet, so it is deferred
            // to a follow-up that splits PrecloseFacet (see #1124).
            // #3178 — the close-out delivery route resolves the lender's vault
            // as a RECEIVER: neither its version nor a sanctions flag on the
            // stored lender can block the borrower's early close (which also
            // closes the flagged-lender half of #1124 for this leg).
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultDeliverERC20From.selector,
                    msg.sender,        // payer — borrower
                    loan.lender,       // user — lender's vault
                    loan.principalAsset,
                    plan.lenderDue,
                    loanId
                ),
                VaultDepositFailed.selector
            );

            // Record lender's claimable (principal + interest)
            s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.principalAsset,
                amount: plan.lenderDue,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });
            // #592 — reserve VPFI lender proceeds against the unstake path
            // until the current holder claims (released in ClaimFacet). No-op
            // for non-VPFI principal.
            if (loan.principalAsset == s.vpfiToken) {
                LibEncumbrance.encumberLenderProceeds(
                    loanId, loan.lender, loan.principalAsset, plan.lenderDue
                );
            }

            // Record borrower's claimable (collateral stays in borrower's vault)
            s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.collateralAsset,
                amount: loan.collateralAmount,
                assetType: loan.collateralAssetType,
                tokenId: loan.collateralTokenId,
                quantity: loan.collateralQuantity,
                claimed: false
            });

            LibPreclose.setLoanClaimable(loan, loanId);
            // T-086 — the active prepay listing was already cleared at the top
            // of `precloseDirect` (before the #658 consolidation hook); see
            // {RepayFacet.repayLoan} for the full rationale. Idempotent, so no
            // second clear is needed here.
            // #1132 (S10 central enforcement) — route through the terminalize host.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.terminalize.selector,
                    loanId,
                    LibVaipakam.LoanStatus.Active,
                    LibVaipakam.LoanStatus.Repaid
                ),
                bytes4(0)
            );
            // #569 Codex #572 round-4 P2 — the collateral-lien release
            // is NO LONGER done at this proper-close terminal. The
            // borrower's collateral stays in their vault as the
            // `borrowerClaims` row recorded above and is withdrawn later
            // by `ClaimFacet.claimAsBorrower`, which now releases the
            // lien atomically right before that withdrawal. Releasing
            // here would let the stored borrower drain the collateral
            // (via `withdrawVPFIFromVault`) before a transferee claimant
            // claims it. `precloseDirect` settles the lender via
            // `safeTransferFrom` from the borrower's wallet (not a vault
            // withdraw), so no guard-clearing release is needed here.

            emit LoanPreclosedDirect(loanId, msg.sender, plan.interest);
            emit LoanSettlementBreakdown(
                loanId,
                plan.principal,
                plan.interest,
                plan.lateFee,
                plan.treasuryShare,
                plan.lenderShare
            );

            // #1383 part B3 — the lender yield-fee VPFI-discount passthrough
            // event is now emitted by the resolve host itself, so indexers still
            // subscribe to a single facet for all VPFI-discount analytics without
            // this facet carrying the emit.
        } else {
            // ── NFT rental preclose ─────────────────────────────────────────
            // For NFT rentals, payments use loan.prepayAsset (ERC20), not principalAsset (NFT).
            // Pass-2 D1 (#1188) — the preclose settles the REMAINING rental
            // (`remainingRentalDays`), not the immutable full `durationDays`
            // term: `autoDeductDaily` already paid the lender for the days
            // consumed so far, so charging the full term here would double-pay.
            // Lender gets remaining-rental fees minus treasury fee.
            // Borrower gets unused prepay + buffer refund.
            uint256 fullRental = loan.principal * LibVaipakam.remainingRentalDays(loan); // principal = daily fee for NFTs
            // Pass-2 A1/D5 (#1189) — add the rental late fee when the preclose
            // lands in the grace window (0 within term; slope-capped AND clamped
            // to the loan's pre-funded `bufferAmount`), funded from the buffer
            // exactly like {RepayFacet.repayLoan}'s rental leg. Split base =
            // remaining rental + late fee, so the lender receives the penalty.
            uint256 rentalLateFee = LibVaipakam.calculateRentalLateFee(loanId);
            uint256 totalDue = fullRental + rentalLateFee;
            (uint256 treasuryFee, uint256 lenderShare) = LibEntitlement.splitTreasury(
                loan,
                totalDue
            );

            // Lender Yield Fee discount (Tokenomics §6 / §F2, #1354 / #1383
            // part B3) — the rental leg previously took the treasury cut with NO
            // discount, so a Full-stamped (or consent-holding) rental lender lost
            // it purely because the collateral was an NFT. Sized on the same
            // `totalDue` split base, and the fee is denominated in
            // `loan.prepayAsset` — which the quote path now prices against
            // (Codex #1389 P2).
            //
            // Keyed on the CURRENT lender-NFT holder, NOT the stored
            // `loan.lender` (Codex #1390 P1). The eager consolidation above
            // deliberately SKIPS rentals (`LibConsolidation` returns `Skipped`
            // for `assetType != ERC20`), so on a transferred rental position
            // `loan.lender` is still the SELLER. `ClaimFacet.claimAsLender` is
            // `ownerOf(lenderTokenId)`-gated, so the proceeds recorded below are
            // ultimately drawn by the current holder — keying the discount on
            // the stale address would price it off the seller's hold tier and,
            // once the peg is set, DEBIT the seller's VPFI vault for a discount
            // they don't receive. The discount must follow the party who is
            // actually paid. (That the interim vault credit still resolves
            // `loan.lender` is the pre-existing #1124 gap — this leg must not
            // extend that gap into spending a non-participant's VPFI.)
            {
                (uint256 rentLenderExtra, uint256 rentNewTreasury) =
                    LibPreclose.resolveLenderYieldFee(
                        loanId,
                        LibPositionNFT.ownerOf(loan.lenderTokenId),
                        totalDue,
                        treasuryFee
                    );
                if (rentLenderExtra > 0) {
                    lenderShare += rentLenderExtra;
                    treasuryFee = rentNewTreasury;
                }
            }

            // Deduct from the borrower's prepay vault: treasury fee.
            // #574 — source from `loan.borrower` (who deposited the rental
            // prepay at loan init), NOT `msg.sender`. `precloseDirect` can be
            // triggered by a keeper or a transferred borrower-position holder
            // (it gates on keeper/holder authorisation, not borrower identity),
            // and the prepay always sits in the original borrower's vault.
            // Keying the source on `msg.sender` pulled from the caller's vault
            // instead — reverting for a keeper/transferee with no prepay, or
            // (worse) letting a transferred-away borrower redirect the prepay
            // out of someone else's vault. The fee belongs to the prepay, so
            // it must come from where the prepay lives.
            // #2440 — the treasury accrues what reached it.
            // #3178 — both prepay legs (the treasury's fee and the lender's
            // share) leave the renter's vault through ONE host on
            // `EncumbranceMutateFacet`: a close-out settlement, so neither the
            // renter's vault version nor a flag on the stored renter can stop
            // it, and the lender's vault is resolved as a RECEIVER, so neither
            // its version nor a flag on the stored lender can block the
            // renter's early close. Hosted off this EIP-170-tight facet.
            // #574 — sourced from `loan.borrower`, where the prepay lives.
            // #2440 — the treasury accrues what reached it; the lender's share
            // is refused unless it all arrived, and is credited under
            // `loan.lender`, whose vault the claim below is paid from.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.settleRentalPrecloseShares.selector,
                    loanId,
                    treasuryFee,
                    lenderShare
                ),
                bytes4(0)
            );

            // Record lender's claimable (rental fees in prepayAsset)
            s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: lenderShare,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });

            // Refund unused prepay + buffer to borrower (stays in borrower's vault).
            // Pass-2 A1/D5 (#1189) — order as (prepay + buffer) − totalDue so the
            // late fee drawing on the buffer can't underflow: `rentalLateFee` is
            // clamped ≤ `bufferAmount` and `prepayAmount ≥ fullRental` holds by
            // construction (mirrors the RepayFacet #558 ordering).
            uint256 refund = (loan.prepayAmount + loan.bufferAmount) - totalDue;
            s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: refund,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });

            // Reset NFT renter
            LibPreclose.resetNftRenter(loan);

            LibPreclose.setLoanClaimable(loan, loanId);
            // T-086 — the defensive prepay-listing sweep (any rental loan that
            // had a listing recorded before NFTPrepayListingFacet started
            // rejecting non-ERC20 principals, PR #317) now runs at the top of
            // `precloseDirect`, before the #658 consolidation hook. Idempotent,
            // so no second clear is needed on this branch.
            // #1132 (S10 central enforcement) — route through the terminalize host.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.terminalize.selector,
                    loanId,
                    LibVaipakam.LoanStatus.Active,
                    LibVaipakam.LoanStatus.Repaid
                ),
                bytes4(0)
            );
            emit LoanPreclosedDirect(loanId, msg.sender, fullRental);
        }

        // #969 / S5 (#998 Tranche 2) — close the interaction-reward entries for
        // BOTH branches (hoisted out of the if/else). The lender is repaid and
        // never forfeits (the early-withdrawal SALE path is the sole
        // lender-forfeit route). The borrower side is CLEAN only for an IN-GRACE
        // full repayment — a LATE preclose (past grace, before anyone triggered
        // default) is a non-clean close and forfeits the borrower reward, per the
        // {RepayFacet.repayLoan} convention (Codex #1061 P2). Bubbling (#2739):
        // a terminal transition closes its reward entry in the same transaction
        // or reverts, so a caller cannot starve the hook of gas and keep a
        // reward the late close should forfeit.
        uint256 graceEnd = LibLoanClock.graceEnd(loan);
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                InteractionRewardsFacet.precloseRewardClose.selector,
                loanId,
                block.timestamp <= graceEnd // borrowerClean
            ),
            RewardHookCallFailed.selector
        );
    }

    // ─── Option 2: Transfer Obligation ──────────────────────────────────────

    // NOTE: transferObligation (direct-parameter path) removed per README update.
    // Option 2 is now handled exclusively via transferObligationViaOffer.

    // ─── Option 2b: Transfer Obligation via Existing Borrower Offer ────────

    /**
     * @notice Transfers loan obligation by accepting an existing Borrower Offer (Option 2).
     * @dev Per README Section 8, Option 2:
     *      alice accepts ben's existing Borrower Offer. The offer must use the same
     *      lending/collateral asset types and favor liam (collateral >= original,
     *      duration <= remaining, amount >= principal). ben's collateral is already
     *      locked in his vault from offer creation. alice pays accrued interest +
     *      shortfall. The live loan is updated to reflect ben as borrower.
     * @param loanId The loan ID to transfer.
     * @param borrowerOfferId The existing Borrower Offer from ben.
     * @param validUntil The caller's MANDATORY transaction deadline (#3412):
     *        handing the obligation over fills ben's offer at its terms and
     *        charges alice the shortfall at the moment it lands, so it is
     *        price-exposed and a transaction landing after this reverts.
     */
    function transferObligationViaOffer(
        uint256 loanId,
        uint256 borrowerOfferId,
        uint64 validUntil
    ) external nonReentrant whenNotPaused {
        LibTiming.requireDeadline(validUntil);
        // T-090 v1.1 (#389) §5.8 — transferObligation rewrites
        // `loan.borrower` + `loan.collateralAmount` + the borrower
        // NFT; the v1.1 commit's `lopAtCommit` pin and orderHash
        // would describe a stale baseline. Block while live.
        LibVaipakam.assertNoLiveIntentCommit(loanId);
        // #2407 — refused while a live refinance request targets the loan.
        LibRefinanceRequest.assertNone(loanId);
        // Tier-1 sanctions gate — transferring an obligation closes
        // and re-opens loan state on behalf of msg.sender.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // #1001 (S3, Codex #1070) — refuse to transfer the obligation while a
        // Preclose Option-3 offset offer is live on this loan. The offset settles
        // the old lender from `loan.borrower` at completion; rewriting the
        // borrower here would repoint that payer and leave the offset link
        // pointing at a loan whose borrower has changed under it. The offset must
        // be cancelled (or completed) first.
        if (s.loanToOffsetOfferId[loanId] != 0) revert OffsetAlreadyActive();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // Phase 6: borrower-entitled strategic flow (Preclose Option 2).
        // Authority binds to the current borrower-NFT owner OR a keeper
        // with the InitPreclose action bit.
        LibPreclose.authorizeBorrowerSide(LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE, loan); // #1219 — a keeper action is charged
        // #819 Tier-1 sanctions on the EXITING borrower-position holder.
        // `requireKeeperFor` authorises against the borrower NFT owner, but a
        // keeper caller leaves that holder unscreened — and the exiting
        // collateral is withdrawn INLINE to that holder later in this function.
        // Screen it here at entry: the replacement offer is required to be
        // un-accepted (below), so no counterparty is committed and an atomic
        // revert strands nothing. Resolve the holder via the same
        // `IERC721(address(this)).ownerOf` authority source `requireKeeperFor`
        // uses (the current owner, not the latched `loan.borrower`).
        LibVaipakam._assertNotSanctioned(
            LibPositionNFT.ownerOf(loan.borrowerTokenId)
        );
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();

        LibVaipakam.Offer storage offer = s.offers[borrowerOfferId];
        if (offer.offerType != LibVaipakam.OfferType.Borrower || offer.accepted)
            revert InvalidOfferTerms();
        // #1773 — GTT expiry. This path reads the incoming borrower's standing
        // offer straight from storage rather than hopping through
        // `OfferAcceptFacet._acceptOffer`, so it inherits none of that entry's
        // gates and was never consulting the deadline. An offer past
        // `expiresAt` and not yet permissionlessly cancelled therefore stayed
        // consumable, letting the EXITING borrower hand a live obligation to an
        // author whose consent window had already closed.
        //
        // Same class as #1503 item 8 on the lender-sale side: the deadline is
        // the author's consent to the TIMING, and this path spends it on their
        // behalf. Refuse before any state change — the collateral top-up, the
        // borrower rewrite and the position-NFT work all follow below.
        // Routes through `LibVaipakam.isOfferExpired` so the GTC sentinel
        // (`expiresAt == 0`, never expires) keeps living in one place.
        if (LibVaipakam.isOfferExpired(offer)) {
            revert OfferExpired(borrowerOfferId, offer.expiresAt);
        }
        // #3443 — the offer's terms must have stood the minimum age before
        // this path takes it, as on every other fill.
        LibTiming.requireOfferAged(borrowerOfferId, offer);
        // #3358 — the incoming borrower posted this offer as a maker, so its
        // price-move guard holds here as on every other fill. The handover
        // opens no loan, so loan creation's check never sees it; this is that
        // check, before any state change.
        LibOfferPriceGuard.requireClear(s, borrowerOfferId, 0);
        // #576 — a refinance-tagged offer is SINGLE-PURPOSE: it may only be
        // consumed by the direct accept-and-refinance path. Consuming it for an
        // UNRELATED obligation transfer is invalid: on a carry-over offer the
        // collateral was never deposited (it's the refinance target loan's,
        // already liened in the creator's vault), so this path would recreate a
        // lien for the SAME NFT against the transferred loan too — double-liening
        // the one collateral and corrupting settlement. Reject before any state
        // change (no offer NFT burn, no lien write).
        if (offer.refinanceTargetLoanId != 0) revert InvalidOfferTerms();
        // #573 Codex round-2 P1 — a partially-filled offer (amountFilled
        // > 0, not yet dust-closed) is a matchOffers-managed entity.
        // Consuming it for an obligation transfer would overfill it beyond
        // the creator's ceiling — the principal / collateral checks below
        // validate against `amountMax` / `collateralAmount`, not the
        // remaining capacity. Mirror the direct-accept (OfferAcceptFacet)
        // and loan-sale (EarlyWithdrawalFacet) partial-fill rejections:
        // only `matchOffers` may advance a partially-filled offer.
        if (offer.amountFilled > 0) revert InvalidOfferTerms();
        // Range Orders Phase 1 — single source of truth for the per-
        // asset invariants (lendingAsset / collateralAsset /
        // collateralAssetType / prepayAsset). The amount / duration /
        // collateral-amount checks below stay flow-specific because
        // their semantics differ between Preclose (exact principal +
        // strict collateral floor) and Refinance (allows overage).
        if (!LibOfferMatch.assertAssetContinuity(loan, offer))
            revert InvalidOfferTerms();

        // Lender-favorability: replacement terms must not reduce liam's
        // protection. #1032 (L-c) — compare MATURITIES with second precision, not
        // whole-day counts: the loan re-originates with `startTime = now`, so a
        // day-granular `offer.durationDays <= _remainingDays(loan)` check (where
        // `_remainingDays` rounds elapsed DOWN, i.e. rounds the remaining count
        // UP) would let the replacement maturity (`now + durationDays·1day`) land
        // up to ~24h AFTER the original maturity, extending the lender's exposure.
        if (
            block.timestamp + offer.durationDays * LibVaipakam.ONE_DAY
                > LibLoanClock.maturity(loan)
        ) revert InvalidOfferTerms();
        if (offer.collateralAmount < loan.collateralAmount)
            revert InsufficientCollateral();
        // Range-aware amount check: legacy single-value offers satisfy
        // `amount == amountMax`; range offers satisfy `amount <=
        // loan.principal <= amountMax`. The borrower's range must
        // accommodate the existing loan's exact principal — preclose
        // is a transfer-of-obligation, not a fresh fill, so principal
        // doesn't get re-derived as a midpoint. With auto-collapse
        // (`amountMax == 0` → treated as `amount`) legacy offers fall
        // through unchanged. An NFT-rental offer is single-value by the
        // create/edit invariant (`RentalAmountRangeNotAllowed`, #1281 item
        // 021), so for a rental this check is exact: the daily fee the offer
        // prepaid (`offer.amount`, used for `newPrepay` in step 5b) equals the
        // fee the loan keeps running on (`loan.principal`).
        uint256 effAmountMax = offer.amountMax == 0
            ? offer.amount
            : offer.amountMax;
        if (offer.amount > loan.principal || loan.principal > effAmountMax)
            revert InvalidOfferTerms();

        address newBorrower = offer.creator;
        if (newBorrower == address(0) || newBorrower == msg.sender)
            revert InvalidNewBorrower();

        // ── Sanctions & KYC: new borrower must pass normal initiation checks ─
        LibCompliance.enforceCountryAndKyc(
            address(this),
            newBorrower,
            loan.lender,
            loan.principalAsset,
            loan.principal,
            loan.collateralAsset,
            loan.collateralAmount
        );

        // #671 phase 2 (#728 PR-2c) — progressive-risk gate on the INCOMING
        // borrower. This path makes `newBorrower` (ben) the borrower of an
        // existing loan by consuming his standing Borrower Offer, WITHOUT routing
        // through the accept→loan-init chokepoint, so the PR-2a acceptor gate
        // never re-validates him here. ben newly assumes this loan's borrower-
        // side exposure, so he is gated against the LOAN's asset pair (the risk
        // he is taking on, not the sale-vehicle surface) against the LIVE
        // tier/consent state — exactly the sale-buyer treatment (PR-2a). ben's
        // Borrower Offer may have been authored while the gate was off, or his
        // tier/consent may since have dropped or gone stale after a terms bump;
        // re-asserting here closes that window. Standing consent only — ben signs
        // no #662 acknowledgement for this transfer, so nothing substitutes. The
        // EXITING borrower (`msg.sender`, alice) stays exempt: that risk was
        // already accepted at the original loan. The assertion is delegated to
        // `RiskPreviewFacet` via a cross-facet call (PrecloseFacet sits at the
        // EIP-170 ceiling, so the PairId build can't live inline here); it gates
        // `offer.creator` (= `newBorrower`) against the POST-TRANSFER pair (the
        // loan's lend leg + this offer's collateral leg, since the transfer
        // installs the offer's collateral token id). The inner `RiskTierTooLow` /
        // `IlliquidPairNotConsented` revert bubbles. No-op unless the kill-switch
        // is on (guarded here so a gate-off transfer pays no cross-call).
        if (LibVaipakam.cfgRiskAccessGateEnabled()) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    RiskPreviewFacet.assertObligationTransferAllowed.selector,
                    loanId,
                    borrowerOfferId
                ),
                bytes4(0)
            );
        }

        // ── 1. Calculate what alice owes ────────────────────────────────────
        // Seconds-based math across accrued, original-remaining, and
        // new-expected to keep rounding symmetric (README §8/§9).
        // #641 — the accrued/remaining split reads the interest clock (post-
        // partial origin + remaining term), not the immutable term tuple.
        // #1194 (Codex #1249 r2 P2) — APR interest applies to ERC-20 loans ONLY.
        // Rentals are settled by the rent block below (keyed off asset type, not
        // the stored rate), so zero the APR legs here for any non-ERC-20 loan —
        // otherwise a rental carrying a non-zero rate (a rental offer is not
        // rejected for a non-zero rate at create, and a prior takeover copies
        // the incoming rate onto the loan) would be billed BOTH APR interest AND
        // per-day rent for the same window.
        bool isErc20 = loan.assetType == LibVaipakam.AssetType.ERC20;
        uint256 elapsed = block.timestamp - LibVaipakam.interestAccrualStartOf(loan);
        // #668 / #935 — the remaining term runs to the pause-moved end.
        uint256 remainingSecs = LibLoanClock.remainingInterestSeconds(loan, block.timestamp);
        uint256 newSecs = offer.durationDays * 1 days;
        uint256 accruedInterest = isErc20
            ? LibEntitlement.proRataInterestSeconds(loan.principal, loan.interestRateBps, elapsed)
            : 0;
        // #915 (M7) — credit interest already forwarded to the lender via
        // periodic auto-liquidation (`loan.interestSettled`, saturating at 0)
        // so the exiting borrower is not billed a second time for it. Mirrors
        // the offset (Option 3) `_computeOffsetSettlement` netting and the
        // proper-close `settlementInterestNet`; the accrual clock is not reset
        // by periodic settlement, so the raw accrual still spans those periods.
        accruedInterest = LibEntitlement.creditSettledInterest(loan, accruedInterest);

        // ERC-20 APR shortfall only; rentals get their rent-terms shortfall in
        // the rent block below (Codex #1249 r2 P2).
        uint256 shortfall;
        if (isErc20) {
            uint256 originalExpectedRemaining = LibEntitlement.proRataInterestSeconds(
                loan.principal, loan.interestRateBps, remainingSecs
            );
            uint256 newExpectedRemaining = LibEntitlement.proRataInterestSeconds(
                loan.principal, offer.interestRateBps, newSecs
            );
            shortfall = originalExpectedRemaining > newExpectedRemaining
                ? originalExpectedRemaining - newExpectedRemaining
                : 0;
        }

        // ── 2. alice pays accrued + shortfall ───────────────────────────────
        (uint256 treasuryFee, ) = LibEntitlement.splitTreasury(loan, accruedInterest);

        // Lender Yield Fee discount (§F2, #1354 / #1383 part B3) — this leg took
        // the treasury cut undiscounted, so a Full/consenting lender lost it on
        // every obligation transfer. Sized on `accruedInterest` (the split base);
        // the shortfall is a pure lender top-up the treasury never touches, so it
        // stays outside the discount base.
        //
        // Keyed on the CURRENT lender-NFT holder, NOT the stored `loan.lender`
        // (Codex #1390 P1). `transferObligationViaOffer` KEEPS `loan.lender`, so
        // on a transferred lender position it is still the SELLER, while the
        // `heldForLender` credit parked below is ultimately drawn through
        // `ClaimFacet.claimAsLender`, which is `ownerOf(lenderTokenId)`-gated —
        // i.e. the current holder is paid. Resolving against the stale address
        // would price the discount off the seller's hold tier and, once the peg
        // is set, DEBIT the seller's VPFI vault for a discount they never
        // receive. The discount follows the party who is actually paid; the
        // interim credit keying on `loan.lender` is the pre-existing #1124 gap
        // and must not be extended into spending a non-participant's VPFI.
        {
            (uint256 aprLenderExtra, uint256 aprNewTreasury) =
                LibPreclose.resolveLenderYieldFee(
                    loanId,
                    LibPositionNFT.ownerOf(loan.lenderTokenId),
                    accruedInterest,
                    treasuryFee
                );
            if (aprLenderExtra > 0) treasuryFee = aprNewTreasury;
        }

        // Sum invariant: the lender receives everything the treasury does not.
        // Deriving the share from the (possibly discounted) `treasuryFee` keeps
        // `treasuryFee + lenderShare == accruedInterest + shortfall` exact in
        // both the direct-reduction and VPFI-payment cases, with no separate
        // `+= lenderExtra` to drift.
        uint256 lenderShare = accruedInterest - treasuryFee + shortfall;

        address payAsset = LibPreclose.paymentAsset(loan);
        // #1281-011 — the one payer -> treasury pull (refuses a short arrival).
        LibFacet.transferFromPayerToTreasury(msg.sender, payAsset, treasuryFee);
        // #1209 / #1808 — the open seller claims are paid first out of the
        // interest, straight from the payer into each seller's vault, and the
        // holder's part of it is recorded as held for the lender side, so a
        // later sale pays it to that seller ({LibInterestLedger.holderParked}).
        // The shortfall is the holder's top-up, never a seller's interest.
        if (isErc20) {
            (uint256 sellersGross, uint256 sellersNet) = LibInterestLedger.paySellersFirst(
                s, loan, msg.sender, payAsset, accruedInterest, accruedInterest - treasuryFee
            );
            lenderShare -= sellersNet;
            LibInterestLedger.holderParked(
                s,
                loan,
                accruedInterest - sellersGross,
                accruedInterest - treasuryFee - sellersNet,
                lenderShare,
                false
            );
        }
        if (lenderShare > 0) {
            // T-037 — direct borrower → lender's vault via the cross-payer
            // chokepoint. Counter ticks up under the lender even though the
            // borrower is paying.
            // #1132 (S10 central enforcement) — route through the SAME
            // `parkLenderPayoffAndFreeze` host the offset-completion top-up
            // (`_settleOldLenderAtCompletion`) uses: it funds the lender's vault
            // behind the sanctions-LOCKING receive-side exemption AND records the
            // fail-closed lender frozen-claimant marker. The guardrail surfaced
            // this held-credit site's pre-existing gap — the plain
            // `vaultDepositERC20From` would (a) BRICK the obligation transfer when
            // a stored/current lender flagged after init resolves their vault
            // through the Tier-1 gate, and (b) leave the held credit fail-open at
            // claim time (no marker). `transferObligationViaOffer` KEEPS
            // `loan.lender`, so the deposit + register key on the same account.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.parkLenderPayoffAndFreeze.selector,
                    msg.sender,        // payer
                    loanId,
                    payAsset,
                    lenderShare
                ),
                bytes4(0)
            );
            s.heldForLender[loanId] += lenderShare;
            // #597 — reserve the held-for-lender VPFI against the unstake path
            // (the lender could otherwise `withdrawVPFIFromVault` to drain it
            // before the holder claims). `transferObligationViaOffer` KEEPS
            // `loan.lender`, so the reservation and the claim-time release key
            // on the SAME account — no migration needed here. A LATER lender
            // sale of this position re-keys the reservation in the
            // EarlyWithdrawalFacet sale paths (release-old + reserve-total-new).
            // Gated on VPFI — the only asset with a user-facing tracked-withdraw
            // (composes with any terminal #592 reserve: same loanId, same VPFI
            // asset, `encumberLenderProceeds` adds).
            if (payAsset == s.vpfiToken) {
                LibEncumbrance.encumberLenderProceeds(
                    loanId, loan.lender, payAsset, lenderShare
                );
            }
        }

        // ── 1b. NFT rental: settle rent accrued since the last deduction ─────
        // #1194 (Pass-2 D4) — a rental's economic payment is `principal (the
        // per-day fee) × days`, NOT APR, so the accrued-interest math above is 0
        // for rentals (`interestRateBps == 0`). Before the loan is rewritten to
        // the new borrower and section 5b resets `lastDeductTime`, forward the
        // rent that accrued between `lastDeductTime` and now to the CURRENT
        // lender-position holder (minus treasury), funded from the exiting
        // borrower's prepay vault — exactly as `RepayPeriodicFacet.autoDeductDaily`
        // does each day. Without this the undeducted rent would be silently
        // dropped by the 5b reset and stay freely withdrawable in the exiting
        // borrower's un-liened vault, leaving the old lender short of the rent
        // they earned up to the transfer (README §1512 "pay all rent accrued up
        // to the transfer" / §1420 "don't leave the original lender worse off").
        // Rentals — keyed off ASSET TYPE, not the stored rate: a rental can
        // legitimately carry a non-zero `interestRateBps` (offers aren't
        // rejected for it at create, and a prior takeover copies the incoming
        // rate onto the loan), so a rate-based gate would silently drop rent on
        // a follow-on transfer. The APR path above is neutralized for rentals
        // (`isErc20 == false`), so there is no double-bill (Codex #1249 r2 P2).
        if (!isErc20) {
            // (a) Rent accrued and not yet paid, in-term only: the one shared
            //     rule `repayLoan` also settles by (#901,
            //     `accruedUnpaidRentalDays`). It never bills past the agreed
            //     term (overdue time is a late-fee concern, out of scope here),
            //     reads a legacy/imported `lastDeductTime == 0` as nothing
            //     consumed rather than the whole term elapsed (Codex #1249 r2
            //     P2), and reads days prepaid ahead via `repayPartial` as zero
            //     owed rather than underflowing and bricking the transfer
            //     (Codex #1249 r1 P2). It never exceeds `remainingDays`.
            uint256 catchUpDays = LibVaipakam.accruedUnpaidRentalDays(loan);
            uint256 remainingDays = LibVaipakam.remainingRentalDays(loan);

            // (b) Term shortfall — the UNPAID rental days after this catch-up
            //     (`remainingRentalDays - catchUpDays`, the days from the
            //     deduction clock to maturity that aren't settled here) that the
            //     NEW borrower's shorter term won't cover. The exiting borrower
            //     pre-paid the full term, so those days are owed to the OLD
            //     lender (README §1420), mirroring the ERC-20 path's `shortfall`.
            //     Basing this on UNPAID days (not wall-clock time to maturity)
            //     avoids double-charging days already prepaid via `repayPartial`
            //     (Codex #1249 r2 P2).
            uint256 unpaidAfterCatchUp = remainingDays - catchUpDays;
            uint256 shortfallDays = unpaidAfterCatchUp > offer.durationDays
                ? unpaidAfterCatchUp - offer.durationDays
                : 0;

            uint256 accruedRent = loan.principal * catchUpDays;
            uint256 rentDue = accruedRent + loan.principal * shortfallDays;
            // Defensive clamp to the funded prepay (a fully-serviced rental
            // always has enough; this prevents an over-withdraw if it doesn't).
            if (rentDue > loan.prepayAmount) {
                rentDue = loan.prepayAmount;
                if (accruedRent > rentDue) accruedRent = rentDue;
            }
            if (rentDue > 0) {
                // Treasury takes its cut only on the accrued (elapsed) rent,
                // matching the ERC-20 path (the shortfall goes fully to the
                // lender). Lender share → current lender-position holder from the
                // prepay vault (fail-closed park if the holder is flagged),
                // mirroring the daily deduction path.
                (uint256 rentTreasury, uint256 rentLenderOnAccrued) =
                    LibEntitlement.splitTreasury(loan, accruedRent);

                // Lender Yield Fee discount (§F2, #1354 / #1383 part B3) — sized
                // on `accruedRent` (the treasury split base; the shortfall top-up
                // is pure lender money). Fee is denominated in `loan.prepayAsset`,
                // which the quote path now prices against (Codex #1389 P2).
                //
                // Keyed on the CURRENT lender-NFT holder, NOT `loan.lender`: this
                // leg deliberately forwards the catch-up rent to the current
                // position holder (`freezeOrPayActiveLenderFromVault` resolves the
                // holder), and rentals are excluded from the eager consolidation,
                // so the stored `loan.lender` can be stale here. Resolving the
                // discount — or a VPFI vault debit — against a party who is not
                // receiving the proceeds would charge the wrong account.
                {
                    (uint256 rentLenderExtra, uint256 rentNewTreasury) =
                        LibPreclose.resolveLenderYieldFee(
                            loanId,
                            LibPositionNFT.ownerOf(loan.lenderTokenId),
                            accruedRent,
                            rentTreasury
                        );
                    if (rentLenderExtra > 0) {
                        rentLenderOnAccrued += rentLenderExtra;
                        rentTreasury = rentNewTreasury;
                    }
                }

                uint256 lenderTotal = (rentDue - accruedRent) + rentLenderOnAccrued;
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EncumbranceMutateFacet.freezeOrPayActiveLenderFromVault.selector,
                        loanId,
                        loan.borrower,
                        loan.prepayAsset,
                        lenderTotal
                    ),
                    bytes4(0)
                );
                // #2440 — the treasury accrues what reached it.
                LibFacet.vaultFeeToTreasury(loan.borrower, loan.prepayAsset, rentTreasury);
                // Reduce the tracked prepay by the settled rent. Section 5b then
                // installs the incoming offer's prepay/buffer; the exiting
                // borrower's remaining prepay stays in their (un-liened) vault to
                // withdraw, now correctly net of the rent just paid to the lender.
                unchecked { loan.prepayAmount -= rentDue; }
            }
        }

        // ── 3. Release alice's collateral ───────────────────────────────────
        // #569 §4.4 (2026-06-13) — rekey, release-leg. Drop the exiting
        // borrower's collateral lien BEFORE returning their collateral,
        // so the chokepoint guard passes. No-op on NFT rentals (D-1).
        // The new borrower's lien is created after the loan rewrite
        // below (rekey create-leg).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.releaseCollateralLien.selector,
                loanId
            ),
            bytes4(0)
        );
        // #569 Codex #572 round-11 P1 — withdraw the exiting collateral
        // from the STORED `loan.borrower`'s vault (where the pledged
        // collateral sits and where the lien just released was keyed),
        // delivering it to the CURRENT borrower-position NFT holder — NOT
        // `msg.sender`. `transferObligationViaOffer` is keeper-authorizable
        // (`requireKeeperFor` above), so `msg.sender` may be a keeper;
        // paying the exiting collateral to `msg.sender` would hand it to an
        // approved/compromised keeper. `migrateBorrowerPosition` (which
        // re-keys the borrower NFT to the new borrower) runs later, so
        // `ownerOf(loan.borrowerTokenId)` here is still the EXITING
        // borrower — the rightful recipient. Common case (the holder calls
        // directly, `msg.sender == holder == loan.borrower`) is unchanged.
        // #2949 — a rental carries no collateral (`isErc20` is false), so
        // there is nothing to return; the zero `collateralAssetType` must not
        // read as an ERC-20 leg.
        address exitingBorrowerHolder = LibPositionNFT.ownerOf(loan.borrowerTokenId);
        // #3205 part 2 — one holder payout for any collateral kind (the asset
        // type's ordinals are the outflow kind's).
        if (isErc20) {
            LibVaipakam.AssetType t = loan.collateralAssetType;
            LibVaultOutflow.toPositionHolder(
                loan.borrower,
                uint8(t),
                loan.collateralAsset,
                t == LibVaipakam.AssetType.ERC20 ? 0 : loan.collateralTokenId,
                t == LibVaipakam.AssetType.ERC20
                    ? loan.collateralAmount
                    : (t == LibVaipakam.AssetType.ERC721 ? 1 : loan.collateralQuantity),
                loanId,
                loan.borrowerTokenId,
                OutflowReason.COLLATERAL_RELEASE
            );
        }

        // #2795 — a borrower extra held on this open loan (a periodic forced
        // sale's extra that could not reach the holder's wallet) came from the
        // exiting holder's collateral, so it leaves with them too. Paid from
        // the STORED borrower's vault, before the rewrite below.
        LibFacet.crossFacetCall(
            abi.encodeCall(
                EncumbranceMutateFacet.payHeldBorrowerExtra,
                (loanId, exitingBorrowerHolder)
            ),
            bytes4(0)
        );

        // ── 4. ben's collateral already locked in his vault at offer creation

        // ── 5. Update loan to reflect ben as borrower ───────────────────────
        // Captured for the migration helper below (Codex #1818 r4 P2): the
        // rewrite on the next line is what made the helper's own
        // holder-change comparison read new-vs-new and never reset the
        // paid-notification flag on an obligation transfer.
        address previousBorrower = loan.borrower;
        loan.borrower = newBorrower;
        loan.collateralAmount = offer.collateralAmount;
        // #569 Codex #572 P1 #2 (2026-06-13) — copy the incoming offer's
        // collateral IDENTITY too, not just the amount. `assertAssetContinuity`
        // pins only `collateralAsset` + `collateralAssetType`, so an
        // ERC721/1155 offer from the same collection may carry a DIFFERENT
        // `collateralTokenId` / `collateralQuantity` than the old loan.
        // Without this the lien recreate below would lock the OLD tokenId
        // under the new borrower while their actually-deposited NFT stays
        // unencumbered. ERC-20 collateral leaves these at 0 (harmless).
        loan.collateralTokenId = offer.collateralTokenId;
        loan.collateralQuantity = offer.collateralQuantity;
        loan.durationDays = offer.durationDays;
        // #1808 — the new rate goes through the ledger's single writer, which
        // checkpoints the old segment first, and BEFORE the new start time is
        // written: a ledger still unopened would otherwise open at the new start.
        LibInterestLedger.setRate(LibVaipakam.storageSlot(), loan, offer.interestRateBps);
        // T-034 — startTime downsized to uint64; explicit cast.
        loan.startTime = uint64(block.timestamp);
        // #641 — offset re-originates the obligation under a new term; restart
        // the interest-accrual clock with it.
        loan.interestAccrualStart = uint64(block.timestamp);
        // #915 (Codex #1087 r1 P2) — the re-originated obligation restarts its
        // accrual clock above, so any periodic-settled interest credited to the
        // EXITING borrower (already netted from their step-2 payment) belongs to
        // the closed accrual window. Clear it so the shared `interestSettled`
        // credit is not subtracted a SECOND time from the NEW borrower's future
        // repayment / default settlement (which would underpay the lender).
        loan.interestSettled = 0;

        // #969 / S5 (#998 Tranche 2) — Option 2 is a CONTINUING transfer, not a
        // terminal close: the loan stays Active under the incoming borrower and a
        // re-originated term (set just above). The hook SPLITS the reward windows
        // at the transfer day — the exiting borrower + unchanged lender keep what
        // they earned pre-transfer, and fresh entries cover the continuing loan
        // under the new rate/duration — so the incoming borrower only earns from
        // the transfer forward and never the previous borrower's history (Codex
        // #1061 P2). Bubbling (#2739), like every terminal reward close.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                InteractionRewardsFacet.precloseRewardTransferObligation.selector,
                loanId
            ),
            RewardHookCallFailed.selector
        );

        // #569 Codex #572 P1 #3 (2026-06-13) — verify the incoming
        // borrower's offer collateral actually backs the loan before
        // locking it. Pre-loan borrower-offer collateral is NOT
        // encumbered (the map §5 "fourth surface", tracked separately),
        // so a creator could deposit ERC-20 collateral at offer-create
        // and drain it — e.g. VPFI via `withdrawVPFIFromVault` — before
        // this transfer. Reverting here keeps the continuing loan from
        // being rekeyed onto absent collateral. (Full pre-loan
        // offer-collateral lock for the normal acceptance path is the
        // follow-up card; this is the targeted guard for the obligation-
        // transfer path that this PR newly liens.) A rental carries no
        // collateral (#2949), so it has nothing to verify here.
        if (isErc20 && loan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
            // #573 — release the new borrower's offer-collateral lock
            // (set when they created the borrow offer) BEFORE the
            // free-balance check + lien recreate below. The obligation
            // transfer is another borrower-offer consumption path: it
            // hands the offer lock off to the continuing loan's collateral
            // lien (`recreateCollateralLien` below). Without the release
            // the still-active offer lock makes `freeBalance` read 0 here
            // and the transfer reverts `InsufficientCollateral`. The check
            // then confirms the collateral is genuinely present (not
            // drained out a side door), and `recreateCollateralLien`
            // re-locks it under the new borrower for the continuing loan.
            // (The #565 comment above anticipated this as "the follow-up
            // card" — #573 is that card.)
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.releaseOfferPrincipalLien.selector,
                    borrowerOfferId
                ),
                bytes4(0)
            );
            address newBorrowerVault = LibFacet.getOrCreateVault(newBorrower);
            // #569 Codex #572 round-2 P1 — compare against the incoming
            // borrower's FREE balance (raw − their existing encumbrances),
            // not the raw vault balance. Otherwise, if they already have
            // the same ERC-20 locked by another active loan, they could
            // drain the new offer collateral down to that locked amount
            // and this check would still pass — double-encumbering the
            // same tokens across two loans.
            // #569 Codex #572 round-3 P2 — cap the raw balance by the
            // protocol-tracked balance first, matching the chokepoint
            // guard. Otherwise drained tracked collateral replaced by
            // unsolicited dust would pass here, and the later guarded
            // exit (which uses `min(balanceOf, tracked)`) couldn't return
            // or liquidate it.
            uint256 rawBal = IERC20(loan.collateralAsset).balanceOf(newBorrowerVault);
            uint256 trackedBal =
                LibVaipakam.trackedHolding(newBorrower, loan.collateralAsset, 0);
            if (trackedBal < rawBal) {
                rawBal = trackedBal;
            }
            if (
                LibEncumbrance.freeBalance(
                    newBorrower, loan.collateralAsset, 0, rawBal
                ) < loan.collateralAmount
            ) {
                revert InsufficientCollateral();
            }
        }

        // #569 §4.4 (2026-06-13) — rekey, create-leg. Now that the loan
        // row reflects the new borrower + their collateral (locked in
        // their vault at offer creation, step 4 above), create the lien
        // under the new borrower so the continuing loan's collateral is
        // protected. No-op on NFT rentals (D-1).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.recreateCollateralLien.selector,
                loanId
            ),
            bytes4(0)
        );

        // ── 5b. NFT rental: reset prepay accounting and reassign user rights ─
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            // Reset prepay accounting to ben's offer terms (initialized like LoanFacet.initiateLoan)
            // #1193 (Pass-2 D3) — read the incoming borrower offer's create-time
            // buffer snapshot, NOT live `cfgRentalBufferBps()`. A retune between
            // that offer's create and this transfer would otherwise set
            // `loan.bufferAmount` above what the offer funded, defeating the
            // #1004 `fee ≤ bufferAmount` guarantee (the #1096 `InsufficientPrepay`
            // brick on close-out).
            uint256 newPrepay = offer.amount * offer.durationDays;
            uint256 newBuffer = (newPrepay * LibVaipakam.effectiveRentalBufferBps(offer)) /
                LibVaipakam.BASIS_POINTS;
            loan.prepayAmount = newPrepay;
            loan.bufferAmount = newBuffer;
            loan.lastDeductTime = block.timestamp;
            // Revoke alice's user right
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultSetRentalUser.selector,
                    loan.id,
                    address(0),
                    0
                ),
                IVaipakamErrors.NFTRenterUpdateFailed.selector
            );
            // Assign ben as new user for remaining duration
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultSetRentalUser.selector,
                    loan.id,
                    newBorrower,
                    uint64(block.timestamp + loan.durationDays * 1 days)
                ),
                IVaipakamErrors.NFTRenterUpdateFailed.selector
            );
        }

        // ── 6. Mark offer accepted ──────────────────────────────────────────
        offer.accepted = true;
        LibMetricsHooks.onOfferAccepted(offer.id);

        // ── 7. NFT updates ──────────────────────────────────────────────────
        // #1123 (Codex #1126 r1 P1) — fail-closed movement gate before the
        // burn/mint borrower-position migration. BOTH parties are gated: unlike a
        // lender sale, an obligation transfer has no frozen-receive carve-out (the
        // `newBorrower` assumes a DEBT + pledges collateral, not proceeds), so a
        // flagged incoming borrower is blocked, not frozen. `from` is the EXITING
        // holder captured before the `loan.borrower` rekey. Routed through the
        // ProfileFacet host so the heavy gate isn't inlined into this
        // EIP-170-tight facet.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ProfileFacet.enforcePositionMoveNotSanctioned.selector,
                exitingBorrowerHolder,
                newBorrower
            ),
            bytes4(0)
        );
        LibLoan.migrateBorrowerPosition(loanId, newBorrower, previousBorrower);

        // Burn ben's offer position NFT (offer is consumed)
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.retirePosition.selector,
                offer.positionTokenId
            ),
            IVaipakamErrors.NFTBurnFailed.selector
        );

        // Update liam's Lender NFT to reflect new borrower
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanInitiated
            ),
            IVaipakamErrors.NFTStatusUpdateFailed.selector
        );

        // §3.16 — best-effort HF computation for the event payload.
        // calculateHealthFactor reverts NonLiquidAsset for illiquid loans;
        // staticcall + degraded-to-0 mirrors the AddCollateralFacet
        // pattern. Saves the consumer a follow-up RiskFacet read for the
        // common liquid case.
        uint256 newHf;
        (bool hfOk, bytes memory hfRet) = address(this).staticcall(
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId)
        );
        if (hfOk && hfRet.length > 0) {
            newHf = abi.decode(hfRet, (uint256));
        }
        emit LoanObligationTransferred(
            loanId,
            msg.sender,
            newBorrower,
            accruedInterest + shortfall,
            loan.borrowerTokenId,
            loan.collateralAmount,
            loan.interestRateBps,
            loan.durationDays,
            uint64(LibLoanClock.maturity(loan)),
            newHf
        );
    }

    // #1032 (L-c) — `_remainingDays` removed: its two callers (Option-2 +
    // Option-3 term gates) now bound the replacement MATURITY with second
    // precision instead of comparing up-rounded whole-day remaining counts.
}
