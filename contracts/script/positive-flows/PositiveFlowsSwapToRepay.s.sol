// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {PositiveFlowsStaged} from "./PositiveFlowsStaged.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../../src/libraries/LibSwap.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {ClaimViewFacet} from "../../src/facets/ClaimViewFacet.sol";
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
 *         ({PositiveFlowsStaged-_registerRunSwapAdapter}), priced at the
 *         fixture's oracle rate, so the proceeds are known before the call. Each
 *         scenario then accounts for every unit of them: the lender's share,
 *         the treasury's share and the borrower's surplus must add up to
 *         exactly what the swap returned, and the collateral that was not
 *         sold stays the borrower's. The adapter is removed from the
 *         Diamond's swap list before the scenario ends.
 *
 *         Every scenario takes two steps (#3574): the first posts the offer;
 *         the second, once its terms have stood the minimum age, registers
 *         the adapter, opens the loan, swaps, checks the split, closes the
 *         loan out and removes the adapter. The adapter is recorded as a
 *         setting to put back, so a run that stops part-way through the
 *         second step can be unwound (`unwind()`). `run()` is the simulation
 *         and `stage()` the broadcastable run ({PositiveFlowsStaged},
 *         `script/positive-flows/run-staged.sh`).
 *         Fixture and ids: {PositiveFlowsBase}.
 */
contract PositiveFlowsSwapToRepay is PositiveFlowsStaged {
    /// @dev The offer the first step posts and the second fills.
    string private constant OFFER = "offer";

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

    /// @dev Post the offer; then fill it, swap and close out.
    function _stepCount(uint256) internal pure override returns (uint256) {
        return 2;
    }

    function _runStep(uint256 index, uint256 step) internal override {
        if (step == 0) return _keep(OFFER, _postOffer(index));
        LibSwap.AdapterCall[] memory route;
        (adapter, route) = _registerRunSwapAdapter();
        uint256 loanId = _acceptAs(borrowerKey, _kept(OFFER), address(weth), COLLATERAL_AMOUNT);
        console.log("Loan initiated:", loanId);
        if (index == 0) _swapToRepayFull(loanId, route);
        else if (index == 1) _swapToRepayPartial(loanId, route);
        else revert("PositiveFlowsSwapToRepay: no scenario at index");
        _removeFixedRateAdapter(adapter);
    }

    /// @dev PF-118 lends on a full-term loan, so the payoff carries interest
    ///      and the treasury takes a share of it; PF-119's lender opts into
    ///      partial repayment.
    function _postOffer(uint256 index) internal returns (uint256) {
        LibVaipakam.CreateOfferParams memory offer = _lenderOfferStandard();
        if (index == 0) offer.useFullTermInterest = true;
        else offer.allowsPartialRepay = true;
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, offer.amount);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(offer, type(uint64).max);
        vm.stopBroadcast();
        console.log("Lender offer created:", offerId);
        return offerId;
    }

    // ─── PF-118 ───────────────────────────────────────────────────────────

    /// @dev The borrower allows the whole collateral as the bound; the
    ///      Diamond sells only the sized amount (#2317).
    function _swapToRepayFull(uint256 loanId, LibSwap.AdapterCall[] memory route) internal {
        (uint256 toSell, uint256 minOut, uint256 required) =
            SwapToRepayFacet(diamond).previewSwapToRepayFull(loanId, COLLATERAL_AMOUNT);
        uint256 proceeds = adapter.quote(address(weth), address(usdc), toSell);
        require(toSell > 0 && toSell < COLLATERAL_AMOUNT, "PF-118: the sale should be sized below the whole collateral");
        require(proceeds >= minOut && minOut >= required, "PF-118: the sized sale should clear its floor and cover the debt");
        console.log("Sized sale (WETH) / proceeds / debt:", toSell, proceeds, required);

        uint256 adapterWethBefore = weth.balanceOf(address(adapter));
        uint256 borrowerBefore = usdc.balanceOf(borrower);
        uint256 treasuryBefore = _treasuryUsdc();
        // The lender's share lands in the lender's vault and the unsold
        // collateral never leaves the borrower's (#3205 part 2); the claims
        // then settle the two positions against them. The borrower's surplus
        // is paid to its wallet.
        uint256 lenderVaultBefore = _vaultBalance(usdc, lender);
        uint256 collateralVaultBefore = _vaultBalance(weth, borrower);
        vm.startBroadcast(borrowerKey);
        SwapToRepayFacet(diamond).swapToRepayFull(loanId, route, COLLATERAL_AMOUNT, type(uint64).max);
        vm.stopBroadcast();

        require(LoanFacet(diamond).getLoanDetails(loanId).status == LibVaipakam.LoanStatus.Repaid,
            "PF-118: the loan should close as Repaid");
        require(weth.balanceOf(address(adapter)) - adapterWethBefore == toSell,
            "PF-118: exactly the sized collateral should be sold");
        uint256 surplus = usdc.balanceOf(borrower) - borrowerBefore;
        uint256 treasuryShare = _treasuryUsdc() - treasuryBefore;
        (address lenderAsset, uint256 lenderShare,,,,,,) = ClaimViewFacet(diamond).getClaimable(loanId, true);
        require(lenderAsset == address(usdc), "PF-118: the lender is repaid in the lending asset");
        require(treasuryShare > 0, "PF-118: a full-term payoff should carry a treasury share");
        require(lenderShare + treasuryShare == required, "PF-118: the lender's and treasury's shares should be the debt");
        require(_vaultBalance(usdc, lender) - lenderVaultBefore == lenderShare,
            "PF-118: the lender's share should land in the lender's vault");
        require(surplus == proceeds - required, "PF-118: the proceeds above the debt should reach the borrower");
        (address collAsset, uint256 residual,,,,,,) = ClaimViewFacet(diamond).getClaimable(loanId, false);
        require(collAsset == address(weth) && residual == COLLATERAL_AMOUNT - toSell,
            "PF-118: the unsold collateral should be the borrower's claim");
        require(collateralVaultBefore - _vaultBalance(weth, borrower) == toSell,
            "PF-118: only the sold collateral should leave the borrower's vault");
        console.log("Lender / treasury / borrower surplus:", lenderShare, treasuryShare, surplus);

        _claimBoth(lenderKey, borrowerKey, loanId);
        (,, bool lenderClaimed,,,,,) = ClaimViewFacet(diamond).getClaimable(loanId, true);
        (,, bool borrowerClaimed,,,,,) = ClaimViewFacet(diamond).getClaimable(loanId, false);
        require(lenderClaimed, "PF-118: the lender claims its share");
        require(borrowerClaimed, "PF-118: the borrower claims the unsold collateral");
    }

    // ─── PF-119 ───────────────────────────────────────────────────────────

    /// @dev The lender opted into partial repayment. A quarter of the
    ///      collateral is sold; the proceeds pay the accrued interest first
    ///      (lender and treasury) and the rest comes off the principal, paid
    ///      straight to the lender. On a loan opened moments earlier no whole
    ///      day has accrued, so the interest share is 0 here and the whole
    ///      proceeds come off the principal; the accounting check does not
    ///      assume that.
    function _swapToRepayPartial(uint256 loanId, LibSwap.AdapterCall[] memory route) internal {        LibVaipakam.Loan memory before = LoanFacet(diamond).getLoanDetails(loanId);

        uint256 sell = COLLATERAL_AMOUNT / 4;
        uint256 proceeds = adapter.quote(address(weth), address(usdc), sell);
        // Unlike the full route, the partial route pays the lender's part to
        // the lender's wallet.
        uint256 lenderBefore = usdc.balanceOf(lender);
        uint256 borrowerBefore = usdc.balanceOf(borrower);
        uint256 treasuryBefore = _treasuryUsdc();
        vm.startBroadcast(borrowerKey);
        SwapToRepayPartialFacet(diamond).swapToRepayPartial(loanId, sell, route, type(uint64).max);
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
}
