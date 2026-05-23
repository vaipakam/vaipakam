// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";

/**
 * @title CancelAfterPartialFillTest
 * @notice Issue #188 — dedicated coverage for `OfferCancelFacet.cancelOffer`
 *         when invoked AFTER one or more partial matches landed on the
 *         offer. The implementation in `OfferCancelFacet` is already
 *         correct (verified during the #183 review; the borrower-side
 *         refund subtracts `collateralAmountFilled` per the Codex P0
 *         fix from #102 round-1). What's missing is the dedicated
 *         test that pins the math so a future refactor can't silently
 *         break it.
 *
 *         Coverage:
 *           - **Lender partial-fill → cancel** — `refund =
 *             effAmountMax - amountFilled`; loan from the prior match
 *             stays alive; offer.accepted flips to true.
 *           - **Borrower partial-fill → cancel** — `refund = collateralMax
 *             - collateralAmountFilled` (the Codex P0 fix). Loan's
 *             locked collateral stays intact (not double-withdrawn).
 *           - **Cancel cooldown bypassed when amountFilled > 0** — even
 *             within the MIN_OFFER_CANCEL_DELAY window, the partial-
 *             filled offer cancels cleanly (no `CancelCooldownActive`).
 *           - **Dust-close terminus → cancel reverts** — once the
 *             offer flipped `accepted = true` (multi-match dust-close
 *             scenario from #173's BorrowerPartialFillTest), subsequent
 *             cancel reverts `OfferAlreadyAccepted`.
 *
 *         Inherits `SetupTest` for the diamond setup and helpers;
 *         partial-fill master flag flipped on per the #173 / #102
 *         pattern.
 *
 *         All numbers use the SetupTest oracle convention: $1 per
 *         token, 18-decimal mock ERC20s, 8-decimal price feeds.
 */
contract CancelAfterPartialFillTest is SetupTest {
    address lender2;
    address lender3;

    function setUp() public {
        setupHelper();

        // Range / partial-fill flags ON — the matchOffers path is the
        // ONLY way to land a partial fill (direct-accept consumes the
        // whole offer / single-fill semantic).
        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setRangeAmountEnabled(true);
        ConfigFacet(address(diamond)).setRangeRateEnabled(true);
        ConfigFacet(address(diamond)).setRangeCollateralEnabled(true);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        vm.stopPrank();

        // Two extra lenders for multi-match scenarios. SetupTest's
        // `owner` is the test contract itself and gets no token
        // approvals — using it as a third lender would trip
        // `ERC20InsufficientAllowance` at createOffer's principal pull.
        lender2 = makeAddr("lender2");
        lender3 = makeAddr("lender3");
        ERC20Mock(mockERC20).mint(lender2, 100_000 ether);
        ERC20Mock(mockERC20).mint(lender3, 100_000 ether);
        vm.prank(lender2);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender3);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender2);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(lender3);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender2, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(lender3, LibVaipakam.KYCTier.Tier2);
    }

    // ─────────────────────────────────────────────────────────────────
    // Helpers — mirror the BorrowerPartialFillTest pattern so tests
    // read like assertion lists rather than 25-field struct literals.
    // ─────────────────────────────────────────────────────────────────

    function _postBorrowerOffer(
        address creator,
        uint256 amountMin,
        uint256 amountMax,
        uint256 rateMin,
        uint256 rateMax,
        uint256 collateralMin,
        uint256 collateralMax
    ) internal returns (uint256 offerId) {
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: amountMin,
                interestRateBps: rateMin,
                collateralAsset: mockCollateralERC20,
                collateralAmount: collateralMin,
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
                collateralAmountMax: collateralMax,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial
            })
        );
    }

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
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial
            })
        );
    }

    // ─────────────────────────────────────────────────────────────────
    // Scenario 1 — Lender partial-fill then cancel
    // ─────────────────────────────────────────────────────────────────

    /// @notice Lender posts a `[1k, 10k]` ranged offer. One matchOffers
    ///         consumes 5k. Lender cancels. Assert (a) the lender's
    ///         wallet receives only `10k - 5k = 5k` (the unfilled
    ///         remainder, NOT the full 10k), (b) the loan from the
    ///         earlier match is unaffected (its principal stays at the
    ///         matched amount on the loan struct), (c) the cancel
    ///         cooldown was bypassed (no `vm.warp` past the delay).
    function test_lenderPartialFillThenCancel() public {
        // Lender's pre-create wallet balance — establishes baseline.
        uint256 lenderWalletBefore = ERC20(mockERC20).balanceOf(lender);

        uint256 lenderOfferId = _postLenderOffer({
            creator: lender,
            amount: 1_000,
            amountMax: 10_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 500
        });
        // createOffer pulled the full amountMax (10_000) from lender's
        // wallet into their vault as pre-funded pool.
        assertEq(
            ERC20(mockERC20).balanceOf(lender),
            lenderWalletBefore - 10_000,
            "post-create: lender wallet down by amountMax"
        );

        // Borrower posts the matching counterparty range. Pick a
        // range that overlaps lender's [1_000, 10_000] at the match
        // midpoint of 5_000 specifically.
        uint256 borrowerOfferId = _postBorrowerOffer({
            creator: borrower,
            amountMin: 5_000,
            amountMax: 5_000,
            rateMin: 500,
            rateMax: 600,
            collateralMin: 500,
            collateralMax: 500
        });

        // First (and only) partial match — consumes 5_000 of the
        // lender's 10_000 pool.
        uint256 loanId =
            OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);

        LibVaipakam.Offer memory L =
            OfferCancelFacet(address(diamond)).getOffer(lenderOfferId);
        assertEq(L.amountFilled, 5_000, "post-match: lender filled by 5k");
        assertFalse(L.accepted, "lender stays OPEN with 5k remaining");

        // Snapshot the live loan's principal/collateral/status BEFORE the
        // cancel so we can prove the cancel does NOT mutate the matched
        // loan's accounting. Without this snapshot the test only proves
        // the lender's wallet refund is correct — a regression that
        // computed the refund correctly but ALSO mistakenly debited the
        // loan's principal would slip past.
        //
        // The exact prorating math (loan.collateralAmount =
        // lender.collateralRequired × matched/amountMax = 500 × 5k/10k
        // = 250 here) is exercised by matchOffers' own dedicated tests
        // — this test asserts only the cancel-invariance shape: take
        // the snapshot, do the cancel, snapshot equals.
        LibVaipakam.Loan memory loanBefore =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loanBefore.principal, 5_000, "pre-cancel: loan principal = 5k");
        assertGt(loanBefore.collateralAmount, 0, "pre-cancel: loan has collateral locked");
        assertEq(
            uint8(loanBefore.status),
            uint8(LibVaipakam.LoanStatus.Active),
            "pre-cancel: loan Active"
        );

        // Lender cancels. Cooldown is bypassed because amountFilled > 0
        // (per OfferCancelFacet line ~110-118).
        vm.prank(lender);
        OfferCancelFacet(address(diamond)).cancelOffer(lenderOfferId);

        // Refund check: lender's wallet receives `amountMax -
        // amountFilled = 10_000 - 5_000 = 5_000` back. Net wallet
        // delta from pre-create: -10_000 (create) + 5_000 (cancel
        // refund) = -5_000. The other 5_000 is sitting in the
        // borrower's vault as the loan's principal.
        assertEq(
            ERC20(mockERC20).balanceOf(lender),
            lenderWalletBefore - 5_000,
            "post-cancel: lender net out 5k (the matched portion)"
        );

        // Storage row preserved with accepted = true (per the design;
        // partial-filled offers don't get the storage delete that
        // never-matched offers do).
        LibVaipakam.Offer memory LPost =
            OfferCancelFacet(address(diamond)).getOffer(lenderOfferId);
        assertTrue(LPost.accepted, "cancelled-after-partial offer: accepted=true");
        assertEq(LPost.amountFilled, 5_000, "amountFilled snapshot preserved");

        // Loan-invariant assertion (P2.3 Codex round-1 #189): the cancel
        // must touch the lender's residual vault and NOTHING ELSE.
        // The live loan's principal, collateral, and status are
        // identical to their pre-cancel snapshot.
        LibVaipakam.Loan memory loanAfter =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loanAfter.principal, loanBefore.principal, "loan principal untouched");
        assertEq(
            loanAfter.collateralAmount,
            loanBefore.collateralAmount,
            "loan collateral untouched"
        );
        assertEq(uint8(loanAfter.status), uint8(loanBefore.status), "loan still Active");
        assertEq(loanAfter.lender, lender, "loan lender unchanged");
        assertEq(loanAfter.borrower, borrower, "loan borrower unchanged");
    }

    // ─────────────────────────────────────────────────────────────────
    // Scenario 2 — Borrower partial-fill then cancel (Codex P0 fix)
    // ─────────────────────────────────────────────────────────────────

    /// @notice Borrower posts a range `[1k, 10k]` lending with collateral
    ///         range `[500, 5_000]`. One match consumes 5k principal + 500
    ///         collateral. Borrower cancels. Assert (a) borrower's wallet
    ///         receives only `5_000 - 500 = 4_500` collateral (NOT the
    ///         full 5_000 they pre-vaulted), (b) the live loan's 500
    ///         collateral backing is untouched, (c) cancel cooldown
    ///         bypassed.
    ///
    /// @dev This is the regression test for the Codex P0 fix from #102
    ///      round-1. Without the `- collateralAmountFilled` subtraction,
    ///      the borrower would withdraw 5_000 — including the 500
    ///      backing the live loan — and the loan would be
    ///      collateral-stripped. Real fund-lock vector for the lender's
    ///      repayment / liquidation claim.
    function test_borrowerPartialFillThenCancel_collateralAmountFilledSubtract() public {
        uint256 borrowerWalletBefore =
            ERC20(mockCollateralERC20).balanceOf(borrower);

        uint256 borrowerOfferId = _postBorrowerOffer({
            creator: borrower,
            amountMin: 1_000,
            amountMax: 10_000,
            rateMin: 500,
            rateMax: 600,
            collateralMin: 500,
            collateralMax: 5_000
        });
        // createOffer pulled the full collateralAmountMax (5_000) from
        // borrower's wallet into their vault.
        assertEq(
            ERC20(mockCollateralERC20).balanceOf(borrower),
            borrowerWalletBefore - 5_000,
            "post-create: borrower wallet down by collateralAmountMax"
        );

        // Lender for one matchOffers — consumes 5k principal + locks
        // 500 collateral on the resulting loan.
        uint256 lenderOfferId = _postLenderOffer({
            creator: lender,
            amount: 5_000,
            amountMax: 5_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 500
        });
        uint256 loanId =
            OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);

        LibVaipakam.Offer memory B =
            OfferCancelFacet(address(diamond)).getOffer(borrowerOfferId);
        assertEq(B.amountFilled, 5_000, "post-match: borrower amountFilled = 5k");
        assertEq(B.collateralAmountFilled, 500, "post-match: 500 collateral locked");
        assertFalse(B.accepted, "borrower stays OPEN with capacity remaining");

        // Snapshot the live loan's collateral/principal/status BEFORE
        // the cancel — see the lender-side test for the rationale.
        // Specifically for the borrower path this proves the cancel
        // does NOT unlock the 500-collateral backing the loan; the
        // Codex P0 fix from #102 round-1 is exactly the bug where it
        // DID get unlocked, so the loan-side assertion is the
        // direct regression oracle for that fix.
        LibVaipakam.Loan memory loanBefore =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loanBefore.principal, 5_000, "pre-cancel: loan principal = 5k");
        assertEq(loanBefore.collateralAmount, 500, "pre-cancel: loan collateral = 500");
        assertEq(
            uint8(loanBefore.status),
            uint8(LibVaipakam.LoanStatus.Active),
            "pre-cancel: loan Active"
        );

        // Borrower cancels. Refund = collateralAmountMax -
        // collateralAmountFilled = 5_000 - 500 = 4_500. The 500
        // backing the live loan stays in vault.
        vm.prank(borrower);
        OfferCancelFacet(address(diamond)).cancelOffer(borrowerOfferId);

        // Net borrower wallet delta from pre-create:
        //   -5_000 (create deposit) + 4_500 (cancel refund) = -500
        // The 500 sitting in vault is the live loan's collateral.
        assertEq(
            ERC20(mockCollateralERC20).balanceOf(borrower),
            borrowerWalletBefore - 500,
            "post-cancel: borrower net out 500 (the locked portion)"
        );

        // Loan-invariant assertion (P2.4 Codex round-1 #189): the live
        // loan's locked collateral, principal, and status are identical
        // to their pre-cancel snapshot. This is the direct regression
        // oracle for the Codex P0 fix from #102 round-1 — a refactor
        // that mistakenly unlocked the 500 collateral on cancel would
        // be caught here even if the wallet delta math happened to
        // line up.
        LibVaipakam.Loan memory loanAfter =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(
            loanAfter.collateralAmount,
            loanBefore.collateralAmount,
            "loan collateral untouched (the 500 still backs the loan)"
        );
        assertEq(loanAfter.principal, loanBefore.principal, "loan principal untouched");
        assertEq(uint8(loanAfter.status), uint8(loanBefore.status), "loan still Active");
        assertEq(loanAfter.lender, lender, "loan lender unchanged");
        assertEq(loanAfter.borrower, borrower, "loan borrower unchanged");
    }

    // ─────────────────────────────────────────────────────────────────
    // Scenario 3 — Cancel cooldown bypassed when amountFilled > 0
    // ─────────────────────────────────────────────────────────────────

    /// @notice OfferCancelFacet line ~112-118 enforces a cooldown
    ///         (`MIN_OFFER_CANCEL_DELAY`) on never-matched offers only
    ///         when `partialFillEnabled` is on — to prevent front-run
    ///         attacks on the matching mempool. Partial-filled offers
    ///         (`amountFilled > 0`) bypass the cooldown
    ///         unconditionally because the creator already committed
    ///         value through prior matches; the front-run vector
    ///         doesn't apply.
    ///
    ///         This test exercises the bypass: a partially-filled
    ///         lender offer cancels successfully WITHIN the cooldown
    ///         window (no `vm.warp` past the delay) and the cancel
    ///         doesn't revert `CancelCooldownActive`.
    function test_cancelCooldownBypassedForPartiallyFilled() public {
        // Note: SetupTest sets block.timestamp at 1 by default; the
        // cooldown is MIN_OFFER_CANCEL_DELAY seconds (5 minutes
        // typically). We deliberately DON'T warp here — the partial-
        // fill bypass should fire even at block.timestamp ≈ createdAt.

        // Control case (P2.1 Codex round-1 #189): post an unmatched
        // lender offer FIRST and assert that an immediate cancel
        // reverts with `CancelCooldownActive`. This proves the
        // cooldown is actually wired and would catch a regression
        // that broke the partial-fill bypass on the next assertion
        // by simply turning the cooldown off globally.
        uint256 unmatchedOfferId = _postLenderOffer({
            creator: lender2,
            amount: 1_000,
            amountMax: 10_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 500
        });
        vm.prank(lender2);
        vm.expectRevert(OfferCancelFacet.CancelCooldownActive.selector);
        OfferCancelFacet(address(diamond)).cancelOffer(unmatchedOfferId);

        // Partial-filled offer — same shape, but a match lands.
        uint256 lenderOfferId = _postLenderOffer({
            creator: lender,
            amount: 1_000,
            amountMax: 10_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 500
        });
        uint256 borrowerOfferId = _postBorrowerOffer({
            creator: borrower,
            amountMin: 5_000,
            amountMax: 5_000,
            rateMin: 500,
            rateMax: 600,
            collateralMin: 500,
            collateralMax: 500
        });
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);

        // Cancel immediately — no warp, partial-fill bypass active.
        vm.prank(lender);
        OfferCancelFacet(address(diamond)).cancelOffer(lenderOfferId);
        // Reach here ⇒ no `CancelCooldownActive` revert. The bypass
        // path is genuinely the one that fired (the control above
        // proved cooldown is active for amountFilled == 0).
    }

    // ─────────────────────────────────────────────────────────────────
    // Scenario 4 — Cancel after dust-close terminus reverts
    // ─────────────────────────────────────────────────────────────────

    /// @notice When matchOffers' multi-fill drains a borrower offer to
    ///         dust (`borrowerRemaining < B.amount`), `OfferMatchFacet`
    ///         flips `accepted = true` and refunds the residual
    ///         collateral. Subsequent `cancelOffer` should revert
    ///         `OfferAlreadyAccepted` — the offer is in its terminal
    ///         state. Verify that.
    function test_cancelAfterDustCloseReverts() public {
        uint256 borrowerOfferId = _postBorrowerOffer({
            creator: borrower,
            amountMin: 1_000,
            amountMax: 10_000,
            rateMin: 500,
            rateMax: 600,
            collateralMin: 500,
            collateralMax: 5_000
        });
        // Drain via three lender matches at 5_000 / 4_000 / 1_000
        // (same shape as #173's `test_multiFillDrainsBorrower_dustCloseFires`).
        uint256 lenderOfferId1 = _postLenderOffer({
            creator: lender,
            amount: 5_000,
            amountMax: 5_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 500
        });
        uint256 lenderOfferId2 = _postLenderOffer({
            creator: lender2,
            amount: 4_000,
            amountMax: 4_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 500
        });
        // The third match is the dust-close trigger.
        uint256 lenderOfferId3 = _postLenderOffer({
            creator: lender3,
            amount: 1_000,
            amountMax: 1_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 500
        });

        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId1, borrowerOfferId);
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId2, borrowerOfferId);
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId3, borrowerOfferId);

        // Dust-close flipped accepted = true on the third match.
        LibVaipakam.Offer memory B =
            OfferCancelFacet(address(diamond)).getOffer(borrowerOfferId);
        assertTrue(B.accepted, "dust-close terminus reached");

        // Cancel attempt should revert OfferAlreadyAccepted.
        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSignature("OfferAlreadyAccepted()")
        );
        OfferCancelFacet(address(diamond)).cancelOffer(borrowerOfferId);
    }
}
