// src/facets/RiskFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {SwapToRepayIntentFacet} from "./SwapToRepayIntentFacet.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibRiskMath} from "../libraries/LibRiskMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibInterestLedger} from "../libraries/LibInterestLedger.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibLenderYieldFeeHost} from "../libraries/LibLenderYieldFeeHost.sol";
import {LibERC721} from "../libraries/LibERC721.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibDiscountedLiquidation} from "../libraries/LibDiscountedLiquidation.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {NumeraireValueFacet} from "./NumeraireValueFacet.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
 // For NFT updates/burns
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
 // For transfers
import {ProfileFacet} from "./ProfileFacet.sol";
 // For KYC if high-value
 // For swap calldata encoding
import {LibSwap} from "../libraries/LibSwap.sol";
// Issue #66 — the internal-match liquidation cluster was extracted into
// its own facet to keep RiskFacet under the EIP-170 size limit; the
// HF-liquidation entry points here still dispatch through it.
import {RiskMatchLiquidationFacet} from "./RiskMatchLiquidationFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {FallbackCustodyFacet} from "./FallbackCustodyFacet.sol";
import {ForcedSaleFacet} from "./ForcedSaleFacet.sol";
import {LibInternalMatchPriority} from "../libraries/LibInternalMatchPriority.sol";
 // Phase 7a — ordered adapter failover for liquidation swaps

/**
 * @title RiskFacet
 * @author Vaipakam Developer Team
 * @notice Risk parameter management, LTV/Health-Factor calculations, and
 *         HF-triggered liquidation for the Vaipakam P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable
 *      (mutating paths only; views are always available).
 *
 *      Per-asset risk parameters (`AssetRiskParams`): the optional
 *      init-LTV ceiling `loanInitMaxLtvBps` and the optional liquidator
 *      incentive ceiling `liqBonusBps`, updatable by RISK_ADMIN_ROLE
 *      (`minPartialBps` is set through ConfigFacet). The per-asset
 *      liquidation threshold (#999) and reserve factor (#2696) are retired.
 *
 *      Formulas (liquid assets only; illiquid reverts NonLiquidAsset):
 *        LTV  = (borrowBalanceNumeraire × 10000) / collateralValueNumeraire  [BPS]
 *        HF   = (collateralNumeraire × liqThresholdBps / 10000) / borrowBalanceNumeraire  [1e18]
 *        borrowBalance = principal + accrued interest (pro-rata seconds-based).
 *      Prices sourced from {OracleFacet.getAssetPrice} — quoted in the
 *      active numeraire (USD by post-deploy default, governance-rotatable).
 *      The ratio cancels the unit, so HF and LTV are unit-agnostic.
 *
 *      Liquidation ({triggerLiquidation}): permissionless when HF < 1e18.
 *      The sale is the one forced-sale rule on {ForcedSaleFacet} (#2796):
 *      it sells only the collateral the debt needs (the least amount whose
 *      proceeds at the liquidation slippage cap cover the debt plus the
 *      largest charges, at the keeper's quoted amount), pays the keeper
 *      bonus, the lender's debt in full, the handling fee on the debt
 *      subordinated to the lender, and leaves the unsold collateral and the
 *      extra proceeds to the borrower's claim. When every adapter fails, it
 *      falls back to {FallbackCustodyFacet.enterFallback}: the full
 *      collateral goes back into the borrower's vault under the loan's lien
 *      (the fallback custody row, #1566 slice 2) until {ClaimFacet} retries
 *      or distributes the split (both through {FallbackCustodyFacet}).
 *
 *      Refresh together (#2796): {ForcedSaleFacet}, RiskFacet,
 *      RiskSplitLiquidationFacet, DefaultedFacet and RepayPeriodicFacet. The
 *      sale is a self-call into {ForcedSaleFacet.sellToNeed}; refreshing this
 *      facet without that one reverts `FunctionDoesNotExist` on every
 *      liquidation.
 *
 *      Refresh together (#1566 slice 2): {FallbackCustodyFacet}, RiskFacet,
 *      DefaultedFacet, ClaimFacet, AddCollateralFacet, RepayFacet and
 *      RiskMatchLiquidationFacet. The swap-failure fallback entry is a
 *      self-call into {FallbackCustodyFacet.enterFallback}; refreshing this
 *      facet without cutting that one leaves the selector unrouted, and
 *      every swap-failure liquidation reverts `FunctionDoesNotExist`.
 */
contract RiskFacet is DiamondReentrancyGuard, DiamondPausable, DiamondAccessControl, IVaipakamErrors {
    using SafeERC20 for IERC20;


    /// @notice Emitted when an asset's risk parameters are updated.
    /// @dev PR2 of internal-match work (2026-05-14) dropped
    ///      `liqThresholdBps` — the per-asset liquidation threshold
    ///      was retired in favour of per-tier
    ///      `ProtocolConfig.tier{1,2,3}LiquidationLtvBps` +
    ///      `Loan.liquidationLtvBpsAtInit` snapshot.
    ///      #2696 retired the per-asset reserve factor (nothing read it),
    ///      so the event no longer carries one.
    /// @param asset The asset address.
    /// @param loanInitMaxLtvBps New per-asset init-LTV ceiling in basis points.
    /// @param liqBonusBps New per-asset liquidator-incentive ceiling in basis points.
    /// @custom:event-category informational/config
    event RiskParamsUpdated(
        address indexed asset,
        uint256 loanInitMaxLtvBps,
        uint256 liqBonusBps
    );

    /// @notice #394 Lever A — emitted when governance retunes the runtime
    ///         loan-admission Health Factor floor.
    /// @param newMinHealthFactor The new admission floor (1e18-scaled).
    event MinHealthFactorSet(uint256 newMinHealthFactor);

    /// @notice Emitted when a liquidation is triggered via HF.
    /// @param loanId The ID of the liquidated loan.
    /// @param liquidator The caller who triggered.
    /// @param proceeds The recovered amount.
    /// @custom:event-category state-change/loan-mutation
    event HFLiquidationTriggered(
        uint256 indexed loanId,
        address indexed liquidator,
        uint256 proceeds
    );

    // Facet-specific errors (shared errors inherited from IVaipakamErrors)
    error InvalidLoan();
    error ZeroCollateral();
    error HealthFactorNotLow();
    /// @notice l2 sequencer is offline or still in its 1h recovery grace
    ///         window; HF-based liquidation is blocked to avoid swapping
    ///         against stale Chainlink / AMM state.
    error SequencerUnhealthy();

    // MAX_LIQUIDATION_SLIPPAGE_BPS consolidated in LibVaipakam

    // #1566 S2a: the three fallback-entry events below are emitted by
    // {FallbackCustodyFacet.enterFallback}, which re-declares them with
    // byte-identical signatures (same topic hashes). They stay declared here
    // so this facet's ABI, and every consumer decoding against it, keeps them.
    /// @notice Emitted when an HF-triggered liquidation falls back to the
    ///         claim-time settlement path because the DEX swap reverted or
    ///         exceeded the 6% slippage ceiling (README §7).
    /// @dev    Informational — the storage transition is captured in
    ///         {HFLiquidationTriggered} (and the FallbackSnapshot write).
    ///         Lender + collateral split are recoverable from
    ///         `s.loans[loanId].lender` and `s.fallbackSnapshot[loanId]`
    ///         respectively. EventSourcingAudit §1.4 + §1.5 — primary-
    ///         key-only payload; consumers query the table by loanId.
    /// @param loanId The liquidated loan ID.
    /// @custom:event-category informational/liquidation
    event LiquidationFallback(uint256 indexed loanId);

    /// @notice Emitted alongside {LiquidationFallback} with the README §7
    ///         three-way split.
    /// @dev    Informational — lender / treasury / borrower allocation is
    ///         stored verbatim in `s.fallbackSnapshot[loanId]`.
    ///         EventSourcingAudit §1.4 + §1.5 — primary-key-only payload.
    /// @param loanId The liquidated loan ID.
    /// @custom:event-category informational/liquidation
    event LiquidationFallbackSplit(uint256 indexed loanId);

    /// @notice Emitted when the HF-based liquidation fallback ran without
    ///         an oracle-quorum price — neither leg of the collateral /
    ///         principal pair had a fresh Phase-7b 2-of-N reading
    ///         available. The fallback degenerates to "full collateral
    ///         to lender claim, treasury + borrower zero" (the same
    ///         shape the existing depth-flow uses for genuinely
    ///         unpriceable assets), and this event fires ADDITIONALLY
    ///         to {LiquidationFallback}/{LiquidationFallbackSplit} so
    ///         downstream indexers + the audit-package can distinguish
    ///         "oracle worked, lender's claim exceeded collateral" from
    ///         "oracle quorum stale, fair-value split was impossible".
    /// @dev    Phase 2 of AutonomousLtvAndOracleFallback.md design. The
    ///         pre-Phase-2 behaviour reverted the whole liquidation when
    ///         oracle was stale; the new path lets the protocol settle
    ///         the loan (lender absorbs everything) so a stale-oracle
    ///         pair can't pin distressed loans in Active state.
    /// @custom:event-category informational/liquidation
    event LiquidationFallbackOracleUnavailable(uint256 indexed loanId);

    /// @notice Emitted on a successful partial HF-based liquidation that
    ///         left the loan Active with reduced collateral + principal.
    /// @dev    Indexer ingests this as a non-terminal mutation; the loan's
    ///         `LoanInitiated` event remains the canonical "opening"
    ///         record, and the terminal event (one of `HFLiquidationTriggered`,
    ///         `LoanRepaid`, `LoanDefaulted`) lands at the eventual close.
    ///         Multiple `LoanPartiallyLiquidated` may fire per loan if the
    ///         keeper restores HF≥1 by repeated partials.
    /// @param  loanId             The partially-liquidated loan.
    /// @param  liquidator         The caller (msg.sender). Receives the
    ///                            dynamic incentive bonus.
    /// @param  fractionBps        Fraction of remaining collateral swept,
    ///                            in BPS of the pre-call `collateralAmount`.
    ///                            Bounded by `(0, maxPartialLiquidationCloseFactorBps]`.
    /// @param  swappedCollateral  Absolute collateral-asset units swapped.
    /// @param  proceeds           Principal-asset units received from the
    ///                            keeper-supplied adapter try-list.
    /// @param  principalRepaid    Reduction applied to `loan.principal`.
    /// @param  interestRepaid     Interest portion paid through this partial
    ///                            (gross of treasury cut).
    /// @param  hfAfter            HF post-mutation. Guaranteed `>= HF_SCALE`.
    /// @custom:event-category state-change/loan-mutation
    event LoanPartiallyLiquidated(
        uint256 indexed loanId,
        address indexed liquidator,
        uint256 fractionBps,
        uint256 swappedCollateral,
        uint256 proceeds,
        uint256 principalRepaid,
        uint256 interestRepaid,
        uint256 hfAfter
    );

    /// @notice Partial fraction is zero, ≥ 10_000, or above the governance cap.
    error InvalidPartialFraction(uint256 fractionBps, uint256 capBps);
    /// @notice Partial swap left HF unchanged or worse — the keeper's
    ///         fraction was too small; pick a larger one or fall back to
    ///         {triggerLiquidation}.
    error PartialMustImproveHF(uint256 hfBefore, uint256 hfAfter);
    /// @notice Partial swap improved HF but it's still below 1.0 — the
    ///         loan would remain liquidatable, defeating the point of a
    ///         partial. Keeper picks a larger fraction or falls back to
    ///         full {triggerLiquidation}.
    error PartialMustRestoreHF(uint256 hfAfter);
    /// @notice #395 — a routine partial over-liquidated: it left the borrower
    ///         above the governance target-HF ceiling without being in a
    ///         deep-underwater or dust-residual escalation case. Sizing must
    ///         stay "as much as needed" — the keeper picks a smaller fraction.
    error PartialOverLiquidates(uint256 hfAfter, uint256 ceiling);
    /// @notice #395 (Codex r3 P2) — a within-band partial would leave a fresh
    ///         dust position (both residual debt AND collateral below the
    ///         configured dust floor) out of a non-dust loan. The keeper must
    ///         use full liquidation instead of stranding an un-liquidatable
    ///         scrap as an Active loan. Both residuals are 1e18-scaled
    ///         numeraire values (#2419), on the dust floor's scale.
    error PartialLeavesDust(uint256 residualDebt, uint256 residualCollateral);
    /// @notice Partial swap proceeds were large enough to retire all
    ///         outstanding principal — at that point the loan is no
    ///         longer "partially" anything, the keeper should be using
    ///         {triggerLiquidation} (failover) or {triggerLiquidationSplit}.
    error PartialFullyClosedUseFull();
    /// @notice Partial is only meaningful in-term; past maturity, the
    ///         time-based path (`DefaultedFacet.markDefaulted`) or
    ///         full {triggerLiquidation} are the right tools. Excludes
    ///         late-fee accounting from the partial path.
    error PartialAfterMaturity(uint256 endTime, uint256 nowTs);
    /// @notice All adapters in the keeper's try-list reverted. Unlike
    ///         {triggerLiquidation}'s soft-fallback to a claim-time
    ///         settlement, partial liquidation cannot leave the loan in
    ///         a half-settled-but-Active state — the only safe move on
    ///         total swap failure is to revert and let the keeper retry
    ///         (smaller fraction, different adapter mix, or full
    ///         {triggerLiquidation}).
    error PartialSwapAllFailed();

    /// @notice #2731 — the slice's proceeds, after its charges, do not cover
    ///         the interest accrued on the loan's current segment. A partial
    ///         liquidation restarts the accrual clock, so it must pay that
    ///         interest in full; sell a larger slice or liquidate in full.
    error PartialMustCoverInterest(uint256 repaid, uint256 interestDue);

    // ─── FlashLoanLiquidationPath.md — discount-path declarations ─────

    /// @notice Emitted at the end of every successful
    ///         {triggerLiquidationDiscounted} call. The keeper bot +
    ///         off-chain monitoring listen on this so a discount-path
    ///         settlement is publicly observable. The (tier, discountBps)
    ///         pair plus the (totalDebt, collateralSeized) pair fully
    ///         reconstruct the trade's oracle-priced economics. The
    ///         `borrowerSurplus` is collateral-asset units, NOT principal.
    /// @custom:event-category state-change/loan-mutation
    event LiquidationDiscounted(
        uint256 indexed loanId,
        address indexed liquidator,
        address indexed recipient,
        uint8 tier,
        uint16 discountBps,
        uint256 totalDebt,
        uint256 collateralSeized,
        uint256 borrowerSurplus
    );

    /// @notice The discount-path master kill-switch
    ///         (`ProtocolConfig.discountPathEnabled`) is `false`. A
    ///         fresh deploy ships this off; governance flips it on
    ///         per chain after audit sign-off. Independent of the
    ///         depth-tiered-LTV kill-switch.
    error DiscountPathDisabled();

    /// @notice The collateral recipient is the zero address. The
    ///         discount path must hand the seized collateral to a
    ///         non-zero address so a typo can't burn the funds.
    error ZeroRecipient();

    /// @notice The loan's collateral asset isn't tier-classified
    ///         (effective tier == 0 — neither the on-chain depth probe
    ///         nor the keeper-relayed tier qualifies it). The discount
    ///         math is per-tier; an unclassified collateral can't be
    ///         priced under this path. Use {triggerLiquidation} for
    ///         Liquid-but-unclassified assets, or wait for time-based
    ///         default for Illiquid ones.
    error UntierableCollateral(address asset);

    /// @notice Oracle quorum unavailable for one or both legs at
    ///         settlement time — `LibFallback.collateralEquivalent`
    ///         reported the pair unpriced, meaning there is no price for
    ///         the principal or collateral asset. (A distrusted price
    ///         refuses by its own read's divergence error,
    ///         `OraclePriceDivergence` or `OracleCrossCheckDivergence`,
    ///         #666.) The discount math
    ///         requires both legs priced. The liquidator can retry
    ///         once the oracle clears, or fall back to
    ///         {triggerLiquidation} which has its own oracle-stale
    ///         fallback to a claim-time settlement.
    error OracleStaleForDiscount(address principalAsset, address collateralAsset);

    /**
     * @notice Updates risk parameters for an asset.
     * @dev RISK_ADMIN_ROLE (the Timelock after the handover). Validates
     *      params. Emits RiskParamsUpdated.
     *
     *      NOT pause-gated (#945, owner decision 2026-10-23): a Diamond
     *      stays paused from its birth until the launch step, so risk limits
     *      must be settable while paused or a chain would launch with none.
     *      The pause guards user-facing entry points; this is a governance
     *      setter whose role check carries the Timelock delay.
     *
     *      PR2 of the internal-match work (2026-05-14) retired the
     *      per-asset `liqThresholdBps`. The liquidation threshold is
     *      now per-tier (configured via
     *      `ConfigFacet.setTierLiquidationLtvBps`) and snapshotted to
     *      each loan at `initiateLoan` onto `Loan.liquidationLtvBpsAtInit`.
     *      Both values are OPTIONAL tightenings (#2696). An asset nobody has
     *      configured is not refused: it has no per-asset LTV ceiling (the
     *      tier cap or the admission health-factor floor binds; see
     *      {LibVaipakam.assetInitLtvCeilingBps}) and no per-asset incentive
     *      ceiling. #2696 also retired the per-asset reserve factor, which no
     *      fee path ever read; the interest treasury cut is the per-loan
     *      treasury fee.
     * @param asset The asset address (collateral/lending).
     * @param loanInitMaxLtvBps Per-asset init-LTV ceiling in bps (e.g., 8000 for 80%).
     *        Bounded to [RISK_PARAMS_MAX_LTV_BPS_MIN, BASIS_POINTS]; `BASIS_POINTS`
     *        is the same as no ceiling.
     * @param liqBonusBps Per-asset ceiling on the dynamic liquidator incentive, in bps.
     *        Must be ≤ MAX_LIQUIDATOR_INCENTIVE_BPS (300 = 3%). The runtime incentive is
     *        still computed as `6% − realized slippage%` capped at 3%; this value only
     *        lets governance tighten that cap further per asset. `0` = no per-asset cap.
     */
    function updateRiskParams(
        address asset,
        uint256 loanInitMaxLtvBps,
        uint256 liqBonusBps
    ) external onlyRole(LibAccessControl.RISK_ADMIN_ROLE) {
        if (asset == address(0)) revert InvalidAsset();
        // Setter-range audit (2026-05-02): bounded floor on the LTV
        // ceiling. Previously maxLtv was only `> 0`, which allowed a
        // degenerate `1`-bp setting that disables borrowing for the
        // asset; surfaced via `ParameterOutOfRange`.
        if (
            loanInitMaxLtvBps < LibVaipakam.RISK_PARAMS_MAX_LTV_BPS_MIN ||
            loanInitMaxLtvBps > LibVaipakam.BASIS_POINTS
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "loanInitMaxLtvBps",
                loanInitMaxLtvBps,
                uint256(LibVaipakam.RISK_PARAMS_MAX_LTV_BPS_MIN),
                LibVaipakam.BASIS_POINTS
            );
        }
        // README §3: liquidator incentive is dynamic (6% − realized slippage)
        // and capped at 3% of liquidation proceeds. The stored `liqBonusBps`
        // is a legacy ceiling and must never be configured above that cap.
        if (liqBonusBps > LibVaipakam.cfgMaxLiquidatorIncentiveBps()) revert UpdateNotAllowed();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RiskParams storage params = s.assetRiskParams[asset];
        params.loanInitMaxLtvBps = loanInitMaxLtvBps;
        params.liqBonusBps = liqBonusBps;

        emit RiskParamsUpdated(asset, loanInitMaxLtvBps, liqBonusBps);
    }

    /**
     * @notice #394 Lever A — retune the runtime loan-ADMISSION Health Factor
     *         floor (the non-tiered init gate + every restore/maintain/preview
     *         HF check). This is the protocol's per-deploy risk-appetite knob:
     *         tighten it in a volatile regime, loosen it for a proven-safe
     *         book — WITHOUT a contract redeploy.
     * @dev    Range-bounded to `[MIN_ADMISSION_HEALTH_FACTOR,
     *         MAX_ADMISSION_HEALTH_FACTOR]` (1.2e18 … 2.0e18); the default
     *         (unset) is `MIN_HEALTH_FACTOR` (1.5e18). RISK_ADMIN_ROLE-gated,
     *         same as {updateRiskParams}, and like it NOT pause-gated so
     *         the floor can be set before launch (#945). The optimistic delta+cooldown
     *         "risk-steward" machinery is intentionally deferred to the
     *         governance card (#404) — this ships the bounded direct setter.
     *
     *         Deliberately does NOT touch the *liquidation* trigger
     *         (`HF_LIQUIDATION_THRESHOLD`, 1e18) or the tiered-regime init
     *         floor (also 1e18) — only the admission floor moves. Because the
     *         floor is range-bounded ≥ 1.2e18 (> the 1e18 liquidation
     *         trigger), an admitted loan can never be born already
     *         liquidatable, in either regime. The new floor applies only to
     *         loans admitted AFTER the change — open loans were gated at their
     *         own admission time and are never retro-checked (ethos E2).
     * @param newMinHealthFactor The new admission floor, 1e18-scaled.
     */
    function setMinHealthFactor(
        uint256 newMinHealthFactor
    ) external onlyRole(LibAccessControl.RISK_ADMIN_ROLE) {
        if (
            newMinHealthFactor < LibVaipakam.MIN_ADMISSION_HEALTH_FACTOR ||
            newMinHealthFactor > LibVaipakam.MAX_ADMISSION_HEALTH_FACTOR
        ) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "minHealthFactor",
                newMinHealthFactor,
                LibVaipakam.MIN_ADMISSION_HEALTH_FACTOR,
                LibVaipakam.MAX_ADMISSION_HEALTH_FACTOR
            );
        }
        // Fits uint64 by construction: the ceiling 2.0e18 < ~18.4e18.
        LibVaipakam.storageSlot().minHealthFactorOverride = uint64(newMinHealthFactor);
        emit MinHealthFactorSet(newMinHealthFactor);
    }

    /// @notice #394 Lever A — the live loan-admission Health Factor floor
    ///         (1e18-scaled). Returns the `MIN_HEALTH_FACTOR` default when no
    ///         override has been set.
    function getMinHealthFactor() external view returns (uint256) {
        return LibVaipakam.minHealthFactor();
    }

    /**
     * @notice Calculates the current LTV for a loan in basis points.
     * @dev LTV = (borrowedValueNumeraire * 10000) / collateralValueNumeraire.
     *      The numeraire unit cancels in the ratio — LTV is unit-agnostic.
     *      Reverts if collateral illiquid (NonLiquidAsset).
     *      Uses Oracle for prices.
     *      For Vaipakam Phase 1 single-asset; expand for multi.
     * @param loanId The loan ID.
     * @return ltv The LTV in basis points (e.g., 7500 for 75%).
     */
    // forge-lint: disable-next-line(mixed-case-function)
    function calculateLTV(uint256 loanId) public view returns (uint256 ltv) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.id == 0 || loan.collateralAmount == 0) revert InvalidLoan();

        // Explicit revert for illiquid — HF/LTV requires prices for both assets
        if (loan.collateralLiquidity != LibVaipakam.LiquidityStatus.Liquid ||
            loan.principalLiquidity != LibVaipakam.LiquidityStatus.Liquid)
            revert IlliquidLoanNoRiskMath();

        (uint256 borrowedValueNumeraire, uint256 collateralValueNumeraire) = _computeNumeraireValues(loan);
        if (collateralValueNumeraire == 0) revert ZeroCollateral();

        // The final division rounds DOWN, by under 1 BPS. Both legs are
        // 1e18-scaled (#2419) with the debt rounded up and the collateral
        // down, so the legs themselves already err toward the lender. Do
        // NOT change this division to ceilDiv without retuning the
        // `maxLTVBps` thresholds.
        ltv = LibRiskMath.ltvBps(borrowedValueNumeraire, collateralValueNumeraire);
    }

    /**
     * @notice Calculates the Health Factor (HF) for a loan.
     * @dev HF = (collateralValueNumeraire * liqThresholdBps / 10000) / currentBorrowBalanceNumeraire; scaled to 1e18.
     *      The numeraire unit cancels in the ratio — HF is unit-agnostic.
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
            revert IlliquidLoanNoRiskMath();

        (uint256 borrowValueNumeraire, uint256 collateralValueNumeraire) = _computeNumeraireValues(loan);


        // PR2 of internal-match work: per-asset `liqThresholdBps` was
        // retired. HF now reads the snapshotted per-tier liquidation
        // threshold from the loan itself (`liquidationLtvBpsAtInit`),
        // so tier degradation mid-loan never re-gates existing loans.
        uint256 liqThresholdBps = uint256(loan.liquidationLtvBpsAtInit);
        // Rounds DOWN on both steps — HF is slightly under-reported, which
        // means liquidation may trigger marginally earlier than theoretical.
        // Lender-favourable (the safe direction), as are the legs: debt
        // rounded up, collateral down, both at 1e18 precision (#2419). The
        // error is a few units of the last digit of HF_SCALE. No borrow
        // reads as an infinite HF. One rule, full precision:
        // {LibRiskMath.healthFactor}.
        healthFactor = LibRiskMath.healthFactor(
            collateralValueNumeraire, liqThresholdBps, borrowValueNumeraire
        );
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
            revert IlliquidLoanNoRiskMath();

        // Single-pass: fetch prices + decimals once and derive both LTV and
        // HF from the shared (borrowNumeraire, collateralNumeraire) pair.
        (uint256 borrowValueNumeraire, uint256 collateralValueNumeraire) = _computeNumeraireValues(loan);
        if (collateralValueNumeraire == 0) revert ZeroCollateral();

        uint256 ltv = LibRiskMath.ltvBps(borrowValueNumeraire, collateralValueNumeraire);

        // PR2 of internal-match work: read snapshotted per-tier
        // liquidation threshold from the loan instead of the retired
        // per-asset `liqThresholdBps`. Same rule as {calculateHealthFactor}.
        uint256 hf = LibRiskMath.healthFactor(
            collateralValueNumeraire,
            uint256(loan.liquidationLtvBpsAtInit),
            borrowValueNumeraire
        );

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
     *      Requires KYC for liquidator if bonusNumeraire > threshold.
     *      Updates loan to Defaulted, marks NFTs Claimable.
     *      Emits HFLiquidationTriggered on success, LiquidationFallback on fallback.
     * @param loanId The loan ID to liquidate.
     */

    /// @dev #658 — single-copy bridge to the cross-facet eager-consolidation
    ///      entry. RiskFacet sits ~347 bytes under EIP-170, so it CANNOT inline
    ///      `LibConsolidation.consolidateToHolder`; instead every liquidation
    ///      entry calls this one private helper (one `crossFacetCall` body,
    ///      compiled once) which routes both sides through
    ///      {ConsolidationFacet.eagerConsolidateBothSides} (Tier2 skip-not-block,
    ///      internal-only). Each entry-point call site is then a cheap internal
    ///      jump, keeping the facet under the limit. `bytes4(0)` bubbles a
    ///      genuine move revert raw (consistent with the direct hooks in
    ///      RepayFacet / DefaultedFacet).
    function _eagerConsolidateBothSides(uint256 loanId) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.eagerConsolidateBothSides.selector,
                loanId
            ),
            bytes4(0)
        );
    }

    /**
     * @notice Liquidate an Active loan whose Health Factor is below 1 by
     *         selling only the collateral its debt needs.
     * @param loanId       The loan.
     * @param sellAmount   The collateral amount the try-list's quotes were
     *                     built for. Must lie between
     *                     `previewForcedSale(loanId, HealthFactorLiquidation)`'s
     *                     `sell` and `maxSell` at the settling block, else the
     *                     call reverts `ForcedSaleQuoteOutOfRange` and nothing
     *                     moves (quote again). Ignored when an internal match
     *                     settles the loan instead.
     * @param adapterCalls Keeper-ranked swap try-list, best first.
     */
    function triggerLiquidation(
        uint256 loanId,
        uint256 sellAmount,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 layer 2 — if a v1.1 intent commit
        // is live, force-cancel it (return collateral + clear
        // state + emit `SwapToRepayIntentForceCancelled`) when
        // HF < `HF_LIQUIDATION_THRESHOLD`; otherwise revert
        // `IntentPending` so the borrower keeps the 5min + 24h
        // window. No-op when no commit is live.
        // Inline storage pre-check so this entry point stays callable on
        // diamonds that haven't cut `SwapToRepayIntentFacet` (the
        // scenario suite + other diamond test harnesses that select
        // facets a la carte). When no v1.1 intent commit is live for
        // this loan, the cross-facet call is skipped entirely and we
        // proceed straight to the standard liquidation flow.
        if (LibVaipakam.storageSlot().intentCommits[loanId].orderHash != bytes32(0)) {
            SwapToRepayIntentFacet(address(this)).forceCancelIntentFor(
                loanId, SwapToRepayIntentFacet.ForceCancelReason.HFBelowLiquidationThreshold
            );
        }
        // Tier-1 sanctions gate. The 3% liquidator bonus flows to
        // msg.sender — value receipt by a sanctioned wallet, blocked.
        // Anyone unflagged can still call this; liquidation is not
        // denied, just denied to sanctioned bots / liquidators.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert InvalidLoan();

        // #1005 (S9) — a forced liquidation must attempt at least one enabled
        // swap route before it can route into the full-collateral fallback.
        // `LibSwap.swapWithFailover` reverts `NoEnabledSwapRoute` when the
        // try-list is empty or every entry is a governance-disabled venue (so a
        // permissionless caller can't push an eligible loan into FallbackPending
        // with zero DEX attempts), rolling back the collateral withdrawal below.

        // T-086 step 10 — clear any live prepay listing FIRST so
        // the borrower-position NFT is unlocked + the diamond /
        // vault / executor bookkeeping is consistent before this
        // facet starts moving collateral. Idempotent no-op when
        // no listing is live. See design doc §5.4.
        s; // suppress unused-storage warning; the library reads it.
        LibPrepayCleanup.clearActiveListing(loan, loanId);

        // l2 circuit breaker: block HF-based liquidation when the sequencer
        // is down or still in the 1h grace window. Chainlink prices and
        // AMM pools may be stale under those conditions, so a swap here
        // would execute against mispriced state and either cross heavy
        // slippage or unfairly punish the borrower. Time-based defaults
        // (DefaultedFacet) also revert while the sequencer is unhealthy
        // (its own sequencer-health gate) rather than transferring collateral.
        if (!OracleFacet(address(this)).sequencerHealthy()) {
            revert SequencerUnhealthy();
        }

        // HF-based liquidation always requires HF < 1. Time-based defaults are handled
        // separately in DefaultedFacet. Without this guard, healthy loans become
        // permissionlessly liquidatable once the grace period passes.
        uint256 hf = RiskFacet(address(this)).calculateHealthFactor(loanId);
        if (hf >= LibVaipakam.HF_SCALE) revert HealthFactorNotLow();

        // #658 — HF-liquidation is a BOTH-SIDE close-out: it pays the lender and
        // returns any surplus to the borrower. Consolidate each transferred
        // side to its current holder BEFORE the internal-match dispatch + swap
        // settlement below, so proceeds/surplus route correctly.
        _eagerConsolidateBothSides(loanId);

        // ── EC-003 Phase 3 — internal-match auto-dispatch ──────────────
        // Before falling through to the external-aggregator swap, check
        // whether an opposing-direction internal-match candidate exists.
        // If yes, settle at oracle price (no DEX slippage), pay the 1%
        // matcher bonus to `msg.sender`, and return. The caller is the
        // de-facto matcher — same incentive shape that
        // `triggerInternalMatchLiquidation` always had, just without
        // requiring the caller to know which entry-point to pick.
        //
        // The priority-window revert below becomes a defensive no-op
        // — if a candidate existed AND it passed the view's gates,
        // auto-dispatch already fired. If we reach the revert it means
        // either the candidate failed mid-flight or there was no
        // candidate to begin with; the revert preserves the original
        // B.2 semantic ("don't dump into the external book mid-window")
        // for that defensive edge.
        if (RiskMatchLiquidationFacet(address(this)).attemptInternalMatchAutoDispatch(loanId, msg.sender)) {
            return;
        }

        // From here down we're on the external-aggregator swap branch. The
        // collateral lien stays live: the forced-sale host lowers it by
        // exactly what it sells (#2796), so the collateral the sale leaves
        // stays protected in the borrower's vault until their claim. An
        // internal-match auto-dispatch above owned its own lien adjustment.

        // ── Internal-match priority window (B.2 / PR4) ─────────────────
        // The auto-dispatch above found no internal match, so the window
        // rule decides whether the external swap may run now. One rule for
        // every external route ({LibInternalMatchPriority}, #2734).
        LibInternalMatchPriority.requireOutside(loanId, loan);

        // Execution routing (README §1): HF-based liquidation requires the
        // collateral to be swappable on the live network. If the active-
        // network liquidity check fails, revert — the time-based default
        // path in DefaultedFacet handles unswappable collateral via the
        // full-collateral-transfer branch.
        LibVaipakam.LiquidityStatus liquidity = OracleFacet(address(this))
            .checkLiquidityOnActiveNetwork(loan.collateralAsset);
        if (liquidity != LibVaipakam.LiquidityStatus.Liquid)
            revert NonLiquidAsset();

        // #2796 — the forced-sale host sizes the sale to the debt (the least
        // collateral whose worst-case proceeds cover the debt plus the
        // largest charges, at the keeper's quoted `sellAmount`), lowers the
        // lien by it, pulls it under the move-out exemption (#821: a borrower
        // flagged after init never bricks the liquidation), sells it through
        // the caller-ranked failover, and divides the proceeds: keeper bonus,
        // the lender's debt in full, the 2% handling fee on the debt
        // subordinated to the lender, and the rest held for the borrower
        // beside the collateral the sale did not take. When every route fails
        // it returns `sold = false` with the whole collateral on the Diamond,
        // and the loan enters the fallback exactly as before (#1005: an empty
        // or all-disabled try-list reverts `NoEnabledSwapRoute` instead).
        ForcedSaleFacet.ForcedSaleOutcome memory out =
            _sellToNeed(loanId, sellAmount, adapterCalls);
        if (!out.sold) {
            _enterFallback(loanId);
            return;
        }

        // Tiered KYC check for liquidator based on bonus value (README §16).
        _assertLiquidatorKyc(loan.principalAsset, out.keeperBonus);

        // Close loan — liquidation is triggered only from Active (HF < 1.0).
        // #1132 (S10 central enforcement) — route through the
        // `EncumbranceMutateFacet.terminalize` host so the validated Active→Defaulted
        // transition AND both holders' fail-closed frozen-claimant markers land
        // in one place (the per-branch standalone registers above were folded here).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.terminalize.selector,
                loanId,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Defaulted
            ),
            bytes4(0)
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

        emit HFLiquidationTriggered(loanId, msg.sender, out.proceeds);
    }


    /**
     * @notice HF-restoring **partial** liquidation — the higher-LTV-aware
     *         third sibling of {triggerLiquidation} (single-route failover)
     *         and {triggerLiquidationSplit} (multi-route atomic split).
     *         Sweeps only `fractionBps` of the loan's remaining collateral,
     *         applies the swap proceeds to accrued-interest + principal,
     *         and **leaves the loan Active with reduced size and the same
     *         maturity date**. The loan keeps accruing interest on the
     *         reduced principal from this moment forward.
     *
     * @dev    Use case — under the depth-tiered-LTV regime, a single
     *         large swap can exceed the 6% slippage ceiling on long-tail
     *         collateral even when a smaller fraction would clear cleanly.
     *         The keeper computes the smallest `fractionBps` that brings
     *         HF >= 1 (typically with a small safety buffer) and submits
     *         that fraction here, saving the borrower from full
     *         liquidation while still restoring protocol solvency.
     *
     *         Hard guards:
     *
     *         - HF must be `< 1e18` at entry (same as full liquidation).
     *         - Block time must be `< endTime` (in-term only). Past
     *           maturity, late fees are due and the right tool is
     *           {triggerLiquidation} or `DefaultedFacet.markDefaulted`
     *           — partial deliberately excludes late-fee accounting
     *           from its math.
     *         - `fractionBps` in `(0, maxPartialLiquidationCloseFactorBps]`
     *           (default cap 10_000 = 100%; governance may tighten).
     *         - HF strictly improves AND lands `>= 1e18` after mutation.
     *           Reverts otherwise — the keeper picks a larger fraction or
     *           falls back to full.
     *         - Principal can't be fully retired through partial; if the
     *           proceeds would zero out `loan.principal`, reverts with
     *           {PartialFullyClosedUseFull} — that's a job for
     *           {triggerLiquidation} which closes the loan, returns
     *           surplus collateral to the borrower, and emits the
     *           terminal event.
     *
     *         Failure path: unlike {triggerLiquidation}, there is no
     *         soft-failure "fall back to a claim-time settlement"
     *         branch. A still-Active loan can't be in a half-settled
     *         state without corrupting the {ClaimFacet} / NFT-state
     *         invariants. On any internal failure (all adapters revert,
     *         HF didn't improve, principal fully repaid) the entire tx
     *         reverts and the slice stays in the borrower's vault.
     *
     *         Maturity preservation: the loan's `endTime`, `startTime`, and
     *         `durationDays` are all UNCHANGED (the #641 pattern — ~20+
     *         maturity/grace consumers treat `startTime + durationDays` as the
     *         fixed maturity). Implementation re-stamps ONLY the interest-accrual
     *         clock (`interestAccrualStart`/`interestRemainingDays`); from now on
     *         interest accrues on the reduced principal for the remaining term.
     *
     *         Repeated partials: a loan may be partial-liquidated multiple
     *         times. Each call further reduces collateral + principal,
     *         restarts the interest clock, and emits a fresh
     *         {LoanPartiallyLiquidated}. The terminal event is whichever
     *         close-out path eventually fires.
     *
     *         Interaction rewards: NOT settled here — the loan is still
     *         alive, so `LibInteractionRewards.closeLoan` does NOT fire. It
     *         runs at the eventual terminal event.
     *
     *         NFTs: stay Active (the borrower and lender position NFTs
     *         continue to represent the now-smaller position).
     *
     * @param  loanId       The loan being partially liquidated. Must be
     *                      Active with HF < 1, in-term.
     * @param  fractionBps  Fraction of remaining collateral to sweep,
     *                      in BPS. `(0, maxPartialLiquidationCloseFactorBps]`.
     * @param  adapterCalls Keeper-supplied ranked adapter try-list for
     *                      the slice swap, best-first by expected output.
     *                      Same shape as {triggerLiquidation}.
     */
    function triggerPartialLiquidation(
        uint256 loanId,
        uint256 fractionBps,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 layer 2 — see `triggerLiquidation`.
        // Inline storage pre-check so this entry point stays callable on
        // diamonds that haven't cut `SwapToRepayIntentFacet` (the
        // scenario suite + other diamond test harnesses that select
        // facets a la carte). When no v1.1 intent commit is live for
        // this loan, the cross-facet call is skipped entirely and we
        // proceed straight to the standard liquidation flow.
        if (LibVaipakam.storageSlot().intentCommits[loanId].orderHash != bytes32(0)) {
            SwapToRepayIntentFacet(address(this)).forceCancelIntentFor(
                loanId, SwapToRepayIntentFacet.ForceCancelReason.HFBelowLiquidationThreshold
            );
        }
        // Tier-1 sanctions gate — the dynamic incentive bonus flows to
        // msg.sender, so value-receipt blocked for sanctioned addresses.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert InvalidLoan();

        // Sequencer / HF / liquidity gates — identical to {triggerLiquidation}.
        if (!OracleFacet(address(this)).sequencerHealthy()) {
            revert SequencerUnhealthy();
        }
        uint256 hfBefore = RiskFacet(address(this)).calculateHealthFactor(loanId);
        if (hfBefore >= LibVaipakam.HF_SCALE) revert HealthFactorNotLow();

        // #658 — partial liquidation pays the lender a slice and may return a
        // borrower surplus; consolidate both transferred sides to their current
        // holders before the slice settlement. hfBefore is already captured
        // above and the move doesn't change the HF inputs (loan.collateralAmount
        // / principal), so the #395 sizing math is unaffected.
        _eagerConsolidateBothSides(loanId);

        // In-term gate — partial is a "before maturity" tool. Once the
        // loan matures, late fees apply and the cleaner close-out is
        // full liquidation or time-based default. Excludes late-fee
        // accounting from this path entirely (safe simplification).
        uint256 endTime = LibLoanClock.maturity(loan);
        if (block.timestamp >= endTime) {
            revert PartialAfterMaturity(endTime, block.timestamp);
        }

        LibVaipakam.LiquidityStatus liquidity = OracleFacet(address(this))
            .checkLiquidityOnActiveNetwork(loan.collateralAsset);
        if (liquidity != LibVaipakam.LiquidityStatus.Liquid)
            revert NonLiquidAsset();

        // #395 (Codex r3 P2) — preserve internal-match priority: a keeper
        // must not use the partial route to sell collateral externally
        // mid-window. A partial does NOT itself auto-dispatch; it just
        // declines inside the window ({LibInternalMatchPriority}, #2734).
        LibInternalMatchPriority.requireOutside(loanId, loan);

        // Fraction bounds: (0, cap]. cap is governance-tunable, default
        // 10_000 (no cap — keeper picks the smallest fraction that
        // restores HF >= 1).
        uint256 cap = LibVaipakam.cfgMaxPartialLiquidationCloseFactorBps();
        if (fractionBps == 0 || fractionBps > cap) {
            revert InvalidPartialFraction(fractionBps, cap);
        }

        // Slice the collateral. Rounds DOWN to favour the borrower at the
        // wei boundary — same convention as the rest of the protocol.
        uint256 swappedCollateral = (loan.collateralAmount * fractionBps)
            / LibVaipakam.BASIS_POINTS;
        if (swappedCollateral == 0) {
            // Defensive: tiny `collateralAmount` × small `fractionBps`
            // can round to zero. A zero swap proves nothing — flag it
            // back so the keeper picks a larger fraction.
            revert InvalidPartialFraction(fractionBps, cap);
        }

        // #407 PR 4 round-1 Codex P1 #1 (2026-06-12) — decrement the
        // lien by the slice we're moving out. Loan stays Active after
        // the slice swap, so full release would leave the residual
        // collateral unprotected from other ERC20 withdraw surfaces.
        _decrementLienAtPartialLiq(loanId, swappedCollateral);

        // Withdraw only the slice from the borrower's vault. If the
        // swap reverts downstream, the wrapping `revert` here unwinds
        // the withdraw too (single tx, all storage rolled back) — no
        // manual refund needed. #821 (Codex #832 r3 P1) — move-out-exempt so a
        // borrower flagged after init doesn't brick the partial liquidation
        // (collateral pushed OUT to screened swap recipients).
        // #2440 — a forced close-out acts on what arrived: the vault gives up
        // the whole slice (its tracked balance and the loan's collateral fall
        // by `swappedCollateral`), and the quote and the sale use what reached
        // the Diamond, so a short delivery is never made up from the Diamond's
        // other balance.
        uint256 sliceReceived = LibSanctionedLock.pullToDiamond(
            LibVaipakam.storageSlot(),
            loan.borrower,
            loan.collateralAsset,
            swappedCollateral
        );
        // Oracle-derived expected proceeds + slippage floor, scoped to
        // the slice. Same formula as {triggerLiquidation}.
        uint256 expectedProceeds = LibFallback.expectedSwapOutput(
            address(this),
            loan.collateralAsset,
            loan.principalAsset,
            sliceReceived
        );
        uint256 maxSlippageBps = LibVaipakam.cfgMaxLiquidationSlippageBps();
        uint256 minOutputAmount = (expectedProceeds *
            (LibVaipakam.BASIS_POINTS - maxSlippageBps)) /
            LibVaipakam.BASIS_POINTS;

        // Partial uses failover (single best adapter). The slice is
        // smaller than a full liquidation by construction, so a single
        // venue is much more likely to absorb it cleanly. If the keeper
        // wants sub-slice splitting, the right move is to first reduce
        // the fraction; a "split-of-a-partial" entry point doesn't pay
        // for itself given the gas cost.
        (bool swapSuccess, uint256 proceeds, ) = LibSwap.swapWithFailover(
            loanId,
            loan.collateralAsset,
            loan.principalAsset,
            sliceReceived,
            minOutputAmount,
            address(this),
            adapterCalls
        );
        if (!swapSuccess) revert PartialSwapAllFailed();

        // Debt accounting at partial time. Late fee = 0 by the in-term
        // guard above. The segment's interest is the gross accrual less the
        // periodic credit already forwarded to the lender (`interestSettled`);
        // credit beyond the accrual carries to the residual loan (#2731).
        (uint256 interestPortion, uint256 settledCarried) =
            LibEntitlement.splitSettledInterest(loan, LibEntitlement.grossBorrowInterest(loan));

        // #2796 — the charges are on what the slice REPAYS, not on the
        // proceeds beside it: `repaid = ⌊P·BPS / (BPS + b + f)⌋`, bonus
        // `b·repaid`, fee the rest (≈ `f·repaid`, rounding to the treasury).
        // So the lender always receives `repaid` and the charges together are
        // at most `(f + bMax)·repaid` — the handling fee can no longer come
        // out of the lender's share. `b` is the same execution-quality curve
        // as the full liquidation ({LibEntitlement.liquidatorIncentiveBps}).
        (uint256 afterFees, uint256 bonus, uint256 handlingFee) = LibEntitlement.chargesOnRepaid(
            proceeds,
            LibEntitlement.liquidatorIncentiveBps(loan.collateralAsset, proceeds, expectedProceeds),
            LibVaipakam.cfgLiquidationHandlingFeeBps()
        );

        // Tiered-KYC for the liquidator — identical to {triggerLiquidation}.
        // The smaller slice means a smaller bonus, less likely to trip
        // the KYC numeraire threshold, but we apply the same check
        // uniformly for predictable bot behaviour.
        _assertLiquidatorKyc(loan.principalAsset, bonus);

        if (bonus > 0) {
            // #2440 — outcome 3, as in {triggerLiquidation}.
            LibDelivery.pushOut(loan.principalAsset, msg.sender, bonus);
        }

        // The repaid amount goes to the debt in order: interest first
        // (treasury cut on it via splitTreasury), then principal. NO
        // late fee — guaranteed zero by the in-term guard.
        //
        // #2731 — the slice must pay the segment's interest in full. The
        // accrual clock restarts below, so interest a short slice left unpaid
        // would be forgiven: the lender would lose it and the health factor
        // would rise by debt that was written off, not repaid. A keeper turned
        // away here sells a larger slice or liquidates in full.
        // So the interest repaid is exactly `interestPortion`.
        if (afterFees < interestPortion) revert PartialMustCoverInterest(afterFees, interestPortion);
        (uint256 treasuryInterestFee, ) = LibEntitlement.splitTreasury(loan, interestPortion);
        uint256 principalRepaid = afterFees - interestPortion;
        // #1383 — same rule as the terminal path; this entry does not end the
        // loan but still takes the ordinary cut from the interest it recovers.
        (, treasuryInterestFee) = LibLenderYieldFeeHost.resolve(
            loanId,
            LibERC721.ownerOf(loan.lenderTokenId),
            interestPortion,
            treasuryInterestFee
        );

        // Partial can't fully retire principal — that's a full liquidation.
        // The keeper retries with `triggerLiquidation` which closes the
        // loan, refunds surplus collateral, and emits the terminal event.
        if (principalRepaid >= loan.principal) revert PartialFullyClosedUseFull();

        // Treasury receipt — single transfer, same as full.
        // #2440 — measured, accrued as it arrived (TreasuryFeeFacet).
        LibFacet.transferToTreasury(loan.principalAsset, handlingFee + treasuryInterestFee);

        // Lender's share goes directly to their vault. We deliberately
        // do NOT write `s.lenderClaims[loanId]` — claims are reserved
        // for terminal events (the lender NFT is still Active, the
        // claim flow runs at proper close / full liquidation / default).
        //
        // #1383 — and BECAUSE no claim is written, the recipient here is the
        // final word: there is no `ownerOf`-gated claim behind it to correct a
        // stale address. This paid `loan.lender`, which the skip-not-block
        // consolidation can leave pointing at the PREVIOUS lender — handing them
        // the principal and interest outright, with nothing for the current
        // holder to claim against. Every other recovery entry pairs its deposit
        // with a `lenderClaims` write and is saved by that gate; this one is
        // not, so it must pay the holder directly. This is misrouted principal,
        // not a fee discount: it stands whatever is decided about whether
        // recovered interest earns the Full bump.
        uint256 lenderProceeds = afterFees - treasuryInterestFee;
        // #1383 — pay-or-freeze through the #998 S10 Class B host rather than a
        // raw locked deposit. Same shape as `RepayPeriodicFacet`'s
        // auto-liquidation leg: an ACTIVE loan, funds already in the Diamond, no
        // claim record behind it. The host resolves `ownerOf` itself, pays a
        // clean holder directly, and FREEZES fail-closed (park into the stored
        // lender's vault + `heldForLender` + encumber + marker) for a
        // registry-flagged one.
        //
        // A raw `depositLocked(ownerOf(...))` was the first attempt and is
        // WRONG here: `getOrCreateUserVault` refuses to mint a vault for a
        // flagged wallet (`SanctionedRecipientHasNoVault`), so a flagged holder
        // who never opened one would revert the liquidation outright — blocking
        // a close-out, which is exactly what Tier-2 handling exists to avoid.
        // Paying the stale `loan.lender` instead was the original bug.
        //
        // #2440 — a partial liquidation leaves the loan ACTIVE and books this
        // payout as received in full: the interest settled from it, the
        // principal it retires, and the accrual restart below. So, like the
        // rest of this all-or-nothing call (see the function's NatSpec), it is
        // refused unless the lender-position holder (or the frozen holder's
        // vault) received all of `lenderProceeds`. (The host itself refuses a
        // short arrival at the holder's wallet; the check here covers the
        // frozen holder's vault.) The close-out that acts on
        // what arrived is the FULL liquidation, which stays open: a keeper
        // turned away here calls {triggerLiquidation}.
        if (lenderProceeds > 0) {
            LibDelivery.requireFull(loan.principalAsset, lenderProceeds, abi.decode(
                LibFacet.crossFacetCallReturn(
                    abi.encodeWithSelector(
                        EncumbranceMutateFacet.freezeOrPayActiveLenderResident.selector,
                        loanId,
                        loan.principalAsset,
                        lenderProceeds,
                        // #1209 / #1808 — the interest in the payout, gross and
                        // net of the fee: open seller claims are paid first.
                        interestPortion,
                        interestPortion - treasuryInterestFee
                    ),
                    bytes4(0)
                ),
                (uint256)
            ));
        }

        // #395 (Codex r1 P1 #2) — snapshot the PRE-partial position value
        // BEFORE the mutation below. The dust waiver keys off this pre-existing
        // size, never the post-mutation residual: otherwise a keeper could
        // over-liquidate to manufacture a sub-dust residual and self-waive the
        // over-liquidation ceiling. Only a genuinely-tiny position (which can't
        // restore within the ceiling without leaving dust) is waived; a larger
        // position that can't partial cleanly falls back to full liquidation.
        (uint256 preDebtNum, uint256 preCollNum) = _computeNumeraireValues(loan);

        // Mutate the loan: reduce collateral + principal and restart the
        // INTEREST-ACCRUAL clock at now on the reduced principal.
        //
        // #641 — the term tuple (`startTime` + `durationDays`) is left
        // UNTOUCHED, so the loan's maturity (`startTime + durationDays*1 days`)
        // and grace bucket (`gracePeriod(durationDays)`) are preserved exactly:
        // a partial can no longer pull the default / late-fee deadline earlier
        // or collapse the grace window. The accrual clock lives in the dedicated
        // `interestAccrualStart` / `interestRemainingDays` fields instead — the
        // reduced principal accrues from `now` over the whole days remaining to
        // maturity. The pre-partial coupon was already settled interest-first
        // from the swap proceeds above.
        loan.collateralAmount -= swappedCollateral;
        LibInterestLedger.reducePrincipal(s, loan, principalRepaid, principalRepaid);
        uint256 remainingDays = (endTime - block.timestamp) / 1 days;
        loan.interestAccrualStart = uint64(block.timestamp);
        loan.interestRemainingDays = uint16(remainingDays);
        // #915 / #2731 — the residual loan restarts its accrual clock at
        // `now`, so the periodic credit this slice's interest was netted
        // against is consumed: only the gross interest it covered is taken off,
        // and any excess (a periodic settlement can deliver more than has
        // accrued by now) carries to the residual loan, as `repayPartial`
        // keeps it (#1191). Clearing it outright would forfeit interest the
        // borrower already paid; keeping it whole would net it a second time.
        loan.interestSettled = settledCarried;
        // #2731 — the interest this slice paid the lender counts toward the
        // current period, as every other mid-period payment does; otherwise the
        // periodic settlement would sell collateral for it again.
        LibPeriodicInterest.creditInterestPaid(loan, loanId, interestPortion);

        // Post-mutation HF check. Strictly improves AND must reach >= 1.
        // `currentBorrow` re-derives from the now-reduced principal, so this
        // branch reverts naturally if HF is still below 1.
        uint256 hfAfter = RiskFacet(address(this)).calculateHealthFactor(loanId);
        if (hfAfter <= hfBefore) revert PartialMustImproveHF(hfBefore, hfAfter);
        if (hfAfter < LibVaipakam.HF_SCALE) revert PartialMustRestoreHF(hfAfter);
        // #395 (Approach A) — "size to need": a routine partial may not leave
        // the borrower above the governance target-HF ceiling (over-liquidation
        // guard), NOR leave a fresh dust position (dust-prevention guard), with
        // escalation waivers for deep-underwater / pre-existing-dust positions.
        // E2-safe: only constrains HOW MUCH collateral is sold, never re-prices.
        // POST-mutation residual value for the dust-prevention check.
        (uint256 postDebtNum, uint256 postCollNum) = _computeNumeraireValues(loan);
        _assertPartialSizing(
            hfBefore, hfAfter, preDebtNum, preCollNum, postDebtNum, postCollNum
        );

        emit LoanPartiallyLiquidated(
            loanId,
            msg.sender,
            fractionBps,
            swappedCollateral,
            proceeds,
            principalRepaid,
            interestPortion,
            hfAfter
        );
    }

    /**
     * @notice Liquidator-buys-at-discount path — Phase 8 of
     *         `docs/DesignsAndPlans/FlashLoanLiquidationPath.md`.
     *         Optional, governance-gated alternative to the existing
     *         atomic-swap paths ({triggerLiquidation},
     *         {triggerLiquidationSplit}). The caller pays the full
     *         outstanding debt in the principal asset (typically funded
     *         via a same-tx flash-loan from Aave V3 or Balancer V2);
     *         the protocol seizes the borrower's collateral at a
     *         per-tier discount and delivers it to `recipient`. The
     *         liquidator sells the seized collateral on their own
     *         schedule (DEX of choice, MEV strategy of choice) to
     *         repay the flash-loan and capture the residual profit.
     *
     * @dev    Same pre-check shape as {triggerLiquidation}:
     *         - Tier-1 sanctions gate on `msg.sender` — the seized
     *           collateral flows to `recipient` (not necessarily
     *           `msg.sender`) but the caller still authored the trade
     *           and value-receipt-by-sanctioned-relayer is blocked.
     *         - Master kill-switch (`discountPathEnabled`). Default
     *           false; flipped on per chain by ADMIN_ROLE /
     *           TimelockController after audit sign-off.
     *         - l2 sequencer circuit-breaker.
     *         - HF < 1e18.
     *
     *         Settlement math (oracle-priced, both legs required):
     *           `totalDebt   = currentBorrow + lateFee`
     *           `collForDebt = collateralEquivalent(totalDebt)`
     *           `collSeize   = collForDebt × (10000 + discountBps) / 10000`
     *           `collSeize   = min(collSeize, loan.collateralAmount)`
     *           `surplus     = loan.collateralAmount - collSeize`
     *
     *         If the loan is underwater (collForDebt × discount
     *         multiplier > collateralAmount) the seizure caps at the
     *         available collateral and the surplus is zero. The
     *         liquidator absorbs the loss on the under-coverage —
     *         which means rational liquidators won't call this path
     *         on underwater loans; the keeper bot falls back to
     *         {triggerLiquidation} (atomic) in those cases.
     *
     *         Asset flow:
     *           - msg.sender → diamond: `totalDebt` principal-asset
     *             (must have pre-approved the diamond, OR funds just
     *             arrived via a flash-loan callback).
     *           - diamond → treasury: `splitTreasury(interestPortion)`
     *             cut — same treasury-on-interest split as the atomic
     *             path. NO `liquidationHandlingFee` (the discount IS
     *             the liquidator's payment; no protocol-side bonus
     *             needed).
     *           - diamond → lender vault: principal + remaining
     *             interest + late fee (full lender entitlement).
     *           - borrower vault → recipient: `collateralSeized`
     *             collateral-asset.
     *           - borrower vault keeps: `borrowerSurplus`
     *             collateral-asset (never withdrawn — already in their
     *             vault, available via standard vault withdrawal).
     *
     *         Loan transitions Active → Defaulted. VPFI LIF forfeits
     *         (HF liquidation is not a proper close).
     *         Interaction-rewards close marks the borrower as forfeit.
     *         Both NFTs flip to `LoanLiquidated`.
     *
     *         Tier resolution:
     *           `tier = OracleFacet.getEffectiveLiquidityTier(asset)`
     *           Requires `tier ∈ {1, 2, 3}` — Tier 0 (unclassified)
     *           reverts `UntierableCollateral`. For Liquid-but-
     *           unclassified assets the right tool is
     *           {triggerLiquidation} (atomic swap); for Illiquid
     *           collateral the right tool is the time-based default
     *           path.
     *
     *         Why no liquidator-side KYC gate (vs the atomic path):
     *           the discount-path liquidator's payment IS receiving
     *           collateral, which carries chain-of-custody from the
     *           borrower — and on the principal-asset side they're
     *           SPENDING, not receiving. The atomic-path KYC gate
     *           specifically fires on the dynamic bonus's
     *           numeraire-value (a payment from the diamond to
     *           msg.sender); that doesn't exist here. The recipient
     *           is the liquidator's choice and the protocol's
     *           responsibility ends at `safeTransfer`.
     *
     * @param  loanId    The loan to liquidate. Must be `Active` with
     *                   `HF < 1e18`, collateral tier-classified.
     * @param  recipient Where the seized collateral lands. Usually
     *                   `msg.sender`; passing a different address
     *                   enables relay / MEV-bot patterns (bot calls
     *                   from a hot wallet, routes seizure elsewhere).
     *                   Must be non-zero.
     *
     *         Note on the third `bytes` parameter: reserved for a
     *         future post-seizure callback (named `extraData` in the
     *         design doc). Ignored in v1; callers using flash-loans
     *         should structure the unwind around the
     *         `triggerLiquidationDiscounted` call (e.g. inside their
     *         `executeOperation` flash-loan callback) rather than
     *         relying on a protocol-side callback.
     */
    function triggerLiquidationDiscounted(
        uint256 loanId,
        address recipient,
        bytes calldata /* extraData reserved for v2 */
    ) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 layer 2 — see `triggerLiquidation`.
        // Inline storage pre-check so this entry point stays callable on
        // diamonds that haven't cut `SwapToRepayIntentFacet` (the
        // scenario suite + other diamond test harnesses that select
        // facets a la carte). When no v1.1 intent commit is live for
        // this loan, the cross-facet call is skipped entirely and we
        // proceed straight to the standard liquidation flow.
        if (LibVaipakam.storageSlot().intentCommits[loanId].orderHash != bytes32(0)) {
            SwapToRepayIntentFacet(address(this)).forceCancelIntentFor(
                loanId, SwapToRepayIntentFacet.ForceCancelReason.HFBelowLiquidationThreshold
            );
        }
        // Tier-1 sanctions gate — `msg.sender` authored the trade and
        // earns the discount-net-of-execution-cost profit.
        LibVaipakam._assertNotSanctioned(msg.sender);

        // Master kill-switch — discount path off by default.
        if (!LibVaipakam.cfgDiscountPathEnabled()) revert DiscountPathDisabled();

        // Recipient sanity — zero would burn the collateral.
        if (recipient == address(0)) revert ZeroRecipient();

        // #816 Tier-1 sanctions gate on the SEIZED-COLLATERAL recipient. The
        // discounted path delivers the bought collateral to `recipient` (a
        // caller-chosen address, not necessarily `msg.sender`), so screening
        // only the caller would let a clean liquidator route fresh value to a
        // flagged wallet. No fresh value may reach a sanctioned recipient.
        LibVaipakam._assertNotSanctioned(recipient);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert InvalidLoan();
        s; // suppress unused-storage warning; the library reads it.
        // T-086 step 10 — see {triggerLiquidation}'s sibling block.
        LibPrepayCleanup.clearActiveListing(loan, loanId);
        // #569 Codex #572 round-5 P2 — UNLIKE the full-seizure atomic
        // paths ({triggerLiquidation}/{triggerLiquidationSplit}, which
        // withdraw ALL collateral and so fully release here), the
        // discounted path seizes only `collateralSeized` and leaves
        // `borrowerSurplus` COLLATERAL in `loan.borrower`'s vault as a
        // `borrowerClaims` row. So the lien must NOT be fully released
        // here; it is decremented by exactly `collateralSeized` inside
        // `_settleDiscountedLiquidation` (just before the seizure
        // withdraw), leaving the surplus encumbered until
        // `ClaimFacet.claimAsBorrower` releases it atomically. A full
        // release here would let the stored borrower drain the surplus
        // (via `withdrawVPFIFromVault`) before a transferee claimant
        // claims it.

        // l2 circuit-breaker — same as atomic path. While the
        // sequencer is unhealthy, oracle reads may be stale and the
        // discount-priced seizure could mis-price.
        if (!OracleFacet(address(this)).sequencerHealthy()) {
            revert SequencerUnhealthy();
        }

        // HF gate — identical to atomic path. Discount-path doesn't
        // relax the threshold; it changes WHO bears swap risk, not
        // WHEN liquidation becomes available.
        uint256 hf = RiskFacet(address(this)).calculateHealthFactor(loanId);
        if (hf >= LibVaipakam.HF_SCALE) revert HealthFactorNotLow();

        // #2734 — the discounted route seizes collateral for an outside
        // liquidator, so it defers to an internal match inside the priority
        // window like every other external route. It does not auto-dispatch.
        LibInternalMatchPriority.requireOutside(loanId, loan);

        // #658 — discounted liquidation is a both-side close-out (lender debt +
        // borrower surplus); consolidate transferred sides to current holders
        // before settlement.
        _eagerConsolidateBothSides(loanId);

        // Resolve per-tier discount. `getEffectiveLiquidityTier`
        // returns 0 for unclassified assets — the discount math
        // requires a classified tier so we reject up-front. The
        // atomic-path is the alternative for Liquid-but-unclassified
        // assets; time-based default for Illiquid.
        // #2697 — one rule with the preview ({LibDiscountedLiquidation}).
        (uint8 tier, uint16 discountBps) =
            LibDiscountedLiquidation.discountFor(loan.collateralAsset);
        if (tier == 0) revert UntierableCollateral(loan.collateralAsset);

        _settleDiscountedLiquidation(loanId, loan, recipient, tier, discountBps);
    }

    /**
     * @dev Settlement leg of {triggerLiquidationDiscounted}, split out
     *      to keep the entry-point under the local-variable limit
     *      under viaIR. Computes debt, pulls principal from
     *      msg.sender, computes the per-tier seizure size, routes
     *      principal to lender + treasury, withdraws seized collateral
     *      to `recipient`, transitions the loan, and emits the
     *      terminal event. Reverts if oracle quorum is unavailable for
     *      either leg.
     */
    function _settleDiscountedLiquidation(
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        address recipient,
        uint8 tier,
        uint16 discountBps
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Debt — same shape as atomic path, by the rule the preview reads
        // ({LibDiscountedLiquidation.debt}, #2697).
        uint256 totalDebt = LibDiscountedLiquidation.debt(loan);
        uint256 interestPortion = totalDebt - loan.principal;
        // #1832 — terminal seam of the lifetime interest counter.
        LibMetricsHooks.onInterestPaid(loan, interestPortion);

        // Pull `totalDebt` of principal-asset from msg.sender. The
        // liquidator must have approved the diamond — either by
        // explicit `approve` before this call, or because they just
        // received the funds inside a flash-loan callback that wraps
        // this entry-point. `nonReentrant` on the outer entry-point
        // prevents a malicious-token transferFrom from re-entering the
        // discount path.
        // #2440 — the debt is forwarded to the lender at `totalDebt`, so it must
        // have arrived in full; a short arrival is refused by name rather than
        // made up from tokens the Diamond holds for others.
        LibDelivery.pullExact(loan.principalAsset, msg.sender, address(this), totalDebt);

        // Seizure at oracle-priced debt-plus-discount value, by the rule the
        // preview reads ({LibDiscountedLiquidation.seizure}, #2697). A missing
        // price is reported as unpriced (no revert on stale) so this fails
        // with a precise `OracleStaleForDiscount` rather than a generic
        // oracle-feed error; a distrusted price reverts with its read's own
        // divergence error inside it (#666). Availability is its `priced`
        // flag, never a zero result (#1281 item 027).
        (bool priced, uint256 collateralSeized) =
            LibDiscountedLiquidation.seizure(loan, totalDebt, discountBps);
        if (!priced) {
            revert OracleStaleForDiscount(loan.principalAsset, loan.collateralAsset);
        }
        uint256 borrowerSurplus = loan.collateralAmount - collateralSeized;

        // Treasury cut on the interest portion of the debt — identical
        // share as the atomic path. NO handling fee — the discount IS
        // the liquidator's compensation, paid in collateral, not a
        // separate principal-asset bonus.
        (uint256 treasuryInterestFee, ) = LibEntitlement.splitTreasury(loan, interestPortion);
        // #1383 — same rule as the atomic path. Separately gated entry, easy to
        // miss because it sits beside the ordinary one.
        (, treasuryInterestFee) = LibLenderYieldFeeHost.resolve(
            loanId,
            LibERC721.ownerOf(loan.lenderTokenId),
            interestPortion,
            treasuryInterestFee
        );
        uint256 lenderProceeds = totalDebt - treasuryInterestFee;

        // #2440 — measured, accrued as it arrived (TreasuryFeeFacet).
        LibFacet.transferToTreasury(loan.principalAsset, treasuryInterestFee);

        // Lender's proceeds to their vault. #821 — vault-lock for a flagged lender.
        // #2440 — the claim names what the vault received.
        lenderProceeds = LibSanctionedLock.depositLocked(
            s, loan.lender, loanId, loan.principalAsset, lenderProceeds
        );
        // #998 S10 (#1006 / #1132) — both holders' fail-closed markers are
        // recorded centrally at the `Defaulted` transition (terminalize).

        // Record lender claim metadata for NFT-state tracking.
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

        // #569 Codex #572 round-5 P2 — decrement the lien by exactly
        // `collateralSeized` (what leaves the vault for the liquidator).
        // The full lien was retained through `triggerLiquidationDiscounted`
        // (the early full release was removed); this decrement clears the
        // guard for the seizure withdraw below while leaving
        // `borrowerSurplus` encumbered. The surplus stays liened in
        // `loan.borrower`'s vault until `ClaimFacet.claimAsBorrower`
        // releases it atomically with the claim withdrawal — closing the
        // transferred-position drain. No-op when `collateralSeized == 0`
        // (the full collateral becomes the surplus claim).
        _decrementLienAtPartialLiq(loanId, collateralSeized);

        // Withdraw `collateralSeized` from borrower vault directly to
        // `recipient`. The remaining `borrowerSurplus` stays ENCUMBERED
        // in the borrower's vault and is retrieved by the current
        // borrower-position NFT holder via `ClaimFacet.claimAsBorrower`
        // (which releases the residual lien atomically with the payout).
        if (collateralSeized > 0) {
            // #821 (Codex #832 r3 P1) — move-out-exempt so a borrower flagged
            // after init doesn't brick the discounted liquidation; the seized
            // collateral is pushed OUT to the already-screened `recipient`.
            LibSanctionedLock.vaultWithdrawERC20MoveOut(
                LibVaipakam.storageSlot(),
                loan.borrower,
                loan.collateralAsset,
                recipient,
                collateralSeized
            );
        }
        // Record borrower claim metadata — the surplus is in COLLATERAL
        // units (not principal), sits ENCUMBERED in the borrower's vault,
        // and is withdrawn by the borrower-position NFT holder through
        // `claimAsBorrower`. `claimed` is set true when the surplus is
        // zero (nothing to claim).
        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: borrowerSurplus,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: borrowerSurplus == 0
        });
        // #998 S10 (#1006 / #1132) — the surplus stays ENCUMBERED in the borrower's
        // own vault (no fresh park) but is claim-gated. Both holders' fail-closed
        // frozen-claimant markers are recorded centrally at the `Defaulted`
        // transition below (via `EncumbranceMutateFacet.terminalize`).

        // Lifecycle: Active → Defaulted. Same terminal as atomic-path
        // liquidations.
        // #1132 (S10 central enforcement) — route through the
        // `EncumbranceMutateFacet.terminalize` host so the validated Active→Defaulted
        // transition AND both holders' fail-closed frozen-claimant markers land
        // in one place (the standalone registers above were folded here).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.terminalize.selector,
                loanId,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Defaulted
            ),
            bytes4(0)
        );

        // Interaction-rewards close — borrower forfeits, lender does
        // not (`borrowerClean=false, lenderForfeit=false`), identical
        // to the atomic path's HF-liquidation terminal.
        LibInteractionRewards.closeLoan(loanId, false, false);

        // NFT status flips — burns happen in {ClaimFacet} after
        // claims settle. Mirrors atomic-path terminal.
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

        emit LiquidationDiscounted(
            loanId,
            msg.sender,
            recipient,
            tier,
            discountBps,
            totalDebt,
            collateralSeized,
            borrowerSurplus
        );
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

    //     uint256 endTime = LibLoanClock.maturity(loan);
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
    //             VaultFactoryFacet.vaultWithdrawERC20.selector,
    //             loan.borrower,
    //             loan.collateralAsset,
    //             address(this),
    //             loan.collateralAmount
    //         )
    //     );
    //     if (!success) revert VaultWithdrawFailed();

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
    //     uint256 bonusNumeraire = (bonus * price) / (10 ** decimals);
    //     if (
    //         bonusNumeraire > LibVaipakam.KYC_TIER1_THRESHOLD_NUMERAIRE &&
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

    /// @dev Tiered-KYC gate on the liquidator bonus (README §16), shared by the
    ///      single-route + partial liquidation paths so the numeraire math +
    ///      threshold check live in one place. Prices `bonus` in the principal
    ///      asset to a 1e18 USD numeraire and reverts `KYCRequired` if the
    ///      caller isn't cleared for that value tier. No-op when KYC enforcement
    ///      is off (retail default — `meetsKYCRequirement` short-circuits true).
    function _assertLiquidatorKyc(address principalAsset, uint256 bonus) private view {
        // Rounded down, as every threshold comparison is (#2419).
        uint256 bonusNumeraire = NumeraireValueFacet(address(this))
            .getNumeraireValue(principalAsset, bonus, false);
        if (!ProfileFacet(address(this)).meetsKYCRequirement(msg.sender, bonusNumeraire))
            revert KYCRequired();
    }

    /// @dev #1566 S2a: the swap failed, so enter FallbackPending through the
    ///      one fallback-custody host, {FallbackCustodyFacet.enterFallback}.
    ///      It replaced this facet's `_fullCollateralTransferFallback`, whose
    ///      code was identical to DefaultedFacet's copy. The entry reads no
    ///      caller context (only `loanId`, storage and the Diamond's own
    ///      address), so the self-call is behaviour-identical; its
    ///      non-empty revert bytes bubble verbatim (an empty one surfaces as
    ///      `bytes4(0)`). A private helper so the call's encoding
    ///      stays out of `triggerLiquidation`'s near-ceiling viaIR frame.
    function _enterFallback(uint256 loanId) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                FallbackCustodyFacet.enterFallback.selector,
                loanId
            ),
            bytes4(0)
        );
    }

    // Internal helper for current borrow balance with accrued interest
    /// @dev `_calculateCurrentBorrowBalance` (seconds-precise borrow balance)
    ///      was promoted to {LibEntitlement.currentBorrowBalance} in the #66
    ///      RiskFacet/RiskMatchLiquidationFacet split so both facets share
    ///      one accrual model. Call sites here now read the library helper.

    /// @dev Each side of `loan` valued in the active numeraire (USD by
    ///      post-deploy default), 1e18-scaled, through the one shared rule
    ///      ({NumeraireValueFacet.getNumeraireValue}, #2419). The debt (the
    ///      current borrow balance, accrued interest included) rounds UP and
    ///      the collateral DOWN, so every ratio built on the pair — LTV, HF,
    ///      the collapse test, the partial-liquidation snapshots — errs
    ///      toward the lender, by at most one 1e-18 unit per side. Used by
    ///      calculateLTV, calculateHealthFactor and isCollateralValueCollapsed
    ///      (one fetch for both of the latter's ratios) and by the partial
    ///      liquidation.
    function _computeNumeraireValues(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256 borrowValueNumeraire, uint256 collateralValueNumeraire) {
        NumeraireValueFacet values = NumeraireValueFacet(address(this));
        borrowValueNumeraire = values.getNumeraireValue(
            loan.principalAsset,
            LibEntitlement.currentBorrowBalance(loan),
            true
        );
        collateralValueNumeraire = values.getNumeraireValue(
            loan.collateralAsset,
            loan.collateralAmount,
            false
        );
    }

    /// @dev #395 (Approach A) graduated-close-factor guard — two checks that
    ///      together keep a routine partial "sized to need":
    ///
    ///      A. OVER-liquidation ceiling: reverts {PartialOverLiquidates} when
    ///         the partial leaves the borrower above the governance target-HF
    ///         ceiling (it sold more than needed). WAIVED when either:
    ///           - deep-underwater — `hfBefore` ≤ the configured threshold
    ///             (the position needs aggressive delevering); or
    ///           - pre-existing dust — the position was ALREADY dust-sized at
    ///             ENTRY (`preDebtNum`/`preCollNum` below the floor), so it
    ///             can't restore within the ceiling without leaving dust.
    ///             Keyed on PRE-partial values (Codex r1 P1 #2) so a keeper
    ///             can't manufacture a sub-dust residual to self-waive.
    ///
    ///      B. UNDER-liquidation dust-prevention (Codex r3 P2): reverts
    ///         {PartialLeavesDust} when a within-band partial would leave a
    ///         FRESH dust position out of a non-dust loan — BOTH the residual
    ///         debt AND residual collateral below the floor. Forces the keeper
    ///         to full liquidation (which closes cleanly) instead of leaving an
    ///         un-liquidatable scrap active. Skipped when the loan was already
    ///         dust (unavoidable) — that case took the (A) pre-dust waiver.
    ///
    ///      Both checks are GATED on a configured dust floor (`> 0`); dust
    ///      handling is off by default (Codex r3 P2 — no USD-scaled default on
    ///      a possibly-rotated numeraire), and a rotation resets it to off.
    ///      The floor and the four snapshots share one scale: 1e18-scaled
    ///      numeraire values from {_computeNumeraireValues} (#2419).
    ///      Thresholds are range-clamped at the setter, so reads are trusted.
    function _assertPartialSizing(
        uint256 hfBefore,
        uint256 hfAfter,
        uint256 preDebtNum,
        uint256 preCollNum,
        uint256 postDebtNum,
        uint256 postCollNum
    ) private view {
        uint256 dustFloor = LibVaipakam.cfgLiquidationDustFloorNumeraire();
        bool preDust = dustFloor > 0 &&
            (preDebtNum < dustFloor || preCollNum < dustFloor);
        // (B) Leaves a FRESH dust position — both residual sides below the
        // floor, out of a non-pre-dust loan. Computed up front because it must
        // be enforced in BOTH the within-band AND the over-ceiling/deep-
        // underwater branches (Codex r7: a deep-underwater aggressive slice can
        // restore HF above the ceiling AND shrink both residuals to dust; that
        // must still escalate to full, not slip through the deep-water waiver).
        bool leavesFreshDust = dustFloor > 0 && !preDust &&
            postDebtNum < dustFloor && postCollNum < dustFloor;

        uint256 ceiling = (LibVaipakam.cfgPartialLiqTargetHfCeilingBps() *
            LibVaipakam.HF_SCALE) / LibVaipakam.BASIS_POINTS;

        if (hfAfter > ceiling) {
            // (A) Over the ceiling. A routine over-liquidation (not deep-
            // underwater, not pre-dust) is "sized too big" — revert
            // PartialOverLiquidates so the keeper re-sizes a SMALLER slice.
            uint256 deepThreshold = (LibVaipakam.cfgPartialLiqDeepUnderwaterHfBps() *
                LibVaipakam.HF_SCALE) / LibVaipakam.BASIS_POINTS;
            if (hfBefore > deepThreshold && !preDust) {
                revert PartialOverLiquidates(hfAfter, ceiling);
            }
            // Deep-underwater or pre-existing-dust: the ceiling is waived, BUT
            // the slice still may not strand fresh dust.
            if (leavesFreshDust) revert PartialLeavesDust(postDebtNum, postCollNum);
            return;
        }

        // Within band — must not leave a FRESH dust position either.
        if (leavesFreshDust) {
            revert PartialLeavesDust(postDebtNum, postCollNum);
        }
    }

    // `_getZeroExProxy` + `_getAllowanceTarget` (previously here)
    // removed in #148 Phase 5 — leftovers from the pre-Phase-7a
    // 0x-direct liquidation path that was replaced by the 4-DEX
    // adapter pattern (`AggregatorAdapterBase` + per-aggregator
    // adapters). Live liquidation paths now read `zeroExProxy` /
    // `allowanceTarget` via `LibVaipakam.storageSlot()` directly at
    // each call site. The commented-out legacy block earlier in this
    // file (around line 1625) is the original 0x-direct flow these
    // wrappers existed to serve; leaving it in place as history.

    /// @dev #407 PR 4 round-1 (2026-06-12) — cross-facet encumbrance call
    ///      helper, in its own frame so the `abi.encodeWithSelector` locals
    ///      don't compete with the trigger function's stack.
    function _callEncumb2(bytes4 selector, uint256 loanId, uint256 arg2) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(selector, loanId, arg2),
            bytes4(0)
        );
    }

    /// @dev #2796 — the single-route HF liquidation's sale, sized to need,
    ///      on the one forced-sale host ({ForcedSaleFacet.sellToNeed}). Its own
    ///      frame keeps the outcome decode off `triggerLiquidation`'s stack.
    function _sellToNeed(
        uint256 loanId,
        uint256 sellAmount,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) private returns (ForcedSaleFacet.ForcedSaleOutcome memory) {
        return abi.decode(
            LibFacet.crossFacetCallReturn(
                abi.encodeCall(
                    ForcedSaleFacet.sellToNeed,
                    (
                        loanId,
                        ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation,
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
    }

    function _decrementLienAtPartialLiq(uint256 loanId, uint256 consumed) private {
        _callEncumb2(EncumbranceMutateFacet.decrementCollateralLien.selector, loanId, consumed);
    }
}
