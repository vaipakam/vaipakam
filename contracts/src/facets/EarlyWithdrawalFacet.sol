// src/facets/EarlyWithdrawalFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibCompliance} from "../libraries/LibCompliance.sol";
import {LibLoan} from "../libraries/LibLoan.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "./EscrowFactoryFacet.sol";
import {OfferFacet} from "./OfferFacet.sol";

/**
 * @title EarlyWithdrawalFacet
 * @author Vaipakam Developer Team
 * @notice Lender early-withdrawal by selling their loan position to a new
 *         lender (Options 1 & 2 per README §9).
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *      ERC-20 loans only (NFT rental lender-sale requires NFT custody
 *      transfer — not supported in Phase 1).
 *
 *      Option 1 — {sellLoanViaBuyOffer}: Liam accepts an existing Lender
 *      Offer from Noah. Noah's principal goes to Liam (minus any rate
 *      shortfall); Liam forfeits accrued interest to treasury.
 *
 *      Option 2 — two-step:
 *        a) {createLoanSaleOffer}: Liam creates a borrower-style sale
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
    event LoanSold(
        uint256 indexed loanId,
        address indexed originalLender,
        address indexed newLender,
        uint256 shortfallPaid
    );

    /// @notice Emitted when a loan sale offer is created and linked to a live loan (Option 2, step 1).
    /// @param loanId The live loan being sold.
    /// @param saleOfferId The borrower-style offer created to execute the sale.
    event LoanSaleOfferLinked(
        uint256 indexed loanId,
        uint256 indexed saleOfferId
    );

    /// @notice Emitted when a loan sale is completed via Option 2.
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

    /**
     * @notice Allows original lender to sell an active loan by accepting a new Lender Offer.
     * @dev Option 1: Liam accepts Noah's Lender Offer. Transfers principal, forfeits accrued to treasury,
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
        LibAuth.requireLenderNFTOwner(loan);
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
        // Enforce same asset types as original loan (README General Rules: lending, collateral, prepay)
        if (buyOffer.lendingAsset != loan.principalAsset)
            revert InvalidSaleOffer();
        if (buyOffer.collateralAsset != loan.collateralAsset)
            revert InvalidSaleOffer();
        if (buyOffer.collateralAssetType != loan.collateralAssetType)
            revert InvalidSaleOffer();
        if (buyOffer.prepayAsset != loan.prepayAsset) revert InvalidSaleOffer();

        // Borrower-favorability: Noah's terms must not worsen Alice's position (README Section 9)
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
        LibCompliance.enforceCountryAndKYC(
            address(this),
            buyOffer.creator,
            loan.borrower,
            loan.principalAsset,
            loan.principal,
            loan.collateralAsset,
            loan.collateralAmount
        );

        // Snapshot pre-existing heldForLender before any new shortfall deposits.
        uint256 priorHeld = s.heldForLender[loanId];

        // ── Net settlement (README Section 9, Option 1) ────────────────────
        // Noah's principal is the only inflow.  Liam's share (principal minus
        // his cost) is paid out net; treasury cut and Noah's shortfall deposit
        // come from the same bucket — Liam never needs to pre-approve tokens.
        //   liamCost    = max(accrued, shortfall)
        //   treasuryCut = max(accrued - shortfall, 0)   (unused forfeited accrued)
        //   toNoahHeld  = shortfall                     (compensates Noah)
        //   toLiam      = principal - liamCost
        // Unified seconds-based precision: both accrued and remaining use
        // SECONDS_PER_YEAR so any sub-day remainder is preserved and rounding
        // is symmetric across the two sides of the net settlement.
        uint256 elapsed = block.timestamp - loan.startTime;
        uint256 totalSecs = loan.durationDays * 1 days;
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
        // If Liam's cost exceeds what Noah brings, net settlement cannot
        // complete — Liam would owe tokens we never collected from him.
        if (liamCost > loan.principal) revert RateShortfallTooHigh();

        // Pull Noah's principal into the diamond in a single withdraw,
        // then fan out to Liam / treasury / Noah's heldForLender.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowWithdrawERC20.selector,
                buyOffer.creator, // Noah
                loan.principalAsset,
                address(this),
                loan.principal
            ),
            EscrowWithdrawFailed.selector
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
                    EscrowFactoryFacet.escrowWithdrawERC20.selector,
                    buyOffer.creator,
                    loan.principalAsset,
                    buyOffer.creator, // Refund back to Noah
                    excess
                ),
                EscrowWithdrawFailed.selector
            );
        }

        // Migrate only the pre-existing heldForLender from old lender's escrow to new lender's.
        // priorHeld was snapshotted before any shortfall deposits in this transaction.
        if (priorHeld > 0) {
            address payAsset = loan.assetType == LibVaipakam.AssetType.ERC20
                ? loan.principalAsset
                : loan.prepayAsset;
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC20.selector,
                    msg.sender, // old lender
                    payAsset,
                    address(this),
                    priorHeld
                ),
                EscrowWithdrawFailed.selector
            );
            address newEscrow = LibFacet.getOrCreateEscrow(buyOffer.creator);
            IERC20(payAsset).safeTransfer(newEscrow, priorHeld);
        }

        // Migrate lender position: burn old NFT + mint new LoanInitiated NFT
        // for Noah, update loan.lender and loan.lenderTokenId in one place.
        LibLoan.migrateLenderPosition(loanId, buyOffer.creator);

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

        emit LoanSold(loanId, msg.sender, buyOffer.creator, shortfall);
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
     *      Liam creates offer for his loan position; new lender accepts via OfferFacet.acceptOffer.
     *      Terms: Remaining duration, same assets/collateral. Links offer to loan via new mapping.
     *      Callable only by original lender. No event here (emitted on acceptance in OfferFacet).
     * @param loanId The loan ID to sell.
     * @param interestRateBps The sale interest rate (may differ from original).
     * @param creatorFallbackConsent Consent for illiquid assets (if applicable).
     */
    function createLoanSaleOffer(
        uint256 loanId,
        uint256 interestRateBps,
        bool creatorFallbackConsent
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
        // not a real borrower posting collateral.  Alice's collateral on the
        // live loan continues to back it after the lender transfer.  Setting 0
        // avoids requiring Liam to post fresh capital he shouldn't need.
        uint256 saleOfferId = _submitSaleOffer(
            loan,
            remainingDays,
            interestRateBps,
            creatorFallbackConsent
        );
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
        uint256 remainingDays,
        uint256 interestRateBps,
        bool creatorFallbackConsent
    ) private returns (uint256 saleOfferId) {
        LibVaipakam.CreateOfferParams memory params = _buildSaleParams(
            loan,
            remainingDays,
            interestRateBps,
            creatorFallbackConsent
        );
        bytes memory result = LibFacet.crossFacetCallReturn(
            abi.encodeWithSelector(OfferFacet.createOffer.selector, params),
            OfferCreationFailed.selector
        );
        saleOfferId = abi.decode(result, (uint256));
    }

    function _buildSaleParams(
        LibVaipakam.Loan storage loan,
        uint256 remainingDays,
        uint256 interestRateBps,
        bool creatorFallbackConsent
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
        params.creatorFallbackConsent = creatorFallbackConsent;
        params.prepayAsset = loan.prepayAsset;
        params.collateralAssetType = loan.collateralAssetType;
        params.collateralTokenId = loan.collateralTokenId;
        params.collateralQuantity = loan.collateralQuantity;
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
     *      - Principal: Already transferred from Noah to Liam by acceptOffer() (no second transfer).
     *      - Forfeits accrued interest to treasury (or applies toward shortfall).
     *      - Handles rate shortfall if applicable.
     *      - Updates loan.lender to Noah on the live loan.
     *      - Burns Liam's lender NFT and mints one for Noah.
     *      - Cleans up the temporary loan created by acceptOffer() (burns its NFTs,
     *        releases Liam's locked collateral, sets dummy claims so ClaimFacet doesn't block).
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

        // ── Find the temporary loan via O(1) lookup ─────────────────────────
        uint256 tempLoanId = s.offerIdToLoanId[saleOfferId];
        if (tempLoanId == 0)
            revert LenderResolutionFailed();
        // For a Borrower-type offer: creator=Liam is borrower, acceptor=Noah is lender
        address newLender = s.loans[tempLoanId].lender;
        if (newLender == address(0))
            revert LenderResolutionFailed();

        // Snapshot pre-existing heldForLender before any new shortfall deposits
        uint256 priorHeldSale = s.heldForLender[loanId];

        // ── Accrued interest & shortfall ────────────────────────────────────
        // "Forfeited accrued" means Liam absorbs the cost — the borrower has
        // not paid this interest yet.  Liam must fund every token that gets
        // routed to treasury or Noah.
        uint256 elapsed = block.timestamp - loan.startTime;
        uint256 totalSecs = loan.durationDays * 1 days;
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
        // (the wallet of Liam, who approved the Diamond). The previous
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
                LibFacet.depositFromPayerForLender(
                    loan.principalAsset,
                    originalLender,
                    newLender,
                    shortfall,
                    loanId
                );
            } else {
                uint256 remainingShortfall = shortfall - accrued;
                uint256 totalFromLiam = accrued + remainingShortfall;
                LibFacet.depositFromPayerForLender(
                    loan.principalAsset,
                    originalLender,
                    newLender,
                    totalFromLiam,
                    loanId
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
        // Noah's (lender) escrow and sends it to Liam (borrower=offer.creator).
        // No second transfer needed here.

        // Migrate only pre-existing heldForLender from old lender's escrow to new lender's
        {
            if (priorHeldSale > 0) {
                address payAsset = loan.assetType == LibVaipakam.AssetType.ERC20
                    ? loan.principalAsset
                    : loan.prepayAsset;
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC20.selector,
                        originalLender,
                        payAsset,
                        address(this),
                        priorHeldSale
                    ),
                    EscrowWithdrawFailed.selector
                );
                address newEscrow = LibFacet.getOrCreateEscrow(newLender);
                IERC20(payAsset).safeTransfer(newEscrow, priorHeldSale);
            }
        }

        // Migrate live-loan lender position in one shot.
        LibLoan.migrateLenderPosition(loanId, newLender);

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

        // Release Liam's collateral that was locked when creating the
        // borrower-style sale offer. Liam locked collateral into his escrow
        // via createOffer(Borrower, ...) — return it to him.
        if (tempLoan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
            if (tempLoan.collateralAmount > 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC20.selector,
                        originalLender,
                        tempLoan.collateralAsset,
                        originalLender,
                        tempLoan.collateralAmount
                    ),
                    EscrowWithdrawFailed.selector
                );
            }
        } else if (
            tempLoan.collateralAssetType == LibVaipakam.AssetType.ERC721
        ) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC721.selector,
                    originalLender,
                    tempLoan.collateralAsset,
                    tempLoan.collateralTokenId,
                    originalLender
                ),
                EscrowWithdrawFailed.selector
            );
        } else if (
            tempLoan.collateralAssetType == LibVaipakam.AssetType.ERC1155
        ) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC1155.selector,
                    originalLender,
                    tempLoan.collateralAsset,
                    tempLoan.collateralTokenId,
                    tempLoan.collateralQuantity,
                    originalLender
                ),
                EscrowWithdrawFailed.selector
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
