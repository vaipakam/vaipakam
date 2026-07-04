// src/facets/PartialWithdrawalFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";

/**
 * @title PartialWithdrawalFacet
 * @author Vaipakam Developer Team
 * @notice This facet allows borrowers to withdraw partial collateral from active loans if post-withdrawal Health Factor remains above threshold and LTV below max.
 * @dev Part of Diamond Standard (EIP-2535). Uses shared LibVaipakam storage.
 *      Calculates max withdrawable to maintain min HF (e.g., 150%) and max LTV (e.g., per asset loanInitMaxLtvBps).
 *      Enhanced: Integrated HF validation post-withdrawal (>= min HF) alongside LTV check.
 *      Disallows for illiquid assets ($0 value per specs).
 *      Custom errors, events, ReentrancyGuard. Cross-facet calls for oracle/risk/vault.
 *      Callable only by borrower. Updates loan.collateralAmount.
 *      Expand for Phase 2 (e.g., multi-collateral, governance-configurable threshold).
 */
contract PartialWithdrawalFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted when partial collateral is withdrawn.
    /// @param loanId The loan ID.
    /// @param borrower The borrower's address.
    /// @param amount The withdrawn collateral amount.
    /// @param newCollateralAmount The post-withdrawal `loan.collateralAmount`
    ///        (carries the state, not just the `amount` delta — mirrors
    ///        `AddCollateralFacet.CollateralAdded.newCollateralAmount` so
    ///        an indexer can `UPDATE loans SET collateral_amount = ?`
    ///        directly without a read-back or unsafe string arithmetic).
    /// @param newHf The post-withdrawal Health Factor (scaled to 1e18).
    /// @param newLtv The post-withdrawal LTV (in bps).
    /// @custom:event-category state-change/loan-mutation
    event PartialCollateralWithdrawn(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 amount,
        uint256 newCollateralAmount,
        uint256 newHf,
        uint256 newLtv
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error AmountTooHigh();
    /// @notice #951 (Codex #959 round-5) — a live lender-sale listing pins the
    ///         position's terms for a pending buyer, but the buyer's accept binds
    ///         only the linked loan id + principal, not its live collateral. A
    ///         collateral withdrawal while the listing is open would let the buyer
    ///         pay full principal for a now-under-collateralised loan. Block it;
    ///         the seller cancels the listing to change collateral.
    error SaleListingActive();

    /**
     * @notice Allows borrower to withdraw partial collateral from an active loan.
     * @dev Checks liquidity (must be liquid), simulates post-HF >= min and post-LTV <= max, withdraws from vault, updates loan.collateralAmount.
     *      Reverts if illiquid, low HF, or high LTV post-withdrawal.
     *      Emits PartialCollateralWithdrawn.
     * @param loanId The active loan ID.
     * @param amount The collateral amount to withdraw (must <= max withdrawable).
     */
    function partialWithdrawCollateral(
        uint256 loanId,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 — partial withdraws reduce
        // `loan.collateralAmount` mid-auction; same baseline-drift
        // problem as `addCollateral`. Block while live.
        LibVaipakam.assertNoLiveIntentCommit(loanId);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // #951 (Codex #959 round-5) — freeze collateral while a lender-sale
        // listing is live for this loan, so a pending buyer can't be handed a
        // position whose collateral was silently drained after listing. Mirrors
        // the live-intent freeze above. The seller cancels the listing first.
        if (s.loanToSaleOfferId[loanId] != 0) revert SaleListingActive();
        // #594 — consolidate a transferred borrower position into the current
        // holder's vault FIRST, so the collateral lives in their vault and the
        // rest of this flow operates on an ordinary (non-pinned) loan rather
        // than the keep-in-original-vault special case the comment below
        // describes. Skip-not-block (Tier-2): a sanctioned/excluded holder
        // leaves the collateral in the original vault and this op proceeds under
        // its own gating, unchanged.
        LibConsolidation.consolidateToHolder(
            loanId, false, LibConsolidation.Ctx.Tier2CloseOut
        );
        // #569 Codex #572 round-10 P1 — authorize the CURRENT borrower-
        // position NFT holder, not the stored `loan.borrower`. The
        // collateral physically lives in `loan.borrower`'s vault for the
        // life of the loan (never migrated on a position transfer), and a
        // top-up funded by a transferee lands there too. Gating on
        // `loan.borrower == msg.sender` let a borrower who had SOLD their
        // position still pass the HF/LTV checks, decrement the lien, and
        // withdraw collateral (including the transferee's top-up) out of
        // that vault. Requiring the NFT owner — and delivering to them —
        // aligns the authority with the entitlement. Common case
        // (`msg.sender == loan.borrower == NFT owner`) is unchanged.
        LibAuth.requireBorrowerNftOwner(loan);
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
        uint256 collateralUsd = (tempCollateral * ctx.collateralPrice) /
            ctx.collateralPriceDivisor;

        uint256 simulatedHf = _hfFromContext(ctx, collateralUsd);
        // #394 Lever A (Codex #647 P1) — this loan's ADMISSION floor snapshot,
        // not the live knob: a later retune must not loosen an open position.
        if (simulatedHf < LibVaipakam.effectiveLoanMinHealthFactor(loan.minHealthFactorAtInit))
            revert HealthFactorTooLow();

        uint256 simulatedLtv = _ltvFromContext(ctx, collateralUsd);
        // #394 Lever A (Codex #647 round-3 P1) — enforce THIS loan's snapshotted
        // admission init-LTV cap (tier buffer included), not just the live
        // per-asset cap, so a depth-tiered loan can't shed its tier buffer.
        uint256 loanInitMaxLtvBps = LibVaipakam.effectiveLoanInitLtvCapBps(
            loan.initLtvCapBpsAtInit,
            s.assetRiskParams[loan.collateralAsset].loanInitMaxLtvBps
        );
        if (simulatedLtv > loanInitMaxLtvBps) revert LTVExceeded();

        // #569 §4.2 (2026-06-13) — decrement the collateral lien by the
        // withdrawn slice BEFORE the guarded vault withdraw. The loan
        // stays Active with reduced collateral, so this is a
        // slice-decrement (not a release). Without it the chokepoint
        // guard sees the full lien and reverts this risk-approved
        // excess-collateral withdrawal. Revert-safe: a downstream
        // withdraw failure rolls back the decrement.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.decrementCollateralLien.selector,
                loanId,
                amount
            ),
            bytes4(0)
        );

        // #569 round-10 P1 — withdraw from the STORED `loan.borrower`'s
        // vault (where the collateral physically sits and the lien is
        // keyed) and deliver to `msg.sender` (the verified current
        // borrower-NFT holder). Sourcing from `msg.sender` would pull the
        // caller's own vault — wrong after a position transfer.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                loan.borrower,
                loan.collateralAsset,
                msg.sender,
                amount
            ),
            VaultWithdrawFailed.selector
        );

        // Update loan collateral
        loan.collateralAmount -= amount;

        // #594 Codex #657 round-4 — the eager consolidation above checkpointed
        // the holder's VPFI tier/staking at the FULL pre-withdraw balance; this
        // withdrawal just reduced it. Re-stamp at the post-withdraw balance so
        // the holder doesn't keep fee-tier/staking credit on VPFI that left
        // their vault. No-op for non-VPFI collateral.
        if (loan.collateralAsset == LibVaipakam.storageSlot().vpfiToken) {
            LibConsolidation.restampUserVpfi(loan.borrower);
        }

        emit PartialCollateralWithdrawn(
            loanId,
            msg.sender,
            amount,
            loan.collateralAmount,
            simulatedHf,
            simulatedLtv
        );
    }

    /**
     * @notice View function to calculate the maximum withdrawable collateral amount.
     * @dev Simulates withdrawals to find max amount where HF >= min and LTV <= loanInitMaxLtvBps.
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
        // #394 Lever A (Codex #647 round-3 P1) — bound by THIS loan's
        // snapshotted admission init-LTV cap (the tier buffer for a depth-tiered
        // loan), not the looser live per-asset cap.
        uint256 loanInitMaxLtvBps = LibVaipakam.effectiveLoanInitLtvCapBps(
            loan.initLtvCapBpsAtInit,
            s.assetRiskParams[loan.collateralAsset].loanInitMaxLtvBps
        );

        uint256 low = 0;
        uint256 high = loan.collateralAmount;
        while (low < high) {
            uint256 mid = (low + high + 1) / 2; // Ceiling
            uint256 tempCollateral = loan.collateralAmount - mid;
            uint256 collateralUsd = (tempCollateral * ctx.collateralPrice) /
                ctx.collateralPriceDivisor;

            uint256 simHf = _hfFromContext(ctx, collateralUsd);
            uint256 simLtv = _ltvFromContext(ctx, collateralUsd);

            // #394 Lever A (Codex #647 P1) — this loan's snapshotted admission
            // floor (immutable post-admission), not the live knob.
            if (simHf >= LibVaipakam.effectiveLoanMinHealthFactor(loan.minHealthFactorAtInit) && simLtv <= loanInitMaxLtvBps) {
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
        uint256 borrowValueUsd;
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
        ctx.borrowValueUsd = (currentBorrowBalance * borrowPrice) /
            (10 ** borrowFeedDecimals) / (10 ** borrowTokenDecimals);

        (uint256 collateralPrice, uint8 collateralFeedDecimals) = OracleFacet(address(this))
            .getAssetPrice(loan.collateralAsset);
        uint8 collateralTokenDecimals = IERC20Metadata(loan.collateralAsset).decimals();
        ctx.collateralPrice = collateralPrice;
        ctx.collateralPriceDivisor =
            (10 ** collateralFeedDecimals) * (10 ** collateralTokenDecimals);

        // PR2 of internal-match work (2026-05-14): per-asset
        // `liqThresholdBps` was retired in favour of per-tier values
        // snapshotted onto the loan at `initiateLoan`. Read the
        // snapshot so partial-withdrawal HF/LTV simulation matches
        // what `RiskFacet.calculateHealthFactor` would compute for
        // this loan today.
        ctx.liqThresholdBps = uint256(loan.liquidationLtvBpsAtInit);
    }

    function _hfFromContext(
        ValuationContext memory ctx,
        uint256 collateralValueUsd
    ) internal pure returns (uint256) {
        if (ctx.borrowValueUsd == 0) return type(uint256).max;
        uint256 riskAdjustedCollateral =
            (collateralValueUsd * ctx.liqThresholdBps) / LibVaipakam.BASIS_POINTS;
        return (riskAdjustedCollateral * LibVaipakam.HF_SCALE) / ctx.borrowValueUsd;
    }

    function _ltvFromContext(
        ValuationContext memory ctx,
        uint256 collateralValueUsd
    ) internal pure returns (uint256) {
        if (collateralValueUsd == 0) return type(uint256).max;
        return (ctx.borrowValueUsd * LibVaipakam.BASIS_POINTS) / collateralValueUsd;
    }

    // `_simulateHF` + `_simulateLTV` (previously here) removed in #148
    // Phase 5 — the mutating path now folds both into a single
    // `_loadValuationContext` + `_hfFromContext` / `_ltvFromContext`
    // call, with the per-iteration loop body inline. See the comment at
    // ~line 161 ("search. Previously each iteration called _simulateHF
    // + _simulateLTV") for the refactor history.

    // Internal helper for current borrow balance with accrued interest
    function _calculateCurrentBorrowBalance(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256) {
        return loan.principal + LibEntitlement.accruedInterestToTime(loan, block.timestamp);
    }
}
