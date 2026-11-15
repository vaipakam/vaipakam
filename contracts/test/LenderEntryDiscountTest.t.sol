// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {EarlyWithdrawalDirectFacet} from "../src/facets/EarlyWithdrawalDirectFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title LenderEntryDiscountTest
/// @notice #3562 — a lender's yield-fee hold discount is the lower of their
///         discount when they took the lender position and their discount at
///         settlement. Drives the real Diamond: every way a lender position
///         gets a holder records that holder's standing, and the fee path
///         reads the lower of the two.
contract LenderEntryDiscountTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;
    uint256 internal constant DURATION_DAYS = 60;
    uint256 internal constant RATE_BPS = 500;
    uint256 internal constant STAKE = 5_000 ether;

    VPFIToken internal vpfi;

    function setUp() public {
        setupHelper();
        address impl = ArtifactDeploy.deploy(type(VPFIToken).name);
        vpfi = VPFIToken(
            ArtifactDeploy.deploy(
                type(ERC1967Proxy).name,
                abi.encode(impl, abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this))))
            )
        );
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _params(LibVaipakam.OfferType kind, uint256 durationDays)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: kind,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: RATE_BPS,
            collateralAsset: mockCollateralERC20,
            collateralAmount: COLLATERAL,
            durationDays: durationDays,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: mockERC20,
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: true,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: PRINCIPAL,
            interestRateBpsMax: RATE_BPS,
            collateralAmountMax: COLLATERAL,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    /// @dev The lender posts, the borrower accepts: the lender's offer token
    ///      becomes the loan's lender token.
    function _openLoan() internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, DURATION_DAYS),
            type(uint64).max
        );
        LibTestTiming.backdateTerms(address(diamond), offerId); // #3443
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    /// @dev Stake VPFI in `who`'s vault and turn their discount consent on.
    function _stake(address who) internal {
        vpfi.transfer(who, STAKE);
        vm.startPrank(who);
        vpfi.approve(address(diamond), STAKE);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(STAKE);
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(true);
        vm.stopPrank();
    }

    function _skip(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
    }

    function _view(uint256 loanId, address who)
        internal
        view
        returns (VPFIDiscountAccumulatorFacet.LenderHoldView memory)
    {
        return VPFIDiscountAccumulatorFacet(address(diamond)).lenderHoldDiscountView(loanId, who);
    }

    function _nowBps(address who) internal view returns (uint16 bps) {
        (, bps) = VPFIDiscountFacet(address(diamond)).getEffectiveDiscount(who);
    }

    function _accrual(uint256 principal, uint256 secs) internal pure returns (uint256) {
        return (principal * RATE_BPS * secs) / (365 days * 10_000);
    }

    function _net(uint256 loanId, uint256 gross) internal view returns (uint256) {
        uint256 fee = LoanFacet(address(diamond)).getLoanDetails(loanId).treasuryFeeBpsAtInit;
        return (gross * (10_000 - fee)) / 10_000;
    }

    function _sellTo(uint256 loanId, address seller, address buyer) internal {
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        uint256 end = uint256(l.startTime) + uint256(l.durationDays) * 1 days;
        uint256 nowTs = vm.getBlockTimestamp();
        uint256 remaining = end > nowTs ? (end - nowTs + 1 days - 1) / 1 days : 0;
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender, remaining);
        p.amount = l.principal;
        p.amountMax = p.amount;
        vm.prank(buyer);
        uint256 buyOfferId = OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
        LibTestTiming.backdateTerms(address(diamond), buyOfferId); // #3443
        vm.prank(seller);
        EarlyWithdrawalDirectFacet(address(diamond)).sellLoanViaBuyOffer(
            loanId, buyOfferId, 0, type(uint256).max, type(uint64).max
        );
    }

    // ─── Every holder change records the holder ──────────────────────────────

    /// @notice A lender offer's token becoming the loan's lender token
    ///         records the offer's holder at the accept.
    function test_offerTokenBecomingTheLoanToken_recordsTheLender() public {
        uint256 loanId = _openLoan();
        VPFIDiscountAccumulatorFacet.LenderHoldView memory v = _view(loanId, lender);
        assertEq(v.entryHolder, lender, "the lender's entry is recorded");
        assertEq(v.enteredAt, LoanFacet(address(diamond)).getLoanDetails(loanId).startTime, "at the accept");
    }

    /// @notice A borrower offer accepted by a lender mints the lender token for
    ///         the loan, which records the accepting lender.
    function test_lenderTokenMintedForTheLoan_recordsTheAcceptingLender() public {
        vm.prank(borrower);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, DURATION_DAYS),
            type(uint64).max
        );
        LibTestTiming.backdateTerms(address(diamond), offerId); // #3443
        uint256 loanId = _signAndAcceptOffer(lender, lenderPk, offerId);
        assertEq(_view(loanId, lender).entryHolder, lender, "the accepting lender's entry is recorded");
    }

    /// @notice Only the Diamond itself may record an entry.
    function test_stampRefusesAnOutsideCaller() public {
        vm.expectRevert(VPFIDiscountAccumulatorFacet.InternalCallerOnly.selector);
        VPFIDiscountAccumulatorFacet(address(diamond)).stampLenderEntry(1, address(this), false);
    }

    // ─── The lower of entry and settlement ───────────────────────────────────

    /// @notice A lender who stakes after the loan started keeps their entry
    ///         standing (none), so a repayment charges them the loan's whole fee.
    function test_stakeAfterTheStart_getsNoHoldDiscount() public {
        uint256 loanId = _openLoan();
        _stake(lender);
        _skip(10 days);
        assertGt(_nowBps(lender), 0, "the lender has a discount now");

        VPFIDiscountAccumulatorFacet.LenderHoldView memory v = _view(loanId, lender);
        assertEq(v.entryBps, 0, "but had none at entry");
        assertEq(v.nowBps, _nowBps(lender), "the view reads the same standing now");
        assertEq(v.holdBps, 0, "so the lower of the two is none");

        uint256 gross = _accrual(PRINCIPAL, 10 days);
        uint256 before = ERC20(mockERC20).balanceOf(lender);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);
        uint256 interest = ERC20(mockERC20).balanceOf(lender) - before - PRINCIPAL / 2;
        assertApproxEqAbs(interest, _net(loanId, gross), 2, "the lender pays the loan's whole fee");
    }

    /// @notice A lender whose standing falls before settlement gets the lower
    ///         figure at settlement.
    function test_standingFallsBeforeSettlement_getsTheLowerFigure() public {
        _stake(lender);
        _skip(10 days);
        uint256 loanId = _openLoan();
        VPFIDiscountAccumulatorFacet.LenderHoldView memory v = _view(loanId, lender);
        assertGt(v.entryBps, 0, "the lender entered with a discount");
        assertEq(v.holdBps, v.entryBps, "and keeps it while it holds");

        vm.prank(lender);
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromVault(STAKE);
        _skip(1 days);
        v = _view(loanId, lender);
        assertEq(v.nowBps, 0, "the lender's standing fell");
        assertEq(v.holdBps, 0, "and the lower figure applies");

        uint256 gross = _accrual(PRINCIPAL, 1 days);
        uint256 before = ERC20(mockERC20).balanceOf(lender);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);
        uint256 interest = ERC20(mockERC20).balanceOf(lender) - before - PRINCIPAL / 2;
        assertApproxEqAbs(interest, _net(loanId, gross), 2, "the lender pays the loan's whole fee");
    }

    /// @notice A lender who held the same standing throughout keeps the
    ///         discount at settlement.
    function test_standingHeldThroughout_keepsTheDiscount() public {
        _stake(lender);
        _skip(10 days);
        uint256 loanId = _openLoan();
        _skip(10 days);
        VPFIDiscountAccumulatorFacet.LenderHoldView memory v = _view(loanId, lender);
        assertGt(v.holdBps, 0, "the discount stands");
        assertEq(v.holdBps, v.entryBps < v.nowBps ? v.entryBps : v.nowBps, "as the lower of the two");

        uint256 gross = _accrual(PRINCIPAL, 10 days);
        uint256 before = ERC20(mockERC20).balanceOf(lender);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, PRINCIPAL / 2);
        uint256 interest = ERC20(mockERC20).balanceOf(lender) - before - PRINCIPAL / 2;
        assertGt(interest, _net(loanId, gross) + 2, "the discount reaches the lender");
    }

    // ─── A new holder is anchored at their own entry ─────────────────────────

    /// @notice After a sale the buyer is anchored at their standing when the
    ///         sale completed, and the seller no longer holds an entry.
    function test_sale_anchorsTheBuyerAtTheSale() public {
        _stake(lender);
        _skip(10 days);
        uint256 loanId = _openLoan();
        _skip(5 days);
        address buyer = _provisionFundedActor("entry-buyer", mockERC20, PRINCIPAL * 2);
        _sellTo(loanId, lender, buyer);

        VPFIDiscountAccumulatorFacet.LenderHoldView memory v = _view(loanId, buyer);
        assertEq(v.entryHolder, buyer, "the buyer's entry is recorded");
        assertEq(v.entryBps, 0, "with the buyer's standing at the sale");
        assertEq(_view(loanId, lender).holdBps, 0, "the seller no longer holds an entry");

        _stake(buyer);
        _skip(10 days);
        v = _view(loanId, buyer);
        assertGt(v.nowBps, 0, "the buyer has a discount now");
        assertEq(v.holdBps, 0, "but not on this loan");
    }

    /// @notice A plain transfer splits no interest, so it can keep or lower
    ///         the recorded figure but never raise it: the receiver's entry is
    ///         the lower of the existing figure and their own standing, and
    ///         handing the token back does not restore the first holder's.
    function test_plainTransfer_canOnlyKeepOrLowerTheFigure() public {
        _stake(lender);
        _skip(10 days);
        uint256 loanId = _openLoan();
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).lenderTokenId;
        assertGt(_view(loanId, lender).entryBps, 0, "the lender entered with a discount");
        address receiver = makeAddr("entry-receiver");

        LibTestPositionNFT.move(address(diamond), tokenId, receiver);
        VPFIDiscountAccumulatorFacet.LenderHoldView memory v = _view(loanId, receiver);
        assertEq(v.entryHolder, receiver, "the receiver's entry is recorded");
        assertEq(v.entryBps, 0, "at the lower of the figure and the receiver's standing");
        assertEq(_view(loanId, lender).holdBps, 0, "the sender no longer holds an entry");

        LibTestPositionNFT.move(address(diamond), tokenId, lender);
        v = _view(loanId, lender);
        assertEq(v.entryHolder, lender, "the lender holds the entry again");
        assertGt(v.nowBps, 0, "the lender still has a discount now");
        assertEq(v.entryBps, 0, "but the round trip carried the lower figure");
        assertEq(v.holdBps, 0, "so none applies on this loan");
    }

    /// @notice A transfer to a receiver who also qualifies keeps the figure.
    function test_plainTransfer_betweenQualifiedHoldersKeepsTheFigure() public {
        _stake(lender);
        address receiver = makeAddr("entry-receiver-staked");
        _stake(receiver);
        _skip(10 days);
        uint256 loanId = _openLoan();
        uint16 entered = _view(loanId, lender).entryBps;
        assertGt(entered, 0, "the lender entered with a discount");
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).lenderTokenId;

        LibTestPositionNFT.move(address(diamond), tokenId, receiver);
        VPFIDiscountAccumulatorFacet.LenderHoldView memory v = _view(loanId, receiver);
        assertEq(v.entryBps, entered, "the figure is kept");
        assertEq(v.holdBps, entered < v.nowBps ? entered : v.nowBps, "and applies to the receiver");
    }

    /// @notice A stake taken after the loan opened cannot be lifted into the
    ///         entry figure by moving the token to oneself.
    function test_selfTransfer_cannotLiftALateStake() public {
        uint256 loanId = _openLoan();
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).lenderTokenId;
        _stake(lender);
        _skip(10 days);
        assertGt(_nowBps(lender), 0, "the lender qualifies now");

        LibTestPositionNFT.move(address(diamond), tokenId, lender);
        VPFIDiscountAccumulatorFacet.LenderHoldView memory v = _view(loanId, lender);
        assertEq(v.entryBps, 0, "the self transfer kept the entry figure");
        assertEq(v.holdBps, 0, "so no hold discount applies");
    }

    /// @notice A sale retires the seller's old lender token but leaves it
    ///         transferable. Moving that receipt must not touch the buyer's
    ///         record.
    function test_retiredReceipt_cannotOverwriteTheBuyersEntry() public {
        uint256 loanId = _openLoan();
        uint256 oldTokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).lenderTokenId;
        address buyer = _provisionFundedActor("entry-buyer-staked", mockERC20, PRINCIPAL * 2);
        _stake(buyer);
        _skip(10 days);
        _sellTo(loanId, lender, buyer);
        assertTrue(
            LoanFacet(address(diamond)).getLoanDetails(loanId).lenderTokenId != oldTokenId,
            "the sale moved the loan to a new lender token"
        );
        VPFIDiscountAccumulatorFacet.LenderHoldView memory before = _view(loanId, buyer);
        assertEq(before.entryHolder, buyer, "the buyer's entry is recorded");
        assertGt(before.holdBps, 0, "with a discount");

        LibTestPositionNFT.move(address(diamond), oldTokenId, makeAddr("receipt-taker"));
        VPFIDiscountAccumulatorFacet.LenderHoldView memory afterMove = _view(loanId, buyer);
        assertEq(afterMove.entryHolder, buyer, "the buyer's entry still stands");
        assertEq(afterMove.entryBps, before.entryBps, "unchanged");
        assertEq(afterMove.holdBps, before.holdBps, "and so is the discount");
    }
}
