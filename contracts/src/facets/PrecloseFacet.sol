// src/facets/PrecloseFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {InteractionRewardsFacet} from "./InteractionRewardsFacet.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibCompliance} from "../libraries/LibCompliance.sol";
import {LibLoan} from "../libraries/LibLoan.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {OfferCreateFacet} from "./OfferCreateFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {RiskPreviewFacet} from "./RiskPreviewFacet.sol";

/**
 * @title PrecloseFacet
 * @author Vaipakam Developer Team
 * @notice Handles early repayment (preclose) for borrowers via three options:
 *      - Option 1: Direct preclose with full term interest.
 *      - Option 2: Transfer loan obligation to a new borrower
 *        (via an existing Borrower Offer).
 *      - Option 3: Offset by creating a new lender offer (two-step:
 *        create + complete after acceptance).
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

    // ─── Errors ──────────────────────���─────────────────────────────────��────

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidNewBorrower();
    error InvalidOfferTerms();
    error InsufficientCollateral();
    error OffsetNotLinked();
    error OffsetOfferNotAccepted();
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
    /// #1001 (S3, Codex #1070) — an offset can't be opened while a lender sale
    /// listing (`loanToSaleOfferId`) is live on the same loan; the two close-out
    /// flows would race and leave one vehicle stale. Symmetric to
    /// `EarlyWithdrawalFacet.OffsetActiveOnLoan`.
    error SaleListingActiveOnLoan();

    /// @dev Pass-2 A1/D5 (#1189) — shared maturity/grace gate for the early-close
    ///      paths (`precloseDirect`, offset completion), matching
    ///      {RepayFacet.repayLoan}. Reverts strictly past the grace window so a
    ///      late borrower can't route around the late-fee penalty (and the
    ///      DefaultedFacet resolution) via an early-close door; returns `endTime`
    ///      (the fixed origination maturity) so the caller computes the late fee
    ///      off the SAME reference. `private` so the gate is one JUMP target, not
    ///      inlined at each call site — this facet is EIP-170-maxed (#1124).
    function _assertWithinGrace(
        LibVaipakam.Loan storage loan
    ) private view returns (uint256 endTime) {
        endTime = uint256(loan.startTime) + uint256(loan.durationDays) * LibVaipakam.ONE_DAY;
        if (block.timestamp > endTime + LibVaipakam.gracePeriod(loan.durationDays)) {
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
        // Tier-1 sanctions gate — preclose routes funds back to
        // msg.sender (borrower closing early); sanctioned blocked.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // Phase 6: borrower-entitled strategic flow. Authority follows the
        // current borrower-NFT owner OR a keeper with the InitPreclose
        // action bit.
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE,
            loan,
            /* lenderSide */ false
        );
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();

        // Pass-2 A1/D5 (#1189) — block a strictly-post-grace preclose (parity
        // with repayLoan; post-grace resolution goes through DefaultedFacet) and
        // capture the fixed maturity so each asset branch below charges the same
        // late-fee penalty when the close lands in the grace window.
        uint256 endTime = _assertWithinGrace(loan);

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
            uint256 lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
            LibSettlement.ERC20Settlement memory plan = LibSettlement.computePreclose(loan, lateFee);

            // Lender Yield Fee discount (Tokenomics §6): when the lender has
            // platform-level VPFI-discount consent AND holds >= the required
            // VPFI in vault, the 1% treasury cut is paid in VPFI from the
            // lender's vault and the lender keeps 100% of interest in the
            // lending asset. tryApplyYieldFee is a silent fallback.
            uint256 yieldVpfiDeducted;
            if (s.vpfiDiscountConsent[loan.lender] && plan.treasuryShare > 0) {
                bool yieldApplied;
                // Pass-2 A1/D5 (#1189) — base the VPFI treasury-cut equivalent on
                // `interest + lateFee` and let the lender keep the whole
                // `interest + lateFee` in the lending asset, mirroring
                // {RepayFacet.repayLoan}. Otherwise a yield-discounted grace-window
                // preclose would silently drop the late fee from the lender's due.
                (yieldApplied, yieldVpfiDeducted) = LibVPFIDiscount
                    .tryApplyYieldFee(
                        loan,
                        plan.interest + plan.lateFee
                    );
                if (yieldApplied) {
                    plan.lenderShare = plan.interest + plan.lateFee;
                    plan.lenderDue = plan.principal + plan.lenderShare;
                    plan.treasuryShare = 0;
                }
            }

            // Treasury fee transferred immediately (skipped when satisfied in VPFI).
            if (plan.treasuryShare > 0) {
                IERC20(loan.principalAsset).safeTransferFrom(
                    msg.sender,
                    LibFacet.getTreasury(),
                    plan.treasuryShare
                );
                LibFacet.recordTreasuryAccrual(loan.principalAsset, plan.treasuryShare);
            }

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
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultDepositERC20From.selector,
                    msg.sender,        // payer — borrower
                    loan.lender,       // user — lender's vault
                    loan.principalAsset,
                    plan.lenderDue
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

            _setLoanClaimable(loan, loanId);
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

            // Phase 5 / §5.2b — proper-close settlement for borrower LIF
            // VPFI path. Splits Diamond-held VPFI into borrower rebate +
            // treasury share based on time-weighted avg discount BPS.
            // No-op on loans that paid LIF in the lending asset.
            LibVPFIDiscount.settleBorrowerLifProper(loan);

            emit LoanPreclosedDirect(loanId, msg.sender, plan.interest);
            emit LoanSettlementBreakdown(
                loanId,
                plan.principal,
                plan.interest,
                plan.lateFee,
                plan.treasuryShare,
                plan.lenderShare
            );

            // Passthrough event for lender yield-fee VPFI discount so indexers
            // subscribe to a single facet for all VPFI-discount analytics.
            if (yieldVpfiDeducted > 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VPFIDiscountFacet.emitYieldFeeDiscountApplied.selector,
                        loanId,
                        loan.lender,
                        loan.principalAsset,
                        yieldVpfiDeducted
                    ),
                    IVaipakamErrors.TreasuryTransferFailed.selector
                );
            }
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
            uint256 rentalLateFee = LibVaipakam.calculateRentalLateFee(loanId, endTime);
            uint256 totalDue = fullRental + rentalLateFee;
            (uint256 treasuryFee, uint256 lenderShare) = LibEntitlement.splitTreasury(
                loan,
                totalDue
            );

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
            if (treasuryFee > 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        loan.borrower,
                        loan.prepayAsset,
                        LibFacet.getTreasury(),
                        treasuryFee
                    ),
                    IVaipakamErrors.TreasuryTransferFailed.selector
                );
                LibFacet.recordTreasuryAccrual(loan.prepayAsset, treasuryFee);
            }

            // T-037 — vault → vault direct, no Diamond intermediate.
            // `vaultWithdrawERC20` accepts an arbitrary recipient
            // (it's just `safeTransfer(recipient, amount)` from inside
            // the borrower's vault), so we pass the lender's vault
            // straight in. Saves one transfer + removes a transient
            // Diamond `prepayAsset` balance.
            // #574 — source from `loan.borrower`, not `msg.sender` (same
            // transferred-position / keeper reasoning as the treasury-fee
            // deduction above): the lender's rental income comes out of the
            // borrower's prepay, which lives in the original borrower's vault.
            // #998 S10 note: see the ERC20 branch — the flagged-STORED-lender
            // brick on this resolution is the same pre-existing #821 gap deferred
            // to the PrecloseFacet-split follow-up (#1124); the S10 markers here
            // protect the transferred-flagged-holder case, which resolves a clean
            // stored `loan.lender` and succeeds.
            address lenderVault = LibFacet.getOrCreateVault(loan.lender);
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    loan.borrower,
                    loan.prepayAsset,
                    lenderVault,
                    lenderShare
                ),
                IVaipakamErrors.VaultWithdrawFailed.selector
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
            _resetNftRenter(loan);

            _setLoanClaimable(loan, loanId);
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
        // {RepayFacet.repayLoan} convention (Codex #1061 P2). Best-effort hook
        // (see {_rewardHook}).
        uint256 graceEnd = loan.startTime
            + loan.durationDays * LibVaipakam.ONE_DAY
            + LibVaipakam.gracePeriod(loan.durationDays);
        _rewardHook(
            abi.encodeWithSelector(
                InteractionRewardsFacet.precloseRewardClose.selector,
                loanId,
                block.timestamp <= graceEnd // borrowerClean
            )
        );
    }

    /// @dev #969 / S5 — best-effort reward-lifecycle hook. Two purposes:
    ///      (1) the reward call-graph lives on {InteractionRewardsFacet}, not
    ///          inlined into this EIP-170-bounded facet; and
    ///      (2) reward bookkeeping is STRICTLY SUBORDINATE to the fund-critical
    ///          preclose — the close (borrower reclaims collateral) must never
    ///          revert because of reward accounting, so the low-level call's
    ///          failure is intentionally not bubbled. Production always cuts
    ///          InteractionRewardsFacet (deploy-sanity guarantees full-surface
    ///          routing) so the hook always runs there; a focused test harness
    ///          that omits that facet simply skips reward bookkeeping. The
    ///          hook's effect is asserted by RewardLifecycleCloseTest on the
    ///          full diamond.
    function _rewardHook(bytes memory data) private {
        (bool ok, ) = address(this).call(data);
        if (!ok) {
            // best-effort — see doc above; the close proceeds regardless.
        }
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
     */
    function transferObligationViaOffer(
        uint256 loanId,
        uint256 borrowerOfferId
    ) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 — transferObligation rewrites
        // `loan.borrower` + `loan.collateralAmount` + the borrower
        // NFT; the v1.1 commit's `lopAtCommit` pin and orderHash
        // would describe a stale baseline. Block while live.
        LibVaipakam.assertNoLiveIntentCommit(loanId);
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
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE,
            loan,
            /* lenderSide */ false
        );
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
            IERC721(address(this)).ownerOf(loan.borrowerTokenId)
        );
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();

        LibVaipakam.Offer storage offer = s.offers[borrowerOfferId];
        if (offer.offerType != LibVaipakam.OfferType.Borrower || offer.accepted)
            revert InvalidOfferTerms();
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
                > loan.startTime + loan.durationDays * LibVaipakam.ONE_DAY
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
        // through unchanged.
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
        uint256 elapsed = block.timestamp - LibVaipakam.interestAccrualStartOf(loan);
        uint256 totalSecs = LibVaipakam.interestRemainingDaysOf(loan) * 1 days;
        uint256 remainingSecs = totalSecs > elapsed ? totalSecs - elapsed : 0;
        uint256 newSecs = offer.durationDays * 1 days;
        uint256 accruedInterest = LibEntitlement.proRataInterestSeconds(
            loan.principal, loan.interestRateBps, elapsed
        );
        // #915 (M7) — credit interest already forwarded to the lender via
        // periodic auto-liquidation (`loan.interestSettled`, saturating at 0)
        // so the exiting borrower is not billed a second time for it. Mirrors
        // the offset (Option 3) `_computeOffsetSettlement` netting and the
        // proper-close `settlementInterestNet`; the accrual clock is not reset
        // by periodic settlement, so the raw accrual still spans those periods.
        accruedInterest = LibEntitlement.creditSettledInterest(loan, accruedInterest);

        uint256 originalExpectedRemaining = LibEntitlement.proRataInterestSeconds(
            loan.principal, loan.interestRateBps, remainingSecs
        );
        uint256 newExpectedRemaining = LibEntitlement.proRataInterestSeconds(
            loan.principal, offer.interestRateBps, newSecs
        );
        uint256 shortfall = originalExpectedRemaining > newExpectedRemaining
            ? originalExpectedRemaining - newExpectedRemaining
            : 0;

        // ── 2. alice pays accrued + shortfall ───────────────────────────────
        (uint256 treasuryFee, ) = LibEntitlement.splitTreasury(loan, accruedInterest);
        uint256 lenderShare = accruedInterest - treasuryFee + shortfall;

        address payAsset = _paymentAsset(loan);
        if (treasuryFee > 0) {
            IERC20(payAsset).safeTransferFrom(
                msg.sender,
                LibFacet.getTreasury(),
                treasuryFee
            );
            LibFacet.recordTreasuryAccrual(payAsset, treasuryFee);
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
        address exitingBorrowerHolder = LibERC721.ownerOf(loan.borrowerTokenId);
        if (loan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    loan.borrower,
                    loan.collateralAsset,
                    exitingBorrowerHolder,
                    loan.collateralAmount
                ),
                IVaipakamErrors.VaultWithdrawFailed.selector
            );
        } else if (loan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC721.selector,
                    loan.borrower,
                    loan.collateralAsset,
                    loan.collateralTokenId,
                    exitingBorrowerHolder
                ),
                IVaipakamErrors.VaultWithdrawFailed.selector
            );
        } else if (loan.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC1155.selector,
                    loan.borrower,
                    loan.collateralAsset,
                    loan.collateralTokenId,
                    loan.collateralQuantity,
                    exitingBorrowerHolder
                ),
                IVaipakamErrors.VaultWithdrawFailed.selector
            );
        }

        // ── 4. ben's collateral already locked in his vault at offer creation

        // ── 5. Update loan to reflect ben as borrower ───────────────────────
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
        // T-034 — startTime downsized to uint64; explicit cast.
        loan.startTime = uint64(block.timestamp);
        // #641 — offset re-originates the obligation under a new term; mirror
        // the interest-accrual clock onto it (validated 1..365 ⇒ uint16 exact).
        loan.interestAccrualStart = uint64(block.timestamp);
        loan.interestRemainingDays = uint16(offer.durationDays);
        loan.interestRateBps = offer.interestRateBps;
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
        // #1061 P2). Best-effort reward hook (see {_rewardHook}).
        _rewardHook(
            abi.encodeWithSelector(
                InteractionRewardsFacet.precloseRewardTransferObligation.selector,
                loanId
            )
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
        // transfer path that this PR newly liens.)
        if (loan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
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
                s.protocolTrackedVaultBalance[newBorrower][loan.collateralAsset];
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
                    VaultFactoryFacet.vaultSetNFTUser.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    address(0),
                    0
                ),
                IVaipakamErrors.NFTRenterUpdateFailed.selector
            );
            // Assign ben as new user for remaining duration
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultSetNFTUser.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
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
        LibLoan.migrateBorrowerPosition(loanId, newBorrower);

        // Burn ben's offer position NFT (offer is consumed)
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
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
            uint64(loan.startTime + loan.durationDays * 1 days),
            newHf
        );
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
     *      NFT on any marketplace. See LibERC721.LockReason.PrecloseOffset.
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
     * @return newOfferId The ID of the newly created offset lender offer.
     */
    function offsetWithNewOffer(
        uint256 loanId,
        uint256 interestRateBps,
        uint256 durationDays,
        address collateralAsset,
        uint256 collateralAmount,
        bool creatorRiskAndTermsConsent,
        address prepayAsset
    ) external nonReentrant whenNotPaused returns (uint256 newOfferId) {
        // T-090 v1.1 (#389) §5.8 — offset writes a new offer that
        // settles against `loan.collateralAmount`; same custody-
        // conflict rationale as the other PrecloseFacet entry
        // points.
        LibVaipakam.assertNoLiveIntentCommit(loanId);
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
     */
    function _validateOffsetRequest(
        LibVaipakam.Loan storage loan,
        uint256 durationDays,
        address collateralAsset,
        uint256 collateralAmount,
        address prepayAsset
    ) private view {
        // Phase 6: borrower-entitled strategic flow (Preclose Option 3).
        // Authority binds to current borrower-NFT owner OR a keeper with
        // the InitPreclose action bit.
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE,
            loan,
            /* lenderSide */ false
        );
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
                > loan.startTime + loan.durationDays * LibVaipakam.ONE_DAY
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
        // The NFT stays with the initiator, but ERC-721 transfer/approve is
        // blocked at the library level for the duration of the offset flow.
        // Lock is cleared in completeOffset (success) or OfferFacet.cancelOffer
        // (cancel). See LibERC721.LockReason.
        LibERC721._lock(loan.borrowerTokenId, LibERC721.LockReason.PrecloseOffset);
        // #1001 (S3, Codex #1070 r6 P3) — emit the ACTUAL offset creator (the
        // borrower-position holder that owns + funds the offer and can cancel it),
        // NOT `msg.sender` — which on the keeper-triggered path is the keeper.
        // Matches the `offsetCreator` passed to `createOfferInternal` so indexers
        // attribute the pending offset to the right party.
        emit OffsetOfferCreated(
            loanId,
            newOfferId,
            IERC721(address(this)).ownerOf(loan.borrowerTokenId),
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
    function _computeOffsetSettlement(
        LibVaipakam.Loan storage loan,
        uint256 interestRateBps,
        uint256 durationDays,
        uint256 lateFee
    )
        private
        view
        returns (uint256 treasuryFee, uint256 lenderTotal)
    {
        // #641 — read the interest clock, not the immutable term tuple.
        uint256 elapsed = block.timestamp - LibVaipakam.interestAccrualStartOf(loan);
        uint256 totalSecs = LibVaipakam.interestRemainingDaysOf(loan) * 1 days;
        uint256 remainingSecs = totalSecs > elapsed ? totalSecs - elapsed : 0;
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
        (treasuryFee, ) = LibEntitlement.splitTreasury(loan, accruedInterest + lateFee);
        lenderTotal = loan.principal + (accruedInterest + lateFee - treasuryFee) + shortfall;
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
        // Pass-2 A1/D5 (#1189) — late fee off the original loan's fixed maturity
        // (0 within term). Defensive parity with the other early-close paths.
        uint256 lateFee = LibVaipakam.calculateLateFee(
            loanId,
            uint256(loan.startTime) + uint256(loan.durationDays) * LibVaipakam.ONE_DAY
        );
        (uint256 treasuryFee, uint256 lenderTotal) = _computeOffsetSettlement(
            loan, offer.interestRateBps, offer.durationDays, lateFee
        );
        address payAssetOffset = _paymentAsset(loan);
        if (treasuryFee > 0) {
            IERC20(payAssetOffset).safeTransferFrom(
                loan.borrower,               // payer — Alice (standing allowance)
                LibFacet.getTreasury(),
                treasuryFee
            );
            LibFacet.recordTreasuryAccrual(payAssetOffset, treasuryFee);
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
        address offsetCreator = IERC721(address(this)).ownerOf(loan.borrowerTokenId);
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
        // #1032 (L-c) — the offset offer is left GTC (`expiresAt == 0`). The
        // replacement-maturity anti-drift guarantee is NOT enforced via
        // `expiresAt` here (an earlier attempt to do so, Codex #1069 rounds 1-2,
        // could produce `expiresAt == now` for a legitimate same-term-at-start
        // offset — `durationDays == remaining` at elapsed 0 — which `createOffer`
        // rejects, breaking a valid lender-swap). Instead the bound is re-checked
        // at ACCEPTANCE inside `_completeOffsetImpl`, which fires atomically in
        // the accepting tx (so `block.timestamp` there IS the replacement loan's
        // fresh start): a drifting term reverts the whole acceptance, rolling the
        // replacement loan back cleanly. See the guard there.
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
                > loan.startTime + loan.durationDays * LibVaipakam.ONE_DAY
        ) revert InvalidOfferTerms();

        // Phase 6: borrower-entitled action. Authority resolves against
        // the current borrower-NFT holder OR a keeper with the
        // CompleteOffset action bit.
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_COMPLETE_OFFSET,
            loan,
            /* lenderSide */ false
        );

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
            _resetNftRenter(loan);
        }
        // (Parallel-sale listing cleanup moved ABOVE the consolidation — see the
        // Codex #1070 r8 P2 note there.)

        // Close original loan — offset completion transitions Active -> Repaid.
        _setLoanClaimable(loan, originalLoanId);
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
        // #1061 P2). Best-effort reward hook (see {_rewardHook}).
        uint256 offsetGraceEnd = loan.startTime
            + loan.durationDays * LibVaipakam.ONE_DAY
            + LibVaipakam.gracePeriod(loan.durationDays);
        _rewardHook(
            abi.encodeWithSelector(
                InteractionRewardsFacet.precloseRewardClose.selector,
                originalLoanId,
                block.timestamp <= offsetGraceEnd // borrowerClean
            )
        );

        // Phase 5 / §5.2b — proper-close settlement on the offset path.
        // The original borrower held VPFI (if applicable) across the old
        // loan's lifetime and now settles; rebate is credited for the
        // time-weighted period they actually held.
        LibVPFIDiscount.settleBorrowerLifProper(loan);

        // Release the native transfer lock on the borrower-side NFT. The
        // original loan is now Repaid; the initiator retains the NFT to
        // later claim back the original collateral via ClaimFacet.
        LibERC721._unlock(loan.borrowerTokenId);

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

    // ─── Internal Helpers ─────────────────────────��─────────────────────────

    /// @dev Returns the correct ERC20 payment asset for a loan (prepayAsset for NFT rentals, principalAsset for ERC20 loans).
    function _paymentAsset(
        LibVaipakam.Loan storage loan
    ) internal view returns (address) {
        return
            loan.assetType == LibVaipakam.AssetType.ERC20
                ? loan.principalAsset
                : loan.prepayAsset;
    }

    // #1032 (L-c) — `_remainingDays` removed: its two callers (Option-2 +
    // Option-3 term gates) now bound the replacement MATURITY with second
    // precision instead of comparing up-rounded whole-day remaining counts.

    function _resetNftRenter(LibVaipakam.Loan storage loan) internal {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultSetNFTUser.selector,
                loan.lender,
                loan.principalAsset,
                loan.tokenId,
                address(0),
                0
            ),
            IVaipakamErrors.NFTRenterUpdateFailed.selector
        );
    }

    function _setLoanClaimable(
        LibVaipakam.Loan storage loan,
        uint256 loanId
    ) internal {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            IVaipakamErrors.NFTStatusUpdateFailed.selector
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            IVaipakamErrors.NFTStatusUpdateFailed.selector
        );
    }
}
