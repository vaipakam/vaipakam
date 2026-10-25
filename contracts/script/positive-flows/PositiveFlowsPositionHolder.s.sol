// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {PositiveFlowsBase} from "./PositiveFlowsBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../../src/interfaces/IVaipakamErrors.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {PrecloseFacet} from "../../src/facets/PrecloseFacet.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";
import {RevertProbe} from "../lib/RevertProbe.sol";

/**
 * @title PositiveFlowsPositionHolder
 * @notice Current-holder semantics (#848 Phase 2): a position NFT carries the
 *         authority and the proceeds of its side of the loan. Each scenario
 *         moves one side's NFT to another wallet while the loan is live, then
 *         shows that the new holder can act and claim, that the wallet which
 *         opened the position no longer can, and that the loan's recorded
 *         party for that side follows the NFT at close-out.
 *
 *         The refusals are probed in the simulation only (`RevertProbe`), so a
 *         deliberate revert neither aborts the broadcast nor spends a nonce the
 *         chain never sees. Fixture, runner and ids: {PositiveFlowsBase}.
 */
contract PositiveFlowsPositionHolder is PositiveFlowsBase {
    function moduleName() public pure override returns (string memory) {
        return "PositiveFlowsPositionHolder";
    }

    function scenarios() public pure override returns (Scenario[] memory list) {
        list = new Scenario[](2);
        list[0] = Scenario("PF-163", "Borrower position transferred: the new holder precloses and claims, the opener can do neither",
            "PF-163, PF-164, PF-210");
        list[1] = Scenario("PF-234", "Lender position transferred: the new holder claims the repayment, the opener cannot",
            "PF-234, PF-163, PF-164, PF-110");
    }

    function _runScenario(uint256 index) internal override {
        if (index == 0) _borrowerPositionTransfer();
        else if (index == 1) _lenderPositionTransfer();
        else revert("PositiveFlowsPositionHolder: no scenario at index");
    }

    // ─── PF-163 ───────────────────────────────────────────────────────────

    /// @dev `borrower` opens the loan and hands its borrower NFT to
    ///      `newBorrower`. The preclose (a borrower-role action) and the
    ///      collateral claim then belong to `newBorrower`.
    function _borrowerPositionTransfer() internal {
        uint256 offerId = _createLenderOffer(lenderKey);
        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        console.log("Loan initiated, loanId:", loanId);

        vm.startBroadcast(borrowerKey);
        VaipakamNFTFacet(diamond).transferFrom(borrower, newBorrower, loan.borrowerTokenId);
        vm.stopBroadcast();
        require(
            VaipakamNFTFacet(diamond).ownerOf(loan.borrowerTokenId) == newBorrower,
            "PF-163: the borrower NFT should now belong to newBorrower"
        );
        console.log("Borrower NFT transferred to newBorrower");

        // A borrower-role action from a wallet that neither holds the NFT
        // nor is an approved keeper for its holder is a keeper-authority
        // refusal (LibAuth.requireKeeperFor).
        _requireRefusedWith(
            borrower,
            abi.encodeWithSelector(PrecloseFacet.precloseDirect.selector, loanId),
            IVaipakamErrors.KeeperAccessRequired.selector,
            "PF-163: the opener should no longer be able to preclose (KeeperAccessRequired)"
        );

        vm.startBroadcast(newBorrowerKey);
        uint256 fullTermInterest = (LOAN_AMOUNT * INTEREST_BPS * DURATION_DAYS) / (365 * 10000);
        // Generous: covers principal plus full-term interest under either
        // preclose interest rule.
        usdc.approve(diamond, LOAN_AMOUNT + 2 * fullTermInterest);
        PrecloseFacet(diamond).precloseDirect(loanId);
        vm.stopBroadcast();
        console.log("New borrower-position holder preclosed the loan");

        // PF-164: the close-out re-anchors the borrower side to its holder.
        require(
            LoanFacet(diamond).getLoanDetails(loanId).borrower == newBorrower,
            "PF-164: the loan should record the current holder as borrower after close-out"
        );

        vm.startBroadcast(lenderKey);
        ClaimFacet(diamond).claimAsLender(loanId);
        vm.stopBroadcast();

        _requireRefusedWith(
            borrower,
            abi.encodeWithSelector(ClaimFacet.claimAsBorrower.selector, loanId),
            IVaipakamErrors.NotNFTOwner.selector,
            "PF-163: the opener should not be able to claim the collateral (NotNFTOwner)"
        );
        (address asset, uint256 amount,,,,,,) = ClaimFacet(diamond).getClaimable(loanId, false);
        require(asset == address(weth) && amount == COLLATERAL_AMOUNT, "PF-163: the borrower claim should be the WETH collateral");
        uint256 before = weth.balanceOf(newBorrower);
        vm.startBroadcast(newBorrowerKey);
        ClaimFacet(diamond).claimAsBorrower(loanId);
        vm.stopBroadcast();
        require(
            weth.balanceOf(newBorrower) - before == amount,
            "PF-163: the current holder should receive the collateral"
        );
        console.log("Current borrower-position holder claimed the collateral:", amount);
    }

    // ─── PF-234 ───────────────────────────────────────────────────────────

    /// @dev `lender` funds the loan and hands its lender NFT to `newLender`,
    ///      as a secondary-market sale would. The borrower repays, and the
    ///      principal and interest belong to `newLender`.
    function _lenderPositionTransfer() internal {
        uint256 offerId = _createLenderOffer(lenderKey);
        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        console.log("Loan initiated, loanId:", loanId);

        vm.startBroadcast(lenderKey);
        VaipakamNFTFacet(diamond).transferFrom(lender, newLender, loan.lenderTokenId);
        vm.stopBroadcast();
        require(
            VaipakamNFTFacet(diamond).ownerOf(loan.lenderTokenId) == newLender,
            "PF-234: the lender NFT should now belong to newLender"
        );
        console.log("Lender NFT transferred to newLender");

        _repayInFull(borrowerKey, loanId);

        // PF-164: the close-out re-anchors the lender side to its holder.
        require(
            LoanFacet(diamond).getLoanDetails(loanId).lender == newLender,
            "PF-164: the loan should record the current holder as lender after close-out"
        );

        _requireRefusedWith(
            lender,
            abi.encodeWithSelector(ClaimFacet.claimAsLender.selector, loanId),
            IVaipakamErrors.NotNFTOwner.selector,
            "PF-234: the opener should not be able to claim the repayment (NotNFTOwner)"
        );
        (address asset, uint256 amount,,,,,,) = ClaimFacet(diamond).getClaimable(loanId, true);
        require(asset == address(usdc), "PF-234: the lender claim should be in the lending asset");
        require(amount >= LOAN_AMOUNT, "PF-234: the lender claim should cover at least the principal");
        uint256 before = usdc.balanceOf(newLender);
        vm.startBroadcast(newLenderKey);
        ClaimFacet(diamond).claimAsLender(loanId);
        vm.stopBroadcast();
        require(
            usdc.balanceOf(newLender) - before == amount,
            "PF-234: the current holder should receive the repayment"
        );
        console.log("Current lender-position holder claimed the repayment:", amount);

        vm.startBroadcast(borrowerKey);
        ClaimFacet(diamond).claimAsBorrower(loanId);
        vm.stopBroadcast();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    /// @dev Requires `data`, sent to the Diamond as `caller`, to be refused
    ///      with the argument-free error `expected`. Runs in the simulation
    ///      only.
    function _requireRefusedWith(address caller, bytes memory data, bytes4 expected, string memory failure)
        internal
    {
        (bool ok, bytes memory ret) = RevertProbe.call(caller, diamond, data);
        require(!ok && ret.length == 4 && bytes4(ret) == expected, failure);
    }
}
