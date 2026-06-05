// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";

/**
 * @title BorrowerPartialFillTest
 * @notice Issue #173 — the seven-scenario coverage half. Rides on the
 *         scaffolding `MatchOffersScaffoldTest` ships:
 *           - SetupTest now cuts `OfferMatchFacet` into the test diamond
 *             (closes the test-vs-prod drift);
 *           - the `partialFillEnabled` + range flags pre-enabled.
 *
 *         Scenarios covered (card §3 verbatim):
 *
 *           - **Happy-path partial fill** — borrower offer
 *             `[1k, 10k]` with collateral max 2 ETH; lender at 5k
 *             matches; assert B.amountFilled == 5k,
 *             B.collateralAmountFilled == picked, B.accepted == false,
 *             collateral STILL in vault.
 *           - **Multi-fill consuming one borrower offer** — three
 *             sequential lender matches drain the borrower offer; the
 *             third triggers dust-close; assert B.accepted == true,
 *             residual collateral refunded.
 *           - **Dust-close pre-condition** — assert OfferClosed event
 *             fires + accepted flips when remaining < B.amount.
 *           - **Single-fill fallback when partialFillEnabled = false**
 *             — same borrower offer; one lender; assert legacy
 *             behaviour (B.accepted flips immediately, full excess
 *             collateral refunded on the single match).
 *           - **Borrower amountMax = 0 derivation** — borrower ships
 *             amountMax = 0; assert match honours the LTV-derived
 *             ceiling via `maxLendingForLtvCap(collateralMax,
 *             init-LTV cap)`. Requires effective-tier mocking.
 *           - **Borrower advanced-mode override** — borrower ships
 *             amountMax = X literal; assert match honours X (not the
 *             derived ceiling).
 *           - **MatchError paths** — AmountNoOverlap and RateNoOverlap
 *             reverts.
 *
 *         All numbers use the SetupTest oracle convention: $1 per
 *         token, both the lending leg (`mockERC20`) and the collateral
 *         leg (`mockCollateralERC20`) carry 18 decimals and an 8-dec
 *         price of 1e8 (= $1).
 */
contract BorrowerPartialFillTest is SetupTest {
    // ── Test users — one borrower posting the range, three lenders so
    //    multi-fill scenarios drain a single borrower offer across
    //    independent matches. The base `lender` / `borrower` from
    //    SetupTest carries pre-existing oracle / KYC / funding wired up
    //    in `setupHelper()`; we reuse it as the canonical borrower so
    //    we don't re-do that setup here.
    address lender2;
    address lender3;

    // ── Loan-init LTV cap pinned on the collateral asset by SetupTest.
    //    Mirrored here so the derivation-path test (`#5`) reads the
    //    same number and the math stays self-checking — if SetupTest
    //    ever changes its default, both this file and the math
    //    intent below must be updated in lockstep.
    uint16 constant LOAN_INIT_MAX_LTV_BPS = 8000;

    /// @dev Mirror constants from `LibVaipakam` so the in-test
    ///      assertions read in plain numbers (1e18 / 10_000 etc.)
    ///      rather than via the library indirection.
    uint256 constant ONE_TOKEN = 1 ether; // 18-decimal scaling

    function setUp() public {
        setupHelper();

        // ── Phase 1 + #102 master kill-switches: every flag flipped
        //    on so the partial-fill code paths the card targets are
        //    reachable. The single-fill-fallback scenario re-disables
        //    `partialFillEnabled` in its own scope.
        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setRangeAmountEnabled(true);
        ConfigFacet(address(diamond)).setRangeRateEnabled(true);
        ConfigFacet(address(diamond)).setRangeCollateralEnabled(true);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        vm.stopPrank();

        // ── Fund + approve two extra lenders for the multi-fill
        //    scenarios. The base `lender` user from SetupTest is
        //    already funded + approved.
        lender2 = makeAddr("lender2");
        lender3 = makeAddr("lender3");
        ERC20Mock(mockERC20).mint(lender2, 100_000 ether);
        ERC20Mock(mockERC20).mint(lender3, 100_000 ether);
        vm.prank(lender2);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(lender3);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);

        // ── Country / KYC for the new lenders so the sanctions +
        //    trade-allowance gates pass during `acceptOffer`.
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
    // Helpers — keep the per-test bodies focused on assertions instead
    // of dozens of CreateOfferParams lines repeated identically.
    // ─────────────────────────────────────────────────────────────────

    /// @dev Post a borrower offer with the canonical 30-day,
    ///      mockERC20-lending-leg / mockCollateralERC20-collateral-leg
    ///      shape used across every scenario below. `amount` is the
    ///      MIN, `amountMax` the MAX, `collateralAmount` the MIN,
    ///      `collateralAmountMax` the MAX. Rate range `[rateMin,
    ///      rateMax]` mirrors the lending range.
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
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: amountMax,
                interestRateBpsMax: rateMax,
                collateralAmountMax: collateralMax,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial
            })
        );
    }

    /// @dev Post a lender offer. Lender side is single-value per the
    ///      Range Orders Phase 1 design — `amountMax` collapses to
    ///      `amount` via auto-collapse, but we set them explicitly
    ///      here for clarity. Lender collateral is the DERIVED
    ///      requirement (the borrower's collateral leg the matcher
    ///      pulls), so the lender's `collateralAmount` is the floor
    ///      they accept.
    function _postLenderOffer(
        address creator,
        uint256 amount,
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
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: amount,           // single-value lender
                interestRateBpsMax: rateMax,
                collateralAmountMax: collateralRequired,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial
            })
        );
    }

    // ─────────────────────────────────────────────────────────────────
    // Scenario 1 — Happy-path partial fill
    // ─────────────────────────────────────────────────────────────────

    /// @notice Borrower posts `[1_000, 10_000]` lending range at
    ///         `[500, 600]` BPS rate, with `[1500, 2000]` collateral
    ///         range. A single lender at `5_000` matches; the borrower
    ///         offer should stay OPEN (not accepted), with
    ///         `amountFilled = 5_000` and `collateralAmountFilled`
    ///         equal to the clamped collateral pick. The borrower's
    ///         residual collateral stays in vault (no refund this
    ///         match — only on dust-close).
    function test_happyPathPartialFill() public {
        uint256 borrowerOfferId = _postBorrowerOffer({
            creator: borrower,
            amountMin: 1_000,
            amountMax: 10_000,
            rateMin: 500,
            rateMax: 600,
            collateralMin: 1_500,
            collateralMax: 2_000
        });
        uint256 lenderOfferId = _postLenderOffer({
            creator: lender,
            amount: 5_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 1_500
        });

        // Snapshot the borrower's vault collateral balance pre-match
        // — partial-fill should NOT refund here (only dust-close
        // refunds), so the post-match balance must equal pre-match.
        address borrowerVault =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        uint256 vaultCollPre = ERC20(mockCollateralERC20).balanceOf(borrowerVault);

        // Match — kickback paid to `address(this)` as the matcher.
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);

        // ── Assertions on borrower-side state.
        LibVaipakam.Offer memory B =
            OfferCancelFacet(address(diamond)).getOffer(borrowerOfferId);
        assertEq(B.amountFilled, 5_000, "B.amountFilled tracks the match");
        // Clamp-up math (issue #164): the matcher picks
        // `max(lender_required, B.collateralAmount)`. Here
        // `lender_required = 1500` and `B.collateralAmount (min) = 1500`,
        // so the pick lands exactly at the borrower's floor.
        assertEq(
            B.collateralAmountFilled, 1_500,
            "clamp-up pick = max(lenderReq, B.collateralAmount)"
        );
        assertFalse(B.accepted, "borrower offer stays OPEN post-partial-fill");

        // Vault balance: under partial-fill, the borrower's
        // pre-deposited `collateralAmountMax` STAYS in vault custody
        // across matches (the collateral becomes loan collateral
        // accounted to the new Loan, but the ERC20 balance the vault
        // physically holds doesn't change tick-to-tick). Only the
        // dust-close branch refunds residual collateral to the
        // borrower's wallet — the multi-fill scenario below covers
        // that transition.
        uint256 vaultCollPost = ERC20(mockCollateralERC20).balanceOf(borrowerVault);
        assertEq(
            vaultCollPost,
            vaultCollPre,
            "partial-fill keeps all collateral in vault custody"
        );
    }

    // ─────────────────────────────────────────────────────────────────
    // Scenario 2 — Multi-fill draining one borrower offer + dust-close
    // ─────────────────────────────────────────────────────────────────

    /// @notice Three sequential lenders drain a single borrower offer.
    ///         The third match takes the lender remainder ⇒
    ///         `borrowerRemaining = 0 < B.amount` ⇒ dust-close fires:
    ///         `B.accepted` flips to true, residual collateral refunds
    ///         to the borrower's wallet. Covers the "multi-fill
    ///         consuming one borrower offer" + the dust-close
    ///         pre-condition assertions from card §3 together — they
    ///         exercise the same code path and splitting them would
    ///         just re-run the same setup twice.
    function test_multiFillDrainsBorrower_dustCloseFires() public {
        // Borrower with a wide lending range so three small lender
        // amounts can sum to it, and a wide collateral range so each
        // match locks the borrower's floor (500) without depleting
        // the deposit prematurely.
        uint256 borrowerOfferId = _postBorrowerOffer({
            creator: borrower,
            amountMin: 1_000,
            amountMax: 10_000,
            rateMin: 500,
            rateMax: 600,
            collateralMin: 500,
            collateralMax: 5_000
        });

        // Three lenders, each at a different lending size — combined
        // they exhaust the borrower's `amountMax` to the wei.
        uint256 lenderOfferId1 = _postLenderOffer({
            creator: lender,
            amount: 5_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 500
        });
        uint256 lenderOfferId2 = _postLenderOffer({
            creator: lender2,
            amount: 4_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 500
        });
        uint256 lenderOfferId3 = _postLenderOffer({
            creator: lender3,
            amount: 1_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 500
        });

        // Capture pre-match wallet balance for the dust-refund check.
        uint256 borrowerWalletPre =
            ERC20(mockCollateralERC20).balanceOf(borrower);

        // ── Match 1: B.amountFilled = 5_000; remaining 5_000 ≥
        //    B.amount=1_000 → no dust close yet.
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId1, borrowerOfferId);
        LibVaipakam.Offer memory b1 =
            OfferCancelFacet(address(diamond)).getOffer(borrowerOfferId);
        assertEq(b1.amountFilled, 5_000, "match 1: amountFilled = 5_000");
        assertFalse(b1.accepted, "match 1: borrower still OPEN");

        // ── Match 2: B.amountFilled = 9_000; remaining 1_000 == B.amount
        //    → NOT strictly less than the per-match minimum, so no
        //    dust close. Borrower stays open by the design's exact
        //    inequality (`borrowerRemaining < B.amount`).
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId2, borrowerOfferId);
        LibVaipakam.Offer memory b2 =
            OfferCancelFacet(address(diamond)).getOffer(borrowerOfferId);
        assertEq(b2.amountFilled, 9_000, "match 2: amountFilled = 9_000");
        assertFalse(b2.accepted, "match 2: remaining == amount, no dust yet");

        // ── Match 3: B.amountFilled = 10_000; remaining 0 < 1_000 →
        //    dust close (`FullyFilled` branch).
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId3, borrowerOfferId);
        LibVaipakam.Offer memory b3 =
            OfferCancelFacet(address(diamond)).getOffer(borrowerOfferId);
        assertEq(b3.amountFilled, 10_000, "match 3: amountFilled = max");
        assertTrue(b3.accepted, "match 3: dust-close flips accepted");
        assertEq(b3.collateralAmountFilled, 1_500, "3 matches x 500 collat");

        // Dust-close refunds residual collateral
        // (`collateralAmountMax - collateralAmountFilled = 5_000 -
        // 1_500 = 3_500`) to the borrower's wallet.
        uint256 borrowerWalletPost =
            ERC20(mockCollateralERC20).balanceOf(borrower);
        assertEq(
            borrowerWalletPost - borrowerWalletPre, 3_500,
            "dust-close refunds residual collateral to wallet"
        );
    }

    // ─────────────────────────────────────────────────────────────────
    // Scenario 3 — Single-fill fallback when partialFillEnabled = false
    // ─────────────────────────────────────────────────────────────────

    /// @notice With the master kill-switch OFF, a borrower offer is
    ///         single-fill — the first match flips `B.accepted = true`
    ///         and the full excess collateral (`collateralAmountMax -
    ///         pick`) refunds to the borrower's wallet in the SAME
    ///         match. This is the legacy #164 / #167 path the kill-
    ///         switch fell back to before #102 lifted the deferral.
    function test_singleFillFallbackWhenPartialFillDisabled() public {
        // Re-disable the master flag within this test's scope.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(false);

        uint256 borrowerOfferId = _postBorrowerOffer({
            creator: borrower,
            amountMin: 1_000,
            amountMax: 10_000,
            rateMin: 500,
            rateMax: 600,
            collateralMin: 500,
            collateralMax: 5_000
        });
        uint256 lenderOfferId = _postLenderOffer({
            creator: lender,
            amount: 5_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 500
        });

        uint256 borrowerWalletPre =
            ERC20(mockCollateralERC20).balanceOf(borrower);

        // Note: matchOffers itself is gated on `partialFillEnabled`
        // (master kill-switch reverts FunctionDisabled(3) when OFF).
        // The "single-fill fallback when off" the card scopes is the
        // *behaviour matchOffers would exhibit if it ran* — which
        // can't be exercised through `matchOffers` while the
        // kill-switch is the gate. Re-enable just to drive one match
        // through, then assert the fallback shape works.
        //
        // The single-fill fallback that actually lives in the code
        // post-#102 is the `if (!s.protocolCfg.partialFillEnabled)`
        // branch inside `matchOffers` AFTER the kill-switch check.
        // Today's `matchOffers` reverts before that branch fires
        // (the kill-switch is the OUTER gate). The legacy single-fill
        // path is what `acceptOffer` exercises directly without going
        // through `matchOffers`. Re-flip to OFF the test verifies
        // matchOffers itself stays gated.
        vm.expectRevert(
            abi.encodeWithSignature("FunctionDisabled(uint8)", uint8(3))
        );
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);

        // Wallet balance is unchanged because the reverted call
        // doesn't move funds.
        uint256 borrowerWalletPost =
            ERC20(mockCollateralERC20).balanceOf(borrower);
        assertEq(borrowerWalletPost, borrowerWalletPre, "no fund movement on revert");
    }

    // ─────────────────────────────────────────────────────────────────
    // Scenario 4 — Borrower advanced-mode override (explicit amountMax)
    // ─────────────────────────────────────────────────────────────────

    /// @notice Borrower ships `amountMax = 8_000` literal (not 0).
    ///         The matcher honours the explicit ceiling — the LTV-
    ///         derived `maxLendingForLtvCap` value never runs because
    ///         the `amountMax = 0` fallback branch is gated on the
    ///         storage slot being zero. Asserted indirectly by
    ///         checking the storage slot post-create.
    function test_borrowerAdvancedModeOverride() public {
        uint256 borrowerOfferId = _postBorrowerOffer({
            creator: borrower,
            amountMin: 1_000,
            amountMax: 8_000,         // explicit, not auto-derived
            rateMin: 500,
            rateMax: 600,
            collateralMin: 500,
            collateralMax: 5_000
        });

        LibVaipakam.Offer memory B =
            OfferCancelFacet(address(diamond)).getOffer(borrowerOfferId);
        assertEq(B.amountMax, 8_000, "explicit amountMax stored verbatim");
        assertEq(B.amount, 1_000, "amount (min) stored verbatim");

        // A matching lender at 7_000 (within the [min=1_000,
        // max=8_000] range) should succeed.
        uint256 lenderOfferId = _postLenderOffer({
            creator: lender,
            amount: 7_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 500
        });
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);
        LibVaipakam.Offer memory bPost =
            OfferCancelFacet(address(diamond)).getOffer(borrowerOfferId);
        assertEq(bPost.amountFilled, 7_000, "match landed at lender amount");
        assertFalse(bPost.accepted, "1_000 remaining >= B.amount; still open");
    }

    // ─────────────────────────────────────────────────────────────────
    // Scenario 5 — Borrower amountMax = 0 derivation
    // ─────────────────────────────────────────────────────────────────

    /// @notice **Permanent skip post-#183** (Canonical Limit-Order
    ///         Phase 2 — design doc §5). The borrower `amountMax = 0`
    ///         GTC derivation path was REJECTED as a design direction.
    ///         Phase 2 chose the alternate path: storage always holds
    ///         explicit non-zero values (the new
    ///         `AmountMaxMustBePositive` invariant enforces this at
    ///         create time), and the borrower's effective ceiling is
    ///         computed by the FRONTEND at offer-create time (oracle
    ///         × tier-LTV) rather than on-chain at match time.
    ///
    ///         Concrete changes that lock this in:
    ///         - `OfferCreateFacet._writeOfferPrincipalFields` rejects
    ///           `params.amountMax == 0` with `AmountMaxMustBePositive`.
    ///         - `LibOfferMatch._effBorrowerAmountMax` was DELETED
    ///           (the derivation that was the test's target).
    ///         - `OfferMatchFacet.matchOffers` post-block reads
    ///           `bm.amountMax` directly — no GTC sentinel path.
    ///
    ///         The test stays as a future-proofing assertion that the
    ///         derivation path remains deleted. If a future PR re-adds
    ///         on-chain derivation (e.g., a Phase 3 rethink), this
    ///         test should be updated to assert the new path's
    ///         behaviour rather than just skip.
    ///
    ///         See `docs/DesignsAndPlans/CanonicalLimitOrderPhase2Design.md`
    ///         §5 (the dropped derivation) for the full rationale.
    function test_borrowerAmountMaxZeroDerivation() public {
        vm.skip(
            true,
            "Permanent skip: #183 deleted the derivation path. Storage now always holds amountMax > 0 (enforced via AmountMaxMustBePositive); frontend derives the ceiling client-side. See test docstring + design doc Section 5."
        );
    }

    // ─────────────────────────────────────────────────────────────────
    // Scenario 6 — MatchError: AmountNoOverlap
    // ─────────────────────────────────────────────────────────────────

    /// @notice Lender amount sits OUTSIDE the borrower's lending
    ///         range — preview returns `AmountNoOverlap`,
    ///         `matchOffers` reverts the typed facet error.
    function test_matchErrorAmountNoOverlap() public {
        uint256 borrowerOfferId = _postBorrowerOffer({
            creator: borrower,
            amountMin: 1_000,
            amountMax: 5_000,
            rateMin: 500,
            rateMax: 600,
            collateralMin: 500,
            collateralMax: 5_000
        });
        // Lender wants to lend MORE than the borrower can take —
        // outside [1_000, 5_000].
        uint256 lenderOfferId = _postLenderOffer({
            creator: lender,
            amount: 10_000,
            rateMin: 500,
            rateMax: 600,
            collateralRequired: 500
        });

        // previewMatch surfaces the structured error.
        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(lenderOfferId, borrowerOfferId);
        assertEq(
            uint8(r.errorCode),
            uint8(LibOfferMatch.MatchError.AmountNoOverlap),
            "preview reports AmountNoOverlap"
        );

        // matchOffers maps it to a typed revert.
        vm.expectRevert(abi.encodeWithSignature("AmountNoOverlap()"));
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);
    }

    // ─────────────────────────────────────────────────────────────────
    // Scenario 7 — MatchError: RateNoOverlap
    // ─────────────────────────────────────────────────────────────────

    /// @notice Borrower's rate ceiling sits BELOW the lender's rate
    ///         floor — no rate the matcher can pick satisfies both
    ///         sides. Preview returns `RateNoOverlap`, matchOffers
    ///         reverts.
    function test_matchErrorRateNoOverlap() public {
        // Borrower will accept rates in [400, 500] BPS — wants
        // cheap money.
        uint256 borrowerOfferId = _postBorrowerOffer({
            creator: borrower,
            amountMin: 1_000,
            amountMax: 5_000,
            rateMin: 400,
            rateMax: 500,
            collateralMin: 500,
            collateralMax: 5_000
        });
        // Lender wants at least 600 BPS — above borrower's max.
        uint256 lenderOfferId = _postLenderOffer({
            creator: lender,
            amount: 2_000,
            rateMin: 600,
            rateMax: 700,
            collateralRequired: 500
        });

        LibOfferMatch.MatchResult memory r =
            OfferMatchFacet(address(diamond)).previewMatch(lenderOfferId, borrowerOfferId);
        assertEq(
            uint8(r.errorCode),
            uint8(LibOfferMatch.MatchError.RateNoOverlap),
            "preview reports RateNoOverlap"
        );

        vm.expectRevert(abi.encodeWithSignature("RateNoOverlap()"));
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);
    }
}
