// src/facets/DefaultedFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "./EscrowFactoryFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {IZeroExProxy} from "../interfaces/IZeroExProxy.sol";
import {LibSwap} from "../libraries/LibSwap.sol";

/**
 * @title DefaultedFacet
 * @author Vaipakam Developer Team
 * @notice Time-based loan default (grace period expired) for the Vaipakam
 *         P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *      Separated from HF-based liquidation ({RiskFacet.triggerLiquidation}).
 *
 *      {triggerDefault} is permissionless — any caller may invoke it once the
 *      loan is past `endTime + gracePeriod(durationDays)`. Asset-handling
 *      branches:
 *        - **Liquid ERC-20 collateral**: 0x swap (slippage ≤
 *          `MAX_LIQUIDATION_SLIPPAGE_BPS`); on swap failure falls back to
 *          {LibFallback.record} (claim-time retry in ClaimFacet).
 *          High-volatility check: if LTV > 110% or HF < 1, routes directly
 *          to the full-collateral-transfer fallback to avoid a guaranteed
 *          slippage breach.
 *        - **Illiquid ERC-20**: full collateral transfer to lender (both
 *          parties already consented at offer time).
 *        - **NFT rental**: remaining prepay to lender (minus treasury fee),
 *          buffer to treasury, renter reset to address(0).
 *        - **NFT/ERC-1155 collateral**: direct NFT transfer to lender.
 */
contract DefaultedFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted when a loan defaults.
    /// @param loanId The ID of the defaulted loan.
    /// @param fallbackConsentFromBoth Mirrors {Loan.fallbackConsentFromBoth}
    ///        latched at initiation — the combined abnormal-market +
    ///        illiquid-assets fallback consent from both counterparties
    ///        (docs/WebsiteReadme.md §"Offer and acceptance risk warnings",
    ///        README.md §"Liquidity & Asset Classification"). Since the
    ///        docs mandate this consent on every offer create/accept, the
    ///        flag is informational only — it records what was acknowledged,
    ///        not the settlement route. The actual liquid-vs-fallback routing
    ///        is decided by live liquidity/collapse state and swap success,
    ///        not by this flag; a liquid-collateral loan with flag=true will
    ///        still DEX-liquidate when conditions allow.
    event LoanDefaulted(uint256 indexed loanId, bool fallbackConsentFromBoth);

    /// @notice Emitted when a liquidation is triggered for liquid collateral.
    /// @param loanId The ID of the liquidated loan.
    /// @param proceeds The amount recovered from liquidation.
    /// @param treasuryFee The treasury fee deducted (if any).
    event LoanLiquidated(
        uint256 indexed loanId,
        uint256 proceeds,
        uint256 treasuryFee
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error NotDefaultedYet();
    /// @notice L2 sequencer is offline or still in its 1h recovery grace
    ///         window; default processing is blocked so the caller can
    ///         retry once prices are trustworthy again.
    error SequencerUnhealthy();

    // MAX_LIQUIDATION_SLIPPAGE_BPS consolidated in LibVaipakam

    /// @notice Emitted when a time-based default falls back to full collateral
    ///         transfer because the DEX swap reverted or exceeded the 6% slippage
    ///         threshold (README §7).
    /// @param loanId The defaulted loan ID.
    /// @param lender The lender who receives the full collateral.
    /// @param collateralAmount The amount of collateral transferred.
    event LiquidationFallback(
        uint256 indexed loanId,
        address indexed lender,
        uint256 collateralAmount
    );

    /// @notice Emitted alongside LiquidationFallback with the README §7 split
    ///         (see RiskFacet.LiquidationFallbackSplit for field semantics).
    event LiquidationFallbackSplit(
        uint256 indexed loanId,
        uint256 lenderCollateral,
        uint256 treasuryCollateral,
        uint256 borrowerCollateral
    );

    /**
     * @notice Triggers default for a loan past grace period (permissionless).
     * @dev If liquid collateral: Calls triggerLiquidation (0x swap).
     *      If illiquid: Transfers full collateral to lender.
     *      Enhanced for NFTs: Transfers prepay (amount * durationDays) to lender, buffer (5%) to treasury from borrower escrow.
     *      Resets renter via escrowSetNFTUser(address(0), 0).
     *      Updates loan to Defaulted, burns NFTs.
     *      Emits LoanDefaulted.
     * @param loanId The loan ID to default.
     */
    function triggerDefault(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) external whenNotPaused nonReentrant {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert InvalidLoanStatus();

        // Tiered KYC check on loan value for the lender. Both branches
        // (ERC20 loan / NFT rental) price the same way — we only differ in
        // which asset + amount to value. Collapsed to one getAssetPrice +
        // decimals() fetch instead of two duplicated bodies.
        // Illiquid assets have no oracle feed, so valued at 0 per README — KYC always passes.
        {
            address valueAsset;
            uint256 valueAmount;
            if (loan.assetType == LibVaipakam.AssetType.ERC20) {
                valueAsset = loan.principalAsset;
                valueAmount = loan.principal;
            } else {
                // NFT rental: principalAsset is the NFT contract; price the prepay.
                valueAsset = loan.prepayAsset;
                valueAmount = loan.prepayAmount;
            }

            LibVaipakam.LiquidityStatus liq = OracleFacet(address(this))
                .checkLiquidity(valueAsset);
            if (liq == LibVaipakam.LiquidityStatus.Liquid) {
                (uint256 price, uint8 feedDecimals) = OracleFacet(address(this))
                    .getAssetPrice(valueAsset);
                uint8 tokenDecimals = IERC20Metadata(valueAsset).decimals();
                uint256 valueNumeraire = (valueAmount * price * 1e18)
                    / (10 ** feedDecimals) / (10 ** tokenDecimals);
                if (!ProfileFacet(address(this)).meetsKYCRequirement(loan.lender, valueNumeraire)) {
                    revert KYCRequired();
                }
            }
            // Illiquid asset: valued at 0, KYC always passes.
        }

        uint256 endTime = loan.startTime + loan.durationDays * 1 days;
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp <= graceEnd) revert NotDefaultedYet();

        address treasury = LibFacet.getTreasury();

        // L2 circuit breaker: block the default trigger entirely while the
        // sequencer is down or in its 1h recovery grace window. Chainlink
        // prices and AMM pools are unreliable under those conditions,
        // so a DEX swap would cross heavy slippage. Sequencer outages are
        // typically short — the caller can simply retry once it recovers,
        // which is safer than locking the loan into an irreversible full-
        // collateral-transfer fallback based on a transient state.
        if (!OracleFacet(address(this)).sequencerHealthy()) {
            revert SequencerUnhealthy();
        }

        // Execution routing (README §1): liquidation depends on whether the
        // live network exposes a swap path for the collateral. When the
        // active-network check returns Illiquid we drop into the full-
        // collateral-transfer branch below instead of attempting a swap.
        LibVaipakam.LiquidityStatus liquidity = OracleFacet(address(this))
            .checkLiquidityOnActiveNetwork(loan.collateralAsset);

        // Terminal NFT status for this default — README §7: "Loan Defaulted" or
        // "Loan Liquidated". Each branch below sets the appropriate label.
        LibVaipakam.LoanPositionStatus terminalStatus =
            LibVaipakam.LoanPositionStatus.LoanDefaulted;

        if (loan.assetType == LibVaipakam.AssetType.ERC20) {
            // Only check collapse for liquid loans — illiquid loans have no oracle
            // and calculateLTV/calculateHealthFactor revert with NonLiquidAsset
            bool isCollateralValueCollapsed;
            if (liquidity == LibVaipakam.LiquidityStatus.Liquid) {
                isCollateralValueCollapsed = RiskFacet(address(this))
                    .isCollateralValueCollapsed(loanId);
            }

            if (
                liquidity == LibVaipakam.LiquidityStatus.Liquid &&
                !isCollateralValueCollapsed
            ) {
                // Time-based default with liquid collateral: swap directly without HF check.
                // RiskFacet.triggerLiquidation requires HF < 1 (for HF-based liquidation),
                // but time-based defaults are independent — the README treats non-repayment
                // after grace as a separate default trigger regardless of collateral health.

                // Withdraw collateral from borrower's escrow
                LibFacet.crossFacetCall(
                    abi.encodeWithSelector(
                        EscrowFactoryFacet.escrowWithdrawERC20.selector,
                        loan.borrower,
                        loan.collateralAsset,
                        address(this),
                        loan.collateralAmount
                    ),
                    EscrowWithdrawFailed.selector
                );

                // README §3 lines 140–141 + §7 line 263: compute the oracle-
                // derived expected output and the 6% slippage floor. Adapters
                // enforce the floor on their side (UniV3 / Balancer pass it
                // through to the underlying DEX as `amountOutMinimum`;
                // aggregators check via balance delta around the call).
                uint256 expectedProceeds = LibFallback.expectedSwapOutput(
                    address(this),
                    loan.collateralAsset,
                    loan.principalAsset,
                    loan.collateralAmount
                );
                uint256 minOutputAmount = (expectedProceeds *
                    (LibVaipakam.BASIS_POINTS - LibVaipakam.cfgMaxLiquidationSlippageBps())) /
                    LibVaipakam.BASIS_POINTS;

                // Phase 7a — caller-ranked failover across the registered
                // swap adapters (mirror of RiskFacet.triggerLiquidation).
                // Total failure routes to the same full-collateral
                // fallback as pre-7a.
                (bool swapSuccess, uint256 proceedsFromSwap, ) = LibSwap.swapWithFailover(
                    loanId,
                    loan.collateralAsset,
                    loan.principalAsset,
                    loan.collateralAmount,
                    minOutputAmount,
                    address(this),
                    adapterCalls
                );
                if (!swapSuccess) {
                    _fullCollateralTransferFallback(loanId, loan);
                    emit LoanDefaulted(loanId, loan.fallbackConsentFromBoth);
                    return;
                }
                uint256 proceeds = proceedsFromSwap;

                // Liquid-collateral DEX liquidation succeeded → "Loan Liquidated".
                terminalStatus = LibVaipakam.LoanPositionStatus.LoanLiquidated;

                // Distribute: principal + accrued interest + late fees.
                // Treasury fee is split out of the interest/late portion (not added on top).
                // Lender bears loss if proceeds are insufficient (per README).
                uint256 elapsed = block.timestamp - loan.startTime;
                uint256 accruedInterest = (loan.principal * loan.interestRateBps * elapsed) /
                    (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
                uint256 lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
                uint256 totalDebt = loan.principal + accruedInterest + lateFee;
                uint256 interestPortion = accruedInterest + lateFee;

                // README §3 liquidation-handling charge: treasury receives
                // 2% of gross proceeds on successful DEX liquidation. This is
                // additive to the treasury fee taken from recovered interest.
                uint256 handlingFee = (proceeds * LibVaipakam.cfgLiquidationHandlingFeeBps())
                    / LibVaipakam.BASIS_POINTS;
                uint256 afterFees = proceeds - handlingFee;

                // Allocate from proceeds after the handling fee.
                uint256 allocated = afterFees > totalDebt ? totalDebt : afterFees;
                uint256 borrowerSurplus = afterFees > totalDebt ? afterFees - totalDebt : 0;

                // Treasury takes its cut from the interest/late portion of allocated amount.
                // If allocated < principal, lender is already taking a loss — no interest to split.
                uint256 treasuryInterestFee;
                uint256 lenderProceeds;
                if (allocated > loan.principal) {
                    uint256 interestRecovered = allocated - loan.principal;
                    // Cap to actual interest portion (rest is principal)
                    if (interestRecovered > interestPortion) interestRecovered = interestPortion;
                    (treasuryInterestFee, ) = LibEntitlement.splitTreasury(interestRecovered);
                    lenderProceeds = allocated - treasuryInterestFee;
                } else {
                    // Undercollateralized below principal: lender bears full loss, no treasury interest fee
                    treasuryInterestFee = 0;
                    lenderProceeds = allocated;
                }

                // Send treasury handling fee + interest fee in a single transfer.
                uint256 toTreasury = handlingFee + treasuryInterestFee;
                if (toTreasury > 0) {
                    IERC20(loan.principalAsset).safeTransfer(treasury, toTreasury);
                }

                // Deposit lender proceeds into lender's escrow for claim
                address lenderEscrow = LibFacet.getOrCreateEscrow(loan.lender);
                if (lenderProceeds > 0) {
                    IERC20(loan.principalAsset).safeTransfer(lenderEscrow, lenderProceeds);
                    // T-051 — Diamond-side transfer to escrow ticks
                    // the protocolTrackedEscrowBalance counter.
                    LibVaipakam.recordEscrowDeposit(loan.lender, loan.principalAsset, lenderProceeds);
                }

                s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                    asset: loan.principalAsset,
                    amount: lenderProceeds,
                    assetType: LibVaipakam.AssetType.ERC20,
                    tokenId: 0,
                    quantity: 0,
                    claimed: false
                });

                // Borrower surplus
                if (borrowerSurplus > 0) {
                    address borrowerEscrow = LibFacet.getOrCreateEscrow(loan.borrower);
                    IERC20(loan.principalAsset).safeTransfer(borrowerEscrow, borrowerSurplus);
                    LibVaipakam.recordEscrowDeposit(loan.borrower, loan.principalAsset, borrowerSurplus);
                }
                s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
                    asset: loan.principalAsset,
                    amount: borrowerSurplus,
                    assetType: LibVaipakam.AssetType.ERC20,
                    tokenId: 0,
                    quantity: 0,
                    claimed: borrowerSurplus == 0
                });
            } else if (
                ((liquidity == LibVaipakam.LiquidityStatus.Liquid &&
                    isCollateralValueCollapsed) ||
                    (liquidity == LibVaipakam.LiquidityStatus.Illiquid &&
                        loan.fallbackConsentFromBoth))
            ) {
                // Illiquid or value collapsed: Move collateral from borrower's escrow to lender's escrow
                // so ClaimFacet.claimAsLender can withdraw from lender's escrow consistently.
                address lenderEscrow = LibFacet.getOrCreateEscrow(loan.lender);

                if (loan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EscrowFactoryFacet.escrowWithdrawERC20.selector,
                            loan.borrower,
                            loan.collateralAsset,
                            address(this),
                            loan.collateralAmount
                        ),
                        EscrowWithdrawFailed.selector
                    );
                    IERC20(loan.collateralAsset).safeTransfer(lenderEscrow, loan.collateralAmount);
                    // T-051 — Diamond-side transfer to lender's escrow
                    // ticks the protocolTrackedEscrowBalance counter.
                    LibVaipakam.recordEscrowDeposit(loan.lender, loan.collateralAsset, loan.collateralAmount);
                } else if (loan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EscrowFactoryFacet.escrowWithdrawERC721.selector,
                            loan.borrower,
                            loan.collateralAsset,
                            loan.collateralTokenId,
                            lenderEscrow
                        ),
                        EscrowWithdrawFailed.selector
                    );
                } else if (loan.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            EscrowFactoryFacet.escrowWithdrawERC1155.selector,
                            loan.borrower,
                            loan.collateralAsset,
                            loan.collateralTokenId,
                            loan.collateralQuantity,
                            lenderEscrow
                        ),
                        EscrowWithdrawFailed.selector
                    );
                }

                // Record collateral claim for the lender
                s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                    asset: loan.collateralAsset,
                    amount: loan.collateralAmount,
                    assetType: loan.collateralAssetType,
                    tokenId: loan.collateralTokenId,
                    quantity: loan.collateralQuantity,
                    claimed: false
                });

                // Any heldForLender from prior preclose top-ups are handled by
                // ClaimFacet.claimAsLender, which withdraws them in the correct
                // payment asset via the NFT-gated claim model.
                // No borrower claim on default (lender takes full collateral)
            } else {
                revert LiquidationFailed();
            }
        }

        // NFT-specific handling (if lendingAsset is NFT)
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            // Reset renter
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowSetNFTUser.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    address(0),
                    0
                ),
                NFTRenterUpdateFailed.selector
            );

            // NFT stays in escrow — returned to lender via ClaimFacet.claimAsLender
            // (NFT-gated: lender must own the Vaipakam position NFT to claim).

            // Buffer to treasury immediately (no claim needed for treasury)
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC20.selector,
                    loan.borrower,
                    loan.prepayAsset,
                    treasury,
                    loan.bufferAmount
                ),
                TreasuryTransferFailed.selector
            );

            // Lender's prepay share: rental fees minus treasury fee (buffer already sent to treasury)
            (uint256 treasuryFee, uint256 prepayToLender) = LibEntitlement.splitTreasury(
                loan.prepayAmount
            );

            // Withdraw full prepay from borrower escrow
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC20.selector,
                    loan.borrower,
                    loan.prepayAsset,
                    address(this),
                    loan.prepayAmount
                ),
                EscrowWithdrawFailed.selector
            );

            // Treasury fee from rental portion
            IERC20(loan.prepayAsset).safeTransfer(treasury, treasuryFee);
            LibFacet.recordTreasuryAccrual(loan.prepayAsset, treasuryFee);

            // Lender gets remainder
            address lenderEscrow = LibFacet.getOrCreateEscrow(loan.lender);
            IERC20(loan.prepayAsset).safeTransfer(lenderEscrow, prepayToLender);
            // T-051 — Diamond-side transfer to lender's escrow ticks
            // the protocolTrackedEscrowBalance counter.
            LibVaipakam.recordEscrowDeposit(loan.lender, loan.prepayAsset, prepayToLender);

            // Record lender's claimable prepay fees. heldForLender handled by ClaimFacet.
            s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: prepayToLender,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });
            // No borrower claim on NFT rental default
        }

        if (loan.status != LibVaipakam.LoanStatus.Defaulted) {
            // Either Active (direct default of illiquid loan) or
            // FallbackPending (retry succeeded) transitions here.
            LibLifecycle.transitionFromAny(loan, LibVaipakam.LoanStatus.Defaulted);

            // Phase 5 / §5.2b — default is NOT a proper close, so the
            // borrower forfeits any up-front VPFI paid for the LIF. The
            // Diamond flushes the full held amount to treasury; no
            // rebate is credited. No-op on loans that paid LIF in the
            // lending asset (vpfiHeld == 0).
            LibVPFIDiscount.forfeitBorrowerLif(loan);

            // Terminal NFT status ("Loan Defaulted" or "Loan Liquidated" per README §7).
            // Burns happen in ClaimFacet after the lender/borrower claims.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaipakamNFTFacet.updateNFTStatus.selector,
                    loan.lenderTokenId,
                    loanId,
                    terminalStatus
                ),
                NFTStatusUpdateFailed.selector
            );
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaipakamNFTFacet.updateNFTStatus.selector,
                    loan.borrowerTokenId,
                    loanId,
                    terminalStatus
                ),
                NFTStatusUpdateFailed.selector
            );

            // Default → borrower loses interaction rewards, lender keeps hers.
            LibInteractionRewards.closeLoan(loanId, /* borrowerClean */ false, /* lenderForfeit */ false);
        }
        emit LoanDefaulted(loanId, loan.fallbackConsentFromBoth);
    }

    /**
     * @notice View function to check if a loan is defaultable (past grace period).
     * @dev Enhanced: For off-chain monitoring or UI.
     * @param loanId The loan ID.
     * @return isDefaultable True if past grace period.
     */
    function isLoanDefaultable(
        uint256 loanId
    ) external view returns (bool isDefaultable) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) return false;

        uint256 endTime = loan.startTime + loan.durationDays * 1 days;
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        return block.timestamp > graceEnd;
    }

    /// @dev Fallback from triggerDefault when the DEX swap reverts or would
    ///      exceed the 6% slippage ceiling (README §7 lines 142–153). The
    ///      collateral is already inside the diamond. We record the README
    ///      §7 three-way split in a FallbackSnapshot and hold the collateral
    ///      so ClaimFacet may retry the swap once during the lender claim;
    ///      if that retry also fails (or the borrower claims first),
    ///      ClaimFacet distributes the collateral per this split. Mirrors
    ///      RiskFacet._fullCollateralTransferFallback.
    function _fullCollateralTransferFallback(
        uint256 loanId,
        LibVaipakam.Loan storage loan
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        (
            uint256 lenderCol,
            uint256 treasuryCol,
            uint256 borrowerCol,
            uint256 lenderPrincDue,
            uint256 treasuryPrincDue
        ) = LibFallback.computeFallbackEntitlements(address(this), loan, loanId);

        s.fallbackSnapshot[loanId] = LibVaipakam.FallbackSnapshot({
            lenderCollateral: lenderCol,
            treasuryCollateral: treasuryCol,
            borrowerCollateral: borrowerCol,
            lenderPrincipalDue: lenderPrincDue,
            treasuryPrincipalDue: treasuryPrincDue,
            active: true,
            retryAttempted: false
        });

        // Record claims in collateral units; ClaimFacet will resolve based
        // on retry outcome.
        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: lenderCol,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: borrowerCol,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: borrowerCol == 0
        });

        // Enter fallback-pending: borrower may still cure via addCollateral or
        // repayLoan until the lender claims. See LibVaipakam.LoanStatus docs.
        LibLifecycle.transition(
            loan,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.FallbackPending
        );

        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanFallbackPending
            ),
            NFTStatusUpdateFailed.selector
        );

        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanFallbackPending
            ),
            NFTStatusUpdateFailed.selector
        );

        emit LiquidationFallback(loanId, loan.lender, loan.collateralAmount);
        emit LiquidationFallbackSplit(
            loanId,
            s.fallbackSnapshot[loanId].lenderCollateral,
            s.fallbackSnapshot[loanId].treasuryCollateral,
            s.fallbackSnapshot[loanId].borrowerCollateral
        );
    }

}
