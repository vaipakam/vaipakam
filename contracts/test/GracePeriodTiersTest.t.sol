// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/// @title GracePeriodTiersTest
/// @notice Pinpoint coverage for the duration-tiered grace period defined
///         in LibVaipakam.gracePeriod():
///
///           durationDays < 7    → 1 hour
///           durationDays < 30   → 1 day
///           durationDays < 90   → 3 days
///           durationDays < 180  → 1 week
///           durationDays >= 180 → 2 weeks
///
///         The grace window is critical because `DefaultedFacet.triggerDefault`
///         and `isLoanDefaultable` both use it to decide whether a late loan
///         has crossed into the permissionless liquidation lane (README §7).
///         Each boundary is validated twice — one second before the grace
///         ends (not defaultable) and one second after (defaultable).
///
///         The tests rewrite `loan.durationDays` via {TestMutatorFacet} so
///         we can exercise every tier off of a single shared loan without
///         spawning five full lender/borrower setups.
contract GracePeriodTiersTest is SetupTest {
    uint256 internal loanId;
    uint256 internal baseStart;

    function setUp() public {
        setupHelper();
        loanId = _createSeedLoan();
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        baseStart = uint256(loan.startTime);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _createSeedLoan() internal returns (uint256) {
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
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
                creatorFallbackConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0
            })
        );
        vm.prank(borrower);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
        return 1;
    }

    function _setDuration(uint256 durationDays) internal {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loan.durationDays = durationDays;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);
    }

    function _assertGrace(
        uint256 durationDays,
        uint256 expectedGrace,
        string memory tag
    ) internal {
        _setDuration(durationDays);
        uint256 endTime = baseStart + durationDays * 1 days;
        uint256 graceEnd = endTime + expectedGrace;

        // At the exact grace end: not yet defaultable (strict `<=` guard).
        vm.warp(graceEnd);
        assertFalse(
            DefaultedFacet(address(diamond)).isLoanDefaultable(loanId),
            tag
        );

        // One second past grace end: defaultable.
        vm.warp(graceEnd + 1);
        assertTrue(
            DefaultedFacet(address(diamond)).isLoanDefaultable(loanId),
            tag
        );
    }

    // ─── Tier: [1, 7) → 1 hour ───────────────────────────────────────────────

    function testTier1HourAtMinDuration() public {
        _assertGrace(1, 1 hours, "dur=1 -> 1h grace");
    }

    function testTier1HourAtUpperBoundary() public {
        _assertGrace(6, 1 hours, "dur=6 -> 1h grace (just below 7)");
    }

    // ─── Tier: [7, 30) → 1 day ───────────────────────────────────────────────

    function testTier1DayAtLowerBoundary() public {
        _assertGrace(7, 1 days, "dur=7 -> 1d grace (floor of tier)");
    }

    function testTier1DayAtUpperBoundary() public {
        _assertGrace(29, 1 days, "dur=29 -> 1d grace (just below 30)");
    }

    // ─── Tier: [30, 90) → 3 days ─────────────────────────────────────────────

    function testTier3DaysAtLowerBoundary() public {
        _assertGrace(30, 3 days, "dur=30 -> 3d grace");
    }

    function testTier3DaysAtUpperBoundary() public {
        _assertGrace(89, 3 days, "dur=89 -> 3d grace");
    }

    // ─── Tier: [90, 180) → 1 week ────────────────────────────────────────────

    function testTier1WeekAtLowerBoundary() public {
        _assertGrace(90, 1 weeks, "dur=90 -> 1w grace");
    }

    function testTier1WeekAtUpperBoundary() public {
        _assertGrace(179, 1 weeks, "dur=179 -> 1w grace");
    }

    // ─── Tier: [180, ∞) → 2 weeks ────────────────────────────────────────────

    function testTier2WeeksAtLowerBoundary() public {
        _assertGrace(180, 2 weeks, "dur=180 -> 2w grace");
    }

    function testTier2WeeksFarAbove() public {
        _assertGrace(730, 2 weeks, "dur=730 -> 2w grace");
    }

    // ─── Pre-endTime behavior ────────────────────────────────────────────────

    function testNotDefaultableBeforeEndTime() public {
        _setDuration(30);
        uint256 endTime = baseStart + 30 days;
        vm.warp(endTime - 1);
        assertFalse(
            DefaultedFacet(address(diamond)).isLoanDefaultable(loanId),
            "pre-due should not be defaultable"
        );
    }

    function testNotDefaultableMidGraceWindow() public {
        // 30-day loan → 3-day grace. Mid-grace (t = endTime + 1 day) must
        // still be within the cure window.
        _setDuration(30);
        uint256 endTime = baseStart + 30 days;
        vm.warp(endTime + 1 days);
        assertFalse(
            DefaultedFacet(address(diamond)).isLoanDefaultable(loanId),
            "mid-grace should not be defaultable"
        );
    }
}
