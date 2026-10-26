// test/LibCollateralSettlementTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/// @title LibCollateralSettlementTest
/// @notice Unit tests for the collateral-sale legs
///         (`LibCollateralSettlement`), T-086 step 3 of
///         `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md`.
///
///         The library provides two view helpers:
///
///           - `saleLegs(loanId, asOfTimestamp)` → (lender leg, treasury leg)
///           - `liveFloor(loanId, asOfTimestamp)` (their sum)
///
///         #2740 — both are the full-repayment split at that instant
///         (`LibSettlement.computeRepayment`): the lender leg is principal
///         plus the lender's share of interest and late fee, the treasury
///         leg is the treasury's share, and the floor is principal +
///         interest + late fee. The treasury's share is a cut OF the
///         interest, never a charge on top of it.
///
/// @dev    The library is `view`, not `pure`: it reads `loan.principal`
///         + `loan.startTime` + `loan.interestRateBps` from
///         `LibVaipakam`'s storage slot, and `cfgTreasuryFeeBps()` from
///         `ProtocolConfig`. The tests therefore scaffold loans through
///         `TestMutatorFacet.setLoan` and exercise the library via the
///         three view proxies (`getLiveFloor` etc) cut into the test
///         diamond — same pattern existing library tests use.
contract LibCollateralSettlementTest is SetupTest {
    uint256 internal constant TEST_LOAN_ID = 7_701;
    uint256 internal constant ONE_DAY = 1 days;
    uint256 internal constant LCS_DAYS_PER_YEAR = 365;
    // `BASIS_POINTS` (10_000) is already declared on the inherited
    // {SetupTest} contract. Reusing the inherited constant directly
    // below; re-declaring it locally would collide (Solidity 9097).

    uint256 internal constant PRINCIPAL = 100_000e18;
    uint256 internal constant RATE_BPS = 1_200; // 12% APR
    uint256 internal constant DURATION_DAYS = 30;
    uint256 internal constant DEFAULT_TREASURY_FEE_BPS = 100; // legacy fallback (1%) for a zero-snapshot loan (#1352 grandfather); NEW loans snapshot the live 200bps default

    address internal _lender;
    address internal _borrower;

    function setUp() public {
        setupHelper();
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

    function _lenderLeg(uint256 id, uint256 asOf) internal view returns (uint256 lenderLeg) {
        (lenderLeg,) = TestMutatorFacet(address(diamond)).getSaleLegs(id, asOf);
    }

    function _treasuryLeg(uint256 id, uint256 asOf) internal view returns (uint256 treasuryLeg) {
        (, treasuryLeg) = TestMutatorFacet(address(diamond)).getSaleLegs(id, asOf);
    }

    // ─── 1. Day-zero: no accrued interest yet ───────────────────────────

    function test_liveFloor_atStartTime_returnsPrincipalOnly() public view {
        uint256 floor = TestMutatorFacet(address(diamond)).getLiveFloor(
            TEST_LOAN_ID, block.timestamp
        );
        assertEq(floor, PRINCIPAL, "floor at t=startTime is just principal");

        uint256 principalLeg = _lenderLeg(TEST_LOAN_ID, block.timestamp);
        assertEq(principalLeg, PRINCIPAL, "lender leg is principal alone");

        uint256 feeLeg = _treasuryLeg(
            TEST_LOAN_ID, block.timestamp
        );
        assertEq(feeLeg, 0, "treasury leg zero when accrued=0");
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

        // #2740 — the treasury leg is a cut OF the interest: the lender
        // gets the rest, and the floor is principal + interest.
        uint256 expectedFeeLeg = (accrued * DEFAULT_TREASURY_FEE_BPS) / BASIS_POINTS;
        uint256 expectedPrincipalLeg = PRINCIPAL + accrued - expectedFeeLeg;
        uint256 expectedFloor = PRINCIPAL + accrued;

        assertEq(
            _lenderLeg(
                TEST_LOAN_ID, block.timestamp
            ),
            expectedPrincipalLeg,
            "lender leg = principal + accrued - treasury share"
        );
        assertEq(
            _treasuryLeg(
                TEST_LOAN_ID, block.timestamp
            ),
            expectedFeeLeg,
            "treasury leg = accrued * 100bps / 10000"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLiveFloor(
                TEST_LOAN_ID, block.timestamp
            ),
            expectedFloor,
            "liveFloor = principal + accrued, the legs' sum"
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
        // #1352: settlement reads the loan's `treasuryFeeBpsAtInit` SNAPSHOT
        // (the admin-configured rate captured at origination) via
        // `effectiveTreasuryFeeBps`, NOT the current live knob. Scaffold a
        // loan born while the admin fee was 5% (500 bps) and confirm the fee
        // leg honours that snapshot. A later live-knob retune (set below)
        // must NOT rewrite it.
        uint256 id = TEST_LOAN_ID + 200;
        uint256 start = block.timestamp;
        _scaffoldLoanWithTreasurySnapshot({
            id: id,
            principal: PRINCIPAL,
            rateBps: RATE_BPS,
            startTime: start,
            durationDays: DURATION_DAYS,
            treasuryFeeBpsAtInit: 500
        });

        // Retune the live knob to a different value to prove the snapshot,
        // not the live knob, drives settlement.
        TestMutatorFacet(address(diamond)).setTreasuryFeeBpsRaw(300);

        vm.warp(start + 30 * ONE_DAY); // full term

        uint256 accrued = _expectedAccrued(PRINCIPAL, RATE_BPS, 30);
        uint256 expectedFeeLeg = (accrued * 500) / BASIS_POINTS;
        // The rate moves value between lender and treasury, never the floor.
        uint256 expectedFloor = PRINCIPAL + accrued;

        assertEq(
            _treasuryLeg(
                id, block.timestamp
            ),
            expectedFeeLeg,
            "fee leg reflects the loan's 500bps snapshot, not the live 300bps knob"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLiveFloor(
                id, block.timestamp
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
            _treasuryLeg(
                TEST_LOAN_ID, block.timestamp
            ),
            expectedFeeLeg,
            "raw-slot-zero falls back to constant default (1%)"
        );
    }

    // ─── 5b. #957 (#921 item 6) — per-loan treasury-fee SNAPSHOT ────────
    //
    // A loan that carries a `treasuryFeeBpsAtInit` snapshot must settle at
    // THAT rate regardless of a later governance retune — the whole point of
    // #957. A `0` snapshot (pre-#957 loan) falls back to the live knob. These
    // guard `LibVaipakam.effectiveTreasuryFeeBps`, which every settlement
    // treasury split (here: the treasury leg of `saleLegs`) now routes through.

    /// @dev Scaffold a loan whose `treasuryFeeBpsAtInit` is stamped, so the
    ///      library reads the snapshot instead of the live knob.
    function _scaffoldLoanWithTreasurySnapshot(
        uint256 id,
        uint256 principal,
        uint256 rateBps,
        uint256 startTime,
        uint256 durationDays,
        uint16 treasuryFeeBpsAtInit
    ) internal {
        LibVaipakam.Loan memory loan;
        loan.lender = _lender;
        loan.borrower = _borrower;
        loan.principal = principal;
        loan.interestRateBps = rateBps;
        loan.startTime = uint64(startTime);
        loan.durationDays = durationDays;
        loan.status = LibVaipakam.LoanStatus.Active;
        loan.treasuryFeeBpsAtInit = treasuryFeeBpsAtInit;
        TestMutatorFacet(address(diamond)).setLoan(id, loan);
    }

    function test_957_treasurySnapshot_overridesLiveRetune() public {
        uint256 id = TEST_LOAN_ID + 100;
        uint256 start = block.timestamp;
        // Loan born at the 1% (100 bps) default.
        _scaffoldLoanWithTreasurySnapshot({
            id: id,
            principal: PRINCIPAL,
            rateBps: RATE_BPS,
            startTime: start,
            durationDays: DURATION_DAYS,
            treasuryFeeBpsAtInit: 100
        });

        // Governance retunes the LIVE treasury fee UP to 5% AFTER init.
        TestMutatorFacet(address(diamond)).setTreasuryFeeBpsRaw(500);

        vm.warp(start + 30 * ONE_DAY);
        uint256 accrued = _expectedAccrued(PRINCIPAL, RATE_BPS, 30);

        uint256 snapshotFee = (accrued * 100) / BASIS_POINTS; // what the loan owes
        uint256 liveFee = (accrued * 500) / BASIS_POINTS; // the WRONG (retuned) amount
        assertGt(liveFee, snapshotFee, "sanity: retune would change the fee");

        assertEq(
            _treasuryLeg(id, block.timestamp),
            snapshotFee,
            "settlement uses the loan's snapshotted 100bps, NOT the retuned 500bps"
        );
    }

    function test_957_zeroSnapshot_fallsBackToLegacyConstant() public {
        uint256 id = TEST_LOAN_ID + 101;
        uint256 start = block.timestamp;
        // Pre-#957 loan: no snapshot (0). #1352 rev-8 freeze changed the
        // fallback: `effectiveTreasuryFeeBps(0)` now pins to the LEGACY
        // constant (`LEGACY_TREASURY_FEE_BPS` = 100 = 1%), NOT the live knob.
        // A pre-#957 loan settles at 1% forever, immune to governance retunes
        // (which now only affect NEW originations via their snapshot).
        _scaffoldLoanWithTreasurySnapshot({
            id: id,
            principal: PRINCIPAL,
            rateBps: RATE_BPS,
            startTime: start,
            durationDays: DURATION_DAYS,
            treasuryFeeBpsAtInit: 0
        });

        // Retune the LIVE knob up to 5% — the zero-snapshot loan must ignore it.
        TestMutatorFacet(address(diamond)).setTreasuryFeeBpsRaw(500);

        vm.warp(start + 30 * ONE_DAY);
        uint256 accrued = _expectedAccrued(PRINCIPAL, RATE_BPS, 30);
        // Pinned to the legacy 1% constant, NOT the live 500bps knob.
        uint256 expectedFeeLeg = (accrued * DEFAULT_TREASURY_FEE_BPS) / BASIS_POINTS;

        assertEq(
            _treasuryLeg(id, block.timestamp),
            expectedFeeLeg,
            "zero snapshot (legacy loan) pins to the 100bps legacy constant, ignoring the live 500bps knob"
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
    ///         paying only `principal + 1d_accrued` and skip the
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
        uint256 expectedFloor = PRINCIPAL + expectedFullTerm;

        // At day zero, a `useFullTermInterest` loan ALREADY owes the
        // full coupon. Pro-rata would say 0.
        assertEq(
            _lenderLeg(
                TEST_LOAN_ID + 4, block.timestamp
            ),
            PRINCIPAL + expectedFullTerm - expectedFeeLeg,
            "lender leg = principal + full-term interest net of the treasury share, even at t=startTime"
        );
        assertEq(
            _treasuryLeg(
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

    // ─── 9. #2740 — one split with repayment, late fee included ────────

    /// @notice The two legs always sum to principal + interest: the treasury
    ///         is paid out of the interest, not on top of it, so a sale never
    ///         costs the borrower more than repaying would.
    function test_2740_legsSumToPrincipalPlusInterest() public {
        vm.warp(block.timestamp + 17 * ONE_DAY);
        uint256 accrued = _expectedAccrued(PRINCIPAL, RATE_BPS, 17);
        (uint256 lenderLeg, uint256 treasuryLeg) =
            TestMutatorFacet(address(diamond)).getSaleLegs(TEST_LOAN_ID, block.timestamp);
        assertEq(treasuryLeg, (accrued * DEFAULT_TREASURY_FEE_BPS) / BASIS_POINTS, "treasury = its cut of the interest");
        assertEq(lenderLeg + treasuryLeg, PRINCIPAL + accrued, "legs sum to principal + interest");
    }

    /// @notice A sale inside grace closes the loan as a late repayment: the
    ///         floor carries the late fee, and the treasury takes its cut of
    ///         interest + late fee as a late repay does.
    function test_2740_saleInsideGraceOwesTheLateFee() public {
        uint256 maturity = block.timestamp + DURATION_DAYS * ONE_DAY;
        vm.warp(maturity + 2 * ONE_DAY + 1 hours);

        uint256 accrued = _expectedAccrued(PRINCIPAL, RATE_BPS, DURATION_DAYS + 2);
        // Two whole days late: 1% + 2 × 0.5%.
        uint256 lateFee = (PRINCIPAL * 200) / BASIS_POINTS;
        uint256 treasury = ((accrued + lateFee) * DEFAULT_TREASURY_FEE_BPS) / BASIS_POINTS;

        (uint256 lenderLeg, uint256 treasuryLeg) =
            TestMutatorFacet(address(diamond)).getSaleLegs(TEST_LOAN_ID, block.timestamp);
        assertEq(treasuryLeg, treasury, "treasury cut of interest + late fee");
        assertEq(lenderLeg, PRINCIPAL + accrued + lateFee - treasury, "lender gets the rest");
        assertEq(
            TestMutatorFacet(address(diamond)).getLiveFloor(TEST_LOAN_ID, block.timestamp),
            PRINCIPAL + accrued + lateFee,
            "floor = principal + interest + late fee"
        );
    }

    /// @notice Legs read for a later instant (a Dutch listing fixes its legs
    ///         at the auction's end) price the late fee at that instant, not
    ///         at the block the read runs in.
    function test_2740_projectedLegsPriceTheLateFeeAtTheProjection() public view {
        uint256 maturity = block.timestamp + DURATION_DAYS * ONE_DAY;
        uint256 asOf = maturity + 3 * ONE_DAY;

        uint256 accrued = _expectedAccrued(PRINCIPAL, RATE_BPS, DURATION_DAYS + 3);
        uint256 lateFee = (PRINCIPAL * 250) / BASIS_POINTS;
        assertEq(
            TestMutatorFacet(address(diamond)).getLiveFloor(TEST_LOAN_ID, asOf),
            PRINCIPAL + accrued + lateFee,
            "projected floor carries the late fee due at the projection"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLiveFloor(TEST_LOAN_ID, maturity),
            PRINCIPAL + _expectedAccrued(PRINCIPAL, RATE_BPS, DURATION_DAYS),
            "no late fee at maturity itself"
        );
    }
}
