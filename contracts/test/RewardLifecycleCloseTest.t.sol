// test/RewardLifecycleCloseTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";

/**
 * @notice #1002 (S4) + #969 (S5) — interaction-reward lifecycle.
 *         S4: a reward entry is claimable ONLY once its loan is closed (the
 *             `closed` bit), not merely because the calendar passed the
 *             contracted maturity. Guards the "claim at maturity while still
 *             open, then default" forfeit-bypass.
 *         S5: the preclose paths (which flip Active→Repaid) must close the
 *             reward entries — previously they left both entries accruing to the
 *             original contracted endDay.
 */
contract RewardLifecycleCloseTest is SetupTest {
    VPFIToken internal vpfi;

    function setUp() public {
        setupHelper();
        // #2308 routes the reward preview through the backing position, which
        // names an unset VPFI token (`RecycleBackingTokenUnset`) rather than
        // reading a code-less address. A deployment always configures the
        // token, so this suite does too — the same wiring every other
        // preview-reading suite performs.
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)))
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        // Start interaction emissions so loan origination registers entries.
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        // Advance so `today >= 1` (entries start at today+1).
        vm.warp(block.timestamp + 1 days + 1);
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _createLoan() internal returns (uint256 loanId) {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 1800 ether,
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
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 1800 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        LibAcceptTestSigner.signAndAccept(address(diamond), borrower, borrowerPk, offerId);
        loanId = 1;
    }

    function _entries(address user)
        internal
        view
        returns (LibVaipakam.RewardEntry[] memory)
    {
        return InteractionRewardsLensFacet(address(diamond)).getUserRewardEntries(user);
    }

    // ─── S4: entries open at origination, closed by closeLoan ────────────────

    function testEntriesOpenAtOrigination() public {
        _createLoan();
        LibVaipakam.RewardEntry[] memory le = _entries(lender);
        LibVaipakam.RewardEntry[] memory be = _entries(borrower);
        assertEq(le.length, 1, "lender has one entry");
        assertEq(be.length, 1, "borrower has one entry");
        assertFalse(le[0].closed, "lender entry OPEN at origination");
        assertFalse(be[0].closed, "borrower entry OPEN at origination");
        assertGt(le[0].endDay, 0, "endDay stamped at registration (the dead sentinel)");
    }

    /// @dev S4 gate: while the loan is open, the entry-path preview pays nothing
    ///      even after the contracted maturity has passed — the claim is gated
    ///      on the loan being CLOSED, not on the calendar.
    function testPreviewZeroWhileOpenPastMaturity() public {
        _createLoan();
        // Warp well past the 30-day maturity; the loan is still Active (open).
        vm.warp(block.timestamp + 45 days);
        (uint256 preview,,) = previewByExecution(lender);
        assertEq(preview, 0, "no entry reward payable while the loan is open");
    }

    function testRepayClosesEntries() public {
        uint256 loanId = _createLoan();
        // Full repayment (principal + interest). Approve generously.
        vm.startPrank(borrower);
        IERC20Mint(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();

        assertTrue(_entries(lender)[0].closed, "lender entry CLOSED after repay");
        assertTrue(_entries(borrower)[0].closed, "borrower entry CLOSED after repay");
    }

    // ─── S5: preclose closes the entries ─────────────────────────────────────

    function testPrecloseDirectClosesEntries() public {
        uint256 loanId = _createLoan();
        vm.startPrank(borrower);
        IERC20Mint(mockERC20).approve(address(diamond), type(uint256).max);
        PrecloseFacet(address(diamond)).precloseDirect(loanId);
        vm.stopPrank();

        assertTrue(_entries(lender)[0].closed, "lender entry CLOSED after preclose");
        assertTrue(_entries(borrower)[0].closed, "borrower entry CLOSED after preclose");
        // In-grace clean preclose → neither side forfeits (lender repaid).
        assertFalse(_entries(lender)[0].forfeited, "lender not forfeited");
        assertFalse(_entries(borrower)[0].forfeited, "borrower not forfeited (in grace)");
    }

    /// @dev #2739 — a terminal transition closes its reward entry in the
    ///      same transaction or reverts. The reward close used to run behind a
    ///      best-effort hook that swallowed a failure, leaving a Repaid loan
    ///      whose reward entries were still open. A failing close now reverts
    ///      the whole preclose, carrying the close's own revert data.
    function testPrecloseRevertsWhenRewardCloseFails() public {
        uint256 loanId = _createLoan();
        bytes memory reason = abi.encodeWithSignature("RewardCloseBroke()");
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(InteractionRewardsFacet.precloseRewardClose.selector),
            reason
        );
        vm.startPrank(borrower);
        IERC20Mint(mockERC20).approve(address(diamond), type(uint256).max);
        vm.expectRevert(reason);
        PrecloseFacet(address(diamond)).precloseDirect(loanId);
        vm.stopPrank();

        // Nothing moved: the loan is still Active and both entries open.
        assertEq(
            uint8(LibVaipakam.LoanStatus.Active),
            uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status),
            "loan still Active after the failed close"
        );
        assertFalse(_entries(lender)[0].closed, "lender entry still open");
        assertFalse(_entries(borrower)[0].closed, "borrower entry still open");
    }

    /// @dev #2739 — a reward close that fails WITHOUT revert data still
    ///      reverts the terminal, under the typed `RewardHookCallFailed`.
    function testPrecloseRevertsTypedWhenRewardCloseFailsSilently() public {
        uint256 loanId = _createLoan();
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(InteractionRewardsFacet.precloseRewardClose.selector),
            ""
        );
        vm.startPrank(borrower);
        IERC20Mint(mockERC20).approve(address(diamond), type(uint256).max);
        vm.expectRevert(IVaipakamErrors.RewardHookCallFailed.selector);
        PrecloseFacet(address(diamond)).precloseDirect(loanId);
        vm.stopPrank();
    }

    /// @dev Pass-2 A1/D5 (#1189) — a preclose PAST the grace window is now
    ///      BLOCKED (parity with `repayLoan`), superseding the earlier "late
    ///      preclose forfeits borrower" behaviour (Codex #1061 P2) that relied on
    ///      the now-closed post-grace preclose door. The late borrower must
    ///      resolve through the default path (DefaultedFacet), which is where the
    ///      reward forfeit now happens (covered by the default-terminal reward
    ///      tests). Here we assert the door is shut.
    function testLatePreclose_blockedPostGrace() public {
        uint256 loanId = _createLoan();
        // 30-day loan, ~2-week grace → warp well past graceEnd but keep Active.
        vm.warp(block.timestamp + 30 days + 20 days);
        vm.startPrank(borrower);
        IERC20Mint(mockERC20).approve(address(diamond), type(uint256).max);
        vm.expectRevert(PrecloseFacet.RepaymentPastGracePeriod.selector);
        PrecloseFacet(address(diamond)).precloseDirect(loanId);
        vm.stopPrank();
    }

    // ─── #3171: the day a loan ends earns no reward day ──────────────────────

    function _today() internal view returns (uint256 day) {
        (day,) = InteractionRewardsLensFacet(address(diamond)).getInteractionCurrentDay();
    }

    function _repay(uint256 loanId) internal {
        vm.startPrank(borrower);
        IERC20Mint(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(loanId);
        vm.stopPrank();
    }

    /// @dev A loan repaid mid-term earns its reward days from the day after
    ///      it opened up to, NOT including, the day it closed.
    function testClosingDayEarnsNothing() public {
        uint256 opened = _today();
        uint256 loanId = _createLoan();
        vm.warp(block.timestamp + 5 days);
        uint256 closedOn = _today();
        assertEq(closedOn, opened + 5, "five reward days later");
        _repay(loanId);

        LibVaipakam.RewardEntry memory le = _entries(lender)[0];
        LibVaipakam.RewardEntry memory be = _entries(borrower)[0];
        assertEq(le.startDay, opened + 1, "earns from the day after opening");
        assertEq(le.endDay, closedOn, "lender: the closing day is excluded");
        assertEq(be.endDay, closedOn, "borrower: the closing day is excluded");
        assertEq(le.endDay - le.startDay, 4, "four whole days earned");
    }

    /// @dev The round trip #3171 names: opened late one day, repaid early the
    ///      next. The entry closes empty — no reward day for minutes of interest.
    function testLoanAcrossOneDayBoundaryEarnsNoDay() public {
        // Move to the last minute of the current reward day.
        (uint256 day,) = InteractionRewardsLensFacet(address(diamond)).getInteractionCurrentDay();
        uint256 loanId;
        {
            uint256 secondsIntoDay = (block.timestamp - _launch()) % 1 days;
            vm.warp(block.timestamp + (1 days - secondsIntoDay) - 60);
            assertEq(_today(), day, "still the opening day");
            loanId = _createLoan();
        }
        vm.warp(block.timestamp + 120);
        assertEq(_today(), day + 1, "the next day");
        _repay(loanId);

        LibVaipakam.RewardEntry memory le = _entries(lender)[0];
        LibVaipakam.RewardEntry memory be = _entries(borrower)[0];
        assertEq(le.endDay, le.startDay, "lender entry closes empty");
        assertEq(be.endDay, be.startDay, "borrower entry closes empty");
    }

    /// @dev A close at or after the term's end keeps the full contracted window.
    function testCloseAfterTermKeepsTheWholeWindow() public {
        uint256 opened = _today();
        uint256 loanId = _createLoan();
        vm.warp(block.timestamp + 31 days);
        _repay(loanId);
        LibVaipakam.RewardEntry memory le = _entries(lender)[0];
        assertEq(le.startDay, opened + 1, "start");
        assertEq(le.endDay, opened + 31, "the whole 30-day window");
    }

    /// @dev The same loan continuing (preclose obligation handover) loses no
    ///      day: the outgoing entries stop at the start of today and the
    ///      re-registered ones carry today.
    function testContinuingLoanLosesNoDay() public {
        uint256 loanId = _createLoan();
        vm.warp(block.timestamp + 3 days);
        uint256 today = _today();
        vm.prank(address(diamond));
        InteractionRewardsFacet(address(diamond)).precloseRewardTransferObligation(loanId);

        LibVaipakam.RewardEntry[] memory le = _entries(lender);
        assertEq(le.length, 2, "old and re-registered lender entries");
        assertTrue(le[0].closed, "old entry closed");
        assertEq(le[0].endDay, today, "outgoing entry stops at the start of today");
        assertEq(le[1].startDay, today, "continuing entry carries today");
        assertFalse(le[1].closed, "continuing entry open");
    }

    /// @dev Codex #3203 r1 P1 — a continuation earlier on the closing day
    ///      cannot carry that day out of the rule: a loan handed over and then
    ///      repaid on the same day earns nothing for that day on any slice.
    ///      Kills: a continuation that leaves today on the outgoing slice.
    function testContinuationThenRepaySameDayEarnsNoClosingDay() public {
        uint256 opened = _today();
        uint256 loanId = _createLoan();
        vm.warp(block.timestamp + 3 days);
        uint256 closedOn = _today();
        vm.prank(address(diamond));
        InteractionRewardsFacet(address(diamond)).precloseRewardTransferObligation(loanId);
        _repay(loanId);

        uint256 earned;
        LibVaipakam.RewardEntry[] memory le = _entries(lender);
        for (uint256 i; i < le.length; ++i) {
            assertTrue(le[i].closed, "every slice closed");
            assertLe(le[i].endDay, closedOn, "no slice reaches the closing day");
            earned += le[i].endDay - le[i].startDay;
        }
        assertEq(earned, closedOn - (opened + 1), "the whole days strictly between opening and closing");
    }

    /// @dev Codex #3203 r1 P1 — a continuation on the OPENING day never credits
    ///      the opening day: the continuing slice resumes tomorrow.
    function testContinuationOnOpeningDayStartsTomorrow() public {
        uint256 opened = _today();
        uint256 loanId = _createLoan();
        vm.prank(address(diamond));
        InteractionRewardsFacet(address(diamond)).precloseRewardTransferObligation(loanId);
        LibVaipakam.RewardEntry[] memory le = _entries(lender);
        assertEq(le[le.length - 1].startDay, opened + 1, "the opening day earns nothing");
    }

    /// @dev Codex #3203 r1 P2 — a loan repaid at its maturity, on the reward
    ///      day its term ends, also earns nothing for that closing day: a
    ///      30-day loan opened on day D and repaid on day D+30 earns 29 days.
    ///      Only a close on a later day keeps the whole contracted window.
    function testRepayAtMaturityEarnsAllButTheClosingDay() public {
        uint256 opened = _today();
        uint256 loanId = _createLoan();
        vm.warp(block.timestamp + 30 days);
        assertEq(_today(), opened + 30, "fixture: the maturity day");
        _repay(loanId);
        LibVaipakam.RewardEntry memory le = _entries(lender)[0];
        assertEq(le.endDay - le.startDay, 29, "29 of the contracted 30 days");
    }

    function _launch() internal view returns (uint256) {
        return InteractionRewardsLensFacet(address(diamond)).getInteractionLaunchTimestamp();
    }
}

interface IERC20Mint {
    function approve(address, uint256) external returns (bool);
}
