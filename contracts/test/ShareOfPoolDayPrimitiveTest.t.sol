// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/// @title  ShareOfPoolDayPrimitiveTest
/// @notice #1351 (M2 PR-2, slice 2b) — unit tests for `processUserSideDay`, the
///         ONE place a ShareOfPool `(user, side, day)` is priced against its
///         absolute ceiling `C`.
///
///         The properties under test are the ones that make the cap actually
///         hold, and each is a silent-failure shape rather than a loud one:
///
///         - fail CLOSED when an armed day has no explicit mode stamp (finalize
///           retires the legacy threshold on armed days, so treating a
///           mode-less day as Legacy would price it with a DISABLED cap);
///         - refuse a transfer set that mixes users/sides or includes a day the
///           entry doesn't cover (the budget is keyed off the FIRST entry);
///         - pool shortage is ALL-OR-NOTHING and must NOT advance (advancing on
///           a partial pay would silently forfeit the remainder);
///         - a 0-slice day that is legitimately exhausted MUST advance, so the
///           walk makes progress instead of spinning;
///         - dust never pushes a slice past its `cEff` (that would breach the
///           loan-side cap), and `Sigma slices <= budget`.
contract ShareOfPoolDayPrimitiveTest is SetupTest {
    uint256 constant DAY = 5;
    uint64 constant LOAN_A = 4001;
    uint64 constant LOAN_B = 4002;

    address internal alice;

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function setUp() public {
        setupHelper();
        alice = makeAddr("aliceD1");
        // Arm D* and seed the day's globals + RPN row so contributions price.
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _mut().setDayPoolStampRaw(DAY, uint128(1000 ether), 0);
        _mut().setKnownGlobalDailyInterest(DAY, 1000 ether, 0, true);
        _mut().setDayCapThreshold18(DAY, type(uint256).max);
        _mut().setDayCapModeRaw(DAY, 1); // ShareOfPool
        // Materialize the RPN row + cursor for DAY so contributions price
        // (production advances this lazily inside the claim walk).
        _mut().seedCumLenderDayRaw(DAY, 0, 1e18);
        // Seed the day's ceiling directly: `snapshotDayUserSideShareCap` runs
        // inside finalizeDay, which these unit tests bypass.
        _mut().setDayUserSideCapRaw(DAY, 100 ether);
        // Loan-side ceilings large enough that the D1 ceiling is the binding
        // constraint in these tests (not the loan-side clamp).
        _stampLoanCap(LOAN_A, 10_000 ether);
        _stampLoanCap(LOAN_B, 10_000 ether);
    }

    /// @dev Stamp a loan-side ceiling for `loanId`. WITHOUT this every `cEff`
    ///      clamps to 0 and the ceiling assertions below pass VACUOUSLY at a
    ///      0 payout — which is exactly how the missing `+1` day-count bug hid.
    function _stampLoanCap(uint64 loanId, uint128 capOpen) internal {
        _mut().setFeeEntitlementRaw(
            loanId,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: 30,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0,
                loanSideRewardCapOpen: capOpen
            })
        );
    }

    /// @dev Seed a closed entry covering `[DAY, DAY+1)` for `user`.
    function _entry(
        address user,
        uint64 loanId,
        uint256 perDay
    ) internal returns (uint256 id) {
        id = _mut().pushRewardEntry(
            user, loanId, LibVaipakam.RewardSide.Lender, perDay, uint32(DAY)
        );
        _mut().closeRewardEntryRaw(id, uint32(DAY + 1));
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _ids(uint256 a, uint256 b)
        internal
        pure
        returns (uint256[] memory r)
    {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    // ─── Fail-closed mode ────────────────────────────────────────────────────

    /// @dev An armed day whose mode stamp is missing is NOT a legacy day.
    ///      Finalize sets `dayCapThreshold18 = max` on armed days, so silently
    ///      treating it as `LegacyEthRatio` would pay it with a disabled cap.
    function test_RevertsWhenArmedDayHasNoModeStamp() public {
        _mut().setDayCapModeRaw(DAY, 0); // back to LegacyEthRatio
        uint256 id = _entry(alice, LOAN_A, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.DayCapModeUnsetPostCutover.selector, DAY
            )
        );
        _mut().processUserSideDayRaw(alice, DAY, _ids(id), type(uint256).max);
    }

    // ─── Transfer-set preconditions ──────────────────────────────────────────

    /// @dev The `(user, side, day)` budget is keyed off the FIRST entry, so a
    ///      foreign-user entry in the set would spend someone else's ceiling.
    function test_RevertsOnForeignUserInTransferSet() public {
        address bob = makeAddr("bobD1");
        uint256 a = _entry(alice, LOAN_A, 1 ether);
        uint256 b = _entry(bob, LOAN_B, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardEntrySetMismatch.selector, b
            )
        );
        _mut().processUserSideDayRaw(alice, DAY, _ids(a, b), type(uint256).max);
    }

    /// @dev Paying a day the entry doesn't cover would mint reward from nothing
    ///      (`perDayNumeraire18 x delta` is computed regardless of the window).
    function test_RevertsOnEntryNotCoveringTheDay() public {
        uint256 id = _mut().pushRewardEntry(
            alice, LOAN_A, LibVaipakam.RewardSide.Lender, 1 ether, uint32(DAY + 3)
        );
        _mut().closeRewardEntryRaw(id, uint32(DAY + 4));
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardEntrySetMismatch.selector, id
            )
        );
        _mut().processUserSideDayRaw(alice, DAY, _ids(id), type(uint256).max);
    }

    // ─── Pool shortage: all-or-nothing, no advance ───────────────────────────

    /// @dev A pool that cannot cover the day's budget pays NOTHING and does NOT
    ///      advance, so the day stays retryable. Advancing on a partial pay
    ///      would silently forfeit the remainder (v1 keeps no partial-day
    ///      accounting).
    function test_PoolShortagePaysNothingAndDoesNotAdvance() public {
        uint256 id = _entry(alice, LOAN_A, 1 ether);
        (uint256 toUser, uint256 toTreasury, bool advanced, ) =
            _mut().processUserSideDayRaw(alice, DAY, _ids(id), 1 wei);
        assertEq(toUser, 0, "no user payout on pool shortage");
        assertEq(toTreasury, 0, "no treasury payout on pool shortage");
        assertFalse(advanced, "must NOT advance - day stays retryable");
    }

    // ─── 0-slice advance policy ──────────────────────────────────────────────

    /// @dev An exhausted budget pays 0 but MUST advance, otherwise the claim
    ///      walk spins forever on a day it can never pay.
    function test_ExhaustedBudgetAdvancesWithZeroSlice() public {
        uint256 id = _entry(alice, LOAN_A, 1 ether);
        uint256 c = _mut().dayUserSideCapVpfi18Raw(DAY);
        _mut().setUserSideDayPaidRaw(alice, 0, DAY, c); // fully spent
        (uint256 toUser, , bool advanced, ) =
            _mut().processUserSideDayRaw(alice, DAY, _ids(id), type(uint256).max);
        assertEq(toUser, 0, "exhausted pays nothing");
        assertTrue(advanced, "exhausted MUST advance");
    }

    /// @dev A dust day is legitimately `C == 0` while still being ShareOfPool —
    ///      it must advance, not be mistaken for a legacy day.
    function test_ZeroCeilingDustDayAdvances() public {
        _mut().setDayUserSideCapRaw(DAY, 0);
        uint256 id = _entry(alice, LOAN_A, 1 ether);
        (uint256 toUser, , bool advanced, ) =
            _mut().processUserSideDayRaw(alice, DAY, _ids(id), type(uint256).max);
        assertEq(toUser, 0, "C == 0 pays nothing");
        assertTrue(advanced, "C == 0 dust day MUST advance");
    }

    // ─── Ceiling + dust bounds ───────────────────────────────────────────────

    /// @dev The absolute ceiling binds across MULTIPLE entries of one user —
    ///      the whole point of the `(user, side, day)` domain (a per-entry cap
    ///      would let N loans take N x C).
    function test_CeilingBindsAcrossMultipleEntriesOfOneUser() public {
        uint256 c = _mut().dayUserSideCapVpfi18Raw(DAY);
        assertGt(c, 0, "ceiling seeded");
        // Two entries each individually able to exceed the ceiling.
        uint256 a = _entry(alice, LOAN_A, 900 ether);
        uint256 b = _entry(alice, LOAN_B, 900 ether);
        (uint256 toUser, uint256 toTreasury, bool advanced, uint256[] memory sl) =
            _mut().processUserSideDayRaw(alice, DAY, _ids(a, b), type(uint256).max);
        assertTrue(advanced, "paid day advances");
        // NON-VACUITY: without this the `<= C` asserts below hold trivially at
        // a 0 payout, which is precisely how the missing day-count `+1` hid.
        assertGt(toUser, 0, "a real payout actually happened");
        assertEq(toUser + toTreasury, c, "two oversized entries saturate C");
        assertLe(toUser + toTreasury, c, "Sigma paid <= C");
        assertLe(sl[0] + sl[1], c, "Sigma slices <= C");
    }

    /// @dev Order-independence: whichever loan settles FIRST consumes budget the
    ///      later one then cannot re-spend, so `Sigma paid <= C` holds across
    ///      sequential (staggered-close) calls. Exact simultaneous pro-rata is
    ///      explicitly NOT promised — only the ceiling is.
    function test_StaggeredSequentialClaimsNeverExceedCeiling() public {
        uint256 c = _mut().dayUserSideCapVpfi18Raw(DAY);
        uint256 a = _entry(alice, LOAN_A, 900 ether);
        uint256 b = _entry(alice, LOAN_B, 900 ether);

        // Loan A settles first and consumes its slice.
        (uint256 firstUser, uint256 firstTreas, , ) =
            _mut().processUserSideDayRaw(alice, DAY, _ids(a), type(uint256).max);
        // Persist what a real caller would charge.
        _mut().setUserSideDayPaidRaw(alice, 0, DAY, firstUser + firstTreas);

        // Loan B settles later against the REDUCED remaining budget.
        (uint256 secondUser, uint256 secondTreas, , ) =
            _mut().processUserSideDayRaw(alice, DAY, _ids(b), type(uint256).max);

        assertGt(firstUser, 0, "first close actually paid (non-vacuous)");
        assertLe(
            firstUser + firstTreas + secondUser + secondTreas,
            c,
            "Sigma paid across staggered closes <= C"
        );
    }
}
