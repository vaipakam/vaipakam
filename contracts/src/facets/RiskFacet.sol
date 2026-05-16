// src/facets/RiskFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
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
import {MetricsFacet} from "./MetricsFacet.sol";
 // For transfers
import {ProfileFacet} from "./ProfileFacet.sol";
 // For KYC if high-value
import {IZeroExProxy} from "../interfaces/IZeroExProxy.sol";
 // For swap calldata encoding
import {LibSwap} from "../libraries/LibSwap.sol";
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

    /// @dev EC-003 Phase 3 — restricts a call to cross-facet only
    ///      (`msg.sender == address(this)`, i.e., another facet inside
    ///      the Diamond reached us via `address(this).call(...)`).
    ///      External callers via the Diamond's fallback have
    ///      `msg.sender == EOA`. Same pattern `EscrowFactoryFacet` uses
    ///      for its cross-facet-only entry-points.
    error OnlyDiamondInternal();
    modifier onlyDiamondInternal() {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        _;
    }

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
    /// @notice L2 sequencer is offline or still in its 1h recovery grace
    ///         window; HF-based liquidation is blocked to avoid swapping
    ///         against stale Chainlink / AMM state.
    error SequencerUnhealthy();

    // ── Internal-liquidation match path (B.2) — PR4 validation errors ──
    /// @notice The master kill-switch (`internalMatchEnabled`) is off.
    error InternalMatchDisabled();
    /// @notice One of the loans referenced isn't in a matchable status
    ///         (`Active` or `FallbackPending`). EC-003 Phase 1 widened the
    ///         allowed set from `{Active}` to `{Active, FallbackPending}`
    ///         so loans whose at-fallback swap failed transiently can
    ///         still be rescued via internal match when conditions
    ///         normalize.
    error InternalMatchLoanNotMatchable(uint256 loanId);
    /// @notice One of the leg assets has no trustworthy oracle price right
    ///         now. Reached when the primary feed is stale past the
    ///         volatile/stable ceiling OR the Soft 2-of-N secondary quorum
    ///         disagrees. Internal match settles at oracle price (no DEX
    ///         swap), so the only blocking condition is "we can't trust
    ///         any number for this asset." EC-003 Phase 1.
    error InternalMatchAssetUnpriceable(address asset);
    /// @notice Caller passed the same loan ID for two legs of a match.
    error InternalMatchSelfPair(uint256 loanId);
    /// @notice The two loans don't form an opposing pair —
    ///         `A.principalAsset == B.collateralAsset` AND
    ///         `A.collateralAsset == B.principalAsset` must both hold.
    error InternalMatchAssetMismatch(uint256 loanIdA, uint256 loanIdB);
    /// @notice The 3-loan chain doesn't form a closed `A→B→C→A` cycle.
    error InternalMatchChainBroken(uint256 loanIdA, uint256 loanIdB, uint256 loanIdC);
    /// @notice The loan's current LTV is below its snapshotted
    ///         liquidation threshold — it isn't liquidatable yet, so
    ///         internal-match can't fire.
    error InternalMatchLtvBelowFloor(uint256 loanId, uint256 currentLtvBps, uint256 floorBps);
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
     * @notice Calculates the current LTV for a loan in basis points.
     * @dev LTV = (borrowedValueNumeraire * 10000) / collateralValueNumeraire.
     *      The numeraire unit cancels in the ratio — LTV is unit-agnostic.
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
    function triggerLiquidation(
        uint256 loanId,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) external nonReentrant whenNotPaused {
        // Tier-1 sanctions gate. The 3% liquidator bonus flows to
        // msg.sender — value receipt by a sanctioned wallet, blocked.
        // Anyone unflagged can still call this; liquidation is not
        // denied, just denied to sanctioned bots / liquidators.
        LibVaipakam._assertNotSanctioned(msg.sender);
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
        if (RiskFacet(address(this)).attemptInternalMatchAutoDispatch(loanId, msg.sender)) {
            return;
        }

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
        uint256 bonusNumeraire = (bonus * price * 1e18) / (10 ** feedDecimals) / (10 ** tokenDecimals);
        if (!ProfileFacet(address(this)).meetsKYCRequirement(msg.sender, bonusNumeraire))
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
            // T-051 — Diamond-side transfer to escrow ticks the
            // protocolTrackedEscrowBalance counter.
            LibVaipakam.recordEscrowDeposit(loan.lender, loan.principalAsset, lenderProceeds);
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
            LibVaipakam.recordEscrowDeposit(loan.borrower, loan.principalAsset, borrowerSurplus);
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

    /// @notice Emitted by `triggerInternalMatchLiquidation` on a valid
    ///         match. PR4 is validation-only and emits this from the
    ///         no-op success path; PR5 will repurpose the same event
    ///         after the execution body lands (cross-vault collateral
    ///         transfer + incentive payout + status transition).
    ///         The two indexed leg fields make event-grep cheap for
    ///         the keeper-bot detector that scans matches.
    /// @custom:event-category state-change/loan-mutation
    event InternalMatchExecuted(
        uint256 indexed loanIdA,
        uint256 indexed loanIdB,
        uint256 loanIdC,
        address matcher,
        uint256 notionalA,
        uint256 notionalB,
        uint256 notionalC,
        uint256 incentivePaidA,
        uint256 incentivePaidB,
        uint256 incentivePaidC
    );

    /**
     * @notice Internal-liquidation match path (B.2 / PR4) — validates a
     *         2-loan or 3-loan match without yet mutating state.
     *
     *         The validation surface ratified in plan-mode Q&A:
     *           1. Kill-switch (`internalMatchEnabled`) must be on.
     *           2. Loans referenced must be `LoanStatus.Active`.
     *           3. No leg may repeat (self-pair / chain-repeat).
     *           4. Asset opposition — 2-loan: `A.principalAsset ==
     *              B.collateralAsset && A.collateralAsset ==
     *              B.principalAsset`; 3-loan chain: `A.principalAsset
     *              == B.collateralAsset && B.principalAsset ==
     *              C.collateralAsset && C.principalAsset ==
     *              A.collateralAsset`.
     *           5. Each leg's current LTV must be at or above its
     *              snapshotted liquidation threshold (`HF < 1` ⇔
     *              loan is liquidatable).
     *           6. Tier-1 sanctions gate on `msg.sender`.
     *
     *         PR4 ships intentionally body-less: after all gates pass
     *         the function emits a placeholder `InternalMatchExecuted`
     *         with zero notional / incentive fields and returns. PR5
     *         fills in the matched-collateral movement + incentive
     *         payout + status transitions. The kill-switch defaults
     *         `false` so production deploys never reach this path
     *         until governance flips it on AFTER PR5 has landed.
     *
     * @param  loanIdA  First leg loan ID.
     * @param  loanIdB  Second leg loan ID (must oppose A).
     * @param  loanIdC  Third leg loan ID for a 3-loan chain, or `0`
     *                  to skip the chain branch and run a 2-loan
     *                  match.
     */
    function triggerInternalMatchLiquidation(
        uint256 loanIdA,
        uint256 loanIdB,
        uint256 loanIdC
    ) external nonReentrant whenNotPaused {
        // Tier-1 sanctions: matcher receives 1% per leg in PR5;
        // blocking sanctioned wallets here keeps the value-receipt
        // path closed.
        LibVaipakam._assertNotSanctioned(msg.sender);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protocolCfg.internalMatchEnabled) revert InternalMatchDisabled();

        // Self-pair / chain-repeat. Includes the C=A and C=B cases
        // when C is non-zero. A zero C means "skip 3-way", so the
        // A/B duplicate is the only check that matters there.
        if (loanIdA == loanIdB) revert InternalMatchSelfPair(loanIdA);
        if (loanIdC != 0) {
            if (loanIdC == loanIdA) revert InternalMatchSelfPair(loanIdA);
            if (loanIdC == loanIdB) revert InternalMatchSelfPair(loanIdB);
        }

        // EC-003 Phase 1 — matchable status set widened from {Active} to
        // {Active, FallbackPending}. FallbackPending loans that failed at-
        // fallback swap transiently (slippage > 6%, DEX revert, oracle stale
        // at that moment) can still be rescued via internal match in a
        // later block when conditions normalize. The oracle gate below
        // filters out FallbackPending legs whose asset *truly* lost its
        // price feed.
        if (
            s.loans[loanIdA].id == 0 ||
            !_isMatchableStatus(s.loans[loanIdA].status)
        ) revert InternalMatchLoanNotMatchable(loanIdA);
        if (
            s.loans[loanIdB].id == 0 ||
            !_isMatchableStatus(s.loans[loanIdB].status)
        ) revert InternalMatchLoanNotMatchable(loanIdB);

        // Asset opposition — 2-loan symmetric form.
        if (loanIdC == 0) {
            if (
                s.loans[loanIdA].principalAsset != s.loans[loanIdB].collateralAsset ||
                s.loans[loanIdA].collateralAsset != s.loans[loanIdB].principalAsset
            ) {
                revert InternalMatchAssetMismatch(loanIdA, loanIdB);
            }
        } else {
            // 3-loan cycle A→B→C→A.
            if (
                s.loans[loanIdC].id == 0 ||
                !_isMatchableStatus(s.loans[loanIdC].status)
            ) revert InternalMatchLoanNotMatchable(loanIdC);
            if (
                s.loans[loanIdA].principalAsset != s.loans[loanIdB].collateralAsset ||
                s.loans[loanIdB].principalAsset != s.loans[loanIdC].collateralAsset ||
                s.loans[loanIdC].principalAsset != s.loans[loanIdA].collateralAsset
            ) {
                revert InternalMatchChainBroken(loanIdA, loanIdB, loanIdC);
            }
        }

        // Per-leg gates. Active legs go through the LTV-floor check
        // (which requires a fresh oracle reading and reverts if the
        // collateral is illiquid or the loan is below the trigger).
        // FallbackPending legs are by definition past the LTV threshold
        // (they already attempted liquidation) — they only need the
        // oracle to be PRICEABLE so the cross-vault transfer settles
        // at a trustworthy number. EC-003 Phase 1.
        _gateMatchableLeg(loanIdA);
        _gateMatchableLeg(loanIdB);
        if (loanIdC != 0) _gateMatchableLeg(loanIdC);

        // PR5 / PR5.5 execution body. Implements partial-match α from
        // §7 of InternalLiquidationLedger.md: each leg moves
        // `min(debt, opposingCollateral)` of the receiving lender's
        // asset, configured % withheld for `msg.sender` (the matcher),
        // remainder to the lender's escrow. Loans whose principal hits
        // zero transition to `LoanStatus.InternalMatched`; partial
        // residuals stay `Active`. PR5.5 extends the 2-way body to
        // 3-loan cycles A→B→C→A — three independent min-match legs.
        if (loanIdC == 0) {
            (
                uint256 movedX,
                uint256 movedY,
                uint256 incentiveX,
                uint256 incentiveY
            ) = _executeTwoWayMatch(loanIdA, loanIdB, msg.sender);
            emit InternalMatchExecuted(
                loanIdA, loanIdB, 0,
                msg.sender,
                movedX, movedY, 0,
                incentiveX, incentiveY, 0
            );
        } else {
            (
                uint256 movedX,
                uint256 movedY,
                uint256 movedZ,
                uint256 incentiveX,
                uint256 incentiveY,
                uint256 incentiveZ
            ) = _executeThreeWayMatch(loanIdA, loanIdB, loanIdC, msg.sender);
            emit InternalMatchExecuted(
                loanIdA, loanIdB, loanIdC,
                msg.sender,
                movedX, movedY, movedZ,
                incentiveX, incentiveY, incentiveZ
            );
        }
    }

    /// @dev Execute the 3-loan chain A→B→C→A version of partial-match α.
    ///      Independent min-match on each leg:
    ///        movedX = min(A.principal, B.collateralAmount)  [B.X → A.lender + matcher]
    ///        movedY = min(B.principal, C.collateralAmount)  [C.Y → B.lender + matcher]
    ///        movedZ = min(C.principal, A.collateralAmount)  [A.Z → C.lender + matcher]
    ///      Each loan whose principal hits zero transitions to
    ///      InternalMatched. Residuals stay Active for the next
    ///      block's matching attempt or external fallback.
    function _executeThreeWayMatch(uint256 loanIdA, uint256 loanIdB, uint256 loanIdC, address matcher)
        private
        returns (
            uint256 movedX,
            uint256 movedY,
            uint256 movedZ,
            uint256 incentiveX,
            uint256 incentiveY,
            uint256 incentiveZ
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage la = s.loans[loanIdA];
        LibVaipakam.Loan storage lb = s.loans[loanIdB];
        LibVaipakam.Loan storage lc = s.loans[loanIdC];

        // EC-003 Phase 1 — rehydrate borrower escrows for any FallbackPending
        // legs in the cycle so the existing _settleLeg withdraws work.
        _rehydrateFallbackEscrowIfNeeded(la);
        _rehydrateFallbackEscrowIfNeeded(lb);
        _rehydrateFallbackEscrowIfNeeded(lc);

        movedX = la.principal < lb.collateralAmount ? la.principal : lb.collateralAmount;
        movedY = lb.principal < lc.collateralAmount ? lb.principal : lc.collateralAmount;
        movedZ = lc.principal < la.collateralAmount ? lc.principal : la.collateralAmount;

        uint256 incentiveBps = LibVaipakam.cfgInternalMatchIncentivePerLegBps();
        incentiveX = (movedX * incentiveBps) / LibVaipakam.BASIS_POINTS;
        incentiveY = (movedY * incentiveBps) / LibVaipakam.BASIS_POINTS;
        incentiveZ = (movedZ * incentiveBps) / LibVaipakam.BASIS_POINTS;

        // Leg X: B's collateral (= A's principal asset) → A.lender + matcher.
        _settleLeg(lb.borrower, la.principalAsset, la.lender, movedX, incentiveX, matcher);
        // Leg Y: C's collateral (= B's principal asset) → B.lender + matcher.
        _settleLeg(lc.borrower, lb.principalAsset, lb.lender, movedY, incentiveY, matcher);
        // Leg Z: A's collateral (= C's principal asset) → C.lender + matcher.
        _settleLeg(la.borrower, lc.principalAsset, lc.lender, movedZ, incentiveZ, matcher);

        // State updates — each loan's principal cleared by its leg,
        // each borrower's collateral debited by the NEXT loan's leg.
        la.principal -= movedX;
        lb.collateralAmount -= movedX;
        lb.principal -= movedY;
        lc.collateralAmount -= movedY;
        lc.principal -= movedZ;
        la.collateralAmount -= movedZ;

        // EC-003 Phase 1 — collateral consumed per leg:
        //   la consumed movedZ (paid out to C's lender)
        //   lb consumed movedX (paid out to A's lender)
        //   lc consumed movedY (paid out to B's lender)
        _settleFallbackOrTransitionPostMatch(la, movedZ);
        _settleFallbackOrTransitionPostMatch(lb, movedX);
        _settleFallbackOrTransitionPostMatch(lc, movedY);
    }

    /// @dev Settle one leg of an internal match — the receiving
    ///      lender gets `moved - incentive`, the matcher gets
    ///      `incentive`. Extracted helper so the 2-way and 3-way
    ///      bodies share the cross-vault transfer logic without
    ///      duplication.
    /// @param matcher Beneficiary of the 1% per-leg incentive. The
    ///        caller MUST pass the genuine matcher explicitly — NOT
    ///        rely on `msg.sender`. On the auto-dispatch path the
    ///        match body runs inside an `onlyDiamondInternal`
    ///        cross-facet call, so `msg.sender` is `address(this)`
    ///        (the Diamond); paying the incentive to `msg.sender`
    ///        there would strand it on the Diamond instead of the
    ///        keeper / lender who triggered settlement.
    function _settleLeg(
        address payingBorrower,
        address asset,
        address receivingLender,
        uint256 moved,
        uint256 incentive,
        address matcher
    ) private {
        if (moved == 0) return;
        uint256 lenderShare = moved - incentive;
        address lenderEscrow = EscrowFactoryFacet(address(this))
            .getOrCreateUserEscrow(receivingLender);
        if (lenderShare > 0) {
            EscrowFactoryFacet(address(this)).escrowWithdrawERC20(
                payingBorrower, asset, lenderEscrow, lenderShare
            );
            EscrowFactoryFacet(address(this)).recordEscrowDepositERC20(
                receivingLender, asset, lenderShare
            );
        }
        if (incentive > 0) {
            EscrowFactoryFacet(address(this)).escrowWithdrawERC20(
                payingBorrower, asset, matcher, incentive
            );
        }
    }

    /// @dev Execute the partial-match α swap between two opposing
    ///      loans. Returns the gross moved amounts and the
    ///      bot-incentive amounts in each leg's asset. Splits the
    ///      withdraws into a 99% lender share + 1% matcher share so
    ///      neither party touches the diamond's balance directly.
    ///      Loans whose principal clears transition to
    ///      `InternalMatched`; partial residuals stay `Active`.
    function _executeTwoWayMatch(uint256 loanIdA, uint256 loanIdB, address matcher)
        private
        returns (uint256 movedX, uint256 movedY, uint256 incentiveX, uint256 incentiveY)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage la = s.loans[loanIdA];
        LibVaipakam.Loan storage lb = s.loans[loanIdB];

        // EC-003 Phase 1 — for FallbackPending legs, the collateral is
        // physically held by the Diamond (was withdrawn from the borrower's
        // escrow during the failed at-fallback swap). Push it back into
        // the borrower's escrow so the existing `_settleLeg` flow can
        // withdraw via the standard path. Idempotent — only fires when
        // `snap.active` is true (i.e., the snapshot hasn't been consumed
        // by a prior match or claim retry).
        _rehydrateFallbackEscrowIfNeeded(la);
        _rehydrateFallbackEscrowIfNeeded(lb);

        // Independent mins on each leg (design §7.1 α): each leg
        // moves the smaller of the receiving lender's owed amount
        // and the paying borrower's available collateral.
        movedX = la.principal < lb.collateralAmount ? la.principal : lb.collateralAmount;
        movedY = lb.principal < la.collateralAmount ? lb.principal : la.collateralAmount;

        uint256 incentiveBps = LibVaipakam.cfgInternalMatchIncentivePerLegBps();
        incentiveX = (movedX * incentiveBps) / LibVaipakam.BASIS_POINTS;
        incentiveY = (movedY * incentiveBps) / LibVaipakam.BASIS_POINTS;

        // Leg X — B's collateral (= A's principal asset) → A.lender + matcher.
        _settleLeg(lb.borrower, la.principalAsset, la.lender, movedX, incentiveX, matcher);
        // Leg Y — A's collateral (= B's principal asset) → B.lender + matcher.
        _settleLeg(la.borrower, lb.principalAsset, lb.lender, movedY, incentiveY, matcher);

        // State updates — debt cleared by the gross moved amount
        // (borrower forfeits the full amount; the incentive % they
        // "would have paid the lender" is reallocated to the matcher).
        la.principal -= movedX;
        lb.collateralAmount -= movedX;
        lb.principal -= movedY;
        la.collateralAmount -= movedY;

        // Status transitions + snapshot scaling. Full match → loan
        // transitions to `InternalMatched`; partial match keeps the
        // loan in its current status (Active or FallbackPending). The
        // helper folds FallbackPending snapshot reduction into the
        // same exit point as the Active-case transition, so both leg
        // statuses converge on a consistent terminal-or-residual shape.
        _settleFallbackOrTransitionPostMatch(la, movedY);
        _settleFallbackOrTransitionPostMatch(lb, movedX);
    }

    /// @dev Internal helper for `triggerInternalMatchLiquidation` —
    ///      reverts `InternalMatchLtvBelowFloor` when the loan's
    ///      current LTV hasn't reached its snapshotted liquidation
    ///      threshold. Illiquid loans (LTV math reverts) revert
    ///      `IlliquidLoanNoRiskMath` from inside `calculateLTV`.
    function _requireLtvAboveFloor(uint256 loanId) private view {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        uint256 floor = uint256(loan.liquidationLtvBpsAtInit);
        uint256 currentLtv = RiskFacet(address(this)).calculateLTV(loanId);
        if (currentLtv < floor) {
            revert InternalMatchLtvBelowFloor(loanId, currentLtv, floor);
        }
    }

    /// @dev EC-003 Phase 1 — status-aware leg gate. Active legs go through
    ///      the LTV-floor check (which implicitly requires a fresh oracle
    ///      via `calculateLTV`). FallbackPending legs skip the LTV check
    ///      (they're past the threshold by definition — they reached
    ///      FallbackPending only because at-fallback liquidation already
    ///      tried and failed) and instead only need the oracle to be
    ///      priceable for BOTH the principal and collateral assets, since
    ///      internal match settles at oracle price.
    function _gateMatchableLeg(uint256 loanId) private view {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        if (loan.status == LibVaipakam.LoanStatus.FallbackPending) {
            _assertOraclePriceable(loan.principalAsset);
            _assertOraclePriceable(loan.collateralAsset);
        } else {
            _requireLtvAboveFloor(loanId);
        }
    }

    /// @dev EC-003 Phase 1 — reverts `InternalMatchAssetUnpriceable` when
    ///      the oracle stack can't return a fresh price for `asset`.
    ///      Mirrors the gate `LibFallback.collateralEquivalent` uses for
    ///      the at-fallback equivalent-value path: `tryGetAssetPrice` must
    ///      return `ok=true` and the price must be non-zero. The
    ///      `getAssetPrice` view this delegates to runs the full Soft
    ///      2-of-N secondary quorum on its way back, so quorum disagreement
    ///      surfaces as `ok=false` here.
    function _assertOraclePriceable(address asset) private view {
        (bool ok, uint256 price, ) = OracleFacet(address(this)).tryGetAssetPrice(asset);
        if (!ok || price == 0) revert InternalMatchAssetUnpriceable(asset);
    }

    /// @dev EC-003 Phase 1 — small predicate keeping the status-set
    ///      widening logic in one place so the gate body in
    ///      `triggerInternalMatchLiquidation` stays scannable.
    function _isMatchableStatus(LibVaipakam.LoanStatus status) private pure returns (bool) {
        return status == LibVaipakam.LoanStatus.Active ||
               status == LibVaipakam.LoanStatus.FallbackPending;
    }

    /// @dev EC-003 Phase 1 — push a FallbackPending loan's collateral
    ///      from the Diamond's own balance back into the borrower's escrow
    ///      so the standard `_settleLeg` `escrowWithdrawERC20` path works
    ///      for the upcoming match.
    ///
    ///      Idempotent: only fires when the loan is FallbackPending AND
    ///      its snapshot is still active (i.e., a prior match retry or
    ///      claim-time retry hasn't already consumed the collateral). Sets
    ///      `snap.active = false` so subsequent partial-match attempts on
    ///      the same loan skip this rehydration — by that point the
    ///      residual collateral already lives in the borrower's escrow.
    function _rehydrateFallbackEscrowIfNeeded(LibVaipakam.Loan storage loan) private {
        if (loan.status != LibVaipakam.LoanStatus.FallbackPending) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.FallbackSnapshot storage snap = s.fallbackSnapshot[loan.id];
        if (!snap.active) return;

        address borrowerEscrow = EscrowFactoryFacet(address(this))
            .getOrCreateUserEscrow(loan.borrower);
        uint256 amount = loan.collateralAmount;
        if (amount > 0) {
            IERC20(loan.collateralAsset).safeTransfer(borrowerEscrow, amount);
            // T-051 — Diamond-side transfer to escrow ticks the
            // protocolTrackedEscrowBalance counter so subsequent
            // `escrowWithdrawERC20` calls don't underflow.
            LibVaipakam.recordEscrowDeposit(loan.borrower, loan.collateralAsset, amount);
        }
        snap.active = false;
    }

    /// @dev EC-003 Phase 1 — post-settlement housekeeping for a loan whose
    ///      principal was reduced by an internal match. Handles three
    ///      cases:
    ///        1. Loan was Active and is now fully matched (`principal == 0`)
    ///           → transition Active → InternalMatched (existing B.2 path).
    ///        2. Loan was FallbackPending and is now fully matched →
    ///           transition FallbackPending → InternalMatched. Snapshot
    ///           was already neutralised by `_rehydrateFallbackEscrowIfNeeded`
    ///           (snap.active = false); clear the collateral-unit claim
    ///           records so the standard Settled-path claim flow takes over.
    ///        3. Loan was FallbackPending and is still partially open
    ///           (`principal > 0`) → stays FallbackPending. The matched
    ///           portion was paid out to the opposing lender via
    ///           `_settleLeg` and the residual collateral lives in the
    ///           borrower's escrow. Scale the (already-zeroed) snapshot's
    ///           reference fields proportionally so any later read sees
    ///           the right shape, and rewrite the claim records to the
    ///           proportional residual.
    ///
    ///      Active partial matches (case 1's residual, where the loan
    ///      stays Active with reduced principal) are a no-op here —
    ///      consistent with the pre-EC-003 B.2 behaviour.
    function _settleFallbackOrTransitionPostMatch(
        LibVaipakam.Loan storage loan,
        uint256 collateralConsumed
    ) private {
        LibVaipakam.LoanStatus status = loan.status;

        // Active branch — same shape as the original B.2 code.
        if (status == LibVaipakam.LoanStatus.Active) {
            if (loan.principal == 0) {
                LibLifecycle.transition(
                    loan,
                    LibVaipakam.LoanStatus.Active,
                    LibVaipakam.LoanStatus.InternalMatched
                );
            }
            return;
        }

        // FallbackPending branch — proportional snapshot scaling +
        // status transition on full match.
        if (status == LibVaipakam.LoanStatus.FallbackPending) {
            LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

            if (loan.principal == 0) {
                // Full rescue. Lender was made whole in principal asset
                // via _settleLeg; treasury's at-fallback entitlement is
                // forfeited (same as the Active→InternalMatched path —
                // no treasury cut on internal-match rescue); borrower's
                // residual collateral sits in their escrow and gets
                // withdrawn via the standard Settled-path claim flow.
                // Clear the collateral-unit claim records so the
                // InternalMatched terminal doesn't double-distribute.
                delete s.lenderClaims[loan.id];
                delete s.borrowerClaims[loan.id];
                LibLifecycle.transitionFromAny(
                    loan,
                    LibVaipakam.LoanStatus.InternalMatched
                );
                return;
            }

            // Partial rescue. Loan stays FallbackPending with reduced
            // principal + collateralAmount. Scale the snapshot's
            // reference fields proportionally to the surviving
            // collateral so any audit-trail read or future settlement
            // sees a self-consistent shape. Claim records — set in
            // collateral units at fallback time — are likewise scaled.
            uint256 oldCollat = loan.collateralAmount + collateralConsumed;
            uint256 newCollat = loan.collateralAmount;
            if (oldCollat == 0 || newCollat >= oldCollat) return;

            LibVaipakam.FallbackSnapshot storage snap = s.fallbackSnapshot[loan.id];
            snap.lenderCollateral = (snap.lenderCollateral * newCollat) / oldCollat;
            snap.treasuryCollateral = (snap.treasuryCollateral * newCollat) / oldCollat;
            snap.borrowerCollateral = (snap.borrowerCollateral * newCollat) / oldCollat;
            snap.lenderPrincipalDue = (snap.lenderPrincipalDue * newCollat) / oldCollat;
            snap.treasuryPrincipalDue = (snap.treasuryPrincipalDue * newCollat) / oldCollat;

            LibVaipakam.ClaimInfo storage lenderClaim = s.lenderClaims[loan.id];
            lenderClaim.amount = snap.lenderCollateral;
            LibVaipakam.ClaimInfo storage borrowerClaim = s.borrowerClaims[loan.id];
            borrowerClaim.amount = snap.borrowerCollateral;
            borrowerClaim.claimed = snap.borrowerCollateral == 0;
        }
    }

    /// @dev EC-003 Phase 3 — auto-dispatch helper. Called from every
    ///      external-liquidation entry-point (`triggerLiquidation`,
    ///      `triggerDefault`, `claimAsLenderWithRetry`) BEFORE the
    ///      external-aggregator path so that any opposing-direction
    ///      internal-match candidate gets settled at oracle price
    ///      (zero aggregator slippage) first.
    ///
    ///      Returns `true` iff the auto-dispatch fired and the
    ///      caller should NOT fall through to the external path.
    ///      Returns `false` when:
    ///        - the kill-switch is off,
    ///        - no opposing candidate exists in the asset-pair index,
    ///        - the candidate fails the per-leg gates (oracle
    ///          priceability + Active-leg LTV-floor) — all already
    ///          filtered by `hasInternalMatchCandidate`.
    ///
    ///      The 1% matcher bonus is paid to `matcher` — which the
    ///      outer entry-point MUST pass as its own `msg.sender`. It
    ///      cannot be derived from `msg.sender` here: this function
    ///      runs inside an `onlyDiamondInternal` cross-facet call, so
    ///      `msg.sender` is `address(this)` (the Diamond). Threading
    ///      the beneficiary explicitly keeps the incentive flowing to
    ///      the keeper / lender who triggered settlement instead of
    ///      stranding it on the Diamond.
    /// @param loanId  The loan being liquidated / claimed.
    /// @param matcher The 1%-per-leg incentive beneficiary — the
    ///        `msg.sender` of the outer `triggerLiquidation` /
    ///        `triggerDefault` / `claimAsLender*` call.
    function attemptInternalMatchAutoDispatch(uint256 loanId, address matcher)
        external
        onlyDiamondInternal
        returns (bool dispatched)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protocolCfg.internalMatchEnabled) return false;

        (bool found, uint256 candidateId) = MetricsFacet(address(this))
            .hasInternalMatchCandidate(loanId);
        if (!found) return false;

        // Settlement. `hasInternalMatchCandidate` has already filtered
        // candidates by status (Active or FallbackPending), oracle
        // priceability (both assets), and — for Active candidates —
        // LTV-floor eligibility. The caller-loan side has been
        // gated by the outer entry-point (HF<1 for triggerLiquidation,
        // time-default conditions for triggerDefault, FallbackPending
        // status for claim-time retry). `_executeTwoWayMatch` runs
        // the partial-match α math + per-leg settlement + post-match
        // snapshot scaling + lifecycle transition.
        (
            uint256 movedX,
            uint256 movedY,
            uint256 incentiveX,
            uint256 incentiveY
        ) = _executeTwoWayMatch(loanId, candidateId, matcher);

        emit InternalMatchExecuted(
            loanId, candidateId, 0,
            matcher,
            movedX, movedY, 0,
            incentiveX, incentiveY, 0
        );
        return true;
    }

    /**
     * @notice HF-based liquidation via a **sum-to-input multi-route
     *         split swap** — the higher-LTV-aware sibling of
     *         {triggerLiquidation}. Used when off-chain quote analysis
     *         shows a single adapter can't absorb the full liquidation
     *         size at acceptable slippage but splitting across two-or-
     *         more adapters can (depth-tiered LTV regime, the design's
     *         "thinner cushion at liquidation" branch).
     *
     *         Routes the collateral through `LibSwap.swapWithSplit`
     *         instead of `swapWithFailover`. Critically: **split is
     *         atomic — any single leg revert reverts the whole tx, no
     *         soft-failure / full-collateral-transfer fallback path.**
     *         The keeper rationally only uses split when every leg's
     *         quote analysis says it'll succeed; if a leg reverts
     *         on-chain (price moved between quote and submission), the
     *         retry path is {triggerLiquidation} (failover), which
     *         handles soft-failure cleanly.
     *
     *         All other surface — pre-checks (sanctions, sequencer
     *         circuit-breaker, HF<1, liquid-asset gate), collateral
     *         withdrawal, expected-proceeds + minOutputAmount math, and
     *         the entire post-swap distribution (dynamic incentive,
     *         tiered-KYC, treasury / lender / borrower-surplus split,
     *         lifecycle transition Active→Defaulted, VPFI forfeit,
     *         interaction-rewards close, NFT-status updates,
     *         `HFLiquidationTriggered` event) — is identical to
     *         {triggerLiquidation}. The duplication is deliberate: keeps
     *         the existing battle-tested path untouched. A future PR
     *         (alongside partial-liquidation work — item 2 of the
     *         liquidator-hardening list) can consolidate both into
     *         shared helpers.
     * @param loanId   Loan being liquidated. Must be Active with HF<1.
     * @param splits   The split spec — `sum(splitAmount) == loan.collateralAmount`,
     *                 each `adapterIdx` ∈ `[0, swapAdapters.length)`,
     *                 each `data` is the keeper-supplied per-adapter
     *                 calldata (aggregator routes recommended; raw V3 /
     *                 Balancer adapters offer no slippage protection
     *                 in split mode — see LibSwap.swapWithSplit).
     */
    function triggerLiquidationSplit(
        uint256 loanId,
        LibSwap.SplitCall[] calldata splits
    ) external nonReentrant whenNotPaused {
        // Sanctions / sequencer / HF / liquidity gates — identical to
        // {triggerLiquidation}.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert InvalidLoan();
        if (!OracleFacet(address(this)).sequencerHealthy()) {
            revert SequencerUnhealthy();
        }
        uint256 hf = RiskFacet(address(this)).calculateHealthFactor(loanId);
        if (hf >= LibVaipakam.HF_SCALE) revert HealthFactorNotLow();
        LibVaipakam.LiquidityStatus liquidity = OracleFacet(address(this))
            .checkLiquidityOnActiveNetwork(loan.collateralAsset);
        if (liquidity != LibVaipakam.LiquidityStatus.Liquid)
            revert NonLiquidAsset();

        // Withdraw collateral to Diamond for the split swap.
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

        // Oracle-derived total minOutputAmount — same formula as the
        // failover path. swapWithSplit enforces it on the *total* (not
        // per-leg) so leg-asymmetric outcomes don't pessimistically fail.
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

        // The split swap. Reverts on sum mismatch, any leg revert, or
        // total < minOutputAmount — no soft-failure return path.
        uint256 proceeds = LibSwap.swapWithSplit(
            loanId,
            loan.collateralAsset,
            loan.principalAsset,
            loan.collateralAmount,
            minOutputAmount,
            address(this),
            splits
        );

        // Calculate debt — identical to {triggerLiquidation}.
        uint256 currentBorrowBalance = _calculateCurrentBorrowBalance(loan);
        uint256 endTime = loan.startTime + loan.durationDays * 1 days;
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
        uint256 totalDebt = currentBorrowBalance + lateFee;
        uint256 interestPortion = totalDebt - loan.principal;

        // Dynamic liquidator incentive — identical to {triggerLiquidation}.
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

        // Tiered-KYC check for the liquidator — identical to {triggerLiquidation}.
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

        // Distribution — identical to {triggerLiquidation}.
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
        address lenderEscrow = LibFacet.getOrCreateEscrow(loan.lender);
        if (lenderProceeds > 0) {
            IERC20(loan.principalAsset).safeTransfer(lenderEscrow, lenderProceeds);
            LibVaipakam.recordEscrowDeposit(loan.lender, loan.principalAsset, lenderProceeds);
        }
        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: lenderProceeds,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        if (borrowerSurplus > 0) {
            address borrowerEscrow = LibFacet.getOrCreateEscrow(loan.borrower);
            IERC20(loan.principalAsset).safeTransfer(borrowerEscrow, borrowerSurplus);
            LibVaipakam.recordEscrowDeposit(loan.borrower, loan.principalAsset, borrowerSurplus);
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
     *         reverts and the slice stays in the borrower's escrow.
     *
     *         Maturity preservation: the loan's `endTime` is unchanged.
     *         Implementation rewires `startTime = block.timestamp` AND
     *         shortens `durationDays` so `startTime + durationDays * 1 days`
     *         is invariant. From now on, interest accrues on the reduced
     *         principal for the remaining duration only.
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

        // Withdraw only the slice from the borrower's escrow. If the
        // swap reverts downstream, the wrapping `revert` here unwinds
        // the withdraw too (single tx, all storage rolled back) — no
        // manual refund needed.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowWithdrawERC20.selector,
                loan.borrower,
                loan.collateralAsset,
                address(this),
                swappedCollateral
            ),
            EscrowWithdrawFailed.selector
        );

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
        uint256 currentBorrowBalance = _calculateCurrentBorrowBalance(loan);
        uint256 interestPortion = currentBorrowBalance - loan.principal;

        // Dynamic-incentive bonus — same formula as full, scoped to slice.
        uint256 realizedSlippageBps;
        if (proceeds < expectedProceeds && expectedProceeds > 0) {
            realizedSlippageBps = ((expectedProceeds - proceeds) * LibVaipakam.BASIS_POINTS)
                / expectedProceeds;
            if (realizedSlippageBps > maxSlippageBps) {
                realizedSlippageBps = maxSlippageBps;
            }
        }
        uint256 maxIncentiveBps = LibVaipakam.cfgMaxLiquidatorIncentiveBps();
        uint256 incentiveBps = maxSlippageBps - realizedSlippageBps;
        if (incentiveBps > maxIncentiveBps) incentiveBps = maxIncentiveBps;
        uint256 assetCapBps = s.assetRiskParams[loan.collateralAsset].liqBonusBps;
        if (assetCapBps != 0 && incentiveBps > assetCapBps) incentiveBps = assetCapBps;
        uint256 bonus = (proceeds * incentiveBps) / LibVaipakam.BASIS_POINTS;
        if (bonus > proceeds) bonus = proceeds;

        // Tiered-KYC for the liquidator — identical to {triggerLiquidation}.
        // The smaller slice means a smaller bonus, less likely to trip
        // the KYC numeraire threshold, but we apply the same check
        // uniformly for predictable bot behaviour.
        (uint256 price, uint8 feedDecimals) = OracleFacet(address(this))
            .getAssetPrice(loan.principalAsset);
        uint8 tokenDecimals = IERC20Metadata(loan.principalAsset).decimals();
        uint256 bonusNumeraire = (bonus * price * 1e18) / (10 ** feedDecimals) / (10 ** tokenDecimals);
        if (!ProfileFacet(address(this)).meetsKYCRequirement(msg.sender, bonusNumeraire))
            revert KYCRequired();

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
            (treasuryInterestFee, ) = LibEntitlement.splitTreasury(interestRepaid);
            principalRepaid = afterFees - interestRepaid;
        } else {
            interestRepaid = afterFees;
            (treasuryInterestFee, ) = LibEntitlement.splitTreasury(interestRepaid);
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

        // Lender's share goes directly to their escrow. We deliberately
        // do NOT write `s.lenderClaims[loanId]` — claims are reserved
        // for terminal events (the lender NFT is still Active, the
        // claim flow runs at proper close / full liquidation / default).
        uint256 lenderProceeds = afterFees - treasuryInterestFee;
        if (lenderProceeds > 0) {
            address lenderEscrow = LibFacet.getOrCreateEscrow(loan.lender);
            IERC20(loan.principalAsset).safeTransfer(lenderEscrow, lenderProceeds);
            LibVaipakam.recordEscrowDeposit(loan.lender, loan.principalAsset, lenderProceeds);
        }

        // Mutate the loan: reduce collateral + principal, restart the
        // interest clock at now, shorten `durationDays` so `endTime` is
        // preserved exactly. The lender's term is unchanged.
        loan.collateralAmount -= swappedCollateral;
        loan.principal -= principalRepaid;
        uint256 remainingDays = (endTime - block.timestamp) / 1 days;
        loan.startTime = uint64(block.timestamp);
        loan.durationDays = remainingDays;

        // Post-mutation HF check. Strictly improves AND must reach >= 1.
        // If `remainingDays` rounded down to 0 (partial in the loan's
        // last sub-day), the loan effectively matures next block — the
        // HF read is still correct since `currentBorrow` re-derives from
        // the now-tiny principal, so this branch reverts naturally if
        // HF is still below 1.
        uint256 hfAfter = RiskFacet(address(this)).calculateHealthFactor(loanId);
        if (hfAfter <= hfBefore) revert PartialMustImproveHF(hfBefore, hfAfter);
        if (hfAfter < LibVaipakam.HF_SCALE) revert PartialMustRestoreHF(hfAfter);

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
     *         - L2 sequencer circuit-breaker.
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
     *           - diamond → lender escrow: principal + remaining
     *             interest + late fee (full lender entitlement).
     *           - borrower escrow → recipient: `collateralSeized`
     *             collateral-asset.
     *           - borrower escrow keeps: `borrowerSurplus`
     *             collateral-asset (never withdrawn — already in their
     *             escrow, available via standard escrow withdrawal).
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
        // Tier-1 sanctions gate — `msg.sender` authored the trade; the
        // seizure flows to `recipient` but the caller is the one
        // earning the discount-net-of-execution-cost profit.
        LibVaipakam._assertNotSanctioned(msg.sender);

        // Master kill-switch — discount path off by default.
        if (!LibVaipakam.cfgDiscountPathEnabled()) revert DiscountPathDisabled();

        // Recipient sanity — zero would burn the collateral.
        if (recipient == address(0)) revert ZeroRecipient();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert InvalidLoan();

        // L2 circuit-breaker — same as atomic path. While the
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
        uint256 currentBorrowBalance = _calculateCurrentBorrowBalance(loan);
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
        (uint256 treasuryInterestFee, ) = LibEntitlement.splitTreasury(interestPortion);
        uint256 lenderProceeds = totalDebt - treasuryInterestFee;

        address treasury = s.treasury;
        if (treasuryInterestFee > 0) {
            IERC20(loan.principalAsset).safeTransfer(treasury, treasuryInterestFee);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, treasuryInterestFee);
        }

        // Lender's proceeds to their escrow.
        address lenderEscrow = LibFacet.getOrCreateEscrow(loan.lender);
        if (lenderProceeds > 0) {
            IERC20(loan.principalAsset).safeTransfer(lenderEscrow, lenderProceeds);
            LibVaipakam.recordEscrowDeposit(loan.lender, loan.principalAsset, lenderProceeds);
        }

        // Record lender claim metadata for NFT-state tracking.
        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: lenderProceeds,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });

        // Withdraw `collateralSeized` from borrower escrow directly to
        // `recipient`. The remaining `borrowerSurplus` stays in the
        // borrower's escrow as a regular balance — the borrower
        // retrieves it via standard escrow withdrawal, no claim
        // ceremony required.
        if (collateralSeized > 0) {
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EscrowFactoryFacet.escrowWithdrawERC20.selector,
                    loan.borrower,
                    loan.collateralAsset,
                    recipient,
                    collateralSeized
                ),
                EscrowWithdrawFailed.selector
            );
        }

        // Record borrower claim metadata — but the surplus is in
        // COLLATERAL units (not principal), and is already in the
        // borrower's escrow. The `ClaimInfo` row records what the
        // discount-path settlement left them with for off-chain
        // accounting + the lender / borrower NFT metadata. `claimed`
        // is set true when the surplus is zero (nothing to claim).
        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: borrowerSurplus,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: borrowerSurplus == 0
        });

        // Lifecycle: Active → Defaulted. Same terminal as atomic-path
        // liquidations.
        LibLifecycle.transition(
            loan,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.Defaulted
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
    ///      collateral, returning each side's value quoted in the active
    ///      numeraire (USD by post-deploy default). Used by calculateLTV,
    ///      calculateHealthFactor, and isCollateralValueCollapsed — the latter
    ///      previously re-ran the full fetch twice (once per view) for ~6-9k
    ///      of duplicated oracle/staticcall overhead. Numeraire-quoted prices
    ///      come from `OracleFacet.getAssetPrice` (Numeraire generalization (B1)).
    function _computeNumeraireValues(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256 borrowValueNumeraire, uint256 collateralValueNumeraire) {
        uint256 currentBorrowBalance = _calculateCurrentBorrowBalance(loan);

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

    /// @dev Get 0x Proxy address
    function _getZeroExProxy() internal view returns (address) {
        return LibVaipakam.storageSlot().zeroExProxy;
    }

    /// @dev Get 0x Proxy address
    function _getAllowanceTarget() internal view returns (address) {
        return LibVaipakam.storageSlot().allowanceTarget;
    }
}
