// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {PositiveFlowsBase} from "./PositiveFlowsBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../../src/facets/AddCollateralFacet.sol";
import {PrecloseFacet} from "../../src/facets/PrecloseFacet.sol";

/**
 * @title PositiveFlowsBasicLifecycle
 * @notice The Basic-mode lending backbone (#848 Phase 1): ERC-20 offers from
 *         either side, third-party repay, add collateral, direct preclose,
 *         illiquid collateral and lending assets, ERC-721 and ERC-1155
 *         collateral, and ERC-721 and ERC-1155 rentals. Each scenario
 *         opens a position, closes it and has both sides claim.
 *
 *         These were scenarios 1-15 of the retired `SepoliaPositiveFlows`
 *         suite. Its scenario 8 (a lender selling through a buy offer) is the
 *         same flow as {PositiveFlowsAdvancedCredit}'s PF-230 and is run there
 *         only. Its scenarios 5 and 6 (cancelling an unaccepted offer) are
 *         in {PositiveFlowsTimed}, which can step past the cancel cooldown.
 *         Fixture, runner and ids: {PositiveFlowsBase}.
 */
contract PositiveFlowsBasicLifecycle is PositiveFlowsBase {
    function moduleName() public pure override returns (string memory) {
        return "PositiveFlowsBasicLifecycle";
    }

    function scenarios() public pure override returns (Scenario[] memory list) {
        list = new Scenario[](12);
        list[0] = Scenario("PF-090", "Borrower accepts a lender ERC-20 offer, repays, both claim",
            "PF-040, PF-090, PF-110, PF-112, PF-113");
        list[1] = Scenario("PF-111", "A third party repays the borrower's loan; both parties claim",
            "PF-040, PF-090, PF-111, PF-112, PF-113");
        list[2] = Scenario("PF-091", "Lender accepts a borrower ERC-20 offer, borrower repays, both claim",
            "PF-041, PF-091, PF-110, PF-112, PF-113");
        list[3] = Scenario("PF-160", "Borrower adds collateral to an active liquid loan, then repays",
            "PF-160, PF-110");
        list[4] = Scenario("PF-210", "Borrower precloses directly, both claim", "PF-210, PF-112, PF-113");
        list[5] = Scenario("PF-094", "Liquid USDC loan against illiquid ERC-20 collateral, with consent",
            "PF-094, PF-110, PF-112, PF-113");
        list[6] = Scenario("PF-092", "ERC-721 collateral loan starts and closes", "PF-092, PF-110, PF-112, PF-113");
        list[7] = Scenario("PF-093", "ERC-1155 collateral loan starts and closes", "PF-093, PF-110, PF-112, PF-113");
        list[8] = Scenario("PF-140", "ERC-721 rental offer accepted and closed normally", "PF-042, PF-140, PF-143");
        list[9] = Scenario("PF-141", "ERC-1155 rental offer accepted and closed normally", "PF-043, PF-141, PF-143");
        list[10] = Scenario("PF-096", "Illiquid lending asset against illiquid collateral, dual consent",
            "PF-096, PF-110, PF-112, PF-113");
        list[11] = Scenario("PF-095", "Illiquid lending asset against liquid WETH collateral",
            "PF-095, PF-110, PF-112, PF-113");
    }

    function _runScenario(uint256 index) internal override {
        if (index == 0) _lenderOfferRepayClaim();
        else if (index == 1) _thirdPartyRepay();
        else if (index == 2) _borrowerOfferRepayClaim();
        else if (index == 3) _addCollateral();
        else if (index == 4) _precloseDirect();
        else if (index == 5) _illiquidCollateral();
        else if (index == 6) _erc721Collateral();
        else if (index == 7) _erc1155Collateral();
        else if (index == 8) _erc721Rental();
        else if (index == 9) _erc1155Rental();
        else if (index == 10) _illiquidLendingIlliquidCollateral();
        else if (index == 11) _illiquidLendingLiquidCollateral();
        else revert("PositiveFlowsBasicLifecycle: no scenario at index");
    }

    // ─── PF-090 ───────────────────────────────────────────────────────────

    function _lenderOfferRepayClaim() internal {
        uint256 offerId = _createLenderOffer(lenderKey);
        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        console.log("Loan initiated, loanId:", loanId);
        require(
            LoanFacet(diamond).getLoanDetails(loanId).status == LibVaipakam.LoanStatus.Active,
            "PF-090: loan should be Active after accept"
        );
        _repayInFull(borrowerKey, loanId);
        _claimBoth(lenderKey, borrowerKey, loanId);
    }

    // ─── PF-111 ───────────────────────────────────────────────────────────

    /// @dev Admin repays on the borrower's behalf; the claims still belong
    ///      to the two position holders.
    function _thirdPartyRepay() internal {
        uint256 offerId = _createLenderOffer(lenderKey);
        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        console.log("Loan initiated, loanId:", loanId);
        _repayInFull(adminKey, loanId);
        console.log("Admin (third party) repaid the loan");
        _claimBoth(lenderKey, borrowerKey, loanId);
    }

    // ─── PF-091 ───────────────────────────────────────────────────────────

    /// @dev The borrower's offer locks the collateral. The lender's accept
    ///      pulls the principal from the lender's wallet into the lender's
    ///      vault inline (the `vaultDepositERC20` chokepoint), so an approve
    ///      is all the lender needs.
    function _borrowerOfferRepayClaim() internal {
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_borrowerOfferStandard());
        vm.stopBroadcast();
        console.log("Borrower created offer:", offerId);

        uint256 loanId = _acceptAs(lenderKey, offerId, address(usdc), LOAN_AMOUNT);
        console.log("Lender accepted, loanId:", loanId);
        _repayInFull(borrowerKey, loanId);
        _claimBoth(lenderKey, borrowerKey, loanId);
    }

    // ─── PF-160 ───────────────────────────────────────────────────────────

    function _addCollateral() internal {
        uint256 offerId = _createLenderOffer(lenderKey);
        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        console.log("Loan initiated, loanId:", loanId);

        uint256 collateralBefore = LoanFacet(diamond).getLoanDetails(loanId).collateralAmount;
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, 0.5e18);
        AddCollateralFacet(diamond).addCollateral(loanId, 0.5e18);
        vm.stopBroadcast();
        require(
            LoanFacet(diamond).getLoanDetails(loanId).collateralAmount == collateralBefore + 0.5e18,
            "PF-160: loan collateral should grow by the amount added"
        );
        console.log("Borrower added 0.5 WETH collateral");

        _repayInFull(borrowerKey, loanId);
        _claimBoth(lenderKey, borrowerKey, loanId);
    }

    // ─── PF-210 ───────────────────────────────────────────────────────────

    function _precloseDirect() internal {
        uint256 offerId = _createLenderOffer(newLenderKey);
        uint256 loanId = _acceptAs(newBorrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        console.log("Loan initiated, loanId:", loanId);

        vm.startBroadcast(newBorrowerKey);
        uint256 fullTermInterest = (LOAN_AMOUNT * INTEREST_BPS * DURATION_DAYS) / (365 * 10000);
        // Generous: covers principal plus full-term interest under either
        // preclose interest rule.
        usdc.approve(diamond, LOAN_AMOUNT + 2 * fullTermInterest);
        PrecloseFacet(diamond).precloseDirect(loanId);
        vm.stopBroadcast();
        console.log("Borrower preclosed the loan");

        _claimBoth(newLenderKey, newBorrowerKey, loanId);
    }

    // ─── PF-094 ───────────────────────────────────────────────────────────

    /// @dev LTV/HF checks do not apply to illiquid collateral; both sides
    ///      consent to the full-collateral default rule.
    function _illiquidCollateral() internal {
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.collateralAsset = address(illiquidToken);
        p.collateralAmount = 200e18;
        p.collateralAmountMax = 200e18;
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(p);
        vm.stopBroadcast();
        console.log("Lender offer created:", offerId);

        uint256 loanId = _acceptAs(borrowerKey, offerId, address(illiquidToken), 200e18);
        console.log("Loan initiated, loanId:", loanId);
        _repayInFull(borrowerKey, loanId);
        _claimBoth(lenderKey, borrowerKey, loanId);
    }

    // ─── PF-092 ───────────────────────────────────────────────────────────

    function _erc721Collateral() internal {
        LibVaipakam.CreateOfferParams memory p = _borrowerOfferStandard();
        p.collateralAsset = address(nft721);
        p.collateralAmount = 1;
        p.collateralAmountMax = 1;
        p.collateralAssetType = LibVaipakam.AssetType.ERC721;
        p.collateralTokenId = 110; // the borrower's
        vm.startBroadcast(borrowerKey);
        nft721.approve(diamond, 110);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(p);
        vm.stopBroadcast();
        console.log("Borrower offer with ERC-721 collateral:", offerId);

        uint256 loanId = _acceptAs(lenderKey, offerId, address(usdc), LOAN_AMOUNT);
        console.log("Loan initiated, loanId:", loanId);
        _repayInFull(borrowerKey, loanId);
        _claimBoth(lenderKey, borrowerKey, loanId);
    }

    // ─── PF-093 ───────────────────────────────────────────────────────────

    function _erc1155Collateral() internal {
        LibVaipakam.CreateOfferParams memory p = _borrowerOfferStandard();
        p.collateralAsset = address(nft1155);
        p.collateralAmount = 10;
        p.collateralAmountMax = 10;
        p.collateralAssetType = LibVaipakam.AssetType.ERC1155;
        p.collateralTokenId = 1;
        p.collateralQuantity = 10;
        vm.startBroadcast(borrowerKey);
        nft1155.setApprovalForAll(diamond, true);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(p);
        vm.stopBroadcast();
        console.log("Borrower offer with ERC-1155 collateral:", offerId);

        uint256 loanId = _acceptAs(lenderKey, offerId, address(usdc), LOAN_AMOUNT);
        console.log("Loan initiated, loanId:", loanId);
        _repayInFull(borrowerKey, loanId);
        _claimBoth(lenderKey, borrowerKey, loanId);
    }

    // ─── PF-140 / PF-141 ──────────────────────────────────────────────────

    /// @dev A 7-day rental at `dailyFee`. A rental names no collateral
    ///      (#2949), so every collateral field is left empty; the prepay
    ///      token is its commitment. The renter prepays 7 days plus the 5% buffer, the
    ///      rental is closed, and the lender reclaims the NFT and fees while
    ///      the renter takes back what the close did not consume.
    function _rental(
        address nft,
        LibVaipakam.AssetType assetType,
        uint256 tokenId,
        uint256 quantity,
        uint256 dailyFee
    ) internal {
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.lendingAsset = nft;
        p.amount = dailyFee;
        p.amountMax = dailyFee;
        p.interestRateBps = 0;
        p.interestRateBpsMax = 0;
        // A rental names no collateral (#2949): the prepay is its commitment.
        p.collateralAsset = address(0);
        p.collateralAmount = 0;
        p.collateralAmountMax = 0;
        p.durationDays = 7;
        p.assetType = assetType;
        p.tokenId = tokenId;
        p.quantity = quantity;

        vm.startBroadcast(newLenderKey);
        if (assetType == LibVaipakam.AssetType.ERC721) nft721.approve(diamond, tokenId);
        else nft1155.setApprovalForAll(diamond, true);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(p);
        vm.stopBroadcast();
        console.log("Lender rental offer:", offerId);

        uint256 totalPrepay = dailyFee * 7 + (dailyFee * 7 * 500) / 10000;
        uint256 loanId = _acceptAs(newBorrowerKey, offerId, address(usdc), totalPrepay);
        console.log("Rental initiated, loanId:", loanId);

        vm.startBroadcast(newBorrowerKey);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        console.log("Rental closed");

        _claimBoth(newLenderKey, newBorrowerKey, loanId);
    }

    /// @dev ERC-721 id 120 belongs to newLender.
    function _erc721Rental() internal {
        _rental(address(nft721), LibVaipakam.AssetType.ERC721, 120, 1, DAILY_FEE);
    }

    /// @dev Five units of ERC-1155 id 1 at 5 USDC a day.
    function _erc1155Rental() internal {
        _rental(address(nft1155), LibVaipakam.AssetType.ERC1155, 1, 5, 5e6);
    }

    // ─── PF-096 ───────────────────────────────────────────────────────────

    function _illiquidLendingIlliquidCollateral() internal {
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.lendingAsset = address(illiquidLending);
        p.amount = 500e18;
        p.amountMax = 500e18;
        p.prepayAsset = address(illiquidLending);
        p.collateralAsset = address(illiquidToken);
        p.collateralAmount = 1000e18;
        p.collateralAmountMax = 1000e18;
        vm.startBroadcast(lenderKey);
        illiquidLending.approve(diamond, 500e18);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(p);
        vm.stopBroadcast();
        console.log("Lender offer (both legs illiquid):", offerId);

        uint256 loanId = _acceptAs(borrowerKey, offerId, address(illiquidToken), 1000e18);
        console.log("Loan initiated, loanId:", loanId);

        vm.startBroadcast(borrowerKey);
        illiquidLending.approve(diamond, 600e18); // generous: principal + interest
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        _claimBoth(lenderKey, borrowerKey, loanId);
    }

    // ─── PF-095 ───────────────────────────────────────────────────────────

    function _illiquidLendingLiquidCollateral() internal {
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.lendingAsset = address(illiquidToken);
        p.amount = 200e18;
        p.amountMax = 200e18;
        p.prepayAsset = address(illiquidToken);
        vm.startBroadcast(lenderKey);
        illiquidToken.approve(diamond, 200e18);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(p);
        vm.stopBroadcast();
        console.log("Lender offer (illiquid lending, liquid collateral):", offerId);

        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        console.log("Loan initiated, loanId:", loanId);

        vm.startBroadcast(borrowerKey);
        illiquidToken.approve(diamond, 300e18); // generous: principal + interest
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        _claimBoth(lenderKey, borrowerKey, loanId);
    }
}
