// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title  ShareOfPoolClaimWalkTest
/// @notice #1351 (M2 PR-2, slice 2c) — the CLAIM-side day walk.
///
///         Slice 2b's suite covers the day primitive in isolation. This covers
///         what 2c adds on top: the claim routes ShareOfPool days THROUGH that
///         primitive, keeps pre-`D*` days on the O(1) window product, persists
///         its cursors between chunks, and never pays a day twice.
///
///         Seeding note: the cumulative RPN series is built LAZILY by the claim
///         from each day's stamp + global denominator, so these tests seed only
///         the day records — hand-seeding the cumulatives would move the cursor
///         without building the capped series the window product reads.
contract ShareOfPoolClaimWalkTest is SetupTest {
    VPFIToken internal vpfi;
    address internal alice = makeAddr("2c-alice");

    uint256 constant DIAMOND_SEED = 100_000_000 ether;
    uint64 constant LOAN = 91;

    function setUp() public {
        setupHelper();
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIToken.initialize,
                (address(this), address(this), address(this))
            )
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        uint256 have = vpfi.balanceOf(address(this));
        if (DIAMOND_SEED > have) vpfi.mint(address(this), DIAMOND_SEED - have);
        vpfi.transfer(address(diamond), DIAMOND_SEED);

        InteractionRewardsFacet(address(diamond))
            .setInteractionLaunchTimestamp(block.timestamp);
        vm.warp(block.timestamp + 60 days); // many finalized past days
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    /// @dev One ARMED (ShareOfPool) day where `alice` is the whole lender side:
    ///      fresh half 1e18 against a 1e18 global ⇒ Δ = 1e18, so an entry with
    ///      `perDay = 1e18` contributes exactly 1e18 on that day. `cap` is the
    ///      D1 `(user, side, day)` ceiling.
    function _armedDay(uint256 d, uint256 cap) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0); // freshHalf = 1e18
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max); // #1008 off
        _mut().setDayCapModeRaw(d, 1); // ShareOfPool
        _mut().setDayUserSideCapRaw(d, cap);
    }

    /// @dev A pre-cutover day, priced by the legacy O(1) window product.
    function _legacyDay(uint256 d) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
    }

    /// @dev Loan-side ceiling deliberately non-binding: this suite is about the
    ///      D1 ceiling and the walk, not the #1353 loan-side cap.
    function _loanSideOpen(uint32 openDays) internal {
        _mut().setFeeEntitlementRaw(
            LOAN,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: openDays,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0,
                loanSideRewardCapOpen: type(uint128).max
            })
        );
    }

    function _entry(uint32 startDay, uint32 endDay) internal returns (uint256) {
        uint256 id = _mut().pushRewardEntry(
            alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, startDay
        );
        _mut().closeRewardEntryRaw(id, endDay);
        return id;
    }

    function _claim() internal returns (uint256 paid) {
        vm.prank(alice);
        (paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    // ── The D1 ceiling binds THROUGH the claim ───────────────────────────────

    /// @dev The point of the slice: a claim over ShareOfPool days is bounded by
    ///      the per-`(user, side, day)` ceiling, not by the raw pool share.
    ///      Each day would contribute 1e18 uncapped; the ceiling is 0.4e18.
    function test_ClaimIsBoundedByTheDailyCeilingAcrossDays() public {
        _armedDay(1, 0.4e18);
        _armedDay(2, 0.4e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3);

        assertEq(_claim(), 0.8e18, "each day trimmed to its own D1 ceiling");
    }

    // ── The owner-chosen hybrid: pre-D* days keep the O(1) product ───────────

    /// @dev A window spanning the cutover is paid by BOTH mechanisms exactly
    ///      once — the pre-`D*` day by the O(1) window product (uncapped by
    ///      D1), the armed day by the walk under its ceiling. The failure this
    ///      guards is either half being dropped or counted twice.
    ///
    ///      The legacy half is DERIVED from a control claim rather than
    ///      hardcoded: a pre-cutover day is priced from the real emission
    ///      schedule (`halfPoolForDay`), which the test cannot and should not
    ///      pin. `bob` claims the legacy day alone; `alice` claims the spanning
    ///      window. Alice must equal Bob plus exactly the armed ceiling.
    function test_SpanningWindowPaysEachRegimeExactlyOnce() public {
        _legacyDay(1); // pre-cutover, priced by the schedule
        _armedDay(2, 0.25e18); // armed, trimmed to its ceiling
        _mut().setGovernorCommitArmedFromDayRaw(2); // D* = 2
        _loanSideOpen(2);

        // Control: same shape, legacy day only.
        address bob = makeAddr("2c-bob");
        uint256 bobEntry = _mut().pushRewardEntry(
            bob, LOAN + 1, LibVaipakam.RewardSide.Lender, 1e18, 1
        );
        _mut().closeRewardEntryRaw(bobEntry, 2); // [1,2): the legacy day only

        _entry(1, 3); // alice: [1,3) spans the cutover

        vm.prank(bob);
        (uint256 legacyOnly, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewards();
        uint256 spanning = _claim();

        assertGt(legacyOnly, 0, "the control really did pay (non-vacuous)");
        assertEq(
            spanning,
            legacyOnly + 0.25e18,
            "spanning = legacy half (unchanged) + armed half (ceiling-capped)"
        );
    }

    // ── Chunking: cursors persist, no day is paid twice ─────────────────────

    /// @dev A window longer than one chunk needs repeated claims. Each pays
    ///      only the days it walked and persists its cursor, so the totals sum
    ///      to the full entitlement with nothing double-paid or skipped. The
    ///      second claim is the double-pay guard: re-walking settled days would
    ///      surface as an over-payment.
    function test_ChunkedClaimNeverPaysADayTwice() public {
        uint256 chunk = LibVaipakam.MAX_INTERACTION_CLAIM_DAYS;
        uint256 span = chunk + 5;
        _mut().setGovernorCommitArmedFromDayRaw(1);
        for (uint256 d = 1; d <= span; ) {
            _armedDay(d, 0.5e18);
            unchecked { ++d; }
        }
        _loanSideOpen(uint32(span));
        _entry(1, uint32(span + 1));

        uint256 first = _claim();
        uint256 second = _claim();

        assertEq(first, chunk * 0.5e18, "first claim walks exactly one chunk");
        assertEq(second, 5 * 0.5e18, "second finishes the remaining days");
        assertEq(first + second, span * 0.5e18, "none paid twice, none skipped");
    }

    /// @dev A day whose ceiling is already fully drawn must ADVANCE with a zero
    ///      slice rather than stalling — otherwise the walk could never get
    ///      past it and every later day would be unreachable.
    function test_ExhaustedDayAdvancesInsteadOfStalling() public {
        _armedDay(1, 0.4e18);
        _armedDay(2, 0.4e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        // Day 1's ceiling is already spent by an earlier settlement.
        _mut().setUserSideDayPaidRaw(alice, 0, 1, 0.4e18);
        _entry(1, 3);

        assertEq(_claim(), 0.4e18, "day 1 pays 0; the walk still reaches day 2");
    }

    // ── Codex #1404 round-1 regressions ─────────────────────────────────────

    /// @dev Codex #1404 **P1** — the pre-`D*` slice must be paid EXACTLY ONCE.
    ///
    ///      `_entryWindowSplit` is a pure function of the cumulative series and
    ///      the entry window; it remembers nothing about prior claims. So if the
    ///      armed tail does not finish in one call, the next claim re-entered
    ///      the deferral branch and paid the legacy slice AGAIN — every retry,
    ///      draining the fresh pool past the entry's entitlement.
    ///
    ///      Neither of the tests above caught it: the chunked one has no
    ///      pre-`D*` portion, and the spanning one claims only once. This is
    ///      the missing combination — spanning entry AND a multi-call tail.
    function test_LegacySliceIsPaidOnceAcrossRetries() public {
        uint256 chunk = LibVaipakam.MAX_INTERACTION_CLAIM_DAYS;
        uint256 lastArmed = 1 + chunk + 3; // tail deliberately exceeds one chunk
        _legacyDay(1);
        for (uint256 d = 2; d <= lastArmed; ) {
            _armedDay(d, 0.5e18);
            unchecked { ++d; }
        }
        _mut().setGovernorCommitArmedFromDayRaw(2); // D* = 2
        _loanSideOpen(uint32(lastArmed));
        _entry(1, uint32(lastArmed + 1));

        uint256 first = _claim();
        uint256 second = _claim();

        // The legacy day is priced from the real emission schedule, so it is
        // orders of magnitude larger than an armed day's 0.5e18 ceiling —
        // a re-paid legacy slice is unmistakable in `second`.
        assertGt(first, 1 ether, "first claim includes the legacy slice");
        assertEq(
            second,
            3 * 0.5e18,
            "second claim is armed-tail ONLY - no legacy re-pay"
        );
    }

    /// @dev Codex #1404 **P2** — a walk that advances only ZERO-PAY days has
    ///      still made persisted progress, so the claim must not revert and
    ///      roll those cursors back. Before the fix the "nothing to claim"
    ///      guard fired, the cursor advance was reverted, and the claimant
    ///      retried the same dust day forever — never reaching payable days
    ///      behind it.
    function test_ZeroPayWalkCommitsItsProgressInsteadOfReverting() public {
        _armedDay(1, 0); // legitimate `C == 0` dust day: pays nothing
        _armedDay(2, 0.4e18); // payable, but only reachable past day 1
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3);

        // Must NOT revert: the dust day's advance is real, persisted progress.
        uint256 paid = _claim();

        // Whether day 2 lands in this same call or the next, the claimant must
        // end up able to collect it — the failure mode is being stuck forever.
        if (paid == 0) {
            uint256 next = _claim();
            assertEq(next, 0.4e18, "the dust day did not block day 2");
        } else {
            assertEq(paid, 0.4e18, "dust day advanced; day 2 paid in-call");
        }
    }

    /// @dev Codex #1404 r2 root fix — PROVES the threaded budget rather than
    ///      arguing it. This is the case the earlier tests could not reach:
    ///      the pool driven to near-exhaustion with BOTH legs live at once —
    ///      a legacy daily-WINDOW claim and a ShareOfPool day walk.
    ///
    ///      Before the fix each leg priced itself against the full
    ///      `poolRemaining()`, so together they could commit more than the pool
    ///      held: the facet's scale-down then landed AFTER the walk had already
    ///      persisted cursors and D1 charges, permanently dropping part of one
    ///      leg while it stayed marked claimed.
    ///
    ///      The invariant that must hold no matter how the two legs divide it:
    ///      the claim can never transfer more than the pool had left, and the
    ///      cumulative paid-out counter can never exceed the 69M cap.
    function test_WindowAndWalkShareOneBudgetUnderExhaustion() public {
        _legacyDay(1); // pre-cutover -> the WINDOW leg
        _armedDay(2, 0.4e18); // armed -> the WALK leg
        _mut().setGovernorCommitArmedFromDayRaw(2);
        _loanSideOpen(2);

        // Give alice a day-1 WINDOW-leg entitlement, and an ARMED-ONLY entry.
        //
        // The entry must NOT span the cutover: a spanning entry's own
        // entry-path legacy slice would exhaust the budget on its own, in both
        // the fixed and unfixed code, and the test would prove nothing about
        // the window leg. Isolating it is what makes this discriminate.
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        _entry(2, 3); // armed day only

        // Squeeze the pool so the two legs TOGETHER cannot both be paid in full.
        uint256 cap = LibVaipakam.VPFI_INTERACTION_POOL_CAP;
        // Chosen so the walk's day WOULD fit on its own (0.4e18 <= 0.5e18) but
        // cannot once the window leg's much larger claim is accounted for. That
        // is what makes this test DISCRIMINATE: at a smaller headroom the
        // walk's own all-or-nothing rule would refuse anyway and the test would
        // pass with or without the root fix.
        uint256 headroom = 0.5e18;
        _mut().setInteractionPoolPaidOut(cap - headroom);

        uint256 balBefore = vpfi.balanceOf(alice);
        uint256 paid = _claim();
        uint256 delivered = vpfi.balanceOf(alice) - balBefore;

        assertEq(paid, delivered, "reported payout equals tokens actually moved");
        assertLe(delivered, headroom, "never transfers more than the pool held");
        // THE discriminating assertion. Without the threaded budget the walk
        // sees the full `poolRemaining()`, funds day 2 (0.4e18 fits in 0.5e18),
        // ADVANCES it and charges the D1 paid map — and only afterwards does
        // the facet scale the aggregate down, dropping value already recorded
        // as claimed. With one shared budget the window leg has already spoken
        // for the headroom, so the walk is never funded and charges nothing.
        assertEq(
            _mut().userSideDayPaidRaw(alice, 0, 2),
            0,
            "walk must not charge against headroom the window leg already spent"
        );
        assertLe(
            InteractionRewardsLensFacet(address(diamond))
                .getInteractionPoolPaidOut(),
            cap,
            "cumulative paid-out never exceeds the 69M cap"
        );
    }

    // ── The per-call day allowance is shared by BOTH sides ───────────────────

    /// @dev `MAX_INTERACTION_CLAIM_DAYS` bounds the GAS a single claim can
    ///      burn, so it has to be a per-CALL allowance. When the counter lived
    ///      inside the per-side walk, a claimant holding both lender- and
    ///      borrower-side entries got the full allowance TWICE in one
    ///      transaction — exactly double the envelope the constant exists to
    ///      cap (Codex #1404 r3).
    ///
    ///      The two sides are given DISJOINT day ranges, 20 days each, so 40
    ///      days of work exist against an allowance of 30. A shared counter
    ///      pays 30; a per-side counter pays all 40.
    function test_ClaimDayAllowanceIsSharedAcrossBothSides() public {
        uint256 perDayCap = 0.01e18;
        // Lender side owns days 1..20, borrower side days 21..40.
        for (uint256 d = 1; d <= 20; ++d) _armedLenderDay(d, perDayCap);
        for (uint256 d = 21; d <= 40; ++d) _armedBorrowerDay(d, perDayCap);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(40);

        _entry(1, 21); // lender, days 1..20
        uint256 bid = _mut().pushRewardEntry(
            alice, LOAN, LibVaipakam.RewardSide.Borrower, 1e18, 21
        );
        _mut().closeRewardEntryRaw(bid, 41); // borrower, days 21..40

        uint256 paid = _claim();

        // THE discriminating assertion: 30 days of ceiling, not 40. With a
        // per-side counter the lender walk takes its 20 and the borrower walk
        // starts a FRESH allowance, taking all 20 of its own.
        assertEq(
            paid,
            30 * perDayCap,
            "one claim must not exceed the shared per-call day allowance"
        );
        // And the overflow really is deferred, not dropped: the last borrower
        // days stay unpaid and retryable.
        assertEq(
            _mut().userSideDayPaidRaw(alice, 1, 40),
            0,
            "days beyond the allowance stay unclaimed for the next call"
        );
    }

    /// @dev Lender-side armed day. Same shape as {_armedDay}; named explicitly
    ///      now that the suite also seeds borrower-side days.
    function _armedLenderDay(uint256 d, uint256 cap) internal {
        _armedDay(d, cap);
    }

    /// @dev Borrower-side twin of {_armedDay}: the global denominator sits on
    ///      the BORROWER leg so the borrower side has a pool to share.
    function _armedBorrowerDay(uint256 d, uint256 cap) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0); // freshHalf = 1e18
        _mut().setKnownGlobalDailyInterest(d, 0, 1e18, true);
        _mut().setDayCapThreshold18(d, type(uint256).max); // #1008 off
        _mut().setDayCapModeRaw(d, 1); // ShareOfPool
        _mut().setDayUserSideCapRaw(d, cap);
    }

    // ── #1351 slice 2e — preview parity with the walk ────────────────────────

    function _preview() internal view returns (uint256 amount) {
        (amount, , ) = InteractionRewardsLensFacet(address(diamond))
            .previewInteractionRewards(alice);
    }

    /// @dev {_loanSideOpen} for an arbitrary loan id.
    function _loanSideOpenFor(uint64 loanId, uint32 openDays) internal {
        _mut().setFeeEntitlementRaw(
            loanId,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: openDays,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0,
                loanSideRewardCapOpen: type(uint128).max
            })
        );
    }

    /// @dev DISCRIMINATION (criterion 3a): two entries sharing a `(side, day)`
    ///      preview as ONE claim would pay — the D1 ceiling is per
    ///      `(user, side, day)` ACROSS entries, and the pre-2e per-entry
    ///      preview (which never saw the shared ceiling) would report ~2× the
    ///      ceiling here. The load-bearing assertion is exact equality with
    ///      the REAL claim's payout.
    function test_PreviewMatchesClaimOnASharedDay() public {
        _armedDay(1, 1e18); // ceiling 1e18; each entry alone contributes 1e18
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        uint64 LOAN2 = LOAN + 9;
        _loanSideOpenFor(LOAN2, 1);
        _entry(1, 2);
        uint256 b = _mut().pushRewardEntry(
            alice, LOAN2, LibVaipakam.RewardSide.Lender, 1e18, 1
        );
        _mut().closeRewardEntryRaw(b, 2);

        // Materialize the cumulative RPN rows the way production does before
        // any preview that matters: the funding-need path advances the side
        // cursors ({userClaimFundingNeed}); a cold view cannot, and the
        // preview then under-reports 0 by the same convention as the core.
        _mut().userClaimFundingNeedRaw(alice);
        uint256 pre = _preview();
        uint256 paid = _claim();
        assertGt(paid, 0, "the shared day genuinely pays");
        assertLt(paid, 2e18, "non-vacuous: the shared ceiling actually binds");
        assertEq(pre, paid, "preview == claim on a shared (side, day)");
    }

    /// @dev DISCRIMINATION (criterion 3b): the preview is chunk-bounded like
    ///      the claim — a long armed window previews exactly what THIS claim
    ///      call pays, and the next chunk appears only after the walk
    ///      advances. The pre-2e preview reported the whole window at once.
    function test_PreviewIsChunkBoundedLikeTheClaim() public {
        uint256 chunk = LibVaipakam.MAX_INTERACTION_CLAIM_DAYS;
        uint256 total = chunk + 10;
        for (uint256 d = 1; d <= total; d++) {
            _armedDay(d, type(uint256).max);
        }
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(uint32(total));
        _entry(1, uint32(total + 1));

        // Materialize the cumulative RPN rows the way production does before
        // any preview that matters: the funding-need path advances the side
        // cursors ({userClaimFundingNeed}); a cold view cannot, and the
        // preview then under-reports 0 by the same convention as the core.
        _mut().userClaimFundingNeedRaw(alice);
        uint256 pre = _preview();
        uint256 paid = _claim();
        assertEq(paid, chunk * 1e18, "one claim pays exactly the chunk");
        assertEq(pre, paid, "preview == this claim's chunk, not the window");

        uint256 pre2 = _preview();
        uint256 paid2 = _claim();
        assertEq(paid2, 10 * 1e18, "second claim pays the remainder");
        assertEq(pre2, paid2, "preview follows the walk's persisted cursor");
    }

    /// @dev DISCRIMINATION (criterion 3c): a window spanning `D*` previews as
    ///      the claim decomposes it — the legacy slice by the O(1) product
    ///      plus the armed days under their ceiling — with neither half
    ///      dropped nor counted twice.
    function test_PreviewMatchesClaimAcrossTheCutover() public {
        _legacyDay(1);
        _armedDay(2, 0.25e18);
        _mut().setGovernorCommitArmedFromDayRaw(2); // D* = 2
        _loanSideOpen(2);
        _entry(1, 3);

        // Materialize the cumulative RPN rows the way production does before
        // any preview that matters: the funding-need path advances the side
        // cursors ({userClaimFundingNeed}); a cold view cannot, and the
        // preview then under-reports 0 by the same convention as the core.
        _mut().userClaimFundingNeedRaw(alice);
        uint256 pre = _preview();
        uint256 paid = _claim();
        assertGt(paid, 0.25e18, "both regimes genuinely pay");
        assertEq(pre, paid, "preview == claim across the cutover");
    }

    /// @dev Codex #1410 r1 P2 — same-side entries ending on different days:
    ///      the DryRun's memory cursors have no `processed` flag, so once the
    ///      shorter entry completes, a later shared day must not re-admit it
    ///      (the primitive's window check would revert the WHOLE preview).
    ///      Against the pre-fix code this test reverts inside `_preview()`.
    function test_PreviewSurvivesStaggeredEntryEnds() public {
        _armedDay(1, type(uint256).max);
        _armedDay(2, type(uint256).max);
        _armedDay(3, type(uint256).max);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(3);
        uint64 LOAN2 = LOAN + 9;
        _loanSideOpenFor(LOAN2, 3);
        _entry(1, 2); // short: day 1 only
        uint256 longId = _mut().pushRewardEntry(
            alice, LOAN2, LibVaipakam.RewardSide.Lender, 1e18, 1
        );
        _mut().closeRewardEntryRaw(longId, 4); // long: days 1-3

        _mut().userClaimFundingNeedRaw(alice);
        uint256 pre = _preview();
        uint256 paid = _claim();
        assertGt(paid, 0, "staggered pair genuinely pays");
        assertEq(pre, paid, "preview survives a completed shorter sibling");
    }

    /// @dev Codex #1410 r1 P2 — a spanning entry whose whole remaining window
    ///      prices to ZERO is retired by the claim's entry path without ever
    ///      entering the walk, so the preview must not spend simulated day
    ///      allowance on it. Against the pre-fix code the DryRun walks the
    ///      retired entry's zero days first and crowds the real entry out of
    ///      the allowance — preview fails LOW (28 days vs the claim's 30).
    function test_PreviewSkipsEntriesTheClaimRetiresEmpty() public {
        uint256 chunk = LibVaipakam.MAX_INTERACTION_CLAIM_DAYS;
        _legacyDay(1);
        for (uint256 d = 2; d <= chunk + 4; d++) {
            _armedDay(d, type(uint256).max); // days 2..chunk+4
        }
        _mut().setGovernorCommitArmedFromDayRaw(2); // D* = 2
        _loanSideOpen(uint32(chunk + 4));
        // Zero-value spanning entry (perDay 0) over day 1 (legacy) + 2-3
        // (armed): its remaining window prices to 0 and the claim retires it.
        uint256 emptyId = _mut().pushRewardEntry(
            alice, LOAN, LibVaipakam.RewardSide.Lender, 0, 1
        );
        _mut().closeRewardEntryRaw(emptyId, 4);
        // A long all-armed entry that needs the WHOLE day allowance.
        uint64 LOAN2 = LOAN + 9;
        _loanSideOpenFor(LOAN2, uint32(chunk + 4));
        uint256 longId = _mut().pushRewardEntry(
            alice, LOAN2, LibVaipakam.RewardSide.Lender, 1e18, 4
        );
        _mut().closeRewardEntryRaw(longId, uint32(4 + chunk + 1));

        _mut().userClaimFundingNeedRaw(alice);
        uint256 pre = _preview();
        uint256 paid = _claim();
        assertEq(
            paid,
            chunk * 1e18,
            "claim spends the whole allowance on real value"
        );
        assertEq(
            pre,
            paid,
            "no allowance burnt previewing a retired-empty entry"
        );
    }

    /// @dev Codex #1410 r2 — the DryRun carries the REAL recycle bucket: a
    ///      recycled-funded day the live walk would defer (bucket short) must
    ///      not be previewed as payable. The fresh side deliberately stays
    ///      unbounded (payment-time truncation, the documented upper-bound
    ///      axis). Against the unbounded-recycled code this fails HIGH,
    ///      previewing the full recycled value the claim defers.
    function test_PreviewHonorsTheRealRecycledBucket() public {
        // One armed day funded from the RECYCLED half only.
        _mut().setDayPoolStampRaw(1, 0, uint128(2e18)); // recycledHalf 1e18
        _mut().setKnownGlobalDailyInterest(1, 1e18, 0, true);
        _mut().setDayCapThreshold18(1, type(uint256).max);
        _mut().setDayCapModeRaw(1, 1); // ShareOfPool
        _mut().setDayUserSideCapRaw(1, type(uint256).max);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(1);
        _entry(1, 2);
        _mut().userClaimFundingNeedRaw(alice);

        // Bucket ample: the day previews (non-vacuous control).
        _mut().setRecycleBucketRaw(10e18);
        assertGt(_preview(), 0, "bucket-ample control previews the day");

        // Bucket short: the live walk defers the day; so must the preview.
        _mut().setRecycleBucketRaw(0);
        assertEq(_preview(), 0, "bucket-short day is deferred, not previewed");
    }

    // ── B2-d4 (WITHDRAWN): the mirror pricing halt STAYS ─────────────────────

    /// @dev Flip this diamond to a MIRROR. `isMirrorRewardChain` is
    ///      `!isCanonical && baseChainId != 0`; this suite leaves both unset,
    ///      which is why every other test here is unaffected by mirror rules.
    function _configureMirror() internal {
        RewardReporterFacet rep = RewardReporterFacet(address(diamond));
        rep.setIsCanonicalRewardChain(false);
        rep.setBaseChainId(8453);
    }

    /// @dev #1434 P1-b — the three-phase proof that the mirror halt was
    ///      replaced by a bound that DEFERS, not one that trims.
    ///
    ///      This REPLACES `test_D4_MirrorArmedDayPricingStaysHalted`, which
    ///      was retired rather than renamed. That test delivered NO funding,
    ///      so it still passes after a correct lift (the day defers and pays
    ///      zero) — but it also passes under a bound that ALWAYS defers, and
    ///      under the halt it was written for. It could not tell the three
    ///      apart, so keeping it under a new name would have been a test that
    ///      asserts nothing about this slice.
    ///
    ///      Phases B and C are what kill the mutant this slice exists to
    ///      avoid: wiring the delivered budget into `PoolBudget.fresh` and
    ///      reusing the fresh shortfall path. That mutant TRIMS instead of
    ///      deferring, so under it phase B pays a partial amount and ADVANCES
    ///      the cursor, and phase C then finds nothing left to pay.
    ///
    ///      Same setup as `test_ClaimIsBoundedByTheDailyCeilingAcrossDays`
    ///      (which pays `0.8e18`), differing only by the mirror flags and the
    ///      delivered ledger — so the delivered bound, and nothing else, is
    ///      what moves between the phases.
    function test_P1b_MirrorArmedDayDefersUntilDelivered() public {
        _configureMirror();
        _armedDay(1, 0.4e18);
        _armedDay(2, 0.4e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3);
        _mut().userClaimFundingNeedRaw(alice);

        // ── Phase A: nothing delivered ⇒ pays nothing, charges nothing ──────
        assertEq(_preview(), 0, "A: undelivered armed days price to zero");
        assertEq(
            _mut().getArmedFreshPaidRaw(), 0, "A: and charge the bound nothing"
        );
        vm.prank(alice);
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();

        // ── Phase B: delivered, but SHORT of day 1 ⇒ STILL nothing ──────────
        //
        // The distinguishing phase. A TRIMMING implementation pays the
        // delivered 0.2e18 here and advances past day 1, permanently
        // underpaying a day whose funding was merely still in flight.
        _mut().setArmedFreshLedgerRaw(0.2e18, 0);
        assertEq(_preview(), 0, "B: a short delivery defers, never trims");
        vm.prank(alice);
        vm.expectRevert(IVaipakamErrors.NoInteractionRewardsToClaim.selector);
        RewardClaimFacet(address(diamond)).claimInteractionRewards();
        assertEq(
            _mut().getArmedFreshPaidRaw(),
            0,
            "B: a deferred day charges the bound nothing"
        );

        // ── Phase C: fully delivered ⇒ pays the canonical control's amount ──
        //
        // Equal to `test_D4_CanonicalArmedDayPricesNormally`, which is the
        // point: once funded, a mirror prices exactly as Base does. That the
        // day was DEFERRED and not TRIMMED in phase B is what makes the full
        // amount still available here.
        _mut().setArmedFreshLedgerRaw(0.8e18, 0);
        assertEq(
            _claim(),
            0.8e18,
            "C: a funded mirror pays exactly what canonical pays"
        );
        assertEq(
            _mut().getArmedFreshPaidRaw(),
            0.8e18,
            "C: and charges the delivered bound exactly what it paid"
        );
    }

    /// @dev #1434 P1-b — the OTHER half of the rule: a CAP-bound trim on a
    ///      mirror must still truncate and ADVANCE.
    ///
    ///      Delivered funding is abundant here, so the only thing that can
    ///      bind is the day's own D1 ceiling. If the implementation deferred
    ///      on ANY fresh trim rather than only on a delivered one, this claim
    ///      would pay zero and park the cursor on a condition no future
    ///      remittance can ever satisfy — the wedge that got B2-d4 withdrawn.
    ///      Payment here is the proof the two causes stayed distinguishable.
    function test_P1b_MirrorCapBoundTrimStillTruncatesAndAdvances() public {
        _configureMirror();
        _armedDay(1, 0.4e18);
        _armedDay(2, 0.4e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3);
        _mut().userClaimFundingNeedRaw(alice);

        // THE TIE, staged so the attribution line actually runs.
        //
        // Two earlier versions of this test failed to exercise it. The
        // mutated comparison only executes when a SHORTFALL exists, and a
        // shortfall needs a budget — not the D1 ceiling — to bind. So BOTH
        // budgets are pinned to the SAME figure, below what the two days want:
        //   * `poolRemaining()` -> 0.5e18 via the paid-out counter,
        //   * delivered        -> 0.5e18 via the ledger.
        // The days want 0.4e18 each. Day 1 takes its full 0.4e18; day 2 then
        // meets 0.1e18 of BOTH budgets at once — an exact tie with a real
        // 0.3e18 shortfall.
        //
        // On a tie the cap binds at the same figure as the delivered bound, so
        // no future remittance could complete day 2: it must TRUNCATE and
        // ADVANCE. Attributing the tie to DELIVERED instead would defer it
        // forever, and the totals below are what separate the two — 0.5e18
        // (truncated) versus 0.4e18 (day 2 deferred).
        uint256 tie = 0.5e18;
        _mut().setInteractionPoolPaidOut(
            LibVaipakam.VPFI_INTERACTION_POOL_CAP - tie
        );
        _mut().setArmedFreshLedgerRaw(tie, 0);

        assertEq(
            _claim(),
            tie,
            "the tie truncates and advances: day 1 in full, day 2 clipped"
        );
        assertEq(
            _mut().getArmedFreshPaidRaw(),
            tie,
            "and charges the bound exactly what it paid"
        );
    }

    /// @dev #1434 P1-b — the ENTRY-PATH question, settled by experiment.
    ///
    ///      A claim has TWO legs: `_processEntry` prices each entry's window
    ///      from the cum rows, and the ShareOfPool walk prices armed days
    ///      per-day. Only the walk consults the delivered bound, so the
    ///      obvious worry is that the entry leg pays armed fresh unbounded.
    ///
    ///      This fixture is the one that can tell: arming starts at day 2, so
    ///      the entry's window straddles it — day 1 is pre-`D*` legacy, days
    ///      2-3 are armed — with ZERO delivered funding. If the entry leg paid
    ///      armed value, this claim would exceed day 1's legacy share.
    ///
    ///      Bounding pre-`D*` fresh by delivered funding would be WRONG, note:
    ///      that value predates arming and no remittance ever funded it, so
    ///      the legacy leg paying while the armed days defer is the correct
    ///      split, not a leak.
    function test_P1b_EntryLegPaysLegacyOnly_ArmedStaysBounded() public {
        _configureMirror();
        _armedDay(1, 0.4e18);
        _armedDay(2, 0.4e18);
        _armedDay(3, 0.4e18);
        // Arming starts at day 2 — day 1 is pre-D* legacy.
        _mut().setGovernorCommitArmedFromDayRaw(2);
        _loanSideOpen(3);
        _entry(1, 4);
        _mut().userClaimFundingNeedRaw(alice);
        // Nothing delivered: every ARMED day must defer.
        _mut().setArmedFreshLedgerRaw(0, 0);

        uint256 legacyPaid = _claim();

        // (1) The armed days contributed nothing: the delivered bound was
        //     never charged. This is what would break if the entry leg paid
        //     armed value behind the walk's back.
        assertEq(
            _mut().getArmedFreshPaidRaw(),
            0,
            "no ARMED fresh is paid while nothing is delivered"
        );
        // (2) The legacy leg DID pay, and is deliberately not bounded by
        //     delivered funding. Asserting it is non-zero keeps this test
        //     honest: if the legacy leg silently stopped paying, assertion
        //     (1) alone would still hold and the test would go vacuous.
        assertGt(legacyPaid, 0, "the pre-D* legacy leg pays, unbounded");

        // (3) The armed days were DEFERRED, not consumed — so funding them
        //     later still pays. This is the assertion that distinguishes
        //     "deferred" from "paid" and from "silently dropped"; a naive
        //     upper bound on the figure in (2) cannot, because the legacy
        //     leg draws on the ordinary schedule pool rather than the armed
        //     day caps (which is what an earlier revision of this test got
        //     wrong).
        _mut().setArmedFreshLedgerRaw(100e18, 0);
        _mut().userClaimFundingNeedRaw(alice);
        assertGt(_claim(), 0, "the deferred armed days pay once funded");
        assertGt(
            _mut().getArmedFreshPaidRaw(),
            0,
            "and only THEN is the delivered bound charged"
        );
    }

    /// @dev #1434 P1-b — with NO arming set, a mirror's ordinary payouts must
    ///      leave the armed-paid ledger untouched.
    ///
    ///      Read what this does and does NOT prove. It does NOT prove the
    ///      walk's `_isArmedDay` filter is load-bearing; an earlier version of
    ///      this comment claimed exactly that and was wrong. With
    ///      `governorCommitArmedFromDay == 0` the ShareOfPool walk returns
    ///      before doing anything, so the whole payout below comes from the
    ///      ENTRY path. Both the filter and the unarmed-day exemption are
    ///      equivalent mutants — a mutation run measured byte-identical gas
    ///      with each removed — because no unarmed day can ever reach the
    ///      walk (early return with no arming; cursor floored at `armedFrom`
    ///      otherwise). Do not "strengthen" this test to kill them; it can't,
    ///      and neither can any other.
    ///
    ///      What it DOES pin is still worth having: on an un-armed mirror the
    ///      entry path pays normally (`paid` is large here) while
    ///      `rewardBudgetArmedFreshPaid` stays exactly zero. That ledger is
    ///      mirror-era armed spending only, and a chain with no arming has
    ///      none — the property that keeps `deliveredFreshBound` from
    ///      flooring at zero and bricking the chain.
    function test_P1b_UnarmedDayFreshNeverChargesTheDeliveredBound() public {
        _configureMirror();
        // Days are FINALIZED but arming is never set, so `_isArmedDay` is
        // false for both: ordinary schedule days, which is the whole point.
        _armedDay(1, 0.4e18);
        _armedDay(2, 0.4e18);
        // ShareOfPool mode WITHOUT local arming — the shape a mirror really
        // can hold, since `RewardReporterFacet`'s broadcast ingress stamps the
        // mode straight from the wire's `capMode` with no arming guard (only
        // the canonical-side stamp checks `armed`). It does NOT make the walk
        // filter testable: the cap mode is irrelevant while
        // `governorCommitArmedFromDay` is zero, because the walk returns
        // before reading it. Setting it here documents the reachable state,
        // nothing more.
        _mut().setDayCapModeRaw(1, 1);
        _mut().setDayCapModeRaw(2, 1);
        // The delivered bound is ZERO, not merely generous. An earlier
        // revision funded it at 100e18 against a sub-1e18 payout, so the
        // bound could never bind and BOTH the exemption and the paid-side
        // `_isArmedDay` filter were unobservable — the test passed whether
        // or not either existed. At zero, an unarmed day that wrongly
        // consulted the bound would find nothing and DEFER, so `paid`
        // collapsing to zero is what proves the exemption is load-bearing.
        _mut().setArmedFreshLedgerRaw(0, 0);
        _loanSideOpen(2);
        _entry(1, 3);
        _mut().userClaimFundingNeedRaw(alice);

        uint256 paid = _claim();

        assertGt(paid, 0, "LIVE: the unarmed days genuinely paid");
        assertEq(
            _mut().getArmedFreshPaidRaw(),
            0,
            "ordinary-day fresh never charges the delivered bound"
        );
    }

    /// @dev #1434 P1-b — the preview and the claim must AGREE on a mirror.
    ///
    ///      The dry-run preview reads the delivered bound for the same reason
    ///      the walk does. An earlier revision left it unbounded, reasoning
    ///      that a preview is allowed to be an upper bound — but that licence
    ///      only holds where a shortfall TRIMS a payout the claimant still
    ///      receives. A delivered shortfall DEFERS to zero, so an unbounded
    ///      preview quotes the full amount against a claim that reverts. This
    ///      pins the agreement in both directions.
    function test_P1b_PreviewAgreesWithClaimOnAMirror() public {
        _configureMirror();
        _armedDay(1, 0.4e18);
        _armedDay(2, 0.4e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3);
        _mut().userClaimFundingNeedRaw(alice);

        // Unfunded: preview must say zero, matching a claim that cannot pay.
        assertEq(_preview(), 0, "unfunded: preview quotes nothing");

        // Funded: preview must quote what the claim then actually pays.
        _mut().setArmedFreshLedgerRaw(0.8e18, 0);
        uint256 quoted = _preview();
        assertEq(quoted, 0.8e18, "funded: preview quotes the payable amount");
        assertEq(_claim(), quoted, "and the claim pays exactly that");
    }

    /// @dev #1434 P1-b (Codex #1699 r1 P1) — the delivered bound must DEPLETE
    ///      across days within a single claim, not just across transactions.
    ///
    ///      The bound is read ONCE when the walk builds its `PoolBudget`. The
    ///      first revision decremented only `ctx.pool.fresh` per settled day,
    ///      so every day in the same claim was measured against the ORIGINAL
    ///      delivered allowance: two 0.4 days against 0.5 delivered each
    ///      passed their own check and 0.8 transferred, drawing the excess
    ///      from custody held for other obligations.
    ///
    ///      This is the same defect the note above `_walkShareOfPoolDays`
    ///      records for the 69M pool — a leg pricing against an allowance a
    ///      sibling leg has already spoken for. `ctx.pool.fresh` is threaded
    ///      for exactly that reason; the delivered bound now is too.
    function test_P1b_DeliveredBoundDepletesAcrossDaysInOneClaim() public {
        _configureMirror();
        _armedDay(1, 0.4e18);
        _armedDay(2, 0.4e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3);
        _mut().userClaimFundingNeedRaw(alice);

        // Enough for EITHER day alone, not for BOTH: the aggregate is what
        // an un-depleted bound fails to notice.
        _mut().setArmedFreshLedgerRaw(0.5e18, 0);

        uint256 paid = _claim();

        assertLe(
            paid,
            0.5e18,
            "a claim never pays out more armed fresh than was delivered"
        );
        assertLe(
            _mut().getArmedFreshPaidRaw(),
            0.5e18,
            "and the charge never exceeds the delivered figure either"
        );
        assertGt(paid, 0, "LIVE: the funded day did pay");
    }

    /// @dev The CANONICAL chain is unaffected by the halt and prices its own
    ///      armed days normally — the control proving the test above isolates
    ///      the mirror flags rather than a broken setup.
    function test_D4_CanonicalArmedDayPricesNormally() public {
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(true);
        RewardReporterFacet(address(diamond)).setBaseChainId(8453);
        _armedDay(1, 0.4e18);
        _armedDay(2, 0.4e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3);

        assertEq(
            _claim(),
            0.8e18,
            "canonical prices its own armed days, trimmed to each D1 ceiling"
        );
    }
}
