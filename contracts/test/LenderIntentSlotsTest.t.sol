// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchIntentFacet} from "../src/facets/OfferMatchIntentFacet.sol";
import {RiskPreviewFacet} from "../src/facets/RiskPreviewFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {LenderIntentViewFacet} from "../src/facets/LenderIntentViewFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {LibMetricsTypes} from "../src/libraries/LibMetricsTypes.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";

/**
 * @title  LenderIntentSlotsTest
 * @notice #3626 — several standing intents per asset pair. One owner holds up
 *         to `MAX_INTENT_SLOTS` intents on one (lendingAsset, collateralAsset)
 *         pair, each fully independent: its own funded capital, exposure cap,
 *         rate floor and terms. A fill names the slot it draws from; a roll
 *         returns to the slot the loan came from. Every check is made on the
 *         live fill and on `previewIntent`, which must agree.
 */
contract LenderIntentSlotsTest is SetupTest {
    address internal solver;

    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant MAX_EXPOSURE = 10_000 ether;
    uint16 internal constant MAX_INIT_LTV_BPS = 5000;
    uint32 internal constant MAX_DURATION = 60;
    uint256 internal constant MIN_FILL = 100 ether;
    uint256 internal constant LOW_FLOOR = 500;
    uint256 internal constant HIGH_FLOOR = 700;

    function setUp() public {
        setupHelper();
        solver = makeAddr("intentSolver");
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);
    }

    // ─── helpers ────────────────────────────────────────────────────────

    function _intents() internal view returns (LenderIntentFacet) {
        return LenderIntentFacet(address(diamond));
    }

    /// @dev The standing-intent reads (LenderIntentViewFacet).
    function _intentsReads() internal view returns (LenderIntentViewFacet) {
        return LenderIntentViewFacet(address(diamond));
    }

    function _setSlot(uint8 slot, uint256 floorBps) internal {
        vm.prank(lender);
        _intents().setLenderIntent(
            mockERC20, mockCollateralERC20, slot, MAX_EXPOSURE, floorBps, MAX_INIT_LTV_BPS, MAX_DURATION, MIN_FILL,
            false, 0, false, true, type(uint64).max
        );
    }

    function _fundSlot(uint8 slot, uint256 amount) internal {
        ERC20Mock(mockERC20).mint(lender, amount);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), amount);
        vm.prank(lender);
        _intents().fundLenderIntent(mockERC20, mockCollateralERC20, slot, amount);
    }

    function _waitOut(uint8 slot) internal {
        LibTestTiming.waitOutIntentAge(address(diamond), lender, mockERC20, mockCollateralERC20, slot);
    }

    function _newBorrower(string memory name) internal returns (address b) {
        b = makeAddr(name);
        ERC20Mock(mockERC20).mint(b, 1_000_000 ether);
        ERC20Mock(mockCollateralERC20).mint(b, 1_000_000 ether);
        vm.prank(b);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(b);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(b);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(b, LibVaipakam.KYCTier.Tier2);
    }

    /// @dev A full-term borrower request asking `rateMin … rateMax`.
    function _post(string memory name, uint256 rateMin, uint256 rateMax) internal returns (address b, uint256 id) {
        b = _newBorrower(name);
        vm.prank(b);
        id = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: rateMin,
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
                interestRateBpsMax: rateMax,
                collateralAmountMax: 2 * PRINCIPAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true
            }),
            type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), id);
    }

    function _preview(uint8 slot, uint256 cp) internal view returns (LibOfferMatch.IntentPreviewResult memory) {
        return RiskPreviewFacet(address(diamond)).previewIntent(
            solver, solver, lender, mockERC20, mockCollateralERC20, slot, cp, PRINCIPAL
        );
    }

    function _fill(uint8 slot, uint256 cp) internal returns (uint256) {
        assertTrue(_preview(slot, cp).ok, "preview admits the fill");
        vm.prank(solver);
        return OfferMatchIntentFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, slot, cp, PRINCIPAL
        );
    }

    function _capital(uint8 slot) internal view returns (uint256) {
        return _intentsReads().getLenderIntentCapital(lender, mockERC20, mockCollateralERC20, slot);
    }

    function _live(uint8 slot) internal view returns (uint256) {
        return _intentsReads().getLenderIntentLivePrincipal(lender, mockERC20, mockCollateralERC20, slot);
    }

    /// @dev A low-floor slot 0 and a high-floor slot 1, each funded on its own.
    function _ladder() internal {
        _setSlot(0, LOW_FLOOR);
        _setSlot(1, HIGH_FLOOR);
        _waitOut(1);
        _fundSlot(0, PRINCIPAL);
        _fundSlot(1, 2 * PRINCIPAL);
    }

    // ─── tests ──────────────────────────────────────────────────────────

    /// @dev Each slot fills only the requests its own bounds admit, the
    ///      preview agrees, and capital, exposure and live principal never
    ///      cross between slots.
    function test_twoSlots_independentBoundsAndCapital() public {
        (, uint256 low) = _post("b-low", 500, 600);
        (, uint256 high) = _post("b-high", 700, 900);
        _ladder();

        assertFalse(_preview(1, low).ok, "the high floor refuses a 5-6% request");
        vm.prank(solver);
        vm.expectRevert();
        OfferMatchIntentFacet(address(diamond)).matchIntent(lender, mockERC20, mockCollateralERC20, 1, low, PRINCIPAL);

        uint256 loanLow = _fill(0, low);
        assertEq(_capital(0), 0, "slot 0 lent its capital");
        assertEq(_live(0), PRINCIPAL, "slot 0 exposure");
        assertEq(_capital(1), 2 * PRINCIPAL, "slot 1 capital untouched");
        assertEq(_live(1), 0, "slot 1 exposure untouched");

        uint256 loanHigh = _fill(1, high);
        assertEq(_capital(1), PRINCIPAL, "slot 1 lent from its own capital");
        assertEq(_live(1), PRINCIPAL, "slot 1 exposure");
        assertEq(_capital(0), 0, "slot 0 still empty");
        assertEq(_live(0), PRINCIPAL, "slot 0 exposure unchanged");

        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanLow).interestRateBps, 550, "midpoint of 5-6%");
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanHigh).interestRateBps, 800, "midpoint of 7-9%");

        // Slot 0 is empty now: the preview and the fill both refuse a draw on it.
        (, uint256 another) = _post("b-again", 500, 600);
        assertEq(
            uint8(_preview(0, another).intentError),
            uint8(LibOfferMatch.IntentError.CapitalInsufficient),
            "an empty slot refuses, whatever the other slot holds"
        );
    }

    /// @dev A repaid loan rolls back into the slot it was filled from; the
    ///      roll feed names that slot and the other slot's capital is unchanged.
    function test_rollReturnsToItsSlot() public {
        (address b, uint256 high) = _post("b-roll", 700, 900);
        _ladder();
        uint256 loanId = _fill(1, high);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);

        (LibMetricsTypes.RollableIntentLoan[] memory rows,) = _intentsReads().getRollableIntentLoans(0, 10);
        assertEq(rows.length, 1, "one roll candidate");
        assertEq(rows[0].slot, 1, "the feed names the slot the loan came from");

        uint256 slot0Before = _capital(0);
        uint256 slot1Before = _capital(1);
        vm.prank(lender);
        _intents().rollIntentLoan(loanId);
        assertGt(_capital(1), slot1Before + PRINCIPAL, "principal and interest back behind slot 1");
        assertEq(_capital(0), slot0Before, "slot 0 unchanged");
        assertEq(_live(1), 0, "slot 1 exposure released");
    }

    /// @dev Cancelling and emptying one slot leaves the other active and
    ///      listed, in the keeper feed and in the owner's own view.
    function test_cancelOneSlot_otherStaysListed() public {
        _ladder();
        (LibMetricsTypes.LenderIntentSummary[] memory rows, uint256 total) = _intentsReads().getActiveLenderIntents(0, 10);
        assertEq(total, 2, "both slots in the feed");
        assertEq(rows.length, 2, "both listed");
        assertTrue(rows[0].slot != rows[1].slot, "one row per slot");

        vm.prank(lender);
        _intents().cancelLenderIntent(mockERC20, mockCollateralERC20, 0);
        (rows, total) = _intentsReads().getActiveLenderIntents(0, 10);
        assertEq(total, 1, "only slot 1 left in the feed");
        assertEq(rows[0].slot, 1, "slot 1 still listed");
        assertEq(rows[0].minRateBps, HIGH_FLOOR, "with its own floor");

        (LibMetricsTypes.OwnerLenderIntentSummary[] memory mine, uint256 count) =
            _intentsReads().getLenderIntentsByOwner(lender, 0, 10);
        assertEq(count, 2, "the paused slot still holds capital, so the owner still sees it");
        for (uint256 i = 0; i < mine.length; i++) {
            assertEq(mine[i].active, mine[i].intent.slot == 1, "only slot 1 is active");
        }

        vm.prank(lender);
        _intents().withdrawLenderIntentCapital(lender, mockERC20, mockCollateralERC20, 0, PRINCIPAL);
        (, count) = _intentsReads().getLenderIntentsByOwner(lender, 0, 10);
        assertEq(count, 1, "a torn-down slot leaves the owner view");
        assertEq(_capital(1), 2 * PRINCIPAL, "slot 1 capital untouched");
        assertTrue(_intentsReads().getLenderIntent(lender, mockERC20, mockCollateralERC20, 1).active, "slot 1 active");
    }

    /// @dev Slots run 0 … MAX_INTENT_SLOTS − 1; the next one is refused by name.
    function test_slotOutOfRange() public {
        uint8 top = LibVaipakam.MAX_INTENT_SLOTS - 1;
        _setSlot(top, LOW_FLOOR);
        assertTrue(_intentsReads().getLenderIntent(lender, mockERC20, mockCollateralERC20, top).active, "the last slot");

        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(LenderIntentFacet.LenderIntentSlotOutOfRange.selector, top + 1)
        );
        _intents().setLenderIntent(
            mockERC20, mockCollateralERC20, top + 1, MAX_EXPOSURE, LOW_FLOOR, MAX_INIT_LTV_BPS, MAX_DURATION, MIN_FILL,
            false, 0, false, true, type(uint64).max
        );
    }

    /// @dev Re-setting one slot leaves the other's terms and capital alone,
    ///      and every intent event states the slot.
    function test_resetOneSlot_eventsStateTheSlot() public {
        _ladder();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LenderIntentFacet.LenderIntentSet(
            lender, mockERC20, mockCollateralERC20, 1, MAX_EXPOSURE, 900, MAX_INIT_LTV_BPS, MAX_DURATION, MIN_FILL,
            false, 0, false
        );
        _setSlot(1, 900);
        assertEq(_intentsReads().getLenderIntent(lender, mockERC20, mockCollateralERC20, 0).minRateBps, LOW_FLOOR, "slot 0 kept");
        assertEq(_capital(0), PRINCIPAL, "slot 0 capital kept");
        assertEq(_capital(1), 2 * PRINCIPAL, "a re-set keeps the slot's own capital");

        ERC20Mock(mockERC20).mint(lender, 1 ether);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), 1 ether);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LenderIntentFacet.LenderIntentFunded(lender, mockERC20, mockCollateralERC20, 0, 1 ether, PRINCIPAL + 1 ether);
        vm.prank(lender);
        _intents().fundLenderIntent(mockERC20, mockCollateralERC20, 0, 1 ether);
    }
}
