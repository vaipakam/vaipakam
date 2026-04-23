// src/facets/RiskFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
 // For NFT updates/burns
import {EscrowFactoryFacet} from "./EscrowFactoryFacet.sol";
 // For transfers
import {ProfileFacet} from "./ProfileFacet.sol";
 // For KYC if high-value
import {IZeroExProxy} from "../interfaces/IZeroExProxy.sol";
 // For swap calldata encoding

/**
 * @title RiskFacet
 * @author Vaipakam Developer Team
 * @notice Risk parameter management, LTV/Health-Factor calculations, and
 *         HF-triggered liquidation for the Vaipakam P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable
 *      (mutating paths only; views are always available).
 *
 *      Per-asset risk parameters (`AssetRiskParams`): maxLtvBps,
 *      liqThresholdBps, liqBonusBps, reserveFactorBps, minPartialBps —
 *      updatable by RISK_ADMIN_ROLE.
 *
 *      Formulas (liquid assets only; illiquid reverts NonLiquidAsset):
 *        LTV  = (borrowBalanceUSD × 10000) / collateralValueUSD  [BPS]
 *        HF   = (collateralUSD × liqThresholdBps / 10000) / borrowBalanceUSD  [1e18]
 *        borrowBalance = principal + accrued interest (pro-rata seconds-based).
 *      USD prices sourced from {OracleFacet.getAssetPrice}.
 *
 *      Liquidation ({triggerLiquidation}): permissionless when HF < 1e18.
 *      Swaps collateral → principal-asset via 0x (slippage ≤
 *      `MAX_LIQUIDATION_SLIPPAGE_BPS` = 6%). On swap failure or slippage
 *      breach, falls back to {LibFallback.record} — full collateral stays
 *      in the Diamond until {ClaimFacet} retries or distributes the split.
 *      On success: liqBonus to liquidator, remainder split per
 *      {LibEntitlement.splitTreasury} (1% treasury, 99% lender).
 */
contract RiskFacet is DiamondReentrancyGuard, DiamondPausable, DiamondAccessControl, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted when an asset's risk parameters are updated.
    /// @param asset The asset address.
    /// @param maxLtvBps New max LTV in basis points.
    /// @param liqThresholdBps New liquidation threshold in basis points.
    /// @param liqBonusBps New liquidation bonus in basis points.
    /// @param reserveFactorBps New reserve factor in basis points.
    event RiskParamsUpdated(
        address indexed asset,
        uint256 maxLtvBps,
        uint256 liqThresholdBps,
        uint256 liqBonusBps,
        uint256 reserveFactorBps
    );

    /// @notice Emitted when a liquidation is triggered via HF.
    /// @param loanId The ID of the liquidated loan.
    /// @param liquidator The caller who triggered.
    /// @param proceeds The recovered amount.
    event HFLiquidationTriggered(
        uint256 indexed loanId,
        address indexed liquidator,
        uint256 proceeds
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidLoan();
    error ZeroCollateral();
    error HealthFactorNotLow();
    /// @notice L2 sequencer is offline or still in its 1h recovery grace
    ///         window; HF-based liquidation is blocked to avoid swapping
    ///         against stale Chainlink / AMM state.
    error SequencerUnhealthy();

    // MAX_LIQUIDATION_SLIPPAGE_BPS consolidated in LibVaipakam

    /// @notice Emitted when a liquidation falls back to the claim-time
    ///         settlement path because the DEX swap reverted or exceeded
    ///         the 6% slippage threshold (README §7). The collateral stays
    ///         in the Diamond until ClaimFacet either retries the swap or
    ///         distributes the recorded split. `collateralAmount` is the
    ///         full borrower collateral entering the fallback — matches the
    ///         legacy event shape. See LiquidationFallbackSplit for the
    ///         detailed three-way allocation.
    event LiquidationFallback(
        uint256 indexed loanId,
        address indexed lender,
        uint256 collateralAmount
    );

    /// @notice Emitted alongside LiquidationFallback with the README §7 split.
    /// @param loanId The liquidated loan ID.
    /// @param lenderCollateral Collateral units allocated to the lender if
    ///        the claim-time retry fails (equivalent of principal + accrued
    ///        interest + late fees + 3%, capped at available collateral).
    /// @param treasuryCollateral Collateral units allocated to the treasury
    ///        (equivalent of 2% of principal), zero when undercollateralized.
    /// @param borrowerCollateral Remaining collateral for the borrower.
    event LiquidationFallbackSplit(
        uint256 indexed loanId,
        uint256 lenderCollateral,
        uint256 treasuryCollateral,
        uint256 borrowerCollateral
    );

    /**
     * @notice Updates risk parameters for an asset.
     * @dev Callable only by Diamond owner (multi-sig/governance).
     *      Validates params (e.g., liqThreshold > maxLtv).
     *      Emits RiskParamsUpdated.
     * @param asset The asset address (collateral/lending).
     * @param maxLtvBps Max LTV in bps (e.g., 8000 for 80%).
     * @param liqThresholdBps Liquidation threshold in bps (> maxLtv).
     * @param liqBonusBps Per-asset ceiling on the dynamic liquidator incentive, in bps.
     *        Must be ≤ MAX_LIQUIDATOR_INCENTIVE_BPS (300 = 3%). The runtime incentive is
     *        still computed as `6% − realized slippage%` capped at 3%; this value only
     *        lets governance tighten that cap further per asset.
     * @param reserveFactorBps Reserve factor in bps.
     */
    function updateRiskParams(
        address asset,
        uint256 maxLtvBps,
        uint256 liqThresholdBps,
        uint256 liqBonusBps,
        uint256 reserveFactorBps
    ) external whenNotPaused onlyRole(LibAccessControl.RISK_ADMIN_ROLE) {
        if (asset == address(0)) revert InvalidAsset();
        if (maxLtvBps == 0 || maxLtvBps > LibVaipakam.BASIS_POINTS) revert UpdateNotAllowed();
        if (liqThresholdBps <= maxLtvBps || liqThresholdBps > LibVaipakam.BASIS_POINTS) revert UpdateNotAllowed();
        // README §3: liquidator incentive is dynamic (6% − realized slippage)
        // and capped at 3% of liquidation proceeds. The stored `liqBonusBps`
        // is a legacy ceiling and must never be configured above that cap.
        if (liqBonusBps > LibVaipakam.cfgMaxLiquidatorIncentiveBps()) revert UpdateNotAllowed();
        if (reserveFactorBps > LibVaipakam.BASIS_POINTS) revert UpdateNotAllowed();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RiskParams storage params = s.assetRiskParams[asset];
        params.maxLtvBps = maxLtvBps;
        params.liqThresholdBps = liqThresholdBps;
        params.liqBonusBps = liqBonusBps;
        params.reserveFactorBps = reserveFactorBps;

        emit RiskParamsUpdated(
            asset,
            maxLtvBps,
            liqThresholdBps,
            liqBonusBps,
            reserveFactorBps
        );
    }

    /**
     * @notice Calculates the current LTV for a loan in basis points.
     * @dev LTV = (borrowedValueUSD * 10000) / collateralValueUSD.
     *      Reverts if collateral illiquid (NonLiquidAsset).
     *      Uses Oracle for prices.
     *      For Vaipakam Phase 1 single-asset; expand for multi.
     * @param loanId The loan ID.
     * @return ltv The LTV in basis points (e.g., 7500 for 75%).
     */
    function calculateLTV(uint256 loanId) public view returns (uint256 ltv) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.id == 0 || loan.collateralAmount == 0) revert InvalidLoan();

        // Explicit revert for illiquid — HF/LTV requires prices for both assets
        if (loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
            loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid)
            revert NonLiquidAsset();

        (uint256 borrowedValueUSD, uint256 collateralValueUSD) = _computeUsdValues(loan);
        if (collateralValueUSD == 0) revert ZeroCollateral();

        // Rounds DOWN (borrower-favourable by <=1 BPS). A loan exactly at the
        // cap slips 1 BPS under; given USD-18 scaled values the absolute error
        // is sub-dust and acceptable. Do NOT change to ceilDiv without
        // retuning `maxLTVBps` thresholds.
        ltv = (borrowedValueUSD * LibVaipakam.BASIS_POINTS) / collateralValueUSD;
    }

    /**
     * @notice Calculates the Health Factor (HF) for a loan.
     * @dev HF = (collateralValueUSD * liqThresholdBps / 10000) / currentBorrowBalanceUSD; scaled to 1e18.
     *      Includes accrued interest in borrow balance.
     *      Reverts if collateral illiquid (NonLiquidAsset).
     *      Uses Oracle for prices.
     *      For Vaipakam Phase 1 single-asset; expand for multi.
     * @param loanId The loan ID.
     * @return healthFactor The HF scaled to 1e18 (e.g., 1.5e18 = 1.5).
     */
    function calculateHealthFactor(
        uint256 loanId
    ) public view returns (uint256 healthFactor) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.id == 0 || loan.collateralAmount == 0) revert InvalidLoan();

        // Explicit revert for illiquid — HF requires prices for both assets
        if (loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
            loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid)
            revert NonLiquidAsset();

        (uint256 borrowValueUSD, uint256 collateralValueUSD) = _computeUsdValues(loan);

        if (borrowValueUSD == 0) return type(uint256).max; // Infinite HF if no borrow

        uint256 liqThresholdBps = s
            .assetRiskParams[loan.collateralAsset]
            .liqThresholdBps;
        // Rounds DOWN on both steps — HF is slightly under-reported, which
        // means liquidation may trigger marginally earlier than theoretical.
        // Protocol-favourable (safe direction). Error magnitude: sub-wei on
        // HF_SCALE (1e18) for realistic collateral sizes.
        uint256 riskAdjustedCollateral = (collateralValueUSD *
            liqThresholdBps) / LibVaipakam.BASIS_POINTS;

        healthFactor =
            (riskAdjustedCollateral * LibVaipakam.HF_SCALE) /
            borrowValueUSD;
    }

    /**
     * @notice Checks if loan is in high volatility state (collateral << loan).
     * @dev For abnormal fallback; uses LTV > threshold. View func.
     * @param loanId Loan ID.
     * @return isCollateralCollapsed True if high volatility (LTV > VOLATILITY_LTV_THRESHOLD_BPS or HF < 1e18).
     */
    function isCollateralValueCollapsed(
        uint256 loanId
    ) external view returns (bool isCollateralCollapsed) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.id == 0 || loan.collateralAmount == 0) revert InvalidLoan();
        if (loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
            loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid)
            revert NonLiquidAsset();

        // Single-pass: fetch prices + decimals once and derive both LTV and
        // HF from the shared (borrowUSD, collateralUSD) pair.
        (uint256 borrowValueUSD, uint256 collateralValueUSD) = _computeUsdValues(loan);
        if (collateralValueUSD == 0) revert ZeroCollateral();

        uint256 ltv = (borrowValueUSD * LibVaipakam.BASIS_POINTS) / collateralValueUSD;

        uint256 hf;
        if (borrowValueUSD == 0) {
            hf = type(uint256).max;
        } else {
            uint256 liqThresholdBps = s
                .assetRiskParams[loan.collateralAsset]
                .liqThresholdBps;
            uint256 riskAdjustedCollateral = (collateralValueUSD * liqThresholdBps)
                / LibVaipakam.BASIS_POINTS;
            hf = (riskAdjustedCollateral * LibVaipakam.HF_SCALE) / borrowValueUSD;
        }

        return ltv > LibVaipakam.cfgVolatilityLtvThresholdBps() || hf < LibVaipakam.HF_SCALE;
    }

    /**
     * @notice Permissionless liquidation trigger if Health Factor < 1e18 for liquid collateral.
     * @dev Uses the configured 0x proxy for the swap. The contract constructs the
     *      swap calldata itself, embedding an oracle-derived `minOutputAmount`
     *      equal to 94% of expected proceeds (README §7: 6% slippage ceiling).
     *      If the DEX rejects that minimum — e.g. due to excess slippage, thin
     *      liquidity, market stress, or any technical failure — execution falls
     *      back to a claimable full-collateral position for the lender via the
     *      Vaipakam NFT claim flow (README §3 lines 140–141). The conversion
     *      literally does not execute in the fallback case because the DEX call
     *      reverts before any collateral leaves the diamond.
     *      Deducts liqBonusBps to liquidator, remainder to lender on success.
     *      Requires KYC for liquidator if bonusUSD > threshold.
     *      Updates loan to Defaulted, marks NFTs Claimable.
     *      Emits HFLiquidationTriggered on success, LiquidationFallback on fallback.
     * @param loanId The loan ID to liquidate.
     */
    function triggerLiquidation(
        uint256 loanId
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert InvalidLoan();

        // L2 circuit breaker: block HF-based liquidation when the sequencer
        // is down or still in the 1h grace window. Chainlink prices and
        // AMM pools may be stale under those conditions, so a swap here
        // would execute against mispriced state and either cross heavy
        // slippage or unfairly punish the borrower. Time-based defaults
        // (DefaultedFacet) fall back to full collateral transfer instead.
        if (!OracleFacet(address(this)).sequencerHealthy()) {
            revert SequencerUnhealthy();
        }

        // HF-based liquidation always requires HF < 1. Time-based defaults are handled
        // separately in DefaultedFacet. Without this guard, healthy loans become
        // permissionlessly liquidatable once the grace period passes.
        uint256 hf = RiskFacet(address(this)).calculateHealthFactor(loanId);
        if (hf >= LibVaipakam.HF_SCALE) revert HealthFactorNotLow();

        // Execution routing (README §1): HF-based liquidation requires the
        // collateral to be swappable on the live network. If the active-
        // network liquidity check fails, revert — the time-based default
        // path in DefaultedFacet handles unswappable collateral via the
        // full-collateral-transfer branch.
        LibVaipakam.LiquidityStatus liquidity = OracleFacet(address(this))
            .checkLiquidityOnActiveNetwork(loan.collateralAsset);
        if (liquidity != LibVaipakam.LiquidityStatus.Liquid)
            revert NonLiquidAsset();

        // Withdraw collateral to Diamond for swap
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

        address zeroExProxy = _getZeroExProxy();

        address allowanceTarget = _getAllowanceTarget();

        // Approve 0x for collateral
        IERC20(loan.collateralAsset).approve(
            allowanceTarget,
            loan.collateralAmount
        );

        // Compute expected proceeds from oracle prices and the slippage floor
        // (94% of expected = 6% slippage ceiling per README §7).
        uint256 expectedProceeds = LibFallback.expectedSwapOutput(
            address(this),
            loan.collateralAsset,
            loan.principalAsset,
            loan.collateralAmount
        );
        uint256 maxSlippageBps = LibVaipakam.cfgMaxLiquidationSlippageBps();
        uint256 minOutputAmount = (expectedProceeds *
            (LibVaipakam.BASIS_POINTS - maxSlippageBps)) /
            LibVaipakam.BASIS_POINTS;

        // Construct the swap calldata on-chain so the `minOutputAmount` guard
        // is enforced atomically by the DEX: any slippage > 6% — or abnormal
        // market / liquidity / technical failure — reverts the call before
        // collateral leaves the diamond. README §3 lines 140–141.
        bytes memory swapData = abi.encodeWithSelector(
            IZeroExProxy.swap.selector,
            loan.collateralAsset,
            loan.principalAsset,
            loan.collateralAmount,
            minOutputAmount,
            address(this)
        );

        (bool swapSuccess, bytes memory result) = zeroExProxy.call(swapData);
        if (!swapSuccess) {
            // Slippage exceeded, illiquid pool, or technical failure.
            // Revoke approval and resolve via the claimable full-collateral
            // fallback — the lender's economic entitlement becomes the raw
            // collateral asset via the Vaipakam NFT claim flow.
            IERC20(loan.collateralAsset).approve(allowanceTarget, 0);
            _fullCollateralTransferFallback(loanId, loan);
            return;
        }
        uint256 proceeds = abi.decode(result, (uint256));

        // Revoke approval
        IERC20(loan.collateralAsset).approve(allowanceTarget, 0);

        // Calculate debt: principal + accrued interest + late fees (per README Section 7).
        uint256 currentBorrowBalance = _calculateCurrentBorrowBalance(loan);
        uint256 endTime = loan.startTime + loan.durationDays * 1 days;
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
        uint256 totalDebt = currentBorrowBalance + lateFee;
        uint256 interestPortion = totalDebt - loan.principal;

        // Dynamic liquidator incentive (README §3 line 148):
        //   incentive% = 6% − realized slippage%, capped at 3% of proceeds.
        //   Realized slippage% = (expectedProceeds − actualProceeds) /
        //     expectedProceeds, clamped to [0, 6%].
        // Proceeds above expected (negative slippage) yield the full 3% cap;
        // slippage == 6% yields 0% incentive. The configured asset-level
        // `liqBonusBps` is preserved as an additional ceiling so governance
        // can tighten the cap per asset but never exceed the README maximum.
        uint256 realizedSlippageBps;
        if (proceeds < expectedProceeds) {
            realizedSlippageBps = ((expectedProceeds - proceeds) * LibVaipakam.BASIS_POINTS)
                / expectedProceeds;
            if (realizedSlippageBps > maxSlippageBps) {
                realizedSlippageBps = maxSlippageBps;
            }
        }
        uint256 maxIncentiveBps = LibVaipakam.cfgMaxLiquidatorIncentiveBps();
        uint256 incentiveBps = maxSlippageBps - realizedSlippageBps;
        if (incentiveBps > maxIncentiveBps) {
            incentiveBps = maxIncentiveBps;
        }
        uint256 assetCapBps = s.assetRiskParams[loan.collateralAsset].liqBonusBps;
        if (assetCapBps != 0 && incentiveBps > assetCapBps) incentiveBps = assetCapBps;
        // Rounds DOWN — liquidator bonus slightly under-paid at the wei
        // boundary. Protocol-favourable. Dust accrues to the treasury
        // tranche below rather than the liquidator.
        uint256 bonus = (proceeds * incentiveBps) / LibVaipakam.BASIS_POINTS;

        // Cap bonus to available proceeds
        if (bonus > proceeds) bonus = proceeds;

        // Tiered KYC check for liquidator based on bonus value (per README Section 16)
        (uint256 price, uint8 feedDecimals) = OracleFacet(address(this))
            .getAssetPrice(loan.principalAsset);
        uint8 tokenDecimals = IERC20Metadata(loan.principalAsset).decimals();
        uint256 bonusUSD = (bonus * price * 1e18) / (10 ** feedDecimals) / (10 ** tokenDecimals);
        if (!ProfileFacet(address(this)).meetsKYCRequirement(msg.sender, bonusUSD))
            revert KYCRequired();

        // Liquidation bonus transferred to liquidator immediately
        if (bonus > 0) {
            IERC20(loan.principalAsset).safeTransfer(msg.sender, bonus);
        }

        // Deduct the README §3 liquidation-handling charge: treasury receives
        // 2% of gross proceeds because the borrower failed to act before
        // liquidation. This is separate from, and additive to, the treasury
        // fee taken from recovered interest/late-fee amounts below.
        uint256 handlingFee = (proceeds * LibVaipakam.cfgLiquidationHandlingFeeBps())
            / LibVaipakam.BASIS_POINTS;
        // Defensive: bonus + handlingFee cannot exceed proceeds. With the
        // 3% incentive cap and 2% handling fee, the combined deduction is
        // ≤ 5% of proceeds, so this never triggers in practice but guards
        // against future parameter changes.
        if (bonus + handlingFee > proceeds) {
            handlingFee = proceeds - bonus;
        }

        // Allocate from remaining proceeds after bonus and handling fee.
        // Treasury fee on interest is split from the interest/late portion
        // (not added on top). Lender bears loss if proceeds are insufficient.
        uint256 afterFees = proceeds - bonus - handlingFee;
        address treasury = s.treasury;

        uint256 allocated = afterFees > totalDebt ? totalDebt : afterFees;
        uint256 borrowerSurplus = afterFees > totalDebt ? afterFees - totalDebt : 0;

        // Treasury takes its cut from the interest/late portion of allocated amount.
        uint256 treasuryInterestFee;
        uint256 lenderProceeds;
        if (allocated > loan.principal) {
            uint256 interestRecovered = allocated - loan.principal;
            if (interestRecovered > interestPortion) interestRecovered = interestPortion;
            (treasuryInterestFee, ) = LibEntitlement.splitTreasury(interestRecovered);
            lenderProceeds = allocated - treasuryInterestFee;
        } else {
            // Undercollateralized below principal: no interest to split
            treasuryInterestFee = 0;
            lenderProceeds = allocated;
        }

        // Treasury receives handling fee + interest fee in a single transfer.
        uint256 toTreasury = handlingFee + treasuryInterestFee;
        if (toTreasury > 0) {
            IERC20(loan.principalAsset).safeTransfer(treasury, toTreasury);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, toTreasury);
        }

        // Lender's proceeds deposited into lender's escrow for claim
        address lenderEscrow = LibFacet.getOrCreateEscrow(loan.lender);
        if (lenderProceeds > 0) {
            IERC20(loan.principalAsset).safeTransfer(lenderEscrow, lenderProceeds);
        }

        // Record lender's claimable proceeds. heldForLender handled by ClaimFacet.
        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: lenderProceeds,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });

        // Borrower surplus: any proceeds remaining after bonus + treasury + lender debt
        if (borrowerSurplus > 0) {
            address borrowerEscrow = LibFacet.getOrCreateEscrow(loan.borrower);
            IERC20(loan.principalAsset).safeTransfer(borrowerEscrow, borrowerSurplus);
        }
        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: borrowerSurplus,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: borrowerSurplus == 0
        });

        // Close loan — liquidation is triggered only from Active (HF < 1.0).
        LibLifecycle.transition(
            loan,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.Defaulted
        );

        // HF liquidation → borrower loses interaction rewards, lender keeps hers.
        LibInteractionRewards.closeLoan(loanId, /* borrowerClean */ false, /* lenderForfeit */ false);

        // Update NFT status to Claimable — burns happen in ClaimFacet after lender claims
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanLiquidated
            ),
            NFTStatusUpdateFailed.selector
        );

        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanLiquidated
            ),
            NFTStatusUpdateFailed.selector
        );

        emit HFLiquidationTriggered(loanId, msg.sender, proceeds);
    }

    // /**
    //  * @notice Triggers liquidation if HF < 1e18 for liquid collateral loans.
    //  * @dev Permissionless (anyone can call). Liquidates via 0x swap, applies liqBonus to liquidator.
    //  *      Checks KYC if bonus > $2k. Updates status to Defaulted, burns NFTs.
    //  *      For illiquid: Reverts (NonLiquidAsset).
    //  *      Emits HFLiquidationTriggered.
    //  * @param loanId The loan ID to liquidate.
    //  * @param fillData 0x fill data for swap.
    //  * @param minOutputAmount Min output for slippage.
    //  */
    // function triggerLiquidation(
    //     uint256 loanId,
    //     bytes calldata fillData,
    //     uint256 minOutputAmount
    // ) external whenNotPaused {
    //     // nonReentrant
    //     console.log("Entered into triggerLiquidation Function");
    //     LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
    //     LibVaipakam.Loan storage loan = s.loans[loanId];
    //     if (loan.status != LibVaipakam.LoanStatus.Active) revert InvalidLoan();

    //     uint256 endTime = loan.startTime + loan.durationDays * 1 days;
    //     uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);

    //     // Check HF < 1e18
    //     uint256 hf = this.calculateHealthFactor(loanId);
    //     if (hf >= LibVaipakam.HF_LIQUIDATION_THRESHOLD)
    //         if (block.timestamp <= graceEnd) revert HealthFactorNotLow();

    //     // Liquidity check (revert if non-liquid)
    //     LibVaipakam.LiquidityStatus liquidity = OracleFacet(address(this))
    //         .checkLiquidity(loan.collateralAsset);
    //     if (liquidity != LibVaipakam.LiquidityStatus.Liquid)
    //         revert NonLiquidAsset();

    //     address zeroExProxy = _getZeroExProxy();

    //     // Liquidate: Withdraw collateral, swap via 0x
    //     bool success;
    //     (success, ) = address(this).call(
    //         abi.encodeWithSelector(
    //             EscrowFactoryFacet.escrowWithdrawERC20.selector,
    //             loan.borrower,
    //             loan.collateralAsset,
    //             address(this),
    //             loan.collateralAmount
    //         )
    //     );
    //     if (!success) revert EscrowWithdrawFailed();

    //     IERC20(loan.collateralAsset).approve(
    //         zeroExProxy,
    //         loan.collateralAmount
    //     );
    //     console.log("Inside triggerLiquidation function 001");

    //     (bool swapSuccess, bytes memory swapResult) = zeroExProxy.call(
    //         fillData
    //     );
    //     if (!swapSuccess) {
    //         if (swapResult.length > 0) {
    //             assembly {
    //                 revert(add(swapResult, 0x20), mload(swapResult))
    //             }
    //         } else {
    //             revert LiquidationFailed();
    //         }
    //     }
    //     uint256 proceeds = abi.decode(swapResult, (uint256));
    //     if (proceeds < minOutputAmount) revert InsufficientProceeds();

    //     // Apply liqBonus to liquidator (e.g., 5% of proceeds)
    //     uint256 liqBonusBps = s
    //         .assetRiskParams[loan.collateralAsset]
    //         .liqBonusBps;
    //     uint256 bonus = (proceeds * liqBonusBps) / LibVaipakam.BASIS_POINTS;
    //     IERC20(loan.principalAsset).safeTransfer(msg.sender, bonus);

    //     // Remainder to lender
    //     IERC20(loan.principalAsset).safeTransfer(loan.lender, proceeds - bonus);

    //     // KYC check for liquidator if high value
    //     (uint256 price, uint8 decimals) = OracleFacet(address(this))
    //         .getAssetPrice(loan.principalAsset);
    //     uint256 bonusUSD = (bonus * price) / (10 ** decimals);
    //     if (
    //         bonusUSD > LibVaipakam.KYC_TIER1_THRESHOLD_USD &&
    //         !ProfileFacet(address(this)).isKYCVerified(msg.sender)
    //     ) revert KYCRequired();

    //     // Close loan
    //     loan.status = LibVaipakam.LoanStatus.Defaulted;

    //     // NFT handling (reset/burn similar to default)
    //     (success, ) = address(this).call(
    //         abi.encodeWithSelector(
    //             VaipakamNFTFacet.updateNFTStatus.selector,
    //             loanId,
    //             "Loan Liquidated"
    //         )
    //     );
    //     if (!success) revert NFTStatusUpdateFailed();

    //     (success, ) = address(this).call(
    //         abi.encodeWithSelector(
    //             VaipakamNFTFacet.burnNFT.selector,
    //             loan.lenderTokenId
    //         )
    //     );
    //     if (!success) revert NFTBurnFailed();

    //     (success, ) = address(this).call(
    //         abi.encodeWithSelector(
    //             VaipakamNFTFacet.burnNFT.selector,
    //             loan.borrowerTokenId
    //         )
    //     );
    //     if (!success) revert NFTBurnFailed();

    //     emit HFLiquidationTriggered(loanId, msg.sender, proceeds);
    // }

    /// @dev Fallback from triggerLiquidation when the DEX swap reverts or
    ///      would exceed the 6% slippage ceiling (README §7 lines 142–153).
    ///      The collateral is already inside the diamond (withdrawn before
    ///      the swap attempt). Instead of pushing full collateral to the
    ///      lender, we record the README §7 three-way split in a
    ///      FallbackSnapshot and hold the collateral in the diamond so
    ///      ClaimFacet may attempt liquidation one more time during the
    ///      lender claim. If that retry also fails — or if the borrower
    ///      claims first — ClaimFacet distributes the collateral per the
    ///      snapshot.
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

        // Record claims in collateral units. ClaimFacet will either rewrite
        // these to principal-asset amounts on a successful retry, or push
        // the collateral to lender/treasury/borrower escrows per this split
        // if the retry fails (or the borrower claims first).
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

        // Enter fallback-pending state. Borrower may still cure via addCollateral
        // or repayLoan until the lender claims; see LibVaipakam.LoanStatus docs.
        LibLifecycle.transition(
            loan,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.FallbackPending
        );

        // Mark NFTs with pending status — final Defaulted/Liquidated label is
        // written once the lender claims (or the borrower cures back to Active).
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

    // Internal helper for current borrow balance with accrued interest
    function _calculateCurrentBorrowBalance(
        LibVaipakam.Loan memory loan
    ) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - loan.startTime;
        // Rounds DOWN — borrower-favourable by <=1 wei of principal token,
        // following the standard simple-interest accrual convention.
        // Multiplication happens first (principal * rate * elapsed) so the
        // numerator keeps full precision before the divide.
        uint256 accruedInterest = (loan.principal *
            loan.interestRateBps *
            elapsed) / (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        return loan.principal + accruedInterest;
    }

    /// @dev Fetch oracle prices and ERC20 decimals for principal and
    ///      collateral, returning each side's USD value. Used by
    ///      calculateLTV, calculateHealthFactor, and isCollateralValueCollapsed
    ///      — the latter previously re-ran the full fetch twice (once per
    ///      view) for ~6-9k of duplicated oracle/staticcall overhead.
    function _computeUsdValues(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256 borrowValueUSD, uint256 collateralValueUSD) {
        uint256 currentBorrowBalance = _calculateCurrentBorrowBalance(loan);

        (uint256 borrowPrice, uint8 borrowFeedDecimals) = OracleFacet(address(this))
            .getAssetPrice(loan.principalAsset);
        uint8 borrowTokenDecimals = IERC20Metadata(loan.principalAsset).decimals();
        borrowValueUSD = (currentBorrowBalance * borrowPrice) /
            (10 ** borrowFeedDecimals) / (10 ** borrowTokenDecimals);

        (uint256 collateralPrice, uint8 collateralFeedDecimals) = OracleFacet(address(this))
            .getAssetPrice(loan.collateralAsset);
        uint8 collateralTokenDecimals = IERC20Metadata(loan.collateralAsset).decimals();
        collateralValueUSD = (loan.collateralAmount * collateralPrice) /
            (10 ** collateralFeedDecimals) / (10 ** collateralTokenDecimals);
    }

    /// @dev Get 0x Proxy address
    function _getZeroExProxy() internal view returns (address) {
        return LibVaipakam.storageSlot().zeroExProxy;
    }

    /// @dev Get 0x Proxy address
    function _getAllowanceTarget() internal view returns (address) {
        return LibVaipakam.storageSlot().allowanceTarget;
    }
}
