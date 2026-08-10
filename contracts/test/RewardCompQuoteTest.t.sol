// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";

import {RewardCommitmentFacet} from "../src/facets/RewardCommitmentFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../src/libraries/LibInteractionRewards.sol";

/// @title RewardCompQuoteTest
/// @notice #1434 P2-w3 — the zeroed-day compensation QUOTE + the Δq pricing
///         ladder, both ends:
///
///         MIRROR side — the §1.4 batched quote accumulator (Δq-priced,
///         demand-conservation completeness, ascending-id cursor), the
///         once-per-day dispatch (kind 11), the §2.3 resolved-zero terminal,
///         and the §2.1 pricing ladder inside the cumulative fold: a
///         deliberately-zeroed day DEFERS while open, crosses at zero once
///         lapsed / resolved-zero, and crosses at the SAME Δq the quote
///         priced once its compensation is funded to quote — including the
///         constraint-17 `G_s == 0` day, which prices under the purely-local
///         denominator (the §8 slice-3 proof). The fold's funding gate is
///         keyed on the AMOUNT present (pool ≥ side quote), never a message
///         arrival, and the blanket armed-mirror halt is untouched for
///         unflagged days.
///
///         BASE side — the kind-11 ingress gates (messenger-only, canonical,
///         finalized, ineligible-or-refresh). The funded-day interaction and
///         the per-side manual-remit bounds live in `RewardRemitLedgerTest`
///         with the remit fixture.
contract RewardCompQuoteTest is SetupTest, IVaipakamErrors {
    MockRewardMessenger internal messenger;

    address internal u1;
    address internal u2;

    uint32 internal constant CHAIN_BASE = 8453; // canonical
    uint32 internal constant CHAIN_ARB = 42161; // mirror

    uint256 internal constant DAY = 1;
    uint8 internal constant L = uint8(LibVaipakam.RewardSide.Lender);
    uint8 internal constant B = uint8(LibVaipakam.RewardSide.Borrower);

    function setUp() public {
        setupHelper();
        messenger = new MockRewardMessenger(address(diamond));
        u1 = makeAddr("carol");
        u2 = makeAddr("dave");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _com() internal view returns (RewardCommitmentFacet) {
        return RewardCommitmentFacet(address(diamond));
    }

    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }

    function _agg() internal view returns (RewardAggregatorFacet) {
        return RewardAggregatorFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _configureMirror() internal {
        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
        _rep().setRewardMessenger(address(messenger));
    }

    function _configureCanonical() internal {
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](1);
        chainIds[0] = CHAIN_BASE;
        _agg().setExpectedSourceChainIds(chainIds);
    }

    /// @dev The constraint-17 zeroed mirror day: armed from `DAY`, this
    ///      chain's own stamp carries fresh halves 20e18/20e18, the local
    ///      interest close ran, the day is deliberately zeroed, and the
    ///      frozen EXCLUDED global is ZERO — Base finalized the day without
    ///      this chain's demand, so Δq must price under the purely-local
    ///      denominator. Lender demand 100e18 ⇒ Δq_L = 20e18 × 1e18 / 100e18
    ///      = 0.2e18.
    function _zeroedDayG0() internal {
        _mut().setGovernorCommitArmedFromDayRaw(DAY);
        _mut().setDayPoolStampRaw(DAY, 40e18, 20e18);
        // #1636 r1 P1 — the PRODUCTION zeroed-day shape: the excluded
        // chain's own per-(day,chain) funding slice is stamped ZERO by
        // `_perDestFields` (its slice was sized without its demand). Δq
        // must come from the day-level `dayPoolStamp` floor, never this
        // slice — the fixture zeroes it so a slice-reading Δq quotes
        // (0,0) and fails these tests.
        _mut().setChainDayFundingRaw(DAY, uint32(block.chainid), 0, 0);
        _mut().setChainReportSentAtRaw(DAY, uint64(block.timestamp));
        _mut().setDayDeliberatelyZeroedRaw(DAY, true);
        _mut().setDailyLenderInterest(DAY, u1, 60e18, 100e18);
        // The seeding helper mirrors totals into the knownGlobal pair;
        // overwrite to the zeroed-day shape (excluded global = 0, still
        // finalized/set).
        _mut().setKnownGlobalDailyInterest(DAY, 0, 0, true);
        // T_d unset would floor the capped cumulative at zero; production
        // freezes it at finalize, so stage "cap disabled".
        _mut().setDayCapThreshold18(DAY, type(uint256).max);
    }

    /// @dev Lender-side entries covering `DAY` (per-day 60/25/15, cap 15e18):
    ///      at Δq = 0.2e18 → 12 + 5 + 3 = 20e18 quoted, conservation 100e18.
    function _seedLenderEntries()
        internal
        returns (uint256 e1, uint256 e2, uint256 e3)
    {
        _mut().setDayUserSideCapRaw(DAY, 15e18);
        e1 = _mut().pushRewardEntry(
            u1, 1, LibVaipakam.RewardSide.Lender, 60e18, 1
        );
        _mut().setRewardEntryEndDayRaw(e1, 10);
        e2 = _mut().pushRewardEntry(
            u2, 2, LibVaipakam.RewardSide.Lender, 25e18, 1
        );
        _mut().setRewardEntryEndDayRaw(e2, 10);
        e3 = _mut().pushRewardEntry(
            u2, 3, LibVaipakam.RewardSide.Lender, 15e18, 1
        );
        _mut().setRewardEntryEndDayRaw(e3, 10);
    }

    /// @dev Dispatch the day's quote (stamps `compQuoteSentAt` — the
    ///      r5 completeness evidence the pricing ladder gates on).
    function _dispatchQuote() internal {
        _com().quoteZeroedDayCompensation(DAY, payable(address(this)));
    }

    function _ids3(
        uint256 a,
        uint256 b,
        uint256 c
    ) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](3);
        ids[0] = a;
        ids[1] = b;
        ids[2] = c;
    }

    /// @dev Accumulate all three lender entries (complete: conservation
    ///      100e18) — quote 20e18 at Δq = 0.2e18.
    function _accumulateAllLender()
        internal
        returns (uint256 e1, uint256 e2, uint256 e3)
    {
        (e1, e2, e3) = _seedLenderEntries();
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, _ids3(e1, e2, e3)
        );
    }

    // ═══ Mirror: quote accumulator (§1.4) ════════════════════════════════════

    function test_accumulate_pricesDeltaQ_underLocalDenominator() public {
        // Constraint-17: G_s == 0, yet the quote prices — the denominator
        // is the mirror's own folded demand.
        _configureMirror();
        _zeroedDayG0();
        (, , uint256 e3) = _accumulateAllLender();

        (
            uint256 curL,
            ,
            uint256 accL,
            uint256 accB,
            uint256 consL,
            uint256 consB,
            uint64 sentAt
        ) = _com().getCompQuoteAccum(DAY);
        assertEq(accL, 20e18, "12 + 5 + 3 at Dq = 0.2e18 (e1 raw-bound 12)");
        assertEq(consL, 100e18, "conservation = folded lender demand");
        assertEq(accB, 0, "borrower side untouched");
        assertEq(consB, 0, "borrower conservation untouched");
        assertEq(curL, e3, "cursor at last entry id");
        assertEq(sentAt, 0, "not dispatched yet");
    }

    function test_accumulate_capsDoNotTrimTheQuote() public {
        // #1636 r1 P1 — the quote is the UNCAPPED fair-share sum: it must
        // upper-bound the cap-free bulk settlement paths (a forfeited
        // entry's window prices uncapped by design), so a per-entry
        // ceiling must NOT shrink it below that liability.
        _configureMirror();
        _zeroedDayG0();
        (uint256 e1, uint256 e2, uint256 e3) = _seedLenderEntries();
        // A ceiling below e1's raw 12e18 — the quote ignores it.
        _mut().setDayUserSideCapRaw(DAY, 10e18);
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, _ids3(e1, e2, e3)
        );
        (, , uint256 accL, , , , ) = _com().getCompQuoteAccum(DAY);
        assertEq(accL, 20e18, "uncapped: 12 + 5 + 3 despite the ceiling");
    }

    function test_accumulate_refusesUnstampedDay() public {
        // #1636 r1 P1 — no frozen pool stamp, no quote: pricing without
        // the Dq numerator would quote (0,0) and wrongly resolve a
        // demand-carrying day to zero.
        _configureMirror();
        _mut().setGovernorCommitArmedFromDayRaw(DAY);
        _mut().setChainReportSentAtRaw(DAY, uint64(block.timestamp));
        _mut().setDayDeliberatelyZeroedRaw(DAY, true);
        (uint256 e1, uint256 e2, uint256 e3) = _seedLenderEntries();
        _mut().setDailyLenderInterest(DAY, u1, 60e18, 100e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                CompQuoteDayPoolStampMissing.selector, DAY
            )
        );
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, _ids3(e1, e2, e3)
        );
    }

    function test_accumulate_reset_recoversSkippedEntries() public {
        // #1636 r1 P1 — a permissionless caller parks the cursor past the
        // covering set; the ADMIN reset valve recovers the day.
        _configureMirror();
        _zeroedDayG0();
        (uint256 e1, uint256 e2, uint256 e3) = _seedLenderEntries();
        uint256[] memory high = new uint256[](1);
        high[0] = e3;
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, high
        );
        // e1/e2 are now below the cursor — unrecoverable without a reset.
        uint256[] memory low = new uint256[](1);
        low[0] = e1;
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntriesNotAscending.selector, e1)
        );
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, low
        );

        _com().resetCompQuoteAccumulation(DAY, L);
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, _ids3(e1, e2, e3)
        );
        (, , uint256 accL, , uint256 consL, , ) = _com().getCompQuoteAccum(DAY);
        assertEq(accL, 20e18, "full set re-accumulated");
        assertEq(consL, 100e18, "conservation complete after reset");
    }

    function test_accumulate_mixedGlobal_pricesAgainstSum() public {
        // G_s > 0 (other chains had demand): denominator is G_s + L_s.
        _configureMirror();
        _zeroedDayG0();
        _mut().setKnownGlobalDailyInterest(DAY, 100e18, 0, true);
        // Δq = 20e18 × 1e18 / (100 + 100)e18 = 0.1e18 → 6 + 2.5 + 1.5.
        _accumulateAllLender();
        (, , uint256 accL, , , , ) = _com().getCompQuoteAccum(DAY);
        assertEq(accL, 10e18, "priced against the summed denominator");
    }

    function test_accumulate_surfaceGates() public {
        _configureMirror();
        _zeroedDayG0();
        (uint256 e1, uint256 e2, uint256 e3) = _seedLenderEntries();

        // Not deliberately zeroed.
        _mut().setDayDeliberatelyZeroedRaw(DAY, false);
        vm.expectRevert(
            abi.encodeWithSelector(CompQuoteDayNotZeroed.selector, DAY)
        );
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, _ids3(e1, e2, e3)
        );
        _mut().setDayDeliberatelyZeroedRaw(DAY, true);

        // Local interest close has not run.
        _mut().setChainReportSentAtRaw(DAY, 0);
        vm.expectRevert(
            abi.encodeWithSelector(CompQuoteLocalCloseMissing.selector, DAY)
        );
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, _ids3(e1, e2, e3)
        );
        _mut().setChainReportSentAtRaw(DAY, uint64(block.timestamp));

        // Lapsed (either flavour) is terminal for the quote surface.
        _mut().setDayLapsedRaw(DAY, true, false);
        vm.expectRevert(
            abi.encodeWithSelector(CompQuoteDayLapsed.selector, DAY)
        );
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, _ids3(e1, e2, e3)
        );
        _mut().setDayLapsedRaw(DAY, false, true);
        vm.expectRevert(
            abi.encodeWithSelector(CompQuoteDayLapsed.selector, DAY)
        );
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, _ids3(e1, e2, e3)
        );
        _mut().setDayLapsedRaw(DAY, false, false);

        // Non-ascending ids (duplicate re-submission).
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, _ids3(e1, e2, e3)
        );
        uint256[] memory again = new uint256[](1);
        again[0] = e3;
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntriesNotAscending.selector, e3)
        );
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, again
        );
    }

    function test_accumulate_validatesEntryMembership() public {
        _configureMirror();
        _zeroedDayG0();
        _seedLenderEntries();
        // A borrower entry offered to the LENDER accumulation.
        uint256 eB = _mut().pushRewardEntry(
            u1, 9, LibVaipakam.RewardSide.Borrower, 10e18, 1
        );
        _mut().setRewardEntryEndDayRaw(eB, 10);
        uint256[] memory one = new uint256[](1);
        one[0] = eB;
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntryMismatch.selector, eB)
        );
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, one
        );

        // A lender entry whose window does not cover DAY.
        uint256 eLate = _mut().pushRewardEntry(
            u1, 10, LibVaipakam.RewardSide.Lender, 10e18, 5
        );
        _mut().setRewardEntryEndDayRaw(eLate, 10);
        one[0] = eLate;
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentEntryMismatch.selector, eLate)
        );
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, one
        );
    }

    // ═══ Mirror: dispatch (§1.4) + resolved-zero (§2.3) ══════════════════════

    function test_dispatch_refusesIncompleteConservation() public {
        _configureMirror();
        _zeroedDayG0();
        (uint256 e1, uint256 e2, ) = _seedLenderEntries();
        uint256[] memory two = new uint256[](2);
        two[0] = e1;
        two[1] = e2;
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, two
        );
        // 60 + 25 = 85e18 ≠ 100e18 — e3 is missing.
        vm.expectRevert(
            abi.encodeWithSelector(
                CompQuoteIncomplete.selector, DAY, L, 85e18, 100e18
            )
        );
        _com().quoteZeroedDayCompensation(DAY, payable(address(this)));
    }

    function test_dispatch_sendsWire_freezesAccumulation_resendable() public {
        _configureMirror();
        _zeroedDayG0();
        _accumulateAllLender();

        _com().quoteZeroedDayCompensation(DAY, payable(address(this)));
        assertEq(messenger.lastCompQuoteDay(), DAY, "wire day");
        assertEq(messenger.lastCompQuoteLender18(), 20e18, "wire lender");
        assertEq(messenger.lastCompQuoteBorrower18(), 0, "wire borrower");
        assertEq(messenger.compQuoteSendCount(), 1, "one send");
        (, , , , , , uint64 sentAt) = _com().getCompQuoteAccum(DAY);
        assertGt(sentAt, 0, "dispatch stamped");
        assertFalse(
            _com().getDayResolvedZero(DAY), "non-zero quote is not resolved"
        );

        // Accumulation is closed once dispatched.
        uint256[] memory one = new uint256[](1);
        one[0] = 99;
        vm.expectRevert(
            abi.encodeWithSelector(CompQuoteAlreadyDispatched.selector, DAY)
        );
        _com().accumulateCompQuoteBatch(
            DAY, LibVaipakam.RewardSide.Lender, one
        );

        // Re-send (lost-message retry) carries the identical frozen quote.
        _com().quoteZeroedDayCompensation(DAY, payable(address(this)));
        assertEq(messenger.compQuoteSendCount(), 2, "re-sent");
        assertEq(messenger.lastCompQuoteLender18(), 20e18, "same figures");
    }

    function test_dispatch_bothSidesZero_setsResolvedZeroLocally() public {
        // A zeroed day with NO local demand at all: trivially complete on
        // both sides, quotes (0,0), and the §2.3 terminal lands MIRROR-side
        // before dispatch.
        _configureMirror();
        _mut().setGovernorCommitArmedFromDayRaw(DAY);
        _mut().setDayPoolStampRaw(DAY, 40e18, 20e18);
        _mut().setChainReportSentAtRaw(DAY, uint64(block.timestamp));
        _mut().setDayDeliberatelyZeroedRaw(DAY, true);
        _mut().setKnownGlobalDailyInterest(DAY, 0, 0, true);
        _mut().setDayCapThreshold18(DAY, type(uint256).max);

        _com().quoteZeroedDayCompensation(DAY, payable(address(this)));
        assertTrue(_com().getDayResolvedZero(DAY), "resolved-zero terminal");
        assertEq(messenger.lastCompQuoteLender18(), 0, "zero quote");
        assertEq(messenger.lastCompQuoteBorrower18(), 0, "zero quote");
    }

    // ═══ Mirror: the §2.1 pricing ladder in the cumulative fold ══════════════

    function test_ladder_zeroedOpenDay_defersFold() public {
        _configureMirror();
        _zeroedDayG0();
        _accumulateAllLender();
        // No compensation credited: the anti-zero-retirement gate holds the
        // cursor BEFORE the day.
        uint256 reached = _mut().advanceCumThroughRaw(L, DAY);
        assertEq(reached, 0, "open zeroed day defers");
    }

    function test_ladder_fundedCompensation_crossesAtDeltaQ() public {
        _configureMirror();
        _zeroedDayG0();
        _accumulateAllLender();
        _dispatchQuote();
        // Funded exactly to the side quote (20e18 lender, 0 borrower).
        _mut().setDayCompensationRaw(DAY, 20e18, 0, true, false);

        uint256 reached = _mut().advanceCumThroughRaw(L, DAY);
        assertEq(reached, DAY, "funded day crosses");
        (
            ,
            uint256 rpn,
            uint256 minRpn,
            uint256 minRec,
            uint256 minArmed
        ) = _mut().getCumStateRaw(L, DAY);
        assertEq(rpn, 0.2e18, "crosses at Dq under the LOCAL denominator");
        assertEq(minRpn, 0.2e18, "capped series carries Dq (T_d disabled)");
        assertEq(minRec, 0, "no recycled component");
        assertEq(
            minArmed,
            0.2e18,
            "Dq stays in the armed cumulative - the window split must "
            "classify it armed-fresh, not pre-D* legacy"
        );
    }

    function test_ladder_underfundedCompensation_defers() public {
        _configureMirror();
        _zeroedDayG0();
        _accumulateAllLender();
        _dispatchQuote();
        // One wei short of the 20e18 side quote.
        _mut().setDayCompensationRaw(DAY, 20e18 - 1, 0, true, false);
        assertEq(
            _mut().advanceCumThroughRaw(L, DAY), 0, "underfunded defers"
        );
    }

    function test_ladder_undispatchedQuote_defers() public {
        // #1636 r5 — the quoted sums are trustworthy only once DISPATCH's
        // conservation proof ran: an undispatched accumulation is partial
        // (would open the gate below the real liability), and a pre-w3
        // compensated day has no accumulation at all (a zero quote would
        // declare any w2 remit "fully funded"). Both defer on the same
        // evidence gate, fully funded pools notwithstanding.
        _configureMirror();
        _zeroedDayG0();
        _accumulateAllLender(); // complete — but never dispatched
        _mut().setDayCompensationRaw(DAY, 20e18, 0, true, false);
        assertEq(
            _mut().advanceCumThroughRaw(L, DAY),
            0,
            "no dispatch stamp, no crossing"
        );
        // The pre-w3 shape exactly: compensated with ZERO accumulation.
        _com().resetCompQuoteAccumulation(DAY, L);
        assertEq(
            _mut().advanceCumThroughRaw(L, DAY),
            0,
            "pre-w3 compensated day defers until quote evidence exists"
        );
    }

    function test_ladder_provisionalCompensation_defers() public {
        _configureMirror();
        _zeroedDayG0();
        _accumulateAllLender();
        _dispatchQuote();
        // Fully funded but era-provisional: not priced until its V3
        // broadcast settles which era governs.
        _mut().setDayCompensationRaw(DAY, 20e18, 0, true, true);
        assertEq(
            _mut().advanceCumThroughRaw(L, DAY), 0, "provisional defers"
        );
    }

    function test_ladder_lapsedDay_crossesAtZero() public {
        _configureMirror();
        _zeroedDayG0();
        _accumulateAllLender();
        _mut().setDayLapsedRaw(DAY, true, false);
        uint256 reached = _mut().advanceCumThroughRaw(L, DAY);
        assertEq(reached, DAY, "lapsed day retires through the fold");
        (, uint256 rpn, , , uint256 minArmed) = _mut().getCumStateRaw(L, DAY);
        assertEq(rpn, 0, "at zero");
        assertEq(minArmed, 0, "no armed contribution");
    }

    function test_ladder_resolvedZeroDay_crossesAtZero() public {
        _configureMirror();
        _zeroedDayG0();
        _accumulateAllLender();
        _dispatchQuote();
        // Day 2: a zeroed day with NO local demand, resolved-zero through
        // the PRODUCTION writer (the (0,0) dispatch).
        uint256 d2 = 2;
        _mut().setDayPoolStampRaw(d2, 40e18, 20e18);
        _mut().setChainReportSentAtRaw(d2, uint64(block.timestamp));
        _mut().setDayDeliberatelyZeroedRaw(d2, true);
        _mut().setKnownGlobalDailyInterest(d2, 0, 0, true);
        _mut().setDayCapThreshold18(d2, type(uint256).max);
        _com().quoteZeroedDayCompensation(d2, payable(address(this)));
        assertTrue(_com().getDayResolvedZero(d2), "resolved");

        // Day 1 funded so the fold can reach day 2.
        _mut().setDayCompensationRaw(DAY, 20e18, 0, true, false);
        uint256 reached = _mut().advanceCumThroughRaw(L, d2);
        assertEq(reached, d2, "resolved-zero day crosses");
        (, uint256 rpn1, , , ) = _mut().getCumStateRaw(L, DAY);
        (, uint256 rpn2, , , ) = _mut().getCumStateRaw(L, d2);
        assertEq(rpn1, 0.2e18, "day 1 at Dq");
        assertEq(rpn2, 0.2e18, "day 2 adds zero (cumulative unchanged)");
    }

    function test_ladder_unflaggedArmedMirrorDay_keepsBlanketHalt() public {
        // The P1-b invariant: an armed mirror day WITHOUT the zeroed marker
        // still halts the fold outright — the ladder must not widen it.
        _configureMirror();
        _zeroedDayG0();
        _mut().setDayDeliberatelyZeroedRaw(DAY, false);
        assertEq(
            _mut().advanceCumThroughRaw(L, DAY),
            0,
            "ordinary armed mirror day stays halted until P1-b"
        );
    }

    function test_walk_paysCompensatedConstraint17Day() public {
        // #1636 r1 P1 — the WALK must consume the same Δq the fold
        // stored. The retired `_contribFor` global-zero guard priced this
        // day at 0 (`knownGlobal == 0` on the constraint-17 side even
        // though the row carries Δq), advanced terminally, and retired
        // the entries UNPAID — while bulk window pricing could still pay
        // from the same row. One row, one truth, both paths.
        _configureMirror();
        _zeroedDayG0();
        (uint256 e1, , ) = _accumulateAllLender();
        _dispatchQuote();
        _mut().setDayCompensationRaw(DAY, 20e18, 0, true, false);
        assertEq(_mut().advanceCumThroughRaw(L, DAY), DAY, "fold crossed");

        // The primitive pays only CLAIMABLE entries — close e1's window.
        _mut().closeRewardEntryRaw(e1, 10);

        // The walk's own gates: ShareOfPool mode + a loan-side ceiling
        // generous enough that the D1 ceiling is the binding constraint.
        _mut().setDayCapModeRaw(DAY, 1);
        _mut().setFeeEntitlementRaw(
            1,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: 30,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0,
                loanSideRewardCapOpen: 10_000 ether
            })
        );
        uint256[] memory one = new uint256[](1);
        one[0] = e1;
        (LibInteractionRewards.DayCharge memory ch, ) = _mut()
            .processUserSideDayRaw(
                u1, DAY, one, type(uint256).max, type(uint256).max
            );
        assertTrue(ch.advanced, "day settles");
        assertEq(ch.toUser.total, 12e18, "e1 pays perDay x Dq = 60 x 0.2");
        assertEq(ch.toUser.armedFresh, 12e18, "classified armed-fresh");
        assertEq(ch.toUser.recycled, 0, "no recycled component");
    }

    // ═══ Mirror: commitment-twin lockstep ════════════════════════════════════

    function test_twin_lockstepAcrossLadderStates() public {
        _configureMirror();
        _zeroedDayG0();
        _accumulateAllLender();

        // Open zeroed day: NOT priceable — a zero report for a day later
        // compensated at Dq would under-commit.
        (uint256 delta, bool priceable) =
            _mut().dailyDeltaForCommitmentRaw(L, DAY);
        assertEq(delta, 0, "open: no figure");
        assertFalse(priceable, "open: report must wait");

        // Funded compensation (quote dispatched — the r5 completeness
        // evidence): reports the same Dq the fold prices.
        _dispatchQuote();
        _mut().setDayCompensationRaw(DAY, 20e18, 0, true, false);
        (delta, priceable) = _mut().dailyDeltaForCommitmentRaw(L, DAY);
        assertEq(delta, 0.2e18, "funded: Dq");
        assertTrue(priceable, "funded: priceable");

        // Lapsed: priceable zero (the day retires at zero).
        _mut().setDayLapsedRaw(DAY, true, false);
        (delta, priceable) = _mut().dailyDeltaForCommitmentRaw(L, DAY);
        assertEq(delta, 0, "lapsed: zero");
        assertTrue(priceable, "lapsed: priceable");
    }
}
