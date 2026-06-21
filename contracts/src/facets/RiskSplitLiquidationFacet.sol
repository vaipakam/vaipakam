// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {SwapToRepayIntentFacet} from "./SwapToRepayIntentFacet.sol";

/**
 * @title RiskSplitLiquidationFacet
 * @author Vaipakam Developer Team
 * @notice Higher-LTV-aware **split-route** HF liquidator — the sibling of
 *         {RiskFacet.triggerLiquidation} (single-route failover) and
 *         {RiskFacet.triggerPartialLiquidation} (partial sweep). Routes the
 *         seized collateral through a sum-to-input multi-route swap
 *         (`LibSwap.swapWithSplit`) so a liquidation too large for any single
 *         venue's depth can still clear at acceptable slippage by splitting
 *         across venues.
 * @dev    Part of the Diamond Standard (EIP-2535). Reentrancy-guarded,
 *         pausable. Carved out of {RiskFacet} (Issue #66 + #633): RiskFacet
 *         sat 58 bytes under the EIP-170 24,576-byte runtime limit, and the
 *         #633 disabled-venue guard inlined into `LibSwap.swapWithSplit`
 *         (~75 bytes) would have tipped it over. Rather than shave unrelated
 *         logic to fit, the whole split-route entry point lives here in its
 *         own facet so the `swapWithSplit` inline lands in fresh headroom.
 *         The function is a verbatim relocation — identical pre-checks,
 *         distribution, and lifecycle to {RiskFacet.triggerLiquidation}; the
 *         shared seconds-precise debt accrual is
 *         {LibEntitlement.currentBorrowBalance}. All facets share Diamond
 *         storage via {LibVaipakam}, so the move needs no storage migration.
 */
contract RiskSplitLiquidationFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;

    // These three errors + the event mirror {RiskFacet}'s declarations
    // one-for-one (same selectors / topic0) so the relocated body and its
    // observers behave identically. `NonLiquidAsset`, `VaultWithdrawFailed`,
    // `NFTStatusUpdateFailed`, and `KYCRequired` are inherited from
    // {IVaipakamErrors}.
    /// @notice Loan isn't in a liquidatable state (must be `Active`).
    error InvalidLoan();
    /// @notice HF is at or above `1e18` — the loan is healthy, not liquidatable.
    error HealthFactorNotLow();
    /// @notice l2 sequencer is offline or still in its recovery grace window;
    ///         HF-based liquidation is blocked to avoid swapping on stale prices.
    error SequencerUnhealthy();
    /// @notice #395 (Codex r5) — the loan's LTV is still inside the
    ///         internal-match priority window, so the external split route
    ///         must defer. Same signature as {RiskFacet.InternalMatchOnlyBand}.
    error InternalMatchOnlyBand(uint256 currentLtvBps, uint256 windowCeilingBps);

    /// @notice Emitted on a successful HF-based liquidation (split route).
    ///         Identical signature to {RiskFacet.HFLiquidationTriggered} so
    ///         indexers route both on one topic.
    event HFLiquidationTriggered(
        uint256 indexed loanId,
        address indexed liquidator,
        uint256 proceeds
    );

    /**
     * @notice HF-based liquidation via a **sum-to-input multi-route split
     *         swap**. Used when off-chain quote analysis shows a single
     *         adapter can't absorb the full liquidation size at acceptable
     *         slippage but splitting across two-or-more adapters can
     *         (depth-tiered LTV regime).
     *
     *         Routes the collateral through `LibSwap.swapWithSplit` instead
     *         of `swapWithFailover`. Critically: **split is atomic — any
     *         single leg revert reverts the whole tx, no soft-failure /
     *         full-collateral-transfer fallback path.** If a leg reverts
     *         on-chain (price moved between quote and submission), the retry
     *         path is {RiskFacet.triggerLiquidation} (failover), which
     *         handles soft-failure cleanly.
     *
     *         The entire post-swap distribution (dynamic incentive,
     *         tiered-KYC, treasury / lender / borrower-surplus split,
     *         lifecycle transition Active→Defaulted, VPFI forfeit,
     *         interaction-rewards close, NFT-status updates,
     *         `HFLiquidationTriggered` event) is identical to
     *         {RiskFacet.triggerLiquidation}.
     *
     * @param loanId   Loan being liquidated. Must be Active with HF<1.
     * @param splits   The split spec — `sum(splitAmount) == loan.collateralAmount`,
     *                 each `adapterIdx` ∈ `[0, swapAdapters.length)`, each
     *                 `data` the keeper-supplied per-adapter calldata.
     */
    function triggerLiquidationSplit(
        uint256 loanId,
        LibSwap.SplitCall[] calldata splits
    ) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 layer 2 — inline storage pre-check so this
        // entry point stays callable on diamonds that haven't cut
        // `SwapToRepayIntentFacet`. When no v1.1 intent commit is live for
        // this loan, the cross-facet call is skipped and we proceed straight
        // to the standard liquidation flow.
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.intentCommits[loanId].orderHash != bytes32(0)) {
            SwapToRepayIntentFacet(address(this)).forceCancelIntentIfHFBelowOrRevert(loanId);
        }
        // Sanctions / sequencer / HF / liquidity gates — identical to
        // {RiskFacet.triggerLiquidation}.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert InvalidLoan();
        // T-086 step 10 — clear any active prepay listing before liquidation.
        LibPrepayCleanup.clearActiveListing(loan, loanId);
        // #407 PR 4 (T-407-B) — release the borrower's collateral lien before
        // the vault withdraw drains the collateral asset. Same cross-facet
        // call {RiskFacet} makes via its private `_releaseLienAtLiquidation`
        // wrapper; inlined here since that wrapper stayed in RiskFacet.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.releaseCollateralLien.selector,
                loanId
            ),
            bytes4(0)
        );
        if (!OracleFacet(address(this)).sequencerHealthy()) {
            revert SequencerUnhealthy();
        }
        uint256 hf = RiskFacet(address(this)).calculateHealthFactor(loanId);
        if (hf >= LibVaipakam.HF_SCALE) revert HealthFactorNotLow();
        // #658 — split liquidation is a both-side close-out (lender debt +
        // borrower surplus); consolidate transferred sides to current holders
        // before the split-swap settlement, via the internal cross-facet eager
        // entry (Tier2 skip-not-block). `bytes4(0)` bubbles a genuine move
        // revert raw.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.eagerConsolidateBothSides.selector,
                loanId
            ),
            bytes4(0)
        );
        LibVaipakam.LiquidityStatus liquidity = OracleFacet(address(this))
            .checkLiquidityOnActiveNetwork(loan.collateralAsset);
        if (liquidity != LibVaipakam.LiquidityStatus.Liquid)
            revert NonLiquidAsset();

        // #395 (Codex r5 P2) — preserve internal-match priority on the split
        // route too. `triggerLiquidation` and `triggerPartialLiquidation`
        // already defer to the priority window; without the same gate here a
        // keeper could route an in-window loan through the split path and
        // bypass the ordering. A split is a full external liquidation, so it
        // simply declines inside the window (the dedicated internal-match path
        // / full-liquidation auto-dispatch handles the in-window resolution).
        if (s.protocolCfg.internalMatchEnabled) {
            uint256 windowLtv = RiskFacet(address(this)).calculateLTV(loanId);
            uint256 floorBps = uint256(loan.liquidationLtvBpsAtInit);
            uint256 windowCeiling = floorBps + LibVaipakam.cfgExternalLiquidationPriorityWindowBps();
            if (floorBps > 0 && windowLtv < windowCeiling) {
                revert InternalMatchOnlyBand(windowLtv, windowCeiling);
            }
        }

        // Withdraw collateral to Diamond for the split swap.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                loan.borrower,
                loan.collateralAsset,
                address(this),
                loan.collateralAmount
            ),
            VaultWithdrawFailed.selector
        );

        // Oracle-derived total minOutputAmount — same formula as the failover
        // path. swapWithSplit enforces it on the *total* (not per-leg) so
        // leg-asymmetric outcomes don't pessimistically fail.
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

        // The split swap. Reverts on sum mismatch, any leg revert, a
        // governance-disabled venue (#633), or total < minOutputAmount — no
        // soft-failure return path.
        uint256 proceeds = LibSwap.swapWithSplit(
            loanId,
            loan.collateralAsset,
            loan.principalAsset,
            loan.collateralAmount,
            minOutputAmount,
            address(this),
            splits
        );

        // Calculate debt — identical to {RiskFacet.triggerLiquidation}.
        uint256 currentBorrowBalance = LibEntitlement.currentBorrowBalance(loan);
        uint256 endTime = loan.startTime + loan.durationDays * 1 days;
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
        uint256 totalDebt = currentBorrowBalance + lateFee;
        uint256 interestPortion = totalDebt - loan.principal;

        // Dynamic liquidator incentive — identical to {RiskFacet.triggerLiquidation}.
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
        uint256 bonus = (proceeds * incentiveBps) / LibVaipakam.BASIS_POINTS;
        if (bonus > proceeds) bonus = proceeds;

        // Tiered-KYC check for the liquidator — identical to {RiskFacet.triggerLiquidation}.
        (uint256 price, uint8 feedDecimals) = OracleFacet(address(this))
            .getAssetPrice(loan.principalAsset);
        uint8 tokenDecimals = IERC20Metadata(loan.principalAsset).decimals();
        uint256 bonusNumeraire = (bonus * price * 1e18) / (10 ** feedDecimals) / (10 ** tokenDecimals);
        if (!ProfileFacet(address(this)).meetsKYCRequirement(msg.sender, bonusNumeraire))
            revert KYCRequired();

        // Bonus to liquidator + treasury handling fee — identical.
        if (bonus > 0) {
            IERC20(loan.principalAsset).safeTransfer(msg.sender, bonus);
        }
        uint256 handlingFee = (proceeds * LibVaipakam.cfgLiquidationHandlingFeeBps())
            / LibVaipakam.BASIS_POINTS;
        if (bonus + handlingFee > proceeds) {
            handlingFee = proceeds - bonus;
        }

        // Distribution — identical to {RiskFacet.triggerLiquidation}.
        uint256 afterFees = proceeds - bonus - handlingFee;
        address treasury = s.treasury;
        uint256 allocated = afterFees > totalDebt ? totalDebt : afterFees;
        uint256 borrowerSurplus = afterFees > totalDebt ? afterFees - totalDebt : 0;
        uint256 treasuryInterestFee;
        uint256 lenderProceeds;
        if (allocated > loan.principal) {
            uint256 interestRecovered = allocated - loan.principal;
            if (interestRecovered > interestPortion) interestRecovered = interestPortion;
            (treasuryInterestFee, ) = LibEntitlement.splitTreasury(interestRecovered);
            lenderProceeds = allocated - treasuryInterestFee;
        } else {
            treasuryInterestFee = 0;
            lenderProceeds = allocated;
        }
        uint256 toTreasury = handlingFee + treasuryInterestFee;
        if (toTreasury > 0) {
            IERC20(loan.principalAsset).safeTransfer(treasury, toTreasury);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, toTreasury);
        }
        address lenderVault = LibFacet.getOrCreateVault(loan.lender);
        if (lenderProceeds > 0) {
            IERC20(loan.principalAsset).safeTransfer(lenderVault, lenderProceeds);
            LibVaipakam.recordVaultDeposit(loan.lender, loan.principalAsset, lenderProceeds);
        }
        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: lenderProceeds,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        // #592 — reserve VPFI lender proceeds against the unstake path until
        // the current holder claims; ClaimFacet releases. No-op for non-VPFI.
        if (loan.principalAsset == s.vpfiToken) {
            LibEncumbrance.encumberLenderProceeds(
                loanId, loan.lender, loan.principalAsset, lenderProceeds
            );
        }
        if (borrowerSurplus > 0) {
            address borrowerVault = LibFacet.getOrCreateVault(loan.borrower);
            IERC20(loan.principalAsset).safeTransfer(borrowerVault, borrowerSurplus);
            LibVaipakam.recordVaultDeposit(loan.borrower, loan.principalAsset, borrowerSurplus);
            // #661 — reserve a VPFI surplus against the unstake path until the
            // current borrower-position holder claims it. No-op for non-VPFI.
            if (loan.principalAsset == s.vpfiToken) {
                LibEncumbrance.encumberBorrowerProceeds(
                    loanId, loan.borrower, loan.principalAsset, borrowerSurplus
                );
            }
        }
        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: borrowerSurplus,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: borrowerSurplus == 0
        });

        // Close loan + VPFI forfeit + rewards + NFT status — identical.
        LibLifecycle.transition(
            loan,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.Defaulted
        );
        LibVPFIDiscount.forfeitBorrowerLif(loan);
        LibInteractionRewards.closeLoan(loanId, false, false);
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
}
