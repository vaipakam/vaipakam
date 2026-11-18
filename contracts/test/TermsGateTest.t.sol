// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LegalFacet} from "../src/facets/LegalFacet.sol";
import {MulticallFacet} from "../src/facets/MulticallFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {EarlyWithdrawalDirectFacet} from "../src/facets/EarlyWithdrawalDirectFacet.sol";
import {PrecloseOffsetFacet} from "../src/facets/PrecloseOffsetFacet.sol";
import {StandingInstructionFacet} from "../src/facets/StandingInstructionFacet.sol";
import {AutoLifecycleFacet} from "../src/facets/AutoLifecycleFacet.sol";
import {AutoLifecycleSettingsFacet} from "../src/facets/AutoLifecycleSettingsFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibTerms} from "../src/libraries/LibTerms.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title TermsGateTest
 * @notice #3734 — the Terms rule on the routes, end to end on the real
 *         Diamond (design tests 1, 2, 7, 8, 10, 13 and the standing
 *         commitments):
 *         - a new loan needs both parties current; the accept preview says so;
 *         - posting an offer that gives a new position needs the poster
 *           current; a stale wallet's offer already on the book stays there
 *           and fills once its maker accepts;
 *         - a wallet accepts and posts in one transaction of its own;
 *         - a lender who is not current may still sell its position; the
 *           buyer must be current (direct sale); the borrower's offset offer
 *           is a new position and is refused;
 *         - standing intents, standing instructions and an in-place extension
 *           need the wallet current;
 *         - repaying and claiming are never asked.
 */
contract TermsGateTest is SetupTest {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;

    bytes32 internal constant H1 = keccak256("Vaipakam ToS v1");
    bytes32 internal constant H2 = keccak256("Vaipakam ToS v2");

    function setUp() public {
        setupHelper();
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockERC20, 1e8, 8);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockCollateralERC20, 1e8, 8);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _l() internal view returns (LegalFacet) {
        return LegalFacet(address(diamond));
    }

    function _v1() internal {
        _l().announceTos(1, H1, uint64(block.timestamp));
    }

    /// @dev Version 2 comes into force (at the notice floor).
    function _v2InForce() internal {
        uint64 at = uint64(block.timestamp + 7 days);
        _l().announceTos(2, H2, at);
        vm.warp(at);
    }

    function _accept(address who, uint32 v, bytes32 h) internal {
        vm.prank(who);
        _l().acceptTerms(v, h);
    }

    function _params(LibVaipakam.OfferType kind, uint256 durationDays)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            lifecycleFlex: 0,
            offerType: kind,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: 500,
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
            interestRateBpsMax: 500,
            collateralAmountMax: COLLATERAL,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _prepareVaults() internal {
        address lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        address borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        vm.prank(lender);
        ERC20(mockERC20).approve(lenderVault, type(uint256).max);
        vm.prank(borrower);
        ERC20(mockCollateralERC20).approve(borrowerVault, type(uint256).max);
    }

    function _postLenderOffer() internal returns (uint256 offerId) {
        _prepareVaults();
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, 30), type(uint64).max
        );
    }

    /// @dev Version 1 in force, both parties current, a loan open.
    function _openLoan() internal returns (uint256 loanId) {
        _v1();
        _accept(lender, 1, H1);
        _accept(borrower, 1, H1);
        uint256 offerId = _postLenderOffer();
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    function _expectTerms(address wallet, uint32 v) internal {
        vm.expectRevert(abi.encodeWithSelector(LibTerms.TermsNotAccepted.selector, wallet, v));
    }

    // ─── Loan creation ────────────────────────────────────────────────────

    /// Test 1: a stale acceptor is refused, and the preview says so first.
    function test_Accept_RefusesAStaleAcceptor() public {
        _v1();
        _accept(lender, 1, H1);
        uint256 offerId = _postLenderOffer();
        LibAcceptTerms.AcceptTerms memory t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
        assertEq(
            uint8(OfferPreviewFacet(address(diamond)).previewAccept(offerId, borrower).errorCode),
            uint8(OfferAcceptFacet.AcceptError.TermsNotAccepted),
            "the preview reports the refusal"
        );
        _expectTerms(borrower, 1);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);

        // Accepting the Terms is all it takes.
        _accept(borrower, 1, H1);
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        assertEq(uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status), uint8(LibVaipakam.LoanStatus.Active));
    }

    /// Test 2: a maker who went stale after posting is refused at the fill;
    /// the offer stays on the book and fills once the maker accepts.
    function test_Accept_RefusesAStaleMaker_OfferStaysOnTheBook() public {
        _v1();
        _accept(lender, 1, H1);
        uint256 offerId = _postLenderOffer();
        _v2InForce();
        _accept(borrower, 2, H2);

        LibAcceptTerms.AcceptTerms memory t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
        assertEq(
            uint8(OfferPreviewFacet(address(diamond)).previewAccept(offerId, borrower).errorCode),
            uint8(OfferAcceptFacet.AcceptError.TermsNotAccepted),
            "the preview names the maker's refusal"
        );
        _expectTerms(lender, 2);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
        assertFalse(OfferCancelFacet(address(diamond)).getOffer(offerId).accepted, "still on the book");
        (address w, uint32 v) = _l().termsBlocker(lender, borrower);
        assertEq(w, lender);
        assertEq(v, 2);

        _accept(lender, 2, H2);
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    // ─── Posting ──────────────────────────────────────────────────────────

    /// Test 8: posting an offer needs the poster current.
    function test_Post_RefusesAStaleWallet() public {
        _v1();
        _prepareVaults();
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender, 30);
        _expectTerms(lender, 1);
        vm.prank(lender);
        OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
    }

    /// Test 11 (one transaction of its own): a wallet accepts and posts in one
    /// multicall.
    function test_Post_AcceptAndPostInOneTransaction() public {
        _v1();
        _prepareVaults();
        MulticallFacet.Call[] memory calls = new MulticallFacet.Call[](2);
        calls[0] = MulticallFacet.Call(abi.encodeCall(LegalFacet.acceptTerms, (uint32(1), H1)), false);
        calls[1] = MulticallFacet.Call(
            abi.encodeCall(
                OfferCreateFacet.createOffer, (_params(LibVaipakam.OfferType.Lender, 30), type(uint64).max)
            ),
            false
        );
        vm.prank(lender);
        MulticallFacet(address(diamond)).multicall(calls);
        assertTrue(_l().isTermsCurrent(lender));
    }

    // ─── Exits: the seller is never asked; the buyer is ───────────────────

    function _postBuyOffer(uint256 loanId, address buyer) internal returns (uint256 buyOfferId) {
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        uint256 end = uint256(l.startTime) + uint256(l.durationDays) * 1 days;
        uint256 remaining = end > block.timestamp ? (end - block.timestamp + 1 days - 1) / 1 days : 0;
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender, remaining);
        p.amount = l.principal;
        p.amountMax = p.amount;
        vm.prank(buyer);
        buyOfferId = OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
        LibTestTiming.backdateTerms(address(diamond), buyOfferId);
    }

    /// Test 13 (direct sale): a stale lender sells to a current buyer; a
    /// buyer that went stale after posting its offer is refused.
    function test_DirectSale_StaleSellerAllowed_StaleBuyerRefused() public {
        uint256 loanId = _openLoan();
        address buyer = _provisionFundedActor("terms-buyer", mockERC20, PRINCIPAL * 2);
        _accept(buyer, 1, H1);
        vm.warp(block.timestamp + 1 days);
        uint256 buyOfferId = _postBuyOffer(loanId, buyer);
        _v2InForce(); // nobody accepted v2: seller and buyer both stale

        _expectTerms(buyer, 2);
        vm.prank(lender);
        EarlyWithdrawalDirectFacet(address(diamond)).sellLoanViaBuyOffer(
            loanId, buyOfferId, 0, type(uint256).max, type(uint64).max
        );

        _accept(buyer, 2, H2);
        assertFalse(_l().isTermsCurrent(lender), "the seller stays stale");
        vm.prank(lender);
        EarlyWithdrawalDirectFacet(address(diamond)).sellLoanViaBuyOffer(
            loanId, buyOfferId, 0, type(uint256).max, type(uint64).max
        );
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).lender, buyer, "the buyer holds the position");
    }

    /// Test 13 (listing): a stale lender may list its position.
    function test_Listing_StaleSellerMayList() public {
        uint256 loanId = _openLoan();
        vm.warp(block.timestamp + 1 days);
        _v2InForce();
        assertFalse(_l().isTermsCurrent(lender));
        vm.prank(lender);
        EarlyWithdrawalFacet(address(diamond)).createLoanSaleOffer(
            loanId, 500, true, 7 days, 0, type(uint256).max, type(uint64).max
        );
    }

    /// Test 13 (offset): the borrower's offset offer is a new position and
    /// needs the borrower current.
    function test_Offset_RefusesAStaleBorrower() public {
        uint256 loanId = _openLoan();
        vm.warp(block.timestamp + 1 days);
        _v2InForce();
        ERC20Mock(mockERC20).mint(borrower, PRINCIPAL * 2);
        vm.startPrank(borrower);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        ERC20(mockERC20).approve(VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower), type(uint256).max);
        vm.stopPrank();
        _expectTerms(borrower, 2);
        vm.prank(borrower);
        PrecloseOffsetFacet(address(diamond)).offsetWithNewOffer(
            loanId, 500, 20, mockCollateralERC20, COLLATERAL, true, mockERC20, type(uint64).max
        );
    }

    // ─── Standing commitments ─────────────────────────────────────────────

    function test_LenderIntent_SetAndFundRefuseAStaleWallet() public {
        _v1();
        _expectTerms(lender, 1);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, PRINCIPAL, 500, 5000, 30, 1 ether, false, 0, false, true,
            type(uint64).max
        );
        _expectTerms(lender, 1);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).fundLenderIntent(mockERC20, mockCollateralERC20, 0, 1 ether);
    }

    function test_StandingInstructions_RefuseAStaleBorrower() public {
        uint256 loanId = _openLoan();
        _v2InForce();
        StandingInstructionFacet.InstructionInput memory cfg;
        cfg.payInterest = true;
        _expectTerms(borrower, 2);
        vm.prank(borrower);
        StandingInstructionFacet(address(diamond)).setStandingInstructions(loanId, cfg);
    }

    function test_Extension_RefusesAStaleParty() public {
        AdminFacet(address(diamond)).setAutoExtendEnabled(true);
        uint256 loanId = _openLoan();
        uint64 farExpiry = uint64(block.timestamp + 400 days);
        vm.prank(borrower);
        AutoLifecycleSettingsFacet(address(diamond)).setAutoExtendBorrowerCaps(
            loanId, true, 0, 1000, farExpiry, type(uint256).max
        );
        vm.prank(lender);
        AutoLifecycleSettingsFacet(address(diamond)).setAutoExtendLenderCaps(loanId, true, 0, 1000, farExpiry);
        ERC20Mock(mockERC20).mint(borrower, 10 ether);
        vm.startPrank(borrower);
        ERC20(mockERC20).approve(address(diamond), 10 ether);
        StandingInstructionFacet(address(diamond)).fundLoanReserve(loanId, 0, 10 ether);
        vm.stopPrank();
        // A new version comes into force inside the extension window: the
        // lender accepts it, the borrower does not.
        (uint64 opensAt, uint64 closesAt) = AutoLifecycleFacet(address(diamond)).getAutoExtendWindow(loanId);
        uint64 at = uint64(vm.getBlockTimestamp() + 7 days);
        if (at < opensAt) at = opensAt;
        assertLe(at, closesAt, "the version comes into force inside the window");
        _l().announceTos(2, H2, at);
        _accept(lender, 2, H2);
        vm.warp(at);
        uint64 startBefore = LoanFacet(address(diamond)).getLoanDetails(loanId).startTime;

        _expectTerms(borrower, 2);
        vm.prank(borrower);
        AutoLifecycleFacet(address(diamond)).extendLoanInPlace(loanId, 500, 30);

        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).startTime, startBefore, "start unchanged");
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).durationDays, 30, "term unchanged");

        _accept(borrower, 2, H2);
        vm.prank(borrower);
        AutoLifecycleFacet(address(diamond)).extendLoanInPlace(loanId, 500, 30);
        assertGt(LoanFacet(address(diamond)).getLoanDetails(loanId).startTime, startBefore, "extended");
    }

    /// The extension also asks for the lender's holder: a stale lender
    /// blocks it while the borrower is current.
    function test_Extension_RefusesAStaleLender() public {
        AdminFacet(address(diamond)).setAutoExtendEnabled(true);
        uint256 loanId = _openLoan();
        uint64 farExpiry = uint64(block.timestamp + 400 days);
        vm.prank(borrower);
        AutoLifecycleSettingsFacet(address(diamond)).setAutoExtendBorrowerCaps(
            loanId, true, 0, 1000, farExpiry, type(uint256).max
        );
        vm.prank(lender);
        AutoLifecycleSettingsFacet(address(diamond)).setAutoExtendLenderCaps(loanId, true, 0, 1000, farExpiry);
        ERC20Mock(mockERC20).mint(borrower, 10 ether);
        vm.startPrank(borrower);
        ERC20(mockERC20).approve(address(diamond), 10 ether);
        StandingInstructionFacet(address(diamond)).fundLoanReserve(loanId, 0, 10 ether);
        vm.stopPrank();
        (uint64 opensAt, uint64 closesAt) = AutoLifecycleFacet(address(diamond)).getAutoExtendWindow(loanId);
        uint64 at = uint64(vm.getBlockTimestamp() + 7 days);
        if (at < opensAt) at = opensAt;
        assertLe(at, closesAt);
        _l().announceTos(2, H2, at);
        _accept(borrower, 2, H2);
        vm.warp(at);
        _expectTerms(lender, 2);
        vm.prank(borrower);
        AutoLifecycleFacet(address(diamond)).extendLoanInPlace(loanId, 500, 30);
    }

    // ─── Never asked ──────────────────────────────────────────────────────

    /// Test 10: with both parties stale, the loan repays and the lender
    /// claims; nothing on the way out asks for the Terms.
    function test_RepayAndClaim_NeverAsked() public {
        uint256 loanId = _openLoan();
        vm.warp(block.timestamp + 5 days);
        _v2InForce();
        assertFalse(_l().isTermsCurrent(lender));
        assertFalse(_l().isTermsCurrent(borrower));
        ERC20Mock(mockERC20).mint(borrower, PRINCIPAL);
        vm.startPrank(borrower);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
    }

    /// The protocol's pause does not stop a wallet accepting, and a version
    /// change while paused still counts from its time.
    function test_AcceptWhilePaused_ThenPost() public {
        _v1();
        AdminFacet(address(diamond)).pause();
        _accept(lender, 1, H1);
        AdminFacet(address(diamond)).unpause();
        _postLenderOffer();
    }
}
