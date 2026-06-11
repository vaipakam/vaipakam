// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ISanctionsList} from "../src/interfaces/ISanctionsList.sol";

/**
 * @title PreviewAcceptTest
 * @notice Coverage for `OfferAcceptFacet.previewAccept(offerId, acceptor)` —
 *         the contract-side dry-run that backs the frontend's
 *         AcceptOffer modal / OfferDetails view (Issue #196).
 *
 * @dev    Two test layers:
 *
 *           1. Happy-path PIN — mirror the four ERC-20 scenarios from
 *              `AcceptRangedOfferTest.t.sol` (the load-bearing reference
 *              for the role-aware mapping):
 *                · lender ranged offer accepted by borrower
 *                · borrower ranged offer accepted by lender
 *                · borrower ranged-collateral offer → residual refund
 *                · single-value (non-ranged) offer
 *              For each scenario, the test computes the preview FIRST,
 *              then runs the real `acceptOffer`, and asserts the
 *              resulting `Loan` shape matches the projection field-for-
 *              field. If `previewAccept` drifts from `_acceptOffer`'s
 *              role-aware mapping, these pins fail.
 *
 *           2. ERROR-CODE walks — one test per `AcceptError` variant
 *              that the preview can surface, plus the `InvalidOffer`
 *              revert. Happy-path projection fields are asserted to
 *              stay populated on recoverable failures (e.g.
 *              `KYCRequired`) so the frontend can render
 *              "tier-up to unlock X principal at Y bps" alongside
 *              the error.
 *
 *         Tests inherit `SetupTest` (28-facet diamond, post-#168
 *         Track A) so every facet the preview probes
 *         (`ProfileFacet`, `OracleFacet`, `VPFIDiscountFacet`-shaped
 *         storage) is reachable. Range flags are flipped on in
 *         `setUp()` so `amountMax != amount` etc. is admissible at
 *         `createOffer` time — same pattern as `AcceptRangedOfferTest`.
 */
contract PreviewAcceptTest is SetupTest {
    function setUp() public {
        setupHelper();

        // Range / range-rate / range-collateral on; partial-fill OFF.
        // The preview is a direct-accept dry-run; the partial-fill
        // gate is on `matchOffers` and doesn't touch this surface.
        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setRangeAmountEnabled(true);
        ConfigFacet(address(diamond)).setRangeRateEnabled(true);
        ConfigFacet(address(diamond)).setRangeCollateralEnabled(true);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────
    // Offer-creation helpers — same shape as AcceptRangedOfferTest so
    // the pinning intent is structurally obvious.
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
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: amountMax,
                interestRateBpsMax: rateMax,
                collateralAmountMax: collateralRequired,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0
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
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: amountMax,
                interestRateBpsMax: rateMax,
                collateralAmountMax: collateralAmountMax,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0
            })
        );
    }

    // ═════════════════════════════════════════════════════════════════
    // Happy-path PINS — preview matches the loan shape post-accept
    // ═════════════════════════════════════════════════════════════════

    /// @notice Lender posts `[amount=1k, amountMax=10k, rate=300, rateMax=800,
    ///         collateral=500]`. Borrower previews → projection takes the
    ///         lender's headline max (10k) and floor rate (300) — the
    ///         direct-accept role-aware reads documented in
    ///         `LoanFacet._copyOfferToLoan`. After accept, the real loan
    ///         matches the projection field-for-field.
    function test_previewAccept_lenderRangedOffer_borrowerAccepts_principalAndRateRoleAware() public {
        uint256 offerId = _postLenderOffer({
            creator: lender,
            amount: 1_000,
            amountMax: 10_000,
            rateMin: 300,
            rateMax: 800,
            collateralRequired: 500
        });

        OfferAcceptFacet.AcceptPreview memory p =
            OfferAcceptFacet(address(diamond)).previewAccept(offerId, borrower);

        assertEq(
            uint8(p.errorCode),
            uint8(OfferAcceptFacet.AcceptError.None),
            "happy path: errorCode == None"
        );
        assertEq(p.effectivePrincipal, 10_000, "principal = lender.amountMax (10k)");
        assertEq(p.interestRateBps, 300, "rate = lender.interestRateBps (floor)");
        assertEq(p.collateralAmount, 500, "collateral = offer.collateralAmount");
        assertEq(p.collateralResidualRefund, 0, "lender offer has no residual");
        // LIF on 10k @ 10 bps = 10
        assertEq(p.lifEstimate, 10, "LIF = 0.1% of 10k principal");

        // Pin: real accept lands the loan with the same shape the
        // preview projected. If `previewAccept` drifts from
        // `_acceptOffer` / `_copyOfferToLoan`, this assertion block
        // is what fails.
        vm.prank(borrower);
        uint256 loanId =
            OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.principal, p.effectivePrincipal, "loan.principal matches preview");
        assertEq(loan.interestRateBps, p.interestRateBps, "loan.rate matches preview");
        assertEq(loan.collateralAmount, p.collateralAmount, "loan.collateral matches preview");
    }

    /// @notice Borrower posts `[amount=1k, amountMax=10k, rate=300, rateMax=800,
    ///         collateral=500, collateralMax=500]`. Lender previews →
    ///         projection takes the borrower's floor (1k) and ceiling rate (800).
    function test_previewAccept_borrowerRangedOffer_lenderAccepts_principalAndRateRoleAware() public {
        uint256 offerId = _postBorrowerOffer({
            creator: borrower,
            amount: 1_000,
            amountMax: 10_000,
            rateMin: 300,
            rateMax: 800,
            collateralAmount: 500,
            collateralAmountMax: 500
        });

        OfferAcceptFacet.AcceptPreview memory p =
            OfferAcceptFacet(address(diamond)).previewAccept(offerId, lender);

        assertEq(uint8(p.errorCode), uint8(OfferAcceptFacet.AcceptError.None));
        assertEq(p.effectivePrincipal, 1_000, "principal = borrower.amount (floor)");
        assertEq(p.interestRateBps, 800, "rate = borrower.interestRateBpsMax (ceiling)");
        assertEq(p.collateralAmount, 500);
        assertEq(p.collateralResidualRefund, 0, "no residual when max == floor");
        // LIF on 1k @ 10 bps = 1
        assertEq(p.lifEstimate, 1, "LIF = 0.1% of 1k principal");

        vm.prank(lender);
        uint256 loanId =
            OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.principal, p.effectivePrincipal);
        assertEq(loan.interestRateBps, p.interestRateBps);
        assertEq(loan.collateralAmount, p.collateralAmount);
    }

    /// @notice Borrower posts with `collateralAmount=500, collateralAmountMax=1000`.
    ///         The preview surfaces the 500-unit residual the borrower would
    ///         get refunded at accept.
    function test_previewAccept_borrowerRangedCollateral_residualRefund() public {
        uint256 offerId = _postBorrowerOffer({
            creator: borrower,
            amount: 1_000,
            amountMax: 1_000,
            rateMin: 500,
            rateMax: 500,
            collateralAmount: 500,
            collateralAmountMax: 1_000
        });

        OfferAcceptFacet.AcceptPreview memory p =
            OfferAcceptFacet(address(diamond)).previewAccept(offerId, lender);

        assertEq(uint8(p.errorCode), uint8(OfferAcceptFacet.AcceptError.None));
        assertEq(p.collateralAmount, 500, "loan locks 500");
        assertEq(
            p.collateralResidualRefund,
            500,
            "residual = collateralMax (1000) - collateralAmount (500)"
        );
    }

    /// @notice Single-value lender offer (amount==amountMax, rate==rateMax) —
    ///         the role-aware mapping degenerates but should still produce
    ///         the right values.
    function test_previewAccept_singleValueLenderOffer_matchesAcceptShape() public {
        uint256 offerId = _postLenderOffer({
            creator: lender,
            amount: 5_000,
            amountMax: 5_000,
            rateMin: 500,
            rateMax: 500,
            collateralRequired: 1_000
        });

        OfferAcceptFacet.AcceptPreview memory p =
            OfferAcceptFacet(address(diamond)).previewAccept(offerId, borrower);
        assertEq(uint8(p.errorCode), uint8(OfferAcceptFacet.AcceptError.None));
        assertEq(p.effectivePrincipal, 5_000);
        assertEq(p.interestRateBps, 500);
        assertEq(p.collateralAmount, 1_000);
        // 0.1% of 5_000 = 5
        assertEq(p.lifEstimate, 5);

        vm.prank(borrower);
        uint256 loanId =
            OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.principal, p.effectivePrincipal);
        assertEq(loan.interestRateBps, p.interestRateBps);
        assertEq(loan.collateralAmount, p.collateralAmount);
    }

    // ═════════════════════════════════════════════════════════════════
    // Error-code walks — one per AcceptError variant + InvalidOffer revert
    // ═════════════════════════════════════════════════════════════════

    /// @notice A non-existent offer ID makes the preview revert
    ///         `InvalidOffer` — consistent with `acceptOffer`'s
    ///         top-of-function behaviour. Every other precondition
    ///         surfaces through `errorCode`, but a non-existent slot is
    ///         the one case where the projection isn't meaningful.
    function test_previewAccept_revertsOnInvalidOffer() public {
        // `InvalidOffer` is declared on OfferAcceptFacet itself (not in
        // IVaipakamErrors) — qualify the selector accordingly.
        vm.expectRevert(OfferAcceptFacet.InvalidOffer.selector);
        OfferAcceptFacet(address(diamond)).previewAccept(99_999, borrower);
    }

    /// @notice After a successful accept, a second preview of the same
    ///         offer surfaces `OfferAlreadyAccepted` and DOES NOT revert.
    function test_previewAccept_offerAlreadyAccepted() public {
        uint256 offerId = _postLenderOffer({
            creator: lender,
            amount: 1_000,
            amountMax: 1_000,
            rateMin: 500,
            rateMax: 500,
            collateralRequired: 200
        });
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, true);

        OfferAcceptFacet.AcceptPreview memory p =
            OfferAcceptFacet(address(diamond)).previewAccept(offerId, borrower);
        assertEq(
            uint8(p.errorCode),
            uint8(OfferAcceptFacet.AcceptError.OfferAlreadyAccepted),
            "second preview surfaces OfferAlreadyAccepted"
        );
        // Projection fields stay populated — frontend can still render
        // "this offer was filled at X principal Y bps" instead of bare
        // "offer expired".
        assertEq(p.effectivePrincipal, 1_000);
        assertEq(p.interestRateBps, 500);
    }

    /// @notice With KYC enforcement on and the borrower at Tier-0, a
    ///         preview of an offer above the Tier-0 threshold surfaces
    ///         `KYCRequired` — and STILL populates the happy-path
    ///         fields so the frontend can render "tier-up to unlock
    ///         this offer at 10k principal, 300 bps".
    function test_previewAccept_kycRequired_populatesHappyPathFields() public {
        // Drop borrower below the tier-0 threshold. SetupTest pins
        // both actors at Tier-2 by default; reset the borrower to T0.
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(
            borrower,
            LibVaipakam.KYCTier.Tier0
        );
        // Flip enforcement on so `meetsKYCRequirement` actually gates.
        AdminFacet(address(diamond)).setKYCEnforcement(true);

        uint256 offerId = _postLenderOffer({
            creator: lender,
            amount: 10_000 ether,
            amountMax: 10_000 ether,
            rateMin: 300,
            rateMax: 300,
            collateralRequired: 1_000 ether
        });

        OfferAcceptFacet.AcceptPreview memory p =
            OfferAcceptFacet(address(diamond)).previewAccept(offerId, borrower);

        assertEq(
            uint8(p.errorCode),
            uint8(OfferAcceptFacet.AcceptError.KYCRequired),
            "preview surfaces KYCRequired"
        );
        // The load-bearing claim — happy-path fields populated so the
        // frontend can render the offer terms alongside the tier-up CTA.
        assertEq(p.effectivePrincipal, 10_000 ether, "principal still projected");
        assertEq(p.interestRateBps, 300, "rate still projected");
        assertEq(p.collateralAmount, 1_000 ether);
    }

    /// @notice Pausing either leg surfaces `AssetPaused`. Happy-path
    ///         fields stay populated (pause is recoverable — operator
    ///         unpauses, the offer becomes acceptable again).
    function test_previewAccept_assetPaused_lendingLeg() public {
        uint256 offerId = _postLenderOffer({
            creator: lender,
            amount: 1_000,
            amountMax: 1_000,
            rateMin: 500,
            rateMax: 500,
            collateralRequired: 200
        });
        vm.prank(owner);
        AdminFacet(address(diamond)).pauseAsset(mockERC20);

        OfferAcceptFacet.AcceptPreview memory p =
            OfferAcceptFacet(address(diamond)).previewAccept(offerId, borrower);
        assertEq(
            uint8(p.errorCode),
            uint8(OfferAcceptFacet.AcceptError.AssetPaused)
        );
        // Happy-path fields populated — pause is recoverable.
        assertEq(p.effectivePrincipal, 1_000);
        assertEq(p.interestRateBps, 500);
    }

    /// @notice A sanctioned acceptor surfaces `SanctionedAcceptor`.
    function test_previewAccept_sanctionedAcceptor() public {
        uint256 offerId = _postLenderOffer({
            creator: lender,
            amount: 1_000,
            amountMax: 1_000,
            rateMin: 500,
            rateMax: 500,
            collateralRequired: 200
        });

        // Wire up a sanctions oracle that flags the borrower. SetupTest
        // leaves the oracle unset (address(0) → fail-open per CLAUDE.md);
        // we plant a mock at a known address and tell it to flag the
        // borrower only.
        address sanctionsOracle = makeAddr("sanctions-oracle");
        vm.mockCall(
            sanctionsOracle,
            abi.encodeWithSelector(ISanctionsList.isSanctioned.selector, borrower),
            abi.encode(true)
        );
        vm.mockCall(
            sanctionsOracle,
            abi.encodeWithSelector(ISanctionsList.isSanctioned.selector, lender),
            abi.encode(false)
        );
        vm.prank(owner);
        ProfileFacet(address(diamond)).setSanctionsOracle(sanctionsOracle);

        OfferAcceptFacet.AcceptPreview memory p =
            OfferAcceptFacet(address(diamond)).previewAccept(offerId, borrower);
        assertEq(
            uint8(p.errorCode),
            uint8(OfferAcceptFacet.AcceptError.SanctionedAcceptor)
        );
    }

    /// @notice A sanctioned offer creator surfaces `SanctionedCreator`.
    function test_previewAccept_sanctionedCreator() public {
        uint256 offerId = _postLenderOffer({
            creator: lender,
            amount: 1_000,
            amountMax: 1_000,
            rateMin: 500,
            rateMax: 500,
            collateralRequired: 200
        });

        address sanctionsOracle = makeAddr("sanctions-oracle");
        vm.mockCall(
            sanctionsOracle,
            abi.encodeWithSelector(ISanctionsList.isSanctioned.selector, lender),
            abi.encode(true)
        );
        vm.mockCall(
            sanctionsOracle,
            abi.encodeWithSelector(ISanctionsList.isSanctioned.selector, borrower),
            abi.encode(false)
        );
        vm.prank(owner);
        ProfileFacet(address(diamond)).setSanctionsOracle(sanctionsOracle);

        OfferAcceptFacet.AcceptPreview memory p =
            OfferAcceptFacet(address(diamond)).previewAccept(offerId, borrower);
        // Acceptor is screened FIRST (mirrors `_acceptOffer`'s order):
        // when the acceptor is clean, the creator-side flag is what
        // surfaces.
        assertEq(
            uint8(p.errorCode),
            uint8(OfferAcceptFacet.AcceptError.SanctionedCreator)
        );
    }
}
