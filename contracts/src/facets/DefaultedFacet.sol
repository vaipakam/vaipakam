// src/facets/DefaultedFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
import {SwapToRepayIntentFacet} from "./SwapToRepayIntentFacet.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
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
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "./RiskMatchLiquidationFacet.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";

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

    /// @notice Emitted when a time-based default's swap-path fallback fires
    ///         and the loan transitions `Active → FallbackPending`. Distinct
    ///         from {LoanDefaulted} (terminal): the loan is still curable
    ///         via {RepayFacet.repayLoan} or
    ///         {AddCollateralFacet.addCollateral} until the lender claims.
    /// @dev    Mutates `s.loans[loanId].status` to `FallbackPending` via
    ///         {_fullCollateralTransferFallback} → {LibLifecycle.transition}.
    ///         Emit-site MUST match the storage transition one-to-one
    ///         (EventSourcingAudit §1.5 rule 1).
    /// @param loanId The fallback-pending loan ID.
    /// @param lender Lender address (indexed for filterable subscriptions).
    /// @param riskAndTermsConsentFromBoth Mirrors {Loan.riskAndTermsConsentFromBoth}
    ///        — informational, not a routing signal.
    /// @param newStatus Post-transition `LoanStatus` (always
    ///        `FallbackPending` for this event); included so cache-merge
    ///        consumers can update the row directly from the payload.
    /// @custom:event-category state-change/loan-mutation
    event LoanFallbackPending(
        uint256 indexed loanId,
        address indexed lender,
        bool riskAndTermsConsentFromBoth,
        LibVaipakam.LoanStatus newStatus
    );

    /// @notice Emitted when a loan reaches the terminal `Defaulted` status.
    /// @dev    Mutates `s.loans[loanId].status` to `Defaulted`. Sibling
    ///         {LoanFallbackPending} captures the swap-failure path's
    ///         intermediate `FallbackPending` transition; this event is
    ///         strictly the terminal `→ Defaulted` flip.
    /// @param loanId The ID of the defaulted loan.
    /// @param riskAndTermsConsentFromBoth Mirrors {Loan.riskAndTermsConsentFromBoth}
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
    /// @param newStatus Post-transition `LoanStatus` (always `Defaulted`
    ///        for this event).
    /// @custom:event-category state-change/loan-mutation
    event LoanDefaulted(
        uint256 indexed loanId,
        bool riskAndTermsConsentFromBoth,
        LibVaipakam.LoanStatus newStatus
    );

    /// @notice Emitted when a liquidation is triggered for liquid collateral.
    /// @dev    Mutates `s.loans[loanId].status` to `Defaulted` (downstream
    ///         of the swap-success path). Treated as a `loan-mutation` for
    ///         the cache-merge contract — the row's terminal label flips
    ///         from `Active` to `LoanLiquidated` on the NFT side.
    /// @param loanId The ID of the liquidated loan.
    /// @param proceeds The amount recovered from liquidation.
    /// @param treasuryFee The treasury fee deducted (if any).
    /// @custom:event-category state-change/loan-mutation
    event LoanLiquidated(
        uint256 indexed loanId,
        uint256 proceeds,
        uint256 treasuryFee
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error NotDefaultedYet();
    /// @notice l2 sequencer is offline or still in its 1h recovery grace
    ///         window; default processing is blocked so the caller can
    ///         retry once prices are trustworthy again.
    error SequencerUnhealthy();

    // MAX_LIQUIDATION_SLIPPAGE_BPS consolidated in LibVaipakam

    /// @notice Emitted alongside {LoanFallbackPending} when a time-based
    ///         default falls back to full-collateral disposition because
    ///         the DEX swap reverted or exceeded the 6% slippage ceiling
    ///         (README §7).
    /// @dev    Informational — the storage transition is captured by
    ///         {LoanFallbackPending}; lender + collateral amount are
    ///         recoverable from `s.loans[loanId].lender` and
    ///         `s.fallbackSnapshot[loanId]` respectively.
    ///         EventSourcingAudit §1.4 + §1.5 — primary-key-only payload.
    /// @param loanId The defaulted loan ID.
    /// @custom:event-category informational/liquidation
    event LiquidationFallback(uint256 indexed loanId);

    /// @notice Emitted when the time-based default fallback ran without
    ///         an oracle-quorum price — neither leg of the collateral /
    ///         principal pair had a fresh Phase-7b 2-of-N reading
    ///         available. The fallback degenerates to "full collateral
    ///         to lender claim, treasury + borrower zero". Mirrors the
    ///         same-named event on {RiskFacet}; downstream indexers can
    ///         distinguish "oracle worked, lender claim exceeded
    ///         collateral" from "oracle quorum stale" via this signal.
    /// @dev    Phase 2 of AutonomousLtvAndOracleFallback.md design — the
    ///         pre-Phase-2 behaviour reverted the whole default action
    ///         when oracle was stale; the new path lets a stale oracle
    ///         pair settle the loan (lender absorbs) rather than pinning
    ///         it in Active state.
    /// @custom:event-category informational/liquidation
    event LiquidationFallbackOracleUnavailable(uint256 indexed loanId);

    /// @notice Emitted alongside {LiquidationFallback} with the README §7
    ///         three-way split.
    /// @dev    Informational — the lender / treasury / borrower allocation
    ///         is stored verbatim in `s.fallbackSnapshot[loanId]`.
    ///         EventSourcingAudit §1.4 + §1.5 — primary-key-only payload.
    /// @param loanId The defaulted loan ID.
    /// @custom:event-category informational/liquidation
    event LiquidationFallbackSplit(uint256 indexed loanId);

    /**
     * @notice Triggers default for a loan past grace period (permissionless).
     * @dev If liquid collateral: Calls triggerLiquidation (0x swap).
     *      If illiquid: Transfers full collateral to lender.
     *      Enhanced for NFTs: Transfers prepay (amount * durationDays) to lender, buffer (5%) to treasury from borrower vault.
     *      Resets renter via vaultSetNFTUser(address(0), 0).
     *      Updates loan to Defaulted, burns NFTs.
     *      Emits LoanDefaulted.
     * @param loanId The loan ID to default.
     */
    function triggerDefault(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) external whenNotPaused nonReentrant {
        // T-090 v1.1 (#389) §5.8 — if a v1.1 intent commit is live
        // AND the loan is past `endTime + gracePeriod`, force-cancel
        // it (return collateral + clear state + emit
        // `SwapToRepayIntentForceCancelled(TimeDefaultDue)`) then
        // proceed with the default flow. Pre-grace commits keep
        // their window — `IntentPending` revert (Codex round-5 P1 #8).
        if (LibVaipakam.storageSlot().intentCommits[loanId].orderHash != bytes32(0)) {
            SwapToRepayIntentFacet(address(this)).forceCancelIntentIfPastDefaultOrRevert(loanId);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active)
            revert InvalidLoanStatus();

        // T-086 step 10 — default-flow lock-bypass. If a prepay-
        // listing is live on this loan, clear it FIRST so the
        // borrower-position NFT is unlocked + the diamond / vault /
        // executor bookkeeping is consistent before this facet
        // starts moving collateral. Idempotent no-op when no
        // listing is live. See design doc §5.4 — without this,
        // the strict `LibERC721._lock` overwrite-protection
        // (step 6 round 2) would block any subsequent flow that
        // needs to re-lock the same token, and stale orderHash
        // bindings on the executor / vault would let a previously-
        // signed Seaport order continue to be (futilely) submitted.
        s; // suppress unused-storage warning; the library reads it.
        LibPrepayCleanup.clearActiveListing(loan, loanId);

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
        uint256 graceEnd = endTime + LibVaipakam.loanGracePeriod(loan); // #641 — original-term grace
        if (block.timestamp <= graceEnd) revert NotDefaultedYet();

        address treasury = LibFacet.getTreasury();

        // l2 circuit breaker: block the default trigger entirely while the
        // sequencer is down or in its 1h recovery grace window. Chainlink
        // prices and AMM pools are unreliable under those conditions,
        // so a DEX swap would cross heavy slippage. Sequencer outages are
        // typically short — the caller can simply retry once it recovers,
        // which is safer than locking the loan into an irreversible full-
        // collateral-transfer fallback based on a transient state.
        if (!OracleFacet(address(this)).sequencerHealthy()) {
            revert SequencerUnhealthy();
        }

        // #594 — time-based default is a BOTH-SIDE close-out: liquidation
        // proceeds / illiquid-collateral transfers route to the stored borrower
        // AND lender anchors. Consolidate each side whose NFT may have moved so
        // a position that reaches default before any consolidating event routes
        // to the current holders. Tier-2 (skip-not-block; a sanctioned holder
        // can't block the close-out). Placed here — after the prepay-listing
        // teardown (so the borrower side isn't `_isExcludedLive`-skipped; Codex
        // #659 r2) and AFTER the lender-KYC gate above (Codex #659 r3: an
        // un-KYC'd transferee must NOT brick a permissionless default — the KYC
        // gate evaluates the original `loan.lender`, and receipt is gated later
        // at claim), but BEFORE the internal-match dispatch + every settlement
        // branch below, which all pay/return to the consolidated anchors.
        LibConsolidation.consolidateToHolder(loanId, false, LibConsolidation.Ctx.Tier2CloseOut);
        LibConsolidation.consolidateToHolder(loanId, true, LibConsolidation.Ctx.Tier2CloseOut);

        // EC-003 Phase 3 — internal-match auto-dispatch. Before falling
        // through to the external-aggregator swap path below, check
        // whether an opposing-direction internal-match candidate exists.
        // If yes, settle at oracle price (no DEX slippage), pay the 1%
        // matcher bonus to `msg.sender`, and return. Time-based defaults
        // are the same as HF-based: any caller who triggers default
        // when an internal match exists is the de-facto matcher and
        // earns the same incentive.
        if (RiskMatchLiquidationFacet(address(this)).attemptInternalMatchAutoDispatch(loanId, msg.sender)) {
            return;
        }

        // #569 §4.4 (2026-06-13) — release the collateral lien only
        // AFTER the internal-match dispatch returned false. Codex #571
        // P1: an EARLY release (before dispatch) tombstoned the lien, so
        // a PARTIAL internal match that leaves the loan Active with
        // reduced collateral would strand the residual collateral
        // unprotected (the post-match decrement no-ops on a released
        // row). The internal-match path owns its own lien adjustment
        // (pre-withdraw decrement in `_executeTwoWayMatch` /
        // `_executeThreeWayMatch`); from here down we're on the
        // terminal external/default-transfer path, where a full release
        // is correct and clears the guard for the collateral drains
        // below. Idempotent on already-released / empty rows; no-op on
        // NFT rentals (D-1). Private helper keeps `triggerDefault`'s
        // stack under viaIR's ceiling.
        _releaseLienAtDefault(loanId);

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

                // Withdraw collateral from borrower's vault. #821 (Codex #832 r3
                // P1) — move-out-exempt so a borrower flagged after init doesn't
                // brick the liquid time-based default (collateral pushed OUT to
                // the already-screened swap recipients).
                LibSanctionedLock.vaultWithdrawERC20MoveOut(
                    s,
                    loan.borrower,
                    loan.collateralAsset,
                    address(this),
                    loan.collateralAmount
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
                    // §3.8 — _fullCollateralTransferFallback transitioned the
                    // loan to FallbackPending; emit the matching state-change
                    // event (NOT LoanDefaulted — the loan is still curable).
                    emit LoanFallbackPending(
                        loanId,
                        loan.lender,
                        loan.riskAndTermsConsentFromBoth,
                        loan.status
                    );
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

                // Deposit lender proceeds into lender's vault for claim. #821 —
                // vault-lock so a flagged stored lender doesn't brick the default
                // (T-051 — the Diamond-side transfer ticks protocolTrackedVaultBalance).
                LibSanctionedLock.depositLocked(
                    s, loan.lender, loanId, loan.principalAsset, lenderProceeds
                );

                s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                    asset: loan.principalAsset,
                    amount: lenderProceeds,
                    assetType: LibVaipakam.AssetType.ERC20,
                    tokenId: 0,
                    quantity: 0,
                    claimed: false
                });
                // #592 — reserve VPFI lender proceeds against the unstake path
                // until the current holder claims (released in ClaimFacet).
                // The proceeds sit in the stored lender's vault; VPFI is the
                // one principal asset with a user-facing tracked exit. No-op
                // for non-VPFI principal.
                if (loan.principalAsset == s.vpfiToken) {
                    LibEncumbrance.encumberLenderProceeds(
                        loanId, loan.lender, loan.principalAsset, lenderProceeds
                    );
                }

                // Borrower surplus
                if (borrowerSurplus > 0) {
                    LibSanctionedLock.depositLocked(
                        s, loan.borrower, loanId, loan.principalAsset, borrowerSurplus
                    );
                    // #661 — reserve a VPFI surplus against the unstake path until
                    // the current borrower-position holder claims it (mirror of
                    // the #592 lender-proceeds reserve above). No-op for non-VPFI.
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
            } else if (
                ((liquidity == LibVaipakam.LiquidityStatus.Liquid &&
                    isCollateralValueCollapsed) ||
                    (liquidity == LibVaipakam.LiquidityStatus.Illiquid &&
                        loan.riskAndTermsConsentFromBoth))
            ) {
                // Illiquid or value collapsed: Move collateral from borrower's vault to lender's vault
                // so ClaimFacet.claimAsLender can withdraw from lender's vault consistently.
                // #821 — vault-lock the in-kind collateral into a flagged stored
                // lender's vault rather than bricking the default. #832 r7 P3 —
                // report the real parked payload in the lock event: ERC-1155
                // carries its amount in `collateralQuantity` (`collateralAmount`
                // is structurally zero for non-ERC-20 collateral), so pass the
                // quantity for ERC-1155 to keep the reconciliation trail accurate.
                address lenderVault = LibSanctionedLock.getOrCreateVaultLocked(
                    s,
                    loan.lender,
                    loanId,
                    loan.collateralAsset,
                    loan.collateralAssetType == LibVaipakam.AssetType.ERC1155
                        ? loan.collateralQuantity
                        : loan.collateralAmount
                );

                // #821 (Codex #832 r2 P1) — the in-kind move WITHDRAWS the
                // collateral from the borrower's vault, which resolves through the
                // Tier-1-gated `getOrCreateUserVault`. Arm the from-side move-out
                // exemption so a borrower flagged after init doesn't brick the
                // default (the collateral is pushed OUT to the lender's vault).
                LibSanctionedLock.beginMoveOut(s, loan.borrower);
                if (loan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
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
                    IERC20(loan.collateralAsset).safeTransfer(lenderVault, loan.collateralAmount);
                    // T-051 — Diamond-side transfer to lender's vault
                    // ticks the protocolTrackedVaultBalance counter.
                    LibVaipakam.recordVaultDeposit(loan.lender, loan.collateralAsset, loan.collateralAmount);
                } else if (loan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            VaultFactoryFacet.vaultWithdrawERC721.selector,
                            loan.borrower,
                            loan.collateralAsset,
                            loan.collateralTokenId,
                            lenderVault
                        ),
                        VaultWithdrawFailed.selector
                    );
                } else if (loan.collateralAssetType == LibVaipakam.AssetType.ERC1155) {
                    LibFacet.crossFacetCall(
                        abi.encodeWithSelector(
                            VaultFactoryFacet.vaultWithdrawERC1155.selector,
                            loan.borrower,
                            loan.collateralAsset,
                            loan.collateralTokenId,
                            loan.collateralQuantity,
                            lenderVault
                        ),
                        VaultWithdrawFailed.selector
                    );
                }
                LibSanctionedLock.endMoveOut(s);

                // Record collateral claim for the lender
                s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
                    asset: loan.collateralAsset,
                    amount: loan.collateralAmount,
                    assetType: loan.collateralAssetType,
                    tokenId: loan.collateralTokenId,
                    quantity: loan.collateralQuantity,
                    claimed: false
                });
                // #592 (ReservationV2 §4.1) — in-kind/illiquid default: the
                // lender claim asset is the COLLATERAL, not the principal. VPFI
                // is collateral-eligible, so when the (ERC-20) collateral that
                // just landed in the stored lender's vault IS VPFI, reserve it
                // against the unstake path — keyed on the collateral asset, the
                // same asset ClaimFacet releases on (`claim.asset`). NFT
                // collateral can't be VPFI and has no fungible unstake door.
                if (
                    loan.collateralAssetType == LibVaipakam.AssetType.ERC20 &&
                    loan.collateralAsset == s.vpfiToken
                ) {
                    LibEncumbrance.encumberLenderProceeds(
                        loanId, loan.lender, loan.collateralAsset, loan.collateralAmount
                    );
                }

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
                    VaultFactoryFacet.vaultSetNFTUser.selector,
                    loan.lender,
                    loan.principalAsset,
                    loan.tokenId,
                    address(0),
                    0
                ),
                NFTRenterUpdateFailed.selector
            );

            // NFT stays in vault — returned to lender via ClaimFacet.claimAsLender
            // (NFT-gated: lender must own the Vaipakam position NFT to claim).

            // #821 (Codex #832 r3 P1) — both prepay withdrawals below pull from
            // the borrower's vault on the NFT-rental default. Arm the move-out
            // exemption so a borrower flagged after init doesn't brick the default
            // (the prepay is pushed OUT to the already-screened treasury / lender).
            LibSanctionedLock.beginMoveOut(s, loan.borrower);
            // Buffer to treasury immediately (no claim needed for treasury)
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
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

            // Withdraw full prepay from borrower vault
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    VaultFactoryFacet.vaultWithdrawERC20.selector,
                    loan.borrower,
                    loan.prepayAsset,
                    address(this),
                    loan.prepayAmount
                ),
                VaultWithdrawFailed.selector
            );
            LibSanctionedLock.endMoveOut(s);

            // Treasury fee from rental portion
            IERC20(loan.prepayAsset).safeTransfer(treasury, treasuryFee);
            LibFacet.recordTreasuryAccrual(loan.prepayAsset, treasuryFee);

            // Lender gets remainder. #821 — vault-lock for a flagged stored lender
            // (T-051 — the Diamond-side transfer ticks protocolTrackedVaultBalance).
            LibSanctionedLock.depositLocked(
                s, loan.lender, loanId, loan.prepayAsset, prepayToLender
            );

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
            // #407 PR 4 (T-407-B, 2026-06-12) — collateral lien release
            // moved to the START of `triggerDefault` (line ~207) so
            // the {VaultFactoryFacet.vaultWithdrawERC20} guard clears
            // for every mid-flow withdraw. See the explanatory
            // comment at the new call site.

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
        emit LoanDefaulted(loanId, loan.riskAndTermsConsentFromBoth, loan.status);
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
        uint256 graceEnd = endTime + LibVaipakam.loanGracePeriod(loan); // #641 — original-term grace
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
            uint256 treasuryPrincDue,
            bool oracleAvailable
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

        // §1.4 + §1.5 — informational events carry only the loanId primary
        // key. lender + split are recoverable from s.loans[loanId] and
        // s.fallbackSnapshot[loanId] respectively. The
        // {LiquidationFallbackOracleUnavailable} extra event (Phase 2
        // of AutonomousLtvAndOracleFallback.md) fires when the
        // fair-value split was impossible due to stale oracle quorum —
        // the lender absorbed everything in that case.
        emit LiquidationFallback(loanId);
        emit LiquidationFallbackSplit(loanId);
        if (!oracleAvailable) emit LiquidationFallbackOracleUnavailable(loanId);
    }

    /// @dev #407 PR 4 (T-407-B, 2026-06-12) — extracted from
    ///      `triggerDefault` so the lien-release lives in its own
    ///      scope. The inline call form (`LibEncumbrance.releaseCollateralLien(loanId)`
    ///      directly inside `triggerDefault`) tripped viaIR's
    ///      "Variable size 1 too deep" — `triggerDefault` already sits
    ///      near solc's stack ceiling (KYC value block + adapterCalls
    ///      calldata + swap math locals). Wrapping the release in a
    ///      private function gives it a fresh stack frame that
    ///      doesn't compete with the caller's locals.
    function _releaseLienAtDefault(uint256 loanId) private {
        LibEncumbrance.releaseCollateralLien(loanId);
    }
}
