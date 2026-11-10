// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {LibDiscountedLiquidation} from "../libraries/LibDiscountedLiquidation.sol";
import {LibInternalMatchPriority} from "../libraries/LibInternalMatchPriority.sol";
import {LibForcedSalePlan} from "../libraries/LibForcedSalePlan.sol";
import {ForcedSaleFacet} from "./ForcedSaleFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";

/**
 * @title  ForcedSalePreviewFacet
 * @author Vaipakam Developer Team
 * @notice The forced-sale previews a keeper sizes every forced close-out from:
 *         {previewForcedSale} (the sale `ForcedSaleFacet.sellToNeed` would
 *         make) and {previewDiscountedLiquidation} (the discount path).
 * @dev    Split off ForcedSaleFacet along its read / write seam (#3205 part 2):
 *         ForcedSaleFacet had reached 11 bytes under EIP-170. The sale and this
 *         preview size through the one rule in {LibForcedSalePlan}. Same
 *         storage, same selectors and call surface; only the runtime bytecode
 *         moved. Read-only: nothing here moves value.
 */
contract ForcedSalePreviewFacet {

    /**
     * @notice The size of the forced sale `kind` would make on `loanId` now:
     *         the debt, the need, the collateral to sell, the floor every
     *         route must deliver, whether that floor covers the need, and
     *         the largest quote a sale accepts.
     * @dev    A keeper builds its adapter calldata for an amount from `sell`
     *         to `maxSell` and passes that amount with the call: an
     *         aggregator quote encodes the sell amount, and a sale only ever
     *         sells the amount it was quoted for. Quoting a little above
     *         `sell` leaves room for the interest that accrues before the
     *         block. A sale that will run needs a fresh price on both
     *         assets; without one this reverts with the price reader's own
     *         error, as the sale itself would (a default is the exception:
     *         its unpriced pair takes the fallback, below). Returns an all-zero plan when no sale of this kind is
     *         due now: the loan is not Active; periodic — nothing is owed,
     *         or the settlement is not yet allowed (the period's grace is not
     *         over, periodic interest is off, the loan has no cadence);
     *         Health-Factor — the loan is healthy; default — its grace
     *         period has not ended, or the default would take a route that
     *         sells nothing ({LibDefaultRoute}: an unpriced pair entering
     *         the fallback, an in-kind move, a refused default), so a caller
     *         sends that default with no quote and an empty try-list. The
     *         caller's other gates (the sequencer, the internal-match
     *         window) still apply. A distrusted price reverts, as the
     *         default itself would (#666).
     */
    function previewForcedSale(uint256 loanId, ForcedSaleFacet.ForcedSaleKind kind)
        external
        view
        returns (ForcedSaleFacet.ForcedSalePlan memory plan)
    {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        if (!LibForcedSalePlan.isDue(loan, kind)) return plan;
        uint256 debt = LibForcedSalePlan.debtFor(loan, kind);
        if (debt == 0) return plan;
        (plan, ) = LibForcedSalePlan.planFor(loan, debt);
    }

    /**
     * @notice The discounted liquidation of `loanId` as it would run now
     *         ({RiskDiscountedLiquidationFacet.triggerLiquidationDiscounted}):
     *         whether it can, and if so the debt the liquidator pays and the
     *         collateral it receives (#2697).
     * @dev    Not a sale through this host: on the discount path the
     *         liquidator buys the collateral with its own funds. It is
     *         previewed here, beside {previewForcedSale}, so a keeper reads
     *         the size of every forced close-out it can send from one facet.
     *         The figures come from {LibDiscountedLiquidation}, the rule the
     *         liquidation itself charges and seizes by, so a reader in the
     *         same transaction (a flash-loan receiver) gets exactly the
     *         liquidation's figures; read earlier, the debt can only have
     *         grown by the block that settles. One exception: for a
     *         collateral token that delivers less than it sends, the
     *         recipient receives less than `seized`, and a liquidation that
     *         first moves the collateral to a new borrower-NFT holder can
     *         seize less (see {LibDiscountedLiquidation}), so `seized` is an
     *         upper bound on what arrives.
     *
     *         `status` is the first check that fails, in the liquidation's
     *         own order; the figures are filled only when it is `Ready`,
     *         except the assets, which are always the loan's. Not checked
     *         here because they depend on who calls: the caller's and
     *         recipient's sanctions screens, and the liquidator's funds and
     *         approval. A distrusted price reverts, as the liquidation
     *         itself would (#666), and so does a Health Factor read that
     *         cannot price the loan: `Unpriced` is the case where the Health
     *         Factor was read but the seizure's own rate is unavailable.
     */
    function previewDiscountedLiquidation(uint256 loanId)
        external
        view
        returns (LibDiscountedLiquidation.Preview memory p)
    {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        p.principalAsset = loan.principalAsset;
        p.collateralAsset = loan.collateralAsset;
        if (LibPausable.paused()) return p; // Status.Paused
        if (!LibVaipakam.cfgDiscountPathEnabled()) {
            p.status = LibDiscountedLiquidation.Status.Disabled;
            return p;
        }
        if (loan.status != LibVaipakam.LoanStatus.Active) {
            p.status = LibDiscountedLiquidation.Status.NotActive;
            return p;
        }
        if (!OracleFacet(address(this)).sequencerHealthy()) {
            p.status = LibDiscountedLiquidation.Status.SequencerUnhealthy;
            return p;
        }
        if (RiskFacet(address(this)).calculateHealthFactor(loanId) >= LibVaipakam.HF_SCALE) {
            p.status = LibDiscountedLiquidation.Status.Healthy;
            return p;
        }
        // #2734 — the liquidation defers to an internal match inside the
        // priority window; the preview asks the same rule.
        (bool inWindow,,) = LibInternalMatchPriority.window(loanId, loan);
        if (inWindow) {
            p.status = LibDiscountedLiquidation.Status.InternalMatchWindow;
            return p;
        }
        (p.tier, p.discountBps) = LibDiscountedLiquidation.discountFor(loan);
        if (p.tier == 0) {
            p.status = LibDiscountedLiquidation.Status.Untiered;
            return p;
        }
        uint256 debt = LibDiscountedLiquidation.debt(loan);
        (bool priced, uint256 seized) = LibDiscountedLiquidation.seizure(loan, debt, p.discountBps);
        if (!priced) {
            p.status = LibDiscountedLiquidation.Status.Unpriced;
            return p;
        }
        p.status = LibDiscountedLiquidation.Status.Ready;
        p.debt = debt;
        p.seized = seized;
        p.surplus = loan.collateralAmount - seized;
    }
}
