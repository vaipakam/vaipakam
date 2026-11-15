// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {Vm} from "forge-std/Vm.sol";
import {PositiveFlowsStaged} from "./PositiveFlowsStaged.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../../src/facets/OfferCancelFacet.sol";
import {OfferMatchFacet} from "../../src/facets/OfferMatchFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {AddCollateralFacet} from "../../src/facets/AddCollateralFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {EarlyWithdrawalFacet} from "../../src/facets/EarlyWithdrawalFacet.sol";
import {AutoLifecycleSettingsFacet} from "../../src/facets/AutoLifecycleSettingsFacet.sol";

/**
 * @title PositiveFlowsMidpoints
 * @notice UI-testable midpoint states (#3574). Each scenario walks the
 *         Diamond to one MID-CYCLE state and STOPS there, so the app, the
 *         indexer and the keeper can be checked against it by hand: an open
 *         offer to accept, an active loan to repay, a repaid loan neither side
 *         has claimed, a listing with no buyer. It replaces the two
 *         single-broadcast midpoint scripts (`BaseSepoliaPartialFlows`,
 *         `AnvilNewPartialFlows`) and their composer (`PartialFlows`), which
 *         posted and filled in one broadcast and so stopped before sending
 *         anything once the offer-age rule (#3412) arrived.
 *         It also replaces the two testnet seeding scripts, `SepoliaOpenOffers`
 *         (now MID-G, a varied offer book) and `SepoliaActiveLoan` (MID-C),
 *         which deployed their own tokens and price feeds on every run and so
 *         left the earlier run's offers and loans unpriced.
 *
 *         It is a staged module ({PositiveFlowsStaged}): a scenario that
 *         fills an offer posts it in one step and fills it in the next, once
 *         its terms have stood the minimum age. `run()` is the simulation and
 *         `stage()` the broadcastable run
 *         (`script/positive-flows/run-staged.sh PositiveFlowsMidpoints`).
 *         Fixture, actors and amounts: {PositiveFlowsBase}.
 *
 *         THE STATES ARE LEFT ON PURPOSE, SO NONE IS RECORDED TO RESTORE.
 *         An open offer, an active loan, a keeper approval or a stray token
 *         in a vault is what the scenario exists to leave, so no step names
 *         it with {_toRestore}; `finish()` passes with every state still in
 *         place and `unwind()` leaves them alone. The module changes no
 *         protocol setting. Every state sits on this run's own fixture tokens,
 *         so a later run of any module neither sees nor disturbs it, with one
 *         exception: P-P leaves `newBorrower` approved as the borrower's
 *         keeper, an approval that is per wallet, not per token.
 *         PositiveFlowsKeeperAutomation revokes an approval it finds before
 *         granting its own, so it is not blocked by it.
 *
 *         Not here, because the state needs a wait this runner is not the
 *         place for or a price move the UI checks do not need: a defaulted
 *         loan (grace past maturity), a loan in the health-factor warning
 *         band, periodic interest overdue and a borrower offset offer. Unit
 *         tests and the timed module cover those flows.
 */
contract PositiveFlowsMidpoints is PositiveFlowsStaged {
    /// @dev The offer a scenario's first step posts and its second fills.
    string private constant OFFER = "offer";
    /// @dev P-G's range lender offer, partly filled by the match.
    string private constant RANGE_OFFER = "rangeOffer";
    /// @dev P-G's borrower offer, matched against the range offer.
    string private constant BORROWER_OFFER = "borrowerOffer";

    /// @dev ERC-721 id 110 belongs to `borrower`, 120 to `newLender`
    ///      ({PositiveFlowsBase} mints 100-139).
    uint256 private constant BORROWER_NFT = 110;
    uint256 private constant LENDER_NFT = 120;
    /// @dev The days a rental runs.
    uint256 private constant RENTAL_DAYS = 7;

    function moduleName() public pure override returns (string memory) {
        return "PositiveFlowsMidpoints";
    }

    function scenarios() public pure override returns (Scenario[] memory list) {
        list = new Scenario[](14);
        list[0] = Scenario("MID-A", "Open lender offer, left for a borrower to accept", "MID-A");
        list[1] = Scenario("MID-B", "Open borrower offer, left for a lender to accept", "MID-B");
        list[2] = Scenario("MID-C", "Active liquid loan, left to repay, add collateral or preclose", "MID-C");
        list[3] = Scenario("P-H", "Repaid loan neither side has claimed", "P-H, MID-D");
        list[4] = Scenario("MID-E", "Active loan on ERC-721 collateral", "MID-E");
        list[5] = Scenario("MID-F", "Active ERC-721 rental", "MID-F");
        list[6] = Scenario("P-G", "Two offer states: one fully filled, one range offer partly filled and still open", "P-G");
        list[7] = Scenario("P-N", "Active loan with one partial repayment applied", "P-N");
        list[8] = Scenario("P-O", "Active loan whose collateral was doubled", "P-O");
        list[9] = Scenario("P-P", "Active loan with a keeper approved to start a preclose", "P-P");
        list[10] = Scenario("P-Q", "Active loan with a refinance request posted and no lender yet", "P-Q");
        list[11] = Scenario("P-T", "Active loan whose lender listed the position, no buyer yet", "P-T");
        list[12] = Scenario("P-U", "Stray ERC-20 in a vault, recovery not started", "P-U");
        list[13] = Scenario("MID-G", "A varied offer book: three lender and two borrower offers on different terms", "MID-G");
    }

    /// @dev The open offers, the offer book and the stray token take one step;
    ///      every other scenario posts, then fills once the terms have stood
    ///      the minimum age.
    function _stepCount(uint256 index) internal pure override returns (uint256) {
        return (index == 0 || index == 1 || index == 12 || index == 13) ? 1 : 2;
    }

    function _runStep(uint256 index, uint256 step) internal override {
        if (index == 0) return _openLenderOffer();
        if (index == 1) return _openBorrowerOffer();
        if (index == 12) return _strayTokenInVault();
        if (index == 13) return _offerBookSpread();
        if (index == 6) return step == 0 ? _postOfferStates() : _fillOfferStates();
        if (step == 0) return _keep(OFFER, _post(index));

        if (index == 2) _activeLiquidLoan(_kept(OFFER));
        else if (index == 3) _repaidUnclaimed(_kept(OFFER));
        else if (index == 4) _activeNftCollateralLoan(_kept(OFFER));
        else if (index == 5) _activeRental(_kept(OFFER));
        else if (index == 7) _partialRepayApplied(_kept(OFFER));
        else if (index == 8) _collateralDoubled(_kept(OFFER));
        else if (index == 9) _keeperApproved(_kept(OFFER));
        else if (index == 10) _refinanceRequestPosted(_kept(OFFER));
        else if (index == 11) _loanSaleListed(_kept(OFFER));
        else revert("PositiveFlowsMidpoints: no scenario at index");
    }

    /// @dev The offer a two-step scenario's first step posts.
    function _post(uint256 index) internal returns (uint256) {
        if (index == 2) return _createLenderOffer(newLenderKey);
        if (index == 4) return _postNftCollateralOffer();
        if (index == 5) return _postRentalOffer();
        if (index == 7) {
            LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
            p.allowsPartialRepay = true;
            return _postAs(lenderKey, p, address(usdc), LOAN_AMOUNT);
        }
        return _createLenderOffer(lenderKey);
    }

    // ─── MID-A / MID-B ────────────────────────────────────────────────────

    function _openLenderOffer() internal {
        uint256 offerId = _createLenderOffer(lenderKey);
        _requireOpen(offerId, "MID-A: the lender offer should stay open");
        console.log("Action: accept this offer from the borrower side of the app:", offerId);
    }

    function _openBorrowerOffer() internal {
        uint256 offerId = _postAs(borrowerKey, _borrowerOfferStandard(), address(weth), COLLATERAL_AMOUNT);
        _requireOpen(offerId, "MID-B: the borrower offer should stay open");
        console.log("Action: accept this offer from the lender side of the app:", offerId);
    }

    // ─── MID-C ────────────────────────────────────────────────────────────

    /// @dev newLender's offer, filled by newBorrower, so the loan sits apart
    ///      from the lender / borrower loans the other scenarios open.
    function _activeLiquidLoan(uint256 offerId) internal {
        uint256 loanId = _acceptAs(newBorrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        _requireActive(loanId, "MID-C: the loan should be Active");
        console.log("Action: repay, add collateral or preclose from Loan Details; loan:", loanId);
    }

    // ─── P-H (MID-D) ──────────────────────────────────────────────────────

    /// @dev Repaid with no claim made, so the Claim Center shows the lender's
    ///      principal and interest beside the borrower's collateral.
    function _repaidUnclaimed(uint256 offerId) internal {
        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        _repayInFull(borrowerKey, loanId);
        require(
            LoanFacet(diamond).getLoanDetails(loanId).status == LibVaipakam.LoanStatus.Repaid,
            "P-H: the loan should be Repaid"
        );
        console.log("Action: claim from both sides in the Claim Center; loan:", loanId);
    }

    // ─── MID-E ────────────────────────────────────────────────────────────

    function _postNftCollateralOffer() internal returns (uint256 offerId) {
        LibVaipakam.CreateOfferParams memory p = _borrowerOfferStandard();
        p.collateralAsset = address(nft721);
        p.collateralAmount = 1;
        p.collateralAmountMax = 1;
        p.collateralAssetType = LibVaipakam.AssetType.ERC721;
        p.collateralTokenId = BORROWER_NFT;
        vm.startBroadcast(borrowerKey);
        nft721.approve(diamond, BORROWER_NFT);
        offerId = OfferCreateFacet(diamond).createOffer(p, type(uint64).max);
        vm.stopBroadcast();
        console.log("Borrower offer with ERC-721 collateral:", offerId);
    }

    function _activeNftCollateralLoan(uint256 offerId) internal {
        uint256 loanId = _acceptAs(lenderKey, offerId, address(usdc), LOAN_AMOUNT);
        _requireActive(loanId, "MID-E: the NFT-collateral loan should be Active");
        console.log("Action: inspect the NFT collateral on Loan Details; loan:", loanId);
    }

    // ─── MID-F ────────────────────────────────────────────────────────────

    /// @dev A rental names no collateral (#2949); the prepay is its commitment.
    function _postRentalOffer() internal returns (uint256 offerId) {
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.lendingAsset = address(nft721);
        p.amount = DAILY_FEE;
        p.amountMax = DAILY_FEE;
        p.interestRateBps = 0;
        p.interestRateBpsMax = 0;
        p.collateralAsset = address(0);
        p.collateralAmount = 0;
        p.collateralAmountMax = 0;
        p.durationDays = RENTAL_DAYS;
        p.assetType = LibVaipakam.AssetType.ERC721;
        p.tokenId = LENDER_NFT;
        p.quantity = 1;
        vm.startBroadcast(newLenderKey);
        nft721.approve(diamond, LENDER_NFT);
        offerId = OfferCreateFacet(diamond).createOffer(p, type(uint64).max);
        vm.stopBroadcast();
        console.log("Lender rental offer:", offerId);
    }

    /// @dev The renter prepays the days plus the 5% buffer.
    function _activeRental(uint256 offerId) internal {
        uint256 prepay = DAILY_FEE * RENTAL_DAYS + (DAILY_FEE * RENTAL_DAYS * 500) / 10_000;
        uint256 loanId = _acceptAs(newBorrowerKey, offerId, address(usdc), prepay);
        _requireActive(loanId, "MID-F: the rental should be Active");
        console.log("Action: open the rental position; close it by repay and claim; loan:", loanId);
    }

    // ─── P-G ──────────────────────────────────────────────────────────────

    /// @dev Posts the three offers: lender's single-value offer (to be filled
    ///      whole), newLender's range offer [1k, 5k], and newBorrower's 1k
    ///      offer that the match fills against the range offer's lower bound.
    function _postOfferStates() internal {
        _keep(OFFER, _createLenderOffer(lenderKey));

        LibVaipakam.CreateOfferParams memory range = _lenderOfferStandard();
        range.amountMax = LOAN_AMOUNT * 5;
        // The collateral floor scales with amountMax, and a lender offer keeps
        // collateralAmountMax equal to collateralAmount
        // (LenderCollateralRangeNotAllowed).
        range.collateralAmount = 5 * COLLATERAL_AMOUNT;
        range.collateralAmountMax = 5 * COLLATERAL_AMOUNT;
        _keep(RANGE_OFFER, _postAs(newLenderKey, range, address(usdc), LOAN_AMOUNT * 5));

        _keep(BORROWER_OFFER, _postAs(newBorrowerKey, _borrowerOfferStandard(), address(weth), COLLATERAL_AMOUNT));
    }

    /// @dev Fills the single-value offer whole and matches 1k of the range offer.
    function _fillOfferStates() internal {
        uint256 filledOfferId = _kept(OFFER);
        uint256 loanId = _acceptAs(borrowerKey, filledOfferId, address(weth), COLLATERAL_AMOUNT);
        console.log("Filled offer:", filledOfferId, "loan:", loanId);

        uint256 rangeOfferId = _kept(RANGE_OFFER);
        vm.startBroadcast(deployerKey);
        OfferMatchFacet(diamond).matchOffers(rangeOfferId, _kept(BORROWER_OFFER));
        vm.stopBroadcast();

        LibVaipakam.Offer memory range = OfferCancelFacet(diamond).getOffer(rangeOfferId);
        require(
            range.amountFilled > 0 && range.amountFilled < range.amountMax,
            "P-G: the range offer should be partly filled and still open"
        );
        console.log("Partly filled offer:", rangeOfferId, "amountFilled:", range.amountFilled);
    }

    // ─── P-N ──────────────────────────────────────────────────────────────

    /// @dev The lender opted into partial repayment; the borrower repays 30%.
    function _partialRepayApplied(uint256 offerId) internal {
        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        uint256 partialAmt = (LOAN_AMOUNT * 30) / 100;
        vm.startBroadcast(borrowerKey);
        // Covers the part repaid plus the interest accrued to it.
        usdc.approve(diamond, partialAmt + 100e6);
        RepayFacet(diamond).repayPartial(loanId, partialAmt);
        vm.stopBroadcast();

        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        require(loan.status == LibVaipakam.LoanStatus.Active, "P-N: the loan should still be Active");
        require(loan.principal == LOAN_AMOUNT - partialAmt, "P-N: the principal should drop by the part repaid");
        console.log("Loan", loanId, "principal after the partial repayment:", loan.principal);
    }

    // ─── P-O ──────────────────────────────────────────────────────────────

    function _collateralDoubled(uint256 offerId) internal {
        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        AddCollateralFacet(diamond).addCollateral(loanId, COLLATERAL_AMOUNT);
        vm.stopBroadcast();
        require(
            LoanFacet(diamond).getLoanDetails(loanId).collateralAmount == 2 * COLLATERAL_AMOUNT,
            "P-O: the loan's collateral should have doubled"
        );
        console.log("Loan", loanId, "collateral doubled");
    }

    // ─── P-P ──────────────────────────────────────────────────────────────

    /// @dev The borrower turns on its three keeper switches for newBorrower:
    ///      the master switch, the per-action approval (start a preclose) and
    ///      the per-loan opt-in. `approveKeeper` refuses a keeper that is
    ///      already approved, so an approval another run left is revoked
    ///      first, but only when the chain shows one (a revoke with nothing to
    ///      revoke would be refused on the broadcast).
    function _keeperApproved(uint256 offerId) internal {
        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        address keeper = newBorrower;
        bool alreadyApproved = ProfileFacet(diamond).isApprovedKeeper(borrower, keeper);
        vm.startBroadcast(borrowerKey);
        ProfileFacet(diamond).setKeeperAccess(true);
        if (alreadyApproved) ProfileFacet(diamond).revokeKeeper(keeper);
        ProfileFacet(diamond).approveKeeper(keeper, LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE);
        ProfileFacet(diamond).setLoanKeeperEnabled(loanId, keeper, true);
        vm.stopBroadcast();
        require(ProfileFacet(diamond).isApprovedKeeper(borrower, keeper), "P-P: the keeper should be approved");
        console.log("Keeper newBorrower may start a preclose on loan:", loanId);
    }

    // ─── P-Q ──────────────────────────────────────────────────────────────

    /// @dev The borrower posts a refinance request against its loan at half
    ///      the rate, with the payoff permit a lender's accept will spend
    ///      (#1558), and no lender takes it. A request needs the loan's
    ///      refinance caps set first (the highest rate it may move to and
    ///      until when), here 6% for a year. A refinance request carries the
    ///      old collateral over, so it locks no new collateral.
    function _refinanceRequestPosted(uint256 offerId) internal {
        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        LibVaipakam.CreateOfferParams memory request = _borrowerOfferStandard();
        request.interestRateBps = INTEREST_BPS / 2;
        request.interestRateBpsMax = INTEREST_BPS / 2;
        request.fillMode = LibVaipakam.FillMode.Aon; // a refinance request is all-or-nothing
        request.refinanceTargetLoanId = loanId;
        vm.startBroadcast(borrowerKey);
        AutoLifecycleSettingsFacet(diamond).setAutoRefinanceCaps(loanId, true, 600, uint64(block.timestamp + 365 days));
        uint256 requestId = OfferCreateFacet(diamond).createOffer(request, type(uint64).max);
        vm.stopBroadcast();
        if (!_attachPayoffPermit(borrowerKey, loanId, requestId)) {
            return _skip("Permit2 is not deployed on this chain, so a refinance request cannot carry its payoff");
        }
        _requireOpen(requestId, "P-Q: the refinance request should stay open");
        require(
            OfferCancelFacet(diamond).getOfferDetails(requestId).refinanceCarryOver,
            "P-Q: the request should carry the old collateral over"
        );
        console.log("Refinance request:", requestId, "against loan:", loanId);
    }

    // ─── P-T ──────────────────────────────────────────────────────────────

    /// @dev The lender lists its position for seven days at the loan's rate,
    ///      and no buyer takes it.
    function _loanSaleListed(uint256 offerId) internal {
        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        vm.recordLogs();
        vm.startBroadcast(lenderKey);
        EarlyWithdrawalFacet(diamond).createLoanSaleOffer(
            loanId, INTEREST_BPS, true, 7 days, 0, type(uint256).max, type(uint64).max
        );
        vm.stopBroadcast();
        uint256 saleOfferId;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 linked = keccak256("LoanSaleOfferLinked(uint256,uint256)");
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == linked) saleOfferId = uint256(logs[i].topics[2]);
        }
        require(saleOfferId != 0, "P-T: the listing was not created");
        _requireOpen(saleOfferId, "P-T: the listing should stay open");
        console.log("Listing:", saleOfferId, "for loan:", loanId);
    }

    // ─── P-U ──────────────────────────────────────────────────────────────

    /// @dev USDC minted straight to newBorrower's vault, beside the
    ///      protocol's tracked count, so the stuck-token recovery surface has
    ///      a difference to show. Recovery is not started.
    function _strayTokenInVault() internal {
        vm.startBroadcast(newBorrowerKey);
        address vault = VaultFactoryFacet(diamond).getOrCreateUserVault(newBorrower);
        vm.stopBroadcast();
        vm.startBroadcast(deployerKey);
        usdc.mint(vault, 50e6);
        vm.stopBroadcast();

        uint256 tracked = VaultFactoryFacet(diamond).getTrackedHolding(newBorrower, address(usdc), 0);
        require(usdc.balanceOf(vault) > tracked, "P-U: the vault should hold more than the tracked count");
        console.log("Stray USDC in vault:", usdc.balanceOf(vault) - tracked);
    }

    // ─── MID-G ────────────────────────────────────────────────────────────

    /// @dev Five open offers whose amount, rate and term differ, so the offer
    ///      book reads as a market rather than one row repeated. Each asks
    ///      collateral worth about twice its amount at the fixture's WETH price,
    ///      so every one of them can be accepted.
    function _offerBookSpread() internal {
        uint256[5] memory amounts = [uint256(500e6), 1_000e6, 2_000e6, 600e6, 1_400e6];
        uint256[5] memory collaterals = [uint256(0.5e18), 1e18, 2e18, 0.6e18, 1.5e18];
        uint256[5] memory rates = [uint256(500), 800, 1200, 600, 1000];
        uint256[5] memory terms = [uint256(7), 30, 90, 14, 60];
        for (uint256 i = 0; i < 5; i++) {
            bool lenderSide = i < 3;
            LibVaipakam.CreateOfferParams memory p = lenderSide ? _lenderOfferStandard() : _borrowerOfferStandard();
            p.amount = amounts[i];
            p.amountMax = amounts[i];
            p.collateralAmount = collaterals[i];
            p.collateralAmountMax = collaterals[i];
            p.interestRateBps = rates[i];
            p.interestRateBpsMax = rates[i];
            p.durationDays = terms[i];
            uint256 offerId = lenderSide
                ? _postAs(lenderKey, p, address(usdc), amounts[i])
                : _postAs(borrowerKey, p, address(weth), collaterals[i]);
            _requireOpen(offerId, "MID-G: every offer in the book should stay open");
        }
        console.log("Action: browse the offer book; three lender and two borrower offers are open");
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    /// @dev `key` approves `amount` of `asset` and posts `p`.
    function _postAs(uint256 key, LibVaipakam.CreateOfferParams memory p, address asset, uint256 amount)
        internal
        returns (uint256 offerId)
    {
        vm.startBroadcast(key);
        if (asset == address(usdc)) usdc.approve(diamond, amount);
        else weth.approve(diamond, amount);
        offerId = OfferCreateFacet(diamond).createOffer(p, type(uint64).max);
        vm.stopBroadcast();
        console.log("Offer posted:", offerId);
    }

    function _requireOpen(uint256 offerId, string memory failure) internal view {
        require(!OfferCancelFacet(diamond).getOffer(offerId).accepted, failure);
    }

    function _requireActive(uint256 loanId, string memory failure) internal view {
        require(LoanFacet(diamond).getLoanDetails(loanId).status == LibVaipakam.LoanStatus.Active, failure);
    }
}
