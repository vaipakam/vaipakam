// src/facets/RiskFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {SwapToRepayIntentFacet} from "./SwapToRepayIntentFacet.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
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
 // Phase 7a — ordered adapter failover for liquidation swaps

/**
 * @title RiskFacet
 * @author Vaipakam Developer Team
 * @notice Risk parameter management, LTV/Health-Factor calculations, and
 *         HF-triggered liquidation for the Vaipakam P2P lending platform.
 * @dev Part of the Diamond Standard (EIP-2535). Reentrancy-guarded, pausable
 *      (mutating paths only; views are always available).
 *
 *      Per-asset risk parameters (`AssetRiskParams`): loanInitMaxLtvBps,
 *      liqThresholdBps, liqBonusBps, reserveFactorBps, minPartialBps —
 *      updatable by RISK_ADMIN_ROLE.
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
    /// @dev PR2 of internal-match work (2026-05-14) dropped
    ///      `liqThresholdBps` — the per-asset liquidation threshold
    ///      was retired in favour of per-tier
    ///      `ProtocolConfig.tier{1,2,3}LiquidationLtvBps` +
    ///      `Loan.liquidationLtvBpsAtInit` snapshot.
    /// @param asset The asset address.
    /// @param loanInitMaxLtvBps New max LTV in basis points.
    /// @param liqBonusBps New liquidation bonus in basis points.
    /// @param reserveFactorBps New reserve factor in basis points.
    /// @custom:event-category informational/config
    event RiskParamsUpdated(
        address indexed asset,
        uint256 loanInitMaxLtvBps,
        uint256 liqBonusBps,
        uint256 reserveFactorBps
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

    /// @notice External `triggerLiquidation` blocked because the loan
    ///         is still inside the internal-match priority window
    ///         `[liquidationLtvBpsAtInit,
    ///          liquidationLtvBpsAtInit + cfgExternalLiquidationPriorityWindowBps)`.
    ///         Above that, external opens up; below it the loan isn't
    ///         liquidatable at all.
    error InternalMatchOnlyBand(uint256 currentLtvBps, uint256 windowCeilingBps);

    // MAX_LIQUIDATION_SLIPPAGE_BPS consolidated in LibVaipakam

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
    ///         scrap as an Active loan.
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
    ///         returned 0, meaning `tryGetAssetPrice` failed for the
    ///         principal or collateral asset. The discount math
    ///         requires both legs priced. The liquidator can retry
    ///         once the oracle clears, or fall back to
    ///         {triggerLiquidation} which has its own oracle-stale
    ///         fallback to a claim-time settlement.
    error OracleStaleForDiscount(address principalAsset, address collateralAsset);

    /**
     * @notice Updates risk parameters for an asset.
     * @dev Callable only by Diamond owner (multi-sig/governance).
     *      Validates params. Emits RiskParamsUpdated.
     *
     *      PR2 of the internal-match work (2026-05-14) retired the
     *      per-asset `liqThresholdBps`. The liquidation threshold is
     *      now per-tier (configured via
     *      `ConfigFacet.setTierLiquidationLtvBps`) and snapshotted to
     *      each loan at `initiateLoan` onto `Loan.liquidationLtvBpsAtInit`.
     * @param asset The asset address (collateral/lending).
     * @param loanInitMaxLtvBps Max LTV in bps (e.g., 8000 for 80%).
     * @param liqBonusBps Per-asset ceiling on the dynamic liquidator incentive, in bps.
     *        Must be ≤ MAX_LIQUIDATOR_INCENTIVE_BPS (300 = 3%). The runtime incentive is
     *        still computed as `6% − realized slippage%` capped at 3%; this value only
     *        lets governance tighten that cap further per asset.
     * @param reserveFactorBps Reserve factor in bps.
     */
    function updateRiskParams(
        address asset,
        uint256 loanInitMaxLtvBps,
        uint256 liqBonusBps,
        uint256 reserveFactorBps
    ) external whenNotPaused onlyRole(LibAccessControl.RISK_ADMIN_ROLE) {
        if (asset == address(0)) revert InvalidAsset();
        // Setter-range audit (2026-05-02): bounded floors on the
        // numeric tunables. Previously: maxLtv only `> 0` (allowed
        // degenerate `1`-bp setting that disables borrowing for the
        // asset); reserveFactor only `≤ BASIS_POINTS` (allowed 100%
        // = lender receives 0% interest). Tightened to credible
        // ranges; surfaced via `ParameterOutOfRange`.
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
        if (reserveFactorBps > LibVaipakam.RISK_PARAMS_RESERVE_FACTOR_BPS_MAX) {
            revert IVaipakamErrors.ParameterOutOfRange(
                "reserveFactorBps",
                reserveFactorBps,
                0,
                uint256(LibVaipakam.RISK_PARAMS_RESERVE_FACTOR_BPS_MAX)
            );
        }

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RiskParams storage params = s.assetRiskParams[asset];
        params.loanInitMaxLtvBps = loanInitMaxLtvBps;
        params.liqBonusBps = liqBonusBps;
        params.reserveFactorBps = reserveFactorBps;

        emit RiskParamsUpdated(
            asset,
            loanInitMaxLtvBps,
            liqBonusBps,
            reserveFactorBps
        );
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
     *         same as {updateRiskParams}. The optimistic delta+cooldown
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
    ) external whenNotPaused onlyRole(LibAccessControl.RISK_ADMIN_ROLE) {
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

        // Rounds DOWN (borrower-favourable by <=1 BPS). A loan exactly at the
        // cap slips 1 BPS under; given 1e18-scaled numeraire-quoted values
        // the absolute error is sub-dust and acceptable. Do NOT change to
        // ceilDiv without retuning `maxLTVBps` thresholds.
        ltv = (borrowedValueNumeraire * LibVaipakam.BASIS_POINTS) / collateralValueNumeraire;
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

        if (borrowValueNumeraire == 0) return type(uint256).max; // Infinite HF if no borrow

        // PR2 of internal-match work: per-asset `liqThresholdBps` was
        // retired. HF now reads the snapshotted per-tier liquidation
        // threshold from the loan itself (`liquidationLtvBpsAtInit`),
        // so tier degradation mid-loan never re-gates existing loans.
        uint256 liqThresholdBps = uint256(loan.liquidationLtvBpsAtInit);
        // Rounds DOWN on both steps — HF is slightly under-reported, which
        // means liquidation may trigger marginally earlier than theoretical.
        // Protocol-favourable (safe direction). Error magnitude: sub-wei on
        // HF_SCALE (1e18) for realistic collateral sizes.
        uint256 riskAdjustedCollateral = (collateralValueNumeraire *
            liqThresholdBps) / LibVaipakam.BASIS_POINTS;

        healthFactor =
            (riskAdjustedCollateral * LibVaipakam.HF_SCALE) /
            borrowValueNumeraire;
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

        uint256 ltv = (borrowValueNumeraire * LibVaipakam.BASIS_POINTS) / collateralValueNumeraire;

        uint256 hf;
        if (borrowValueNumeraire == 0) {
            hf = type(uint256).max;
        } else {
            // PR2 of internal-match work: read snapshotted per-tier
            // liquidation threshold from the loan instead of the
            // retired per-asset `liqThresholdBps`.
            uint256 liqThresholdBps = uint256(loan.liquidationLtvBpsAtInit);
            uint256 riskAdjustedCollateral = (collateralValueNumeraire * liqThresholdBps)
                / LibVaipakam.BASIS_POINTS;
            hf = (riskAdjustedCollateral * LibVaipakam.HF_SCALE) / borrowValueNumeraire;
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

    /// @dev #658 (Codex #680 P2) — single-copy bridge to the cross-facet
    ///      post-withdraw VPFI re-stamp. The eager consolidation above stamped
    ///      the holder at the full pre-liquidation balance; once a liquidation
    ///      path withdraws VPFI collateral out of the holder's vault, the credit
    ///      is stale-high until the next VPFI action. Each liquidation entry
    ///      calls this AFTER its collateral withdrawal; no-op for non-VPFI
    ///      collateral (gated inside the facet). Same EIP-170 rationale as
    ///      {_eagerConsolidateBothSides}.
    function _restampCollateralVpfi(uint256 loanId) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.restampCollateralVpfiAfterWithdraw.selector,
                loanId
            ),
            bytes4(0)
        );
    }

    function triggerLiquidation(
        uint256 loanId,
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
            SwapToRepayIntentFacet(address(this)).forceCancelIntentIfHFBelowOrRevert(loanId);
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
            // #658 (Codex #680 round-2 P2) — the auto-dispatch branch returns
            // here BEFORE the external-swap restamp below. If the eager
            // consolidation above moved VPFI collateral to the holder (stamping
            // them at the full pre-liquidation balance) and the internal match
            // just consumed it, re-stamp the triggering loan's holder at the
            // reduced balance now, so they can't keep tier/staking credit for
            // VPFI the match already removed. No-op for non-VPFI. (The matched
            // CANDIDATE leg's consolidation + restamp is PR-B —
            // RiskMatchLiquidationFacet, where the candidateId is in scope.)
            _restampCollateralVpfi(loanId);
            return;
        }

        // #407 PR 4 round-1 Codex P1 #5 (2026-06-12) — release the
        // collateral lien only AFTER the internal-match dispatch
        // returned `false`. If internal-match auto-dispatched, that
        // path may have partially consumed the loan and is responsible
        // for its own lien decrement; releasing here would have
        // unprotected the residual. From this line down we're on the
        // external-aggregator swap branch — loan transitions Active →
        // Defaulted (or FallbackPending on swap failure, where the
        // cure path will recreate the lien).
        _releaseLienAtLiquidation(loanId);

        // ── Internal-match priority window (B.2 / PR4) ─────────────────
        // When the kill-switch is on AND auto-dispatch above didn't fire
        // (no candidate found), the external swap-liquidation path is
        // blocked for a configurable LTV band immediately above the
        // loan's snapshotted liquidation threshold — giving internal
        // matchers a clean priority slot. Above that band, external
        // opens up (worst case: ~2% LTV deterioration vs today, well
        // within the bad-debt buffer guaranteed by
        // MAX_TIER_LIQUIDATION_LTV_BPS = 9500 + MAX window = 500 ⇒ 100%).
        if (s.protocolCfg.internalMatchEnabled) {
            uint256 currentLtv = RiskFacet(address(this)).calculateLTV(loanId);
            uint256 floor = uint256(loan.liquidationLtvBpsAtInit);
            uint256 windowCeiling = floor + LibVaipakam.cfgExternalLiquidationPriorityWindowBps();
            // HF < 1 already implies LTV >= floor for liquid collateral,
            // so only the upper bound needs gating. A zero floor (illiquid
            // loan with no snapshot) means we never enter the window
            // and external proceeds — safe by construction.
            if (floor > 0 && currentLtv < windowCeiling) {
                revert InternalMatchOnlyBand(currentLtv, windowCeiling);
            }
        }

        // Execution routing (README §1): HF-based liquidation requires the
        // collateral to be swappable on the live network. If the active-
        // network liquidity check fails, revert — the time-based default
        // path in DefaultedFacet handles unswappable collateral via the
        // full-collateral-transfer branch.
        LibVaipakam.LiquidityStatus liquidity = OracleFacet(address(this))
            .checkLiquidityOnActiveNetwork(loan.collateralAsset);
        if (liquidity != LibVaipakam.LiquidityStatus.Liquid)
            revert NonLiquidAsset();

        // Withdraw collateral to Diamond for swap. #821 (Codex #832 r3 P1) — the
        // move-out-exempt withdraw so a borrower flagged after init doesn't brick
        // the liquidation (collateral pushed OUT to the already-screened swap
        // recipients; the flagged party loses custody).
        LibSanctionedLock.vaultWithdrawERC20MoveOut(
            LibVaipakam.storageSlot(),
            loan.borrower,
            loan.collateralAsset,
            address(this),
            loan.collateralAmount
        );
        // #658 (Codex #680 P2) — the eager consolidation stamped the holder at
        // the full pre-liquidation VPFI balance; the withdrawal just above
        // removed the collateral. Re-stamp at the reduced balance (no-op for
        // non-VPFI). Covers both the swap-success and swap-fail/fallback
        // branches below; the auto-dispatch branch returned earlier and its
        // internal-match collateral handling lands with PR-B.
        _restampCollateralVpfi(loanId);

        // Compute expected proceeds from oracle prices and the slippage floor
        // (94% of expected = 6% slippage ceiling per README §7). The floor
        // is passed unchanged to LibSwap; each adapter enforces it on its
        // own side either via the underlying DEX's amountOutMinimum guard
        // (UniV3, Balancer) or a balance-delta check around the call
        // (aggregator base).
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

        // Phase 7a — caller-ranked failover across the registered swap
        // adapters. `adapterCalls` is the keeper-supplied try-list,
        // ranked by expected output (best first). LibSwap iterates in
        // submitted order, handles per-adapter exact-scope approvals,
        // and commits on the first success. Total failure (all adapters
        // reverted, or empty try-list) routes to the same full-
        // collateral fallback path as pre-7a.
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
            return;
        }
        uint256 proceeds = proceedsFromSwap;

        // Calculate debt: principal + net accrued interest + late fees (README §7).
        // #915 (M7) — `currentBorrowBalance` nets `interestSettled` so periodic-
        // settled interest is not double-counted in the liquidation debt.
        uint256 endTime = loan.startTime + loan.durationDays * 1 days;
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
        uint256 totalDebt = LibEntitlement.currentBorrowBalance(loan) + lateFee;
        uint256 interestPortion = totalDebt - loan.principal;

        // Dynamic liquidator incentive (README §3 line 148): 6% − realized
        // slippage, capped 3% (+ per-asset ceiling). Shared curve helper (L-h
        // #1010) so the split-route + time-default paths stay identical. Rounds
        // DOWN — protocol-favourable; dust accrues to the treasury tranche.
        uint256 bonus = (proceeds *
            LibEntitlement.liquidatorIncentiveBps(loan.collateralAsset, proceeds, expectedProceeds))
            / LibVaipakam.BASIS_POINTS;
        if (bonus > proceeds) bonus = proceeds;

        // Tiered KYC check for liquidator based on bonus value (README §16).
        _assertLiquidatorKyc(loan.principalAsset, bonus);

        // Liquidation bonus transferred to liquidator immediately.
        if (bonus > 0) {
            IERC20(loan.principalAsset).safeTransfer(msg.sender, bonus);
        }

        // Waterfall (L-g #1009): bonus (keeper incentive) is paid first, then
        // the lender's debt is satisfied in FULL, and only THEN is the 2%
        // treasury handling fee taken — SUBORDINATED to lender recovery, i.e.
        // capped to whatever surplus remains above the debt. On an underwater
        // close the handling fee collapses to 0 so the treasury never profits
        // while the lender takes a loss. The treasury interest-cut below is the
        // standard `splitTreasury` fee on recovered interest, unchanged.
        uint256 afterBonus = proceeds - bonus;
        uint256 allocated = afterBonus > totalDebt ? totalDebt : afterBonus;
        uint256 surplusAfterDebt = afterBonus - allocated; // 0 when underwater
        uint256 handlingFee = (proceeds * LibVaipakam.cfgLiquidationHandlingFeeBps())
            / LibVaipakam.BASIS_POINTS;
        if (handlingFee > surplusAfterDebt) handlingFee = surplusAfterDebt;
        uint256 borrowerSurplus = surplusAfterDebt - handlingFee;

        uint256 treasuryInterestFee;
        uint256 lenderProceeds;
        if (allocated > loan.principal) {
            uint256 interestRecovered = allocated - loan.principal;
            if (interestRecovered > interestPortion) interestRecovered = interestPortion;
            (treasuryInterestFee, ) = LibEntitlement.splitTreasury(loan, interestRecovered);
            lenderProceeds = allocated - treasuryInterestFee;
        } else {
            lenderProceeds = allocated;
        }

        // Treasury receives the (subordinated) handling fee + interest fee.
        uint256 toTreasury = handlingFee + treasuryInterestFee;
        if (toTreasury > 0) {
            IERC20(loan.principalAsset).safeTransfer(s.treasury, toTreasury);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, toTreasury);
        }

        // Lender's proceeds deposited into lender's vault for claim. #821 —
        // vault-lock so a flagged stored lender doesn't brick the liquidation
        // (T-051 — the Diamond-side transfer ticks protocolTrackedVaultBalance).
        LibSanctionedLock.depositLocked(
            s, loan.lender, loanId, loan.principalAsset, lenderProceeds
        );
        // #998 S10 (#1006 / #1132) — both holders' fail-closed markers are
        // recorded centrally at the `Defaulted` transition (via
        // `EncumbranceMutateFacet.terminalize`).

        // Record lender's claimable proceeds. heldForLender handled by ClaimFacet.
        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: lenderProceeds,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        // #592 — reserve VPFI lender proceeds (deposited into the stored
        // lender's vault, owed to the current holder) against the unstake path
        // until the holder claims; ClaimFacet releases. No-op for non-VPFI.
        if (loan.principalAsset == s.vpfiToken) {
            LibEncumbrance.encumberLenderProceeds(
                loanId, loan.lender, loan.principalAsset, lenderProceeds
            );
        }

        // Borrower surplus: any proceeds remaining after bonus + treasury + lender debt
        if (borrowerSurplus > 0) {
            LibSanctionedLock.depositLocked(
                s, loan.borrower, loanId, loan.principalAsset, borrowerSurplus
            );
            // #998 S10 (#1006 / #1132) — both holders' fail-closed markers are
            // recorded centrally at the `Defaulted` transition (terminalize).
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

        // Phase 5 / §5.2b — HF liquidation is NOT a proper close, so
        // the borrower forfeits any up-front VPFI paid for the LIF.
        // Full held amount flushes to treasury; no rebate.
        LibVPFIDiscount.forfeitBorrowerLif(loan);

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
     *         VPFI / interaction rewards: NOT settled here — the loan is
     *         still alive, so `forfeitBorrowerLif` / `LibInteractionRewards.closeLoan`
     *         do NOT fire. They run at the eventual terminal event.
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
            SwapToRepayIntentFacet(address(this)).forceCancelIntentIfHFBelowOrRevert(loanId);
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
        uint256 endTime = loan.startTime + loan.durationDays * 1 days;
        if (block.timestamp >= endTime) {
            revert PartialAfterMaturity(endTime, block.timestamp);
        }

        LibVaipakam.LiquidityStatus liquidity = OracleFacet(address(this))
            .checkLiquidityOnActiveNetwork(loan.collateralAsset);
        if (liquidity != LibVaipakam.LiquidityStatus.Liquid)
            revert NonLiquidAsset();

        // #395 (Codex r3 P2) — preserve internal-match priority. When the
        // kill-switch is on, the external-swap liquidation paths are blocked
        // for a configurable LTV band immediately above the loan's snapshotted
        // liquidation threshold, giving internal matchers a clean priority
        // slot. `triggerLiquidation` enforces this (after a failed
        // auto-dispatch); the partial path must defer the same way, or a
        // keeper could use `triggerPartialLiquidation` to dump collateral
        // externally mid-window and bypass the ordering. A partial is a
        // smaller action than a full internal match, so it does NOT itself
        // auto-dispatch — it just declines to external-swap inside the window.
        if (s.protocolCfg.internalMatchEnabled) {
            uint256 windowLtv = RiskFacet(address(this)).calculateLTV(loanId);
            uint256 floorBps = uint256(loan.liquidationLtvBpsAtInit);
            uint256 windowCeiling = floorBps + LibVaipakam.cfgExternalLiquidationPriorityWindowBps();
            if (floorBps > 0 && windowLtv < windowCeiling) {
                revert InternalMatchOnlyBand(windowLtv, windowCeiling);
            }
        }

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
        LibSanctionedLock.vaultWithdrawERC20MoveOut(
            LibVaipakam.storageSlot(),
            loan.borrower,
            loan.collateralAsset,
            address(this),
            swappedCollateral
        );
        // #658 (Codex #680 P2) — re-stamp the holder's VPFI tier/staking after
        // the partial collateral slice leaves the vault. No-op for non-VPFI.
        _restampCollateralVpfi(loanId);

        // Oracle-derived expected proceeds + slippage floor, scoped to
        // the slice. Same formula as {triggerLiquidation}.
        uint256 expectedProceeds = LibFallback.expectedSwapOutput(
            address(this),
            loan.collateralAsset,
            loan.principalAsset,
            swappedCollateral
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
            swappedCollateral,
            minOutputAmount,
            address(this),
            adapterCalls
        );
        if (!swapSuccess) revert PartialSwapAllFailed();

        // Debt accounting at partial time. Late fee = 0 by the in-term
        // guard above. interestPortion = currentBorrow - principal.
        uint256 currentBorrowBalance = LibEntitlement.currentBorrowBalance(loan);
        uint256 interestPortion = currentBorrowBalance - loan.principal;

        // Dynamic-incentive bonus — same curve as full, scoped to slice, via
        // the shared {LibEntitlement.liquidatorIncentiveBps} helper.
        uint256 bonus = (proceeds *
            LibEntitlement.liquidatorIncentiveBps(loan.collateralAsset, proceeds, expectedProceeds))
            / LibVaipakam.BASIS_POINTS;
        if (bonus > proceeds) bonus = proceeds;

        // Tiered-KYC for the liquidator — identical to {triggerLiquidation}.
        // The smaller slice means a smaller bonus, less likely to trip
        // the KYC numeraire threshold, but we apply the same check
        // uniformly for predictable bot behaviour.
        _assertLiquidatorKyc(loan.principalAsset, bonus);

        if (bonus > 0) {
            IERC20(loan.principalAsset).safeTransfer(msg.sender, bonus);
        }

        // 2% handling fee on the slice's proceeds. Capped so bonus +
        // handling can't exceed proceeds (matches {triggerLiquidation}).
        uint256 handlingFee = (proceeds * LibVaipakam.cfgLiquidationHandlingFeeBps())
            / LibVaipakam.BASIS_POINTS;
        if (bonus + handlingFee > proceeds) {
            handlingFee = proceeds - bonus;
        }

        // After fees, allocate to debt in order: interest first
        // (treasury cut on it via splitTreasury), then principal. NO
        // late fee — guaranteed zero by the in-term guard.
        uint256 afterFees = proceeds - bonus - handlingFee;
        uint256 interestRepaid;
        uint256 treasuryInterestFee;
        uint256 principalRepaid;
        if (afterFees > interestPortion) {
            interestRepaid = interestPortion;
            (treasuryInterestFee, ) = LibEntitlement.splitTreasury(loan, interestRepaid);
            principalRepaid = afterFees - interestRepaid;
        } else {
            interestRepaid = afterFees;
            (treasuryInterestFee, ) = LibEntitlement.splitTreasury(loan, interestRepaid);
            principalRepaid = 0;
        }

        // Partial can't fully retire principal — that's a full liquidation.
        // The keeper retries with `triggerLiquidation` which closes the
        // loan, refunds surplus collateral, and emits the terminal event.
        if (principalRepaid >= loan.principal) revert PartialFullyClosedUseFull();

        // Treasury receipt — single transfer, same as full.
        address treasury = s.treasury;
        uint256 toTreasury = handlingFee + treasuryInterestFee;
        if (toTreasury > 0) {
            IERC20(loan.principalAsset).safeTransfer(treasury, toTreasury);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, toTreasury);
        }

        // Lender's share goes directly to their vault. We deliberately
        // do NOT write `s.lenderClaims[loanId]` — claims are reserved
        // for terminal events (the lender NFT is still Active, the
        // claim flow runs at proper close / full liquidation / default).
        uint256 lenderProceeds = afterFees - treasuryInterestFee;
        // #821 — vault-lock the lender's share (self-guards a zero amount).
        LibSanctionedLock.depositLocked(
            s, loan.lender, loanId, loan.principalAsset, lenderProceeds
        );

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
        loan.principal -= principalRepaid;
        uint256 remainingDays = (endTime - block.timestamp) / 1 days;
        loan.interestAccrualStart = uint64(block.timestamp);
        loan.interestRemainingDays = uint16(remainingDays);
        // #915 (Codex #1087 r1 P2) — the residual loan restarts its accrual
        // clock at `now`, so any periodic-settled interest (already credited via
        // `currentBorrowBalance` when the slice debt was priced above, and paid
        // interest-first from the swap proceeds) belongs to the closed pre-partial
        // window. Clear it so the shared `interestSettled` credit is not netted a
        // SECOND time on the residual loan's next settlement (which would
        // underpay the lender).
        loan.interestSettled = 0;

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
            interestRepaid,
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
            SwapToRepayIntentFacet(address(this)).forceCancelIntentIfHFBelowOrRevert(loanId);
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

        // #658 — discounted liquidation is a both-side close-out (lender debt +
        // borrower surplus); consolidate transferred sides to current holders
        // before settlement.
        _eagerConsolidateBothSides(loanId);

        // Resolve per-tier discount. `getEffectiveLiquidityTier`
        // returns 0 for unclassified assets — the discount math
        // requires a classified tier so we reject up-front. The
        // atomic-path is the alternative for Liquid-but-unclassified
        // assets; time-based default for Illiquid.
        uint8 tier = OracleFacet(address(this)).getEffectiveLiquidityTier(
            loan.collateralAsset
        );
        if (tier == 0) revert UntierableCollateral(loan.collateralAsset);
        uint16 discountBps = LibVaipakam.effectiveTierLiqDiscountBps(tier);

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

        // Debt — same shape as atomic path.
        uint256 currentBorrowBalance = LibEntitlement.currentBorrowBalance(loan);
        uint256 endTime = loan.startTime + loan.durationDays * 1 days;
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
        uint256 totalDebt = currentBorrowBalance + lateFee;
        uint256 interestPortion = totalDebt - loan.principal;

        // Pull `totalDebt` of principal-asset from msg.sender. The
        // liquidator must have approved the diamond — either by
        // explicit `approve` before this call, or because they just
        // received the funds inside a flash-loan callback that wraps
        // this entry-point. `nonReentrant` on the outer entry-point
        // prevents a malicious-token transferFrom from re-entering the
        // discount path.
        IERC20(loan.principalAsset).safeTransferFrom(
            msg.sender,
            address(this),
            totalDebt
        );

        // Compute seizure size at oracle-priced debt-plus-discount-
        // value. `collateralEquivalent` uses `tryGetAssetPrice` (no
        // revert on stale) so we can fail-soft here with a precise
        // `OracleStaleForDiscount` revert rather than bubbling a
        // generic oracle-feed error.
        uint256 collForDebt = LibFallback.collateralEquivalent(
            address(this),
            totalDebt,
            loan.collateralAsset,
            loan.principalAsset
        );
        if (collForDebt == 0) {
            revert OracleStaleForDiscount(loan.principalAsset, loan.collateralAsset);
        }
        uint256 collateralSeized = (collForDebt *
            (LibVaipakam.BASIS_POINTS + discountBps)) / LibVaipakam.BASIS_POINTS;
        // Cap at available collateral — underwater loans seize all
        // collateral. The liquidator's profit (or loss) is settled
        // off-chain at their own sale price; the protocol's books
        // are clean once `totalDebt` lands at the lender + treasury.
        if (collateralSeized > loan.collateralAmount) {
            collateralSeized = loan.collateralAmount;
        }
        uint256 borrowerSurplus = loan.collateralAmount - collateralSeized;

        // Treasury cut on the interest portion of the debt — identical
        // share as the atomic path. NO handling fee — the discount IS
        // the liquidator's compensation, paid in collateral, not a
        // separate principal-asset bonus.
        (uint256 treasuryInterestFee, ) = LibEntitlement.splitTreasury(loan, interestPortion);
        uint256 lenderProceeds = totalDebt - treasuryInterestFee;

        address treasury = s.treasury;
        if (treasuryInterestFee > 0) {
            IERC20(loan.principalAsset).safeTransfer(treasury, treasuryInterestFee);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, treasuryInterestFee);
        }

        // Lender's proceeds to their vault. #821 — vault-lock for a flagged lender.
        LibSanctionedLock.depositLocked(
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
        // #658 (Codex #680 P2) — re-stamp the holder's VPFI tier/staking after
        // the seized collateral leaves the vault (the surplus stays encumbered
        // in the vault and is reflected in the reduced balance). No-op for
        // non-VPFI; harmless when nothing was seized.
        _restampCollateralVpfi(loanId);

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

        // HF liquidation is NOT a proper close — borrower's VPFI LIF
        // forfeits to treasury. Mirrors {triggerLiquidation}.
        LibVPFIDiscount.forfeitBorrowerLif(loan);

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
        (uint256 price, uint8 feedDecimals) = OracleFacet(address(this))
            .getAssetPrice(principalAsset);
        uint8 tokenDecimals = IERC20Metadata(principalAsset).decimals();
        uint256 bonusNumeraire =
            (bonus * price * 1e18) / (10 ** feedDecimals) / (10 ** tokenDecimals);
        if (!ProfileFacet(address(this)).meetsKYCRequirement(msg.sender, bonusNumeraire))
            revert KYCRequired();
    }

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

        // Record claims in collateral units. ClaimFacet will either rewrite
        // these to principal-asset amounts on a successful retry, or push
        // the collateral to lender/treasury/borrower vaults per this split
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

        // #998 S10 (#1006 / #1132) — capture a confirmed freeze at fallback ENTRY,
        // where the oracle is up (this path is HF-gated). Unlike an atomic
        // liquidation, the lender + borrower shares here are distributed LATER inside
        // a claim that can itself run during an oracle outage (fallback distribution
        // needs no oracle), so entry is the only reliable moment to record an
        // affirmative flag for BOTH the lender claim and the deferred borrower claim.
        // The `EncumbranceMutateFacet.terminalize` host records both holders AT this
        // Active→FallbackPending entry transition (design §2 Invariant A —
        // fallback-entry is a register-triggering edge).

        // Enter fallback-pending state. Borrower may still cure via addCollateral
        // or repayLoan until the lender claims; see LibVaipakam.LoanStatus docs.
        // #1132 (S10 central enforcement) — route through the
        // `EncumbranceMutateFacet.terminalize` host so the validated Active→FallbackPending
        // transition AND both holders' fail-closed frozen-claimant markers land
        // in one place (the standalone registers above were folded here).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.terminalize.selector,
                loanId,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.FallbackPending
            ),
            bytes4(0)
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

        // §1.4 + §1.5 — informational events carry only the loanId primary
        // key. lender + split are recoverable from s.loans[loanId] and
        // s.fallbackSnapshot[loanId] respectively. The
        // {LiquidationFallbackOracleUnavailable} extra event (Phase 2
        // of AutonomousLtvAndOracleFallback.md) fires when the
        // fair-value split was impossible due to stale oracle quorum
        // — the lender absorbed everything in that case.
        emit LiquidationFallback(loanId);
        emit LiquidationFallbackSplit(loanId);
        if (!oracleAvailable) emit LiquidationFallbackOracleUnavailable(loanId);
    }

    // Internal helper for current borrow balance with accrued interest
    /// @dev `_calculateCurrentBorrowBalance` (seconds-precise borrow balance)
    ///      was promoted to {LibEntitlement.currentBorrowBalance} in the #66
    ///      RiskFacet/RiskMatchLiquidationFacet split so both facets share
    ///      one accrual model. Call sites here now read the library helper.

    /// @dev Fetch oracle prices and ERC20 decimals for principal and
    ///      collateral, returning each side's value quoted in the active
    ///      numeraire (USD by post-deploy default). Used by calculateLTV,
    ///      calculateHealthFactor, and isCollateralValueCollapsed — the latter
    ///      previously re-ran the full fetch twice (once per view) for ~6-9k
    ///      of duplicated oracle/staticcall overhead. Numeraire-quoted prices
    ///      come from `OracleFacet.getAssetPrice` (Numeraire generalization (b1)).
    function _computeNumeraireValues(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256 borrowValueNumeraire, uint256 collateralValueNumeraire) {
        uint256 currentBorrowBalance = LibEntitlement.currentBorrowBalance(loan);

        (uint256 borrowPrice, uint8 borrowFeedDecimals) = OracleFacet(address(this))
            .getAssetPrice(loan.principalAsset);
        uint8 borrowTokenDecimals = IERC20Metadata(loan.principalAsset).decimals();
        borrowValueNumeraire = (currentBorrowBalance * borrowPrice) /
            (10 ** borrowFeedDecimals) / (10 ** borrowTokenDecimals);

        (uint256 collateralPrice, uint8 collateralFeedDecimals) = OracleFacet(address(this))
            .getAssetPrice(loan.collateralAsset);
        uint8 collateralTokenDecimals = IERC20Metadata(loan.collateralAsset).decimals();
        collateralValueNumeraire = (loan.collateralAmount * collateralPrice) /
            (10 ** collateralFeedDecimals) / (10 ** collateralTokenDecimals);
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
    ///      a possibly-rotated numeraire). Thresholds are range-clamped at the
    ///      setter, so reads are trusted.
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

    /// @dev #407 PR 4 (T-407-B, 2026-06-12) — release the borrower's
    ///      collateral lien before any liquidation-path vault withdraw
    ///      drains the collateral asset (swap to lender share / treasury
    ///      share / borrower surplus). Wrapped in a private helper so
    ///      the cross-facet `abi.encodeWithSelector` locals don't
    ///      compete with the trigger function's already-large stack
    ///      frame (HF quorum + swap math). Idempotent on already-
    ///      released rows. NFT-rental loans never carry a lien
    ///      (gated at create time in {LibEncumbrance.createCollateralLien}),
    ///      so this is a no-op for those.
    /// @dev #407 PR 4 round-1 (2026-06-12) — consolidated cross-facet
    ///      helpers.
    function _callEncumb1(bytes4 selector, uint256 loanId) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(selector, loanId),
            bytes4(0)
        );
    }

    function _callEncumb2(bytes4 selector, uint256 loanId, uint256 arg2) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(selector, loanId, arg2),
            bytes4(0)
        );
    }

    function _releaseLienAtLiquidation(uint256 loanId) private {
        _callEncumb1(EncumbranceMutateFacet.releaseCollateralLien.selector, loanId);
    }

    function _decrementLienAtPartialLiq(uint256 loanId, uint256 consumed) private {
        _callEncumb2(EncumbranceMutateFacet.decrementCollateralLien.selector, loanId, consumed);
    }
}
