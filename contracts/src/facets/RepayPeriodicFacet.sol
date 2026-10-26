// src/facets/RepayPeriodicFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {SwapToRepayIntentFacet} from "./SwapToRepayIntentFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {ForcedSaleFacet} from "./ForcedSaleFacet.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {VPFIDiscountFacet} from "./VPFIDiscountFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {InteractionRewardsFacet} from "./InteractionRewardsFacet.sol";

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
    ///         cover a period's shortfall. The sale is sized to need and
    ///         divided by the shared forced-sale rule ({ForcedSaleFacet},
    ///         which also emits {ForcedSaleFacet.ForcedSaleSettled} with the
    ///         need, the proceeds and whether the sale was covered): keeper
    ///         bonus first, the lender at most the shortfall, the handling fee
    ///         subordinated to the lender, the rest to the borrower.
    /// @param loanId The loan whose collateral was partially sold.
    /// @param periodEndAt Timestamp of the period boundary that closed.
    /// @param shortfall The interest shortfall that triggered the sale.
    /// @param collateralSold Collateral withdrawn from the borrower's vault
    ///        and sold.
    /// @param lenderProceeds What the lender received (or was held for a
    ///        frozen lender holder) as the period's interest, at most the
    ///        shortfall. Below the shortfall only when the sale could not
    ///        cover it; the difference stays owed.
    /// @param settlerBonus Lending-asset amount paid to `msg.sender` as the
    ///        execution-quality incentive (at most 3% of the shortfall).
    /// @param treasuryShare Handling fee to the treasury (2% of the
    ///        shortfall, subordinated to the lender).
    /// @param borrowerExtra What the sale raised above the lender's
    ///        interest and the charges, returned to the borrower.
    /// @param borrowerExtraHeld True when `borrowerExtra` was held in the
    ///        borrower's vault for their claim at loan end (a flagged holder,
    ///        or a wallet payment that could not complete) instead of paid to
    ///        the borrower-position holder's wallet.
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
        uint256 borrowerExtra,
        bool borrowerExtraHeld,
        address indexed settler
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
     *      Deducts one day's fee from prepay and splits it between the
     *      lender and the treasury at the loan's snapshotted treasury rate.
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
            loan,
            dayFee
        );

        // #1383 — honor the lender Full/hold discount (§F2 / #1354) for the
        // CURRENT lender-NFT holder (the periodic payout already routes to
        // `ownerOf(lenderTokenId)`, not the stale `loan.lender`). Resolved via
        // the `VPFIDiscountFacet` host so the delivery bytecode stays off this
        // facet; the shift is treasury→lender. Dark until `feeEntitlementEnabled`.
        // Gated on an INLINED eligibility read so the ineligible/dark case never
        // routes to the host (no cross-facet dependency for unstamped loans).
        if (treasuryShare > 0) {
            address settlingLender = IERC721(address(this)).ownerOf(loan.lenderTokenId);
            if (LibVPFIDiscount.lenderYieldFeeEligible(loan, settlingLender)) {
                bytes memory ret = LibFacet.crossFacetCallReturn(
                    abi.encodeWithSelector(
                        VPFIDiscountFacet.resolveLenderYieldFeeFor.selector,
                        loanId,
                        settlingLender,
                        dayFee,
                        treasuryShare
                    ),
                    bytes4(0)
                );
                (uint256 lenderExtra, uint256 newTreasury, ) =
                    abi.decode(ret, (uint256, uint256, uint256));
                if (lenderExtra > 0) {
                    lenderShare += lenderExtra;
                    treasuryShare = newTreasury;
                }
            }
        }

        // #569 D-1 (2026-06-13) — NFT rentals carry no collateral lien
        // (D-2 forbids VPFI as a rental prepay asset, so the prepay pool
        // has no side-door drain to protect against). No decrement here.

        // #654 — route the daily rental fee to the CURRENT lender-position
        // holder, not the stale `loan.lender`. This is a DIRECT payout (no
        // `lenderClaims` indirection, unlike `repayLoan` / `markDefaulted`
        // which deposit to the lender vault + write a claim the holder pulls),
        // so a lender-NFT transfer would otherwise keep paying the departed
        // lender every day. Resolve `ownerOf(lenderTokenId)` + apply the
        // direct-recipient sanctions gate, mirroring
        // `_autoLiquidatePeriodShortfall` + `RepayFacet.repayPartial`. The loan
        // is Active here, so the lender NFT is live and `ownerOf` holds.
        // #998 S10 (#1006) Class B — the daily lender share is funded from the
        // borrower's prepay vault. Pay the CURRENT lender-position holder inline
        // when clean, or FREEZE fail-closed (park borrower-vault → stored-lender
        // vault + `heldForLender` + encumber + marker) when the holder is
        // registry-flagged, replacing the prior fail-open `_assertNotSanctioned`
        // (a previously-confirmed-flagged holder would otherwise be paid during an
        // oracle outage). Hosted on `EncumbranceMutateFacet`; the host resolves
        // `ownerOf(lenderTokenId)` and arms the from-side move-out exemption so a
        // borrower flagged after init can still be serviced (Tier-2 stays open).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.freezeOrPayActiveLenderFromVault.selector,
                loanId,
                loan.borrower,
                loan.prepayAsset,
                lenderShare
            ),
            bytes4(0)
        );

        // #1383 — a yield-fee discount can drive `treasuryShare` to 0 on the
        // VPFI-payment path; the fee leg skips a zero amount. #2440 — the
        // treasury accrues what reached it.
        LibFacet.vaultFeeToTreasury(loan.borrower, loan.prepayAsset, treasuryShare);

        // Pass-2 D1 (#1188) — do NOT decrement `durationDays`. The term tuple
        // (`startTime + durationDays`) is the FIXED maturity every default/
        // grace/preclose consumer relies on; shrinking it pulled maturity +
        // grace earlier each day (mid-term permissionless default + repay-brick
        // on a fully-serviced rental). Consumed days are tracked by
        // `lastDeductTime` (advanced below); remaining = `remainingRentalDays`.
        unchecked {
            loan.prepayAmount -= dayFee;
            loan.lastDeductTime += LibVaipakam.ONE_DAY;
        }

        // Update renter expires. #893 join: with `durationDays` now immutable
        // this is the origination maturity, so the renter holds the NFT for
        // the full agreed term instead of an earlier-shrinking expiry. It is
        // the ORIGINAL maturity, not the pause-moved one (#668 / #935, Codex
        // #2809 r2): rent, like interest, is charged by elapsed day, pause
        // included, so the prepaid days are used up on the original
        // schedule and the deduction below closes the rental then. The pause
        // credit moves only the late-fee and default deadlines.
        uint64 newExpires = uint64(LibLoanClock.originalMaturity(loan));
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultSetRentalUser.selector,
                loan.id,
                loan.borrower,
                newExpires
            ),
            NFTRenterUpdateFailed.selector
        );

        // Pass-2 D1 (#1188) — `durationDays` is now IMMUTABLE (the fixed term),
        // so full consumption is signalled by `remainingRentalDays == 0` (which
        // reaches 0 exactly when `lastDeductTime` has advanced across the whole
        // term), not by the term counter hitting 0.
        if (LibVaipakam.remainingRentalDays(loan) == 0) {
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

            // #998 S10 (#1006 / #1132) — this terminal writes a borrower buffer
            // claim (and the zero-amount lender claim) that are released LATER by
            // `claimAsBorrower` / `claimAsLender`. Both current position holders'
            // fail-closed frozen-claimant markers are recorded centrally at the
            // `Repaid` transition below (via `EncumbranceMutateFacet.terminalize`). Position
            // NFTs are not burned on this path (status-only update below), so
            // `ownerOf` still resolves both holders.

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
                    VaultFactoryFacet.vaultSetRentalUser.selector,
                    loan.id,
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

            // #1132 (S10 central enforcement) — route through the
            // `EncumbranceMutateFacet.terminalize` host so the validated Active→Repaid
            // transition AND both holders' fail-closed frozen-claimant markers
            // land in one place (the standalone register above was folded here).
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.terminalize.selector,
                    loanId,
                    LibVaipakam.LoanStatus.Active,
                    LibVaipakam.LoanStatus.Repaid
                ),
                bytes4(0)
            );

            // #1067 — DURABLE terminal reward close: full daily-deduction
            // repayment is a proper close, so shrink both reward entries'
            // active windows to today and re-anchor each open side to the
            // live NFT holder here. Stamping it at the terminal is the one
            // item no status fallback can cover (a later ClaimFacet burn
            // would drop the status-derived close). `borrowerClean = true`
            // (proper close — borrower keeps its reward). Bubbling (#2739):
            // a terminal transition closes its reward entry or reverts.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    InteractionRewardsFacet.terminalRewardClose.selector,
                    loanId,
                    true
                ),
                RewardHookCallFailed.selector
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
    /// @param sellAmount The collateral amount the try-list's quotes were
    ///        built for. Ignored on the just-stamp path. On auto-liquidate it
    ///        must lie between `previewForcedSale(loanId, PeriodicSettlement)`'s
    ///        `sell` and `maxSell` at the block it settles in, else the call
    ///        reverts `ForcedSaleQuoteOutOfRange` and nothing moves.
    /// @param adapterCalls Caller-ranked swap try-list. Ignored on the
    ///        just-stamp path; required (non-empty) on auto-liquidate.
    function settlePeriodicInterest(
        uint256 loanId,
        uint256 sellAmount,
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
        _autoLiquidatePeriodShortfall(loan, loanId, shortfall, boundary, sellAmount, adapterCalls);
    }

    /// @dev Auto-liquidate path body, factored out to keep the public
    ///      entry under the IR-stack budget. See `settlePeriodicInterest`
    ///      for the surrounding contract.
    ///
    ///      #2795 / #2796 — the sale is sized, pulled, sold and divided by the
    ///      shared forced-sale host ({ForcedSaleFacet.sellToNeed}): the least
    ///      collateral whose worst-case proceeds cover the shortfall plus the
    ///      largest charges (the keeper's quoted amount, within the host's
    ///      margin), the lender paid at most the shortfall, the extra back to
    ///      the borrower. This facet keeps the preconditions, the
    ///      consolidation, the checkpoint and its event.
    function _autoLiquidatePeriodShortfall(
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        uint256 shortfall,
        uint256 boundary,
        uint256 sellAmount,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) private {
        // T-090 v1.1 (#389) §5.8 layer 2 — a live intent commit is
        // force-cancelled on THIS sale's own trigger, the periodic
        // shortfall past grace (#2732), not on the HF gate: a missed
        // periodic payment is a time trigger, and a healthy borrower
        // must not be able to hold the sale off with a live intent.
        // The host re-checks the trigger itself.
        if (LibVaipakam.storageSlot().intentCommits[loanId].orderHash != bytes32(0)) {
            SwapToRepayIntentFacet(address(this)).forceCancelIntentFor(
                loanId, SwapToRepayIntentFacet.ForceCancelReason.PeriodicShortfallDue
            );
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
        // #2795 — size, sell and divide on the consolidated position. The sale
        // cannot proceed without a price, so a missing or stale feed reverts
        // inside the host with the reader's own error before anything moves;
        // every route failing reverts {PeriodicSettleSwapFailed}.
        ForcedSaleFacet.ForcedSaleOutcome memory out = abi.decode(
            LibFacet.crossFacetCallReturn(
                abi.encodeCall(
                    ForcedSaleFacet.sellToNeed,
                    (
                        loanId,
                        ForcedSaleFacet.ForcedSaleKind.PeriodicSettlement,
                        sellAmount,
                        adapterCalls,
                        new LibSwap.SplitCall[](0),
                        msg.sender
                    )
                ),
                bytes4(0)
            ),
            (ForcedSaleFacet.ForcedSaleOutcome)
        );

        // The checkpoint advances on any payout. A sale that could not cover
        // the shortfall leaves the difference owed (only what arrived was
        // credited to `interestSettled`), and the event states both figures.
        LibPeriodicInterest.advanceCheckpoint(loan);
        emit PeriodicInterestAutoLiquidated(
            loanId,
            boundary,
            shortfall,
            sellAmount,
            out.lenderPaid,
            out.keeperBonus,
            out.handlingFee,
            out.borrowerExtra,
            out.borrowerExtraHeld,
            msg.sender
        );
    }
}
