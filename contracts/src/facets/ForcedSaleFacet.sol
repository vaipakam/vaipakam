// src/facets/ForcedSaleFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibSaleSizing} from "../libraries/LibSaleSizing.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibCloseoutFreeze} from "../libraries/LibCloseoutFreeze.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title ForcedSaleFacet
 * @author Vaipakam Developer Team
 * @notice The ONE place a forced sale is sized, sold and divided
 *         (#2796, #2795; design `docs/DesignsAndPlans/ForcedSaleSizingDesign.md`).
 *         A forced sale sells only what the debt needs: the least collateral
 *         whose worst-case proceeds cover the debt plus the largest charges.
 *         The charges are on the debt, the lender is paid first, and what the
 *         sale raised above the lender and the charges goes back to the
 *         borrower (owner decisions 2026-10-25).
 * @dev Part of the Diamond Standard (EIP-2535).
 *
 *      FIRST USER: the periodic-interest settlement
 *      ({RepayPeriodicFacet.settlePeriodicInterest}). The Health-Factor
 *      liquidation routes and the time-based default move onto this host in
 *      later changes; {ForcedSaleKind} grows with them.
 *
 *      THE RULE, with `D` the debt the sale settles (periodic: the period's
 *      shortfall), `f` the handling-fee rate, `bMax` the largest keeper-bonus
 *      rate (`cfgMaxLiquidatorIncentiveBps`, lowered by the collateral's
 *      per-asset `liqBonusBps`) and `cap` the liquidation slippage cap:
 *      - need `N = D + ⌈f·D⌉ + ⌈bMax·D⌉`;
 *      - sell the least `x ≤ C` whose floor (oracle value less `cap`) is
 *        `≥ N` ({LibSaleSizing}); the floor is the minimum every route must
 *        deliver, so a filled covered sale always pays the lender in full;
 *      - when no `x ≤ C` covers `N`, sell all of `C` at its own floor and say
 *        so (`covered = false`);
 *      - with proceeds `P`: bonus `B = b·min(D, P)` first (`b` is the shared
 *        execution-quality curve, {LibEntitlement.liquidatorIncentiveBps}),
 *        lender `L = min(D, P − B)`, handling fee `F = min(f·D, P − B − L)`
 *        subordinated to the lender, borrower extra `X = P − B − L − F`.
 *
 *      TRUST MODEL: every mutator is `address(this)`-gated and carries no
 *      reentrancy guard of its own, because every caller already holds the
 *      Diamond guard. The plan a caller passes in is the Diamond's own
 *      {previewForcedSale} output, read in the same transaction.
 *
 *      Refresh-together family: this facet + every facet that sells through
 *      it (RepayPeriodicFacet today). A caller refreshed without the host
 *      reverts `FunctionDoesNotExist` on every forced sale — a hard revert,
 *      never a silent old waterfall.
 */
contract ForcedSaleFacet is IVaipakamErrors {
    /// @notice Which forced sale a plan is for. Values are append-only.
    enum ForcedSaleKind {
        PeriodicSettlement
    }

    /// @notice The size of a forced sale, computed before anything moves.
    /// @param debt    `D`: what the sale must pay the lender.
    /// @param need    `N`: the debt plus the largest handling fee and the
    ///                largest keeper bonus, each rounded up.
    /// @param sell    Collateral the sale offers: the least amount whose
    ///                floor covers `need`, or all of it when none does.
    /// @param floor   The least proceeds every route must deliver for `sell`
    ///                (its oracle value less the liquidation slippage cap).
    /// @param covered True when `floor >= need`.
    struct ForcedSalePlan {
        uint256 debt;
        uint256 need;
        uint256 sell;
        uint256 floor;
        bool covered;
    }

    /// @notice Every figure of one forced sale. Nothing is left to be
    ///         inferred from balance changes.
    /// @param loanId            The loan.
    /// @param kind              Which forced sale ({ForcedSaleKind}).
    /// @param debt              `D`.
    /// @param need              `N`.
    /// @param collateralSold    Collateral that reached the Diamond and was sold.
    /// @param proceeds          `P`: lending-asset proceeds that arrived.
    /// @param lenderPaid        What the lender received (or what was held for
    ///                          a frozen lender holder), at most `debt`.
    /// @param handlingFee       `F`, to the treasury.
    /// @param keeperBonus       `B`, to the caller.
    /// @param borrowerExtra     `X`, the borrower's share of the proceeds.
    /// @param borrowerExtraHeld True when `X` was held in the borrower's vault
    ///                          for the claim instead of paid to the holder's
    ///                          wallet.
    /// @param collateralUnsold  Collateral the sale left with the loan.
    /// @param covered           Whether the sale's floor covered the need.
    /// @param keeper            Who submitted the sale and received `B`.
    /// @dev    The breakdown only: the loan's own change is carried by the
    ///         kind's state event in the same transaction
    ///         (`PeriodicInterestAutoLiquidated` for a periodic settlement),
    ///         which is what the indexer folds into the loan row.
    /// @custom:event-category informational/settlement
    event ForcedSaleSettled(
        uint256 indexed loanId,
        uint8 indexed kind,
        uint256 debt,
        uint256 need,
        uint256 collateralSold,
        uint256 proceeds,
        uint256 lenderPaid,
        uint256 handlingFee,
        uint256 keeperBonus,
        uint256 borrowerExtra,
        bool borrowerExtraHeld,
        uint256 collateralUnsold,
        bool covered,
        address indexed keeper
    );

    /// @dev The division of one sale's proceeds ({ForcedSaleFacet} @dev).
    struct Split {
        uint256 bonus;
        uint256 lender;
        uint256 fee;
        uint256 extra;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
        _;
    }

    // ─── Views ──────────────────────────────────────────────────────────

    /**
     * @notice The size of the forced sale `kind` would make on `loanId` now:
     *         the debt, the need, the collateral to sell, the floor every
     *         route must deliver and whether that floor covers the need.
     * @dev    A keeper builds its adapter calldata for exactly `sell`: an
     *         aggregator quote encodes the sell amount, and a quote for any
     *         other amount fails every route. Needs a fresh price on both
     *         assets; without one this reverts with the price reader's own
     *         error, as the sale itself would. Returns an all-zero plan when
     *         no sale of this kind is due now: nothing is owed, or (periodic)
     *         the settlement is not yet allowed — the period's grace is not
     *         over, periodic interest is off, or the loan is not Active on a
     *         cadence.
     */
    function previewForcedSale(uint256 loanId, ForcedSaleKind kind)
        external
        view
        returns (ForcedSalePlan memory plan)
    {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        uint256 debt = _debt(loan, kind);
        if (debt == 0) return plan;
        return _plan(loan, debt);
    }

    // ─── Mutators (Diamond-internal) ────────────────────────────────────

    /**
     * @notice Sell the periodic settlement's collateral slice and divide the
     *         proceeds: keeper bonus, the lender's interest (at most the
     *         shortfall), the subordinated handling fee, and the borrower's
     *         extra (paid to the holder's wallet, or held for the claim).
     * @dev    The caller ({RepayPeriodicFacet}) has already decremented the
     *         collateral lien by `plan.sell` and withdrawn the slice from the
     *         borrower's vault; `received` is what reached the Diamond. A
     *         slice that arrived short is sold whole at its own floor and
     *         reported uncovered. Every route failing reverts
     *         {PeriodicSettleSwapFailed} and nothing moves. Leaves the
     *         checkpoint, the loan's collateral figure and the lifecycle event
     *         to the caller.
     * @return lenderPaid    What the lender received (or was held for them).
     * @return borrowerExtra The borrower's share (`X`) as the borrower got it.
     * @return extraHeld     True when `X` was held instead of paid out.
     * @return bonus         Keeper bonus paid to `settler`.
     * @return fee           Handling fee paid to the treasury.
     */
    function settlePeriodicSale(
        uint256 loanId,
        ForcedSalePlan calldata plan,
        uint256 received,
        LibSwap.AdapterCall[] calldata adapterCalls,
        address settler
    )
        external
        onlySelf
        returns (uint256 lenderPaid, uint256 borrowerExtra, bool extraHeld, uint256 bonus, uint256 fee)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        (bool ok, uint256 proceeds, bool covered) = _sell(loan, plan, received, adapterCalls);
        if (!ok) revert PeriodicSettleSwapFailed(loanId);

        Split memory sp = _split(loan, plan.debt, proceeds, received);
        _payBonusAndFee(loan.principalAsset, settler, sp);

        // The lender: the current lender-position holder, paid inline when
        // clean or held fail-closed when flagged (#998 S10 Class B). The
        // paid-through mark moves only on full coverage of the shortfall
        // (Codex #1801 r4 P1): a partial payout leaves the window open over
        // what is still owed. The mark is the UNMOVED period end
        // ({LibPeriodicInterest.deliveredThroughAt}, #668 / #935), not the
        // payment deadline: the deadline carries the pause credit, while the
        // shortfall covered here is one interval of interest.
        lenderPaid = LibCloseoutFreeze.freezeOrPayActiveLenderResident(
            s,
            loanId,
            loan,
            loan.principalAsset,
            sp.lender,
            sp.lender >= plan.debt ? LibPeriodicInterest.deliveredThroughAt(loan) : 0
        );
        // #2795 — credit exactly what the lender received, never more than the
        // shortfall: the extra above it is the borrower's, not prepaid interest.
        loan.interestSettled += lenderPaid;

        (extraHeld, borrowerExtra) = _payBorrowerExtra(s, loanId, loan, sp.extra);
        bonus = sp.bonus;
        fee = sp.fee;

        emit ForcedSaleSettled(
            loanId,
            uint8(ForcedSaleKind.PeriodicSettlement),
            plan.debt,
            plan.need,
            received,
            proceeds,
            lenderPaid,
            fee,
            bonus,
            borrowerExtra,
            extraHeld,
            loan.collateralAmount - plan.sell,
            covered,
            settler
        );
    }

    /**
     * @notice Pay `amount` of `asset` to `to`'s wallet, refused unless all of
     *         it arrived (a wallet reading is trusted only to refuse).
     * @dev    Called by this facet on itself so a refusal — a token that
     *         blocks the address, a short reading, a receiving hook that
     *         reverts — unwinds this attempt alone and the extra falls through
     *         to the held route. A forced settlement never depends on the
     *         borrower's wallet.
     */
    function payBorrowerWallet(address asset, address to, uint256 amount) external onlySelf {
        LibDelivery.pushExact(asset, to, amount);
    }

    // ─── Internals ──────────────────────────────────────────────────────

    /// @dev `D` for `kind`. Periodic: the period's shortfall on an Active
    ///      periodic-cadence loan, else 0.
    function _debt(LibVaipakam.Loan storage loan, ForcedSaleKind kind) private view returns (uint256) {
        if (kind == ForcedSaleKind.PeriodicSettlement) {
            return LibPeriodicInterest.settleableShortfall(loan);
        }
        return 0;
    }

    /// @dev The plan for selling `loan`'s collateral to cover `debt`.
    function _plan(LibVaipakam.Loan storage loan, uint256 debt)
        private
        view
        returns (ForcedSalePlan memory plan)
    {
        uint256 cap = LibVaipakam.cfgMaxLiquidationSlippageBps();
        plan.debt = debt;
        plan.need = debt
            + Math.mulDiv(debt, LibVaipakam.cfgLiquidationHandlingFeeBps(), LibVaipakam.BASIS_POINTS, Math.Rounding.Ceil)
            + Math.mulDiv(debt, _maxBonusBps(loan.collateralAsset), LibVaipakam.BASIS_POINTS, Math.Rounding.Ceil);
        LibFallback.Rate memory rate =
            LibFallback.oracleRate(address(this), loan.collateralAsset, loan.principalAsset);
        (plan.covered, plan.sell, plan.floor) =
            LibSaleSizing.sizeSaleAtRate(rate, plan.need, loan.collateralAmount, cap);
        if (!plan.covered) {
            plan.sell = loan.collateralAmount;
            plan.floor = LibSaleSizing.floorAtRate(rate, plan.sell, cap);
        }
    }

    /// @dev `bMax`: the protocol's largest keeper bonus, lowered by the
    ///      collateral's own ceiling when one is set — the same two caps
    ///      {LibEntitlement.liquidatorIncentiveBps} applies to the bonus paid.
    function _maxBonusBps(address collateralAsset) private view returns (uint256 bps) {
        bps = LibVaipakam.cfgMaxLiquidatorIncentiveBps();
        uint256 assetCap = LibVaipakam.storageSlot().assetRiskParams[collateralAsset].liqBonusBps;
        if (assetCap != 0 && bps > assetCap) bps = assetCap;
    }

    /// @dev Sell `received` collateral (already on the Diamond) through the
    ///      caller's try-list, demanding the plan's floor. A slice that
    ///      arrived short of `plan.sell` is held to its own floor instead and
    ///      the sale reports uncovered.
    function _sell(
        LibVaipakam.Loan storage loan,
        ForcedSalePlan calldata plan,
        uint256 received,
        LibSwap.AdapterCall[] calldata adapterCalls
    ) private returns (bool ok, uint256 proceeds, bool covered) {
        covered = plan.covered && received == plan.sell;
        uint256 minOut = plan.floor;
        if (received != plan.sell) {
            minOut = LibSaleSizing.floorAtRate(
                LibFallback.oracleRate(address(this), loan.collateralAsset, loan.principalAsset),
                received,
                LibVaipakam.cfgMaxLiquidationSlippageBps()
            );
            covered = covered && minOut >= plan.need;
        }
        (ok, proceeds, ) = LibSwap.swapWithFailover(
            loan.id,
            loan.collateralAsset,
            loan.principalAsset,
            received,
            minOut,
            address(this),
            adapterCalls
        );
    }

    /// @dev The one waterfall ({ForcedSaleFacet} @dev). `sold` prices the
    ///      execution-quality bonus against what was actually sold.
    function _split(LibVaipakam.Loan storage loan, uint256 debt, uint256 proceeds, uint256 sold)
        private
        view
        returns (Split memory sp)
    {
        uint256 expected = LibFallback.expectedSwapOutput(
            address(this), loan.collateralAsset, loan.principalAsset, sold
        );
        uint256 b = LibEntitlement.liquidatorIncentiveBps(loan.collateralAsset, proceeds, expected);
        uint256 base = proceeds < debt ? proceeds : debt;
        sp.bonus = (base * b) / LibVaipakam.BASIS_POINTS;
        uint256 rest = proceeds - sp.bonus;
        sp.lender = rest < debt ? rest : debt;
        rest -= sp.lender;
        uint256 feeDue = (debt * LibVaipakam.cfgLiquidationHandlingFeeBps()) / LibVaipakam.BASIS_POINTS;
        sp.fee = rest < feeDue ? rest : feeDue;
        sp.extra = rest - sp.fee;
    }

    /// @dev Bonus to the caller and the subordinated fee to the treasury.
    ///      A bonus books nobody by what arrives (LibDelivery outcome 3); the
    ///      treasury accrues what reached it (TreasuryFeeFacet).
    function _payBonusAndFee(address asset, address settler, Split memory sp) private {
        if (sp.bonus > 0) LibDelivery.pushOut(asset, settler, sp.bonus);
        LibFacet.transferToTreasury(asset, sp.fee);
    }

    /// @dev The borrower's extra on an OPEN loan (owner decision 2026-10-25):
    ///      an unflagged current holder of the borrower position is paid to
    ///      their wallet through {payBorrowerWallet}; a flagged holder, or a
    ///      wallet payment that was refused, has it held in the stored
    ///      borrower's vault for the claim at loan end
    ///      ({LibCloseoutFreeze.parkActiveBorrowerExtra}).
    /// @return held   True when the extra was held rather than paid out.
    /// @return amount What the borrower got: all of `extra` when paid to the
    ///                wallet (a short arrival there is refused), or what the
    ///                stored borrower's vault received when held.
    function _payBorrowerExtra(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        uint256 extra
    ) private returns (bool held, uint256 amount) {
        if (extra == 0) return (false, 0);
        address holder = IERC721(address(this)).ownerOf(loan.borrowerTokenId);
        bool frozen = LibSanctionedLock.mustFreezeParty(s, holder);
        if (!frozen) {
            (bool paid, ) = address(this).call(
                abi.encodeCall(this.payBorrowerWallet, (loan.principalAsset, holder, extra))
            );
            if (paid) return (false, extra);
        }
        amount = LibCloseoutFreeze.parkActiveBorrowerExtra(
            s, loanId, loan, holder, loan.principalAsset, extra
        );
        held = true;
    }
}
