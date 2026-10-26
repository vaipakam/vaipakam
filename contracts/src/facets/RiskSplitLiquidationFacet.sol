// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibPrepayCleanup} from "../libraries/LibPrepayCleanup.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {NumeraireValueFacet} from "./NumeraireValueFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {ProfileFacet} from "./ProfileFacet.sol";
import {SwapToRepayIntentFacet} from "./SwapToRepayIntentFacet.sol";
import {ForcedSaleFacet} from "./ForcedSaleFacet.sol";

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
 *         Identical pre-checks and lifecycle to
 *         {RiskFacet.triggerLiquidation}; the sale itself — its size, the
 *         lien, the pull and the division of the proceeds — is the one
 *         forced-sale rule on {ForcedSaleFacet} (#2796), which both routes
 *         share. All facets share Diamond storage via {LibVaipakam}.
 */
contract RiskSplitLiquidationFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{

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
     *         The sale is sized to the debt and divided by the shared
     *         forced-sale rule ({ForcedSaleFacet.sellToNeed}), exactly as
     *         on {RiskFacet.triggerLiquidation}; the tiered-KYC check, the
     *         Active→Defaulted transition, the VPFI forfeit, the
     *         interaction-rewards close, the NFT-status updates and the
     *         `HFLiquidationTriggered` event are identical too.
     *
     * @param loanId   Loan being liquidated. Must be Active with HF<1.
     * @param splits   The split spec. `sum(splitAmount)` is the collateral
     *                 sold and must lie between
     *                 `previewForcedSale(loanId, HealthFactorSplitLiquidation)`'s
     *                 `sell` and `maxSell` at the settling block
     *                 (`ForcedSaleQuoteOutOfRange` otherwise); each
     *                 `adapterIdx` ∈ `[0, swapAdapters.length)`, each `data`
     *                 the keeper-supplied per-adapter calldata.
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
            SwapToRepayIntentFacet(address(this)).forceCancelIntentFor(
                loanId, SwapToRepayIntentFacet.ForceCancelReason.HFBelowLiquidationThreshold
            );
        }
        // Sanctions / sequencer / HF / liquidity gates — identical to
        // {RiskFacet.triggerLiquidation}.
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.status != LibVaipakam.LoanStatus.Active) revert InvalidLoan();
        // T-086 step 10 — clear any active prepay listing before liquidation.
        LibPrepayCleanup.clearActiveListing(loan, loanId);
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

        // #2796 — the forced-sale host sizes the sale to the debt and sells
        // exactly the sum of the legs, which must lie in the plan's accepted
        // range (the least collateral whose worst-case proceeds cover the
        // debt plus the largest charges, up to the host's margin above it).
        // It lowers the collateral lien by that sum and pulls it under the
        // move-out exemption (#821), so the collateral the sale leaves stays
        // liened in the borrower's vault for their claim. The split is atomic
        // (`LibSwap.swapWithSplit`): a sum mismatch with what arrived (#2440:
        // legs are fixed aggregator quotes and are never rescaled), any leg
        // revert, a governance-disabled venue (#633) or a total below the
        // floor of what was sold reverts the whole call — there is no
        // fallback on this route; {RiskFacet.triggerLiquidation} is the
        // failover retry. The proceeds are divided by the shared rule:
        // keeper bonus, the lender's debt in full, the 2% handling fee on the
        // debt subordinated to the lender, the rest held for the borrower.
        uint256 quoted;
        for (uint256 i; i < splits.length; ++i) quoted += splits[i].splitAmount;
        ForcedSaleFacet.ForcedSaleOutcome memory out = abi.decode(
            LibFacet.crossFacetCallReturn(
                abi.encodeCall(
                    ForcedSaleFacet.sellToNeed,
                    (
                        loanId,
                        ForcedSaleFacet.ForcedSaleKind.HealthFactorSplitLiquidation,
                        quoted,
                        new LibSwap.AdapterCall[](0),
                        splits,
                        msg.sender
                    )
                ),
                bytes4(0)
            ),
            (ForcedSaleFacet.ForcedSaleOutcome)
        );

        // Tiered-KYC check for the liquidator — identical to {RiskFacet.triggerLiquidation}:
        // the bonus valued through the one shared rule, rounded down (#2419).
        uint256 bonusNumeraire = NumeraireValueFacet(address(this))
            .getNumeraireValue(loan.principalAsset, out.keeperBonus, false);
        if (!ProfileFacet(address(this)).meetsKYCRequirement(msg.sender, bonusNumeraire))
            revert KYCRequired();

        // Close loan + VPFI forfeit + rewards + NFT status — identical.
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
        emit HFLiquidationTriggered(loanId, msg.sender, out.proceeds);
    }
}
