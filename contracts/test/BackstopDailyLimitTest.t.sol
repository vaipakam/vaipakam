// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibTestVaultBeacon} from "./helpers/LibTestVaultBeacon.sol";
import {LibTestCalmPair} from "./helpers/LibTestCalmPair.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibBackstopDailyLimit} from "../src/libraries/LibBackstopDailyLimit.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {IntentPreviewFacet} from "../src/facets/IntentPreviewFacet.sol";
import {VaipakamTimelock} from "../src/governance/VaipakamTimelock.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  BackstopDailyLimitTest
 * @notice #3849 — the backstop (Role A) lends at most a governed share of its
 *         lending capital in an asset per UTC day: the running total, the
 *         refusal with its three figures, the day reset, the opt-in refusal,
 *         the capital following a seed / withdrawal / repayment, two pairs of
 *         one asset sharing one total, the setting's bounds and its delay, the
 *         fill switch, and the view.
 * @dev    Same posture as `BackstopVaultTest`: $1 mocks, the backstop slot on
 *         (mockERC20, mockCollateralERC20), seeded with {SEED}. At the default
 *         2,000 bps the day's limit is SEED / 5.
 */
contract BackstopDailyLimitTest is SetupTest {
    address internal vault;
    address internal coll2;

    uint256 internal constant SEED = 10_000 ether;
    uint256 internal constant PRINCIPAL = 500 ether;
    uint256 internal constant MAX_EXPOSURE = 100_000 ether;
    uint256 internal constant MIN_RATE = 500;
    uint16 internal constant MAX_LTV = 5000;
    uint32 internal constant MAX_DUR = 30;
    uint256 internal constant MIN_FILL = 100 ether;

    uint64 internal base;
    uint256 internal borrowerCount;

    event BackstopDailyLimitBpsSet(uint16 limitBps);

    function setUp() public {
        setupHelper();
        base = uint64(1_000_000);
        vm.warp(base);

        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);
        BackstopFacet(address(diamond)).initializeBackstopVaultImplementation();
        vault = BackstopFacet(address(diamond)).provisionBackstopVault();
        LibTestVaultBeacon.sync(address(diamond));
        BackstopFacet(address(diamond)).setBackstopIntent(
            mockERC20, mockCollateralERC20, MAX_EXPOSURE, MIN_RATE, MAX_LTV, MAX_DUR, MIN_FILL
        );
        BackstopFacet(address(diamond)).setBackstopEnabled(true);
        BackstopFacet(address(diamond)).setBackstopFillEnabled(true);
        vm.stopPrank();

        _seed(mockCollateralERC20, SEED);
    }

    // ─── helpers ────────────────────────────────────────────────────────────

    function _seed(address coll, uint256 amount) internal {
        ERC20Mock(mockERC20).mint(address(diamond), amount);
        vm.startPrank(owner);
        uint256 bal = TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20);
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, bal + amount);
        BackstopFacet(address(diamond)).seedBackstopOrigination(mockERC20, coll, amount);
        vm.stopPrank();
    }

    function _figures()
        internal
        view
        returns (uint256 limit, uint256 used, uint256 room, uint64 dayEnd, uint256 capital, uint16 bps)
    {
        return BackstopFacet(address(diamond)).getBackstopDailyLimit(mockERC20);
    }

    function _newBorrower() internal returns (address b) {
        b = makeAddr(string(abi.encodePacked("dlBorrower", vm.toString(++borrowerCount))));
        ERC20Mock(mockERC20).mint(b, 1_000_000 ether);
        ERC20Mock(mockCollateralERC20).mint(b, 1_000_000 ether);
        if (coll2 != address(0)) ERC20Mock(coll2).mint(b, 1_000_000 ether);
        vm.startPrank(b);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        if (coll2 != address(0)) ERC20(coll2).approve(address(diamond), type(uint256).max);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.stopPrank();
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(b, LibVaipakam.KYCTier.Tier2);
    }

    function _postOffer(address coll, uint256 amount, uint64 expiresAt)
        internal
        returns (uint256 offerId, address b)
    {
        b = _newBorrower();
        vm.prank(b);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                integrator: address(0),
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: amount,
                interestRateBps: MIN_RATE,
                collateralAsset: coll,
                collateralAmount: 2 * amount,
                durationDays: MAX_DUR,
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
                amountMax: amount,
                interestRateBpsMax: MIN_RATE + 100,
                collateralAmountMax: 2 * amount,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: expiresAt,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true,
                linkKind: 0,
                linkMarginBps: 0,
                rateFarFromAverageAcknowledged: false
            }),
            type(uint64).max
        );
    }

    /// @dev Post and opt in `n` offers of `amount` on `coll`, eligible from
    ///      `vm.getBlockTimestamp() + 1 day`, expiring in 10 days.
    function _optedIn(address coll, uint256 amount, uint256 n) internal returns (uint256[] memory ids) {
        ids = new uint256[](n);
        uint64 eligibleAfter = uint64(vm.getBlockTimestamp() + 1 days);
        for (uint256 i; i < n; ++i) {
            address b;
            (ids[i], b) = _postOffer(coll, amount, uint64(vm.getBlockTimestamp() + 10 days));
            vm.prank(b);
            BackstopFacet(address(diamond)).setOfferBackstopEligible(ids[i], eligibleAfter);
        }
    }

    /// @dev Move past the opt-in deadline and lay the calm-price checkpoints.
    function _ready(address coll) internal {
        vm.warp(vm.getBlockTimestamp() + 1 days);
        LibTestCalmPair.checkpoint(address(diamond), coll, mockERC20);
    }

    function _fill(uint256 offerId) internal returns (uint256) {
        vm.prank(makeAddr("poker"));
        return BackstopFacet(address(diamond)).backstopFill(offerId);
    }

    function _setBps(uint16 bps) internal {
        vm.prank(owner);
        BackstopFacet(address(diamond)).setBackstopDailyLimitBps(bps);
    }

    // ─── the view, the default and the running total ──────────────────────

    function test_view_defaultsToOneFifthOfCapital() public view {
        (uint256 limit, uint256 used, uint256 room, uint64 dayEnd, uint256 capital, uint16 bps) = _figures();
        assertEq(bps, 2000, "unset reads as the default, never as no limit");
        assertEq(capital, SEED, "capital = the seeded, waiting capital");
        assertEq(limit, SEED / 5, "limit = one fifth");
        assertEq(used, 0);
        assertEq(room, limit);
        assertEq(dayEnd, (vm.getBlockTimestamp() / 1 days + 1) * 1 days, "day ends at the next UTC midnight");
    }

    function test_fillInsideLimit_countsAndKeepsCapital() public {
        uint256[] memory ids = _optedIn(mockCollateralERC20, PRINCIPAL, 1);
        _ready(mockCollateralERC20);
        uint256 loanId = _fill(ids[0]);
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).lender, vault);
        (uint256 limit, uint256 used, uint256 room,, uint256 capital,) = _figures();
        assertEq(capital, SEED, "a fill moves capital from waiting to out: the sum is unchanged");
        assertEq(limit, SEED / 5, "so the day's limit is unchanged by the fill");
        assertEq(used, PRINCIPAL, "the fill is counted");
        assertEq(room, limit - PRINCIPAL, "room = limit - used");
    }

    function test_fillOverLimit_isRefusedWithTheThreeFigures() public {
        _setBps(500); // limit = 500 = one offer
        uint256[] memory ids = _optedIn(mockCollateralERC20, PRINCIPAL, 2);
        _ready(mockCollateralERC20);
        _fill(ids[0]);
        (uint256 limit, uint256 used,, uint64 dayEnd,,) = _figures();
        assertEq(limit, PRINCIPAL);
        assertEq(used, PRINCIPAL);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibBackstopDailyLimit.BackstopDailyLimitExceeded.selector,
                mockERC20,
                PRINCIPAL,
                limit,
                used,
                dayEnd
            )
        );
        _fill(ids[1]);
    }

    /// @dev Codex #3842 — the intent preview reports the limit, so an Ok
    ///      preview is never a backstop fill the limit refuses.
    function test_previewIntent_reportsTheDailyLimit() public {
        _setBps(500); // limit = 500 = one offer
        uint256[] memory ids = _optedIn(mockCollateralERC20, PRINCIPAL, 2);
        _ready(mockCollateralERC20);
        LibOfferMatch.IntentPreviewResult memory r = IntentPreviewFacet(address(diamond)).previewIntent(
            vault, makeAddr("fresh-1"), vault, mockERC20, mockCollateralERC20,
            LibVaipakam.PROTOCOL_INTENT_SLOT, ids[1], PRINCIPAL
        );
        assertTrue(r.ok, "room left: the preview clears");
        _fill(ids[0]);
        r = IntentPreviewFacet(address(diamond)).previewIntent(
            vault, makeAddr("fresh-2"), vault, mockERC20, mockCollateralERC20,
            LibVaipakam.PROTOCOL_INTENT_SLOT, ids[1], PRINCIPAL
        );
        assertFalse(r.ok, "day spent: the preview refuses");
        assertEq(uint8(r.intentError), uint8(LibOfferMatch.IntentError.BackstopDailyLimit));
        assertFalse(r.spendsPriorityCredit);
    }

    function test_totalResetsWithTheUtcDay() public {
        _setBps(500);
        uint256[] memory ids = _optedIn(mockCollateralERC20, PRINCIPAL, 2);
        _ready(mockCollateralERC20);
        _fill(ids[0]);
        (,,, uint64 dayEnd,,) = _figures();
        vm.warp(dayEnd);
        (, uint256 used, uint256 room,,,) = _figures();
        assertEq(used, 0, "a new day starts at zero");
        assertEq(room, PRINCIPAL);
        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
        _fill(ids[1]);
        (, used,,,,) = _figures();
        assertEq(used, PRINCIPAL);
    }

    /// @dev The stated limit of the rule: a stretch across midnight can use two
    ///      days' limits, never more than one per day.
    function test_twoFillsAcrossMidnight() public {
        _setBps(500);
        uint256[] memory ids = _optedIn(mockCollateralERC20, PRINCIPAL, 3);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        (,,, uint64 dayEnd,,) = _figures();
        // Lay the checkpoints so the first fill lands one hour before midnight.
        vm.warp(dayEnd - 4 hours);
        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
        assertLt(vm.getBlockTimestamp(), dayEnd, "still the first day");
        _fill(ids[0]);
        vm.warp(dayEnd);
        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
        assertLt(vm.getBlockTimestamp(), uint256(dayEnd) + 1 days, "the second day");
        _fill(ids[1]); // the next day's room
        (, uint256 used,, uint64 dayEnd2,,) = _figures();
        assertEq(used, PRINCIPAL);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibBackstopDailyLimit.BackstopDailyLimitExceeded.selector,
                mockERC20,
                PRINCIPAL,
                PRINCIPAL,
                PRINCIPAL,
                dayEnd2
            )
        );
        _fill(ids[2]);
    }

    // ─── an offer larger than the limit ────────────────────────────────────

    function test_offerAboveLimit_isRefusedAtOptIn() public {
        _setBps(500); // limit = 500
        (uint256 offerId, address b) = _postOffer(mockCollateralERC20, PRINCIPAL + 1 ether, uint64(vm.getBlockTimestamp() + 10 days));
        vm.prank(b);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibBackstopDailyLimit.BackstopOfferAboveDailyLimit.selector,
                mockERC20,
                PRINCIPAL + 1 ether,
                PRINCIPAL
            )
        );
        BackstopFacet(address(diamond)).setOfferBackstopEligible(offerId, uint64(vm.getBlockTimestamp() + 1 days));
    }

    function test_offerAboveLimit_isRefusedAtFill() public {
        uint256[] memory ids = _optedIn(mockCollateralERC20, PRINCIPAL, 1); // admitted at 2,000 bps
        _setBps(500);
        // Return 1,000 to treasury: capital 9,000, limit 450 < the offer.
        vm.prank(owner);
        BackstopFacet(address(diamond)).withdrawBackstopToTreasury(mockERC20, mockCollateralERC20, 1_000 ether);
        _ready(mockCollateralERC20);
        (uint256 limit,,, uint64 dayEnd,,) = _figures();
        assertEq(limit, 450 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibBackstopDailyLimit.BackstopDailyLimitExceeded.selector, mockERC20, PRINCIPAL, limit, 0, dayEnd
            )
        );
        _fill(ids[0]);
    }

    // ─── the limit follows the capital ─────────────────────────────────────

    function test_limitFollowsSeedWithdrawalAndRepayment() public {
        _seed(mockCollateralERC20, 1_000 ether);
        (uint256 limit,,,, uint256 capital,) = _figures();
        assertEq(capital, SEED + 1_000 ether, "a seed raises the capital");
        assertEq(limit, (SEED + 1_000 ether) / 5);

        vm.prank(owner);
        BackstopFacet(address(diamond)).withdrawBackstopToTreasury(mockERC20, mockCollateralERC20, 2_000 ether);
        (limit,,,, capital,) = _figures();
        assertEq(capital, SEED - 1_000 ether, "a withdrawal to treasury lowers it");
        assertEq(limit, (SEED - 1_000 ether) / 5);

        uint256[] memory ids = _optedIn(mockCollateralERC20, PRINCIPAL, 1);
        _ready(mockCollateralERC20);
        uint256 loanId = _fill(ids[0]);
        (,,,, capital,) = _figures();
        assertEq(capital, SEED - 1_000 ether, "the fill leaves it unchanged");

        address b = LoanFacet(address(diamond)).getLoanDetails(loanId).borrower;
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);
        (limit,,,, capital,) = _figures();
        assertEq(capital, SEED - 1_000 ether - PRINCIPAL, "a repaid loan's principal is no longer out");
        assertEq(limit, (SEED - 1_000 ether - PRINCIPAL) / 5);
    }

    // ─── two pairs of one asset ────────────────────────────────────────────

    function test_twoPairsOfOneAsset_shareOneTotal() public {
        coll2 = address(new ERC20Mock("MockCollateral2", "MC2", 18));
        mockOracleLiquidity(coll2, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(coll2, 1e8, 8);
        // The Diamond's own price read too (the calm-price checkpoints read it).
        vm.mockCall(
            address(diamond), abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, coll2), abi.encode(1e8, uint8(8))
        );
        vm.startPrank(owner);
        RiskFacet(address(diamond)).updateRiskParams(coll2, 8000, 300);
        BackstopFacet(address(diamond)).setBackstopIntent(
            mockERC20, coll2, MAX_EXPOSURE, MIN_RATE, MAX_LTV, MAX_DUR, MIN_FILL
        );
        vm.stopPrank();
        _seed(coll2, SEED);
        (uint256 limit,,,, uint256 capital,) = _figures();
        assertEq(capital, 2 * SEED, "both pairs' capital counts");
        assertEq(limit, 2 * SEED / 5);

        _setBps(500); // limit = 1,000 = two offers across both pairs
        uint256[] memory a = _optedIn(mockCollateralERC20, PRINCIPAL, 2);
        uint256[] memory c = _optedIn(coll2, PRINCIPAL, 1);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _checkpointBoth(); // both pairs' calm-price checkpoints in one pass
        _fill(a[0]);
        _fill(c[0]);
        (, uint256 used, uint256 room, uint64 dayEnd,,) = _figures();
        assertEq(used, 2 * PRINCIPAL, "the two pairs' fills share one total");
        assertEq(room, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibBackstopDailyLimit.BackstopDailyLimitExceeded.selector,
                mockERC20,
                PRINCIPAL,
                2 * PRINCIPAL,
                2 * PRINCIPAL,
                dayEnd
            )
        );
        _fill(a[1]);
    }

    function _checkpointBoth() internal {
        address[] memory assets = new address[](3);
        assets[0] = mockCollateralERC20;
        assets[1] = coll2;
        assets[2] = mockERC20;
        vm.warp(((vm.getBlockTimestamp() / 1 hours) + 1) * 1 hours);
        _checkpoint(assets);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _checkpoint(assets);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
    }

    function _checkpoint(address[] memory assets) internal {
        (bool ok,) = address(diamond).call(abi.encodeWithSignature("checkpointHourlyPrices(address[])", assets));
        assertTrue(ok, "checkpoint");
    }

    // ─── the setting: bounds, role, delay ──────────────────────────────────

    function test_setting_boundsAndEvent() public {
        uint16[4] memory bad = [uint16(0), 499, 5001, type(uint16).max];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(abi.encodeWithSelector(BackstopFacet.BackstopDailyLimitOutOfRange.selector, bad[i]));
            BackstopFacet(address(diamond)).setBackstopDailyLimitBps(bad[i]);
        }
        vm.expectEmit(address(diamond));
        emit BackstopDailyLimitBpsSet(500);
        _setBps(500);
        _setBps(5000);
        (uint256 limit,,,,, uint16 bps) = _figures();
        assertEq(bps, 5000);
        assertEq(limit, SEED / 2);
    }

    function test_setting_notVaultAdmin_reverts() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        BackstopFacet(address(diamond)).setBackstopDailyLimitBps(1000);
    }

    /// @dev The setting is held by VAULT_ADMIN, which the handover gives the
    ///      governance timelock: once it does, a change waits out the delay.
    function test_setting_takesTheGovernanceDelay() public {
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        address[] memory cancellers = new address[](1);
        cancellers[0] = owner;
        VaipakamTimelock tl = new VaipakamTimelock(2 days, proposers, executors, cancellers);
        vm.startPrank(owner);
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.VAULT_ADMIN_ROLE, address(tl));
        AccessControlFacet(address(diamond)).revokeRole(LibAccessControl.VAULT_ADMIN_ROLE, owner);
        vm.expectRevert();
        BackstopFacet(address(diamond)).setBackstopDailyLimitBps(1000); // no direct path left
        bytes memory data = abi.encodeCall(BackstopFacet.setBackstopDailyLimitBps, (1000));
        tl.schedule(address(diamond), 0, data, bytes32(0), bytes32(0), 2 days);
        vm.expectRevert();
        tl.execute(address(diamond), 0, data, bytes32(0), bytes32(0)); // before the delay
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 2 days);
        tl.execute(address(diamond), 0, data, bytes32(0), bytes32(0));
        (,,,,, uint16 bps) = _figures();
        assertEq(bps, 1000, "applied after the delay");
    }

    // ─── the fill switch still stops everything ────────────────────────────

    function test_fillSwitch_stopsFillsWithRoomLeft() public {
        uint256[] memory ids = _optedIn(mockCollateralERC20, PRINCIPAL, 1);
        _ready(mockCollateralERC20);
        vm.prank(owner);
        BackstopFacet(address(diamond)).setBackstopFillEnabled(false);
        (,, uint256 room,,,) = _figures();
        assertGt(room, PRINCIPAL, "room is left");
        vm.expectRevert(BackstopFacet.BackstopDisabled.selector);
        _fill(ids[0]);
    }
}
