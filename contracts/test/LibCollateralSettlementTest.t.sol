// test/LibCollateralSettlementTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SetupComposable} from "./composable/SetupComposable.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/// @title LibCollateralSettlementTest
/// @notice Unit tests for the closed-form floor formula library
///         (`LibCollateralSettlement`) introduced as T-086 step 3 of
///         `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md`.
///
///         The library provides three view helpers:
///
///           - `principalPlusAccruedInterest(loanId, asOfTimestamp)`
///           - `treasuryAndPrecloseFee(loanId, asOfTimestamp)`
///           - `liveFloor(loanId, asOfTimestamp)` (sum of the above)
///
///         These map 1:1 to the three Seaport consideration items the
///         step-5 executor will sign + the zone callback will re-verify
///         at fill time. The accrued-interest math uses the same
///         `LibEntitlement.accruedInterestToTime` path RepayFacet +
///         PrecloseFacet already use, so a Seaport prepay-listing close
///         can never disagree with a parallel proper close on the same
///         loan.
///
/// @dev    The library is `view`, not `pure`: it reads `loan.principal`
///         + `loan.startTime` + `loan.interestRateBps` from
///         `LibVaipakam`'s storage slot, and `cfgTreasuryFeeBps()` from
///         `ProtocolConfig`. The tests therefore scaffold loans through
///         `TestMutatorFacet.setLoan` and exercise the library via the
///         three view proxies (`getLiveFloor` etc) cut into the test
///         diamond — same pattern existing library tests use.
contract LibCollateralSettlementTest is Test {

    // ── Stage 6 composition migration (2026-05-27) ──────────────────────
    // Inherit only forge-std `Test`; the Diamond + facet routing + state
    // are owned by a `SetupComposable` instance the test composes via
    // `setUp`. Common SetupTest fields are mirrored locally below so the
    // bulk of test-body code keeps compiling unchanged.
    SetupComposable internal helpers;
    VaipakamDiamond internal diamond;
    address internal owner;
    address internal lender;
    address internal borrower;
    address internal mockERC20;
    address internal mockCollateralERC20;
    address internal mockIlliquidERC20;
    address internal mockNft721;
    address internal mockZeroExProxy;
    uint256 internal constant BASIS_POINTS = 10_000;
    uint256 internal constant KYC_THRESHOLD_USD = 2000 * 1e18;
    uint256 internal constant RENTAL_BUFFER_BPS = 500;
    uint256 internal constant MIN_HEALTH_FACTOR = 150 * 1e16;
    uint256 internal constant TEST_LOAN_ID = 7_701;
    uint256 internal constant ONE_DAY = 1 days;
    uint256 internal constant LCS_DAYS_PER_YEAR = 365;
    // `BASIS_POINTS` (10_000) is already declared on the inherited
    // {SetupTest} contract. Reusing the inherited constant directly
    // below; re-declaring it locally would collide (Solidity 9097).

    uint256 internal constant PRINCIPAL = 100_000e18;
    uint256 internal constant RATE_BPS = 1_200; // 12% APR
    uint256 internal constant DURATION_DAYS = 30;
    uint256 internal constant DEFAULT_TREASURY_FEE_BPS = 100; // protocol default (1%)

    address internal _lender;
    address internal _borrower;

    function setUp() public {
        helpers = new SetupComposable();
        helpers.bootstrap(address(this));
        diamond = helpers.diamond();
        owner = helpers.owner();
        lender = helpers.lender();
        borrower = helpers.borrower();
        mockERC20 = helpers.mockERC20();
        mockCollateralERC20 = helpers.mockCollateralERC20();
        mockIlliquidERC20 = helpers.mockIlliquidERC20();
        mockNft721 = helpers.mockNft721();
        mockZeroExProxy = helpers.mockZeroExProxy();
        _lender = makeAddr("lcSettlement_lender");
        _borrower = makeAddr("lcSettlement_borrower");
        _scaffoldLoan({
            id: TEST_LOAN_ID,
            principal: PRINCIPAL,
            rateBps: RATE_BPS,
            startTime: block.timestamp,
            durationDays: DURATION_DAYS
        });
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _scaffoldLoan(
        uint256 id,
        uint256 principal,
        uint256 rateBps,
        uint256 startTime,
        uint256 durationDays
    ) internal {
        _scaffoldLoanFull({
            id: id,
            principal: principal,
            rateBps: rateBps,
            startTime: startTime,
            durationDays: durationDays,
            useFullTermInterest: false
        });
    }

    function _scaffoldLoanFull(
        uint256 id,
        uint256 principal,
        uint256 rateBps,
        uint256 startTime,
        uint256 durationDays,
        bool useFullTermInterest
    ) internal {
        LibVaipakam.Loan memory loan;
        loan.lender = _lender;
        loan.borrower = _borrower;
        loan.principal = principal;
        loan.interestRateBps = rateBps;
        loan.startTime = uint64(startTime);
        loan.durationDays = durationDays;
        loan.status = LibVaipakam.LoanStatus.Active;
        loan.useFullTermInterest = useFullTermInterest;
        TestMutatorFacet(address(diamond)).setLoan(id, loan);
    }

    function _expectedAccrued(uint256 principal, uint256 rateBps, uint256 elapsedDays)
        internal
        pure
        returns (uint256)
    {
        return (principal * rateBps * elapsedDays) / (LCS_DAYS_PER_YEAR * BASIS_POINTS);
    }

    // ─── 1. Day-zero: no accrued interest yet ───────────────────────────

    function test_liveFloor_atStartTime_returnsPrincipalOnly() public view {
        uint256 floor = TestMutatorFacet(address(diamond)).getLiveFloor(
            TEST_LOAN_ID, block.timestamp
        );
        assertEq(floor, PRINCIPAL, "floor at t=startTime is just principal");

        uint256 principalLeg = TestMutatorFacet(address(diamond))
            .getPrincipalPlusAccruedInterest(TEST_LOAN_ID, block.timestamp);
        assertEq(principalLeg, PRINCIPAL, "lender leg is principal alone");

        uint256 feeLeg = TestMutatorFacet(address(diamond)).getTreasuryAndPrecloseFee(
            TEST_LOAN_ID, block.timestamp
        );
        assertEq(feeLeg, 0, "treasury+preclose fee zero when accrued=0");
    }

    function test_liveFloor_beforeStartTime_returnsPrincipalOnly() public view {
        // Defensive: if a hypothetical fill timestamp predates the loan's
        // startTime, `accruedInterestToTime` returns 0; floor collapses to
        // principal. This case can't happen in production (Seaport
        // `startTime` is at-or-after sign which is at-or-after loan init)
        // but the library's pure-math behaviour must still be sensible.
        uint256 floor = TestMutatorFacet(address(diamond)).getLiveFloor(
            TEST_LOAN_ID, block.timestamp - 1
        );
        assertEq(floor, PRINCIPAL);
    }

    // ─── 2. Interest accrual over time ──────────────────────────────────

    function test_liveFloor_after10DaysAtDefaultTreasuryFee() public {
        uint256 start = block.timestamp;
        vm.warp(start + 10 * ONE_DAY);

        uint256 accrued = _expectedAccrued(PRINCIPAL, RATE_BPS, 10);
        // sanity check on the hand-computed expected value:
        // 100_000e18 * 1200 * 10 / (365 * 10000) ≈ 328.767e18
        assertGt(accrued, 328e18);
        assertLt(accrued, 329e18);

        uint256 expectedPrincipalLeg = PRINCIPAL + accrued;
        uint256 expectedFeeLeg = (accrued * DEFAULT_TREASURY_FEE_BPS) / BASIS_POINTS;
        uint256 expectedFloor = expectedPrincipalLeg + expectedFeeLeg;

        assertEq(
            TestMutatorFacet(address(diamond)).getPrincipalPlusAccruedInterest(
                TEST_LOAN_ID, block.timestamp
            ),
            expectedPrincipalLeg,
            "lender leg = principal + accrued"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getTreasuryAndPrecloseFee(
                TEST_LOAN_ID, block.timestamp
            ),
            expectedFeeLeg,
            "treasury+preclose leg = accrued * 100bps / 10000"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLiveFloor(
                TEST_LOAN_ID, block.timestamp
            ),
            expectedFloor,
            "liveFloor = principalLeg + feeLeg"
        );
    }

    // ─── 3. Sub-day elapsed rounds down to zero ─────────────────────────

    function test_liveFloor_subDayElapsed_doesNotAccrueYet() public {
        // 23 hours, 59 minutes after start — accrual is per whole-day,
        // rounded down. Floor must still be principal exactly.
        vm.warp(block.timestamp + 23 hours + 59 minutes);
        uint256 floor = TestMutatorFacet(address(diamond)).getLiveFloor(
            TEST_LOAN_ID, block.timestamp
        );
        assertEq(floor, PRINCIPAL, "sub-day elapsed rounds to 0 accrued interest");
    }

    // ─── 4. Monotonicity: floor never decreases as time advances ────────

    function test_liveFloor_isMonotonicNonDecreasing() public {
        uint256[] memory checkpoints = new uint256[](6);
        checkpoints[0] = block.timestamp;
        checkpoints[1] = block.timestamp + 1 * ONE_DAY;
        checkpoints[2] = block.timestamp + 7 * ONE_DAY;
        checkpoints[3] = block.timestamp + 15 * ONE_DAY;
        checkpoints[4] = block.timestamp + 29 * ONE_DAY;
        checkpoints[5] = block.timestamp + 30 * ONE_DAY;

        uint256 prev = 0;
        for (uint256 i = 0; i < checkpoints.length; i++) {
            uint256 floor = TestMutatorFacet(address(diamond)).getLiveFloor(
                TEST_LOAN_ID, checkpoints[i]
            );
            assertGe(floor, prev, "floor must not decrease as time advances");
            prev = floor;
        }
    }

    // ─── 5. Treasury fee BPS override flows through ─────────────────────

    function test_liveFloor_respectsAdminConfiguredTreasuryFee() public {
        // Push treasury fee up to 5% (500 bps).
        TestMutatorFacet(address(diamond)).setTreasuryFeeBpsRaw(500);

        uint256 start = block.timestamp;
        vm.warp(start + 30 * ONE_DAY); // full term

        uint256 accrued = _expectedAccrued(PRINCIPAL, RATE_BPS, 30);
        uint256 expectedFeeLeg = (accrued * 500) / BASIS_POINTS;
        uint256 expectedFloor = PRINCIPAL + accrued + expectedFeeLeg;

        assertEq(
            TestMutatorFacet(address(diamond)).getTreasuryAndPrecloseFee(
                TEST_LOAN_ID, block.timestamp
            ),
            expectedFeeLeg,
            "fee leg picks up the 500bps override"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLiveFloor(
                TEST_LOAN_ID, block.timestamp
            ),
            expectedFloor
        );
    }

    function test_liveFloor_zeroTreasuryFeeFallsBackToConstantDefault() public {
        // A stored value of 0 means "fall back to the constant default"
        // per the `cfgTreasuryFeeBps` getter contract — the library MUST
        // route through that getter, not read the raw slot. Setting the
        // raw slot to 0 should leave the floor at the DEFAULT (1%), NOT
        // at zero-fee.
        TestMutatorFacet(address(diamond)).setTreasuryFeeBpsRaw(0);

        vm.warp(block.timestamp + 30 * ONE_DAY);
        uint256 accrued = _expectedAccrued(PRINCIPAL, RATE_BPS, 30);
        uint256 expectedFeeLeg = (accrued * DEFAULT_TREASURY_FEE_BPS) / BASIS_POINTS;

        assertEq(
            TestMutatorFacet(address(diamond)).getTreasuryAndPrecloseFee(
                TEST_LOAN_ID, block.timestamp
            ),
            expectedFeeLeg,
            "raw-slot-zero falls back to constant default (1%)"
        );
    }

    // ─── 6. Zero-principal + zero-rate edge cases ───────────────────────

    function test_liveFloor_zeroPrincipalReturnsZero() public {
        _scaffoldLoan({
            id: TEST_LOAN_ID + 1,
            principal: 0,
            rateBps: RATE_BPS,
            startTime: block.timestamp,
            durationDays: DURATION_DAYS
        });

        vm.warp(block.timestamp + 30 * ONE_DAY);
        assertEq(
            TestMutatorFacet(address(diamond)).getLiveFloor(
                TEST_LOAN_ID + 1, block.timestamp
            ),
            0,
            "zero principal collapses every leg to 0"
        );
    }

    function test_liveFloor_zeroRateAccruesNothing() public {
        _scaffoldLoan({
            id: TEST_LOAN_ID + 2,
            principal: PRINCIPAL,
            rateBps: 0,
            startTime: block.timestamp,
            durationDays: DURATION_DAYS
        });

        vm.warp(block.timestamp + 30 * ONE_DAY);
        uint256 floor = TestMutatorFacet(address(diamond)).getLiveFloor(
            TEST_LOAN_ID + 2, block.timestamp
        );
        assertEq(floor, PRINCIPAL, "rateBps=0 keeps floor at principal forever");
    }

    // ─── 7. Cross-loan isolation ───────────────────────────────────────

    function test_liveFloor_loansAreIndependent() public {
        // Loan B with double the principal and same rate — its floor at
        // T+30d should be exactly 2× loan A's floor (linear in principal).
        _scaffoldLoan({
            id: TEST_LOAN_ID + 3,
            principal: PRINCIPAL * 2,
            rateBps: RATE_BPS,
            startTime: block.timestamp,
            durationDays: DURATION_DAYS
        });

        vm.warp(block.timestamp + 30 * ONE_DAY);

        uint256 floorA = TestMutatorFacet(address(diamond)).getLiveFloor(
            TEST_LOAN_ID, block.timestamp
        );
        uint256 floorB = TestMutatorFacet(address(diamond)).getLiveFloor(
            TEST_LOAN_ID + 3, block.timestamp
        );
        assertEq(floorB, floorA * 2, "floor scales linearly with principal");
    }

    // ─── 8. useFullTermInterest branch (Codex P1) ───────────────────────

    /// @notice On loans created with `useFullTermInterest == true`, the
    ///         lender is owed the FULL promised coupon regardless of how
    ///         early a Seaport prepay sale closes the loan. The floor
    ///         therefore prices off `fullTermInterest`, not pro-rata
    ///         accrual — otherwise a buyer at T+1day could close the loan
    ///         paying only `principal + 1d_accrued + fee` and skip the
    ///         lender's contracted-but-not-yet-accrued interest.
    function test_liveFloor_useFullTermInterest_atDayZero() public {
        _scaffoldLoanFull({
            id: TEST_LOAN_ID + 4,
            principal: PRINCIPAL,
            rateBps: RATE_BPS,
            startTime: block.timestamp,
            durationDays: DURATION_DAYS,
            useFullTermInterest: true
        });

        uint256 expectedFullTerm = _expectedAccrued(
            PRINCIPAL, RATE_BPS, DURATION_DAYS
        );
        uint256 expectedFeeLeg = (expectedFullTerm * DEFAULT_TREASURY_FEE_BPS) / BASIS_POINTS;
        uint256 expectedFloor = PRINCIPAL + expectedFullTerm + expectedFeeLeg;

        // At day zero, a `useFullTermInterest` loan ALREADY owes the
        // full coupon. Pro-rata would say 0.
        assertEq(
            TestMutatorFacet(address(diamond)).getPrincipalPlusAccruedInterest(
                TEST_LOAN_ID + 4, block.timestamp
            ),
            PRINCIPAL + expectedFullTerm,
            "lender leg = principal + full-term interest, even at t=startTime"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getTreasuryAndPrecloseFee(
                TEST_LOAN_ID + 4, block.timestamp
            ),
            expectedFeeLeg,
            "fee leg cuts from the full-term interest, not pro-rata"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLiveFloor(
                TEST_LOAN_ID + 4, block.timestamp
            ),
            expectedFloor,
            "liveFloor honors useFullTermInterest at day zero"
        );
    }

    /// @notice `useFullTermInterest` keeps the floor constant for the
    ///         loan's lifetime — neither lender nor treasury leg moves
    ///         with elapsed time. (Compare to the pro-rata path where
    ///         accrued grows daily.)
    function test_liveFloor_useFullTermInterest_constantOverTerm() public {
        _scaffoldLoanFull({
            id: TEST_LOAN_ID + 5,
            principal: PRINCIPAL,
            rateBps: RATE_BPS,
            startTime: block.timestamp,
            durationDays: DURATION_DAYS,
            useFullTermInterest: true
        });

        uint256 floorAtStart = TestMutatorFacet(address(diamond)).getLiveFloor(
            TEST_LOAN_ID + 5, block.timestamp
        );

        vm.warp(block.timestamp + 15 * ONE_DAY);
        uint256 floorMidTerm = TestMutatorFacet(address(diamond)).getLiveFloor(
            TEST_LOAN_ID + 5, block.timestamp
        );

        vm.warp(block.timestamp + 15 * ONE_DAY); // now at T+30d (full term)
        uint256 floorAtMaturity = TestMutatorFacet(address(diamond)).getLiveFloor(
            TEST_LOAN_ID + 5, block.timestamp
        );

        assertEq(floorAtStart, floorMidTerm, "full-term floor stays flat mid-term");
        assertEq(floorMidTerm, floorAtMaturity, "full-term floor stays flat at maturity");
        assertGt(floorAtStart, PRINCIPAL, "but it's above principal (the lender's coupon is baked in)");
    }

    /// @notice Cross-check: at the loan's natural maturity (`T+durationDays`),
    ///         a pro-rata loan's floor equals a parallel
    ///         `useFullTermInterest` loan's floor (the full coupon
    ///         accrues to exactly the full-term value). Confirms the
    ///         two branches converge at the boundary.
    function test_liveFloor_proRataAndFullTermConverge_atMaturity() public {
        // The pre-existing TEST_LOAN_ID is pro-rata at the default
        // 100k/12%APR/30d setup. Scaffold a parallel useFullTermInterest
        // loan with the same params.
        _scaffoldLoanFull({
            id: TEST_LOAN_ID + 6,
            principal: PRINCIPAL,
            rateBps: RATE_BPS,
            startTime: block.timestamp,
            durationDays: DURATION_DAYS,
            useFullTermInterest: true
        });

        vm.warp(block.timestamp + DURATION_DAYS * ONE_DAY);

        uint256 floorProRata = TestMutatorFacet(address(diamond)).getLiveFloor(
            TEST_LOAN_ID, block.timestamp
        );
        uint256 floorFullTerm = TestMutatorFacet(address(diamond)).getLiveFloor(
            TEST_LOAN_ID + 6, block.timestamp
        );
        assertEq(
            floorProRata,
            floorFullTerm,
            "at natural maturity, pro-rata and full-term floors converge"
        );
    }
}
