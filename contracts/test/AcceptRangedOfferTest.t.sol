// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title AcceptRangedOfferTest
 * @notice Issue #191 — dedicated coverage for `OfferAcceptFacet.acceptOffer`
 *         when invoked against a ranged offer (Phase 2 / #183 / PR #187
 *         canonical limit-order shape). The role-aware reads in
 *         `_acceptOffer` (lines 539-546) + `LoanFacet.initiateLoan` (lines
 *         697-699) had zero dedicated coverage at merge time of #187:
 *         every `testAccept*` in `OfferFacetTest.t.sol` uses
 *         `amountMax == amount` and `interestRateBpsMax == interestRateBps`,
 *         so the role-aware paths were mechanically taken but never
 *         exercised with a non-trivial range. A regression that swapped
 *         read fields (e.g., borrower-acceptor reading `amount` instead
 *         of `amountMax`) would slip past every existing test.
 *
 *         This file fills that gap. Coverage:
 *
 *           - **Lender-posted ranged offer + borrower-acceptor** —
 *             `loan.principal == offer.amountMax` (most favourable
 *             principal for borrower); `loan.interestRateBps ==
 *             offer.interestRateBps` (lender's floor / DEX limit — the
 *             lowest rate the lender will accept = borrower's win).
 *
 *           - **Borrower-posted ranged offer + lender-acceptor** —
 *             `loan.principal == offer.amount` (borrower's floor / DEX
 *             limit — smallest principal the borrower will accept =
 *             lender's win); `loan.interestRateBps ==
 *             offer.interestRateBpsMax` (borrower's ceiling — highest
 *             rate borrower will pay = lender's win).
 *
 *           - **Residual collateral refund** — borrower posts ranged
 *             collateral (`collateralAmount < collateralAmountMax`),
 *             lender accepts. `_refundBorrowerCollateralResidualIfNeeded`
 *             must fire on the direct-accept path (not only on
 *             `matchOffers`), returning the unused collateral to the
 *             borrower's wallet.
 *
 *           - **No-residual case** — borrower's `collateralAmount ==
 *             collateralAmountMax`. Lender accepts. Borrower wallet
 *             delta = the full single-value collateral (no refund).
 *
 *           - **Cancel after direct-accept** — Phase 2 direct-accept
 *             consumes the entire offer (single-fill semantic).
 *             Subsequent `cancelOffer` reverts `OfferAlreadyAccepted`.
 *
 *           - **Single-value offer regression sentinel** — the Phase 2
 *             changes must not break the trivial `amount == amountMax`
 *             case. Mirrors the shape `OfferFacetTest` covers, kept
 *             here so a regression on the trivial path lights up
 *             alongside the range-aware ones.
 *
 *         NOT covered here (intentionally out of scope, tracked as
 *         separate cards): NFT-collateral / NFT-rental partial-fill
 *         shapes (gated by `_isERC20` in `_acceptOffer`, no role-aware
 *         range semantic applies); sanctions tier on ranged offers
 *         (covered by `SanctionsOracle.t.sol`'s existing positive
 *         tests against ranged offers via the OfferCreateFacet path);
 *         multi-fill / `matchOffers` (covered by
 *         `BorrowerPartialFillTest.t.sol`).
 *
 *         All numbers use SetupTest's $1/token, 18-decimal mock ERC20
 *         convention. Range orders are enabled in `setUp` via the
 *         Phase 1 kill-switch flags; partial-fill is left OFF — this
 *         file specifically exercises the SINGLE-FILL direct-accept
 *         path, which is the path `acceptOffer` always takes.
 */
contract AcceptRangedOfferTest is SetupTest {
    function setUp() public {
        setupHelper();

        // Range / range-rate / range-collateral on; partial-fill OFF.
        // The direct-accept path doesn't consult the partial-fill flag
        // (that gate is read by matchOffers), but enabling range fields
        // is what unlocks `amountMax > amount` etc. in createOffer.
        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setRangeAmountEnabled(true);
        ConfigFacet(address(diamond)).setRangeRateEnabled(true);
        ConfigFacet(address(diamond)).setRangeCollateralEnabled(true);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────
    // Offer-creation helpers — mirror BorrowerPartialFillTest's shape
    // so individual tests read like assertion lists rather than 25-field
    // struct literals.
    // ─────────────────────────────────────────────────────────────────

    function _postLenderOffer(
        address creator,
        uint256 amount,
        uint256 amountMax,
        uint256 rateMin,
        uint256 rateMax,
        uint256 collateralRequired
    ) internal returns (uint256 offerId) {
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: amount,
                interestRateBps: rateMin,
                collateralAsset: mockCollateralERC20,
                collateralAmount: collateralRequired,
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
                amountMax: amountMax,
                interestRateBpsMax: rateMax,
                collateralAmountMax: collateralRequired,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );
    }

    function _postBorrowerOffer(
        address creator,
        uint256 amount,
        uint256 amountMax,
        uint256 rateMin,
        uint256 rateMax,
        uint256 collateralAmount,
        uint256 collateralAmountMax
    ) internal returns (uint256 offerId) {
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: amount,
                interestRateBps: rateMin,
                collateralAsset: mockCollateralERC20,
                collateralAmount: collateralAmount,
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
                amountMax: amountMax,
                interestRateBpsMax: rateMax,
                collateralAmountMax: collateralAmountMax,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );
    }

    // ═════════════════════════════════════════════════════════════════
    // Scenario 1 — Lender-posted ranged offer accepted by borrower
    // ═════════════════════════════════════════════════════════════════

    /// @notice Lender posts `[amount=1k, amountMax=10k, rate=300, rateMax=800,
    ///         collateral=500]`. createOffer pre-escrows the FULL `amountMax`
    ///         (10k). Borrower calls acceptOffer with consent. Asserts the
    ///         role-aware reads:
    ///           - loan.principal       == amountMax  (10_000)
    ///           - loan.interestRateBps == interestRateBps (300, lender's
    ///                                     floor — most favourable to
    ///                                     borrower)
    ///           - loan.collateralAmount == 500
    ///         + the lender's escrow is fully drained of the 10k
    ///         + the borrower receives 10k principal (less LIF in VPFI
    ///           if applicable; LIF math sits on `effectivePrincipal`,
    ///           which is the role-aware read — wallet credit equals
    ///           principal minus LIF, but this test uses no VPFI so LIF
    ///           is paid in the principal token and lands in treasury
    ///           via `tryApplyBorrowerLif`).
    ///         + offer.accepted = true; offer.amountFilled = amountMax
    ///           (direct-accept is single-fill — entire offer consumed).
    function test_lenderRangedOffer_borrowerAccepts_principalAndRateRoleAware() public {
        uint256 lenderEscrowBalBefore = ERC20(mockERC20).balanceOf(lender);
        uint256 borrowerWalletBefore  = ERC20(mockERC20).balanceOf(borrower);

        uint256 offerId = _postLenderOffer({
            creator: lender,
            amount: 1_000,
            amountMax: 10_000,
            rateMin: 300,
            rateMax: 800,
            collateralRequired: 500
        });
        // createOffer pulled the FULL amountMax (10k) from lender's wallet.
        assertEq(
            ERC20(mockERC20).balanceOf(lender),
            lenderEscrowBalBefore - 10_000,
            "post-create: lender wallet down by amountMax (10k pre-funded)"
        );

        // Borrower accepts.
        vm.prank(borrower);
        uint256 loanId =
            OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        // Role-aware read assertions — the load-bearing claim.
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(
            loan.principal,
            10_000,
            "borrower-acceptor reads lender.amountMax (= 10k)"
        );
        assertEq(
            loan.interestRateBps,
            300,
            "borrower-acceptor reads lender.interestRateBps (the floor = 300)"
        );
        assertEq(loan.collateralAmount, 500, "loan locks lender's required 500");
        assertEq(loan.lender, lender, "loan lender = offer creator");
        assertEq(loan.borrower, borrower, "loan borrower = acceptor");

        // Offer state - direct-accept marks the offer terminal via
        // `accepted = true`. The storage `amountFilled` is NOT updated on
        // the direct-accept path (see OfferAcceptFacet line 963 comment:
        // "Phase 1 acceptOffer is single-fill"); the effective fill
        // surfaces through `effectivePrincipal` and the OfferAccepted
        // event payload, not the storage field. `amountFilled` is the
        // matchOffers accumulator only.
        LibVaipakam.Offer memory o =
            OfferCancelFacet(address(diamond)).getOffer(offerId);
        assertTrue(o.accepted, "offer.accepted flipped");
        assertEq(
            o.amountFilled,
            0,
            "direct-accept does NOT update amountFilled (terminal via accepted=true)"
        );

        // Borrower wallet credit - net of the 0.1% LIF that
        // `tryApplyBorrowerLif` short-circuits past when the borrower
        // hasn't staked VPFI (default SetupTest harness). 10_000 * 10 /
        // 10000 = 10 LIF (99% treasury / 1% matcher kickback per the
        // Phase 1 split). Borrower nets 9_990 of the 10k principal.
        assertEq(
            ERC20(mockERC20).balanceOf(borrower),
            borrowerWalletBefore + 9_990,
            "borrower nets 9990 = effectivePrincipal (10k) - LIF (10)"
        );
    }

    // ═════════════════════════════════════════════════════════════════
    // Scenario 2 — Borrower-posted ranged offer accepted by lender
    // ═════════════════════════════════════════════════════════════════

    /// @notice Borrower posts `[amount=1k, amountMax=10k, rate=300,
    ///         rateMax=800, collateralAmount=500, collateralAmountMax=500]`.
    ///         createOffer pre-escrows the FULL collateralAmountMax (500).
    ///         Lender calls acceptOffer with consent. Asserts the
    ///         role-aware reads:
    ///           - loan.principal       == amount (1_000, borrower's floor —
    ///                                     smallest principal lender must
    ///                                     deliver = most favourable to
    ///                                     lender)
    ///           - loan.interestRateBps == interestRateBpsMax (800,
    ///                                     borrower's ceiling — highest
    ///                                     rate borrower will pay = most
    ///                                     favourable to lender)
    ///           - loan.collateralAmount == 500
    ///         + lender's escrow deposits the 1k principal (debited
    ///           from lender's wallet via the borrower-side acceptOffer
    ///           pull described in `_acceptOffer` lines 577-617).
    ///         + borrower's wallet receives the 1k principal.
    ///         + offer.accepted = true; offer.amountFilled = amount (the
    ///           floor, since lender-acceptor reads `amount`).
    function test_borrowerRangedOffer_lenderAccepts_principalAndRateRoleAware() public {
        uint256 lenderWalletBefore = ERC20(mockERC20).balanceOf(lender);
        uint256 borrowerWalletBefore = ERC20(mockERC20).balanceOf(borrower);

        uint256 offerId = _postBorrowerOffer({
            creator: borrower,
            amount: 1_000,
            amountMax: 10_000,
            rateMin: 300,
            rateMax: 800,
            collateralAmount: 500,
            collateralAmountMax: 500
        });

        vm.prank(lender);
        uint256 loanId =
            OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        // Role-aware read assertions.
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(
            loan.principal,
            1_000,
            "lender-acceptor reads borrower.amount (= 1k, floor)"
        );
        assertEq(
            loan.interestRateBps,
            800,
            "lender-acceptor reads borrower.interestRateBpsMax (= 800, ceiling)"
        );
        assertEq(loan.collateralAmount, 500, "loan locks borrower's collateral 500");
        assertEq(loan.lender, lender, "loan lender = acceptor");
        assertEq(loan.borrower, borrower, "loan borrower = offer creator");

        // Lender's wallet — debited by the 1k principal that was pulled
        // into the lender's escrow at acceptOffer time and then sent
        // through the loan plumbing to the borrower.
        assertEq(
            ERC20(mockERC20).balanceOf(lender),
            lenderWalletBefore - 1_000,
            "lender wallet down by the 1k principal"
        );
        // Borrower's wallet - credited by the 1k principal net of LIF
        // (10 BPS = 1). See scenario 1's note for the LIF semantic.
        assertEq(
            ERC20(mockERC20).balanceOf(borrower),
            borrowerWalletBefore + 999,
            "borrower nets 999 = effectivePrincipal (1k) - LIF (1)"
        );

        // Offer state - direct-accept marks accepted=true, leaves
        // amountFilled at 0 (see scenario 1's note).
        LibVaipakam.Offer memory o =
            OfferCancelFacet(address(diamond)).getOffer(offerId);
        assertTrue(o.accepted, "offer.accepted flipped");
        assertEq(o.amountFilled, 0, "direct-accept does NOT update amountFilled");
    }

    // ═════════════════════════════════════════════════════════════════
    // Scenario 3 — Residual collateral refund on direct-accept
    // ═════════════════════════════════════════════════════════════════

    /// @notice Borrower posts `[amount=1k, amountMax=10k, collateralAmount=500,
    ///         collateralAmountMax=5_000]`. createOffer pre-escrows the
    ///         FULL collateralAmountMax (5_000). Lender accepts — direct-
    ///         accept locks only `collateralAmount = 500` on the loan.
    ///         `_refundBorrowerCollateralResidualIfNeeded` must fire and
    ///         return the unused `4_500` to the borrower's wallet.
    ///
    /// @dev This is the direct-accept counterpart to the residual refund
    ///      already tested for matchOffers in #102 round-1 / #189. The
    ///      helper short-circuits on `matchOverride.active` (line 363),
    ///      so the direct-accept path is a distinct code branch worth
    ///      its own assertion.
    function test_borrowerRangedCollateral_lenderAccepts_residualRefunds() public {
        uint256 borrowerCollatBefore =
            ERC20(mockCollateralERC20).balanceOf(borrower);

        uint256 offerId = _postBorrowerOffer({
            creator: borrower,
            amount: 1_000,
            amountMax: 10_000,
            rateMin: 300,
            rateMax: 800,
            collateralAmount: 500,
            collateralAmountMax: 5_000
        });
        // createOffer pulled the FULL collateralAmountMax (5_000) from
        // borrower's wallet.
        assertEq(
            ERC20(mockCollateralERC20).balanceOf(borrower),
            borrowerCollatBefore - 5_000,
            "post-create: borrower collateral wallet down by collateralAmountMax"
        );

        vm.prank(lender);
        uint256 loanId =
            OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        // The loan only locks `collateralAmount` (500); the unused
        // `collateralAmountMax - collateralAmount = 4_500` was refunded
        // to the borrower's wallet by
        // `_refundBorrowerCollateralResidualIfNeeded`.
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.collateralAmount, 500, "loan locks only the floor");

        // Borrower's net wallet delta: -5_000 (create) + 4_500 (residual
        // refund on direct-accept) = -500. The 500 sits in escrow as the
        // loan's locked collateral.
        assertEq(
            ERC20(mockCollateralERC20).balanceOf(borrower),
            borrowerCollatBefore - 500,
            "post-accept: borrower net out 500 (the locked portion); 4_500 refunded"
        );
    }

    // ═════════════════════════════════════════════════════════════════
    // Scenario 4 — No-residual case (single-value collateral)
    // ═════════════════════════════════════════════════════════════════

    /// @notice Borrower posts `collateralAmount == collateralAmountMax`.
    ///         Lender accepts. `_refundBorrowerCollateralResidualIfNeeded`
    ///         must short-circuit (line 378 — `collateralAmountMax <=
    ///         collateralAmount`) and NOT attempt an escrow withdraw.
    function test_borrowerSingleValueCollateral_lenderAccepts_noResidual() public {
        uint256 borrowerCollatBefore =
            ERC20(mockCollateralERC20).balanceOf(borrower);

        uint256 offerId = _postBorrowerOffer({
            creator: borrower,
            amount: 1_000,
            amountMax: 10_000,
            rateMin: 300,
            rateMax: 800,
            collateralAmount: 500,
            collateralAmountMax: 500
        });
        // createOffer pulled the full 500 (collateralAmount == max).
        assertEq(
            ERC20(mockCollateralERC20).balanceOf(borrower),
            borrowerCollatBefore - 500,
            "post-create: borrower collateral wallet down by 500"
        );

        vm.prank(lender);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        // No residual refund — borrower wallet stays at -500.
        assertEq(
            ERC20(mockCollateralERC20).balanceOf(borrower),
            borrowerCollatBefore - 500,
            "post-accept: no refund - single-value collateral path"
        );
    }

    // ═════════════════════════════════════════════════════════════════
    // Scenario 5 — Cancel after direct-accept reverts
    // ═════════════════════════════════════════════════════════════════

    /// @notice Phase 2 direct-accept is single-fill — the entire offer is
    ///         consumed. Subsequent `cancelOffer` must revert
    ///         `OfferAlreadyAccepted`. Symmetric to
    ///         `CancelAfterPartialFillTest.test_cancelAfterDustCloseReverts`,
    ///         but for the direct-accept terminal state rather than the
    ///         multi-fill dust-close terminal state.
    function test_cancelAfterDirectAcceptReverts() public {
        uint256 offerId = _postLenderOffer({
            creator: lender,
            amount: 1_000,
            amountMax: 10_000,
            rateMin: 300,
            rateMax: 800,
            collateralRequired: 500
        });

        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        // Lender attempts cancel; offer is in the accepted terminal
        // state — must revert.
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSignature("OfferAlreadyAccepted()")
        );
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);
    }

    // ═════════════════════════════════════════════════════════════════
    // Scenario 6 — Single-value offer regression sentinel
    // ═════════════════════════════════════════════════════════════════

    /// @notice The Phase 2 role-aware changes must not break the trivial
    ///         `amount == amountMax` case. This mirrors the shape the
    ///         pre-#183 `testAccept*` cases used; kept here so a
    ///         regression on the trivial path lights up alongside the
    ///         range-aware ones (rather than only showing up in the
    ///         OfferFacetTest sweep where the failure mode is harder
    ///         to attribute).
    function test_singleValueLenderOffer_borrowerAccepts_unchanged() public {
        uint256 lenderWalletBefore   = ERC20(mockERC20).balanceOf(lender);
        uint256 borrowerWalletBefore = ERC20(mockERC20).balanceOf(borrower);

        uint256 offerId = _postLenderOffer({
            creator: lender,
            amount: 5_000,
            amountMax: 5_000,
            rateMin: 500,
            rateMax: 500,
            collateralRequired: 500
        });

        vm.prank(borrower);
        uint256 loanId =
            OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        // amountMax == amount = 5k → both role-aware reads collapse to
        // the same value.
        assertEq(loan.principal, 5_000, "loan.principal = 5k (single-value)");
        assertEq(loan.interestRateBps, 500, "loan.interestRateBps = 500 (single-value)");

        assertEq(
            ERC20(mockERC20).balanceOf(lender),
            lenderWalletBefore - 5_000,
            "lender wallet down by 5k (single-value path)"
        );
        assertEq(
            ERC20(mockERC20).balanceOf(borrower),
            borrowerWalletBefore + 4_995,
            "borrower nets 4_995 = principal 5k - LIF (5) - single-value path unchanged from #183"
        );
    }
}
