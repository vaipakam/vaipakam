// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {PerkFacet} from "../src/facets/PerkFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchIntentFacet} from "../src/facets/OfferMatchIntentFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {ServiceCapacityFacet} from "../src/facets/ServiceCapacityFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibPriorityRouting} from "../src/libraries/LibPriorityRouting.sol";
import {RiskPreviewFacet} from "../src/facets/RiskPreviewFacet.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title  PriorityRoutingPerkTest
 * @notice #2559 / #2550 — the priority solver routing perk (perk id 1). A
 *         `matchIntent` fill that the solver's service capacity would REFUSE goes
 *         through on one of the intent owner's priority credits, but ONLY when the
 *         owner opted that intent in and holds a credit. When the solver's capacity
 *         covers the fill (or the limiter is dark) it is charged exactly as before
 *         and no credit is spent.
 *
 * @dev    Every cell is a STRADDLE where it makes sense: one variable changes and
 *         both sides are asserted, so a cell cannot pass for a reason unrelated to
 *         the property it names. Fixtures mirror `LenderIntentMatchTest` (the fill)
 *         `ServiceCapacityLimiterTest` (the Solver curve and an exhausted bucket)
 *         and `PerkSpendTest` (VPFI in the buyer's vault).
 */
contract PriorityRoutingPerkTest is SetupTest {
    VPFIToken internal vpfi;
    address internal solver;

    uint256 internal constant PERK = 1; // LibPriorityRouting.PERK_ID
    uint256 internal constant PRICE = 2e18; // VPFI per credit
    uint8 internal constant SOLVER = uint8(LibVaipakam.ServiceCapacityRole.Solver);
    uint256 internal constant FREE = 1e18; // one action of free tier
    uint256 internal constant RATE = 1e16; // 100 s per free action
    uint256 internal constant AT4X = 100e18;
    uint256 internal constant COST = 1e18;

    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant MAX_EXPOSURE = 10_000 ether;
    uint256 internal constant MIN_RATE_BPS = 500;
    uint16 internal constant MAX_INIT_LTV_BPS = 5000;
    uint32 internal constant MAX_DURATION = 30;
    uint256 internal constant MIN_FILL = 100 ether;

    event LenderIntentPrioritySet(
        address indexed owner, address indexed lendingAsset, address indexed collateralAsset, bool enabled
    );
    event PerkCreditConsumed(address indexed user, uint256 indexed perkId, uint256 creditsLeft);

    bytes32 internal constant T_PRIORITY_SET = keccak256("LenderIntentPrioritySet(address,address,address,bool)");
    bytes32 internal constant T_PRIORITY_FILL =
        keccak256("IntentPriorityFill(address,address,address,uint256,address,uint256)");
    bytes32 internal constant T_CREDIT_CONSUMED = keccak256("PerkCreditConsumed(address,uint256,uint256)");
    bytes32 internal constant T_CAPACITY_SPENT = keccak256("CapacitySpent(uint8,address,uint256,uint256)");

    function setUp() public {
        setupHelper();
        solver = makeAddr("prioritySolver");
        AdminFacet(address(diamond)).setTreasury(makeAddr("treasury"));

        // The intent fill path: both master gates on (they are also two of the
        // perk's three deliverability conditions).
        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setRangeAmountEnabled(true);
        ConfigFacet(address(diamond)).setRangeRateEnabled(true);
        ConfigFacet(address(diamond)).setRangeCollateralEnabled(true);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);
        vm.stopPrank();

        // VPFI in the intent owner's vault, so the owner can buy credits.
        vpfi = _newVpfi();
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        vpfi.transfer(lender, 100e18);
        vm.startPrank(lender);
        vpfi.approve(address(diamond), type(uint256).max);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(50e18);
        vm.stopPrank();
    }

    // ─── fixtures ───────────────────────────────────────────────────────────

    function _newVpfi() internal returns (VPFIToken t) {
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl), abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)))
        );
        t = VPFIToken(address(proxy));
    }

    function _cap() internal view returns (ServiceCapacityFacet) {
        return ServiceCapacityFacet(address(diamond));
    }

    function _perk() internal view returns (PerkFacet) {
        return PerkFacet(address(diamond));
    }

    function _intentFacet() internal view returns (LenderIntentFacet) {
        return LenderIntentFacet(address(diamond));
    }

    /// @dev Light the Solver capacity curve (the limiter goes live).
    function _lightCurve() internal {
        _cap().setCapacityCurve(SOLVER, FREE, RATE, AT4X, COST);
    }

    /// @dev Arm the counted perk and buy `units` credits as the intent owner.
    function _buyCredits(uint256 units) internal {
        _perk().setPerkConfig(PERK, PRICE, 0);
        vm.prank(lender);
        _perk().purchasePerk(PERK, units, PRICE * units, 0);
    }

    function _credits() internal view returns (uint256 c) {
        (,, c) = _perk().getPerkEntitlement(lender, PERK);
    }

    function _vaultVpfi(address who) internal view returns (uint256) {
        return vpfi.balanceOf(VaultFactoryFacet(address(diamond)).getUserVaultAddress(who));
    }

    function _setIntent() internal {
        vm.prank(lender);
        _intentFacet().setLenderIntent(
            mockERC20, mockCollateralERC20, MAX_EXPOSURE, MIN_RATE_BPS, MAX_INIT_LTV_BPS, MAX_DURATION, MIN_FILL, false, true
        );
    }

    function _fundIntent(uint256 amount) internal {
        ERC20Mock(mockERC20).mint(lender, amount);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), amount);
        vm.prank(lender);
        _intentFacet().fundLenderIntent(mockERC20, mockCollateralERC20, amount);
    }

    function _setPriority(bool enabled) internal {
        vm.prank(lender);
        _intentFacet().setLenderIntentPriority(mockERC20, mockCollateralERC20, enabled);
    }

    function _priority() internal view returns (bool enabled) {
        (enabled,,,) = _view();
    }

    /// @dev The snapshot view for the direct solver (the initiator is ignored on a
    ///      direct route, so the transaction originator is passed).
    function _view() internal view returns (bool enabled, uint256 credits, bool capacityCovers, bool creditUnlocks) {
        return _intentFacet().getLenderIntentPriority(lender, mockERC20, mockCollateralERC20, solver, tx.origin);
    }

    function _assertView(bool enabled, uint256 credits, bool capacityCovers, bool creditUnlocks, string memory tag)
        internal
        view
    {
        (bool e, uint256 c, bool cc, bool cu) = _view();
        assertEq(e, enabled, string.concat(tag, ": enabled"));
        assertEq(c, credits, string.concat(tag, ": credits"));
        assertEq(cc, capacityCovers, string.concat(tag, ": capacityCovers"));
        assertEq(cu, creditUnlocks, string.concat(tag, ": creditUnlocks"));
    }

    /// @dev Spend the solver's one free action through the Diamond-gated charge, so
    ///      its bucket is seen and empty at this second (the limiter suite's route).
    function _exhaustSolver() internal {
        address s = solver; // read BEFORE the prank
        vm.prank(address(diamond));
        _cap().capacityChargeInternal(SOLVER, s);
        (uint256 accrued,,,) = _cap().previewCapacity(SOLVER, s);
        assertEq(accrued, 0, "fixture-live: the solver's bucket is exhausted");
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

    function _postBorrower(string memory name) internal returns (uint256 offerId) {
        address creator = _newBorrower(name);
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
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
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: MIN_RATE_BPS + 100,
                collateralAmountMax: 2 * PRINCIPAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true
            })
        );
    }

    function _fill(uint256 cp) internal returns (uint256 loanId) {
        vm.prank(solver);
        loanId = OfferMatchIntentFacet(address(diamond)).matchIntent(lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL);
    }

    function _expectExhausted() internal {
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.ServiceCapacityExhausted.selector, SOLVER, solver, COST, 0));
    }

    /// @dev The common opted-in fixture: an active, funded intent; the Solver curve
    ///      lit; `credits` priority credits bought; the intent opted in.
    function _optedInFixture(uint256 credits) internal {
        _setIntent();
        _fundIntent(3 * PRINCIPAL);
        _lightCurve();
        if (credits != 0) _buyCredits(credits);
        _setPriority(true);
        assertTrue(_priority(), "fixture-live: opted in");
        assertEq(_credits(), credits, "fixture-live: credits held");
    }

    function _count(Vm.Log[] memory logs, bytes32 topic0) internal view returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(diamond) && logs[i].topics.length != 0 && logs[i].topics[0] == topic0) n++;
        }
    }

    function _bucket() internal view returns (LibVaipakam.CapacityBucket memory) {
        return _cap().getCapacityBucket(SOLVER, solver);
    }

    function _assertBucketEq(LibVaipakam.CapacityBucket memory a, LibVaipakam.CapacityBucket memory b, string memory tag)
        internal
        pure
    {
        assertEq(a.balance, b.balance, string.concat(tag, ": balance"));
        assertEq(a.lastTouch, b.lastTouch, string.concat(tag, ": lastTouch"));
        assertEq(a.curveEpoch, b.curveEpoch, string.concat(tag, ": curveEpoch"));
        assertEq(a.seen, b.seen, string.concat(tag, ": seen"));
    }

    // ─── 1. capacity covers → no credit spent ───────────────────────────────

    /// @dev The solver's unseen bucket holds its one free action, so the fill is
    ///      covered: the solver is charged one action, and the opted-in owner's
    ///      credit is NOT spent. (Cell 2 is the other side: the same fixture with the
    ///      bucket exhausted spends the credit.)
    function test_CapacityCovers_SolverCharged_NoCreditSpent() public {
        _optedInFixture(1);
        uint256 cp = _postBorrower("b-covers");
        assertFalse(_bucket().seen, "fixture-live: the solver's bucket is unseen (one free action)");
        _assertView(true, 1, true, false, "covered");

        vm.recordLogs();
        uint256 loanId = _fill(cp);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertGt(loanId, 0, "filled");
        assertEq(_credits(), 1, "no credit spent while the solver's capacity covers the fill");
        assertTrue(_bucket().seen, "the solver's bucket was touched");
        (uint256 accrued,,,) = _cap().previewCapacity(SOLVER, solver);
        assertEq(accrued, 0, "the solver's one action was charged");
        assertEq(_count(logs, T_CAPACITY_SPENT), 1, "one capacity charge");
        assertEq(_count(logs, T_PRIORITY_FILL), 0, "no IntentPriorityFill");
        assertEq(_count(logs, T_CREDIT_CONSUMED), 0, "no PerkCreditConsumed");
    }

    // ─── 2. exhausted + opted in + credit → fill on the credit ──────────────

    /// @dev Straddle on the bucket against cell 1: exhausted, the same opted-in
    ///      intent's fill goes through on the credit (1 → 0); the solver's bucket is
    ///      NOT touched; `IntentPriorityFill` and `PerkCreditConsumed` name the
    ///      owner, pair, loan, solver and the credits left. Then straddle on the
    ///      credit count: the same state with 0 credits refuses by name.
    function test_Exhausted_OptedIn_Credit_FillsOnTheCredit_ThenZeroCreditsRefuses() public {
        _optedInFixture(1);
        uint256 cp1 = _postBorrower("b-credit-1");
        uint256 cp2 = _postBorrower("b-credit-2");
        _exhaustSolver();
        _assertView(true, 1, false, true, "exhausted + credit");
        LibVaipakam.CapacityBucket memory before = _bucket();

        vm.recordLogs();
        uint256 loanId = _fill(cp1);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertGt(loanId, 0, "filled on the credit");
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).lender, lender, "lender-of-record");
        assertEq(_credits(), 0, "one credit spent");
        _assertBucketEq(_bucket(), before, "the solver's bucket is untouched");
        assertEq(_count(logs, T_CAPACITY_SPENT), 0, "no capacity charge");
        assertEq(_count(logs, T_CREDIT_CONSUMED), 1, "PerkCreditConsumed once");
        assertEq(_count(logs, T_PRIORITY_FILL), 1, "IntentPriorityFill once");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == T_PRIORITY_FILL) {
                assertEq(logs[i].emitter, address(diamond), "emitted by the Diamond");
                assertEq(address(uint160(uint256(logs[i].topics[1]))), lender, "owner");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), mockERC20, "lendingAsset");
                assertEq(address(uint160(uint256(logs[i].topics[3]))), mockCollateralERC20, "collateralAsset");
                (uint256 lid, address slv, uint256 left) = abi.decode(logs[i].data, (uint256, address, uint256));
                assertEq(lid, loanId, "loanId");
                assertEq(slv, solver, "solver");
                assertEq(left, 0, "creditsLeft");
            } else if (logs[i].topics[0] == T_CREDIT_CONSUMED) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), lender, "consumed from the owner");
                assertEq(uint256(logs[i].topics[2]), PERK, "perk id 1");
                assertEq(abi.decode(logs[i].data, (uint256)), 0, "nothing left");
            }
        }

        // The other side of the straddle: the same opted-in, exhausted intent with
        // ZERO credits is refused exactly as an unprioritised fill is.
        _assertView(true, 0, false, false, "exhausted + 0 credits");
        _expectExhausted();
        _fill(cp2);
    }

    /// @dev The zero-credit side as its own fixture (never bought): opted in and
    ///      exhausted, the fill reverts `ServiceCapacityExhausted`.
    function test_Exhausted_OptedIn_ZeroCredits_Reverts() public {
        _optedInFixture(0);
        uint256 cp = _postBorrower("b-zero");
        _exhaustSolver();
        _assertView(true, 0, false, false, "never bought");
        _expectExhausted();
        _fill(cp);
    }

    // ─── 3. exhausted + credits held + NOT opted in → refused ───────────────

    /// @dev Straddle on the opt-in flag: with credits held and the bucket exhausted,
    ///      the un-opted intent's fill is refused and no credit moves; flipping ONLY
    ///      the flag lets the same fill through on a credit.
    function test_Exhausted_Credits_NotOptedIn_Reverts_OptInLifts() public {
        _setIntent();
        _fundIntent(3 * PRINCIPAL);
        _lightCurve();
        _buyCredits(2);
        uint256 cp = _postBorrower("b-flag");
        _exhaustSolver();
        _assertView(false, 2, false, false, "not opted in");

        _expectExhausted();
        _fill(cp);
        assertEq(_credits(), 2, "no credit spent on a refused fill");

        _setPriority(true);
        _assertView(true, 2, false, true, "opted in");
        uint256 loanId = _fill(cp);
        assertGt(loanId, 0, "the same fill goes through once opted in");
        assertEq(_credits(), 1, "one credit spent");
    }

    // ─── 4. limiter dark → no charge, no credit ─────────────────────────────

    /// @dev The Solver curve cleared (by a VPFI rotation, the real clearing path):
    ///      the limiter is dark, so an opted-in owner's fill is neither charged to
    ///      the solver nor paid for with a credit.
    function test_LimiterDark_NoChargeNoCredit() public {
        _optedInFixture(1);
        uint256 cp = _postBorrower("b-dark");
        VPFITokenFacet(address(diamond)).setVPFIToken(address(_newVpfi())); // rotation clears every curve
        assertEq(_cap().getCapacityCurve(SOLVER).freeTier, 0, "fixture-live: the Solver curve is dark");
        _assertView(true, 1, true, false, "dark");

        vm.recordLogs();
        uint256 loanId = _fill(cp);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertGt(loanId, 0, "filled");
        assertEq(_credits(), 1, "no credit spent while dark");
        assertFalse(_bucket().seen, "no bucket touched while dark");
        assertEq(_count(logs, T_CAPACITY_SPENT), 0, "no capacity charge");
        assertEq(_count(logs, T_PRIORITY_FILL), 0, "no IntentPriorityFill");
        assertEq(_count(logs, T_CREDIT_CONSUMED), 0, "no PerkCreditConsumed");
    }

    // ─── 5. opt-in lifecycle + events ───────────────────────────────────────

    /// @dev Opt-in needs an ACTIVE intent; EVERY write emits exactly one event — a
    ///      repeated write with the same value included (Codex #2563 r1: each is a
    ///      consent action the logs must record, not only the changes).
    function test_OptIn_RequiresActiveIntent_AndEmitsOnEveryWrite() public {
        // No intent at all: refused.
        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentNotActive.selector);
        _intentFacet().setLenderIntentPriority(mockERC20, mockCollateralERC20, true);

        // Active intent: accepted, one event.
        _setIntent();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LenderIntentPrioritySet(lender, mockERC20, mockCollateralERC20, true);
        _setPriority(true);
        assertTrue(_priority(), "opted in");

        // The same value again: one event, the repeated consent recorded.
        vm.recordLogs();
        _setPriority(true);
        assertEq(_count(vm.getRecordedLogs(), T_PRIORITY_SET), 1, "a repeated true is recorded");
        assertTrue(_priority(), "still opted in");

        // Opt out: one event; again: one more.
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LenderIntentPrioritySet(lender, mockERC20, mockCollateralERC20, false);
        _setPriority(false);
        vm.recordLogs();
        _setPriority(false);
        assertEq(_count(vm.getRecordedLogs(), T_PRIORITY_SET), 1, "a repeated false is recorded");
        assertFalse(_priority(), "opted out");
    }

    /// @dev Re-writing the intent resets the opt-in (one event); a re-write while it
    ///      is already off records the reset too (one event).
    function test_SetLenderIntent_ResetsTheOptIn() public {
        _setIntent();
        _setPriority(true);
        assertTrue(_priority(), "fixture-live: opted in");

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LenderIntentPrioritySet(lender, mockERC20, mockCollateralERC20, false);
        _setIntent();
        assertFalse(_priority(), "a replacement intent never inherits the opt-in");

        vm.recordLogs();
        _setIntent();
        assertEq(_count(vm.getRecordedLogs(), T_PRIORITY_SET), 1, "every re-write records its reset");
    }

    /// @dev The reset bites on the fill: a re-written intent with credits held is
    ///      refused for capacity until the owner opts in again.
    function test_SetLenderIntent_Reset_StopsTheCreditFromBeingSpent() public {
        _optedInFixture(1);
        uint256 cp = _postBorrower("b-reset");
        _exhaustSolver();
        _setIntent(); // reset
        _expectExhausted();
        _fill(cp);
        assertEq(_credits(), 1, "the reset intent spent nothing");
    }

    /// @dev Cancellation clears the opt-in (one event); opting in on the now-inactive
    ///      intent is refused, opting OUT is allowed (and is recorded).
    function test_Cancel_ClearsTheOptIn_OptOutAlwaysAllowed() public {
        _setIntent();
        _setPriority(true);

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LenderIntentPrioritySet(lender, mockERC20, mockCollateralERC20, false);
        vm.prank(lender);
        _intentFacet().cancelLenderIntent(mockERC20, mockCollateralERC20);
        assertFalse(_priority(), "a cancelled intent carries no opt-in");

        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentNotActive.selector);
        _intentFacet().setLenderIntentPriority(mockERC20, mockCollateralERC20, true);

        vm.recordLogs();
        _setPriority(false); // inactive intent: allowed
        assertEq(_count(vm.getRecordedLogs(), T_PRIORITY_SET), 1, "the opt-out is recorded");

        // Opting out of a pair that never had an intent is allowed too.
        vm.prank(lender);
        _intentFacet().setLenderIntentPriority(mockERC20, address(0xC0FFEE), false);
    }

    // ─── 6. protocol owners refused ─────────────────────────────────────────

    /// @dev Straddle on the adapter mark: the same owner and intent opts in while
    ///      unmarked, and is refused by name once marked an aggregator adapter;
    ///      opting out stays allowed.
    function test_AggregatorAdapterOwner_Refused() public {
        _setIntent();
        _setPriority(true); // unmarked: accepted
        _setPriority(false);

        TestMutatorFacet(address(diamond)).setAggregatorAdapterRaw(lender, address(0));
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.LenderIntentPriorityProtocolOwner.selector, lender));
        _intentFacet().setLenderIntentPriority(mockERC20, mockCollateralERC20, true);
        assertFalse(_priority(), "not opted in");

        _setPriority(false); // opting out is always allowed
    }

    /// @dev The backstop vault is refused by name (before the active-intent check:
    ///      it has no intent here, and the error is the protocol-owner one).
    function test_BackstopVaultOwner_Refused() public {
        vm.startPrank(owner);
        BackstopFacet(address(diamond)).initializeBackstopVaultImplementation();
        address vault = BackstopFacet(address(diamond)).provisionBackstopVault();
        vm.stopPrank();
        assertTrue(vault != address(0), "fixture-live: backstop vault provisioned");

        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.LenderIntentPriorityProtocolOwner.selector, vault));
        _intentFacet().setLenderIntentPriority(mockERC20, mockCollateralERC20, true);

        vm.prank(vault);
        _intentFacet().setLenderIntentPriority(mockERC20, mockCollateralERC20, false); // opt-out allowed
    }

    /// @dev Opting in is Tier-1 sanctions-gated; opting out is not, so a flagged
    ///      owner can always withdraw consent.
    function test_Sanctioned_OptInRefused_OptOutAllowed() public {
        _setIntent();
        _setPriority(true);
        MockSanctionsList m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
        m.setFlagged(lender, true);

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LenderIntentPrioritySet(lender, mockERC20, mockCollateralERC20, false);
        _setPriority(false); // withdraw consent while flagged

        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, lender));
        _intentFacet().setLenderIntentPriority(mockERC20, mockCollateralERC20, true);

        m.setFlagged(lender, false);
        _setPriority(true); // straddle: cleared, accepted
        assertTrue(_priority(), "opted in once unflagged");
    }

    /// @dev Codex #2563 r3 — opting IN is consent-creating and refused while the
    ///      protocol is paused, like `setLenderIntent`; opting OUT is containment and
    ///      stays open during the pause. Straddle: unpaused, the same opt-in lands.
    function test_Paused_OptInRefused_OptOutAllowed() public {
        _setIntent();
        _setPriority(true);
        AdminFacet(address(diamond)).pause();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LenderIntentPrioritySet(lender, mockERC20, mockCollateralERC20, false);
        _setPriority(false); // revoke during the pause

        vm.prank(lender);
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        _intentFacet().setLenderIntentPriority(mockERC20, mockCollateralERC20, true);
        assertFalse(_priority(), "no opt-in written while paused");

        AdminFacet(address(diamond)).unpause();
        _setPriority(true);
        assertTrue(_priority(), "opted in once unpaused");
    }

    // ─── 7. sale guards ─────────────────────────────────────────────────────

    /// @dev Perk 1 is counted-only; another perk id may still be timed.
    function test_SetPerkConfig_PriorityMustBeCounted() public {
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.PerkPriorityMustBeCounted.selector, uint32(3600)));
        _perk().setPerkConfig(PERK, PRICE, 3600);
        _perk().setPerkConfig(2, PRICE, 3600); // another id: accepted
        (, uint32 dur2,) = _perk().getPerkConfig(2);
        assertEq(dur2, 3600, "perk 2 timed");
        _perk().setPerkConfig(PERK, PRICE, 0); // counted: accepted
        (uint256 p1, uint32 dur1,) = _perk().getPerkConfig(PERK);
        assertEq(p1, PRICE, "perk 1 priced");
        assertEq(dur1, 0, "perk 1 counted");
        _perk().setPerkConfig(PERK, 0, 3600); // a DISARM is accepted at any duration
        (p1,,) = _perk().getPerkConfig(PERK);
        assertEq(p1, 0, "perk 1 disarmed");
    }

    /// @dev Codex #2563 r2 — LEGACY state: perk 1 configured and SOLD as a timed
    ///      perk before #2550 (written raw; the current setter refuses it). With
    ///      every other deliverability condition live, a purchase is refused even
    ///      on the exact legacy terms, because the effect reads only credits. The
    ///      stale price can still be taken down on the frozen duration, while
    ///      re-arming it timed stays refused and the mode lock keeps it timed.
    ///      Straddle: the same rig configured COUNTED sells.
    function test_LegacyTimedPerk1_NeverSells_AndCanBeDisarmed() public {
        _lightCurve();
        TestMutatorFacet(address(diamond)).setPerkStateRaw(PERK, PRICE, 3600, 1);
        uint256 vaultBefore = _vaultVpfi(lender);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.PerkNotDeliverable.selector, PERK));
        _perk().purchasePerk(PERK, 1, PRICE, 3600);
        assertEq(_vaultVpfi(lender), vaultBefore, "no VPFI moved on the legacy timed terms");

        _perk().setPerkConfig(PERK, 0, 3600); // disarm on the frozen duration
        (uint256 p1, uint32 dur1, uint256 sold) = _perk().getPerkConfig(PERK);
        assertEq(p1, 0, "disarmed");
        assertEq(dur1, 3600, "mode still frozen");
        assertEq(sold, 1, "sold count untouched");
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.PerkPriorityMustBeCounted.selector, uint32(3600)));
        _perk().setPerkConfig(PERK, PRICE, 3600);

        TestMutatorFacet(address(diamond)).setPerkStateRaw(PERK, 0, 0, 0);
        _perk().setPerkConfig(PERK, PRICE, 0); // the explicit, counted arming write
        _expectPurchaseSucceeds();
    }

    /// @dev Codex #2563 r5 — a priced COUNTED configuration of perk 1 inherited from
    ///      before #2550 does not start selling by itself, even with every live
    ///      condition on: only this version's priced write ARMS the effect (once,
    ///      with an event). Straddle: after that write, the same rig sells.
    function test_LegacyCountedPrice_DoesNotSell_UntilTheArmingWrite() public {
        _lightCurve();
        TestMutatorFacet(address(diamond)).setPerkStateRaw(PERK, PRICE, 0, 0);
        _expectNotDeliverableNoMove();
        (bool armed, bool deliverable, bool counted, bool lit, bool live) = _perk().getPriorityRoutingStatus();
        assertFalse(armed, "status: not armed");
        assertFalse(deliverable, "status: not deliverable");
        assertTrue(counted && lit && live, "status: every OTHER condition holds, so the arming write is what is missing");
        vm.expectEmit(false, false, false, true, address(diamond));
        emit LibPriorityRouting.PriorityRoutingPerkArmed(PRICE);
        _perk().setPerkConfig(PERK, PRICE, 0);
        (armed, deliverable,,,) = _perk().getPriorityRoutingStatus();
        assertTrue(armed && deliverable, "status: armed and deliverable after the arming write");
        _expectPurchaseSucceeds();
        vm.recordLogs();
        _perk().setPerkConfig(PERK, PRICE * 2, 0); // re-pricing: armed once, no second event
        assertEq(vm.getRecordedLogs().length, 1, "only PerkConfigured on a re-price");
    }

    /// @dev Codex #2563 r5 — perk-1 CREDITS sold before the effect existed never
    ///      acquire it: with the intent opted in, the owner holding two legacy
    ///      credits and the solver exhausted, the fill is refused and no credit is
    ///      spent; and the effect cannot be armed while those sold units stand.
    function test_LegacyCredits_NeverCarryAFill_AndBlockArming() public {
        _setIntent();
        _fundIntent(3 * PRINCIPAL);
        _lightCurve();
        _setPriority(true);
        TestMutatorFacet(address(diamond)).setPerkStateRaw(PERK, 0, 0, 2);
        TestMutatorFacet(address(diamond)).setPerkCreditsRaw(lender, PERK, 2);
        uint256 cp = _postBorrower("b-legacy");
        _exhaustSolver();
        _expectExhausted();
        _fill(cp);
        assertEq(_credits(), 2, "no legacy credit spent");
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.PerkPriorityLegacyUnitsSold.selector, uint256(2)));
        _perk().setPerkConfig(PERK, PRICE, 0);
        _perk().setPerkConfig(PERK, 0, 0); // disarming stays available
    }

    function _expectNotDeliverableNoMove() internal {
        uint256 vaultBefore = _vaultVpfi(lender);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.PerkNotDeliverable.selector, PERK));
        _perk().purchasePerk(PERK, 1, PRICE, 0);
        assertEq(_vaultVpfi(lender), vaultBefore, "no VPFI moved on a refused purchase");
        assertEq(_credits(), 0, "no credit granted");
    }

    function _expectPurchaseSucceeds() internal {
        uint256 vaultBefore = _vaultVpfi(lender);
        uint256 creditsBefore = _credits();
        vm.prank(lender);
        _perk().purchasePerk(PERK, 1, PRICE, 0);
        assertEq(vaultBefore - _vaultVpfi(lender), PRICE, "vault debited one price");
        assertEq(_credits(), creditsBefore + 1, "one credit granted");
    }

    /// @dev Straddle on the Solver curve: dark → refused; lit → sold.
    function test_Purchase_Deliverability_SolverCurve() public {
        _perk().setPerkConfig(PERK, PRICE, 0);
        _expectNotDeliverableNoMove();
        _lightCurve();
        _expectPurchaseSucceeds();
    }

    /// @dev A curve CLEARED after arming (a VPFI rotation) closes the sale again.
    function test_Purchase_Deliverability_CurveClearedByRotation() public {
        _perk().setPerkConfig(PERK, PRICE, 0);
        _lightCurve();
        VPFIToken oldToken = vpfi;
        uint256 oldVault = oldToken.balanceOf(VaultFactoryFacet(address(diamond)).getUserVaultAddress(lender));
        VPFITokenFacet(address(diamond)).setVPFIToken(address(_newVpfi()));
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.PerkNotDeliverable.selector, PERK));
        _perk().purchasePerk(PERK, 1, PRICE, 0);
        assertEq(
            oldToken.balanceOf(VaultFactoryFacet(address(diamond)).getUserVaultAddress(lender)), oldVault, "no VPFI moved"
        );
    }

    /// @dev Straddle on `partialFillEnabled`: the other two conditions on.
    function test_Purchase_Deliverability_PartialFill() public {
        _perk().setPerkConfig(PERK, PRICE, 0);
        _lightCurve();
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(false);
        _expectNotDeliverableNoMove();
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        _expectPurchaseSucceeds();
    }

    /// @dev Straddle on `lenderIntentEnabled`: the other two conditions on.
    function test_Purchase_Deliverability_LenderIntentEnabled() public {
        _perk().setPerkConfig(PERK, PRICE, 0);
        _lightCurve();
        vm.prank(owner);
        _intentFacet().setLenderIntentEnabled(false);
        _expectNotDeliverableNoMove();
        vm.prank(owner);
        _intentFacet().setLenderIntentEnabled(true);
        _expectPurchaseSucceeds();
    }

    /// @dev The deliverability gate is perk 1's alone: another counted perk sells
    ///      with the Solver curve dark.
    function test_Purchase_OtherPerkUnaffectedByDeliverability() public {
        _perk().setPerkConfig(2, PRICE, 0);
        uint256 vaultBefore = _vaultVpfi(lender);
        vm.prank(lender);
        _perk().purchasePerk(2, 1, PRICE, 0);
        assertEq(vaultBefore - _vaultVpfi(lender), PRICE, "perk 2 sold while perk 1 is undeliverable");
    }

    // ─── 8. the view agrees with the fill ───────────────────────────────────

    /// @dev One trajectory through the three states of cells 1–3, the view read
    ///      before each fill and the fill's outcome asserted against it.
    /// @dev Codex #2563 r1 — `previewIntent`, the solver's own pre-check that the
    ///      shipped keeper treats a capacity refusal from as pass-terminal, applies
    ///      the SAME capacity-or-credit rule as the fill: with the solver exhausted,
    ///      an opted-in intent whose owner holds a credit previews Ok (and the fill
    ///      then succeeds on the credit); opted out, the same state previews
    ///      CapacityExhausted (and the fill reverts). Ok exactly when the fill succeeds.
    function test_PreviewIntent_AppliesTheCreditRule_LikeTheFill() public {
        _optedInFixture(1);
        uint256 cp = _postBorrower("b-preview");
        LibOfferMatch.IntentPreviewResult memory r = RiskPreviewFacet(address(diamond)).previewIntent(
            solver, solver, lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
        assertTrue(r.ok, "capacity covers: Ok");
        assertFalse(r.spendsPriorityCredit, "covered by capacity: the solver is charged, no credit spent");
        _exhaustSolver();
        r = RiskPreviewFacet(address(diamond)).previewIntent(
            solver, solver, lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
        assertTrue(r.ok, "exhausted + opted in + credit: the preview is Ok");
        assertTrue(r.spendsPriorityCredit, "and it names the credit as what carries the fill");
        _setPriority(false);
        r = RiskPreviewFacet(address(diamond)).previewIntent(
            solver, solver, lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
        assertFalse(r.ok, "opted out: refused");
        assertFalse(r.spendsPriorityCredit, "a refused preview names no credit");
        assertEq(uint8(r.intentError), uint8(LibOfferMatch.IntentError.CapacityExhausted), "for capacity");
        _expectExhausted();
        _fill(cp);
        _setPriority(true);
        r = RiskPreviewFacet(address(diamond)).previewIntent(
            solver, solver, lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
        assertTrue(r.ok, "opted back in: Ok again");
        assertTrue(r.spendsPriorityCredit, "carried by the credit again");
        _fill(cp);
        assertEq(_credits(), 0, "and the fill it previewed spent the credit");
    }

    function test_View_AgreesWithTheFill() public {
        _optedInFixture(1);
        uint256 cp1 = _postBorrower("b-view-1");
        uint256 cp2 = _postBorrower("b-view-2");
        uint256 cp3 = _postBorrower("b-view-3");

        // Covered: charged to the solver, credit kept.
        _assertView(true, 1, true, false, "covered");
        _fill(cp1);
        assertEq(_credits(), 1, "covered: credit kept");

        // Exhausted + opted in + credit: the credit unlocks the fill.
        _assertView(true, 1, false, true, "exhausted + credit");
        _fill(cp2);
        assertEq(_credits(), 0, "unlocked: credit spent");

        // Exhausted + 0 credits: refused.
        _assertView(true, 0, false, false, "exhausted + 0 credits");
        _expectExhausted();
        _fill(cp3);

        // Credits held but opted out: the view says no unlock, and so does the fill.
        _buyCredits(1);
        _setPriority(false);
        _assertView(false, 1, false, false, "credit, not opted in");
        _expectExhausted();
        _fill(cp3);
    }
}
