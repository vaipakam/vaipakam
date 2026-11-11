// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {PositiveFlowsStaged} from "./PositiveFlowsStaged.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../../src/interfaces/IVaipakamErrors.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {PrecloseFacet} from "../../src/facets/PrecloseFacet.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";

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
 *         chain never sees. Fixture and ids: {PositiveFlowsBase}.
 *
 *         Every scenario takes three steps (#3502): the first posts the
 *         offer; the second, once its terms have stood the minimum age, opens
 *         the loan; the third, once the position transfer cooldown has passed
 *         since the loan opened (#3413), moves the NFT and carries the loan to
 *         its close and the claims. `run()` is the simulation and `stage()`
 *         the broadcastable run ({PositiveFlowsStaged},
 *         `script/positive-flows/run-staged.sh`).
 */
contract PositiveFlowsPositionHolder is PositiveFlowsStaged {
    /// @dev The offer the first step posts and the second fills.
    string private constant OFFER = "offer";
    /// @dev The loan the second step opens and the third hands on.
    string private constant LOAN = "loan";

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

    /// @dev Post; open the loan; move the position, close and claim.
    function _stepCount(uint256) internal pure override returns (uint256) {
        return 3;
    }

    function _runStep(uint256 index, uint256 step) internal override {
        if (step == 0) return _keep(OFFER, _createLenderOffer(lenderKey));
        if (step == 1) {
            uint256 opened = _acceptAs(borrowerKey, _kept(OFFER), address(weth), COLLATERAL_AMOUNT);
            console.log("Loan initiated, loanId:", opened);
            return _keep(LOAN, opened);
        }
        if (index == 0) _borrowerPositionTransfer(_kept(LOAN));
        else if (index == 1) _lenderPositionTransfer(_kept(LOAN));
        else revert("PositiveFlowsPositionHolder: no scenario at index");
    }

    // ─── PF-163 ───────────────────────────────────────────────────────────

    /// @dev `borrower` opened the loan (step 2) and now hands its borrower
    ///      NFT to `newBorrower`. The preclose (a borrower-role action) and the
    ///      collateral claim then belong to `newBorrower`.
    function _borrowerPositionTransfer(uint256 loanId) internal {
        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);

        vm.startBroadcast(borrowerKey);
        IERC721(VaipakamNFTFacet(diamond).positionNFT()).transferFrom(borrower, newBorrower, loan.borrowerTokenId);
        vm.stopBroadcast();
        require(
            IERC721(VaipakamNFTFacet(diamond).positionNFT()).ownerOf(loan.borrowerTokenId) == newBorrower,
            "PF-163: the borrower NFT should now belong to newBorrower"
        );
        console.log("Borrower NFT transferred to newBorrower");

        // A borrower-role action from a wallet that neither holds the NFT
        // nor is an approved keeper for its holder is a keeper-authority
        // refusal (LibAuth.requireKeeperFor).
        _requireRefused(
            borrower,
            abi.encodeWithSelector(PrecloseFacet.precloseDirect.selector, loanId),
            abi.encodeWithSelector(IVaipakamErrors.KeeperAccessRequired.selector),
            "PF-163: the opener should no longer be able to preclose (KeeperAccessRequired)"
        );

        // The close-out returns the collateral to the current holder's vault
        // (#3205 part 2); the claim then settles the position against it.
        uint256 vaultBefore = _vaultBalance(weth, newBorrower);
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

        _requireRefused(
            borrower,
            abi.encodeWithSelector(ClaimFacet.claimAsBorrower.selector, loanId),
            abi.encodeWithSelector(IVaipakamErrors.NotNFTOwner.selector),
            "PF-163: the opener should not be able to claim the collateral (NotNFTOwner)"
        );
        (address asset, uint256 amount,,,,,,) = ClaimFacet(diamond).getClaimable(loanId, false);
        require(asset == address(weth) && amount == COLLATERAL_AMOUNT, "PF-163: the borrower claim should be the WETH collateral");
        require(
            _vaultBalance(weth, newBorrower) - vaultBefore == amount,
            "PF-163: the current holder's vault should receive the collateral"
        );
        vm.startBroadcast(newBorrowerKey);
        ClaimFacet(diamond).claimAsBorrower(loanId);
        vm.stopBroadcast();
        (,, bool claimed,,,,,) = ClaimFacet(diamond).getClaimable(loanId, false);
        require(claimed, "PF-163: the current holder's claim should settle the collateral");
        console.log("Current borrower-position holder claimed the collateral:", amount);
    }

    // ─── PF-234 ───────────────────────────────────────────────────────────

    /// @dev `lender` funded the loan (step 2) and now hands its lender NFT to
    ///      `newLender`, as a secondary-market sale would. The borrower
    ///      repays, and the principal and interest belong to `newLender`.
    function _lenderPositionTransfer(uint256 loanId) internal {
        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);

        vm.startBroadcast(lenderKey);
        IERC721(VaipakamNFTFacet(diamond).positionNFT()).transferFrom(lender, newLender, loan.lenderTokenId);
        vm.stopBroadcast();
        require(
            IERC721(VaipakamNFTFacet(diamond).positionNFT()).ownerOf(loan.lenderTokenId) == newLender,
            "PF-234: the lender NFT should now belong to newLender"
        );
        console.log("Lender NFT transferred to newLender");

        // The repayment lands in the current holder's vault (#3205 part 2);
        // the claim then settles the position against it.
        uint256 vaultBefore = _vaultBalance(usdc, newLender);
        _repayInFull(borrowerKey, loanId);

        // PF-164: the close-out re-anchors the lender side to its holder.
        require(
            LoanFacet(diamond).getLoanDetails(loanId).lender == newLender,
            "PF-164: the loan should record the current holder as lender after close-out"
        );

        _requireRefused(
            lender,
            abi.encodeWithSelector(ClaimFacet.claimAsLender.selector, loanId),
            abi.encodeWithSelector(IVaipakamErrors.NotNFTOwner.selector),
            "PF-234: the opener should not be able to claim the repayment (NotNFTOwner)"
        );
        (address asset, uint256 amount,,,,,,) = ClaimFacet(diamond).getClaimable(loanId, true);
        require(asset == address(usdc), "PF-234: the lender claim should be in the lending asset");
        require(amount >= LOAN_AMOUNT, "PF-234: the lender claim should cover at least the principal");
        require(
            _vaultBalance(usdc, newLender) - vaultBefore == amount,
            "PF-234: the current holder's vault should receive the repayment"
        );
        vm.startBroadcast(newLenderKey);
        ClaimFacet(diamond).claimAsLender(loanId);
        vm.stopBroadcast();
        (,, bool claimed,,,,,) = ClaimFacet(diamond).getClaimable(loanId, true);
        require(claimed, "PF-234: the current holder's claim should settle the repayment");
        console.log("Current lender-position holder claimed the repayment:", amount);

        vm.startBroadcast(borrowerKey);
        ClaimFacet(diamond).claimAsBorrower(loanId);
        vm.stopBroadcast();
    }
}
