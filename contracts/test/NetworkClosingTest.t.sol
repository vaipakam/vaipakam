// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {CustodyInvariantBase} from "./invariants/CustodyInvariantBase.sol";
import {LegalFacet} from "../src/facets/LegalFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferMatchIntentFacet} from "../src/facets/OfferMatchIntentFacet.sol";
import {OfferPriceGuardFacet} from "../src/facets/OfferPriceGuardFacet.sol";
import {IntentPreviewFacet} from "../src/facets/IntentPreviewFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ClaimViewFacet} from "../src/facets/ClaimViewFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {EarlyWithdrawalDirectFacet} from "../src/facets/EarlyWithdrawalDirectFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {StandingInstructionFacet} from "../src/facets/StandingInstructionFacet.sol";
import {AutoLifecycleFacet} from "../src/facets/AutoLifecycleFacet.sol";
import {AutoLifecycleSettingsFacet} from "../src/facets/AutoLifecycleSettingsFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {LenderIntentViewFacet} from "../src/facets/LenderIntentViewFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibTerms} from "../src/libraries/LibTerms.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";
import {LibTestPositionNFT} from "./helpers/LibTestPositionNFT.sol";
import {LibTestCalmPair} from "./helpers/LibTestCalmPair.sol";
import {LibTestVaultBeacon} from "./helpers/LibTestVaultBeacon.sol";
import {LibTestFallbackGate} from "./helpers/LibTestFallbackGate.sol";
import {liquidationQuote} from "./helpers/ForcedSaleQuote.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev The switch, its view and its event, shared by the suites below.
abstract contract NetworkClosingBase {
    event NetworkClosingSet(bool closing, uint64 since);
}

/**
 * @title NetworkClosingTest
 * @notice #3864 — the network closing switch and the opening rule it joins,
 *         end to end on the real Diamond:
 *         - the switch: who may move it each way, its event both ways, its
 *           idempotence and its view;
 *         - while closing, refused: posting an offer, accepting one (and its
 *           preview names the closing state first), matching two (and its
 *           preview), setting and funding an Auto-lend slot, the in-place
 *           extension, a lender's direct sale (the position migration) and an
 *           obligation handover;
 *         - while closing, still open: repaying, adding collateral, the loan
 *           reserves, setting standing instructions (the Terms part alone,
 *           which still binds), cancelling an offer, the vault's deposit and
 *           withdrawal, the lender's claim and a plain position-token
 *           transfer;
 *         - switching off restores opening.
 * @dev No Terms version is in force unless a test says so, so every refusal
 *      here is the closing part's.
 */
contract NetworkClosingTest is SetupTest, NetworkClosingBase {
    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 2000 ether;

    bytes32 internal constant H1 = keccak256("Vaipakam ToS v1");

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

    /// @dev Switch the network to Closing as ADMIN; returns `since`.
    function _close() internal returns (uint64 since) {
        _l().setNetworkClosing(true);
        (, since) = _l().getNetworkClosing();
    }

    function _reopen() internal {
        _l().setNetworkClosing(false);
    }

    function _expectClosing(uint64 since) internal {
        vm.expectRevert(abi.encodeWithSelector(LibTerms.NetworkClosing.selector, since));
    }

    function _params(LibVaipakam.OfferType kind, uint256 durationDays)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            integrator: address(0),
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
            useFullTermInterest: false,
            linkKind: 0,
            linkMarginBps: 0,
            rateFarFromAverageAcknowledged: false
        });
    }

    function _prepareVaults() internal {
        address lenderVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        address borrowerVault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        vm.startPrank(lender);
        ERC20(mockERC20).approve(lenderVault, type(uint256).max);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(borrower);
        ERC20(mockCollateralERC20).approve(borrowerVault, type(uint256).max);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.stopPrank();
    }

    function _postLenderOffer() internal returns (uint256 offerId) {
        _prepareVaults();
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, 30), type(uint64).max
        );
    }

    function _openLoan() internal returns (uint256 loanId) {
        uint256 offerId = _postLenderOffer();
        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    // ─── The switch ───────────────────────────────────────────────────────

    /// Quick hands switch it on, slower ones switch it off: ADMIN or PAUSER
    /// on, ADMIN or UNPAUSER off, and neither fast nor slow key may do the
    /// other's half.
    function test_Switch_RolesBothWays() public {
        address stranger = makeAddr("stranger");
        address pauser = makeAddr("closingPauser");
        address unpauser = makeAddr("closingUnpauser");
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.PAUSER_ROLE, pauser);
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.UNPAUSER_ROLE, unpauser);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector, stranger, LibAccessControl.PAUSER_ROLE
            )
        );
        _l().setNetworkClosing(true);
        vm.prank(unpauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector, unpauser, LibAccessControl.PAUSER_ROLE
            )
        );
        _l().setNetworkClosing(true);

        vm.prank(pauser);
        _l().setNetworkClosing(true);
        (bool closing,) = _l().getNetworkClosing();
        assertTrue(closing, "the pauser switched it on");

        vm.prank(pauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector, pauser, LibAccessControl.UNPAUSER_ROLE
            )
        );
        _l().setNetworkClosing(false);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector, stranger, LibAccessControl.UNPAUSER_ROLE
            )
        );
        _l().setNetworkClosing(false);

        vm.prank(unpauser);
        _l().setNetworkClosing(false);
        (closing,) = _l().getNetworkClosing();
        assertFalse(closing, "the unpauser switched it off");

        // ADMIN holds both halves.
        _l().setNetworkClosing(true);
        _l().setNetworkClosing(false);
        (closing,) = _l().getNetworkClosing();
        assertFalse(closing);
    }

    /// One event both ways; a repeat switch-on keeps the first time; the view
    /// reads it; switching off clears it.
    function test_Switch_EventIdempotenceAndView() public {
        (bool closing, uint64 since) = _l().getNetworkClosing();
        assertFalse(closing, "open at deploy");
        assertEq(since, 0);

        uint64 t0 = uint64(vm.getBlockTimestamp());
        vm.expectEmit(false, false, false, true, address(diamond));
        emit NetworkClosingSet(true, t0);
        _l().setNetworkClosing(true);

        vm.warp(t0 + 3 days);
        vm.expectEmit(false, false, false, true, address(diamond));
        emit NetworkClosingSet(true, t0);
        _l().setNetworkClosing(true);
        (closing, since) = _l().getNetworkClosing();
        assertTrue(closing);
        assertEq(since, t0, "a repeat switch-on keeps the first time");

        vm.expectEmit(false, false, false, true, address(diamond));
        emit NetworkClosingSet(false, 0);
        _l().setNetworkClosing(false);
        (closing, since) = _l().getNetworkClosing();
        assertFalse(closing);
        assertEq(since, 0);

        vm.expectEmit(false, false, false, true, address(diamond));
        emit NetworkClosingSet(false, 0);
        _l().setNetworkClosing(false); // idempotent off

        // Switching on again starts a new Closing at the new time.
        _l().setNetworkClosing(true);
        (, since) = _l().getNetworkClosing();
        assertEq(since, uint64(vm.getBlockTimestamp()));
    }

    /// The rule's views: the two-part question refuses, the Terms part alone
    /// does not, and the previews' read reports the closing state first.
    function test_RuleViews() public {
        uint64 since = _close();
        assertFalse(_l().mayOpen(lender), "no wallet may open");
        assertTrue(_l().isTermsCurrent(lender), "the Terms part alone is unchanged");
        _l().requireCurrentTerms(lender);
        _expectClosing(since);
        _l().requireMayOpen(lender);
        (uint64 cs, address w, uint32 v) = _l().openingBlocker(lender, borrower);
        assertEq(cs, since, "the closing state is the first reason");
        assertEq(w, address(0));
        assertEq(v, 0);

        // With a Terms version in force and nobody current, the closing state
        // is still the first reason.
        _l().announceTos(1, H1, uint64(block.timestamp));
        (cs, w,) = _l().openingBlocker(lender, borrower);
        assertEq(cs, since);
        assertEq(w, address(0));
        _expectClosing(since);
        _l().requireMayOpen(lender);

        _reopen();
        assertFalse(_l().mayOpen(lender), "open again, now the Terms bind");
        (cs, w, v) = _l().openingBlocker(lender, borrower);
        assertEq(cs, 0);
        assertEq(w, lender);
        assertEq(v, 1);
    }

    // ─── Refused while closing ────────────────────────────────────────────

    function test_Post_Refused() public {
        _prepareVaults();
        uint64 since = _close();
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender, 30);
        _expectClosing(since);
        vm.prank(lender);
        OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
        p = _params(LibVaipakam.OfferType.Borrower, 30);
        _expectClosing(since);
        vm.prank(borrower);
        OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
    }

    /// An offer posted before the switch stays on the book and cannot fill;
    /// the preview says why; cancelling stays open; switching off lets it fill.
    function test_Accept_RefusedWithItsPreview_ThenFillsAfterReopen() public {
        uint256 offerId = _postLenderOffer();
        // Past the terms-age rule, so the preview's first refusal is the
        // opening rule's and not the freshness check that precedes it.
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
        uint64 since = _close();
        assertEq(
            uint8(OfferPreviewFacet(address(diamond)).previewAccept(offerId, borrower).errorCode),
            uint8(OfferAcceptFacet.AcceptError.NetworkClosing),
            "the accept preview names the closing state"
        );
        LibAcceptTerms.AcceptTerms memory t =
            LibAcceptTestSigner.buildTerms(address(diamond), borrower, offerId, true, 0);
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);
        _expectClosing(since);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
        assertFalse(OfferCancelFacet(address(diamond)).getOffer(offerId).accepted, "still on the book");

        _reopen();
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status), uint8(LibVaipakam.LoanStatus.Active)
        );
    }

    function test_Match_RefusedWithItsPreview() public {
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        uint256 lo = _postLenderOffer();
        vm.prank(borrower);
        uint256 bo = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 30), type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), bo);
        LibTestTiming.waitOutTermsAge(address(diamond), lo);
        uint64 since = _close();
        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(lo, bo, address(this), address(this));
        assertEq(uint8(r.errorCode), uint8(LibOfferMatch.MatchError.NetworkClosing), "the match preview says why");
        _expectClosing(since);
        OfferMatchFacet(address(diamond)).matchOffers(lo, bo);
    }

    function test_Slot_SetAndFundRefused() public {
        uint64 since = _close();
        _expectClosing(since);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, PRINCIPAL, 500, 5000, 30, 1 ether, false, 0, false, true,
            LibVaipakam.IntentRateTerms(0, 0, false),
            type(uint64).max
        );
        _expectClosing(since);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).fundLenderIntent(mockERC20, mockCollateralERC20, 0, 1 ether);
    }

    function test_Extension_Refused() public {
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
        (uint64 opensAt,) = AutoLifecycleFacet(address(diamond)).getAutoExtendWindow(loanId);
        if (vm.getBlockTimestamp() < opensAt) vm.warp(opensAt);
        uint64 startBefore = LoanFacet(address(diamond)).getLoanDetails(loanId).startTime;

        uint64 since = _close();
        _expectClosing(since);
        vm.prank(borrower);
        AutoLifecycleFacet(address(diamond)).extendLoanInPlace(loanId, 500, 30);
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).startTime, startBefore, "start unchanged");

        _reopen();
        vm.prank(borrower);
        AutoLifecycleFacet(address(diamond)).extendLoanInPlace(loanId, 500, 30);
        assertGt(LoanFacet(address(diamond)).getLoanDetails(loanId).startTime, startBefore, "extended once open");
    }

    /// A lender's direct sale brings a new party into the loan: the position
    /// migration asks the opening rule and refuses it.
    function test_DirectSale_Refused() public {
        uint256 loanId = _openLoan();
        address buyer = _provisionFundedActor("closing-buyer", mockERC20, PRINCIPAL * 2);
        vm.warp(block.timestamp + 1 days);
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        uint256 end = uint256(l.startTime) + uint256(l.durationDays) * 1 days;
        uint256 remaining = (end - block.timestamp + 1 days - 1) / 1 days;
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender, remaining);
        p.amount = l.principal;
        p.amountMax = p.amount;
        vm.prank(buyer);
        uint256 buyOfferId = OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
        LibTestTiming.backdateTerms(address(diamond), buyOfferId);

        uint64 since = _close();
        _expectClosing(since);
        vm.prank(lender);
        EarlyWithdrawalDirectFacet(address(diamond)).sellLoanViaBuyOffer(
            loanId, buyOfferId, 0, type(uint256).max, type(uint64).max
        );
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).lender, lender, "the position did not move");
    }

    /// An obligation handover brings a new borrower into the loan.
    function test_ObligationHandover_Refused() public {
        uint256 loanId = _openLoan();
        address incoming = makeAddr("closingIncoming");
        ERC20Mock(mockCollateralERC20).mint(incoming, COLLATERAL * 2);
        vm.prank(incoming);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(incoming);
        ERC20(mockCollateralERC20).approve(
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(incoming), type(uint256).max
        );
        vm.prank(incoming);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 30), type(uint64).max
        );
        LibTestTiming.backdateTerms(address(diamond), offerId);
        ERC20Mock(mockERC20).mint(borrower, PRINCIPAL);

        uint64 since = _close();
        _expectClosing(since);
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).transferObligationViaOffer(loanId, offerId, type(uint64).max);
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).borrower, borrower, "the obligation did not move");
    }

    // ─── Still open while closing ─────────────────────────────────────────

    /// Everything that helps a loan end: the reserves, standing instructions
    /// (the Terms part alone), adding collateral, a partial and a full
    /// repayment, then the lender's claim.
    function test_CloseOutSteps_StayOpen() public {
        uint256 loanId = _openLoan();
        _close();

        ERC20Mock(mockERC20).mint(borrower, PRINCIPAL * 2);
        vm.startPrank(borrower);
        StandingInstructionFacet(address(diamond)).fundLoanReserve(loanId, 0, 10 ether);
        StandingInstructionFacet(address(diamond)).withdrawLoanReserve(borrower, loanId, 0, 4 ether);
        StandingInstructionFacet.InstructionInput memory cfg;
        cfg.repayAtDue = true;
        StandingInstructionFacet(address(diamond)).setStandingInstructions(loanId, cfg);
        StandingInstructionFacet(address(diamond)).clearStandingInstructions(loanId);
        ERC20Mock(mockCollateralERC20).mint(borrower, 100 ether);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, 100 ether);
        vm.stopPrank();

        vm.warp(block.timestamp + 5 days);
        vm.startPrank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, 100 ether);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
        assertEq(uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status), uint8(LibVaipakam.LoanStatus.Repaid));
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
    }

    /// Setting standing instructions asks the Terms part alone: closing does
    /// not refuse it, and a stale Terms standing still does.
    function test_StandingInstructions_TermsPartOnly() public {
        uint256 loanId = _openLoan();
        uint64 since = _close();
        _l().announceTos(1, H1, uint64(block.timestamp));
        StandingInstructionFacet.InstructionInput memory cfg;
        cfg.repayAtDue = true;
        vm.expectRevert(abi.encodeWithSelector(LibTerms.TermsNotAccepted.selector, borrower, uint32(1)));
        vm.prank(borrower);
        StandingInstructionFacet(address(diamond)).setStandingInstructions(loanId, cfg);
        vm.prank(borrower);
        _l().acceptTerms(1, H1);
        vm.prank(borrower);
        StandingInstructionFacet(address(diamond)).setStandingInstructions(loanId, cfg);
        (, uint64 stillSince) = _l().getNetworkClosing();
        assertEq(stillSince, since, "set while closing");
    }

    /// Cancelling an offer and the vault's own deposit and withdrawal.
    function test_CancelAndVault_StayOpen() public {
        uint256 offerId = _postLenderOffer();
        _close();
        // Past the cancel cooldown, which is not the rule under test.
        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY);
        vm.prank(lender);
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);

        ERC20Mock(mockERC20).mint(lender, 50 ether);
        vm.startPrank(lender);
        VaultDepositoryFacet(address(diamond)).depositToVault(
            uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, 50 ether
        );
        uint256 before = ERC20(mockERC20).balanceOf(lender);
        VaultDepositoryFacet(address(diamond)).withdrawFromVault(
            lender, uint8(LibVaipakam.AssetType.ERC20), mockERC20, 0, 50 ether, lender
        );
        vm.stopPrank();
        assertEq(ERC20(mockERC20).balanceOf(lender) - before, 50 ether, "withdrawn to the wallet");
    }

    /// A plain transfer of a position token passes no opening site.
    function test_PositionTokenTransfer_StaysOpen() public {
        uint256 loanId = _openLoan();
        _close();
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(loanId).lenderTokenId;
        address holder = makeAddr("closingHolder");
        LibTestPositionNFT.move(address(diamond), tokenId, holder);
        assertEq(LibTestPositionNFT.core(address(diamond)).ownerOf(tokenId), holder, "the token moved");
    }

    // ─── Reopening ────────────────────────────────────────────────────────

    function test_Reopen_RestoresOpening() public {
        _prepareVaults();
        uint64 since = _close();
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Lender, 30);
        _expectClosing(since);
        vm.prank(lender);
        OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
        _reopen();
        assertTrue(_l().mayOpen(lender));
        _openLoan();
    }
}

/**
 * @title NetworkClosingIntentTest
 * @notice #3864 — the Auto-lend slot on a closing network: a fill and its
 *         preview are refused, the slot's re-commit of held payments and its
 *         roll of a repaid loan are refused by name (the closing part only),
 *         the lender's normal claim (which releases the slot's exposure)
 *         stays open, and the re-commit and the roll work again once the
 *         switch is off.
 */
contract NetworkClosingIntentTest is SetupTest, NetworkClosingBase {
    address internal solver;

    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant MAX_EXPOSURE = 10_000 ether;
    uint256 internal constant MIN_RATE_BPS = 500;
    uint16 internal constant MAX_INIT_LTV_BPS = 5000;
    uint32 internal constant MAX_DURATION = 60;
    uint256 internal constant MIN_FILL = 100 ether;

    function setUp() public {
        setupHelper();
        solver = makeAddr("intentSolver");
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);
        vm.prank(lender);
        OfferPriceGuardFacet(address(diamond)).setIntentCalmCheck(mockERC20, mockCollateralERC20, 0, false);
    }

    function _l() internal view returns (LegalFacet) {
        return LegalFacet(address(diamond));
    }

    function _close() internal returns (uint64 since) {
        _l().setNetworkClosing(true);
        (, since) = _l().getNetworkClosing();
    }

    function _expectClosing(uint64 since) internal {
        vm.expectRevert(abi.encodeWithSelector(LibTerms.NetworkClosing.selector, since));
    }

    function _setIntent() internal {
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, MAX_EXPOSURE, MIN_RATE_BPS, MAX_INIT_LTV_BPS, MAX_DURATION, MIN_FILL,
            false, 0, true, true, LibVaipakam.IntentRateTerms(0, 0, false), type(uint64).max
        );
        LibTestTiming.waitOutIntentAge(address(diamond), lender, mockERC20, mockCollateralERC20);
    }

    function _fundIntent(uint256 amount) internal {
        ERC20Mock(mockERC20).mint(lender, amount);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), amount);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).fundLenderIntent(mockERC20, mockCollateralERC20, 0, amount);
    }

    function _newBorrower(string memory name) internal returns (address b) {
        b = makeAddr(name);
        ERC20Mock(mockERC20).mint(b, 1_000_000 ether);
        ERC20Mock(mockCollateralERC20).mint(b, 1_000_000 ether);
        vm.startPrank(b);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.stopPrank();
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(b, LibVaipakam.KYCTier.Tier2);
    }

    function _postBorrower(address creator, bool partialRepay) internal returns (uint256 offerId) {
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                integrator: address(0),
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: MIN_RATE_BPS,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 2 * PRINCIPAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: partialRepay,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: MIN_RATE_BPS + 100,
                collateralAmountMax: 2 * PRINCIPAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: !partialRepay,
                linkKind: 0,
                linkMarginBps: 0,
                rateFarFromAverageAcknowledged: false
            }),
            type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
    }

    function _preview(uint256 cp) internal view returns (LibOfferMatch.IntentPreviewResult memory) {
        return IntentPreviewFacet(address(diamond)).previewIntent(
            solver, solver, lender, mockERC20, mockCollateralERC20, 0, cp, PRINCIPAL
        );
    }

    function _fill(uint256 cp) internal returns (uint256) {
        vm.prank(solver);
        return OfferMatchIntentFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, 0, cp, PRINCIPAL
        );
    }

    /// @dev An open slot loan that allows partial repayment.
    function _slotLoan(string memory name, bool partialRepay) internal returns (uint256 loanId, address b) {
        b = _newBorrower(name);
        uint256 cp = _postBorrower(b, partialRepay);
        _setIntent();
        _fundIntent(PRINCIPAL);
        loanId = _fill(cp);
    }

    function _lenderHeld(uint256 loanId) internal view returns (uint256 amount) {
        (,,,,,, amount,) = ClaimViewFacet(address(diamond)).getClaimable(loanId, true);
    }

    function _livePrincipal() internal view returns (uint256) {
        return LenderIntentViewFacet(address(diamond)).getLenderIntentLivePrincipal(
            lender, mockERC20, mockCollateralERC20, 0
        );
    }

    function test_Fill_RefusedWithItsPreview() public {
        address b = _newBorrower("closing-fill");
        uint256 cp = _postBorrower(b, false);
        _setIntent();
        _fundIntent(PRINCIPAL);
        uint64 since = _close();
        LibOfferMatch.IntentPreviewResult memory r = _preview(cp);
        assertFalse(r.ok, "the preview refuses");
        assertEq(uint8(r.matchError), uint8(LibOfferMatch.MatchError.NetworkClosing), "and says why");
        vm.prank(solver);
        _expectClosing(since);
        OfferMatchIntentFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, 0, cp, PRINCIPAL
        );
    }

    /// The re-commit of held payments is refused while closing, the payments
    /// stay held for the holder, and it works again once the switch is off.
    function test_Recommit_RefusedWhileClosing_WorksAfter() public {
        (uint256 loanId, address b) = _slotLoan("closing-recommit", true);
        vm.warp(vm.getBlockTimestamp() + 5 days);
        vm.prank(b);
        RepayFacet(address(diamond)).repayPartial(loanId, 400 ether);
        uint256 held = _lenderHeld(loanId);
        assertGt(held, 0, "fixture-live: a payment is held");

        uint64 since = _close();
        _expectClosing(since);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).recommitHeldToIntent(loanId);
        assertEq(_lenderHeld(loanId), held, "still held for the holder");

        _l().setNetworkClosing(false);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).recommitHeldToIntent(loanId);
        assertEq(_lenderHeld(loanId), 0, "re-committed once open");
    }

    /// The roll of a repaid slot loan is refused while closing and works again
    /// once the switch is off.
    function test_Roll_RefusedWhileClosing_WorksAfter() public {
        (uint256 loanId, address b) = _slotLoan("closing-roll", false);
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);

        uint64 since = _close();
        _expectClosing(since);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);

        _l().setNetworkClosing(false);
        uint256 capitalBefore = LenderIntentViewFacet(address(diamond)).getLenderIntentCapital(
            lender, mockERC20, mockCollateralERC20, 0
        );
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
        assertGt(
            LenderIntentViewFacet(address(diamond)).getLenderIntentCapital(lender, mockERC20, mockCollateralERC20, 0),
            capitalBefore,
            "rolled once open"
        );
    }

    /// The lender's normal claim on a repaid slot loan stays open while
    /// closing, and its release of the slot's exposure (the Diamond-internal
    /// `releaseIntentExposure`) runs with it.
    function test_Claim_ReleasesExposureWhileClosing() public {
        (uint256 loanId, address b) = _slotLoan("closing-claim", false);
        assertEq(_livePrincipal(), PRINCIPAL, "fixture-live: exposure out");
        uint64 since = _close();
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        assertEq(_livePrincipal(), 0, "the exposure was released");
        (, uint256 rollable) = LenderIntentViewFacet(address(diamond)).getRollableIntentLoans(0, 50);
        assertEq(rollable, 0, "and the loan de-registered");
        // Slot capital can still be taken out, while closing.
        (, uint64 stillSince) = _l().getNetworkClosing();
        assertEq(stillSince, since);
    }
}

/**
 * @title NetworkClosingBackstopTest
 * @notice #3864 — the backstop vault is exempt from the Terms part, never
 *         from the closing part: its fill is refused while closing and works
 *         once the switch is off.
 */
contract NetworkClosingBackstopTest is SetupTest, NetworkClosingBase {
    address internal vault;
    uint256 internal constant SEED = 10_000 ether;
    uint256 internal constant PRINCIPAL = 500 ether;

    function setUp() public {
        setupHelper();
        vm.warp(1_000_000);
        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);
        BackstopFacet(address(diamond)).initializeBackstopVaultImplementation();
        vault = BackstopFacet(address(diamond)).provisionBackstopVault();
        LibTestVaultBeacon.sync(address(diamond));
        BackstopFacet(address(diamond)).setBackstopIntent(
            mockERC20, mockCollateralERC20, 100_000 ether, 500, 5000, 30, 100 ether
        );
        BackstopFacet(address(diamond)).setBackstopEnabled(true);
        BackstopFacet(address(diamond)).setBackstopFillEnabled(true);
        vm.stopPrank();
        ERC20Mock(mockERC20).mint(address(diamond), SEED);
        vm.startPrank(owner);
        uint256 bal = TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20);
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, bal + SEED);
        BackstopFacet(address(diamond)).seedBackstopOrigination(mockERC20, mockCollateralERC20, SEED);
        vm.stopPrank();
    }

    function _optedInOffer() internal returns (uint256 offerId) {
        address b = makeAddr("closingBackstopBorrower");
        ERC20Mock(mockERC20).mint(b, 1_000_000 ether);
        ERC20Mock(mockCollateralERC20).mint(b, 1_000_000 ether);
        vm.startPrank(b);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.stopPrank();
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(b, LibVaipakam.KYCTier.Tier2);
        vm.prank(b);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                integrator: address(0),
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 2 * PRINCIPAL,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: 600,
                collateralAmountMax: 2 * PRINCIPAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: uint64(vm.getBlockTimestamp() + 10 days),
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true,
                linkKind: 0,
                linkMarginBps: 0,
                rateFarFromAverageAcknowledged: false
            }),
            type(uint64).max
        );
        vm.prank(b);
        BackstopFacet(address(diamond)).setOfferBackstopEligible(offerId, uint64(vm.getBlockTimestamp() + 1 days));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
    }

    function test_BackstopFill_RefusedWhileClosing_WorksAfter() public {
        uint256 offerId = _optedInOffer();
        // The vault is exempt from the Terms part.
        LegalFacet(address(diamond)).announceTos(1, keccak256("v1"), uint64(block.timestamp));
        assertTrue(LegalFacet(address(diamond)).isTermsCurrent(vault), "the vault is exempt from the Terms");
        vm.prank(makeAddr("closingBackstopBorrower"));
        LegalFacet(address(diamond)).acceptTerms(1, keccak256("v1"));

        LegalFacet(address(diamond)).setNetworkClosing(true);
        (, uint64 since) = LegalFacet(address(diamond)).getNetworkClosing();
        assertFalse(LegalFacet(address(diamond)).mayOpen(vault), "never from the closing part");
        vm.expectRevert(abi.encodeWithSelector(LibTerms.NetworkClosing.selector, since));
        vm.prank(makeAddr("poker"));
        BackstopFacet(address(diamond)).backstopFill(offerId);

        LegalFacet(address(diamond)).setNetworkClosing(false);
        vm.prank(makeAddr("poker"));
        uint256 loanId = BackstopFacet(address(diamond)).backstopFill(offerId);
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).lender, vault, "filled once open");
    }
}

/**
 * @title NetworkClosingAbsorbTest
 * @notice #3864 — a loan that ends badly still ends on a closing network: the
 *         HF liquidation (here into the in-kind fallback, every venue
 *         failing) runs, and the backstop's absorb of the fallback loan,
 *         which is how its lender is paid, passes no opening site.
 * @dev Same harness and fixture shape as `FallbackCustodyTest` F10.
 */
contract NetworkClosingAbsorbTest is CustodyInvariantBase {
    uint256 internal constant HF_HEALTHY = 2e18;
    uint256 internal constant HF_LIQUIDATABLE = 0.9e18;
    uint256 internal constant LTV_HEALTHY = 5_000;
    uint256 internal constant LTV_LIQUIDATABLE = 9_600;
    uint256 internal constant PRINCIPAL = 1_000e18;
    uint256 internal constant COLLATERAL = 2_000e18;

    function setUp() public {
        _deployCustodyHarness();
    }

    function _setRisk(uint256 loanId, uint256 hf, uint256 ltv) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId), abi.encode(hf));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId), abi.encode(ltv));
    }

    function _route() internal view returns (LibSwap.AdapterCall[] memory route) {
        route = new LibSwap.AdapterCall[](1);
        route[0] = LibSwap.AdapterCall({adapterIdx: failingAdapterIdx, data: bytes("")});
    }

    function _open() internal returns (uint256 loanId) {
        address l = custodyLenders[0];
        ERC20Mock(usdc).mint(l, PRINCIPAL);
        ERC20Mock(weth).mint(custodyBorrowers[0], COLLATERAL);
        LibVaipakam.CreateOfferParams memory p = LibVaipakam.CreateOfferParams({
            integrator: address(0),
            lifecycleFlex: 0,
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: usdc,
            amount: PRINCIPAL,
            interestRateBps: 1_000,
            collateralAsset: weth,
            collateralAmount: COLLATERAL,
            durationDays: 30,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(0),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: true,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: PRINCIPAL,
            interestRateBpsMax: 1_000,
            collateralAmountMax: COLLATERAL,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false,
            linkKind: 0,
            linkMarginBps: 0,
            rateFarFromAverageAcknowledged: false
        });
        vm.prank(l);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
        loanId = LibAcceptTestSigner.signAndAccept(address(diamond), custodyBorrowers[0], custodyBorrowerPks[0], offerId);
        _setRisk(loanId, HF_HEALTHY, LTV_HEALTHY);
    }

    function test_LiquidationAndAbsorb_RunWhileClosing() public {
        uint256 id = _open();
        LegalFacet(address(diamond)).setNetworkClosing(true);

        _setRisk(id, HF_LIQUIDATABLE, LTV_LIQUIDATABLE);
        LibTestFallbackGate.open(address(diamond), id);
        uint256 sellQuote = liquidationQuote(address(diamond), id);
        RiskFacet(address(diamond)).triggerLiquidation(id, sellQuote, _route());
        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(id).status),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "the liquidation ran while closing"
        );

        vm.prank(custodyLenders[0]);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(id, true);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(id, _route());
        LibVaipakam.LoanStatus st = LoanFacet(address(diamond)).getLoanDetails(id).status;
        assertTrue(
            st == LibVaipakam.LoanStatus.Defaulted || st == LibVaipakam.LoanStatus.Settled,
            "the absorb ended the loan while closing"
        );
        (bool closing,) = LegalFacet(address(diamond)).getNetworkClosing();
        assertTrue(closing);
    }
}
