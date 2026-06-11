// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";

/**
 * @title SelfTradePreventionTest
 * @notice #194 coverage — a single address cannot occupy both sides of
 *         a loan at initiation. The check sits in `_acceptOffer` after
 *         role resolution and covers both code paths (`acceptOffer`
 *         direct-accept AND `matchOffers` via `acceptOfferInternal`).
 *
 * @dev    Four test surfaces:
 *           1. Direct-accept of own lender offer → revert
 *              `SelfTradeForbidden(creator)`.
 *           2. Direct-accept of own borrower offer → revert
 *              `SelfTradeForbidden(creator)`.
 *           3. `matchOffers` between two same-creator offers → revert
 *              `SelfTradeForbidden(creator)` (from the load-bearing
 *              gate in `_acceptOffer`, not from any check inside
 *              `executeMatch` / `matchOffers` itself).
 *           4. `previewMatch` on the same-creator pair returns
 *              `MatchError.SelfTrade` without reverting — the early
 *              classifier exists so bots short-circuit before
 *              submitting a transaction that would revert.
 *
 *         Plus a happy-path negative-control: two different creators
 *         accept cleanly. If anything in the role-resolution block
 *         breaks the self-trade gate, this control regresses.
 *
 *         See `docs/DesignsAndPlans/SelfTradePreventionADR.md` for the
 *         policy rationale (Branch A — Enforce was chosen over Branch
 *         B — Allow-but-tax and Branch C — Allow unchanged).
 */
contract SelfTradePreventionTest is SetupTest {
    function setUp() public {
        setupHelper();

        // matchOffers is gated behind the `partialFillEnabled` kill
        // switch — flip it on so the matchOffers + previewMatch tests
        // reach `_acceptOffer`'s self-trade gate (test 3) or the
        // `LibOfferMatch.previewMatch` classifier (test 4) rather
        // than bailing out at the kill-switch guard.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
    }

    // ─────────────────────────────────────────────────────────────────
    // Offer helpers — same shape as AcceptRangedOfferTest /
    // BorrowerPartialFillTest so the test bodies stay declarative.
    // ─────────────────────────────────────────────────────────────────

    function _postLenderOffer(address creator)
        internal
        returns (uint256 offerId)
    {
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1_000,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 200,
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
                amountMax: 1_000,
                interestRateBpsMax: 500,
                collateralAmountMax: 200,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    function _postBorrowerOffer(address creator)
        internal
        returns (uint256 offerId)
    {
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: 1_000,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 200,
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
                amountMax: 1_000,
                interestRateBpsMax: 500,
                collateralAmountMax: 200,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    // ═════════════════════════════════════════════════════════════════
    // Test 1 — direct-accept on own lender offer reverts
    // ═════════════════════════════════════════════════════════════════

    function test_directAccept_lenderOfferBySelf_revertsSelfTradeForbidden() public {
        uint256 offerId = _postLenderOffer(lender);
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferAcceptFacet.SelfTradeForbidden.selector,
                lender
            )
        );
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
    }

    // ═════════════════════════════════════════════════════════════════
    // Test 2 — direct-accept on own borrower offer reverts
    // ═════════════════════════════════════════════════════════════════

    function test_directAccept_borrowerOfferBySelf_revertsSelfTradeForbidden() public {
        uint256 offerId = _postBorrowerOffer(borrower);
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferAcceptFacet.SelfTradeForbidden.selector,
                borrower
            )
        );
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
    }

    // ═════════════════════════════════════════════════════════════════
    // Test 3 — matchOffers with same-creator both sides reverts
    // ═════════════════════════════════════════════════════════════════

    /// @notice A single user posts both a lender offer and a borrower
    ///         offer; a third-party matcher tries to match them. The
    ///         load-bearing gate in `_acceptOffer` fires after role
    ///         resolution sets `lender == borrower == sameCreator`.
    ///
    /// @dev    The matcher (msg.sender on the matchOffers call) is the
    ///         `borrower` from SetupTest — a separate address — to
    ///         exercise the case where the third-party submitter is
    ///         NOT the colluding creator. The revert still fires
    ///         because the gate looks at `lender` vs `borrower`, not
    ///         at `msg.sender`.
    function test_matchOffers_sameCreatorBothSides_revertsSelfTradeForbidden() public {
        uint256 lenderOfferId = _postLenderOffer(lender);
        uint256 borrowerOfferId = _postBorrowerOffer(lender);

        // `borrower` (a different address) is the matcher / submitter.
        // The revert is about the LOAN sides collapsing, not about the
        // submitter — so the third-party matcher still gets the
        // typed error.
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(
                OfferAcceptFacet.SelfTradeForbidden.selector,
                lender
            )
        );
        OfferMatchFacet(address(diamond)).matchOffers(
            lenderOfferId,
            borrowerOfferId
        );
    }

    // ═════════════════════════════════════════════════════════════════
    // Test 4 — previewMatch surfaces MatchError.SelfTrade without
    //          reverting (bot short-circuit path)
    // ═════════════════════════════════════════════════════════════════

    function test_previewMatch_sameCreatorBothSides_returnsSelfTrade() public {
        uint256 lenderOfferId = _postLenderOffer(lender);
        uint256 borrowerOfferId = _postBorrowerOffer(lender);

        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(
                lenderOfferId,
                borrowerOfferId
            );
        assertEq(
            uint8(r.errorCode),
            uint8(LibOfferMatch.MatchError.SelfTrade),
            "previewMatch surfaces MatchError.SelfTrade"
        );
    }

    // ═════════════════════════════════════════════════════════════════
    // Test 5 — happy-path negative-control: different creators accept
    // ═════════════════════════════════════════════════════════════════

    /// @notice If the self-trade gate ever inverts (rejects every
    ///         accept) or accidentally compares the wrong field, this
    ///         test catches it. lender posts the offer; borrower (a
    ///         distinct address) accepts. The resulting loan has
    ///         `loan.lender == lender` and `loan.borrower == borrower`,
    ///         and the self-trade gate does NOT fire.
    function test_directAccept_differentCreators_acceptsCleanly() public {
        uint256 offerId = _postLenderOffer(lender);
        vm.prank(borrower);
        uint256 loanId =
            OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.lender, lender, "loan lender = lender (offer creator)");
        assertEq(loan.borrower, borrower, "loan borrower = borrower (acceptor)");
        assertEq(
            uint8(loan.status),
            uint8(LibVaipakam.LoanStatus.Active),
            "loan ends Active - self-trade gate did not fire"
        );
    }
}
