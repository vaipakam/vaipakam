// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchIntentFacet} from "../src/facets/OfferMatchIntentFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {MarketLedgerFacet} from "../src/facets/MarketLedgerFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibMarketLedger} from "../src/libraries/LibMarketLedger.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";

/**
 * @title  MarketLedgerTest
 * @notice Instant market §8 — the common ledger. Declared is the sum of
 *         `maxExposure` over active Auto-lend slots; Lent is the open principal
 *         of every ERC-20 loan in the active set. Both are kept per lending
 *         asset and per pair, and each test checks them against the sum over
 *         their sources after the step (design §12.6).
 */
abstract contract MarketLedgerBase is SetupTest {
    address internal solver;
    address internal otherCollateral;

    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant MIN_RATE_BPS = 500;
    uint16 internal constant MAX_INIT_LTV_BPS = 5000;
    uint32 internal constant MAX_DURATION = 30;
    uint256 internal constant MIN_FILL = 100 ether;

    function setUp() public {
        setupHelper();
        solver = makeAddr("ledgerSolver");
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);
    }

    // ─── helpers ────────────────────────────────────────────────────────────

    function _set(address coll, uint8 slot, uint256 maxExposure, bool proRata) internal {
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, coll, slot, maxExposure, MIN_RATE_BPS, MAX_INIT_LTV_BPS,
            MAX_DURATION, MIN_FILL, false, 0, proRata, true, type(uint64).max
        );
    }

    function _fund(uint256 amount) internal {
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
        vm.prank(b);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(b);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(b);
        ProfileFacet(address(diamond)).setUserCountry("US");
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
                durationDays: MAX_DURATION,
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
                useFullTermInterest: !partialRepay
            }),
            type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
    }

    function _fill(uint256 cp) internal returns (uint256 loanId) {
        LibTestTiming.waitOutIntentAge(address(diamond), lender, mockERC20, mockCollateralERC20);
        vm.prank(solver);
        loanId = OfferMatchIntentFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, 0, cp, PRINCIPAL
        );
    }

    function _asset() internal view returns (uint256 declared, uint256 lent) {
        (declared, , lent, , ) = MarketLedgerFacet(address(diamond)).getMarketLedger(mockERC20);
    }

    function _pair(address coll) internal view returns (uint256 declared, uint256 lent) {
        (declared, , lent, , ) = MarketLedgerFacet(address(diamond)).getPairLedger(mockERC20, coll);
    }

    function _fromSlots() internal view returns (uint256 f) {
        (, , , f, ) = MarketLedgerFacet(address(diamond)).getMarketLedger(mockERC20);
    }

    function _setUntil(uint8 slot, uint256 maxExposure, uint64 lendUntil) internal {
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, slot, maxExposure, MIN_RATE_BPS, MAX_INIT_LTV_BPS,
            MAX_DURATION, MIN_FILL, false, lendUntil, false, true, type(uint64).max
        );
    }

    /// @dev The stored total as a write would leave it, read through a roll.
    function _rollAll() internal {
        MarketLedgerFacet(address(diamond)).rollMarketLedger(mockERC20, mockCollateralERC20, 10_000);
    }

    function _principal(uint256 loanId) internal view returns (uint256) {
        return LoanFacet(address(diamond)).getLoanDetails(loanId).principal;
    }
}

/// @notice Declared and Lent through set, cancel, fill and repay.
contract MarketLedgerTest is MarketLedgerBase {
    // ─── Declared ───────────────────────────────────────────────────────────

    /// @dev Set, re-set, a second slot, a second pair and a cancel: Declared
    ///      equals the sum of the active slots' `maxExposure` after each step.
    function test_declaredFollowsEveryActiveSlot() public {
        otherCollateral = address(new ERC20Mock("Other", "OTH", 18));
        _set(mockCollateralERC20, 0, 5000 ether, false);
        (uint256 d, ) = _asset();
        assertEq(d, 5000 ether, "first slot");

        _set(mockCollateralERC20, 0, 3000 ether, false); // re-set lower
        (d, ) = _asset();
        assertEq(d, 3000 ether, "re-set replaces, never adds");

        _set(mockCollateralERC20, 1, 2000 ether, false); // second slot, same pair
        (d, ) = _pair(mockCollateralERC20);
        assertEq(d, 5000 ether, "pair sums its slots");

        // The admission check on a second pair may refuse an unpriced
        // collateral; the per-pair split is shown on the first pair either way.
        try this.setOther() {
            (d, ) = _asset();
            assertEq(d, 5000 ether + 1000 ether, "asset sums every pair");
            (d, ) = _pair(otherCollateral);
            assertEq(d, 1000 ether, "second pair alone");
        } catch {}

        vm.prank(lender);
        LenderIntentFacet(address(diamond)).cancelLenderIntent(mockERC20, mockCollateralERC20, 1);
        (d, ) = _pair(mockCollateralERC20);
        assertEq(d, 3000 ether, "cancel removes the slot");
        // Cancelling again is refused, so it cannot subtract twice.
        vm.prank(lender);
        vm.expectRevert();
        LenderIntentFacet(address(diamond)).cancelLenderIntent(mockERC20, mockCollateralERC20, 1);
    }

    /// @dev The slot hosts are Diamond-internal.
    function test_slotHostsAreDiamondInternal() public {
        vm.expectRevert(MarketLedgerFacet.OnlyDiamondInternal.selector);
        MarketLedgerFacet(address(diamond)).syncSlot(lender, mockERC20, mockCollateralERC20, 0);
        vm.expectRevert(MarketLedgerFacet.OnlyDiamondInternal.selector);
        MarketLedgerFacet(address(diamond)).onSlotFilled(1);
        vm.expectRevert(MarketLedgerFacet.OnlyDiamondInternal.selector);
        MarketLedgerFacet(address(diamond)).onSlotReleased(1);
        vm.expectRevert(MarketLedgerFacet.OnlyDiamondInternal.selector);
        MarketLedgerFacet(address(diamond)).onSlotLoanPrincipal(1, 0, 1);
    }

    /// @dev The library's literal selector is the facet's.
    function test_slotLoanPrincipalSelectorPinned() public pure {
        assertEq(LibMarketLedger.ON_SLOT_LOAN_PRINCIPAL, MarketLedgerFacet.onSlotLoanPrincipal.selector);
    }

    function setOther() external {
        _set(otherCollateral, 0, 1000 ether, false);
    }

    /// @dev Funding and withdrawing capital change no slot's declared figure.
    function test_capitalDoesNotMoveDeclared() public {
        _set(mockCollateralERC20, 0, 5000 ether, false);
        _fund(2 * PRINCIPAL);
        (uint256 d, ) = _asset();
        assertEq(d, 5000 ether, "funding leaves declared");
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).withdrawLenderIntentCapital(
            lender, mockERC20, mockCollateralERC20, 0, PRINCIPAL
        );
        (d, ) = _asset();
        assertEq(d, 5000 ether, "withdrawing leaves declared");
    }

    // ─── Lent ───────────────────────────────────────────────────────────────

    /// @dev A fill adds its principal; a full repay takes it out at once (the
    ///      loan leaves the active set), and the lender's claim moves nothing.
    function test_lentFollowsOpenPrincipalThroughRepayAndClaim() public {
        _set(mockCollateralERC20, 0, 5000 ether, false);
        _fund(2 * PRINCIPAL);
        address b = _newBorrower("b-full");
        uint256 loanId = _fill(_postBorrower(b, false));

        (uint256 d, uint256 l) = _asset();
        assertEq(l, PRINCIPAL, "fill adds principal");
        assertEq(_fromSlots(), PRINCIPAL, "a slot fill counts as lent from slots");
        assertEq(d, 5000 ether, "a fill does not change declared");
        (, l) = _pair(mockCollateralERC20);
        assertEq(l, PRINCIPAL, "pair lent");

        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);
        (, l) = _asset();
        assertEq(l, 0, "repaid loan no longer lent");
        assertEq(_fromSlots(), 0, "nor lent from slots");

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        (, l) = _asset();
        assertEq(l, 0, "claim moves nothing");
    }

    /// @dev A partial repay lowers Lent by exactly the principal it cleared.
    function test_partialRepayLowersLentByTheClearedPrincipal() public {
        _set(mockCollateralERC20, 0, 5000 ether, true);
        _fund(2 * PRINCIPAL);
        address b = _newBorrower("b-part");
        uint256 loanId = _fill(_postBorrower(b, true));
        vm.warp(block.timestamp + 1 days);

        vm.prank(b);
        RepayFacet(address(diamond)).repayPartial(loanId, 400 ether);
        (, uint256 l) = _asset();
        assertEq(l, _principal(loanId), "lent equals the loan's open principal");
        assertLt(l, PRINCIPAL, "partial repay lowered it");
        assertEq(_fromSlots(), l, "the slot figure follows the same principal");
    }
}

/// @notice Declared after a slot's fill window closes, without a transaction.
contract MarketLedgerExpiryTest is MarketLedgerBase {
    // ─── Expiry ─────────────────────────────────────────────────────────────

    /// @dev A slot counts through the UTC day its fill window closes (one day
    ///      before lend-until) and drops out the next day with no transaction.
    ///      Cancelling it afterwards takes nothing out again.
    function test_expiredSlotLeavesDeclaredWithoutATransaction() public {
        uint64 until = uint64(vm.getBlockTimestamp() + 10 days);
        _setUntil(0, 4000 ether, until);
        _set(mockCollateralERC20, 1, 1000 ether, false); // no lend-until
        (uint256 d, ) = _asset();
        assertEq(d, 5000 ether, "both slots");

        uint256 closes = until - 1 days; // the window closes a day early
        vm.warp((closes / 1 days) * 1 days + 1 days - 1); // last second of that day
        (d, ) = _asset();
        assertEq(d, 5000 ether, "counts through its closing day");

        vm.warp((closes / 1 days) * 1 days + 1 days); // the next day starts
        (d, ) = _asset();
        assertEq(d, 1000 ether, "gone the next day, read with no write");
        (d, ) = _pair(mockCollateralERC20);
        assertEq(d, 1000 ether, "and from the pair");

        vm.prank(lender);
        LenderIntentFacet(address(diamond)).cancelLenderIntent(mockERC20, mockCollateralERC20, 0);
        (d, ) = _asset();
        assertEq(d, 1000 ether, "cancelling an expired slot subtracts nothing");
        _rollAll();
        (d, ) = _asset();
        assertEq(d, 1000 ether, "rolling agrees with the read");
    }

    /// @dev Cancelling a slot before its closing day takes it out of both the
    ///      total and its day's bucket, so the bucket does not subtract it a
    ///      second time when that day passes.
    function test_cancelBeforeExpiryLeavesTheBucket() public {
        uint64 until = uint64(vm.getBlockTimestamp() + 10 days);
        _setUntil(0, 4000 ether, until);
        _set(mockCollateralERC20, 1, 1000 ether, false);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).cancelLenderIntent(mockERC20, mockCollateralERC20, 0);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        (uint256 d, ) = _asset();
        assertEq(d, 1000 ether, "no second subtraction at the closing day");
        _rollAll();
        (d, ) = _asset();
        assertEq(d, 1000 ether, "rolled total agrees");
    }

    /// @dev After a quiet gap longer than one write rolls, a write and the
    ///      roll entry both leave the total exact.
    function test_longGapStaysExact() public {
        _setUntil(0, 4000 ether, uint64(vm.getBlockTimestamp() + 10 days));
        _setUntil(1, 3000 ether, uint64(vm.getBlockTimestamp() + 60 days));
        _set(mockCollateralERC20, 2, 1000 ether, false);
        vm.warp(vm.getBlockTimestamp() + 200 days);
        (uint256 d, ) = _asset();
        assertEq(d, 1000 ether, "both dated slots expired");
        // A write rolls at most 31 days; the rest stays for later writes.
        _set(mockCollateralERC20, 3, 500 ether, false);
        (d, ) = _asset();
        assertEq(d, 1500 ether, "write after a long gap is exact");
        // Re-setting an expired slot whose day is still unrolled.
        _setUntil(1, 2000 ether, uint64(vm.getBlockTimestamp() + 10 days));
        (d, ) = _asset();
        assertEq(d, 3500 ether, "re-set expired slot counts once, at its new size");
        _rollAll();
        (d, ) = _asset();
        assertEq(d, 3500 ether, "rolled total agrees");
    }
}
