// src/facets/ForcedSaleFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibMetricsHooks} from "../libraries/LibMetricsHooks.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibSaleSizing} from "../libraries/LibSaleSizing.sol";
import {LibEntitlement} from "../libraries/LibEntitlement.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {OutflowReason} from "../vault/VaultOutflowTypes.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibCloseoutFreeze} from "../libraries/LibCloseoutFreeze.sol";
import {LibPeriodicInterest} from "../libraries/LibPeriodicInterest.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibLenderYieldFeeHost} from "../libraries/LibLenderYieldFeeHost.sol";
import {LibLoanClock} from "../libraries/LibLoanClock.sol";
import {LibDefaultRoute} from "../libraries/LibDefaultRoute.sol";
import {LibPositionNFT} from "../libraries/LibPositionNFT.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {LibDiscountedLiquidation} from "../libraries/LibDiscountedLiquidation.sol";
import {LibForcedSalePlan} from "../libraries/LibForcedSalePlan.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {RiskFacet} from "./RiskFacet.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {SaleFloorFacet} from "./SaleFloorFacet.sol";
import {LibInternalMatchPriority} from "../libraries/LibInternalMatchPriority.sol";

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
 *      USERS ({ForcedSaleKind}): the periodic-interest settlement
 *      ({RepayPeriodicFacet.settlePeriodicInterest}), the Health-Factor
 *      liquidation on one route ({RiskFacet.triggerLiquidation}) and split
 *      across routes ({RiskSplitLiquidationFacet.triggerLiquidationSplit}),
 *      and the time-based default of liquid collateral
 *      ({DefaultedFacet.triggerDefault}). Each caller keeps its own
 *      preconditions, its failure branch, its terminal transition and its own
 *      lifecycle event; this host owns everything between: the size, the
 *      lien, the pull, the sale and the division of the proceeds.
 *
 *      THE RULE, with `D` the debt the sale settles (periodic: the period's
 *      shortfall; terminal: the borrow balance plus the late fee), `f` the
 *      handling-fee rate, `bMax` the largest keeper-bonus rate
 *      (`cfgMaxLiquidatorIncentiveBps`, lowered by the collateral's
 *      per-asset `liqBonusBps`) and `cap` the liquidation slippage cap:
 *      - need `N = D + ⌈f·D⌉ + ⌈bMax·D⌉`;
 *      - the least `x ≤ C` whose floor (oracle value less `cap`) is `≥ N`
 *        ({LibSaleSizing}); when none covers `N`, all of `C` (`covered =
 *        false`);
 *      - the sale sells the amount the caller's swap quote was built for.
 *        A covered sale accepts any quote from `x` up to {QUOTE_MARGIN_BPS}
 *        above it (never above `C`), because interest accrues every second
 *        and prices tick between the quote and the block; an uncovered sale
 *        accepts only `C`. Any other quote reverts
 *        {ForcedSaleQuoteOutOfRange} and nothing moves. The floor every
 *        route must deliver is that of what was sold, so a filled covered
 *        sale always pays the lender in full;
 *      - with proceeds `P`: bonus `B = b·min(D, P)` first (`b` is the shared
 *        execution-quality curve, {LibEntitlement.liquidatorIncentiveBps},
 *        and zero for a sanctions-flagged caller), lender `L = min(D, P − B)`,
 *        handling fee `F = min(f·D, P − B − L)` subordinated to the lender,
 *        borrower extra `X = P − B − L − F`.
 *
 *      WHERE THE BORROWER'S SHARE GOES. Periodic (the loan stays open): `X`
 *      to the current borrower-position holder's wallet, or held in the
 *      stored borrower's vault for the claim when the holder is flagged or
 *      the wallet refuses it. Terminal: the unsold collateral stays in the
 *      stored borrower's vault under the loan's lien and is named by the
 *      borrower's collateral claim; `X` is held in that vault on the
 *      borrower's surplus row; `claimAsBorrower` pays both.
 *
 *      TRUST MODEL: every mutator is `address(this)`-gated and carries no
 *      reentrancy guard of its own, because every caller already holds the
 *      Diamond guard.
 *
 *      Refresh-together family: this facet + every facet that sells through
 *      it (RepayPeriodicFacet, RiskFacet, RiskSplitLiquidationFacet,
 *      DefaultedFacet). A caller refreshed without the host reverts
 *      `FunctionDoesNotExist` on every forced sale — a hard revert, never a
 *      silent old waterfall.
 */
contract ForcedSaleFacet is IVaipakamErrors {
    /// @notice Which forced sale. Values are append-only.
    enum ForcedSaleKind {
        PeriodicSettlement,
        HealthFactorLiquidation,
        HealthFactorSplitLiquidation,
        TimeBasedDefault
    }

    /// @notice How far above the least covering amount a covered sale's
    ///         quote may be (2%). It absorbs the interest that accrues and
    ///         the price ticks between the moment a keeper builds its swap
    ///         quote and the block that settles it; the extra proceeds go
    ///         back to the borrower like the rest of the extra, so the
    ///         borrower's cost is the slippage on at most this much more
    ///         collateral. Owner decision 2026-10-25 (#2796).
    uint256 public constant QUOTE_MARGIN_BPS = LibForcedSalePlan.QUOTE_MARGIN_BPS;

    /// @notice The size of a forced sale, computed before anything moves.
    /// @param debt    `D`: what the sale must pay the lender.
    /// @param need    `N`: the debt plus the largest handling fee and the
    ///                largest keeper bonus, each rounded up.
    /// @param sell    The least collateral whose floor covers `need`, or all
    ///                of it when none does. A swap quote for exactly this
    ///                amount is always accepted while the plan holds.
    /// @param floor   The least proceeds every route must deliver for `sell`
    ///                (its oracle value less the liquidation slippage cap).
    /// @param covered True when `floor >= need`.
    /// @param maxSell The largest quote a sale accepts now: `sell` plus
    ///                {QUOTE_MARGIN_BPS} (never above the collateral) when
    ///                covered, `sell` itself when not.
    /// @param floorBps The most the sale may lose to the market, in bps of
    ///                the oracle value of what it sells: the per-tier figure
    ///                when the collateral is deep, the pair calm and the
    ///                cushion wide, else the full slippage cap (#3359,
    ///                {SaleFloorFacet.saleFloorBps}). `floor` and every
    ///                route's minimum output are set from it.
    struct ForcedSalePlan {
        uint256 debt;
        uint256 need;
        uint256 sell;
        uint256 floor;
        bool covered;
        uint256 maxSell;
        uint256 floorBps;
    }

    /// @notice What one forced sale did, returned to the caller.
    /// @param sold              False only when every failover route failed
    ///                          on a terminal sale: nothing was paid, the
    ///                          loan's lien is released and its whole
    ///                          collateral is on the Diamond for the caller's
    ///                          fallback entry.
    /// @param collateralSold    Collateral that reached the Diamond and was sold.
    /// @param proceeds          `P`: lending-asset proceeds that arrived.
    /// @param lenderPaid        What the lender received (periodic: paid, or
    ///                          held for a frozen holder; terminal: what the
    ///                          stored lender's vault received for the claim,
    ///                          after the ordinary treasury cut on interest).
    /// @param handlingFee       `F`, to the treasury.
    /// @param keeperBonus       `B`, to the caller.
    /// @param borrowerExtra     `X` as the borrower got it.
    /// @param borrowerExtraHeld True when `X` was held for the claim.
    struct ForcedSaleOutcome {
        bool sold;
        uint256 collateralSold;
        uint256 proceeds;
        uint256 lenderPaid;
        uint256 handlingFee;
        uint256 keeperBonus;
        uint256 borrowerExtra;
        bool borrowerExtraHeld;
    }

    /// @notice A sale was asked to sell `quoted`, outside the range the plan
    ///         accepts now (`least` to `most`). Nothing moved; quote again.
    error ForcedSaleQuoteOutOfRange(uint256 loanId, uint256 quoted, uint256 least, uint256 most);

    /// @notice No sale of this kind is owed on the loan now (nothing is
    ///         owed, or the kind's own window is not open).
    error ForcedSaleNotDue(uint256 loanId, uint8 kind);

    /// @notice Every figure of one forced sale. Nothing is left to be
    ///         inferred from balance changes.
    /// @param loanId            The loan.
    /// @param kind              Which forced sale ({ForcedSaleKind}).
    /// @param debt              `D`.
    /// @param need              `N`.
    /// @param collateralSold    Collateral that reached the Diamond and was sold.
    /// @param proceeds          `P`: lending-asset proceeds that arrived.
    /// @param lenderPaid        What the lender received (or what was held for
    ///                          a frozen holder), at most `debt`.
    /// @param handlingFee       `F`, to the treasury.
    /// @param keeperBonus       `B`, to the caller.
    /// @param borrowerExtra     `X`, the borrower's share of the proceeds.
    /// @param borrowerExtraHeld True when `X` was held in the borrower's vault
    ///                          for the claim instead of paid to the holder's
    ///                          wallet.
    /// @param collateralUnsold  Collateral the sale left in the borrower's
    ///                          vault (with the open loan, or for the claim).
    /// @param covered           Whether the sale's floor covered the need.
    /// @param keeper            Who submitted the sale and received `B`.
    /// @dev    The breakdown only: the loan's own change is carried by the
    ///         kind's state event in the same transaction
    ///         (`PeriodicInterestAutoLiquidated`, `HFLiquidationTriggered`,
    ///         `LoanDefaulted`), which is what the indexer folds into the
    ///         loan row.
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

    /// @dev The division of one sale's proceeds (see the contract notes).
    struct Split {
        uint256 bonus;
        uint256 lender;
        uint256 fee;
        uint256 extra;
    }

    /// @dev One sale's working figures, kept in memory so no frame carries
    ///      them all on the stack.
    struct Job {
        uint256 loanId;
        ForcedSaleKind kind;
        uint256 debt;
        uint256 need;
        uint256 unsold;
        uint256 minOut;
        address keeper;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
        _;
    }

    // ─── Mutators (Diamond-internal) ────────────────────────────────────

    /**
     * @notice Size, sell and divide one forced sale of `loanId`'s collateral.
     * @dev    The caller has checked the kind's preconditions and holds the
     *         Diamond guard. In order:
     *         1. The plan for the kind's debt; `quotedSell` must lie in the
     *            plan's accepted range ({ForcedSaleQuoteOutOfRange}).
     *         2. The collateral lien falls by `quotedSell` and that much
     *            leaves the stored borrower's vault for the Diamond under the
     *            forced close-out move-out exemption (a flagged borrower
     *            never blocks it). The sale acts on what arrived.
     *         3. The sale, held to the floor of what arrived: the caller's
     *            failover try-list, or for the split kind the caller's legs
     *            (atomic: any failure reverts the whole call).
     *         4. A failover with every route failed: periodic reverts
     *            {PeriodicSettleSwapFailed} (nothing moves); terminal releases
     *            the rest of the lien, brings the rest of the collateral to
     *            the Diamond and returns `sold = false` for the caller's
     *            fallback entry, which finds the loan's whole collateral there.
     *         5. Otherwise the division (see the contract notes), the kind's
     *            booking and {ForcedSaleSettled}. Each vault movement
     *            refreshes the owner's VPFI tier record at the write (#1820).
     *         Leaves the checkpoint (periodic), the terminal transition, the
     *         NFT status and the lifecycle event to the caller.
     * @param loanId       The loan.
     * @param kind         Which forced sale.
     * @param quotedSell   The collateral amount the caller's quote was built
     *                     for (the split kind: the sum of its legs).
     * @param adapterCalls The failover try-list (empty for the split kind).
     * @param splits       The split legs (empty for every other kind).
     * @param keeper       Who submitted the sale; receives `B`.
     */
    function sellToNeed(
        uint256 loanId,
        ForcedSaleKind kind,
        uint256 quotedSell,
        LibSwap.AdapterCall[] calldata adapterCalls,
        LibSwap.SplitCall[] calldata splits,
        address keeper
    ) external onlySelf returns (ForcedSaleOutcome memory out) {
        Job memory j;
        (j, out.collateralSold) = _open(loanId, kind, quotedSell, keeper);
        (out.sold, out.proceeds) = _sell(j, out.collateralSold, adapterCalls, splits);
        if (!out.sold) {
            if (kind == ForcedSaleKind.PeriodicSettlement) revert PeriodicSettleSwapFailed(loanId);
            _gatherForFallback(j, out.collateralSold);
            return out;
        }
        _settle(j, out);
    }

    /**
     * @notice Pay `amount` of `asset` to `to`'s wallet, refused unless all of
     *         it arrived (a wallet reading is trusted only to refuse).
     * @dev    Reached by a self-call from
     *         {LibCloseoutFreeze.payOrHoldBorrowerExtra} (this facet's
     *         periodic sale and `PrepayListingFacet`'s collateral sale, #2876)
     *         so a refusal — a token that blocks the address, a short reading,
     *         a receiving hook that reverts — unwinds this payment alone and
     *         the extra falls through to the held route. A settlement never
     *         depends on the borrower's wallet.
     */
    function payBorrowerWallet(address asset, address to, uint256 amount) external onlySelf {
        LibDelivery.pushExact(asset, to, amount);
    }

    // ─── Internals: sell ────────────────────────────────────────────────

    /// @dev The plan for `kind`, the quote check, and the pull: the lien falls
    ///      by `quotedSell` and that much leaves the stored borrower's vault
    ///      for the Diamond under the forced close-out move-out exemption.
    /// @return j        The sale's working figures, the floor set from what
    ///                  arrived.
    /// @return received The collateral that reached the Diamond.
    function _open(uint256 loanId, ForcedSaleKind kind, uint256 quotedSell, address keeper)
        private
        returns (Job memory j, uint256 received)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        j.loanId = loanId;
        j.kind = kind;
        j.keeper = keeper;
        j.debt = LibForcedSalePlan.debtFor(loan, kind);
        if (j.debt == 0) revert ForcedSaleNotDue(loanId, uint8(kind));
        (ForcedSalePlan memory plan, LibFallback.Rate memory rate) = LibForcedSalePlan.planFor(loan, j.debt);
        if (quotedSell < plan.sell || quotedSell > plan.maxSell) {
            revert ForcedSaleQuoteOutOfRange(loanId, quotedSell, plan.sell, plan.maxSell);
        }
        j.need = plan.need;
        j.unsold = loan.collateralAmount - quotedSell;
        LibEncumbrance.decrementCollateralLien(loanId, quotedSell);
        received = LibSanctionedLock.pullToDiamond(s, loan.borrower, loan.collateralAsset, quotedSell, loanId, OutflowReason.LIQUIDATION);
        j.minOut = LibSaleSizing.floorAtRate(rate, received, plan.floorBps);
    }

    /// @dev Sell `amount` collateral (on the Diamond) demanding the floor of
    ///      what arrived: the split legs for the split kind (atomic), else the
    ///      failover try-list.
    function _sell(
        Job memory j,
        uint256 amount,
        LibSwap.AdapterCall[] calldata adapterCalls,
        LibSwap.SplitCall[] calldata splits
    ) private returns (bool ok, uint256 got) {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[j.loanId];
        if (j.kind == ForcedSaleKind.HealthFactorSplitLiquidation) {
            got = LibSwap.swapWithSplit(
                j.loanId, loan.collateralAsset, loan.principalAsset, amount, j.minOut, address(this), splits
            );
            ok = true;
        } else {
            (ok, got, ) = LibSwap.swapWithFailover(
                j.loanId, loan.collateralAsset, loan.principalAsset, amount, j.minOut, address(this), adapterCalls
            );
        }
    }

    /// @dev Every failover route failed on a terminal sale. Release what is
    ///      left of the lien, bring the unsold collateral to the Diamond too,
    ///      and make the loan's collateral what is now on the Diamond, so the
    ///      caller's fallback entry finds the whole of it there.
    function _gatherForFallback(Job memory j, uint256 alreadyHere) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[j.loanId];
        LibEncumbrance.releaseCollateralLien(j.loanId);
        uint256 rest = j.unsold == 0
            ? 0
            : LibSanctionedLock.pullToDiamond(s, loan.borrower, loan.collateralAsset, j.unsold, j.loanId, OutflowReason.LIQUIDATION);
        loan.collateralAmount = alreadyHere + rest;
    }

    // ─── Internals: divide and book ─────────────────────────────────────

    /// @dev A filled sale: divide the proceeds, pay the keeper, book the kind,
    ///      and state every figure ({ForcedSaleSettled}).
    function _settle(Job memory j, ForcedSaleOutcome memory out) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[j.loanId];
        Split memory sp = _split(loan, j.debt, out.proceeds, out.collateralSold, j.keeper);
        out.keeperBonus = sp.bonus;
        out.handlingFee = sp.fee;
        // A bonus books nobody by what arrives (LibDelivery outcome 3).
        if (sp.bonus > 0) LibDelivery.pushOut(loan.principalAsset, j.keeper, sp.bonus);

        if (j.kind == ForcedSaleKind.PeriodicSettlement) {
            _bookPeriodic(s, j.loanId, loan, sp, out);
            loan.collateralAmount = j.unsold;
        } else {
            _bookTerminal(s, j.loanId, loan, sp, out);
            _recordUnsold(s, j.loanId, loan, j.unsold, out.collateralSold);
        }

        emit ForcedSaleSettled(
            j.loanId,
            uint8(j.kind),
            j.debt,
            j.need,
            out.collateralSold,
            out.proceeds,
            out.lenderPaid,
            out.handlingFee,
            out.keeperBonus,
            out.borrowerExtra,
            out.borrowerExtraHeld,
            j.unsold,
            j.minOut >= j.need,
            j.keeper
        );
    }

    /// @dev The one waterfall (see the contract notes). `sold` prices the
    ///      execution-quality bonus against what was actually sold. A
    ///      sanctions-flagged caller earns no bonus; it stays in the
    ///      waterfall (the HF and periodic entries refuse such a caller
    ///      outright, the time-based default stays open to it).
    function _split(
        LibVaipakam.Loan storage loan,
        uint256 debt,
        uint256 proceeds,
        uint256 sold,
        address keeper
    ) private view returns (Split memory sp) {
        uint256 b;
        if (!LibVaipakam.isSanctionedAddress(keeper)) {
            uint256 expected = LibFallback.expectedSwapOutput(
                address(this), loan.collateralAsset, loan.principalAsset, sold
            );
            b = LibEntitlement.liquidatorIncentiveBps(loan.collateralAsset, proceeds, expected);
        }
        uint256 base = proceeds < debt ? proceeds : debt;
        sp.bonus = (base * b) / LibVaipakam.BASIS_POINTS;
        uint256 rest = proceeds - sp.bonus;
        sp.lender = rest < debt ? rest : debt;
        rest -= sp.lender;
        uint256 feeDue = (debt * LibVaipakam.cfgLiquidationHandlingFeeBps()) / LibVaipakam.BASIS_POINTS;
        sp.fee = rest < feeDue ? rest : feeDue;
        sp.extra = rest - sp.fee;
    }

    /// @dev Periodic booking (the loan stays open): the fee to the treasury,
    ///      the lender's interest to the current lender-position holder (paid
    ///      inline, or held fail-closed when flagged), and the borrower's
    ///      extra to the holder's wallet or held.
    function _bookPeriodic(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        Split memory sp,
        ForcedSaleOutcome memory out
    ) private {
        // The treasury accrues what reached it (TreasuryFeeFacet).
        LibFacet.transferToTreasury(loan.principalAsset, sp.fee);
        // #1209 / #1808 — the whole payout is interest, and this slice carries
        // no treasury cut, so it is passed as both the gross and the net
        // interest: open seller claims are paid out of it first, in full.
        out.lenderPaid = LibCloseoutFreeze.freezeOrPayActiveLenderResident(
            s,
            loanId,
            loan,
            loan.principalAsset,
            sp.lender,
            sp.lender,
            sp.lender
        );
        // #2795 — credit exactly what the lender received, never more than the
        // shortfall: the extra above it is the borrower's, not prepaid interest.
        loan.interestSettled += out.lenderPaid;
        // The owner decision of 2026-10-25: an unflagged holder is paid to
        // their wallet; a flagged holder, or a refused payment, has the extra
        // held for the claim at loan end.
        (out.borrowerExtraHeld, out.borrowerExtra) = LibCloseoutFreeze.payOrHoldBorrowerExtra(
            s, loanId, loan, LibPositionNFT.ownerOf(loan.borrowerTokenId), sp.extra
        );
    }

    /// @dev Terminal booking (the caller ends the loan): the fee and the
    ///      ordinary treasury cut on the recovered interest to the treasury,
    ///      the lender's share into the stored lender's vault for the claim,
    ///      and the borrower's extra held on the surplus row. The lender's
    ///      share repays principal first, then interest and the late fee;
    ///      only the interest part carries the treasury cut, resolved for the
    ///      current lender-position holder's discounts (#1383).
    function _bookTerminal(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        Split memory sp,
        ForcedSaleOutcome memory out
    ) private {
        // `sp.lender` is already capped at the debt ({_split}), so the
        // interest it recovers never exceeds the interest owed.
        uint256 treasuryInterest;
        uint256 lenderNet = sp.lender;
        if (sp.lender > loan.principal) {
            uint256 interestRecovered = sp.lender - loan.principal;
            // #1832 — terminal seam of the lifetime interest counter: what the
            // sale recovered, not what was owed.
            LibMetricsHooks.onInterestPaid(loan, interestRecovered);
            (treasuryInterest, ) = LibEntitlement.splitTreasury(loan, interestRecovered);
            (, treasuryInterest) = LibLenderYieldFeeHost.resolve(
                loanId, LibPositionNFT.ownerOf(loan.lenderTokenId), interestRecovered, treasuryInterest
            );
            lenderNet = sp.lender - treasuryInterest;
        }
        LibFacet.transferToTreasury(loan.principalAsset, sp.fee + treasuryInterest);

        // #821 — through the receive-side exemption so a flagged stored lender
        // never blocks the close-out; the claim names what the vault received
        // (#2440).
        lenderNet = LibSanctionedLock.depositLocked(s, loan.lender, loanId, loan.principalAsset, lenderNet);
        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: lenderNet,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        // #1132 (S10) — the row's writer registers its holder: the current
        // lender-position holder's fail-closed claimant marker lands with the
        // claim itself, whichever entry reached this host. The caller's
        // terminal transition records both holders again; the marker is
        // idempotent (first-write-wins for a still-flagged party).
        LibSanctionedLock.recordFrozenClaimantForLoan(s, loan, true);
        // #592 — reserve VPFI lender proceeds against the unstake path until
        // the current holder claims; ClaimFacet releases.
        if (loan.principalAsset == s.vpfiToken) {
            LibEncumbrance.encumberLenderProceeds(loanId, loan.lender, loan.principalAsset, lenderNet);
        }
        out.lenderPaid = lenderNet;

        if (sp.extra > 0) {
            out.borrowerExtra = LibCloseoutFreeze.holdBorrowerExtra(
                s, loanId, loan, LibPositionNFT.ownerOf(loan.borrowerTokenId), loan.principalAsset, sp.extra
            );
            out.borrowerExtraHeld = true;
        }
    }

    /// @dev The borrower's collateral claim after a terminal sale: the
    ///      collateral the sale did not take, still in the stored borrower's
    ///      vault under the loan's lien (which now equals it).
    ///      `ClaimFacet.claimAsBorrower` releases the lien with the payout.
    ///      Written claimed when nothing is left; the claim pays the surplus
    ///      row on its own flag either way. The loan's collateral figure
    ///      becomes what the sale left plus what reached the Diamond, which
    ///      on an ordinary token is the figure it pledged.
    function _recordUnsold(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.Loan storage loan,
        uint256 unsold,
        uint256 sold
    ) private {
        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: unsold,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: unsold == 0
        });
        // #1132 (S10) — the borrower-side marker lands with its row, as the
        // lender's does in {_bookTerminal}.
        LibSanctionedLock.recordFrozenClaimantForLoan(s, loan, false);
        loan.collateralAmount = unsold + sold;
    }
}
