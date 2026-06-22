// src/facets/RepayPeriodicFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {SwapToRepayIntentFacet} from "./SwapToRepayIntentFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";


/**
 * @title RepayPeriodicFacet
 * @author Vaipakam Developer Team
 * @notice Periodic-interest settlement and NFT-rental daily auto-deduction
 *         for the Vaipakam P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable.
 *
 *      Split out of {RepayFacet} (Issue #66 — EIP-170 runtime-size limit):
 *      this facet carries the permissionless NFT daily-deduction loop and
 *      the T-034 periodic-interest settlement cluster (including the
 *      collateral auto-liquidation path), keeping {RepayFacet}'s
 *      borrower-driven full/partial-repay surface under the 24,576-byte
 *      ceiling. This is a pure mechanical move — no business-logic change.
 *
 *      Entry points:
 *        {autoDeductDaily}        — permissionless daily deduction for NFT
 *                                   rentals (deducts one day's fee from the
 *                                   borrower's vaulted prepay).
 *        {previewPeriodicSettle}  — view: preview the next periodic-interest
 *                                   checkpoint result.
 *        {nextPeriodCheckpoint}   — view: upcoming-checkpoint timestamp.
 *        {settlePeriodicInterest} — permissionless settler: closes the
 *                                   current periodic-interest period,
 *                                   auto-liquidating collateral on shortfall.
 */
contract RepayPeriodicFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted when auto daily deduct is triggered for an NFT rental.
    /// @param loanId The ID of the loan.
    /// @param dayFeeDeducted The daily fee deducted.
    /// @custom:event-category state-change/loan-mutation
    event AutoDailyDeducted(uint256 indexed loanId, uint256 dayFeeDeducted);

    // ─── T-034 Periodic Interest Payment events ───────────────────────────

    /// @notice Emitted when a period checkpoint advances cleanly — either
    ///         the borrower's voluntary repayments covered the period's
    ///         interest in full (just-stamp) or
    ///         {settlePeriodicInterest} was called with no shortfall.
    ///         No collateral was sold; no settler bonus was paid.
    /// @param loanId The loan whose checkpoint advanced.
    /// @param periodEndAt Timestamp of the period boundary that closed
    ///        (`lastPeriodicInterestSettledAt` BEFORE the advance).
    /// @param expected The period's expected interest, snapshotted at
    ///        the moment of the advance.
    /// @param paidByBorrower Cumulative interest the borrower paid
    ///        during the period, drawn from `interestPaidSinceLastPeriod`
    ///        before reset.
    /// @param settler `msg.sender` of the call that triggered the
    ///        advance — borrower (via `repayPartial` fold), permissionless
    ///        bot (via `settlePeriodicInterest`), or anyone else.
    /// @custom:event-category state-change/loan-mutation
    event PeriodicInterestSettled(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 expected,
        uint256 paidByBorrower,
        address indexed settler
    );

    /// @notice Emitted when {settlePeriodicInterest} sold collateral to
    ///         cover a period's shortfall. Mirrors the existing HF-
    ///         liquidation split (slippage-driven liquidator bonus,
    ///         flat 2% treasury handling fee, lender gets the rest)
    ///         per docs/FunctionalSpecs/ProjectDetailsREADME.md
    ///         §"Equivalent Collateral Transfer for Liquid Asset
    ///         during Abnormal Periods".
    /// @param loanId The loan whose collateral was partially sold.
    /// @param periodEndAt Timestamp of the period boundary that closed.
    /// @param shortfall The interest shortfall that triggered the sale.
    /// @param collateralSold Amount of collateral asset withdrawn from
    ///        the borrower's vault and offered to the swap try-list.
    /// @param lenderProceeds Principal-asset amount credited to the
    ///        lender's vault as the period's interest payment.
    /// @param settlerBonus Principal-asset amount paid to `msg.sender`
    ///        as the slippage-driven incentive.
    /// @param treasuryShare Principal-asset amount paid to treasury as
    ///        the 2% liquidation handling fee.
    /// @param settler `msg.sender` of the settle call.
    /// @custom:event-category state-change/loan-mutation
    event PeriodicInterestAutoLiquidated(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 shortfall,
        uint256 collateralSold,
        uint256 lenderProceeds,
        uint256 settlerBonus,
        uint256 treasuryShare,
        address indexed settler
    );

    /// @notice Informational. Emitted alongside
    ///         {PeriodicInterestAutoLiquidated} when the realized swap
    ///         output came in BELOW the shortfall after the standard
    ///         3% bonus + 2% handling fee — i.e. lender got less than
    ///         the interest they were owed despite the swap clearing
    ///         the slippage gate. Off-chain monitors may aggregate
    ///         this to spot DEX-side regression.
    /// @custom:event-category informational/liquidation
    event PeriodicSlippageOverBuffer(
        uint256 indexed loanId,
        uint256 expectedShortfall,
        uint256 actualLenderProceeds
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors).
    // `InsufficientPrepay` is intentionally declared in BOTH RepayFacet and
    // RepayPeriodicFacet — each facet reverts it independently and Solidity
    // permits duplicate error declarations across contracts.
    error InsufficientPrepay();
    error NotDailyYet();
    error NotNFTRental();

    /**
     * @notice Permissionless auto deduct for NFT rental daily fee.
     * @dev Callable by anyone after each day (checks lastDeductTime + 1 day <= now).
     *      Deducts one day's fee from prepay to lender (99%) and treasury (1%).
     *      Updates lastDeductTime, reduces prepayAmount and durationDays by 1.
     *      If insufficient prepay, reverts (default via DefaultedFacet).
     *      No incentive yet (Phase 2: Small bounty from treasury).
     *      Reverts if not NFT or not daily yet.
     *      Emits AutoDailyDeducted.
     * @param loanId The NFT rental loan ID.
     */
    function autoDeductDaily(uint256 loanId) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert InvalidLoanStatus();
        if (loan.assetType == LibVaipakam.AssetType.ERC20) revert NotNFTRental();

        if (block.timestamp < loan.lastDeductTime + LibVaipakam.ONE_DAY)
            revert NotDailyYet();

        uint256 dayFee = loan.principal; // Daily rental fee
        if (dayFee > loan.prepayAmount) revert InsufficientPrepay();

        (uint256 treasuryShare, uint256 lenderShare) = LibEntitlement.splitTreasury(
            dayFee
        );
        address treasury = LibFacet.getTreasury();

        // #569 D-1 (2026-06-13) — NFT rentals carry no collateral lien
        // (D-2 forbids VPFI as a rental prepay asset, so the prepay pool
        // has no side-door drain to protect against). No decrement here.

        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                loan.borrower,
                loan.prepayAsset,
                loan.lender,
                lenderShare
            ),
            VaultWithdrawFailed.selector
        );

        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                loan.borrower,
                loan.prepayAsset,
                treasury,
                treasuryShare
            ),
            TreasuryTransferFailed.selector
        );
        LibFacet.recordTreasuryAccrual(loan.prepayAsset, treasuryShare);

        unchecked {
            loan.prepayAmount -= dayFee;
            loan.durationDays -= 1;
            loan.lastDeductTime += LibVaipakam.ONE_DAY;
        }

        // Update renter expires
        uint64 newExpires = uint64(
            loan.startTime + loan.durationDays * LibVaipakam.ONE_DAY
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultSetNFTUser.selector,
                loan.lender,
                loan.principalAsset,
                loan.tokenId,
                loan.borrower,
                newExpires
            ),
            NFTRenterUpdateFailed.selector
        );

        // If duration 0, close the rental properly with claims and NFT updates
        if (loan.durationDays == 0) {
            // All rental fees have been deducted. Remaining prepay is just the buffer.
            // Lender gets the full rental (already deducted daily via this function).
            // The lender's claim for accumulated daily deductions is already in vault.
            // Record a zero-amount lender claim so ClaimFacet can still return the NFT.
            s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: 0,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });

            // Borrower gets buffer refund (stays in borrower's vault)
            s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
                asset: loan.prepayAsset,
                amount: loan.bufferAmount,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                claimed: false
            });

            // Three best-effort cleanup calls below. Each writes to the
            // same `ok` local, which Slither flags as `write-after-write`.
            // The reuse is intentional: every cleanup is non-critical
            // (the inline comments mark them so), independent of the
            // others, and the loan still transitions to Repaid at the
            // end of the block regardless of cleanup outcome. The two
            // `ok; // discard` no-op statements are Solidity-side hints
            // (silence unused-variable warnings) — they don't gate
            // anything. If any one of these cleanups becomes
            // load-bearing in future, replace the shared `ok` with
            // per-call locals and lift this comment.

            // Reset renter (non-critical — renter may have already expired)
            (bool ok, ) = address(this).call(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultSetNFTUser.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    address(0),
                    0
                )
            );
            ok; // discard

            // Update NFTs to Loan Repaid (non-critical)
            // slither-disable-next-line write-after-write
            (ok, ) = address(this).call(
                abi.encodeWithSelector(
                    VaipakamNFTFacet.updateNFTStatus.selector,
                    loan.lenderTokenId,
                    loanId,
                    LibVaipakam.LoanPositionStatus.LoanRepaid
                )
            );
            // slither-disable-next-line write-after-write
            (ok, ) = address(this).call(
                abi.encodeWithSelector(
                    VaipakamNFTFacet.updateNFTStatus.selector,
                    loan.borrowerTokenId,
                    loanId,
                    LibVaipakam.LoanPositionStatus.LoanRepaid
                )
            );
            ok; // silence unused warning

            LibLifecycle.transition(
                loan,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Repaid
            );
        }

        emit AutoDailyDeducted(loanId, dayFee);
    }

    // ─── T-034 — Periodic Interest Payment views ──────────────────────────

    /// @notice Preview the result of `settlePeriodicInterest(loanId)` at
    ///         the current block. Used by the loan-detail "Next interest
    ///         checkpoint" countdown card and by settler bots before
    ///         submitting a tx. Pure read; no state changes.
    /// @param loanId The loan to inspect.
    /// @return cadence The on-chain cadence enum value (0 = None).
    /// @return periodEndAt Timestamp of the next/current period boundary
    ///         (`lastPeriodicInterestSettledAt + intervalDays * 1 days`).
    ///         Zero when cadence is None.
    /// @return graceEndsAt `periodEndAt + gracePeriod(intervalDays)` —
    ///         the earliest moment a permissionless settler call is
    ///         allowed. Zero when cadence is None.
    /// @return expected Interest expected for the FULL period at the
    ///         current `loan.principal` and `loan.interestRateBps`.
    /// @return paidByBorrower Cumulative interest paid this period
    ///         (drawn from `loan.interestPaidSinceLastPeriod`).
    /// @return shortfall Saturating-non-negative `expected - paid`.
    /// @return canSettleNow True iff `block.timestamp >= graceEndsAt`
    ///         AND the loan is `Active` AND cadence is non-None — i.e.
    ///         a permissionless settler call would clear the
    ///         {PeriodicSettleNotDue} guard right now.
    function previewPeriodicSettle(uint256 loanId)
        external
        view
        returns (
            uint8 cadence,
            uint256 periodEndAt,
            uint256 graceEndsAt,
            uint256 expected,
            uint256 paidByBorrower,
            uint256 shortfall,
            bool canSettleNow
        )
    {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        cadence = uint8(loan.periodicInterestCadence);
        if (cadence == 0) {
            return (0, 0, 0, 0, 0, 0, false);
        }
        periodEndAt = LibPeriodicInterest.periodEndAt(loan);
        graceEndsAt = LibPeriodicInterest.settleAllowedFromAt(loan);
        expected = LibPeriodicInterest.expectedInterestForPeriod(loan);
        paidByBorrower = uint256(loan.interestPaidSinceLastPeriod);
        shortfall = LibPeriodicInterest.currentShortfall(loan);
        canSettleNow =
            loan.status == LibVaipakam.LoanStatus.Active &&
            block.timestamp >= graceEndsAt;
    }

    /// @notice Convenience view returning ONLY the upcoming-checkpoint
    ///         timestamp. Returns zero when the loan has no cadence.
    function nextPeriodCheckpoint(uint256 loanId)
        external
        view
        returns (uint256)
    {
        return LibPeriodicInterest.periodEndAt(
            LibVaipakam.storageSlot().loans[loanId]
        );
    }

    // ─── T-034 — settlePeriodicInterest entry point ───────────────────────

    /// @notice Permissionless settler. Closes the loan's current
    ///         periodic-interest period, advancing
    ///         `lastPeriodicInterestSettledAt` by exactly one cadence
    ///         interval. Two paths:
    ///
    ///         **Just-stamp** (shortfall == 0): borrower's voluntary
    ///         repayments already covered the period's expected
    ///         interest. Caller pays gas only — no settler bonus, no
    ///         collateral sale. Anyone may call; in practice the
    ///         borrower self-calls or the watcher batches it.
    ///
    ///         **Auto-liquidate** (shortfall > 0): caller-supplied swap
    ///         try-list sells just enough collateral to cover the
    ///         shortfall. Mirrors the existing HF-liquidation split:
    ///         settler bonus = `max(0, slippageCap - realizedSlippage)`,
    ///         capped at 3%; treasury 2% handling fee; lender gets the
    ///         rest. See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md
    ///         §4.3.
    ///
    ///         Reverts {PeriodicSettleNotDue} before the period boundary
    ///         + grace window. Reverts {PeriodicInterestDisabled} when
    ///         the master kill-switch is off. Reverts
    ///         {PeriodicSettleSwapPathRequired} when shortfall > 0 but
    ///         caller passed empty `adapterCalls`. Reverts
    ///         {PeriodicSettleSwapFailed} when every swap adapter
    ///         reverts (settler retries with fresh quote).
    /// @param loanId Loan whose period is closing.
    /// @param adapterCalls Caller-ranked swap try-list. Ignored on the
    ///        just-stamp path; required (non-empty) on auto-liquidate.
    function settlePeriodicInterest(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ProtocolConfig storage cfg = s.protocolCfg;
        if (!cfg.periodicInterestEnabled) {
            revert IVaipakamErrors.PeriodicInterestDisabled();
        }
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert IVaipakamErrors.PeriodicSettleNotApplicable(loanId);
        if (loan.periodicInterestCadence == LibVaipakam.PeriodicInterestCadence.None)
            revert IVaipakamErrors.PeriodicSettleNotApplicable(loanId);
        uint256 graceEndsAt = LibPeriodicInterest.settleAllowedFromAt(loan);
        if (block.timestamp < graceEndsAt) {
            revert IVaipakamErrors.PeriodicSettleNotDue(
                loanId,
                LibPeriodicInterest.periodEndAt(loan),
                graceEndsAt
            );
        }
        // Tier-1 sanctions gate. Settler may receive a value bonus on
        // the auto-liquidate path; mirror the {triggerLiquidation}
        // policy.
        LibVaipakam._assertNotSanctioned(msg.sender);

        uint256 expected = LibPeriodicInterest.expectedInterestForPeriod(loan);
        uint256 paid = uint256(loan.interestPaidSinceLastPeriod);
        uint256 shortfall = paid >= expected ? 0 : expected - paid;
        uint256 boundary = LibPeriodicInterest.periodEndAt(loan);

        if (shortfall == 0) {
            // ── Just-stamp path ────────────────────────────────────────────
            LibPeriodicInterest.advanceCheckpoint(loan);
            emit PeriodicInterestSettled(
                loanId,
                boundary,
                expected,
                paid,
                msg.sender
            );
            return;
        }

        // ── Auto-liquidate path ───────────────────────────────────────────
        if (adapterCalls.length == 0) {
            revert IVaipakamErrors.PeriodicSettleSwapPathRequired(loanId, shortfall);
        }
        _autoLiquidatePeriodShortfall(loan, loanId, expected, paid, shortfall, boundary, adapterCalls);
    }

    /// @dev Auto-liquidate path body, factored out to keep the public
    ///      entry under the IR-stack budget. See `settlePeriodicInterest`
    ///      for the surrounding contract.
    function _autoLiquidatePeriodShortfall(
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        uint256 expected,
        uint256 paid,
        uint256 shortfall,
        uint256 boundary,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) private {
        // T-090 v1.1 (#389) §5.8 layer 2 — same force-cancel-on-
        // HF-low pattern as the public HF-liquidation entry
        // points. If no commit is live → no-op. If a commit is
        // live AND HF < `HF_LIQUIDATION_THRESHOLD` → force-cancel
        // + emit `SwapToRepayIntentForceCancelled`. Otherwise
        // revert `IntentPending` so the borrower's window is
        // honoured even mid-period.
        if (LibVaipakam.storageSlot().intentCommits[loanId].orderHash != bytes32(0)) {
            SwapToRepayIntentFacet(address(this)).forceCancelIntentIfHFBelowOrRevert(loanId);
        }
        // #658 PR-B — the periodic auto-liquidate is a both-side fund-distribution
        // event (it SELLS the borrower's collateral and PAYS the lender the
        // shortfall coverage) on a loan that stays Active. Consolidate each
        // transferred side to its current NFT holder BEFORE the collateral sale +
        // lender payout, so the collateral lien / reward entry / VPFI checkpoint
        // follow the holder and the proceeds route to the current lender holder
        // (mirrors triggerPartialLiquidation). Cross-facet (Tier2 skip-not-block);
        // the just-stamp path has no payout, so it is intentionally NOT wired.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.eagerConsolidateBothSides.selector,
                loanId
            ),
            bytes4(0)
        );
        // Sell-amount sizing: aim for `shortfall × (1 + slippageCap)` of
        // collateral so the swap clears even in the worst-case slippage
        // scenario. If the loan's remaining collateral is smaller, sell
        // the entire collateral balance — the lender absorbs the
        // slippage on top. Settler still gets paid the slippage-driven
        // bonus on whatever proceeds came in.
        uint256 maxSlippageBps = LibVaipakam.cfgMaxLiquidationSlippageBps();
        uint256 collateralEquivalent = LibFallback.collateralEquivalent(
            address(this),
            shortfall,
            loan.collateralAsset,
            loan.principalAsset
        );
        // Add the slippage cap as an over-sell buffer (e.g. 6% extra
        // collateral so net proceeds clear `shortfall` after worst-
        // case slippage). Numeric over-flow safe — collateral amounts
        // are bounded.
        uint256 toSell = (collateralEquivalent *
            (LibVaipakam.BASIS_POINTS + maxSlippageBps)) /
            LibVaipakam.BASIS_POINTS;
        if (toSell > loan.collateralAmount) {
            toSell = loan.collateralAmount;
        }

        // #407 PR 4 round-1 Codex P1 #1 (2026-06-12) — decrement the
        // lien by the periodic-interest shortfall slice. Loan stays
        // Active after the slice swap, so a release would leave the
        // residual collateral unprotected.
        _decrementLienAtPeriodicAutoLiq(loanId, toSell);

        // Withdraw collateral to Diamond for swap (mirrors the HF-
        // liquidation withdraw shape).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                loan.borrower,
                loan.collateralAsset,
                address(this),
                toSell
            ),
            VaultWithdrawFailed.selector
        );
        // #658 PR-B — re-stamp the holder's VPFI tier/staking after the
        // collateral slice leaves the vault (no-op for non-VPFI collateral).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.restampCollateralVpfiAfterWithdraw.selector,
                loanId
            ),
            bytes4(0)
        );

        uint256 expectedProceeds = LibFallback.expectedSwapOutput(
            address(this),
            loan.collateralAsset,
            loan.principalAsset,
            toSell
        );
        uint256 minOutput = (expectedProceeds *
            (LibVaipakam.BASIS_POINTS - maxSlippageBps)) /
            LibVaipakam.BASIS_POINTS;

        (bool ok, uint256 proceeds, ) = LibSwap.swapWithFailover(
            loanId,
            loan.collateralAsset,
            loan.principalAsset,
            toSell,
            minOutput,
            address(this),
            adapterCalls
        );
        if (!ok) {
            revert IVaipakamErrors.PeriodicSettleSwapFailed(loanId);
        }

        // Slippage-driven settler bonus mirrors RiskFacet.triggerLiquidation:
        //   incentiveBps = max(0, slippageCap - realizedSlippageBps), capped
        //   at maxLiquidatorIncentiveBps (3%).
        uint256 realizedSlippageBps;
        if (proceeds < expectedProceeds) {
            realizedSlippageBps = ((expectedProceeds - proceeds) *
                LibVaipakam.BASIS_POINTS) / expectedProceeds;
            if (realizedSlippageBps > maxSlippageBps) {
                realizedSlippageBps = maxSlippageBps;
            }
        }
        uint256 maxIncentiveBps = LibVaipakam.cfgMaxLiquidatorIncentiveBps();
        uint256 incentiveBps = maxSlippageBps - realizedSlippageBps;
        if (incentiveBps > maxIncentiveBps) {
            incentiveBps = maxIncentiveBps;
        }
        uint256 bonus = (proceeds * incentiveBps) / LibVaipakam.BASIS_POINTS;
        // Treasury 2% handling fee — same constant as HF-liquidation.
        uint256 handlingFee = (proceeds *
            LibVaipakam.cfgLiquidationHandlingFeeBps()) /
            LibVaipakam.BASIS_POINTS;
        if (bonus + handlingFee > proceeds) {
            handlingFee = proceeds - bonus;
        }
        uint256 lenderProceeds = proceeds - bonus - handlingFee;

        // Pay out: settler bonus → msg.sender, treasury → treasury,
        // lender → lender's vault (bookkeeping mirrors PartialRepaid
        // accounting on the lender side).
        if (bonus > 0) {
            IERC20(loan.principalAsset).safeTransfer(msg.sender, bonus);
        }
        if (handlingFee > 0) {
            address treasury = LibFacet.getTreasury();
            IERC20(loan.principalAsset).safeTransfer(treasury, handlingFee);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, handlingFee);
        }
        if (lenderProceeds > 0) {
            // #658 PR-B (Codex #685 P1) — route to the CURRENT lender-position
            // holder, not the stale `loan.lender`: the eager consolidation above
            // is Tier2 skip-not-block, so it can leave `loan.lender` stale (e.g.
            // a `_isExcludedLive` lender exclusion), and this is a DIRECT payout.
            // Resolve `ownerOf(lenderTokenId)` + apply the direct-recipient
            // sanctions gate, mirroring `RepayFacet.repayPartial`. The loan is
            // Active here so the lender NFT is live and `ownerOf` holds.
            address lenderRecipient = IERC721(address(this)).ownerOf(
                loan.lenderTokenId
            );
            LibVaipakam._assertNotSanctioned(lenderRecipient);
            IERC20(loan.principalAsset).safeTransfer(lenderRecipient, lenderProceeds);
            // #408 / #410 / #413 (2026-06-12) — credit
            // `interestSettled` by the interest just forwarded to the
            // lender so a later full repay / preclose nets the
            // accumulator against the gross floor. Mirrors the
            // partial-repay accrual credit in `repayPartial`.
            //
            // Note: when slippage forces `lenderProceeds < shortfall`,
            // we credit only what the lender ACTUALLY received — the
            // borrower's gross obligation is unchanged, so the
            // shortfall stays uncredited and the borrower pays the
            // difference at the next settlement.
            loan.interestSettled += lenderProceeds;
        }

        unchecked {
            loan.collateralAmount -= toSell;
        }
        // Even if `lenderProceeds < shortfall` (rare — DEX cleared the
        // slippage gate but lender absorbed the bonus + handling
        // hit), advance the checkpoint anyway. The auto-liquidate
        // event records the actual amounts so off-chain reconcilers
        // can spot lender shortfalls.
        if (lenderProceeds < shortfall) {
            emit PeriodicSlippageOverBuffer(loanId, shortfall, lenderProceeds);
        }
        LibPeriodicInterest.advanceCheckpoint(loan);
        emit PeriodicInterestAutoLiquidated(
            loanId,
            boundary,
            shortfall,
            toSell,
            lenderProceeds,
            bonus,
            handlingFee,
            msg.sender
        );
        // `expected` and `paid` are unused in the event — captured for
        // future-proofing the function signature without changing the
        // event ABI. Suppressed via the assignment below to silence
        // the unused-warning lint without inflating gas.
        expected; paid;
    }

    /// @dev #407 PR 4 round-1 (2026-06-12) — cross-facet lien decrement
    ///      used only by `_autoLiquidatePeriodShortfall`. Moved here
    ///      alongside its sole caller during the Issue #66 facet split;
    ///      the cross-facet call is inlined (rather than re-sharing the
    ///      `_callEncumb2` helper, which stays in RepayFacet for its
    ///      own call sites).
    function _decrementLienAtPeriodicAutoLiq(uint256 loanId, uint256 consumed) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.decrementCollateralLien.selector,
                loanId,
                consumed
            ),
            bytes4(0)
        );
    }
}
