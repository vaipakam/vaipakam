// src/facets/SwapToRepayFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibSettlement} from "../libraries/LibSettlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title SwapToRepayFacet
 * @author Vaipakam Developer Team
 * @notice T-090 — Borrower-initiated swap-to-repay surface. Lets the
 *         borrower swap their collateral asset into the loan's principal
 *         asset and apply the proceeds to settlement in a single
 *         transaction, instead of the 4-step withdraw → external swap →
 *         re-deposit → repay flow.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded,
 *      pausable. ERC20-on-ERC20 loans only in v1; NFT collateral has no
 *      swap path at repay time today (T-086's prepay-listing surface is
 *      gated to the pre-grace window).
 *
 *      Two entry points:
 *        {swapToRepayFull}    — close-out via swap. Respects
 *                               `loan.useFullTermInterest`.
 *        {swapToRepayPartial} — partial principal reduction via swap,
 *                               gated on `loan.allowsPartialRepay`.
 *
 *      Slippage cap: `cfgMaxSwapToRepaySlippageBps()` (default 300 bps =
 *      3% — tighter than the liquidation cap because the borrower picks
 *      the moment and can wait for better price action).
 *
 *      Auth: both entry points require `LibAuth.requireBorrower(loan)` —
 *      no third-party "swap-on-behalf-of". The borrower's collateral is
 *      at risk during the swap; consent must be the borrower's own.
 *      Third parties can still use `RepayFacet.repayLoan` to repay on
 *      the borrower's behalf with their own principal asset.
 *
 *      Surplus principal (when a tight quote delivers more than the
 *      loan requires) routes to the borrower's vault — they took the
 *      slippage risk, they get the symmetric upside.
 *
 *      Total swap failure (every adapter reverted) reverts the whole
 *      tx — no soft-fallback in v1. Borrower can retry with better
 *      routing.
 *
 *      Yield-fee VPFI discount (RepayFacet:309-321) is NOT applied on
 *      this path in v1 — see docs/DesignsAndPlans/SwapToRepay.md §6.2.
 *      Tracked for v1.1.
 */
contract SwapToRepayFacet is DiamondReentrancyGuard, DiamondPausable, IVaipakamErrors {
    using SafeERC20 for IERC20;

    /// @notice Emitted on a successful full swap-to-repay close-out.
    /// @param loanId The loan being settled.
    /// @param borrower The borrower (== msg.sender — caller authority).
    /// @param collateralIn The collateral consumed by the swap.
    /// @param principalOut The principal asset received from the swap.
    /// @param adapterUsed The `LibSwap` adapter index that succeeded.
    /// @custom:event-category state-change/loan-mutation
    event SwapToRepayExecuted(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 collateralIn,
        uint256 principalOut,
        uint256 adapterUsed
    );

    /// @notice Emitted on a successful partial swap-to-repay (principal
    ///         reduced; loan continues in Active).
    /// @param loanId The loan being partially repaid.
    /// @param borrower The borrower (== msg.sender).
    /// @param collateralIn The collateral consumed by the swap.
    /// @param principalOut The principal asset received from the swap.
    /// @param partialPrincipal The principal amount retired.
    /// @param adapterUsed The `LibSwap` adapter index that succeeded.
    /// @custom:event-category state-change/loan-mutation
    event SwapToRepayPartialExecuted(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 collateralIn,
        uint256 principalOut,
        uint256 partialPrincipal,
        uint256 adapterUsed
    );

    /// @notice Mirror of `RepayFacet.RepayPartialPeriodAdvanced` so the
    ///         T-034 periodic-interest checkpoint-advance signal is
    ///         observable on the swap-to-repay path too. Identical
    ///         topic hash — indexers subscribing by topic catch both.
    ///         (Codex round-1 PR #390 P2 #2.)
    /// @custom:event-category state-change/loan-mutation
    event RepayPartialPeriodAdvanced(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 expected,
        address indexed advancedBy
    );

    /// @notice Mirror of `RepayFacet.PeriodicInterestSettled`. Topic
    ///         match — see {RepayPartialPeriodAdvanced}.
    ///         (Codex round-1 PR #390 P2 #2.)
    /// @custom:event-category state-change/loan-mutation
    event PeriodicInterestSettled(
        uint256 indexed loanId,
        uint256 periodEndAt,
        uint256 expected,
        uint256 paidByBorrower,
        address indexed settler
    );

    /// @notice Pre-flight check failed: the slippage floor would not
    ///         cover the loan's required principal payoff. Borrower
    ///         must raise `maxCollateralIn` or wait for better price
    ///         action.
    error SwapBoundsInsufficient();

    /// @notice `LibSwap.swapWithFailover` returned `(success=false)` —
    ///         every adapter in the caller's try-list reverted.
    error SwapAllAdaptersFailed();

    /// @notice The loan isn't ERC20-on-ERC20 — NFT collateral / NFT
    ///         rental / illiquid-asset loans are out of scope for the
    ///         swap-to-repay surface in v1.
    error UnsupportedLoanShape();

    /// @notice Partial swap-to-repay proceeds would retire the full
    ///         loan principal. To avoid leaving an Active zero-principal
    ///         loan, the borrower must use `swapToRepayFull` instead —
    ///         which carries the close-out side-effects (Repaid status,
    ///         position-NFT lifecycle, reward close).
    error PartialWouldRetireFullPrincipal();

    /// @notice Repayment attempted past the loan's grace period —
    ///         beyond that point only `DefaultedFacet` can resolve.
    ///         Mirrored from `RepayFacet`.
    error RepaymentPastGracePeriod();

    /// @notice The offer was not opted into partial repay at creation;
    ///         the partial swap-to-repay path requires the lender's
    ///         pre-consent via `Offer.allowsPartialRepay`. Mirrored
    ///         from `RepayFacet`.
    error PartialRepayNotAllowed();

    /// @notice Partial swap-to-repay proceeds resolved to less than
    ///         the asset-level `minPartialBps` floor (`loan.principal *
    ///         minPartialBps / BASIS_POINTS`). Mirrored from `RepayFacet`.
    error InsufficientPartialAmount();

    /// @notice Full swap-to-repay: swap the borrower's collateral asset
    ///         for the loan's principal asset and close the loan in
    ///         one transaction.
    /// @dev    Only `Active` loans (FallbackPending cure intentionally
    ///         out-of-scope in v1 to keep the slippage surface narrow).
    ///         ERC20-on-ERC20 loans only.
    ///
    ///         Slippage floor computed from
    ///         `LibFallback.expectedSwapOutput` × (BPS - cap) / BPS and
    ///         passed to `LibSwap` as `minOutput`. The settlement-debt
    ///         requirement is a SEPARATE post-swap assertion — passing
    ///         `requiredPrincipal` to LibSwap directly would let a
    ///         too-generous `maxCollateralIn` get consumed at arbitrarily
    ///         bad pricing (Codex round-1 P1 #1).
    ///
    ///         Lender / treasury / borrower distribution mirrors
    ///         `RepayFacet.repayLoan` for diamond-held proceeds:
    ///         direct `safeTransfer` to each destination + matching
    ///         `recordVaultDeposit` / `recordTreasuryAccrual` —
    ///         NOT `vaultDepositERC20From` (would need a self-allowance
    ///         the diamond never sets; Codex round-1 P1 #3).
    ///
    /// @param loanId           The loan to settle.
    /// @param adapterCalls     Keeper-ranked 4-DEX try-list
    ///                          (`LibSwap.AdapterCall[]`).
    /// @param maxCollateralIn  Upper bound on collateral the caller
    ///                          permits the diamond to withdraw + swap.
    ///                          Must be ≤ `loan.collateralAmount`.
    function swapToRepayFull(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata adapterCalls,
        uint256 maxCollateralIn
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // ── Pre-flight gates ─────────────────────────────────────────
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert InvalidLoanStatus();
        // Codex round-1 PR #390 P2 #4 — both PRINCIPAL and COLLATERAL
        // must be ERC20. The v0 design checked `loan.assetType` (which
        // is the principal asset type) but not `collateralAssetType` —
        // letting an ERC20-loan with NFT collateral through the gate
        // would have proceeded into ERC20 metadata calls + ERC20
        // vault withdraw against the NFT contract, with unpredictable
        // downstream reverts.
        if (
            loan.assetType != LibVaipakam.AssetType.ERC20 ||
            loan.collateralAssetType != LibVaipakam.AssetType.ERC20
        ) revert UnsupportedLoanShape();
        if (
            loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
            loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid
        ) revert UnsupportedLoanShape();
        // Codex round-1 PR #390 P1 #3 — borrower NFT ownership (not the
        // latched `loan.borrower` field) is the authority root. Claim
        // rights travel with the position NFT, so the current NFT
        // holder must be the only caller able to spend pledged collateral.
        LibAuth.requireBorrowerNftOwner(loan);

        // Block lender-side self-repay (mirrors RepayFacet:273-278).
        if (msg.sender == loan.lender) revert LenderCannotRepayOwnLoan();
        if (
            IERC721(address(this)).ownerOf(loan.lenderTokenId) == msg.sender
        ) revert LenderCannotRepayOwnLoan();

        if (maxCollateralIn == 0 || maxCollateralIn > loan.collateralAmount)
            revert InvalidAmount();

        uint256 endTime = loan.startTime + loan.durationDays * LibVaipakam.ONE_DAY;
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp > graceEnd) revert RepaymentPastGracePeriod();

        // ── Build the settlement plan + required-principal target ────
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
        LibSettlement.ERC20Settlement memory plan = LibSettlement.computeRepayment(
            loan,
            lateFee,
            block.timestamp
        );
        uint256 requiredPrincipal = plan.lenderDue + plan.treasuryShare;

        // ── Slippage floor pre-flight (Codex round-1 P1 #1) ──────────
        // Pass the slippage-floor to LibSwap, not requiredPrincipal —
        // the latter would let any maxCollateralIn slip through at
        // arbitrarily bad pricing as long as the debt closed.
        uint256 expectedProceeds = LibFallback.expectedSwapOutput(
            address(this),
            loan.collateralAsset,
            loan.principalAsset,
            maxCollateralIn
        );
        uint256 minPrincipalOut = (expectedProceeds *
            (LibVaipakam.BASIS_POINTS - LibVaipakam.cfgMaxSwapToRepaySlippageBps())) /
            LibVaipakam.BASIS_POINTS;
        if (minPrincipalOut < requiredPrincipal) revert SwapBoundsInsufficient();

        // ── Withdraw collateral to diamond + execute swap ────────────
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                loan.borrower,
                loan.collateralAsset,
                address(this),
                maxCollateralIn
            ),
            VaultWithdrawFailed.selector
        );

        (bool success, uint256 outputAmount, uint256 adapterUsed) = LibSwap.swapWithFailover(
            loanId,
            loan.collateralAsset,
            loan.principalAsset,
            maxCollateralIn,
            minPrincipalOut,
            address(this),
            adapterCalls
        );
        if (!success) revert SwapAllAdaptersFailed();
        // Slippage floor cleared the loan; the debt-cover bound is a
        // separate post-swap assertion (Codex P2 #2).
        if (outputAmount < requiredPrincipal) revert InsufficientProceeds();

        // ── Settlement waterfall — diamond-held proceeds pattern
        //    (Codex round-1 P1 #3 — mirrors RiskFacet:702-712) ────────
        address treasury = LibFacet.getTreasury();
        if (plan.treasuryShare > 0) {
            IERC20(loan.principalAsset).safeTransfer(treasury, plan.treasuryShare);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, plan.treasuryShare);
        }

        address lenderVault = LibFacet.getOrCreateVault(loan.lender);
        IERC20(loan.principalAsset).safeTransfer(lenderVault, plan.lenderDue);
        LibVaipakam.recordVaultDeposit(loan.lender, loan.principalAsset, plan.lenderDue);

        // Surplus principal → CURRENT borrower-position NFT holder's
        // vault (Codex round-2 P1 #1). Routing to `loan.borrower`
        // (the latched field) after authorizing the current NFT
        // owner would let the original borrower siphon the surplus
        // by simply having their vault un-recorded for that asset.
        // Resolve the current owner via `ownerOf(borrowerTokenId)`.
        uint256 surplusPrincipal = outputAmount - requiredPrincipal;
        address currentBorrowerHolder = IERC721(address(this))
            .ownerOf(loan.borrowerTokenId);
        if (surplusPrincipal > 0) {
            address holderVault = LibFacet.getOrCreateVault(currentBorrowerHolder);
            IERC20(loan.principalAsset).safeTransfer(holderVault, surplusPrincipal);
            LibVaipakam.recordVaultDeposit(
                currentBorrowerHolder,
                loan.principalAsset,
                surplusPrincipal
            );
        }

        // ── Claim slots ──────────────────────────────────────────────
        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: plan.lenderDue,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });

        // Codex round-1 P1 #2 — record the residual pledged collateral
        // that was never withdrawn from the borrower's vault. The
        // borrower keeps `collateralAmount - maxCollateralIn`; the
        // ClaimFacet release path unlocks it on the Repaid transition.
        // Codex round-2 P1 #2 — `claimed: false` regardless of
        // residual=0 so the LIF VPFI rebate path
        // (`settleBorrowerLifProper` below) can credit
        // `borrowerLifRebate` for later claim. `ClaimFacet.claimAsBorrower`
        // gates on `claim.claimed` BEFORE considering the LIF rebate;
        // marking claimed=true at write time would lock the rebate
        // surface entirely.
        uint256 residualCollateral = loan.collateralAmount - maxCollateralIn;
        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: residualCollateral,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });

        // ── Position-NFT status flip → LoanRepaid ────────────────────
        // Codex round-1 PR #390 P2 #3 — without this, marketplaces +
        // dashboards reading the NFT metadata keep showing the loan
        // as active during the claim window. Mirror RepayFacet:516-535.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            NFTStatusUpdateFailed.selector
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            NFTStatusUpdateFailed.selector
        );

        // ── Active prepay listing cleanup ────────────────────────────
        // Codex round-1 PR #390 P2 #1 — atomically revoke the vault's
        // ERC-1271 binding for any live prepay listing on this loan,
        // release the borrower-position-NFT lock, and clear the
        // diamond / executor / vault bookkeeping. Idempotent on loans
        // without a live listing. Placement mirrors RepayFacet:550:
        // after every safeTransfer has committed, before the status
        // flip declares the listing dead.
        LibPrepayCleanup.clearActiveListing(loan, loanId);

        // ── Transition + LIF VPFI settlement ─────────────────────────
        LibLifecycle.transition(
            loan,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.Repaid
        );

        // Codex round-1 PR #390 P1 #2 — Phase 5 / §5.2b proper-close
        // settlement for the borrower LIF VPFI path. Splits any
        // diamond-held VPFI between the borrower's claimable rebate
        // (scaled by time-weighted avg discount BPS) and the
        // treasury share. No-op on loans that took the lending-asset
        // fee path at init (vpfiHeld == 0). Mirror RepayFacet:561.
        LibVPFIDiscount.settleBorrowerLifProper(loan);

        // ── Phase-2 reward accrual close ─────────────────────────────
        LibInteractionRewards.closeLoan(
            loanId,
            /* borrowerClean */ true,
            /* lenderForfeit */ false
        );

        emit SwapToRepayExecuted(
            loanId,
            loan.borrower,
            maxCollateralIn,
            outputAmount,
            adapterUsed
        );
    }

    /// @notice Partial swap-to-repay: swap a portion of the borrower's
    ///         collateral for the principal asset and apply the proceeds
    ///         to a partial principal reduction. Resets the accrual
    ///         clock per `repayPartial` semantics.
    /// @dev    Gated on `loan.allowsPartialRepay` (snapshotted from
    ///         `Offer.allowsPartialRepay` at init). Post-swap HF check
    ///         per `repayPartial:771-783`.
    /// @param loanId               The loan to partially repay.
    /// @param collateralSwapAmount The collateral input to swap.
    /// @param adapterCalls         Keeper-ranked try-list.
    function swapToRepayPartial(
        uint256 loanId,
        uint256 collateralSwapAmount,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        // ── Pre-flight gates ─────────────────────────────────────────
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert InvalidLoanStatus();
        // Codex round-1 PR #390 P2 #4 (same fix as `swapToRepayFull`).
        if (
            loan.assetType != LibVaipakam.AssetType.ERC20 ||
            loan.collateralAssetType != LibVaipakam.AssetType.ERC20
        ) revert UnsupportedLoanShape();
        if (
            loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
            loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid
        ) revert UnsupportedLoanShape();
        // Codex round-1 PR #390 P1 #3 (same fix as `swapToRepayFull`).
        LibAuth.requireBorrowerNftOwner(loan);

        // Codex round-2 PR #390 P2 #1 — block lender self-repay on
        // the partial path too. The full path had this guard from
        // round-0; without the mirror, a lender who has acquired the
        // borrower-side position NFT could consume claim-bearing
        // collateral and route the partial principal + interest into
        // their own lender vault while keeping the loan Active.
        if (msg.sender == loan.lender) revert LenderCannotRepayOwnLoan();
        if (
            IERC721(address(this)).ownerOf(loan.lenderTokenId) == msg.sender
        ) revert LenderCannotRepayOwnLoan();

        if (!loan.allowsPartialRepay) revert PartialRepayNotAllowed();

        if (collateralSwapAmount == 0 || collateralSwapAmount > loan.collateralAmount)
            revert InvalidAmount();

        uint256 endTime = loan.startTime + loan.durationDays * LibVaipakam.ONE_DAY;
        uint256 graceEnd = endTime + LibVaipakam.gracePeriod(loan.durationDays);
        if (block.timestamp > graceEnd) revert RepaymentPastGracePeriod();

        // ── Slippage floor pre-flight ────────────────────────────────
        uint256 expectedProceeds = LibFallback.expectedSwapOutput(
            address(this),
            loan.collateralAsset,
            loan.principalAsset,
            collateralSwapAmount
        );
        uint256 minPrincipalOut = (expectedProceeds *
            (LibVaipakam.BASIS_POINTS - LibVaipakam.cfgMaxSwapToRepaySlippageBps())) /
            LibVaipakam.BASIS_POINTS;

        // ── Withdraw + swap ──────────────────────────────────────────
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
                loan.borrower,
                loan.collateralAsset,
                address(this),
                collateralSwapAmount
            ),
            VaultWithdrawFailed.selector
        );

        (bool success, uint256 outputAmount, uint256 adapterUsed) = LibSwap.swapWithFailover(
            loanId,
            loan.collateralAsset,
            loan.principalAsset,
            collateralSwapAmount,
            minPrincipalOut,
            address(this),
            adapterCalls
        );
        if (!success) revert SwapAllAdaptersFailed();

        // ── Accrued-interest split + partial bound ───────────────────
        uint256 accrued = LibEntitlement.accruedInterestToTime(loan, block.timestamp);
        (uint256 treasuryShare, uint256 lenderShare) = LibEntitlement.splitTreasury(accrued);

        // Must at least cover the accrued interest.
        if (outputAmount < lenderShare + treasuryShare) revert InsufficientProceeds();
        uint256 partialPrincipal = outputAmount - lenderShare - treasuryShare;
        if (partialPrincipal == 0) revert InsufficientProceeds();

        // Codex round-1 P2 #3 — reject swaps that would retire the
        // full principal; borrower must use `swapToRepayFull` for
        // close-out side-effects.
        if (partialPrincipal >= loan.principal)
            revert PartialWouldRetireFullPrincipal();

        uint256 minPartial = (loan.principal *
            s.assetRiskParams[loan.principalAsset].minPartialBps) /
            LibVaipakam.BASIS_POINTS;
        if (partialPrincipal < minPartial) revert InsufficientPartialAmount();

        // ── Settle waterfall — diamond-held pattern ──────────────────
        address treasury = LibFacet.getTreasury();
        if (treasuryShare > 0) {
            IERC20(loan.principalAsset).safeTransfer(treasury, treasuryShare);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, treasuryShare);
        }

        address lenderVault = LibFacet.getOrCreateVault(loan.lender);
        uint256 lenderTotal = lenderShare + partialPrincipal;
        IERC20(loan.principalAsset).safeTransfer(lenderVault, lenderTotal);
        LibVaipakam.recordVaultDeposit(loan.lender, loan.principalAsset, lenderTotal);

        // Any leftover principal (above accrued + partialPrincipal) →
        // current borrower-NFT holder's vault (Codex round-2 P1 #1
        // mirror of the full-path fix). Resolves via
        // `ownerOf(borrowerTokenId)` so the surplus follows the NFT.
        uint256 surplus = outputAmount - treasuryShare - lenderTotal;
        if (surplus > 0) {
            address currentBorrowerHolder = IERC721(address(this))
                .ownerOf(loan.borrowerTokenId);
            address holderVault = LibFacet.getOrCreateVault(currentBorrowerHolder);
            IERC20(loan.principalAsset).safeTransfer(holderVault, surplus);
            LibVaipakam.recordVaultDeposit(
                currentBorrowerHolder,
                loan.principalAsset,
                surplus
            );
        }

        // ── Loan state updates ───────────────────────────────────────
        unchecked {
            loan.principal -= partialPrincipal;
            // Codex round-1 P1 #4 — also reduce collateralAmount so
            // HF / default / claim logic reflects true post-swap
            // backing.
            loan.collateralAmount -= collateralSwapAmount;
        }
        loan.startTime = uint64(block.timestamp); // reset accrual clock

        // ── T-034 §4.5 — periodic-interest checkpoint advance
        //    (mirror RepayFacet:679-706) ────────────────────────────
        if (loan.periodicInterestCadence != LibVaipakam.PeriodicInterestCadence.None) {
            uint256 newPaid = uint256(loan.interestPaidSinceLastPeriod) + accrued;
            if (newPaid > type(uint128).max) newPaid = type(uint128).max;
            loan.interestPaidSinceLastPeriod = SafeCast.toUint128(newPaid);
            if (LibPeriodicInterest.canAdvanceCheckpointInline(loan)) {
                // Codex round-1 PR #390 P2 #2 — emit the
                // `RepayPartialPeriodAdvanced` + `PeriodicInterestSettled`
                // events that off-chain accounting subscribes to. Both
                // are topic-matched to the RepayFacet declarations so
                // existing indexer / dashboard handlers fire here too.
                uint256 boundary = LibPeriodicInterest.periodEndAt(loan);
                uint256 expected = LibPeriodicInterest.expectedInterestForPeriod(loan);
                LibPeriodicInterest.advanceCheckpoint(loan);
                emit RepayPartialPeriodAdvanced(loanId, boundary, expected, msg.sender);
                emit PeriodicInterestSettled(
                    loanId,
                    boundary,
                    expected,
                    newPaid,
                    msg.sender
                );
            }
        }

        // ── Post-repay HF guard ──────────────────────────────────────
        bytes memory hfResult = LibFacet.crossFacetStaticCall(
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId),
            HealthFactorCalculationFailed.selector
        );
        uint256 hf = abi.decode(hfResult, (uint256));
        if (hf < LibVaipakam.MIN_HEALTH_FACTOR) revert HealthFactorTooLow();

        emit SwapToRepayPartialExecuted(
            loanId,
            loan.borrower,
            collateralSwapAmount,
            outputAmount,
            partialPrincipal,
            adapterUsed
        );
    }
}
