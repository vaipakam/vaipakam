// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title InteractionRewardsCoverageTest
/// @notice Exhaustive coverage for the platform-interaction reward surface
///         (docs/TokenomicsTechSpec.md §4). Exercises:
///           - single-day single-user happy path
///           - proportional USD-share split across two lenders
///           - 50/50 lender vs borrower half-pool split
///           - MAX_INTERACTION_CLAIM_DAYS windowing (claim walks at most 30
///             finalized days in one tx, rest claimable in a follow-up)
///           - pool-cap truncation (pending > remaining → paid = remaining)
///           - pool-exhausted revert once paidOut == 69M
///           - preview matches realized payout exactly
///           - claim is idempotent (per-user counters deleted on walk)
///
///         Per-day USD counters are pre-seeded via {TestMutatorFacet.setDailyXXX}
///         to avoid the full OfferFacet + RepayFacet E2E on every test — the
///         E2E wiring is covered separately in VPFIDiscountFacetTest and the
///         Scenario* suites.
///
///         Day-0 quirk: `interactionLastClaimedDay[user] == 0` is the
///         never-claimed sentinel, so day 0 itself is inherently un-claimable.
///         All tests seed rewards starting at day 1.
contract InteractionRewardsCoverageTest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    InteractionRewardsFacet internal interactionFacet;

    uint256 internal constant DIAMOND_SEED = 100_000_000 ether; // ≥ 69M cap + slack

    address internal alice;
    address internal bob;

    function setUp() public {
        setupHelper();

        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfi = VPFIToken(address(proxy));

        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));

        uint256 have = vpfi.balanceOf(address(this));
        if (DIAMOND_SEED > have) vpfi.mint(address(this), DIAMOND_SEED - have);
        vpfi.transfer(address(diamond), DIAMOND_SEED);

        interactionFacet = new InteractionRewardsFacet();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(interactionFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getInteractionRewardsFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        alice = makeAddr("alice");
        bob = makeAddr("bob");

        _facet().setInteractionLaunchTimestamp(block.timestamp);
    }

    function _facet() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _halfPool(uint256 day) internal view returns (uint256) {
        return _facet().getInteractionHalfPoolForDay(day);
    }

    // ─── Happy paths ─────────────────────────────────────────────────────────

    function testSingleLenderClaimsEntireHalfPoolForDay() public {
        // Alice is the only lender on day 1 with $100 interest.
        _mut().setDailyLenderInterest(1, alice, 100e18, 100e18);

        // Need today ≥ 2 so day 1 is finalized AND cursor-sentinel of 0
        // doesn't collide with the requested day.
        vm.warp(block.timestamp + 2 days + 1);

        uint256 preview = _previewAmount(alice);
        uint256 expected = _halfPool(1);
        assertEq(preview, expected, "preview == halfPool(1)");

        uint256 balBefore = vpfi.balanceOf(alice);
        vm.prank(alice);
        (uint256 paid, uint256 fromDay, uint256 toDay) = _facet().claimInteractionRewards();

        assertEq(paid, expected, "paid == halfPool(1)");
        assertEq(fromDay, 1, "window starts after the never-claimed sentinel");
        assertEq(toDay, 1, "single-day claim");
        assertEq(vpfi.balanceOf(alice), balBefore + paid, "transfer landed");
    }

    function testTwoLendersSplitHalfPoolByUSDShare() public {
        _mut().setDailyLenderInterest(1, alice, 70e18, 100e18);
        _mut().setDailyLenderInterest(1, bob, 30e18, 100e18);

        vm.warp(block.timestamp + 2 days + 1);

        uint256 half = _halfPool(1);
        uint256 expectedA = (half * 70e18) / 100e18;
        uint256 expectedB = (half * 30e18) / 100e18;

        vm.prank(alice);
        (uint256 paidA,,) = _facet().claimInteractionRewards();
        vm.prank(bob);
        (uint256 paidB,,) = _facet().claimInteractionRewards();

        assertEq(paidA, expectedA, "alice 70% share");
        assertEq(paidB, expectedB, "bob 30% share");
        // Integer division at 70/30 can leave up to 1 wei of dust.
        assertApproxEqAbs(paidA + paidB, half, 1, "paid sums to half-pool");
    }

    function testLenderAndBorrowerHalvesBothEarned() public {
        // Alice is the sole lender AND the sole borrower on day 1 — she
        // owns 100% of both sides, so she claims the full daily pool
        // (= 2 × halfPool).
        _mut().setDailyLenderInterest(1, alice, 50e18, 50e18);
        _mut().setDailyBorrowerInterest(1, alice, 50e18, 50e18);

        vm.warp(block.timestamp + 2 days + 1);

        uint256 expected = _halfPool(1) * 2;
        vm.prank(alice);
        (uint256 paid,,) = _facet().claimInteractionRewards();
        assertEq(paid, expected, "both halves combined");
    }

    function testPreviewMatchesRealizedPayout() public {
        _mut().setDailyLenderInterest(1, alice, 10e18, 10e18);
        _mut().setDailyLenderInterest(2, alice, 20e18, 20e18);
        _mut().setDailyLenderInterest(3, alice, 30e18, 30e18);
        vm.warp(block.timestamp + 4 days + 1);

        uint256 preview = _previewAmount(alice);
        vm.prank(alice);
        (uint256 paid,,) = _facet().claimInteractionRewards();
        assertEq(paid, preview, "preview == paid");
    }

    // ─── Windowing ───────────────────────────────────────────────────────────

    function testClaimWindowBoundedByMaxDays() public {
        // Seed 35 days of credits starting at day 1, warp past day 35, claim.
        uint256 half0 = _halfPool(1); // same rate through day 182
        for (uint256 d = 1; d <= 35; d++) {
            _mut().setDailyLenderInterest(d, alice, 1e18, 1e18);
        }
        vm.warp(block.timestamp + 36 days + 1);

        vm.prank(alice);
        (uint256 paid1, uint256 from1, uint256 to1) = _facet().claimInteractionRewards();
        assertEq(from1, 1, "first window starts at 1");
        assertEq(to1, LibVaipakam.MAX_INTERACTION_CLAIM_DAYS, "first window ends at day MAX");
        assertEq(paid1, half0 * LibVaipakam.MAX_INTERACTION_CLAIM_DAYS, "first batch = 30 days");

        vm.prank(alice);
        (uint256 paid2, uint256 from2, uint256 to2) = _facet().claimInteractionRewards();
        assertEq(from2, LibVaipakam.MAX_INTERACTION_CLAIM_DAYS + 1, "second window starts at 31");
        assertEq(to2, 35, "up to day 35");
        assertEq(paid2, half0 * 5, "second batch covers 5 days");
    }

    function testClaimRevertsWhenCursorEqualsLastFinalized() public {
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        vm.warp(block.timestamp + 2 days + 1);

        vm.prank(alice);
        _facet().claimInteractionRewards(); // advances cursor to 1

        vm.prank(alice);
        vm.expectRevert(NoInteractionRewardsToClaim.selector);
        _facet().claimInteractionRewards(); // last=1, lastFinalized=1 → revert
    }

    // ─── Pool-cap enforcement ────────────────────────────────────────────────

    function testClaimTruncatedByRemainingPoolBalance() public {
        uint256 cap = LibVaipakam.VPFI_INTERACTION_POOL_CAP;
        _mut().setInteractionPoolPaidOut(cap - 1 ether);

        _mut().setDailyLenderInterest(1, alice, 10e18, 10e18);
        vm.warp(block.timestamp + 2 days + 1);

        uint256 balBefore = vpfi.balanceOf(alice);
        vm.prank(alice);
        (uint256 paid,,) = _facet().claimInteractionRewards();

        assertEq(paid, 1 ether, "truncated to remaining");
        assertEq(vpfi.balanceOf(alice), balBefore + 1 ether, "transfer matches truncation");
        assertEq(_facet().getInteractionPoolPaidOut(), cap, "paidOut == cap");
        assertEq(_facet().getInteractionPoolRemaining(), 0, "pool exhausted");
    }

    function testClaimRevertsWhenPoolExhausted() public {
        _mut().setInteractionPoolPaidOut(LibVaipakam.VPFI_INTERACTION_POOL_CAP);

        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        vm.warp(block.timestamp + 2 days + 1);

        vm.prank(alice);
        vm.expectRevert(InteractionPoolExhausted.selector);
        _facet().claimInteractionRewards();
    }

    // ─── Idempotency / state hygiene ─────────────────────────────────────────

    function testClaimDeletesUserCountersButRetainsTotals() public {
        _mut().setDailyLenderInterest(1, alice, 40e18, 100e18);
        _mut().setDailyLenderInterest(1, bob, 60e18, 100e18);
        vm.warp(block.timestamp + 2 days + 1);

        vm.prank(alice);
        _facet().claimInteractionRewards();

        (uint256 userL, , uint256 totalL, ) = _facet().getInteractionDayEntry(1, alice);
        assertEq(userL, 0, "alice counter cleared");
        assertEq(totalL, 100e18, "total preserved for bob's claim");

        vm.prank(bob);
        (uint256 paidB,,) = _facet().claimInteractionRewards();
        assertEq(paidB, (_halfPool(1) * 60e18) / 100e18, "bob's slice intact");
    }

    // ─── Schedule bands ──────────────────────────────────────────────────────

    function testClaimAcrossBandBoundaryUsesPerDayRate() public {
        // Day 182 rate = 3200 bps, day 183 rate = 2900 bps. Cursor at 181
        // so the first claimed day is 182 (boundary of band 0).
        _mut().setInteractionLastClaimedDay(alice, 181);
        _mut().setDailyLenderInterest(182, alice, 1e18, 1e18);
        _mut().setDailyLenderInterest(183, alice, 1e18, 1e18);

        vm.warp(block.timestamp + 184 days + 1);

        vm.prank(alice);
        (uint256 paid, uint256 fromDay, uint256 toDay) = _facet().claimInteractionRewards();
        assertEq(fromDay, 182, "window starts right after cursor");
        assertEq(toDay, 183, "covers both sides of the band boundary");
        assertEq(paid, _halfPool(182) + _halfPool(183), "per-day rates respected");
    }

    // ─── §4a finalization gate ───────────────────────────────────────────────
    //
    // docs/TokenomicsTechSpec.md §4a: claims must wait for the finalized
    // global denominator broadcast from the Base aggregator. There is NO
    // local fallback. The gate is implemented by {LibInteractionRewards
    // .clampToFinalized}; these tests exercise the positive + negative
    // paths end-to-end through the facet.

    /// @notice Credits exist on day 1, but the cross-chain broadcast hasn't
    ///         landed (`knownGlobalSet[1] == false`). Claim must revert
    ///         with the typed wait error so the frontend can explain it.
    function testClaimRevertsWhenFirstDayNotFinalized() public {
        _mut().setDailyLenderInterest(1, alice, 10e18, 10e18);
        // Roll back the auto-finalization the seeder applied so we can
        // exercise the pre-broadcast state.
        _mut().setKnownGlobalSet(1, false);

        vm.warp(block.timestamp + 2 days + 1);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(InteractionDayGlobalNotFinalized.selector, 1)
        );
        _facet().claimInteractionRewards();
    }

    /// @notice Preview must mirror the claim gate — return all-zeros while
    ///         `fromDay` is still unfinalized so the UI can show "waiting"
    ///         rather than a misleading zero "nothing to claim".
    function testPreviewReturnsZeroWhenFirstDayNotFinalized() public {
        _mut().setDailyLenderInterest(1, alice, 10e18, 10e18);
        _mut().setKnownGlobalSet(1, false);
        vm.warp(block.timestamp + 2 days + 1);

        (uint256 amount, uint256 fromDay, uint256 toDay) = _facet()
            .previewInteractionRewards(alice);
        assertEq(amount, 0, "preview amount zeroed");
        assertEq(fromDay, 0, "fromDay zeroed");
        assertEq(toDay, 0, "toDay zeroed");
    }

    /// @notice Days 1,2,3 have credits but only 1,2 are finalized. Claim
    ///         must walk the contiguous finalized prefix (1..2), advance
    ///         the cursor to 2, and leave day 3's credits intact for a
    ///         follow-up claim once the broadcast lands.
    function testClaimClampsToContiguousFinalizedPrefix() public {
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        _mut().setDailyLenderInterest(2, alice, 1e18, 1e18);
        _mut().setDailyLenderInterest(3, alice, 1e18, 1e18);
        // Day 3 has NOT yet been broadcast — pretend the mirror hop is late.
        _mut().setKnownGlobalSet(3, false);

        vm.warp(block.timestamp + 4 days + 1);

        uint256 expected = _halfPool(1) + _halfPool(2);
        vm.prank(alice);
        (uint256 paid, uint256 fromDay, uint256 toDay) = _facet()
            .claimInteractionRewards();

        assertEq(fromDay, 1, "walk starts at 1");
        assertEq(toDay, 2, "walk stops at last finalized day");
        assertEq(paid, expected, "only finalized prefix was paid");
        assertEq(
            _facet().getInteractionLastClaimedDay(alice),
            2,
            "cursor advanced to effectiveTo"
        );

        // Day 3's per-user counter must still be intact for the catch-up.
        (uint256 userL, , , ) = _facet().getInteractionDayEntry(3, alice);
        assertEq(userL, 1e18, "day-3 credit preserved for catch-up claim");
    }

    /// @notice After the missing day's broadcast lands, the user's next
    ///         claim picks up the gap and walks forward from the updated
    ///         cursor. Matches the operational story of a delayed mirror
    ///         hop catching up.
    function testClaimPicksUpAfterHoleIsFinalized() public {
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        _mut().setDailyLenderInterest(2, alice, 1e18, 1e18);
        _mut().setDailyLenderInterest(3, alice, 1e18, 1e18);
        _mut().setKnownGlobalSet(3, false);

        vm.warp(block.timestamp + 4 days + 1);

        // First claim: cursor 0 → 2, pays halfPool(1)+halfPool(2).
        vm.prank(alice);
        _facet().claimInteractionRewards();

        // Now pretend the day-3 broadcast lands. Alice claims again.
        _mut().setKnownGlobalDailyInterest(3, 1e18, 0, true);

        vm.prank(alice);
        (uint256 paid2, uint256 from2, uint256 to2) = _facet()
            .claimInteractionRewards();
        assertEq(from2, 3, "window restarts right after old cursor");
        assertEq(to2, 3, "only the newly finalized day");
        assertEq(paid2, _halfPool(3), "catch-up payout matches half-pool(3)");
        assertEq(
            _facet().getInteractionLastClaimedDay(alice),
            3,
            "cursor advanced to the new tip"
        );
    }

    /// @notice Preview reflects the same contiguous-finalized-prefix
    ///         clamp the live claim applies, so the UI value never
    ///         promises more VPFI than the claim would actually pay.
    function testPreviewReflectsContiguousFinalizedPrefix() public {
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        _mut().setDailyLenderInterest(2, alice, 1e18, 1e18);
        _mut().setDailyLenderInterest(3, alice, 1e18, 1e18);
        _mut().setKnownGlobalSet(3, false);

        vm.warp(block.timestamp + 4 days + 1);

        (uint256 amount, uint256 fromDay, uint256 toDay) = _facet()
            .previewInteractionRewards(alice);
        assertEq(fromDay, 1, "preview fromDay starts at 1");
        assertEq(toDay, 2, "preview toDay stops at last finalized");
        assertEq(amount, _halfPool(1) + _halfPool(2), "preview amount matches walk");
    }

    /// @notice A non-contiguous hole (days 1,2 finalized, day 3 missing,
    ///         days 4,5 finalized) must NOT let the claim skip over the
    ///         gap — the spec commits to strict contiguity from `fromDay`.
    function testClampDoesNotSkipOverHoles() public {
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        _mut().setDailyLenderInterest(2, alice, 1e18, 1e18);
        _mut().setDailyLenderInterest(3, alice, 1e18, 1e18);
        _mut().setDailyLenderInterest(4, alice, 1e18, 1e18);
        _mut().setDailyLenderInterest(5, alice, 1e18, 1e18);
        _mut().setKnownGlobalSet(3, false);

        vm.warp(block.timestamp + 6 days + 1);

        vm.prank(alice);
        (uint256 paid, uint256 fromDay, uint256 toDay) = _facet()
            .claimInteractionRewards();

        assertEq(fromDay, 1, "walk starts at cursor + 1");
        assertEq(toDay, 2, "walk stops AT the gap, not past it");
        assertEq(paid, _halfPool(1) + _halfPool(2), "gap not skipped");

        // Day 4 + 5 credits preserved — they'll claim once day 3 is broadcast.
        (uint256 u4, , , ) = _facet().getInteractionDayEntry(4, alice);
        (uint256 u5, , , ) = _facet().getInteractionDayEntry(5, alice);
        assertEq(u4, 1e18, "day 4 credit preserved past the gap");
        assertEq(u5, 1e18, "day 5 credit preserved past the gap");
    }

    /// @notice Claimability view exposes the §4a gate explicitly so
    ///         frontends can render the "waiting for broadcast" state
    ///         without a second round-trip.
    function testClaimabilityFlagsWaitingState() public {
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        _mut().setKnownGlobalSet(1, false);
        vm.warp(block.timestamp + 2 days + 1);

        (
            uint256 fromDay,
            uint256 windowToDay,
            uint256 effectiveTo,
            bool finalizedPrefix,
            uint256 waitingForDay
        ) = _facet().getInteractionClaimability(alice);
        assertEq(fromDay, 1, "fromDay on the cursor");
        assertEq(windowToDay, 1, "window bounded by lastFinalized");
        assertEq(effectiveTo, 0, "no finalized day yet");
        assertFalse(finalizedPrefix, "gate is closed");
        assertEq(waitingForDay, 1, "waiting on day 1 broadcast");
    }

    /// @notice Once the broadcast lands, the claimability view flips to
    ///         the ready state.
    function testClaimabilityFlagsReadyState() public {
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        vm.warp(block.timestamp + 2 days + 1);

        (
            uint256 fromDay,
            uint256 windowToDay,
            uint256 effectiveTo,
            bool finalizedPrefix,
            uint256 waitingForDay
        ) = _facet().getInteractionClaimability(alice);
        assertEq(fromDay, 1, "fromDay = 1");
        assertEq(windowToDay, 1, "windowToDay = 1");
        assertEq(effectiveTo, 1, "effectiveTo = 1");
        assertTrue(finalizedPrefix, "gate is open");
        assertEq(waitingForDay, 0, "no wait reason");
    }

    /// @notice Before launch, the view must return all zeros / false so
    ///         the UI renders the "not started" path without needing a
    ///         separate `getInteractionLaunchTimestamp` round-trip.
    function testClaimabilityBeforeLaunchReturnsZeros() public {
        // Fresh diamond has the launch set by setUp(). Reach into storage
        // via the mutator's cursor setter to simulate "no credits yet" by
        // just querying an address that never participated.
        (
            uint256 fromDay,
            uint256 windowToDay,
            uint256 effectiveTo,
            bool finalizedPrefix,
            uint256 waitingForDay
        ) = _facet().getInteractionClaimability(alice);
        // Launch was set but we haven't warped — today = 0 → all zeros.
        assertEq(fromDay, 0, "fromDay zero pre-finalized-day-1");
        assertEq(windowToDay, 0, "windowToDay zero");
        assertEq(effectiveTo, 0, "effectiveTo zero");
        assertFalse(finalizedPrefix, "not ready");
        assertEq(waitingForDay, 0, "no wait reason yet");
    }

    // ─── getUserRewardEntries view ───────────────────────────────────────────

    /// @dev Empty-state contract: a fresh address with no entries returns an
    ///      empty array (not a revert), so the view is safe to call eagerly
    ///      from frontends without first checking participation.
    function testGetUserRewardEntriesEmptyForFreshAddress() public {
        address fresh = makeAddr("fresh");
        LibVaipakam.RewardEntry[] memory entries = _facet().getUserRewardEntries(fresh);
        assertEq(entries.length, 0, "no entries for never-participated user");
    }

    /// @dev Populated state: pushing two entries (lender + borrower side of
    ///      the same loan) materialises both back through the view, with
    ///      every recorded field intact. Drives the bookkeeping via the
    ///      TestMutatorFacet `pushRewardEntry` helper rather than the full
    ///      LoanFacet.initiateLoan E2E — the view is a thin wrapper over
    ///      storage so this exercises the read path's correctness without
    ///      retesting registerLoan's write path (covered elsewhere).
    function testGetUserRewardEntriesReturnsLenderAndBorrowerSides() public {
        // Loan 42: alice as lender (5 USD/day), bob as borrower (5 USD/day).
        _mut().pushRewardEntry(
            alice,
            42,
            LibVaipakam.RewardSide.Lender,
            5e18,
            uint32(1)
        );
        _mut().pushRewardEntry(
            bob,
            42,
            LibVaipakam.RewardSide.Borrower,
            5e18,
            uint32(1)
        );

        LibVaipakam.RewardEntry[] memory aliceEntries = _facet().getUserRewardEntries(alice);
        LibVaipakam.RewardEntry[] memory bobEntries = _facet().getUserRewardEntries(bob);

        assertEq(aliceEntries.length, 1, "alice has one entry (lender side of loan 42)");
        assertEq(aliceEntries[0].loanId, 42);
        assertEq(uint8(aliceEntries[0].side), uint8(LibVaipakam.RewardSide.Lender));
        assertEq(aliceEntries[0].perDayUSD18, 5e18);
        assertEq(aliceEntries[0].startDay, 1);
        assertEq(aliceEntries[0].endDay, 0, "still open");

        assertEq(bobEntries.length, 1, "bob has one entry (borrower side of loan 42)");
        assertEq(bobEntries[0].loanId, 42);
        assertEq(uint8(bobEntries[0].side), uint8(LibVaipakam.RewardSide.Borrower));
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _previewAmount(address user) internal view returns (uint256 amount) {
        (amount,,) = _facet().previewInteractionRewards(user);
    }
}
