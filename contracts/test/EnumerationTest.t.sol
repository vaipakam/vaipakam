// test/EnumerationTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Enumerable.sol";

/**
 * @notice Coverage for the reverse-index enumeration views added to MetricsFacet
 *         plus IERC721Enumerable on VaipakamNFTFacet. The reverse-index side is
 *         seeded via TestMutatorFacet so pagination, state filters, and the
 *         cancellation marker are exercised without driving the full offer-loan
 *         lifecycle. The NFT enumerable side mints through the authorized
 *         diamond-internal path to verify the `_allTokens` / `_ownedTokens`
 *         bookkeeping inside LibERC721 stays consistent with transfers and
 *         burns.
 */
contract EnumerationTest is SetupTest {
    address u1;
    address u2;

    function setUp() public {
        setupHelper();
        u1 = makeAddr("u1");
        u2 = makeAddr("u2");
    }

    // ─── Reverse-index seeding helpers ──────────────────────────────────────

    function _seedOpenOffer(uint256 offerId, address creator_) internal {
        LibVaipakam.Offer memory o;
        o.id = offerId;
        o.creator = creator_;
        o.lendingAsset = mockERC20;
        o.amount = 100 ether;
        o.offerType = LibVaipakam.OfferType.Lender;
        o.assetType = LibVaipakam.AssetType.ERC20;
        o.collateralAssetType = LibVaipakam.AssetType.ERC20;
        TestMutatorFacet(address(diamond)).setOffer(offerId, o);
        TestMutatorFacet(address(diamond)).pushUserOfferId(creator_, offerId);
    }

    function _seedAcceptedOffer(uint256 offerId, address creator_) internal {
        LibVaipakam.Offer memory o;
        o.id = offerId;
        o.creator = creator_;
        o.lendingAsset = mockERC20;
        o.amount = 100 ether;
        o.accepted = true;
        o.offerType = LibVaipakam.OfferType.Lender;
        o.assetType = LibVaipakam.AssetType.ERC20;
        TestMutatorFacet(address(diamond)).setOffer(offerId, o);
        TestMutatorFacet(address(diamond)).pushUserOfferId(creator_, offerId);
    }

    function _seedCancelledOffer(uint256 offerId, address creator_) internal {
        TestMutatorFacet(address(diamond)).pushUserOfferId(creator_, offerId);
        TestMutatorFacet(address(diamond)).setOfferCancelled(offerId, true);
    }

    function _seedLoan(
        uint256 loanId,
        address lender_,
        address borrower_,
        LibVaipakam.LoanStatus status
    ) internal {
        LibVaipakam.Loan memory l;
        l.id = loanId;
        l.lender = lender_;
        l.borrower = borrower_;
        l.principal = 100 ether;
        l.principalAsset = mockERC20;
        l.collateralAsset = mockERC20;
        l.collateralAmount = 150 ether;
        l.status = status;
        l.assetType = LibVaipakam.AssetType.ERC20;
        l.collateralAssetType = LibVaipakam.AssetType.ERC20;
        l.startTime = uint64(block.timestamp);
        l.durationDays = 30;
        TestMutatorFacet(address(diamond)).setLoan(loanId, l);
        TestMutatorFacet(address(diamond)).pushUserLoanId(lender_, loanId);
        TestMutatorFacet(address(diamond)).pushUserLoanId(borrower_, loanId);
    }

    // ─── getGlobalCounts / counters ─────────────────────────────────────────

    function testGlobalCountsReflectsNextIds() public {
        TestMutatorFacet(address(diamond)).setNextLoanId(7);
        TestMutatorFacet(address(diamond)).setNextOfferId(4);
        (uint256 loans, uint256 offers) =
            MetricsFacet(address(diamond)).getGlobalCounts();
        assertEq(loans, 7);
        assertEq(offers, 4);
    }

    function testUserLoanAndOfferCounts() public {
        _seedOpenOffer(1, u1);
        _seedOpenOffer(2, u1);
        _seedOpenOffer(3, u2);
        _seedLoan(1, u1, u2, LibVaipakam.LoanStatus.Active);
        _seedLoan(2, u1, u2, LibVaipakam.LoanStatus.Repaid);

        assertEq(MetricsFacet(address(diamond)).getUserOfferCount(u1), 2);
        assertEq(MetricsFacet(address(diamond)).getUserOfferCount(u2), 1);
        // Both loans appear on u1 (lender) and u2 (borrower) indices.
        assertEq(MetricsFacet(address(diamond)).getUserLoanCount(u1), 2);
        assertEq(MetricsFacet(address(diamond)).getUserLoanCount(u2), 2);
    }

    function testIsOfferCancelledSurvivesDelete() public {
        _seedCancelledOffer(42, u1);
        assertTrue(MetricsFacet(address(diamond)).isOfferCancelled(42));
        assertFalse(MetricsFacet(address(diamond)).isOfferCancelled(43));
    }

    // ─── getUserOffersPaginated ─────────────────────────────────────────────

    function testUserOffersPaginatedSliceAndBounds() public {
        for (uint256 i = 1; i <= 5; i++) _seedOpenOffer(i, u1);

        (uint256[] memory first, uint256 total) =
            MetricsFacet(address(diamond)).getUserOffersPaginated(u1, 0, 3);
        assertEq(total, 5);
        assertEq(first.length, 3);
        assertEq(first[0], 1);
        assertEq(first[2], 3);

        (uint256[] memory second, ) =
            MetricsFacet(address(diamond)).getUserOffersPaginated(u1, 3, 10);
        assertEq(second.length, 2); // 4 and 5
        assertEq(second[0], 4);
        assertEq(second[1], 5);

        // Offset >= length → empty slice, total still reports full index size.
        (uint256[] memory empty, uint256 totalStill) =
            MetricsFacet(address(diamond)).getUserOffersPaginated(u1, 10, 5);
        assertEq(empty.length, 0);
        assertEq(totalStill, 5);
    }

    // ─── getUserLoansPaginated + status filter ──────────────────────────────

    function testUserLoansByStatusFilterPagination() public {
        _seedLoan(1, u1, u2, LibVaipakam.LoanStatus.Active);
        _seedLoan(2, u1, u2, LibVaipakam.LoanStatus.Repaid);
        _seedLoan(3, u1, u2, LibVaipakam.LoanStatus.Active);
        _seedLoan(4, u1, u2, LibVaipakam.LoanStatus.Defaulted);
        _seedLoan(5, u1, u2, LibVaipakam.LoanStatus.Active);

        (uint256[] memory active, uint256 matched) = MetricsFacet(address(diamond))
            .getUserLoansByStatusPaginated(
                u1,
                LibVaipakam.LoanStatus.Active,
                0,
                2
            );
        assertEq(matched, 3);
        assertEq(active.length, 2);
        assertEq(active[0], 1);
        assertEq(active[1], 3);

        (uint256[] memory activePage2, ) = MetricsFacet(address(diamond))
            .getUserLoansByStatusPaginated(
                u1,
                LibVaipakam.LoanStatus.Active,
                2,
                2
            );
        assertEq(activePage2.length, 1);
        assertEq(activePage2[0], 5);

        (uint256[] memory repaid, uint256 repaidMatched) =
            MetricsFacet(address(diamond)).getUserLoansByStatusPaginated(
                u1,
                LibVaipakam.LoanStatus.Repaid,
                0,
                10
            );
        assertEq(repaidMatched, 1);
        assertEq(repaid[0], 2);
    }

    // ─── getUserOffersByStatePaginated (Open / Accepted / Cancelled) ─────────

    function testUserOffersByStateFilter() public {
        _seedOpenOffer(1, u1);
        _seedAcceptedOffer(2, u1);
        _seedCancelledOffer(3, u1);
        _seedOpenOffer(4, u1);

        (uint256[] memory open, uint256 openMatched) = MetricsFacet(address(diamond))
            .getUserOffersByStatePaginated(
                u1,
                MetricsFacet.OfferState.Open,
                0,
                10
            );
        assertEq(openMatched, 2);
        assertEq(open.length, 2);
        assertEq(open[0], 1);
        assertEq(open[1], 4);

        (uint256[] memory accepted, uint256 acceptedMatched) = MetricsFacet(address(diamond))
            .getUserOffersByStatePaginated(
                u1,
                MetricsFacet.OfferState.Accepted,
                0,
                10
            );
        assertEq(acceptedMatched, 1);
        assertEq(accepted[0], 2);

        (uint256[] memory cancelled, uint256 cancelledMatched) = MetricsFacet(address(diamond))
            .getUserOffersByStatePaginated(
                u1,
                MetricsFacet.OfferState.Cancelled,
                0,
                10
            );
        assertEq(cancelledMatched, 1);
        assertEq(cancelled[0], 3);
    }

    // ─── getAllLoansPaginated / getAllOffersPaginated ───────────────────────

    function testAllLoansPaginatedSkipsEmptySlots() public {
        TestMutatorFacet(address(diamond)).setNextLoanId(5);
        _seedLoan(1, u1, u2, LibVaipakam.LoanStatus.Active);
        // slot 2 intentionally left empty (loans[2].id == 0)
        _seedLoan(3, u1, u2, LibVaipakam.LoanStatus.Repaid);
        _seedLoan(4, u1, u2, LibVaipakam.LoanStatus.Active);

        (uint256[] memory page, uint256 total) =
            MetricsFacet(address(diamond)).getAllLoansPaginated(0, 10);
        assertEq(total, 5); // mirrors nextLoanId
        assertEq(page.length, 3); // slot 2 and 5 skipped (5 never seeded)
        assertEq(page[0], 1);
        assertEq(page[1], 3);
        assertEq(page[2], 4);
    }

    function testAllOffersPaginatedIncludesCancelled() public {
        TestMutatorFacet(address(diamond)).setNextOfferId(3);
        _seedOpenOffer(1, u1);
        // slot 2: never seeded
        _seedCancelledOffer(3, u1); // offer record was deleted, marker survives

        (uint256[] memory page, uint256 total) =
            MetricsFacet(address(diamond)).getAllOffersPaginated(0, 10);
        assertEq(total, 3);
        assertEq(page.length, 2); // slot 2 skipped
        assertEq(page[0], 1);
        assertEq(page[1], 3);
    }

    function testLoansByStatusPaginatedGlobal() public {
        // nextLoanId matches the highest seeded id so the iteration doesn't
        // visit an empty slot (empty slot would have default LoanStatus.Active
        // and be double-counted — MetricsFacet.getLoansByStatusPaginated does
        // not gate on loans[id].id != 0).
        TestMutatorFacet(address(diamond)).setNextLoanId(3);
        _seedLoan(1, u1, u2, LibVaipakam.LoanStatus.Active);
        _seedLoan(2, u1, u2, LibVaipakam.LoanStatus.Defaulted);
        _seedLoan(3, u1, u2, LibVaipakam.LoanStatus.Active);

        (uint256[] memory active, uint256 matched) =
            MetricsFacet(address(diamond)).getLoansByStatusPaginated(
                LibVaipakam.LoanStatus.Active,
                0,
                10
            );
        assertEq(matched, 2);
        assertEq(active.length, 2);
        assertEq(active[0], 1);
        assertEq(active[1], 3);
    }

    // ─── IERC721Enumerable on VaipakamNFTFacet ──────────────────────────────

    /// @dev Mint path requires caller == address(diamond) via {_enforceAuthorizedCaller}.
    function _mintVia(
        address to,
        uint256 tokenId,
        bool isLender
    ) internal {
        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).mintNFT(
            to,
            tokenId,
            1,
            0,
            isLender,
            LibVaipakam.LoanPositionStatus.OfferCreated
        );
    }

    function _burnVia(uint256 tokenId) internal {
        vm.prank(address(diamond));
        VaipakamNFTFacet(address(diamond)).burnNFT(tokenId);
    }

    function testTotalSupplyTracksMintBurn() public {
        assertEq(IERC721Enumerable(address(diamond)).totalSupply(), 0);

        _mintVia(u1, 101, true);
        _mintVia(u2, 102, false);
        assertEq(IERC721Enumerable(address(diamond)).totalSupply(), 2);

        _burnVia(101);
        assertEq(IERC721Enumerable(address(diamond)).totalSupply(), 1);
    }

    function testTokenByIndexAndOwnerByIndexReflectOrder() public {
        _mintVia(u1, 10, true);
        _mintVia(u2, 20, false);
        _mintVia(u1, 30, true);

        // Global index order matches mint order.
        assertEq(IERC721Enumerable(address(diamond)).tokenByIndex(0), 10);
        assertEq(IERC721Enumerable(address(diamond)).tokenByIndex(1), 20);
        assertEq(IERC721Enumerable(address(diamond)).tokenByIndex(2), 30);

        // Per-owner index: u1 holds [10, 30] in mint order.
        assertEq(IERC721Enumerable(address(diamond)).tokenOfOwnerByIndex(u1, 0), 10);
        assertEq(IERC721Enumerable(address(diamond)).tokenOfOwnerByIndex(u1, 1), 30);
        assertEq(IERC721Enumerable(address(diamond)).tokenOfOwnerByIndex(u2, 0), 20);
    }

    function testBurnCompactsOwnerIndex() public {
        _mintVia(u1, 10, true);
        _mintVia(u1, 20, true);
        _mintVia(u1, 30, true);

        _burnVia(20);

        // Swap-and-pop semantics: last token moves into the freed slot.
        // Order after burning 20 becomes [10, 30] (30 was last, moved to slot 1).
        assertEq(IERC721Enumerable(address(diamond)).tokenOfOwnerByIndex(u1, 0), 10);
        assertEq(IERC721Enumerable(address(diamond)).tokenOfOwnerByIndex(u1, 1), 30);

        // Third slot should now be out of bounds.
        vm.expectRevert();
        IERC721Enumerable(address(diamond)).tokenOfOwnerByIndex(u1, 2);
    }

    function testTokenByIndexRevertsOnOutOfBounds() public {
        _mintVia(u1, 10, true);
        vm.expectRevert();
        IERC721Enumerable(address(diamond)).tokenByIndex(1);
    }

    function testTokenOfOwnerByIndexRevertsOnOutOfBounds() public {
        _mintVia(u1, 10, true);
        vm.expectRevert();
        IERC721Enumerable(address(diamond)).tokenOfOwnerByIndex(u2, 0);
    }
}
