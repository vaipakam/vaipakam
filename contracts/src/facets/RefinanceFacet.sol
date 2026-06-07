// src/facets/RefinanceFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";

/**
 * @title RefinanceFacet
 * @author Vaipakam Developer Team
 * @notice Borrower refinancing — close an existing loan and switch to a new
 *         lender with better terms.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *      ERC-20 loans only (NFT rental refinance not supported — would require
 *      NFT custody transfer between vaults).
 *
 *      Two-step flow:
 *        1. Borrower creates a Borrower Offer; a new lender accepts it
 *           (creating a new loan). Principal from the new lender flows to
 *           the borrower.
 *        2. Borrower calls {refinanceLoan}: repays the old lender
 *           (principal + full-term interest — early repayment economics
 *           per README), releases old collateral,
 *           verifies post-refinance HF ≥ 1.5 and LTV ≤ loanInitMaxLtvBps on the new
 *           loan, and transitions the old loan to Repaid.
 */
contract RefinanceFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted when a loan is refinanced to a new lender.
    /// @param oldLoanId The ID of the original loan.
    /// @param newLoanId The ID of the new refinanced loan.
    /// @param borrower The borrower's address.
    /// @param oldLender The original lender's address.
    /// @param newLender The new lender's address.
    /// @param shortfallPaid Reserved for ABI compatibility; refinance no
    ///        longer charges a rate shortfall on top of full-term interest.
    /// @param oldLoanNewStatus The original loan's `LoanStatus` after the
    ///        refinance — always `Repaid` (1). Carried explicitly so an
    ///        indexer flips status from the payload rather than inferring
    ///        it from the event name (uniform with `LoanRepaid.newStatus`).
    /// @custom:event-category state-change/loan-mutation
    event LoanRefinanced(
        uint256 indexed oldLoanId,
        uint256 indexed newLoanId,
        address indexed borrower,
        address oldLender,
        address newLender,
        uint256 shortfallPaid,
        uint8 oldLoanNewStatus
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidRefinanceOffer();
    error OfferNotAccepted();

    /**
     * @notice Completes refinancing after alice's Borrower Offer has been accepted by Lender B.
     * @dev Per README Section "Allow Borrower to Choose New Lender with Better Offer":
     *      1. alice creates a Borrower Offer (separate tx via OfferFacet.createOffer).
     *      2. Lender B accepts alice's offer (separate tx via OfferFacet.acceptOffer),
     *         creating a new loan. Principal from Lender B is sent to alice.
     *      3. alice calls this function to close the old loan:
     *         - Verifies the Borrower Offer was accepted and a new loan exists.
     *         - Repays old lender (principal + full-term interest; see
     *           LibEntitlement.fullTermInterest — matches README early
     *           repayment economics).
     *         - Releases old collateral back to alice.
     *         - Checks post-refinance HF and LTV on new loan.
     *         - Updates old loan NFTs and marks old loan Repaid.
     * @param oldLoanId The current loan ID to refinance.
     * @param borrowerOfferId The Borrower Offer ID that alice created and Lender B accepted.
     */
    function refinanceLoan(
        uint256 oldLoanId,
        uint256 borrowerOfferId
    ) external nonReentrant whenNotPaused {
        // Tier-1 sanctions gate — refinance routes funds + creates
        // new loan state for msg.sender; sanctioned wallet blocked.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage oldLoan = s.loans[oldLoanId];
        // Phase 6: borrower-entitled strategic flow. Authority binds to the
        // current borrower-NFT owner OR a keeper with the Refinance action
        // bit.
        LibAuth.requireKeeperFor(
            LibVaipakam.KEEPER_ACTION_REFINANCE,
            oldLoan,
            /* lenderSide */ false
        );
        if (oldLoan.status != LibVaipakam.LoanStatus.Active)
            revert LoanNotActive();
        // NFT rental refinance not supported in Phase 1 (requires NFT custody transfer)
        if (oldLoan.assetType != LibVaipakam.AssetType.ERC20)
            revert InvalidRefinanceOffer();

        // T-034 §4.6 — settle-first guard. If the old loan has a
        // Periodic Interest Payment cadence AND the current period is
        // overdue past its grace window, the original lender is owed
        // interest right now. Refinance must NOT overwrite the loan's
        // state until that obligation is settled — otherwise the new
        // lender's terms (different rate / cadence / start time)
        // would silently extinguish the original lender's claim.
        // Caller resolves by running `settlePeriodicInterest` on the
        // old loan first; that path either just-stamps (no shortfall)
        // or auto-liquidates (covers the shortfall to the lender),
        // and refinance can then proceed cleanly.
        if (
            oldLoan.periodicInterestCadence !=
            LibVaipakam.PeriodicInterestCadence.None
        ) {
            uint256 graceEndsAt = LibPeriodicInterest.settleAllowedFromAt(oldLoan);
            if (block.timestamp >= graceEndsAt) {
                revert IVaipakamErrors.RefinanceRequiresPeriodSettle(
                    oldLoanId,
                    graceEndsAt
                );
            }
        }

        // Validate: must be a Borrower offer created by alice, already accepted
        LibVaipakam.Offer storage offer = s.offers[borrowerOfferId];
        if (
            offer.offerType != LibVaipakam.OfferType.Borrower ||
            offer.creator != msg.sender
        ) revert InvalidRefinanceOffer();
        if (!offer.accepted) revert OfferNotAccepted();
        // Range-aware amount check: legacy single-value offers satisfy
        // `amount == amountMax`; range offers satisfy
        // `amount <= oldLoan.principal <= amountMax` (the borrower's
        // range must accommodate the existing loan's principal). With
        // auto-collapse (`amountMax == 0` → treated as `amount`),
        // legacy single-value offers fall through to the original
        // `offer.amount >= oldLoan.principal` check unchanged.
        uint256 effAmountMax = offer.amountMax == 0
            ? offer.amount
            : offer.amountMax;
        if (offer.amount > oldLoan.principal || oldLoan.principal > effAmountMax)
            revert InvalidRefinanceOffer();
        // Range Orders Phase 1 — single source of truth for the per-
        // asset invariants (lendingAsset / collateralAsset /
        // collateralAssetType / prepayAsset). README: same lending,
        // collateral, and prepay asset types as original loan.
        if (!LibOfferMatch.assertAssetContinuity(oldLoan, offer))
            revert InvalidRefinanceOffer();

        // Find the new loan created when Lender B accepted alice's offer
        uint256 newLoanId = s.offerIdToLoanId[borrowerOfferId];
        if (newLoanId == 0) revert InvalidRefinanceOffer();
        LibVaipakam.Loan storage newLoan = s.loans[newLoanId];
        address newLender = newLoan.lender;

        // ── Repay old lender ──────────────────────────────────────────────
        // alice already received new principal from Lender B (via acceptOffer).
        // README: repay old lender with principal + full-term interest (early repayment rules).
        uint256 oldInterest = LibEntitlement.fullTermInterest(
            oldLoan.principal,
            oldLoan.interestRateBps,
            oldLoan.durationDays
        );

        // Refinance closes the old loan, so the original lender exits fully
        // protected at principal + full-term interest. Do not add the
        // lower-rate offer's interest delta here; unlike transfer/offset
        // paths, there is no remaining earning slice to top up.
        uint256 shortfall = 0;

        // Treasury fee on the old loan's full-term interest.
        // Lender Yield Fee discount (Tokenomics §6): when the old lender has
        // platform-level VPFI-discount consent AND holds >= the required VPFI
        // in vault, the treasury cut is paid in VPFI from the old lender's
        // vault and the old lender keeps 100% of interestPortion in the
        // lending asset. tryApplyYieldFee silently falls back on any
        // precondition failure.
        uint256 interestPortion = oldInterest;
        (uint256 treasuryFee, uint256 lenderInterest) = LibEntitlement.splitTreasury(
            interestPortion
        );
        uint256 yieldVpfiDeducted;
        if (s.vpfiDiscountConsent[oldLoan.lender] && treasuryFee > 0) {
            bool yieldApplied;
            (yieldApplied, yieldVpfiDeducted) = LibVPFIDiscount.tryApplyYieldFee(
                oldLoan,
                interestPortion
            );
            if (yieldApplied) {
                lenderInterest = interestPortion;
                treasuryFee = 0;
            }
        }
        uint256 lenderDue = oldLoan.principal + lenderInterest;

        // T-037 — pay each party directly from the borrower without
        // the Diamond holding the asset between transfers. The
        // borrower's prior `approve()` to the Diamond covers the
        // total; two `safeTransferFrom` calls (one to treasury, one
        // to the old lender's vault) replace the prior pull-and-
        // split pattern. Treasury share skipped entirely if the
        // VPFI-discount path satisfied it.
        if (treasuryFee > 0) {
            IERC20(oldLoan.principalAsset).safeTransferFrom(
                msg.sender,
                LibFacet.getTreasury(),
                treasuryFee
            );
            LibFacet.recordTreasuryAccrual(oldLoan.principalAsset, treasuryFee);
        }

        // Route lender's share to old lender's vault via the cross-
        // payer chokepoint so the protocolTrackedVaultBalance
        // counter ticks under the old lender (the vault owner)
        // while the borrower remains the payer.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultDepositERC20From.selector,
                msg.sender,         // payer — borrower
                oldLoan.lender,     // user — old lender's vault
                oldLoan.principalAsset,
                lenderDue
            ),
            VaultDepositFailed.selector
        );

        // Record lender's claimable. heldForLender handled by ClaimFacet.
        s.lenderClaims[oldLoanId] = LibVaipakam.ClaimInfo({
            asset: oldLoan.principalAsset,
            amount: lenderDue,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });

        // T-086 follow-up to step 14 — clear any active prepay listing on
        // the OLD loan BEFORE the collateral withdrawal below. Placement
        // matters here: `LibPrepayCleanup.clearActiveListing` calls
        // `vault.setCollateralOperatorApproval(..., approved=false)` on
        // ERC721 collateral, which performs `IERC721.approve(address(0),
        // tokenId)` from the vault. After the collateral has been
        // withdrawn out of the vault (lines below), the vault is no
        // longer the token owner and standard ERC721s revert that approve
        // call — leaving refinance permanently broken for ERC721
        // collateral loans that carry a live listing.
        //
        // Refinance is gated on `oldLoan.assetType == ERC20` upstream
        // (line ~109) so rental loans never reach here; for the
        // ERC20-principal + NFT-collateral case this is the right
        // moment: principal-asset payments to the old lender have
        // already committed (so we know the borrower paid), no
        // collateral has been touched yet, and the listing's
        // bookkeeping can be cleared while the vault still owns the
        // NFT. Idempotent no-op when no listing is live.
        // Codex round-1 P1 fix on PR #317.
        LibPrepayCleanup.clearActiveListing(oldLoan, oldLoanId);

        // ── Release old collateral ────────────────────────────────────────
        // The borrower's vault currently holds the old collateral deposited
        // when the original loan was opened. We must refund it back to the borrower.
        if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
            uint256 oldCol = oldLoan.collateralAmount;
            if (oldCol > 0) {
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        VaultFactoryFacet.vaultWithdrawERC20.selector,
                        msg.sender,
                        oldLoan.collateralAsset,
                        msg.sender,
                        oldCol
                    ),
                    VaultWithdrawFailed.selector
                );
            }
        } else if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC721.selector,
                    msg.sender,
                    oldLoan.collateralAsset,
                    oldLoan.collateralTokenId,
                    msg.sender
                ),
                VaultWithdrawFailed.selector
            );
        } else if (oldLoan.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC1155.selector,
                    msg.sender,
                    oldLoan.collateralAsset,
                    oldLoan.collateralTokenId,
                    oldLoan.collateralQuantity,
                    msg.sender
                ),
                VaultWithdrawFailed.selector
            );
        }

        // Post-refinance LTV + HF gates. Mirrors
        // `LoanFacet._checkInitialLtvAndHf` exactly so refinance can't
        // admit a position that would have been rejected at init —
        // both regimes (depth-tiered ON / OFF) must agree.
        //
        // Regime OFF (default / pre-flip): today's gate — `LTV ≤
        // assetRiskParams.loanInitMaxLtvBps` and `HF ≥ 1.5e18`.
        //
        // Regime ON (post-flip per chain): cap LTV at
        // `min(loanInitMaxLtvBps, effectiveTierMaxInitLtvBps[effectiveTier(
        // collateral)])` and relax HF floor to `≥ 1e18` (tier cap is
        // the binding buffer; see LoanFacet for full rationale).
        bytes memory ltvResult = LibFacet.crossFacetStaticCall(
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector, newLoanId),
            LTVCalculationFailed.selector
        );
        uint256 newLtv = abi.decode(ltvResult, (uint256));
        uint256 loanInitMaxLtvBps = s
            .assetRiskParams[oldLoan.collateralAsset]
            .loanInitMaxLtvBps;
        bool tieredOn = LibVaipakam.cfgDepthTieredLtvEnabled();
        if (tieredOn) {
            uint8 effTier = OracleFacet(address(this))
                .getEffectiveLiquidityTier(oldLoan.collateralAsset);
            uint256 tierCap = uint256(
                LibVaipakam.effectiveTierMaxInitLtvBps(effTier)
            );
            uint256 cap = loanInitMaxLtvBps < tierCap ? loanInitMaxLtvBps : tierCap;
            if (newLtv > cap) {
                revert IVaipakamErrors.InitLtvAboveTier(newLtv, cap);
            }
        } else if (newLtv > loanInitMaxLtvBps) {
            revert LTVExceeded();
        }

        bytes memory hfResult = LibFacet.crossFacetStaticCall(
            abi.encodeWithSelector(
                RiskFacet.calculateHealthFactor.selector,
                newLoanId
            ),
            HealthFactorCalculationFailed.selector
        );
        uint256 newHf = abi.decode(hfResult, (uint256));
        // Tier-ON ⇒ HF ≥ 1.0 (not born already-liquidatable; the tier
        // cap is the binding buffer). Tier-OFF ⇒ legacy HF ≥ 1.5.
        uint256 hfFloor = tieredOn
            ? LibVaipakam.HF_LIQUIDATION_THRESHOLD
            : LibVaipakam.MIN_HEALTH_FACTOR;
        if (newHf < hfFloor) revert HealthFactorTooLow();

        // Update old loan NFTs: mark lender NFT as Loan Repaid
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                oldLoan.lenderTokenId,
                oldLoanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            NFTStatusUpdateFailed.selector
        );
        // Preserve old borrower NFT as a LoanRepaid-status receipt so the
        // borrower retains a redeemable claim on the original position even
        // after refinancing into a new loan.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                oldLoan.borrowerTokenId,
                oldLoanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            NFTStatusUpdateFailed.selector
        );

        // Mark old loan closed — refinance only operates on Active loans.
        LibLifecycle.transition(
            oldLoan,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.Repaid
        );

        // Phase 5 / §5.2b — proper-close settlement for the OLD loan's
        // borrower LIF VPFI path. The borrower earned the rebate over
        // the old loan's live period; the new loan gets a fresh anchor
        // via _snapshotBorrowerDiscount inside its own initiateLoan path
        // (and, if the new loan also takes the VPFI fee path, that will
        // register its own vpfiHeld against the new loan id).
        LibVPFIDiscount.settleBorrowerLifProper(oldLoan);

        emit LoanRefinanced(
            oldLoanId,
            newLoanId,
            msg.sender,
            oldLoan.lender,
            newLender,
            shortfall,
            uint8(oldLoan.status)
        );

        // Passthrough event for lender yield-fee VPFI discount so indexers
        // subscribe to a single facet for all VPFI-discount analytics.
        if (yieldVpfiDeducted > 0) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VPFIDiscountFacet.emitYieldFeeDiscountApplied.selector,
                    oldLoanId,
                    oldLoan.lender,
                    oldLoan.principalAsset,
                    yieldVpfiDeducted
                ),
                TreasuryTransferFailed.selector
            );
        }
    }
}
