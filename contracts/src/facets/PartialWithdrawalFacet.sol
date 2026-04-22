// src/facets/PartialWithdrawalFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {EscrowFactoryFacet} from "./EscrowFactoryFacet.sol";

/**
 * @title PartialWithdrawalFacet
 * @author Vaipakam Developer Team
 * @notice This facet allows borrowers to withdraw partial collateral from active loans if post-withdrawal Health Factor remains above threshold and LTV below max.
 * @dev Part of Diamond Standard (EIP-2535). Uses shared LibVaipakam storage.
 *      Calculates max withdrawable to maintain min HF (e.g., 150%) and max LTV (e.g., per asset maxLtvBps).
 *      Enhanced: Integrated HF validation post-withdrawal (>= min HF) alongside LTV check.
 *      Disallows for illiquid assets ($0 value per specs).
 *      Custom errors, events, ReentrancyGuard. Cross-facet calls for oracle/risk/escrow.
 *      Callable only by borrower. Updates loan.collateralAmount.
 *      Expand for Phase 2 (e.g., multi-collateral, governance-configurable threshold).
 */
contract PartialWithdrawalFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted when partial collateral is withdrawn.
    /// @param loanId The loan ID.
    /// @param borrower The borrower's address.
    /// @param amount The withdrawn collateral amount.
    /// @param newHF The post-withdrawal Health Factor (scaled to 1e18).
    /// @param newLTV The post-withdrawal LTV (in bps).
    event PartialCollateralWithdrawn(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 amount,
        uint256 newHF,
        uint256 newLTV
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error AmountTooHigh();

    /**
     * @notice Allows borrower to withdraw partial collateral from an active loan.
     * @dev Checks liquidity (must be liquid), simulates post-HF >= min and post-LTV <= max, withdraws from escrow, updates loan.collateralAmount.
     *      Reverts if illiquid, low HF, or high LTV post-withdrawal.
     *      Emits PartialCollateralWithdrawn.
     * @param loanId The active loan ID.
     * @param amount The collateral amount to withdraw (must <= max withdrawable).
     */
    function partialWithdrawCollateral(
        uint256 loanId,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.borrower != msg.sender) revert NotBorrower();
        if (loan.status != LibVaipakam.LoanStatus.Active) revert LoanNotActive();
        if (amount == 0 || amount > loan.collateralAmount)
            revert AmountTooHigh();

        // Check liquidity: Must be liquid
        (bool liqSuccess, bytes memory liqResult) = address(this).staticcall(
            abi.encodeWithSelector(
                OracleFacet.checkLiquidity.selector,
                loan.collateralAsset
            )
        );
        if (
            !liqSuccess ||
            abi.decode(liqResult, (LibVaipakam.LiquidityStatus)) !=
            LibVaipakam.LiquidityStatus.Liquid
        ) revert IlliquidAsset();

        // Simulate post-withdrawal HF and LTV using a single oracle/decimals load
        uint256 tempCollateral = loan.collateralAmount - amount;
        ValuationContext memory ctx = _loadValuationContext(loan);
        uint256 collateralUSD = (tempCollateral * ctx.collateralPrice) /
            ctx.collateralPriceDivisor;

        uint256 simulatedHF = _hfFromContext(ctx, collateralUSD);
        if (simulatedHF < LibVaipakam.MIN_HEALTH_FACTOR)
            revert HealthFactorTooLow();

        uint256 simulatedLTV = _ltvFromContext(ctx, collateralUSD);
        uint256 maxLtvBps = s.assetRiskParams[loan.collateralAsset].maxLtvBps;
        if (simulatedLTV > maxLtvBps) revert LTVExceeded();

        // Withdraw from escrow to borrower
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowWithdrawERC20.selector,
                msg.sender,
                loan.collateralAsset,
                msg.sender,
                amount
            ),
            EscrowWithdrawFailed.selector
        );

        // Update loan collateral
        loan.collateralAmount -= amount;

        emit PartialCollateralWithdrawn(
            loanId,
            msg.sender,
            amount,
            simulatedHF,
            simulatedLTV
        );
    }

    /**
     * @notice View function to calculate the maximum withdrawable collateral amount.
     * @dev Simulates withdrawals to find max amount where HF >= min and LTV <= maxLtvBps.
     *      Binary search for efficiency (gas-optimized).
     *      Returns 0 for illiquid assets.
     * @param loanId The loan ID.
     * @return maxAmount The maximum withdrawable collateral amount.
     */
    function calculateMaxWithdrawable(
        uint256 loanId
    ) external view returns (uint256 maxAmount) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // Quick checks
        if (
            loan.status != LibVaipakam.LoanStatus.Active ||
            loan.collateralAmount == 0
        ) return 0;

        // Illiquid: 0
        (bool success, bytes memory result) = address(this).staticcall(
            abi.encodeWithSelector(
                OracleFacet.checkLiquidity.selector,
                loan.collateralAsset
            )
        );
        if (
            !success ||
            abi.decode(result, (LibVaipakam.LiquidityStatus)) !=
            LibVaipakam.LiquidityStatus.Liquid
        ) return 0;

        // Hoist everything invariant across iterations out of the binary
        // search. Previously each iteration called _simulateHF + _simulateLTV,
        // which each re-ran 2 × getAssetPrice + 2 × decimals() — ~60 loop
        // iterations × 8 staticcalls = 480 duplicated cross-facet calls.
        ValuationContext memory ctx = _loadValuationContext(loan);
        uint256 maxLtvBps = s.assetRiskParams[loan.collateralAsset].maxLtvBps;

        uint256 low = 0;
        uint256 high = loan.collateralAmount;
        while (low < high) {
            uint256 mid = (low + high + 1) / 2; // Ceiling
            uint256 tempCollateral = loan.collateralAmount - mid;
            uint256 collateralUSD = (tempCollateral * ctx.collateralPrice) /
                ctx.collateralPriceDivisor;

            uint256 simHF = _hfFromContext(ctx, collateralUSD);
            uint256 simLTV = _ltvFromContext(ctx, collateralUSD);

            if (simHF >= LibVaipakam.MIN_HEALTH_FACTOR && simLTV <= maxLtvBps) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return low;
    }

    /// @dev Snapshot of all loan- and oracle-derived values needed to price
    ///      a simulated withdrawal. Fetched once per call in
    ///      partialWithdrawCollateral / calculateMaxWithdrawable and then
    ///      reused for every HF / LTV evaluation.
    struct ValuationContext {
        uint256 borrowValueUSD;
        uint256 collateralPrice;
        uint256 collateralPriceDivisor; // 10**(feedDecimals + tokenDecimals)
        uint256 liqThresholdBps;
    }

    /// @dev Build a ValuationContext for `loan` — runs two getAssetPrice
    ///      staticcalls and two decimals() staticcalls exactly once.
    function _loadValuationContext(
        LibVaipakam.Loan storage loan
    ) internal view returns (ValuationContext memory ctx) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 currentBorrowBalance = _calculateCurrentBorrowBalance(loan);

        (uint256 borrowPrice, uint8 borrowFeedDecimals) = OracleFacet(address(this))
            .getAssetPrice(loan.principalAsset);
        uint8 borrowTokenDecimals = IERC20Metadata(loan.principalAsset).decimals();
        ctx.borrowValueUSD = (currentBorrowBalance * borrowPrice) /
            (10 ** borrowFeedDecimals) / (10 ** borrowTokenDecimals);

        (uint256 collateralPrice, uint8 collateralFeedDecimals) = OracleFacet(address(this))
            .getAssetPrice(loan.collateralAsset);
        uint8 collateralTokenDecimals = IERC20Metadata(loan.collateralAsset).decimals();
        ctx.collateralPrice = collateralPrice;
        ctx.collateralPriceDivisor =
            (10 ** collateralFeedDecimals) * (10 ** collateralTokenDecimals);

        ctx.liqThresholdBps = s.assetRiskParams[loan.collateralAsset].liqThresholdBps;
    }

    function _hfFromContext(
        ValuationContext memory ctx,
        uint256 collateralValueUSD
    ) internal pure returns (uint256) {
        if (ctx.borrowValueUSD == 0) return type(uint256).max;
        uint256 riskAdjustedCollateral =
            (collateralValueUSD * ctx.liqThresholdBps) / LibVaipakam.BASIS_POINTS;
        return (riskAdjustedCollateral * LibVaipakam.HF_SCALE) / ctx.borrowValueUSD;
    }

    function _ltvFromContext(
        ValuationContext memory ctx,
        uint256 collateralValueUSD
    ) internal pure returns (uint256) {
        if (collateralValueUSD == 0) return type(uint256).max;
        return (ctx.borrowValueUSD * LibVaipakam.BASIS_POINTS) / collateralValueUSD;
    }

    /// @dev Thin wrapper over the context-based helpers so the mutating
    ///      path still exposes the original two-call simulate flow.
    function _simulateHF(
        LibVaipakam.Loan storage loan,
        uint256 tempCollateral
    ) internal view returns (uint256) {
        ValuationContext memory ctx = _loadValuationContext(loan);
        uint256 collateralUSD = (tempCollateral * ctx.collateralPrice) /
            ctx.collateralPriceDivisor;
        return _hfFromContext(ctx, collateralUSD);
    }

    function _simulateLTV(
        LibVaipakam.Loan storage loan,
        uint256 tempCollateral
    ) internal view returns (uint256) {
        ValuationContext memory ctx = _loadValuationContext(loan);
        uint256 collateralUSD = (tempCollateral * ctx.collateralPrice) /
            ctx.collateralPriceDivisor;
        return _ltvFromContext(ctx, collateralUSD);
    }

    // Internal helper for current borrow balance with accrued interest
    function _calculateCurrentBorrowBalance(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256) {
        return loan.principal + LibEntitlement.accruedInterestToTime(loan, block.timestamp);
    }
}
