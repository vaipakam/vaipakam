// src/facets/EarlyWithdrawalFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibCompliance} from "../libraries/LibCompliance.sol";
import {LibRiskAccess} from "../libraries/LibRiskAccess.sol";
import {LibLoan} from "../libraries/LibLoan.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LenderIntentFacet} from "./LenderIntentFacet.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {OfferCreateFacet} from "./OfferCreateFacet.sol";

/**
 * @title EarlyWithdrawalFacet
 * @author Vaipakam Developer Team
 * @notice Lender early-withdrawal by selling their loan position to a new
 *         lender (Options 1 & 2 per README §9).
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *      ERC-20 loans only (NFT rental lender-sale requires NFT custody
 *      transfer — not supported in Phase 1).
 *
 *      Option 1 — {sellLoanViaBuyOffer}: liam accepts an existing Lender
 *      Offer from Noah. Noah's principal goes to liam (minus any rate
 *      shortfall); liam forfeits accrued interest to treasury.
 *
 *      Option 2 — two-step:
 *        a) {createLoanSaleOffer}: liam creates a borrower-style sale
 *           offer linked to the live loan via `saleOfferToLoanId`.
 *        b) A new lender accepts the sale offer (via {OfferFacet.acceptOffer},
 *           which atomically calls {completeLoanSale}). The live loan's
 *           lender field is updated to the new lender, new NFTs are minted,
 *           old NFTs burned, and accrued interest forfeited to treasury.
 *
 *      Sanctions/KYC enforced via {LibCompliance}. The borrower and loan
 *      terms are unchanged — only the lender relationship transfers.
 */
contract EarlyWithdrawalFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;

    /// @notice Emitted when a loan is sold to a new lender.
    /// @param loanId The ID of the sold loan.
    /// @param originalLender The original lender's address.
    /// @param newLender The new lender's address.
    /// @param shortfallPaid Any shortfall amount paid by original lender.
    /// @param newLenderTokenId Position-NFT id minted for the new lender.
    /// @param newInterestRateBps Loan's interest rate AFTER the sale.
    ///        Unchanged in the lender-side sale path (borrower-favourability
    ///        rule per README §9 keeps the rate fixed); included for
    ///        cache-row freshness so consumers can self-update without a
    ///        follow-up read.
    /// @param newDurationDays Loan's duration AFTER the sale (unchanged
    ///        for the same reason).
    /// @param newDueTimestamp Computed maturity timestamp
    ///        (`startTime + durationDays * 1 days`) — also unchanged on
    ///        a sale, but explicit for consumer convenience.
    ///        EventSourcingAudit §3.15.
    /// @custom:event-category state-change/loan-mutation
    event LoanSold(
        uint256 indexed loanId,
        address indexed originalLender,
        address indexed newLender,
        uint256 shortfallPaid,
        uint256 newLenderTokenId,
        uint256 newInterestRateBps,
        uint256 newDurationDays,
        uint64 newDueTimestamp
    );

    /// @notice Emitted when a loan sale offer is created and linked to a live loan (Option 2, step 1).
    /// @param loanId The live loan being sold.
    /// @param saleOfferId The borrower-style offer created to execute the sale.
    /// @custom:event-category state-change/loan-mutation
    event LoanSaleOfferLinked(
        uint256 indexed loanId,
        uint256 indexed saleOfferId
    );

    /// @notice Emitted when a loan sale is completed via Option 2.
    /// @custom:event-category state-change/loan-mutation
    event LoanSaleCompleted(
        uint256 indexed loanId,
        address indexed originalLender,
        address indexed newLender
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidSaleOffer();
    error RateShortfallTooHigh();
    error SaleNotLinked();
    error SaleOfferNotAccepted();

    /// @dev #671 phase 2 (Codex #729 r4) — the buyer-side progressive-risk gate
    ///      for the direct Option-1 loan sale. Kept in its own frame so the
    ///      PairId locals + classification chain do not add to the already-deep
    ///      `sellLoanViaBuyOffer` stack (viaIR stack ceiling). Standing-consent
    ///      semantics — the buy offer carries no #662 acknowledgement for this
    ///      loan's assets. Behind the off-by-default master switch.
    function _assertBuyerRiskAccess(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        address buyer
    ) private view {
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return;
        LibRiskAccess.assertActorMayTransact(
            s,
            buyer,
            LibRiskAccess.PairId({
                lendAsset: loan.principalAsset,
                lendType: loan.assetType,
                lendTokenId: loan.tokenId,
                collAsset: loan.collateralAsset,
                collType: loan.collateralAssetType,
                collTokenId: loan.collateralTokenId,
                prepayAsset: loan.prepayAsset
            })
        );
    }

    /**
     * @notice Allows original lender to sell an active loan by accepting a new Lender Offer.
     * @dev Option 1: liam accepts Noah's Lender Offer. Transfers principal, forfeits accrued to treasury,
     *      calculates/pays shortfall if rates differ. Updates NFTs, loan lender.
     *      Callable only by original lender. Emits LoanSold.
     * @param loanId The active loan ID to sell.
     * @param buyOfferId The new Lender Offer ID from Noah.
     */
    function sellLoanViaBuyOffer(
        uint256 loanId,
        uint256 buyOfferId
    ) external nonReentrant whenNotPaused {
        // Tier-1 sanctions gate — selling a loan routes funds back
        // to msg.sender (the lender exiting early).
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // Strategic flow — authority binds to current lender-side NFT owner.
        LibAuth.requireLenderNftOwner(loan);
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();
        // NFT rental lender-sale requires NFT custody transfer — not supported in Phase 1
        if (loan.assetType != LibVaipakam.AssetType.ERC20)
            revert InvalidSaleOffer();

        // Per-asset pause: direct lender swap-in is a creation path (Noah
        // steps into new exposure without going through acceptOffer). The
        // exit path for the old lender is still covered via claim/repay.
        LibFacet.requireAssetNotPaused(loan.principalAsset);
        LibFacet.requireAssetNotPaused(loan.collateralAsset);

        LibVaipakam.Offer storage buyOffer = s.offers[buyOfferId];
        if (
            buyOffer.offerType != LibVaipakam.OfferType.Lender ||
            buyOffer.accepted
        ) revert InvalidSaleOffer();
        // T-407-C (#566) Codex P2 — the loan sale consumes the buy offer
        // in full, so it must be a clean SINGLE-VALUE, UNFILLED offer:
        //   • Ranged (effective amountMax > amount): the offer pre-vaults
        //     and liens the ceiling, but the refund below only returns
        //     `amount - principal`, stranding `amountMax - amount` in the
        //     seller's vault with no cancel path (the offer is marked
        //     accepted here).
        //   • Partially filled (amountFilled > 0): only the residual is
        //     vaulted, so the full-amount principal + refund withdrawals
        //     would revert, or over-consume the seller's unrelated free
        //     balance.
        // Both shapes stay usable for ordinary matching — just not as a
        // loan-sale vehicle. With this guard the existing refund
        // (`amount - principal`) is provably exact (vault holds exactly
        // `amount`).
        {
            uint256 effMax = buyOffer.amountMax == 0
                ? buyOffer.amount
                : buyOffer.amountMax;
            if (effMax != buyOffer.amount || buyOffer.amountFilled != 0) {
                revert InvalidSaleOffer();
            }
        }
        // Enforce same asset types as original loan (README General Rules: lending, collateral, prepay)
        if (buyOffer.lendingAsset != loan.principalAsset)
            revert InvalidSaleOffer();
        if (buyOffer.collateralAsset != loan.collateralAsset)
            revert InvalidSaleOffer();
        if (buyOffer.collateralAssetType != loan.collateralAssetType)
            revert InvalidSaleOffer();
        if (buyOffer.prepayAsset != loan.prepayAsset) revert InvalidSaleOffer();

        // Borrower-favorability: Noah's terms must not worsen alice's position (README Section 9)
        {
            uint256 elapsedSecs = block.timestamp - loan.startTime;
            uint256 remainDays = loan.durationDays > (elapsedSecs / 1 days)
                ? loan.durationDays - (elapsedSecs / 1 days)
                : 0;
            if (buyOffer.durationDays > remainDays) revert InvalidSaleOffer();
            if (buyOffer.collateralAmount > loan.collateralAmount)
                revert InvalidSaleOffer();
        }

        // ── Sanctions & KYC: new lender (Noah) must pass normal initiation checks ─
        LibCompliance.enforceCountryAndKyc(
            address(this),
            buyOffer.creator,
            loan.borrower,
            loan.principalAsset,
            loan.principal,
            loan.collateralAsset,
            loan.collateralAmount
        );

        // #671 phase 2 (Codex #729 r4) — re-gate the BUYER against the loan's
        // asset pair. This direct Option-1 sale bypasses acceptOffer /
        // initiateLoan, so the accept-time progressive-risk gate in LoanFacet
        // never runs; without this re-check a buy offer authored before the gate
        // was enabled (or whose creator has since down-tiered, revoked the pair
        // consent, or gone stale after a terms bump) could still step into an
        // illiquid- or mid-tier-backed live loan. Extracted to a helper so the
        // PairId locals do not add to this function's (already deep) stack frame.
        _assertBuyerRiskAccess(s, loan, buyOffer.creator);

        // Snapshot pre-existing heldForLender before any new shortfall deposits.
        uint256 priorHeld = s.heldForLender[loanId];

        // ── Net settlement (README Section 9, Option 1) ────────────────────
        // Noah's principal is the only inflow.  liam's share (principal minus
        // his cost) is paid out net; treasury cut and Noah's shortfall deposit
        // come from the same bucket — liam never needs to pre-approve tokens.
        //   liamCost    = max(accrued, shortfall)
        //   treasuryCut = max(accrued - shortfall, 0)   (unused forfeited accrued)
        //   toNoahHeld  = shortfall                     (compensates Noah)
        //   toLiam      = principal - liamCost
        // Unified seconds-based precision: both accrued and remaining use
        // SECONDS_PER_YEAR so any sub-day remainder is preserved and rounding
        // is symmetric across the two sides of the net settlement.
        // #641 — accrued/remaining split reads the interest clock (post-partial
        // origin + remaining term), not the immutable term tuple.
        uint256 elapsed = block.timestamp - LibVaipakam.interestAccrualStartOf(loan);
        uint256 totalSecs = LibVaipakam.interestRemainingDaysOf(loan) * 1 days;
        uint256 remainingSecs = totalSecs > elapsed ? totalSecs - elapsed : 0;

        uint256 accrued = (loan.principal * loan.interestRateBps * elapsed) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        uint256 originalRemainingInterest = (loan.principal *
            loan.interestRateBps *
            remainingSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        uint256 newRemainingInterest = (loan.principal *
            buyOffer.interestRateBps *
            remainingSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);

        uint256 shortfall = newRemainingInterest > originalRemainingInterest
            ? newRemainingInterest - originalRemainingInterest
            : 0;
        uint256 liamCost = accrued > shortfall ? accrued : shortfall;
        uint256 treasuryCut = accrued > shortfall ? accrued - shortfall : 0;

        if (buyOffer.amount < loan.principal) revert InvalidSaleOffer();
        // If liam's cost exceeds what Noah brings, net settlement cannot
        // complete — liam would owe tokens we never collected from him.
        if (liamCost > loan.principal) revert RateShortfallTooHigh();

        // T-407-C (#566) Codex P1 — release the buy offer's offer-principal
        // lock before consuming its principal. The Lender buy offer
        // pre-vaulted its principal at create, encumbered in the same
        // aggregate the #565 withdraw chokepoint reads. This sale
        // terminally consumes the offer (accepted = true + position-NFT
        // burn below), so release the lock in full BEFORE the principal +
        // excess withdrawals — otherwise the chokepoint sees free balance
        // = 0 and bricks the first withdraw. The NFT-burn at the end of
        // this function is too late to unblock these withdraws.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.releaseOfferPrincipalLien.selector,
                buyOfferId
            ),
            bytes4(0)
        );

        // Pull Noah's principal into the diamond in a single withdraw,
        // then fan out to liam / treasury / Noah's heldForLender.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                buyOffer.creator, // Noah
                loan.principalAsset,
                address(this),
                loan.principal
            ),
            VaultWithdrawFailed.selector
        );

        uint256 toLiam = loan.principal - liamCost;
        if (toLiam > 0) {
            IERC20(loan.principalAsset).safeTransfer(msg.sender, toLiam);
        }
        LibFacet.transferToTreasury(loan.principalAsset, treasuryCut);
        LibFacet.depositForNewLender(
            loan.principalAsset,
            buyOffer.creator,
            shortfall,
            loanId
        );

        // Refund any excess Noah deposited beyond the required principal.
        // Noah deposited buyOffer.amount when creating the Lender offer;
        // only loan.principal was withdrawn above.  Since accepted offers
        // cannot be cancelled, the excess would otherwise be stranded.
        uint256 excess = buyOffer.amount - loan.principal;
        if (excess > 0) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    buyOffer.creator,
                    loan.principalAsset,
                    buyOffer.creator, // Refund back to Noah
                    excess
                ),
                VaultWithdrawFailed.selector
            );
        }

        // #597 — release the old lender's held-for-lender VPFI reservation
        // BEFORE the physical migration withdraws it from their vault below:
        // the #565 withdraw chokepoint would otherwise see the held as
        // encumbered and brick the withdraw. `loan.lender` is still the old
        // lender here (migrated below). No-op for a non-VPFI / never-reserved
        // loan. The full held is re-reserved on the new lender after the
        // position migrates (see end of this block).
        LibEncumbrance.releaseLenderProceeds(loanId, loan.lender);

        // Migrate only the pre-existing heldForLender from old lender's vault to new lender's.
        // priorHeld was snapshotted before any shortfall deposits in this transaction.
        if (priorHeld > 0) {
            address payAsset = loan.assetType == LibVaipakam.AssetType.ERC20
                ? loan.principalAsset
                : loan.prepayAsset;
            // #597 Codex #672 P1 — withdraw the held from the STORED `loan.lender`,
            // NOT `msg.sender`. The held was deposited into `loan.lender`'s vault
            // at accrual and the #597 reservation (released just above) is keyed
            // there too. After a plain lender-NFT transfer (pre-consolidation),
            // `msg.sender` (the current NFT owner accepted by
            // `requireLenderNftOwner`) ≠ `loan.lender`; sourcing from `msg.sender`
            // would migrate the caller's OWN VPFI and leave the stored lender's
            // released-but-not-moved held unencumbered + drainable. In the common
            // sell-your-own-loan case `msg.sender == loan.lender` so this is
            // unchanged. (`completeLoanSale` already uses `originalLender`.)
            //
            // #597 Codex #672 P2 — the stored `loan.lender` may have been
            // sanctions-flagged after a plain lender-NFT transfer; they are
            // LOSING custody (their held VPFI is pushed OUT to the new lender),
            // so the Tier-1 vault gate must not brick this Tier-2 sale for the
            // unflagged seller. Open the address-scoped exemption around ONLY
            // this from-side withdrawal (same primitive as the #594 consolidation
            // move). The host is `nonReentrant`; cleared immediately after.
            s.consolidationMoveFromUser = loan.lender;
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    loan.lender, // stored (old) lender — where the held VPFI sits
                    payAsset,
                    address(this),
                    priorHeld
                ),
                VaultWithdrawFailed.selector
            );
            s.consolidationMoveFromUser = address(0);
            address newVault = LibFacet.getOrCreateVault(buyOffer.creator);
            IERC20(payAsset).safeTransfer(newVault, priorHeld);
            // T-051 — Diamond-side transfer to new lender's vault
            // ticks the protocolTrackedVaultBalance counter.
            LibVaipakam.recordVaultDeposit(buyOffer.creator, payAsset, priorHeld);
        }

        // Migrate lender position: burn old NFT + mint new LoanInitiated NFT
        // for Noah, update loan.lender and loan.lenderTokenId in one place.
        LibLoan.migrateLenderPosition(loanId, buyOffer.creator);

        // #597 — re-reserve the FULL held-for-lender VPFI on the NEW lender,
        // where it now physically lives (pre-existing `priorHeld` migrated above
        // + this tx's `shortfall` deposit). `loan.lender` is now the new lender.
        // Released to the new lender at claim. Gated on VPFI (held is in the
        // principal asset; NFT-rental prepay can't be VPFI — D-2).
        if (loan.principalAsset == s.vpfiToken) {
            LibEncumbrance.encumberLenderProceeds(
                loanId, loan.lender, loan.principalAsset, s.heldForLender[loanId]
            );
        }

        // Old lender forfeits interaction rewards to treasury; new lender
        // gets a fresh entry covering the residual loan window.
        LibInteractionRewards.transferLenderEntry(loanId, buyOffer.creator);

        // Mark buyOffer accepted
        buyOffer.accepted = true;
        LibMetricsHooks.onOfferAccepted(buyOffer.id);

        // Burn the consumed offer's position NFT (stale "Offer Created" artifact)
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                buyOffer.positionTokenId
            ),
            NFTBurnFailed.selector
        );

        emit LoanSold(
            loanId,
            msg.sender,
            buyOffer.creator,
            shortfall,
            loan.lenderTokenId,
            loan.interestRateBps,
            loan.durationDays,
            uint64(loan.startTime + loan.durationDays * 1 days)
        );
    }

    /**
     * @notice Allows original lender to create a sale offer mimicking a Borrower Offer (Option 2).
     * @dev WARNING — front-ends MUST surface this to the caller before they
     *      sign: the lender-side position NFT for `loanId` is NATIVELY
     *      LOCKED against transfer/approve from the moment this call
     *      succeeds. The lock persists until either a new lender accepts
     *      the sale offer (at which point the NFT is burned and replaced
     *      via {completeLoanSale}) or the initiator cancels via
     *      {OfferFacet.cancelOffer}. During that window the holder cannot
     *      list, sell, transfer, or approve the NFT on any marketplace.
     *      See LibERC721.LockReason.EarlyWithdrawalSale.
     *
     *      liam creates offer for his loan position; new lender accepts via OfferFacet.acceptOffer.
     *      Terms: Remaining duration, same assets/collateral. Links offer to loan via new mapping.
     *      Callable only by original lender. No event here (emitted on acceptance in OfferFacet).
     * @param loanId The loan ID to sell.
     * @param interestRateBps The sale interest rate (may differ from original).
     * @param creatorRiskAndTermsConsent Consent for illiquid assets (if applicable).
     */
    function createLoanSaleOffer(
        uint256 loanId,
        uint256 interestRateBps,
        bool creatorRiskAndTermsConsent
    ) external nonReentrant whenNotPaused {
        // Tier-1 sanctions gate — creating a sale offer is a state-
        // creating action by msg.sender; sanctioned wallet blocked.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // Phase 6: lender-entitled strategic flow. Authority binds to the
        // current lender-NFT owner OR a keeper with the
        // InitEarlyWithdraw action bit.
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_INIT_EARLY_WITHDRAW,
            loan,
            /* lenderSide */ true
        );
        // #819 Tier-1 sanctions on the LENDER-position holder. `requireKeeperFor`
        // authorises against the lender NFT owner, but a keeper caller leaves
        // that holder unscreened — and the eventual sale proceeds settle to the
        // seller (that holder). Screen the holder here at listing CREATION: no
        // buyer is committed yet, so an atomic revert strands no counterparty.
        // (The flagged-after-listing residual on `completeLoanSale` is the
        // deferred-proceeds liveness case tracked under #821.)
        // The exiting lender (current lender-NFT holder) is the sale offer's
        // real creator — proceeds and cancel authority bind to them, NOT to a
        // keeper caller. Capture once: used for the screen here and passed as
        // the `creator` into the internal offer-create hop below (#951).
        address seller = LibERC721.ownerOf(loan.lenderTokenId);
        LibVaipakam._assertNotSanctioned(seller);
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();
        // NFT rental lender-sale not supported in Phase 1
        if (loan.assetType != LibVaipakam.AssetType.ERC20)
            revert InvalidSaleOffer();

        // Calculate remaining days — revert if loan is past maturity
        uint256 elapsed = block.timestamp - loan.startTime;
        uint256 elapsedDays = elapsed / 1 days;
        if (elapsedDays >= loan.durationDays) revert InvalidSaleOffer();
        uint256 remainingDays = loan.durationDays - elapsedDays;

        // Create mimicking Borrower Offer via cross-facet call.
        // collateralAmount is set to 0 because this is a lender-position sale,
        // not a real borrower posting collateral.  alice's collateral on the
        // live loan continues to back it after the lender transfer.  Setting 0
        // avoids requiring liam to post fresh capital he shouldn't need.
        // #671 — exempt this protocol-authored sale-vehicle create from the
        // risk-access gate: the offer's risk is the EXITING lender's, already
        // gated at the original loan. The transient is shared storage so it
        // survives the cross-facet `createOfferInternal` hop, and is cleared
        // immediately after (a non-false value at rest is a bug).
        s.saleVehicleCreate = true;
        uint256 saleOfferId = _submitSaleOffer(
            loan,
            seller,
            remainingDays,
            interestRateBps,
            creatorRiskAndTermsConsent
        );
        s.saleVehicleCreate = false;
        s.loanToSaleOfferId[loanId] = saleOfferId;
        s.saleOfferToLoanId[saleOfferId] = loanId;

        // Native lock the lender-side position NFT for the duration of the
        // sale flow. The NFT stays with the initiator, but ERC-721
        // transfer/approve is blocked at the library level — this prevents
        // keeper front-running via a mid-flow secondary sale. Lock is
        // released (and the NFT burned) in completeLoanSale via
        // migrateLenderPosition → LibERC721._burn, or released in
        // OfferFacet.cancelOffer. See LibERC721.LockReason.
        LibERC721._lock(loan.lenderTokenId, LibERC721.LockReason.EarlyWithdrawalSale);

        emit LoanSaleOfferLinked(loanId, saleOfferId);
    }

    /**
     * @dev Builds the 18-field `CreateOfferParams` struct in its own frame
     *      and fires the cross-facet call. Extracted from
     *      {createLoanSaleOffer} so `forge coverage --ir-minimum` doesn't
     *      pile every `loan.X` SLOAD onto the caller's stack.
     */
    function _submitSaleOffer(
        LibVaipakam.Loan storage loan,
        address creator,
        uint256 remainingDays,
        uint256 interestRateBps,
        bool creatorRiskAndTermsConsent
    ) private returns (uint256 saleOfferId) {
        LibVaipakam.CreateOfferParams memory params = _buildSaleParams(
            loan,
            remainingDays,
            interestRateBps,
            creatorRiskAndTermsConsent
        );
        // #951 — call the INTERNAL create entry, not the external `createOffer`.
        // `createLoanSaleOffer` already holds the diamond-shared `nonReentrant`
        // guard, and the external `createOffer` re-enters that same guard via the
        // `address(this).call` hop → `ReentrancyGuardReentrantCall` every time.
        // `createOfferInternal` is `msg.sender == address(this)`-gated and takes
        // no reentrancy modifier (same pattern as `PrecloseFacet._submitOffsetOffer`).
        // The explicit `creator` is required because under `address(this).call`
        // `msg.sender` is the diamond — without it `offer.creator` would be
        // corrupted to the diamond instead of the exiting lender.
        bytes memory result = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(
                OfferCreateFacet.createOfferInternal.selector,
                creator,
                params
            ),
            OfferCreationFailed.selector
        );
        saleOfferId = abi.decode(result, (uint256));
    }

    function _buildSaleParams(
        LibVaipakam.Loan storage loan,
        uint256 remainingDays,
        uint256 interestRateBps,
        bool creatorRiskAndTermsConsent
    ) private view returns (LibVaipakam.CreateOfferParams memory params) {
        params.offerType = LibVaipakam.OfferType.Borrower;
        params.lendingAsset = loan.principalAsset;
        params.amount = loan.principal;
        params.interestRateBps = interestRateBps;
        params.collateralAsset = loan.collateralAsset;
        params.collateralAmount = 0;
        params.durationDays = remainingDays;
        params.assetType = loan.assetType;
        params.tokenId = loan.tokenId;
        params.quantity = loan.quantity;
        params.creatorRiskAndTermsConsent = creatorRiskAndTermsConsent;
        params.prepayAsset = loan.prepayAsset;
        params.collateralAssetType = loan.collateralAssetType;
        params.collateralTokenId = loan.collateralTokenId;
        params.collateralQuantity = loan.collateralQuantity;
        // #183 (PR #187 Codex P1) — Phase 2 OfferCreateFacet rejects
        // `amountMax == 0` / `interestRateBpsMax == 0`
        // (and `collateralAmountMax == 0` for ERC20+ERC20 non-sale-
        // vehicle offers). Internal builders must ship explicit values
        // matching the floors to preserve single-value semantics
        // byte-identically. The sale vehicle's
        // `collateralAmountMax = 0` mirrors `collateralAmount = 0` —
        // the OfferCreateFacet sale-vehicle exception (BOTH zero is
        // allowed) preserves the existing behaviour where collateral
        // for the resulting loan comes from the linked live loan, not
        // from a new commitment.
        params.amountMax = loan.principal;
        params.interestRateBpsMax = interestRateBps;
        params.collateralAmountMax = 0;
        // #408 / #410 / #413 (2026-06-12), Codex PR #559 round-1
        // P2: inherit the source loan's floor-model election so the
        // replacement loan settles under the same interest model.
        // Without this, a memory-default `false` would silently
        // opt out of the full-term floor on the new lender's books
        // — re-introducing the early-repay under-charge on every
        // internal builder flow (sale vehicle here, offset in
        // PrecloseFacet).
        params.useFullTermInterest = loan.useFullTermInterest;
        // Phase 6: keeper enables are per-keeper via
        // `offerKeeperEnabled[offerId][keeper]`. The outgoing lender (sale-
        // offer creator) can enable specific keepers on this sale offer
        // via `ProfileFacet.setOfferKeeperEnabled` after creation.
    }

    /**
     * @notice Step 2: Completes a loan sale after the borrower-style offer has been accepted.
     * @dev Normally invoked atomically from {OfferFacet.acceptOffer} in the
     *      same transaction as acceptance — users do NOT click a separate
     *      "Complete Sale" button under the happy path. This entry point is
     *      retained as a manual recovery hook (e.g., for sales accepted
     *      before auto-completion was introduced, or keeper-driven
     *      retries). Callable by the current lender-NFT holder OR a
     *      keeper with the COMPLETE_LOAN_SALE action bit and the
     *      per-loan enable for this loan (lender-entitled action).
     *      Verifies the linked sale offer was accepted, then:
     *      - Principal: Already transferred from Noah to liam by acceptOffer() (no second transfer).
     *      - Forfeits accrued interest to treasury (or applies toward shortfall).
     *      - Handles rate shortfall if applicable.
     *      - Updates loan.lender to Noah on the live loan.
     *      - Burns liam's lender NFT and mints one for Noah.
     *      - Cleans up the temporary loan created by acceptOffer() (burns its NFTs,
     *        releases liam's locked collateral, sets dummy claims so ClaimFacet doesn't block).
     * @param loanId The loan ID whose sale to complete.
     */
    function completeLoanSale(
        uint256 loanId
    ) external nonReentrant whenNotPaused {
        // Tier-1 sanctions gate — funds settle to msg.sender on
        // successful sale; sanctioned recipient blocked.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();

        uint256 saleOfferId = s.loanToSaleOfferId[loanId];
        if (saleOfferId == 0) revert SaleNotLinked();

        LibVaipakam.Offer storage saleOffer = s.offers[saleOfferId];
        if (!saleOffer.accepted) revert SaleOfferNotAccepted();

        // Phase 6: role-scoped keeper authority. Lender-entitled action, so
        // resolve against the lender NFT holder and require the
        // CompleteLoanSale bit on the holder's approved-keeper bitmask.
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_COMPLETE_LOAN_SALE,
            loan,
            /* lenderSide */ true
        );

        address originalLender = loan.lender;

        // #393 v1-b — the seller EXITS the loan here (receives sale proceeds and
        // hands the position to the buyer), so release their standing-intent
        // live-principal cap now rather than waiting for the buyer's eventual
        // claim (the buyer might never claim, stranding the seller's cap). Keyed
        // off the ORIGINATING intent so it frees the original owner's counter +
        // deletes the marker. Gated on the cheap per-loan origin check so a
        // non-intent loan skips the cross-facet hop entirely (no wasted gas, and
        // no dependency on LenderIntentFacet being routed).
        if (s.intentOrigin[loanId].owner != address(0)) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    LenderIntentFacet.releaseIntentExposure.selector, loanId
                ),
                bytes4(0)
            );
        }

        // ── Find the temporary loan via O(1) lookup ─────────────────────────
        uint256 tempLoanId = s.offerIdToLoanId[saleOfferId];
        if (tempLoanId == 0)
            revert LenderResolutionFailed();
        // For a Borrower-type offer: creator=liam is borrower, acceptor=Noah is lender
        address newLender = s.loans[tempLoanId].lender;
        if (newLender == address(0))
            revert LenderResolutionFailed();

        // Snapshot pre-existing heldForLender before any new shortfall deposits
        uint256 priorHeldSale = s.heldForLender[loanId];

        // ── Accrued interest & shortfall ────────────────────────────────────
        // "Forfeited accrued" means liam absorbs the cost — the borrower has
        // not paid this interest yet.  liam must fund every token that gets
        // routed to treasury or Noah.
        // #641 — accrued/remaining split reads the interest clock (post-partial
        // origin + remaining term), not the immutable term tuple.
        uint256 elapsed = block.timestamp - LibVaipakam.interestAccrualStartOf(loan);
        uint256 totalSecs = LibVaipakam.interestRemainingDaysOf(loan) * 1 days;
        uint256 remainingSecs = totalSecs > elapsed ? totalSecs - elapsed : 0;
        uint256 accrued = (loan.principal * loan.interestRateBps * elapsed) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        uint256 originalRemainingInterest = (loan.principal *
            loan.interestRateBps *
            remainingSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        uint256 saleRemainingInterest = (loan.principal *
            saleOffer.interestRateBps *
            remainingSecs) /
            (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);

        // T-037 — pay each destination directly from `originalLender`
        // (the wallet of liam, who approved the Diamond). The previous
        // pull-into-Diamond-then-split pattern incurred 1 transferFrom +
        // N transfers (3 transfers total in the worst case); the new
        // direct-transfer pattern is N transferFroms total (2 in the
        // worst case). Same accounting via the new
        // {transferFromPayerToTreasury} / {depositFromPayerForLender}
        // helpers — they record `treasuryBalances` and `heldForLender`
        // identically to the Diamond-resident variants.
        if (saleRemainingInterest > originalRemainingInterest) {
            uint256 shortfall = saleRemainingInterest -
                originalRemainingInterest;
            if (accrued >= shortfall) {
                uint256 excessAccrued = accrued - shortfall;
                LibFacet.transferFromPayerToTreasury(
                    originalLender,
                    loan.principalAsset,
                    excessAccrued
                );
                // #831 — vault-lock the buyer's (newLender) receive: a buyer
                // flagged AFTER committing the sale must not brick the completion
                // (which would strand the committed seller). The shortfall parks
                // frozen in the buyer's OWN vault behind the #821 freeze.
                LibSanctionedLock.begin(s, newLender);
                LibFacet.depositFromPayerForLender(
                    loan.principalAsset,
                    originalLender,
                    newLender,
                    shortfall,
                    loanId
                );
                LibSanctionedLock.end(
                    s, newLender, loanId, loan.principalAsset, shortfall
                );
            } else {
                uint256 remainingShortfall = shortfall - accrued;
                uint256 totalFromLiam = accrued + remainingShortfall;
                // #831 — same buyer-receive vault-lock as the branch above.
                LibSanctionedLock.begin(s, newLender);
                LibFacet.depositFromPayerForLender(
                    loan.principalAsset,
                    originalLender,
                    newLender,
                    totalFromLiam,
                    loanId
                );
                LibSanctionedLock.end(
                    s, newLender, loanId, loan.principalAsset, totalFromLiam
                );
            }
        } else {
            LibFacet.transferFromPayerToTreasury(
                originalLender,
                loan.principalAsset,
                accrued
            );
        }

        // NOTE: Principal transfer already happened in acceptOffer().
        // For Borrower-type offers, acceptOffer() withdraws principal from
        // Noah's (lender) vault and sends it to liam (borrower=offer.creator).
        // No second transfer needed here.

        // #597 — release the old lender's held-for-lender VPFI reservation
        // BEFORE the physical migration withdraws it below (else the #565
        // chokepoint bricks the withdraw). `loan.lender` is still the old
        // lender here. No-op for a non-VPFI / never-reserved loan. Re-reserved
        // on the new lender after the position migrates (below).
        LibEncumbrance.releaseLenderProceeds(loanId, loan.lender);

        // Migrate only pre-existing heldForLender from old lender's vault to new lender's
        {
            if (priorHeldSale > 0) {
                address payAsset = loan.assetType == LibVaipakam.AssetType.ERC20
                    ? loan.principalAsset
                    : loan.prepayAsset;
                // #597 Codex #672 P2 — same sanctions exemption as
                // `sellLoanViaBuyOffer`: the departed `originalLender` is losing
                // custody of their held VPFI, so the Tier-1 vault gate must not
                // brick the sale for the unflagged seller. Address-scoped; the
                // host is `nonReentrant`; cleared immediately after.
                s.consolidationMoveFromUser = originalLender;
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        originalLender,
                        payAsset,
                        address(this),
                        priorHeldSale
                    ),
                    VaultWithdrawFailed.selector
                );
                s.consolidationMoveFromUser = address(0);
                // #831 — vault-lock the held migration into the buyer's
                // (newLender) vault: a buyer flagged after committing must not
                // brick the completion. `depositLocked` resolves the buyer vault
                // under the receive-side exemption, pushes the held from Diamond
                // custody, and emits `SanctionedProceedsLocked` when flagged
                // (T-051 — the Diamond-side transfer ticks the tracked counter).
                LibSanctionedLock.depositLocked(
                    s, newLender, loanId, payAsset, priorHeldSale
                );
            }
        }

        // Migrate live-loan lender position in one shot.
        LibLoan.migrateLenderPosition(loanId, newLender);

        // #597 — re-reserve the FULL held-for-lender VPFI on the NEW lender,
        // where it now physically lives. `loan.lender` is now the new lender.
        // Released to the new lender at claim. Gated on VPFI.
        if (loan.principalAsset == s.vpfiToken) {
            LibEncumbrance.encumberLenderProceeds(
                loanId, loan.lender, loan.principalAsset, s.heldForLender[loanId]
            );
        }

        // Old lender forfeits interaction rewards to treasury; new lender
        // gets a fresh entry covering the residual loan window.
        LibInteractionRewards.transferLenderEntry(loanId, newLender);

        // ── Clean up temporary loan created by acceptOffer ──────────────────
        LibVaipakam.Loan storage tempLoan = s.loans[tempLoanId];

        // Burn both NFTs on the temporary loan
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                tempLoan.lenderTokenId
            ),
            NFTBurnFailed.selector
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                tempLoan.borrowerTokenId
            ),
            NFTBurnFailed.selector
        );

        // Release liam's collateral that was locked when creating the
        // borrower-style sale offer. liam locked collateral into his vault
        // via createOffer(Borrower, ...) — return it to him.
        // #569 §4.6 (2026-06-13) — defensive lien release for the sale-
        // vehicle temp loan before returning its collateral. The lender-
        // side sale vehicle posts ZERO collateral today (`_buildSaleParams`
        // forces `collateralAmount = 0`), so the temp loan's lien is
        // empty and this is a no-op. It is wired defensively so that if
        // a future change ever lets a sale vehicle carry real collateral,
        // the chokepoint guard on the withdraws below clears. No-op on
        // NFT rentals (D-1). EncumbranceLifecycleMap.md §4.6.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.releaseCollateralLien.selector,
                tempLoanId
            ),
            bytes4(0)
        );
        if (tempLoan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
            if (tempLoan.collateralAmount > 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        originalLender,
                        tempLoan.collateralAsset,
                        originalLender,
                        tempLoan.collateralAmount
                    ),
                    VaultWithdrawFailed.selector
                );
            }
        } else if (
            tempLoan.collateralAssetType == LibVaipakam.AssetType.ERC721
        ) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC721.selector,
                    originalLender,
                    tempLoan.collateralAsset,
                    tempLoan.collateralTokenId,
                    originalLender
                ),
                VaultWithdrawFailed.selector
            );
        } else if (
            tempLoan.collateralAssetType == LibVaipakam.AssetType.ERC1155
        ) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC1155.selector,
                    originalLender,
                    tempLoan.collateralAsset,
                    tempLoan.collateralTokenId,
                    tempLoan.collateralQuantity,
                    originalLender
                ),
                VaultWithdrawFailed.selector
            );
        }

        // Mark temp loan as Repaid with zeroed-out claim records so
        // ClaimFacet's NothingToClaim check won't create a stuck artifact.
        LibLifecycle.transition(
            tempLoan,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.Repaid
        );
        // Set claimed=true so neither party needs to (or can) claim.
        s.lenderClaims[tempLoanId] = LibVaipakam.ClaimInfo({
            asset: tempLoan.principalAsset,
            amount: 0,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: true
        });
        s.borrowerClaims[tempLoanId] = LibVaipakam.ClaimInfo({
            asset: tempLoan.collateralAsset,
            amount: 0,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: true
        });

        emit LoanSaleCompleted(loanId, originalLender, newLender);
    }

}
