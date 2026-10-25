// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {PositiveFlowsBase} from "./PositiveFlowsBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../../src/libraries/LibSwap.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {SwapToRepayFacet} from "../../src/facets/SwapToRepayFacet.sol";
import {SwapToRepayPartialFacet} from "../../src/facets/SwapToRepayPartialFacet.sol";
import {FixedRateSwapAdapter} from "../mocks/FixedRateSwapAdapter.sol";

/**
 * @title PositiveFlowsSwapToRepay
 * @notice Borrower swap-to-repay (#848 Phase 2): the Diamond sells part of
 *         the collateral for the lending asset and applies the proceeds to
 *         the loan in one transaction, in full (PF-118) or in part (PF-119).
 *
 *         The swap goes through a {FixedRateSwapAdapter} the scenario
 *         deploys and registers for its own run
 *         ({PositiveFlowsBase-_registerFixedRateAdapter}), priced at the
 *         fixture's oracle rate, so the proceeds are known before the call. Each
 *         scenario then accounts for every unit of them: the lender's share,
 *         the treasury's share and the borrower's surplus must add up to
 *         exactly what the swap returned, and the collateral that was not
 *         sold stays the borrower's. The adapter is removed from the
 *         Diamond's swap list before the scenario ends.
 *         Fixture, runner and ids: {PositiveFlowsBase}.
 */
contract PositiveFlowsSwapToRepay is PositiveFlowsBase {
    FixedRateSwapAdapter private adapter;

    function moduleName() public pure override returns (string memory) {
        return "PositiveFlowsSwapToRepay";
    }

    function scenarios() public pure override returns (Scenario[] memory list) {
        list = new Scenario[](2);
        list[0] = Scenario("PF-118", "Full swap-to-repay sells only what the debt needs and closes the loan",
            "PF-118, PF-112, PF-113");
        list[1] = Scenario("PF-119", "Partial swap-to-repay cuts the principal by the proceeds net of accrued interest",
            "PF-119, PF-114");
    }

    function _runScenario(uint256 index) internal override {
        LibSwap.AdapterCall[] memory route;
        (adapter, route) = _registerFixedRateAdapter();
        if (index == 0) _swapToRepayFull(route);
        else if (index == 1) _swapToRepayPartial(route);
        else revert("PositiveFlowsSwapToRepay: no scenario at index");
        _removeFixedRateAdapter(adapter);
    }

    // ─── PF-118 ───────────────────────────────────────────────────────────

    /// @dev A full-term loan, so the payoff carries interest and the treasury
    ///      takes a share of it. The borrower allows the whole collateral as
    ///      the bound; the Diamond sells only the sized amount (#2317).
    function _swapToRepayFull(LibSwap.AdapterCall[] memory route) internal {
        LibVaipakam.CreateOfferParams memory offer = _lenderOfferStandard();
        offer.useFullTermInterest = true;
        uint256 loanId = _openLoan(offer);

        (uint256 toSell, uint256 minOut, uint256 required) =
            SwapToRepayFacet(diamond).previewSwapToRepayFull(loanId, COLLATERAL_AMOUNT);
        uint256 proceeds = adapter.quote(address(weth), address(usdc), toSell);
        require(toSell > 0 && toSell < COLLATERAL_AMOUNT, "PF-118: the sale should be sized below the whole collateral");
        require(proceeds >= minOut && minOut >= required, "PF-118: the sized sale should clear its floor and cover the debt");
        console.log("Sized sale (WETH) / proceeds / debt:", toSell, proceeds, required);

        uint256 adapterWethBefore = weth.balanceOf(address(adapter));
        uint256 borrowerBefore = usdc.balanceOf(borrower);
        uint256 treasuryBefore = _treasuryUsdc();
        vm.startBroadcast(borrowerKey);
        SwapToRepayFacet(diamond).swapToRepayFull(loanId, route, COLLATERAL_AMOUNT);
        vm.stopBroadcast();

        require(LoanFacet(diamond).getLoanDetails(loanId).status == LibVaipakam.LoanStatus.Repaid,
            "PF-118: the loan should close as Repaid");
        require(weth.balanceOf(address(adapter)) - adapterWethBefore == toSell,
            "PF-118: exactly the sized collateral should be sold");
        uint256 surplus = usdc.balanceOf(borrower) - borrowerBefore;
        uint256 treasuryShare = _treasuryUsdc() - treasuryBefore;
        (address lenderAsset, uint256 lenderShare,,,,,,) = ClaimFacet(diamond).getClaimable(loanId, true);
        require(lenderAsset == address(usdc), "PF-118: the lender is repaid in the lending asset");
        require(treasuryShare > 0, "PF-118: a full-term payoff should carry a treasury share");
        require(lenderShare + treasuryShare == required, "PF-118: the lender's and treasury's shares should be the debt");
        require(surplus == proceeds - required, "PF-118: the proceeds above the debt should reach the borrower");
        (address collAsset, uint256 residual,,,,,,) = ClaimFacet(diamond).getClaimable(loanId, false);
        require(collAsset == address(weth) && residual == COLLATERAL_AMOUNT - toSell,
            "PF-118: the unsold collateral should be the borrower's claim");
        console.log("Lender / treasury / borrower surplus:", lenderShare, treasuryShare, surplus);

        uint256 lenderBefore = usdc.balanceOf(lender);
        uint256 wethBefore = weth.balanceOf(borrower);
        _claimBoth(lenderKey, borrowerKey, loanId);
        require(usdc.balanceOf(lender) - lenderBefore == lenderShare, "PF-118: the lender claims its share");
        require(weth.balanceOf(borrower) - wethBefore == residual, "PF-118: the borrower claims the unsold collateral");
    }

    // ─── PF-119 ───────────────────────────────────────────────────────────

    /// @dev The lender opted into partial repayment. A quarter of the
    ///      collateral is sold; the proceeds pay the accrued interest first
    ///      (lender and treasury) and the rest comes off the principal, paid
    ///      straight to the lender. On a loan opened moments earlier no whole
    ///      day has accrued, so the interest share is 0 here and the whole
    ///      proceeds come off the principal; the accounting check does not
    ///      assume that.
    function _swapToRepayPartial(LibSwap.AdapterCall[] memory route) internal {
        LibVaipakam.CreateOfferParams memory offer = _lenderOfferStandard();
        offer.allowsPartialRepay = true;
        uint256 loanId = _openLoan(offer);
        LibVaipakam.Loan memory before = LoanFacet(diamond).getLoanDetails(loanId);

        uint256 sell = COLLATERAL_AMOUNT / 4;
        uint256 proceeds = adapter.quote(address(weth), address(usdc), sell);
        uint256 lenderBefore = usdc.balanceOf(lender);
        uint256 borrowerBefore = usdc.balanceOf(borrower);
        uint256 treasuryBefore = _treasuryUsdc();
        vm.startBroadcast(borrowerKey);
        SwapToRepayPartialFacet(diamond).swapToRepayPartial(loanId, sell, route);
        vm.stopBroadcast();

        LibVaipakam.Loan memory afterLoan = LoanFacet(diamond).getLoanDetails(loanId);
        require(afterLoan.status == LibVaipakam.LoanStatus.Active, "PF-119: the loan should stay Active");
        require(before.collateralAmount - afterLoan.collateralAmount == sell,
            "PF-119: the loan's collateral should fall by the amount sold");
        uint256 principalCut = before.principal - afterLoan.principal;
        uint256 lenderIn = usdc.balanceOf(lender) - lenderBefore;
        uint256 treasuryIn = _treasuryUsdc() - treasuryBefore;
        uint256 borrowerIn = usdc.balanceOf(borrower) - borrowerBefore;
        require(principalCut > 0 && principalCut <= lenderIn, "PF-119: the principal cut should be paid to the lender");
        require(lenderIn + treasuryIn + borrowerIn == proceeds,
            "PF-119: the lender, treasury and borrower shares should add up to the proceeds");
        // Whatever the lender received above the principal cut, plus the
        // treasury's share, is the interest accrued so far.
        uint256 interestPaid = lenderIn - principalCut + treasuryIn;
        console.log("Principal cut / interest paid / borrower surplus:", principalCut, interestPaid, borrowerIn);

        _repayInFull(borrowerKey, loanId);
        _claimBoth(lenderKey, borrowerKey, loanId);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _openLoan(LibVaipakam.CreateOfferParams memory offer) internal returns (uint256 loanId) {
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, offer.amount);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(offer);
        vm.stopBroadcast();
        loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        console.log("Loan initiated:", loanId);
    }
}
