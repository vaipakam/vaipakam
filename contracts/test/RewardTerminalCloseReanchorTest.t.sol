// test/RewardTerminalCloseReanchorTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @notice #1067 (S13 Part 2) — the CENTRALIZED terminal reward close-out.
 *
 *         `LibInteractionRewards.closeLoan` (reached via the diamond-internal
 *         `terminalRewardClose` / `liquidationRewardClose` self-hooks) must,
 *         before it closes each OPEN reward entry:
 *           1. re-anchor the entry to the LIVE position-NFT holder (so a sold
 *              position's reward follows the funds — F6), and
 *           2. NEVER re-anchor an already-closed entry (a frozen slice must not
 *              be handed to a later holder — F8),
 *         and route the forfeit correctly (liquidation → borrower forfeits,
 *         lender keeps; proper close → neither forfeits).
 *
 *         Plus the O(1) membership index (`userRewardEntryIds` +
 *         `rewardEntryUserIdx`) stays consistent across successive re-anchors
 *         (H3), including both the swap-middle and pop-tail removal branches.
 */
contract RewardTerminalCloseReanchorTest is SetupTest {
    uint256 internal constant LOAN = 4242;
    uint256 internal constant LENDER_TOKEN = 1001;
    uint256 internal constant BORROWER_TOKEN = 1002;

    address internal lenderOrig;
    address internal borrowerOrig;
    address internal lenderNew;
    address internal borrowerNew;

    function setUp() public {
        setupHelper();
        lenderOrig = makeAddr("lenderOrig");
        borrowerOrig = makeAddr("borrowerOrig");
        lenderNew = makeAddr("lenderNew");
        borrowerNew = makeAddr("borrowerNew");

        // Start emissions + advance so `currentDayOrZero()` is active.
        InteractionRewardsFacet(address(diamond)).setInteractionLaunchTimestamp(
            block.timestamp
        );
        vm.warp(block.timestamp + 1 days + 1);
    }

    // ─── scaffold ─────────────────────────────────────────────────────────────

    /// @dev Seed an Active loan (only the fields `closeLoan` reads) + one OPEN
    ///      lender entry and one OPEN borrower entry, with the per-loan pointers
    ///      wired as production `registerLoan` would.
    function _seedLoanWithEntries()
        internal
        returns (uint256 lenderId, uint256 borrowerId)
    {
        LibVaipakam.Loan memory l;
        l.id = LOAN;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lender = lenderOrig;
        l.borrower = borrowerOrig;
        l.lenderTokenId = LENDER_TOKEN;
        l.borrowerTokenId = BORROWER_TOKEN;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(LOAN, l);

        (uint256 day, ) =
            InteractionRewardsLensFacet(address(diamond)).getInteractionCurrentDay();
        uint32 today = uint32(day);
        lenderId = TestMutatorFacet(address(diamond)).pushRewardEntry(
            lenderOrig, uint64(LOAN), LibVaipakam.RewardSide.Lender, 1e18, today
        );
        borrowerId = TestMutatorFacet(address(diamond)).pushRewardEntry(
            borrowerOrig, uint64(LOAN), LibVaipakam.RewardSide.Borrower, 1e18, today
        );
        TestMutatorFacet(address(diamond)).setLoanActiveLenderEntryId(LOAN, lenderId);
        TestMutatorFacet(address(diamond)).setLoanBorrowerEntryId(LOAN, borrowerId);
    }

    /// @dev Mock `ownerOf(tokenId)` → `who` (simulate a transferred position).
    function _mockHolder(uint256 tokenId, address who) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(IERC721.ownerOf.selector, tokenId),
            abi.encode(who)
        );
    }

    function _entries(address user)
        internal
        view
        returns (LibVaipakam.RewardEntry[] memory)
    {
        return InteractionRewardsLensFacet(address(diamond)).getUserRewardEntries(user);
    }

    function _closeAsDiamond(bytes memory data) internal {
        vm.prank(address(diamond));
        (bool ok, ) = address(diamond).call(data);
        require(ok, "self-hook close reverted");
    }

    // ─── F6: proper close re-anchors BOTH sides to their live holders ──────────

    function test_TerminalClose_ReanchorsBothSidesToLiveHolders() public {
        _seedLoanWithEntries();
        _mockHolder(LENDER_TOKEN, lenderNew);
        _mockHolder(BORROWER_TOKEN, borrowerNew);

        // Proper close (borrowerClean = true) via terminalRewardClose.
        _closeAsDiamond(
            abi.encodeWithSelector(
                InteractionRewardsFacet.terminalRewardClose.selector, LOAN, true
            )
        );

        // Both entries moved off the stale originals onto the live holders.
        assertEq(_entries(lenderOrig).length, 0, "lender entry left original");
        assertEq(_entries(borrowerOrig).length, 0, "borrower entry left original");

        LibVaipakam.RewardEntry[] memory ln = _entries(lenderNew);
        LibVaipakam.RewardEntry[] memory bn = _entries(borrowerNew);
        assertEq(ln.length, 1, "lender re-anchored to live holder");
        assertEq(bn.length, 1, "borrower re-anchored to live holder");
        assertTrue(ln[0].closed, "lender entry closed");
        assertTrue(bn[0].closed, "borrower entry closed");
        // Proper close ⇒ neither side forfeits.
        assertFalse(ln[0].forfeited, "lender not forfeited (proper close)");
        assertFalse(bn[0].forfeited, "borrower not forfeited (proper close)");
    }

    // ─── liquidation close: borrower forfeits DURABLY, lender keeps ────────────

    function test_LiquidationClose_BorrowerForfeits_LenderKeeps() public {
        _seedLoanWithEntries();
        _mockHolder(LENDER_TOKEN, lenderNew);
        _mockHolder(BORROWER_TOKEN, borrowerNew);

        _closeAsDiamond(
            abi.encodeWithSelector(
                InteractionRewardsFacet.liquidationRewardClose.selector, LOAN
            )
        );

        LibVaipakam.RewardEntry[] memory ln = _entries(lenderNew);
        LibVaipakam.RewardEntry[] memory bn = _entries(borrowerNew);
        assertTrue(ln[0].closed && !ln[0].forfeited, "lender keeps (closed, not forfeited)");
        assertTrue(bn[0].closed && bn[0].forfeited, "borrower forfeits durably");
    }

    // ─── F8: an ALREADY-closed entry is never re-anchored ──────────────────────

    function test_TerminalClose_SkipsAlreadyClosedEntry() public {
        (uint256 lenderId, ) = _seedLoanWithEntries();
        // Close the lender entry BEFORE the terminal (a frozen slice).
        TestMutatorFacet(address(diamond)).closeRewardEntryRaw(lenderId, 5);
        _mockHolder(LENDER_TOKEN, lenderNew);
        _mockHolder(BORROWER_TOKEN, borrowerNew);

        _closeAsDiamond(
            abi.encodeWithSelector(
                InteractionRewardsFacet.terminalRewardClose.selector, LOAN, true
            )
        );

        // The pre-closed lender entry STAYED with the original holder — a frozen
        // slice is never moved to a later holder (F8).
        assertEq(_entries(lenderNew).length, 0, "closed entry NOT moved to live holder");
        assertEq(_entries(lenderOrig).length, 1, "closed lender entry stays with original");
        // The still-open borrower side DID re-anchor (only the closed side skips).
        assertEq(_entries(borrowerNew).length, 1, "open borrower side re-anchored");
    }

    // ─── H3: O(1) index stays consistent across successive re-anchors ──────────

    function test_Repoint_SuccessiveHolders_IndexConsistent() public {
        // Seed the lender-side entry for A + the per-loan pointer.
        LibVaipakam.Loan memory l;
        l.id = LOAN;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lenderTokenId = LENDER_TOKEN;
        TestMutatorFacet(address(diamond)).scaffoldActiveLoan(LOAN, l);

        address a = makeAddr("A");
        address b = makeAddr("B");
        address c = makeAddr("C");

        uint256 idX = TestMutatorFacet(address(diamond)).pushRewardEntry(
            a, uint64(LOAN), LibVaipakam.RewardSide.Lender, 1e18, 1
        );
        // A holds a SECOND, unrelated entry AFTER idX so removing idX exercises
        // the swap-middle branch (idX is not last in A's array).
        uint256 idA2 = TestMutatorFacet(address(diamond)).pushRewardEntry(
            a, uint64(999), LibVaipakam.RewardSide.Lender, 1e18, 1
        );
        // B already holds an entry so the push-onto-B keeps a sibling to conserve.
        uint256 idBOwn = TestMutatorFacet(address(diamond)).pushRewardEntry(
            b, uint64(888), LibVaipakam.RewardSide.Lender, 1e18, 1
        );
        TestMutatorFacet(address(diamond)).setLoanActiveLenderEntryId(LOAN, idX);

        TestMutatorFacet mut = TestMutatorFacet(address(diamond));

        // A → B: swap-middle removal from A ([idX, idA2] → [idA2]); push to B.
        mut.callRepointRewardEntry(LOAN, b, true);
        _assertIds(mut.getUserRewardEntryIds(a), _one(idA2), "A after A->B");
        _assertIds(mut.getUserRewardEntryIds(b), _two(idBOwn, idX), "B after A->B");
        assertEq(mut.getRewardEntryUserIdx(idA2), 1, "idA2 idx after swap");
        assertEq(mut.getRewardEntryUserIdx(idBOwn), 1, "idBOwn idx stable");
        assertEq(mut.getRewardEntryUserIdx(idX), 2, "idX idx on B tail");

        // B → C: pop-tail removal from B ([idBOwn, idX] → [idBOwn]); push to C.
        mut.callRepointRewardEntry(LOAN, c, true);
        _assertIds(mut.getUserRewardEntryIds(b), _one(idBOwn), "B after B->C");
        _assertIds(mut.getUserRewardEntryIds(c), _one(idX), "C after B->C");
        assertEq(mut.getRewardEntryUserIdx(idBOwn), 1, "idBOwn idx survives");
        assertEq(mut.getRewardEntryUserIdx(idX), 1, "idX idx on C head");
        assertEq(mut.getUserRewardEntryIds(a).length, 1, "A untouched by B->C");
    }

    // ─── tiny array helpers ────────────────────────────────────────────────────

    /// @notice The paged entry index (Codex #2489 r5) returns exactly the slice
    ///         `[offset, offset + limit)` of the registration order, clipped at
    ///         its end, with the order's length as `total` on every page — so a
    ///         reader that must consider EVERY entry (the claim-center
    ///         countdown) can walk the pages and prove it reached the end.
    /// @dev   Mutations: an unclipped last page reads past the array (revert);
    ///        `total` from the page rather than the order → the walk stops early.
    function test_Page_EntryIdsPage_ClipsToTheOrder_andReportsItsLength() public {
        address p = makeAddr("P");
        InteractionRewardsLensFacet lens = InteractionRewardsLensFacet(address(diamond));
        (uint256[] memory none, uint256 total0) = lens.getUserRewardEntryIdsPage(p, 0, 10);
        assertEq(none.length, 0, "no entries: an empty page");
        assertEq(total0, 0, "no entries: total 0");

        uint256[] memory all = new uint256[](5);
        for (uint256 i; i < 5; ++i) {
            all[i] = TestMutatorFacet(address(diamond)).pushRewardEntry(
                p, uint64(100 + i), LibVaipakam.RewardSide.Lender, 1e18, 1
            );
        }
        _assertIds(TestMutatorFacet(address(diamond)).getUserRewardEntryIds(p), all, "fixture: five entries in order");

        (uint256[] memory ids, uint256 total) = lens.getUserRewardEntryIdsPage(p, 0, 2);
        assertEq(total, 5, "page 1: total is the order's length");
        _assertIds(ids, _two(all[0], all[1]), "page 1: the first two");
        (ids, total) = lens.getUserRewardEntryIdsPage(p, 2, 2);
        assertEq(total, 5, "page 2: total unchanged");
        _assertIds(ids, _two(all[2], all[3]), "page 2: the next two");
        (ids, total) = lens.getUserRewardEntryIdsPage(p, 4, 2);
        assertEq(total, 5, "last page: total unchanged");
        _assertIds(ids, _one(all[4]), "last page: clipped to the one remaining");
        (ids, total) = lens.getUserRewardEntryIdsPage(p, 5, 2);
        assertEq(ids.length, 0, "past the end: empty");
        assertEq(total, 5, "past the end: total still reported");
        (ids, total) = lens.getUserRewardEntryIdsPage(p, 1, 0);
        assertEq(ids.length, 0, "a zero limit: empty");
        assertEq(total, 5, "a zero limit: total still reported");
        (ids, total) = lens.getUserRewardEntryIdsPage(p, 0, 100);
        _assertIds(ids, all, "a limit past the end: the whole order");
    }

    /// @notice Codex #2489 r14 — the LIVE page returns only entries not yet
    ///         settled and not yet expiring, scanning `limit` index positions
    ///         (not returning `limit` ids), with the index length as `total`.
    /// @dev   Mutation: drop the `processed` / `expiryBegun` filter → the
    ///        settled and the expiring entry are returned as live.
    function test_Page_LiveEntryIds_FiltersSettledAndExpiring() public {
        address p = makeAddr("Q");
        InteractionRewardsLensFacet lens = InteractionRewardsLensFacet(address(diamond));
        uint256[] memory all = new uint256[](5);
        for (uint256 i; i < 5; ++i) {
            all[i] = TestMutatorFacet(address(diamond)).pushRewardEntry(
                p, uint64(200 + i), LibVaipakam.RewardSide.Lender, 1e18, 1
            );
        }
        TestMutatorFacet(address(diamond)).setRewardEntryProcessedRaw(all[1], true);
        TestMutatorFacet(address(diamond)).setRewardEntryExpiryBegunRaw(all[3], true);
        (uint256[] memory live, uint256 total) = lens.getUserLiveRewardEntryIdsPage(p, 0, 100);
        assertEq(total, 5, "total is the index length");
        uint256[] memory want = new uint256[](3);
        want[0] = all[0]; want[1] = all[2]; want[2] = all[4];
        _assertIds(live, want, "settled and expiring entries are not live");
        (live, total) = lens.getUserLiveRewardEntryIdsPage(p, 1, 2);
        assertEq(total, 5);
        _assertIds(live, _one(all[2]), "scans positions 1..2: one live");
        (live, ) = lens.getUserLiveRewardEntryIdsPage(p, 5, 10);
        assertEq(live.length, 0, "past the end: empty");
    }

    // ─── Codex #2489 r16: the live-from cursor ────────────────────────────────

    /// @notice The permissionless compactor passes the TERMINAL prefix of a
    ///         wallet's index — settled and expiring entries — bounded by
    ///         `maxSteps`, and stops at the first live entry even when terminal
    ///         entries follow it; the soonest-expiry view starts at the cursor.
    /// @dev   Mutations: an advance that passes a live entry → the cursor lands
    ///        on 5 and the view's first page skips entry 3; a view that ignores
    ///        the cursor → its one-position page covers position 0, not 3.
    function test_LiveFrom_CompactorPassesTerminalPrefix_StopsAtFirstLive() public {
        address p = makeAddr("C");
        InteractionRewardsLensFacet lens = InteractionRewardsLensFacet(address(diamond));
        InteractionRewardsFacet facet = InteractionRewardsFacet(address(diamond));
        uint256[] memory all = new uint256[](6);
        for (uint256 i; i < 6; ++i) {
            all[i] = TestMutatorFacet(address(diamond)).pushRewardEntry(
                p, uint64(300 + i), LibVaipakam.RewardSide.Lender, 1e18, 1
            );
        }
        // 0 settled, 1 settled, 2 expiring, 3 LIVE, 4 settled, 5 live.
        TestMutatorFacet(address(diamond)).setRewardEntryProcessedRaw(all[0], true);
        TestMutatorFacet(address(diamond)).setRewardEntryProcessedRaw(all[1], true);
        TestMutatorFacet(address(diamond)).setRewardEntryExpiryBegunRaw(all[2], true);
        TestMutatorFacet(address(diamond)).setRewardEntryProcessedRaw(all[4], true);
        assertEq(lens.getUserRewardEntryLiveFrom(p), 0, "fresh index: cursor at 0");

        assertEq(facet.compactRewardEntryIndex(p, 2), 2, "bounded: two steps");
        assertEq(lens.getUserRewardEntryLiveFrom(p), 2);
        assertEq(facet.compactRewardEntryIndex(p, 100), 3, "stops at the first live entry");
        assertEq(facet.compactRewardEntryIndex(p, 100), 3, "idempotent");
        assertEq(lens.getUserRewardEntryLiveFrom(p), 3, "entry 4 is settled but 3 before it is live");

        // The view starts at the cursor: a one-position page covers position 3.
        (uint256 soonestId, uint64 soonestAt, uint256 next, uint256 total) =
            lens.getUserSoonestRewardExpiry(p, 0, 1, 100);
        assertEq(total, 6, "total is the index length");
        assertEq(next, 4, "page covered position 3 only (raised from offset 0 to the cursor)");
        assertEq(soonestId, 0, "dark horizon: no estimate");
        assertEq(soonestAt, 0);
        (, , next, ) = lens.getUserSoonestRewardExpiry(p, 4, 100, 100);
        assertEq(next, 6, "an offset past the cursor is honoured and the walk completes");
        (, , next, ) = lens.getUserSoonestRewardExpiry(p, 6, 100, 100);
        assertEq(next, 6, "past the end: nothing scanned");
        // The live page is unchanged by the cursor (it scans the positions asked).
        (uint256[] memory live, ) = lens.getUserLiveRewardEntryIdsPage(p, 0, 6);
        uint256[] memory want = new uint256[](2);
        want[0] = all[3]; want[1] = all[5];
        _assertIds(live, want, "the live page still answers for any positions");
    }

    /// @notice The index's one swap-pop keeps the cursor sound: repointing an
    ///         entry that sits BELOW the cursor moves the tail (live) entry into
    ///         its slot, and the cursor is pulled down to that slot so the
    ///         soonest-expiry view still covers the moved entry.
    /// @dev   Mutation: drop the cursor correction in `_removeUserEntry` → the
    ///        cursor stays at 2 over an index of length 2 and the view's walk
    ///        covers nothing while a live entry sits at position 0.
    function test_LiveFrom_SwapPopBelowCursor_PullsTheCursorDown() public {
        address a = makeAddr("A");
        address b = makeAddr("B");
        InteractionRewardsLensFacet lens = InteractionRewardsLensFacet(address(diamond));
        InteractionRewardsFacet facet = InteractionRewardsFacet(address(diamond));
        TestMutatorFacet mut = TestMutatorFacet(address(diamond));
        uint256 a0 = mut.pushRewardEntry(a, 700, LibVaipakam.RewardSide.Lender, 1e18, 1);
        uint256 a1 = mut.pushRewardEntry(a, 701, LibVaipakam.RewardSide.Lender, 1e18, 1);
        uint256 a2 = mut.pushRewardEntry(a, 702, LibVaipakam.RewardSide.Lender, 1e18, 1);
        mut.setRewardEntryProcessedRaw(a0, true);
        mut.setRewardEntryProcessedRaw(a1, true);
        assertEq(facet.compactRewardEntryIndex(a, 100), 2, "cursor past the two settled entries");

        // Repoint a0 (position 0, below the cursor) away: the tail a2 (live)
        // lands at position 0.
        mut.setLoanActiveLenderEntryId(700, a0);
        mut.callRepointRewardEntry(700, b, true);
        uint256[] memory idsA = mut.getUserRewardEntryIds(a);
        assertEq(idsA.length, 2);
        assertEq(idsA[0], a2, "the live tail moved into the vacated slot");
        assertEq(lens.getUserRewardEntryLiveFrom(a), 0, "cursor pulled down to the slot");
        (, , uint256 next, uint256 total) = lens.getUserSoonestRewardExpiry(a, 0, 1, 100);
        assertEq(total, 2);
        assertEq(next, 1, "the walk covers the moved live entry at position 0");
        // Re-compaction passes nothing: position 0 is live now.
        assertEq(facet.compactRewardEntryIndex(a, 100), 0);

        // Popping the TAIL moves nothing, so the cursor is left alone even
        // when it then exceeds the shortened index: settle a2, compact to the
        // end (2), then repoint a1 (the tail, position 1) away — the cursor
        // stays at 2 over an index of length 1, and both readers clamp.
        mut.setRewardEntryProcessedRaw(a2, true);
        assertEq(facet.compactRewardEntryIndex(a, 100), 2, "both settled: cursor at the end");
        mut.setLoanActiveLenderEntryId(701, a1);
        mut.callRepointRewardEntry(701, b, true);
        assertEq(mut.getUserRewardEntryIds(a).length, 1);
        assertEq(lens.getUserRewardEntryLiveFrom(a), 2, "a tail pop moves nothing below the cursor");
        (, , next, total) = lens.getUserSoonestRewardExpiry(a, 0, 100, 100);
        assertEq(total, 1);
        assertEq(next, 2, "the view clamps: nothing to scan, walk complete (next >= total)");
        assertEq(facet.compactRewardEntryIndex(a, 100), 1, "the advance clamps the cursor to the length");
    }

    function _one(uint256 x) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = x;
    }

    function _two(uint256 x, uint256 y) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = x;
        r[1] = y;
    }

    function _assertIds(
        uint256[] memory got,
        uint256[] memory want,
        string memory tag
    ) internal {
        assertEq(got.length, want.length, string.concat(tag, ": length"));
        for (uint256 i = 0; i < want.length; i++) {
            assertEq(got[i], want[i], string.concat(tag, ": elem"));
        }
    }
}
