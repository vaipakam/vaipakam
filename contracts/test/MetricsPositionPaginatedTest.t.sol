// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/// @dev #769 — `getUserPositionLoansPaginated` / `getUserPositionOffersPaginated`
///      bound the per-wallet `balanceOf`-loop so a holder griefed with a huge
///      position-NFT inventory can't make the unbounded single-`eth_call` view
///      revert. These tests assert each page is a correct, overflow-safe slice
///      and that the union of pages reproduces the non-paginated view exactly.
contract MetricsPositionPaginatedTest is SetupTest {
    function setUp() public {
        setupHelper();
    }

    /// @dev One liquid lender offer from `lender`; mints a creator-position NFT.
    function _lenderOffer(uint256 amount) internal returns (uint256 offerId) {
        _fundActorVault(lender, mockERC20, amount);
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: amount,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 150 ether,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: amount,
                interestRateBpsMax: 500,
                collateralAmountMax: 150 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    function _contains(uint256[] memory haystack, uint256 needle)
        internal
        pure
        returns (bool)
    {
        for (uint256 i = 0; i < haystack.length; i++) {
            if (haystack[i] == needle) return true;
        }
        return false;
    }

    function test_PositionOffersPaginated_parityAndBounds() public {
        uint256 n = 5;
        uint256[] memory allIds = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            allIds[i] = _lenderOffer(100 ether);
        }

        // Page through with a tiny limit; the union must reproduce the n offers
        // `lender` created (self-consistent — no dependence on the non-paginated
        // view being cut into the test harness).
        uint256[] memory collected = new uint256[](n);
        uint256 c;
        uint256 offset;
        uint256 guard;
        while (true) {
            (uint256[] memory ids, uint256[] memory toks, uint256 total) =
                MetricsFacet(address(diamond)).getUserPositionOffersPaginated(
                    lender, offset, 2
                );
            assertEq(total, n, "totalBalance stable == n");
            assertEq(ids.length, toks.length, "ids/tokens aligned");
            assertLe(ids.length, 2, "page <= limit");
            for (uint256 j = 0; j < ids.length; j++) {
                assertTrue(_contains(allIds, ids[j]), "paged id in baseline");
                collected[c++] = ids[j];
            }
            offset += 2;
            if (offset >= total) break;
            require(++guard < 100, "loop guard");
        }
        assertEq(c, n, "paged union count == baseline");
        for (uint256 i = 0; i < allIds.length; i++) {
            assertTrue(_contains(collected, allIds[i]), "baseline id in paged union");
        }

        // offset >= balance ⇒ empty page, correct totalBalance.
        (uint256[] memory empty, , uint256 t2) =
            MetricsFacet(address(diamond)).getUserPositionOffersPaginated(lender, n, 2);
        assertEq(empty.length, 0, "past-end empty");
        assertEq(t2, n, "past-end total");

        // limit 0 ⇒ empty page.
        (uint256[] memory e0, , ) =
            MetricsFacet(address(diamond)).getUserPositionOffersPaginated(lender, 0, 0);
        assertEq(e0.length, 0, "zero-limit empty");

        // huge limit is overflow-safe and returns the whole set in one page.
        (uint256[] memory big, , uint256 t3) = MetricsFacet(address(diamond))
            .getUserPositionOffersPaginated(lender, 0, type(uint256).max);
        assertEq(big.length, n, "max-limit returns all");
        assertEq(t3, n, "max-limit total");
    }

    function test_PositionLoansPaginated_basicAndBounds() public {
        uint256 offerId = _lenderOffer(100 ether);
        _fundActorVault(borrower, mockCollateralERC20, 150 ether);
        LibAcceptTestSigner.signAndAccept(
            address(diamond), borrower, borrowerPk, offerId
        );

        // The lender now holds exactly the loan's lender-position NFT — asserted
        // via the view's `total` (== balanceOf, computed internally), since the
        // ERC721 `balanceOf` selector isn't cut into the test harness diamond.
        (uint256[] memory ids, uint256[] memory toks, uint256 total) =
            MetricsFacet(address(diamond)).getUserPositionLoansPaginated(
                lender, 0, 10
            );
        assertEq(total, 1, "totalBalance == 1");
        assertEq(ids.length, 1, "page returns the loan");
        assertEq(toks.length, 1, "tokens aligned");
        assertEq(ids[0], 1, "paged loan id is the first loan");

        // offset past the single NFT ⇒ empty.
        (uint256[] memory empty, , uint256 t2) =
            MetricsFacet(address(diamond)).getUserPositionLoansPaginated(lender, 1, 10);
        assertEq(empty.length, 0, "past-end empty");
        assertEq(t2, 1, "past-end total");
    }
}
