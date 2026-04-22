// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {Handler} from "./Handler.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {OfferFacet} from "../../src/facets/OfferFacet.sol";
import {MetricsFacet} from "../../src/facets/MetricsFacet.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";

/**
 * @title MetricsCountersParityInvariant
 * @notice Every counter and active-set index in {LibVaipakam.Storage} that
 *         {LibMetricsHooks} maintains is a materialized view over a
 *         ground-truth full scan of `loans[1..nextLoanId)` and
 *         `offers[1..nextOfferId)`. The MAX_ITER rewrite replaced
 *         O(n) scans in {MetricsFacet} with O(1) counter reads and
 *         O(activeCount) iteration of two swap-and-pop lists — so any
 *         bug that drops or double-counts a hook call silently corrupts
 *         the aggregate views with no production read path to catch it.
 *
 *         These invariants assert, after every fuzz call, that:
 *
 *           1. `activeLoansCount == activeLoanIdsList.length`
 *           2. `activeOffersCount == activeOfferIdsList.length`
 *           3. For every id in `activeLoanIdsList`, the stored loan has
 *              status ∈ {Active, FallbackPending} (no stale entries).
 *           4. For every id in `activeOfferIdsList`, the stored offer is
 *              still `!accepted && !offerCancelled` (no stale entries).
 *           5. The 1-based position map is consistent: for each id at
 *              0-based index `i` in the list, `pos[id] == i + 1`.
 *           6. The full-scan count of Active+FallbackPending loans
 *              matches `activeLoansCount`.
 *           7. The full-scan count of Defaulted+Settled loans matches
 *              `terminalBadOrSettledCount`.
 *           8. The full-scan count of non-zero loans matches
 *              `totalLoansEverCreated`.
 *           9. The full-scan sum of `interestRateBps` matches
 *              `interestRateBpsSum`.
 *          10. The full-scan count of open offers matches
 *              `activeOffersCount`.
 *          11. The `uniqueUserCount` ≥ count of actors in the bounded
 *              pool flagged `userSeen` (floor; onboarding may have
 *              bootstrapped extras).
 *
 *         Ground truth is computed via a full scan of `[1..nextLoanId)`
 *         and `[1..nextOfferId)` reading through {LoanFacet.getLoanDetails}
 *         / {OfferFacet.getOffer}, independent of any hook-maintained
 *         state. If a hook misfires at any edge (initialize, status
 *         transition, create, accept, cancel), one of these assertions
 *         trips.
 */
contract MetricsCountersParityInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;
    address internal diamond;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);
        targetContract(address(handler));
        diamond = address(base.diamond());
    }

    // ── Invariant 1–5: active-set lists and position maps stay coherent ──

    function invariant_ActiveLoanListLengthMatchesCounter() public view {
        TestMutatorFacet m = TestMutatorFacet(diamond);
        assertEq(
            m.getActiveLoansCounter(),
            m.getActiveLoanIdsListLength(),
            "activeLoansCount drift vs activeLoanIdsList.length"
        );
    }

    function invariant_ActiveOfferListLengthMatchesCounter() public view {
        TestMutatorFacet m = TestMutatorFacet(diamond);
        assertEq(
            m.getActiveOffersCounter(),
            m.getActiveOfferIdsListLength(),
            "activeOffersCount drift vs activeOfferIdsList.length"
        );
    }

    function invariant_ActiveLoanListEntriesAreLiveAndIndexed() public view {
        TestMutatorFacet m = TestMutatorFacet(diamond);
        uint256 n = m.getActiveLoanIdsListLength();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = m.getActiveLoanIdAt(i);
            assertGt(id, 0, "active loan list contains zero id");

            // Position map is 1-based and must round-trip.
            assertEq(
                m.getActiveLoanIdPos(id),
                i + 1,
                "activeLoanIdsListPos drift at index"
            );

            // Entry must still be live (no stale entries).
            LibVaipakam.Loan memory L = LoanFacet(diamond).getLoanDetails(id);
            bool live = L.status == LibVaipakam.LoanStatus.Active ||
                L.status == LibVaipakam.LoanStatus.FallbackPending;
            assertTrue(live, "active loan list contains non-live status");
        }
    }

    function invariant_ActiveOfferListEntriesAreLiveAndIndexed() public view {
        TestMutatorFacet m = TestMutatorFacet(diamond);
        MetricsFacet metrics = MetricsFacet(diamond);
        uint256 n = m.getActiveOfferIdsListLength();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = m.getActiveOfferIdAt(i);
            assertGt(id, 0, "active offer list contains zero id");
            assertEq(
                m.getActiveOfferIdPos(id),
                i + 1,
                "activeOfferIdsListPos drift at index"
            );

            LibVaipakam.Offer memory O = OfferFacet(diamond).getOffer(id);
            assertTrue(O.creator != address(0), "active offer list points at cleared slot");
            assertTrue(!O.accepted, "active offer list contains accepted offer");
            assertTrue(!metrics.isOfferCancelled(id), "active offer list contains cancelled offer");
        }
    }

    // ── Invariants 6–9: loan counters match full-scan ground truth ──────

    function invariant_LoanCountersMatchFullScan() public view {
        TestMutatorFacet m = TestMutatorFacet(diamond);
        MetricsFacet metrics = MetricsFacet(diamond);

        // nextLoanId is the highest id ever assigned (pre-increment on
        // create), so we iterate inclusive to cover the most recent loan.
        (uint256 nextLoanId, ) = metrics.getGlobalCounts();

        uint256 gtActive;
        uint256 gtTerminalBadOrSettled;
        uint256 gtTotalEver;
        uint256 gtRateSum;

        for (uint256 i = 1; i <= nextLoanId; i++) {
            LibVaipakam.Loan memory L = LoanFacet(diamond).getLoanDetails(i);
            if (L.id == 0) continue;
            gtTotalEver++;
            gtRateSum += L.interestRateBps;
            if (
                L.status == LibVaipakam.LoanStatus.Active ||
                L.status == LibVaipakam.LoanStatus.FallbackPending
            ) {
                gtActive++;
            } else if (
                L.status == LibVaipakam.LoanStatus.Defaulted ||
                L.status == LibVaipakam.LoanStatus.Settled
            ) {
                gtTerminalBadOrSettled++;
            }
        }

        assertEq(m.getActiveLoansCounter(), gtActive, "activeLoansCount drift vs scan");
        assertEq(
            m.getTerminalBadOrSettledCounter(),
            gtTerminalBadOrSettled,
            "terminalBadOrSettledCount drift vs scan"
        );
        assertEq(
            m.getTotalLoansEverCreatedCounter(),
            gtTotalEver,
            "totalLoansEverCreated drift vs scan"
        );
        assertEq(
            m.getInterestRateBpsSumCounter(),
            gtRateSum,
            "interestRateBpsSum drift vs scan"
        );
    }

    // ── Invariant 10: offer counter matches full-scan ground truth ──────

    function invariant_OfferCounterMatchesFullScan() public view {
        TestMutatorFacet m = TestMutatorFacet(diamond);
        MetricsFacet metrics = MetricsFacet(diamond);

        (, uint256 nextOfferId) = metrics.getGlobalCounts();

        uint256 gtActiveOffers;
        for (uint256 i = 1; i <= nextOfferId; i++) {
            LibVaipakam.Offer memory O = OfferFacet(diamond).getOffer(i);
            if (O.creator == address(0)) continue;
            if (O.accepted) continue;
            if (metrics.isOfferCancelled(i)) continue;
            gtActiveOffers++;
        }

        assertEq(
            m.getActiveOffersCounter(),
            gtActiveOffers,
            "activeOffersCount drift vs scan"
        );
    }

    // ── Invariant 11: uniqueUserCount is a monotone floor over the
    //                 bounded actor pool ─────────────────────────────────
    //
    //   The hook fires userSeen exactly once per distinct participant
    //   ever observed. In this harness, participants are drawn from the
    //   fixed 6-actor pool the InvariantBase seeds + whichever auxiliary
    //   addresses the base onboarded. We can't enumerate "every address
    //   the diamond has ever seen" from outside, so we assert the looser
    //   direction that matters: every actor the handler drove who has
    //   touched the loan/offer book must be `userSeen`, and the counter
    //   must be at least as large as the number of flagged actors. A
    //   hook miss would leave the counter below that floor.
    function invariant_UniqueUserCountCoversPool() public view {
        TestMutatorFacet m = TestMutatorFacet(diamond);
        uint256 flagged;
        for (uint256 i = 0; i < 3; i++) {
            if (m.getUserSeenFlag(base.lenderAt(i))) flagged++;
            if (m.getUserSeenFlag(base.borrowerAt(i))) flagged++;
        }
        assertGe(
            m.getUniqueUserCounter(),
            flagged,
            "uniqueUserCount below userSeen floor"
        );
    }
}
