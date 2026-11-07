// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {LibAcceptTestSigner} from "../test/helpers/LibAcceptTestSigner.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {EarlyWithdrawalDirectFacet} from "../src/facets/EarlyWithdrawalDirectFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RiskPreviewFacet} from "../src/facets/RiskPreviewFacet.sol";
import {SellerClaimFacet} from "../src/facets/SellerClaimFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {Deployments} from "./lib/Deployments.sol";
import {IRepriceDiamondViews} from "./lib/RepriceVenueReport.sol";

/**
 * @title BaseSepoliaSellerClaim
 * @notice #1209 live verification fixture. Leaves a REAL seller interest claim
 *         on the Base Sepolia Diamond, ready to withdraw: a loan the `lender`
 *         role opened, sold to the `newLender` role after the seller earned
 *         interest, then repaid in full by the `borrower` role. The withdrawal
 *         itself is NOT done here: `apps/app/e2e/live/live-seller-claim.mjs`
 *         drives it through the deployed app.
 *
 *         Three stages, run in order, each its own broadcast (`SC_STAGE`):
 *         - `open`: the lender offers `SC_PRINCIPAL` mUSDC (liquidToken2, the
 *           faucet mock, default 100 mUSDC) for 30 days at `SC_RATE_BPS`
 *           (default 900) against tLIQ (liquidToken) worth three times the
 *           principal at the Diamond's own prices; the borrower accepts.
 *           Prints the loan id.
 *         - `sell` (`SC_LOAN_ID`): the new lender posts a single-value lender
 *           offer on the loan's exact terms at the same rate (no rate
 *           shortfall, so the seller is paid the whole principal), and the
 *           lender sells into it with the BOUND direct sale, at the bounds
 *           the Diamond's own quote gives and a ten-minute deadline. Refuses
 *           unless the sale recorded a claim for the lender with something
 *           owed. Run it at least a few minutes after `open`: interest is
 *           earned per second, and a claim of zero proves nothing.
 *         - `repay` (`SC_LOAN_ID`): the borrower repays in full, approving
 *           exactly the Diamond's quote; refuses unless the loan reads Repaid
 *           and the seller's share is waiting (`getSellerInterestHeld` > 0).
 *
 *         Funds moved, all testnet mocks: the faucet mints mUSDC to the lender
 *         and the new lender and tLIQ to the borrower; the principal moves
 *         lender → borrower at open, new lender → seller at the sale, and
 *         borrower → lender side at repay; the loan-initiation fee and the
 *         treasury's interest share are taken as on any loan. Gas from all
 *         three wallets. No admin key, no price move, no config write.
 *
 *         Env (keys from contracts/.env): LENDER_PRIVATE_KEY,
 *         BORROWER_PRIVATE_KEY, NEW_LENDER_PRIVATE_KEY; `SC_STAGE`;
 *         `SC_LOAN_ID` for `sell` and `repay`. Optional: SC_PRINCIPAL (raw
 *         mUSDC), SC_RATE_BPS.
 */
contract BaseSepoliaSellerClaim is Script {
    uint32 internal constant DURATION_DAYS = 30;
    uint256 internal constant SALE_WINDOW = 10 minutes;

    function run() external {
        require(block.chainid == 84532 || block.chainid == 31337, "BaseSepoliaSellerClaim: Base Sepolia only");
        address diamond = Deployments.readDiamond();
        string memory stage = vm.envString("SC_STAGE");
        bytes32 s = keccak256(bytes(stage));
        console.log("=== Base Sepolia seller-claim fixture (#1209), stage:", stage);
        console.log("Diamond:", diamond);
        if (s == keccak256("open")) _open(diamond);
        else if (s == keccak256("sell")) _sell(diamond, vm.envUint("SC_LOAN_ID"));
        else if (s == keccak256("repay")) _repay(diamond, vm.envUint("SC_LOAN_ID"));
        else revert("BaseSepoliaSellerClaim: SC_STAGE must be open, sell or repay");
    }

    // ─── Stages ─────────────────────────────────────────────────────────────

    function _open(address diamond) internal {
        uint256 lenderKey = vm.envUint("LENDER_PRIVATE_KEY");
        uint256 borrowerKey = vm.envUint("BORROWER_PRIVATE_KEY");
        address mUsdc = _mock("liquidToken2");
        address tLiq = _mock("liquidToken");
        uint256 principal = vm.envOr("SC_PRINCIPAL", 100 * uint256(10) ** IERC20Metadata(mUsdc).decimals());
        uint256 rateBps = vm.envOr("SC_RATE_BPS", uint256(900));
        uint256 collateral = _worthThreeTimes(diamond, mUsdc, principal, tLiq);
        console.log("Principal (raw mUSDC) / collateral (raw tLIQ) / rate bps:", principal, collateral, rateBps);

        address lender = vm.addr(lenderKey);
        address borrower = vm.addr(borrowerKey);
        require(lender != borrower, "BaseSepoliaSellerClaim: lender and borrower keys are the same wallet");

        vm.startBroadcast(lenderKey);
        ERC20Mock(mUsdc).mint(lender, principal);
        ERC20Mock(mUsdc).approve(diamond, principal);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(
            _lenderOffer(mUsdc, principal, tLiq, collateral, rateBps)
        );
        vm.stopBroadcast();

        LibAcceptTerms.AcceptTerms memory terms =
            LibAcceptTestSigner.buildTerms(diamond, borrower, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(diamond, terms, borrowerKey);
        vm.startBroadcast(borrowerKey);
        ERC20Mock(tLiq).mint(borrower, collateral);
        ERC20Mock(tLiq).approve(diamond, collateral);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, terms, sig);
        vm.stopBroadcast();

        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        require(loan.status == LibVaipakam.LoanStatus.Active, "BaseSepoliaSellerClaim: the loan is not Active");
        require(loan.lender == lender && loan.borrower == borrower, "BaseSepoliaSellerClaim: the loan's parties are not the intended ones");
        console.log("Opened loan (offer, loan):", offerId, loanId);
        console.log("Next, a few minutes from now: SC_STAGE=sell SC_LOAN_ID=", loanId);
    }

    function _sell(address diamond, uint256 loanId) internal {
        uint256 lenderKey = vm.envUint("LENDER_PRIVATE_KEY");
        uint256 buyerKey = vm.envUint("NEW_LENDER_PRIVATE_KEY");
        address seller = vm.addr(lenderKey);
        address buyer = vm.addr(buyerKey);
        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        require(loan.status == LibVaipakam.LoanStatus.Active, "BaseSepoliaSellerClaim: the loan is not Active");
        require(loan.lender == seller, "BaseSepoliaSellerClaim: the lender key does not hold this loan's lender side");
        require(buyer != seller && buyer != loan.borrower, "BaseSepoliaSellerClaim: the buyer must be a third wallet");

        vm.startBroadcast(buyerKey);
        ERC20Mock(loan.principalAsset).mint(buyer, loan.principal);
        ERC20Mock(loan.principalAsset).approve(diamond, loan.principal);
        uint256 buyOfferId = OfferCreateFacet(diamond).createOffer(_buyOffer(loan));
        vm.stopBroadcast();

        uint64 deadline = uint64(block.timestamp + SALE_WINDOW);
        (uint256 minSellerNet, uint256 maxHeld) =
            RiskPreviewFacet(diamond).quoteSellerBounds(loanId, loan.interestRateBps, deadline);
        console.log("Quoted bounds (min seller net, max held):", minSellerNet, maxHeld);
        vm.startBroadcast(lenderKey);
        EarlyWithdrawalDirectFacet(diamond).sellLoanViaBuyOfferBound(
            loanId, buyOfferId, minSellerNet, maxHeld, deadline
        );
        vm.stopBroadcast();

        LibVaipakam.Loan memory after_ = LoanFacet(diamond).getLoanDetails(loanId);
        require(after_.lender == buyer, "BaseSepoliaSellerClaim: the buyer does not hold the lender side");
        uint256 owed = _claimOwed(diamond, loanId, seller);
        require(owed > 0, "BaseSepoliaSellerClaim: the sale recorded no claim with anything owed for the seller");
        console.log("Sold into buy offer; seller's gross claim (raw):", buyOfferId, owed);
        console.log("Next: SC_STAGE=repay SC_LOAN_ID=", loanId);
    }

    function _repay(address diamond, uint256 loanId) internal {
        uint256 borrowerKey = vm.envUint("BORROWER_PRIVATE_KEY");
        address seller = vm.addr(vm.envUint("LENDER_PRIVATE_KEY"));
        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        require(loan.status == LibVaipakam.LoanStatus.Active, "BaseSepoliaSellerClaim: the loan is not Active");
        require(loan.borrower == vm.addr(borrowerKey), "BaseSepoliaSellerClaim: the borrower key is not this loan's borrower");
        require(_claimOwed(diamond, loanId, seller) > 0, "BaseSepoliaSellerClaim: no seller claim on this loan - run `sell` first");

        uint256 due = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        require(due > 0, "BaseSepoliaSellerClaim: the Diamond quotes nothing due");
        vm.startBroadcast(borrowerKey);
        uint256 have = IERC20Metadata(loan.principalAsset).balanceOf(loan.borrower);
        if (have < due) ERC20Mock(loan.principalAsset).mint(loan.borrower, due - have);
        ERC20Mock(loan.principalAsset).approve(diamond, due);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();

        require(
            LoanFacet(diamond).getLoanDetails(loanId).status == LibVaipakam.LoanStatus.Repaid,
            "BaseSepoliaSellerClaim: the loan did not read Repaid"
        );
        uint256 held = SellerClaimFacet(diamond).getSellerInterestHeld(loanId, seller, loan.principalAsset);
        require(held > 0, "BaseSepoliaSellerClaim: nothing is waiting for the seller after the repay");
        console.log("Repaid; waiting for the seller (raw):", held);
        console.log("Next: live-seller-claim.mjs with LOAN_ID=", loanId);
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    /// @dev The seller's gross claim on `loanId` as the Diamond records it,
    ///      or 0 when the ledger holds none for them.
    function _claimOwed(address diamond, uint256 loanId, address seller) internal view returns (uint256) {
        (,,, LibVaipakam.SellerInterestClaim[] memory claims) =
            SellerClaimFacet(diamond).getInterestLedger(loanId);
        for (uint256 i; i < claims.length; i++) {
            if (claims[i].seller == seller) return claims[i].grossOwed;
        }
        return 0;
    }

    /// @dev A faucet mock's address from this chain's deployment artifact.
    function _mock(string memory key) internal view returns (address a) {
        string memory full = string.concat(".testnetMocks.", key);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(Deployments.path());
        try vm.parseJsonAddress(json, full) returns (address v) {
            a = v;
        } catch {}
        require(a != address(0), string.concat("BaseSepoliaSellerClaim: artifact has no ", full));
    }

    /// @dev Raw `collAsset` worth three times `principal` of `lendAsset`, at the
    ///      Diamond's own prices and both tokens' own decimals.
    function _worthThreeTimes(address diamond, address lendAsset, uint256 principal, address collAsset)
        internal
        view
        returns (uint256)
    {
        (uint256 lendPrice, uint8 lendPriceDec) = IRepriceDiamondViews(diamond).getAssetPrice(lendAsset);
        (uint256 collPrice, uint8 collPriceDec) = IRepriceDiamondViews(diamond).getAssetPrice(collAsset);
        require(lendPrice != 0 && collPrice != 0, "BaseSepoliaSellerClaim: the oracle reads no price for a leg");
        uint256 lendDec = IERC20Metadata(lendAsset).decimals();
        uint256 collDec = IERC20Metadata(collAsset).decimals();
        // value(principal) = principal * lendPrice / 10^(lendDec + lendPriceDec);
        // collateral = 3 * value * 10^(collDec + collPriceDec) / collPrice.
        return (3 * principal * lendPrice * 10 ** (collDec + collPriceDec))
            / (collPrice * 10 ** (lendDec + lendPriceDec));
    }

    function _lenderOffer(address lendAsset, uint256 amount, address collAsset, uint256 collateral, uint256 rateBps)
        internal
        pure
        returns (LibVaipakam.CreateOfferParams memory p)
    {
        p.offerType = LibVaipakam.OfferType.Lender;
        p.lendingAsset = lendAsset;
        p.amount = amount;
        p.amountMax = amount;
        p.interestRateBps = rateBps;
        p.interestRateBpsMax = rateBps;
        p.collateralAsset = collAsset;
        p.collateralAmount = collateral;
        p.collateralAmountMax = collateral;
        p.durationDays = DURATION_DAYS;
        p.assetType = LibVaipakam.AssetType.ERC20;
        p.collateralAssetType = LibVaipakam.AssetType.ERC20;
        p.prepayAsset = lendAsset;
        p.creatorRiskAndTermsConsent = true;
        p.periodicInterestCadence = LibVaipakam.PeriodicInterestCadence.None;
        p.fillMode = LibVaipakam.FillMode.Partial;
    }

    /// @dev The buyer's single-value lender offer on the loan's exact terms:
    ///      what `sellLoanViaBuyOffer` requires of a buy offer (same assets,
    ///      prepay asset and behavioural terms, amount = the live principal,
    ///      collateral no more than the loan's, a duration covering what is
    ///      left), at the loan's own rate so the sale carries no shortfall.
    function _buyOffer(LibVaipakam.Loan memory loan) internal pure returns (LibVaipakam.CreateOfferParams memory p) {
        p = _lenderOffer(
            loan.principalAsset, loan.principal, loan.collateralAsset, loan.collateralAmount, loan.interestRateBps
        );
        p.durationDays = loan.durationDays;
        p.prepayAsset = loan.prepayAsset;
        p.collateralAssetType = loan.collateralAssetType;
        p.allowsPartialRepay = loan.allowsPartialRepay;
        p.allowsPrepayListing = loan.allowsPrepayListing;
        p.periodicInterestCadence = loan.periodicInterestCadence;
        p.useFullTermInterest = loan.useFullTermInterest;
    }
}
