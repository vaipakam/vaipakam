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
