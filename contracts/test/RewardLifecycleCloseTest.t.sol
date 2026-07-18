// test/RewardLifecycleCloseTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
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
    function setUp() public {
        setupHelper();
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
        (uint256 preview,,) =
            InteractionRewardsLensFacet(address(diamond)).previewInteractionRewards(lender);
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
}

interface IERC20Mint {
    function approve(address, uint256) external returns (bool);
}
