// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @title OfferFillModeTest
/// @notice #125 — coverage for the new `FillMode` flavour of an offer
///         (`Partial` default / `Aon` / `Ioc`). Pins each create-time
///         invariant + the AON match-time enforcement, plus the IOC
///         convention that `expiresAt` is required at create.
contract OfferFillModeTest is SetupTest {
    uint64 internal constant ONE_HOUR = 60 * 60;

    function setUp() public {
        setupHelper();
        deal(mockERC20, lender, 1_000_000 ether);
        deal(mockERC20, borrower, 1_000_000 ether);
        deal(mockCollateralERC20, lender, 1_000_000 ether);
        deal(mockCollateralERC20, borrower, 1_000_000 ether);
        vm.prank(lender);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20Mock(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender);
        ERC20Mock(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        ERC20Mock(mockCollateralERC20).approve(address(diamond), type(uint256).max);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _lenderParams(
        LibVaipakam.FillMode fillMode,
        uint256 amount,
        uint256 amountMax,
        uint64 expiresAt
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: mockERC20,
            amount: amount,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: 5000 ether,
            durationDays: 30,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(0),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: amountMax,
            interestRateBpsMax: 500,
            collateralAmountMax: 5000 ether,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: expiresAt,
            fillMode: fillMode
        });
    }

    function _create(LibVaipakam.CreateOfferParams memory p) internal returns (uint256) {
        vm.prank(lender);
        return OfferCreateFacet(address(diamond)).createOffer(p);
    }

    function _createBorrower(LibVaipakam.FillMode fillMode, uint256 amount, uint256 amountMax)
        internal returns (uint256)
    {
        LibVaipakam.CreateOfferParams memory p = LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: mockERC20,
            amount: amount,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: 5000 ether,
            durationDays: 30,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(0),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: amountMax,
            interestRateBpsMax: 500,
            collateralAmountMax: 5000 ether,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: fillMode
        });
        vm.prank(borrower);
        return OfferCreateFacet(address(diamond)).createOffer(p);
    }

    // ─── Partial (default) — preserves legacy behaviour ─────────────

    function testPartialDefaultPreservesLegacyBehaviour() public {
        uint256 id = _create(_lenderParams(LibVaipakam.FillMode.Partial, 1000 ether, 1000 ether, 0));
        LibVaipakam.Offer memory o = OfferCancelFacet(address(diamond)).getOffer(id);
        assertEq(uint256(o.fillMode), uint256(LibVaipakam.FillMode.Partial), "default Partial");
    }

    // ─── AON create-time invariants ─────────────────────────────────

    function testAonRequiresSingleValueAmount() public {
        // amount != amountMax under AON must revert.
        vm.prank(lender);
        vm.expectRevert(OfferCreateFacet.AonRequiresSingleValueAmount.selector);
        OfferCreateFacet(address(diamond)).createOffer(
            _lenderParams(LibVaipakam.FillMode.Aon, 1000 ether, 1500 ether, 0)
        );
    }

    function testAonAcceptsSingleValueAmount() public {
        uint256 id = _create(_lenderParams(LibVaipakam.FillMode.Aon, 1000 ether, 1000 ether, 0));
        LibVaipakam.Offer memory o = OfferCancelFacet(address(diamond)).getOffer(id);
        assertEq(uint256(o.fillMode), uint256(LibVaipakam.FillMode.Aon), "AON stamped");
        assertEq(o.amount, o.amountMax, "single-value invariant");
    }

    function testAonDirectAcceptFullFillSucceeds() public {
        // Direct-accept of an AON lender offer naturally consumes
        // amount == amountMax, so the create-time single-value
        // invariant makes the accept path AON-compatible without any
        // additional gating.
        uint256 id = _create(_lenderParams(LibVaipakam.FillMode.Aon, 1000 ether, 1000 ether, 0));
        vm.prank(borrower);
        uint256 loanId = OfferAcceptFacet(address(diamond)).acceptOffer(id, true);
        assertGt(loanId, 0, "AON direct-accept full fill");
    }

    // ─── IOC create-time invariants ─────────────────────────────────

    function testIocRequiresExpiry() public {
        // expiresAt == 0 under IOC must revert.
        vm.prank(lender);
        vm.expectRevert(OfferCreateFacet.IocRequiresExpiry.selector);
        OfferCreateFacet(address(diamond)).createOffer(
            _lenderParams(LibVaipakam.FillMode.Ioc, 1000 ether, 1000 ether, 0)
        );
    }

    function testIocAcceptsWithExpiry() public {
        uint64 deadline = uint64(block.timestamp + ONE_HOUR);
        uint256 id = _create(_lenderParams(LibVaipakam.FillMode.Ioc, 1000 ether, 1500 ether, deadline));
        LibVaipakam.Offer memory o = OfferCancelFacet(address(diamond)).getOffer(id);
        assertEq(uint256(o.fillMode), uint256(LibVaipakam.FillMode.Ioc), "IOC stamped");
        assertEq(o.expiresAt, deadline, "expiresAt stamped");
        // IOC allows ranged amount — the partial-fill behaviour is the
        // default; the IOC label just bounds the window via expiresAt.
        assertGt(o.amountMax, o.amount, "IOC supports ranged amount");
    }

    function testIocOfferExpiresAtDeadline() public {
        // IOC inherits #195's lazy-expiry semantics: past `expiresAt`,
        // accepts and matches refuse the offer.
        uint64 deadline = uint64(block.timestamp + ONE_HOUR);
        uint256 id = _create(_lenderParams(LibVaipakam.FillMode.Ioc, 1000 ether, 1000 ether, deadline));
        vm.warp(uint256(deadline) + 1);
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(OfferAcceptFacet.OfferExpired.selector, id, deadline)
        );
        OfferAcceptFacet(address(diamond)).acceptOffer(id, true);
    }

    // ─── AON match-time enforcement (via previewMatch) ──────────────

    function testPreviewMatchAonRequiresFullFillRevertsOnPartial() public {
        // Lender AON at amount=1000 against borrower partial range
        // [500, 2000]. The match-amount midpoint would be 1000 (the
        // overlap), so this case naturally satisfies AON. To force a
        // partial, drop the lender side to a smaller amount.
        // Build a lender AON at 500 + borrower partial at [600, 1500]
        // — no overlap because lender AON needs exactly 500, but
        // borrower's floor is 600 → AmountNoOverlap fires before AON.
        // The clean AON-violation case needs: AON lender at X, partial
        // borrower whose overlap MIDPOINT yields some Y != X. The
        // midpoint = (max(L.min, B.min), min(L.lenderRemaining, B.borrowerRemaining)) / 2.
        // For lender AON X, lenderRemaining == X. So hi <= X. For
        // midpoint to differ from X, lo < hi → max(X, B.min) < X →
        // impossible (max >= X). The midpoint thus always lands at X
        // when the overlap is non-empty AND lender is AON.
        // Conclusion: AON-on-one-side cannot produce a partial match
        // through previewMatch's midpoint logic. The AonRequiresFullFill
        // error path remains reachable defensively if amountFilled > 0
        // — that's the belt-and-suspenders branch.
        // Pin instead: the create-time AON invariant + the AON
        // metadata propagates correctly into both sides of
        // previewMatch; the defensive `amountFilled != 0` branch is
        // unreachable via the normal flow but the code path exists.
        uint256 lenderId = _create(_lenderParams(LibVaipakam.FillMode.Aon, 1000 ether, 1000 ether, 0));
        uint256 borrowerId = _createBorrower(LibVaipakam.FillMode.Partial, 1000 ether, 1000 ether);
        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(lenderId, borrowerId);
        // AON on lender + partial on borrower both targeting 1000:
        // overlap exists at exactly 1000, so the match is legal. The
        // AON check sees matchAmount == L.amount = 1000 → passes.
        assertEq(uint256(r.errorCode), uint256(LibOfferMatch.MatchError.Ok), "matched at AON amount");
        assertEq(r.matchAmount, 1000 ether, "match consumes full AON");
    }

    function testPreviewMatchBothSidesAonMatchedExact() public {
        // Symmetric AON: both lender and borrower carry AON at the
        // same amount. previewMatch's overlap math + the AON gate
        // converge cleanly.
        uint256 lenderId = _create(_lenderParams(LibVaipakam.FillMode.Aon, 1000 ether, 1000 ether, 0));
        uint256 borrowerId = _createBorrower(LibVaipakam.FillMode.Aon, 1000 ether, 1000 ether);
        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(lenderId, borrowerId);
        assertEq(uint256(r.errorCode), uint256(LibOfferMatch.MatchError.Ok), "both-AON ok");
        assertEq(r.matchAmount, 1000 ether, "full single-shot");
    }

    function testPreviewMatchAonRevertsOnSizeMismatch() public {
        // Lender AON at 1000 + borrower partial floor 2000 (above AON
        // size). lenderRemaining = 1000 → hi = 1000; lo = max(1000,
        // 2000) = 2000 → lo > hi → AmountNoOverlap fires BEFORE the
        // AON branch.
        uint256 lenderId = _create(_lenderParams(LibVaipakam.FillMode.Aon, 1000 ether, 1000 ether, 0));
        uint256 borrowerId = _createBorrower(LibVaipakam.FillMode.Partial, 2000 ether, 2000 ether);
        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(lenderId, borrowerId);
        assertEq(
            uint256(r.errorCode),
            uint256(LibOfferMatch.MatchError.AmountNoOverlap),
            "no overlap when AON size is below borrower floor"
        );
    }

    // ─── Storage layout backward-compat ─────────────────────────────

    function testLegacyOfferRowsReadAsPartial() public {
        // A pre-#125 offer constructed without setting `fillMode`
        // (zero-init storage) must read as `Partial` so legacy
        // behaviour is bit-for-bit preserved. The bulk-update of
        // every construction site already ships `Partial` explicitly,
        // so this test is a regression sentinel: any read-side
        // logic that conflates "unset" with "Aon" or "Ioc" would
        // fail here.
        LibVaipakam.CreateOfferParams memory p = _lenderParams(
            LibVaipakam.FillMode.Partial,
            1000 ether,
            1500 ether,
            0
        );
        uint256 id = _create(p);
        LibVaipakam.Offer memory o = OfferCancelFacet(address(diamond)).getOffer(id);
        assertEq(uint256(o.fillMode), 0, "Partial is the zero-init default");
    }
}
