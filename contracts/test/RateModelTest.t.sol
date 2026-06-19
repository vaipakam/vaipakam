// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IRateModel} from "../src/interfaces/IRateModel.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {RateModelMock} from "./mocks/RateModelMock.sol";
import {RiskPremiumRateModel} from "../src/models/RiskPremiumRateModel.sol";

/// @title RateModelTest
/// @notice #400 — pluggable quote-time rate model. Asserts the resolver view +
///         registry, and the load-bearing thesis guarantee: a HUMAN-created
///         offer keeps the creator's typed rate even with a model registered
///         (Vaipakam's market rate is set by the human order book, never by a
///         protocol curve — the model is guidance / automated-pricing only).
contract RateModelTest is SetupTest {
    RateModelMock internal model; // quotes referenceRateBps + 300

    function setUp() public {
        setupHelper();
        model = new RateModelMock(300);
    }

    function _input(uint256 refBps) internal view returns (IRateModel.RateModelInput memory) {
        return IRateModel.RateModelInput({
            creator: lender,
            offerType: uint8(LibVaipakam.OfferType.Lender),
            lendingAsset: mockERC20,
            collateralAsset: mockCollateralERC20,
            amount: 1_000 ether,
            collateralAmount: 1_800 ether,
            durationDays: 30,
            referenceRateBps: refBps
        });
    }

    // ── Resolver view ──────────────────────────────────────────────────────

    /// @notice Identity default (no model) → the resolver returns the reference verbatim.
    function test_quote_identityDefault_returnsReference() public view {
        uint256 q = OfferCreateFacet(address(diamond)).quoteOfferRateBps(_input(500));
        assertEq(q, 500, "identity model returns the reference rate unchanged");
    }

    /// @notice With a model registered → the resolver returns the model quote.
    function test_quote_withModel_returnsModelOutput() public {
        vm.prank(owner);
        AdminFacet(address(diamond)).setRateModel(address(model));
        uint256 q = OfferCreateFacet(address(diamond)).quoteOfferRateBps(_input(500));
        assertEq(q, 800, "registered model adjusts the reference (+300)");
    }

    // ── Registry setter ──────────────────────────────────────────────────────

    function test_setRateModel_accessAndGuards() public {
        // non-admin rejected
        vm.prank(borrower);
        vm.expectRevert();
        AdminFacet(address(diamond)).setRateModel(address(model));

        // EOA (no bytecode) rejected
        vm.prank(owner);
        vm.expectRevert(AdminFacet.RateModelNotContract.selector);
        AdminFacet(address(diamond)).setRateModel(address(0xBEEF));

        // setRateModel(address(0)) is rejected — disable goes through the
        // dedicated fast path
        vm.prank(owner);
        vm.expectRevert(AdminFacet.UseDisableRateModel.selector);
        AdminFacet(address(diamond)).setRateModel(address(0));

        // valid set + getter reflects
        vm.prank(owner);
        AdminFacet(address(diamond)).setRateModel(address(model));
        assertEq(AdminFacet(address(diamond)).getRateModel(), address(model));
    }

    /// @notice Fast-disable (enable-slow / disable-fast asymmetry): WATCHER (or
    ///         ADMIN) flips the model off to identity; a stranger cannot.
    function test_disableRateModel_fastPath() public {
        vm.prank(owner);
        AdminFacet(address(diamond)).setRateModel(address(model));

        // stranger (neither watcher nor admin) rejected
        vm.prank(borrower);
        vm.expectRevert(AdminFacet.NotWatcherOrAdmin.selector);
        AdminFacet(address(diamond)).disableRateModel();

        // owner holds WATCHER_ROLE (granted at init) → fast disable works
        vm.prank(owner);
        AdminFacet(address(diamond)).disableRateModel();
        assertEq(AdminFacet(address(diamond)).getRateModel(), address(0), "reverted to identity");
    }

    /// @notice The resolver CLAMPS a model that quotes far off the reference to
    ///         ±maxDeviation — the anti-rate-setting guarantee. Model adds 5000
    ///         bps; default cap is 500, so ref 500 is clamped to 1000, not 5500.
    function test_quote_clampedToDeviationBand() public {
        RateModelMock wild = new RateModelMock(5_000);
        vm.prank(owner);
        AdminFacet(address(diamond)).setRateModel(address(wild));
        uint256 q = OfferCreateFacet(address(diamond)).quoteOfferRateBps(_input(500));
        assertEq(q, 1_000, "model clamped to reference + default 500-bps cap");
    }

    /// @notice The deviation cap is governance-tunable + range-checked, and the
    ///         resolver honours the new value.
    function test_setRateModelMaxDeviationBps_boundsAndEffect() public {
        // out of range rejected
        vm.prank(owner);
        vm.expectRevert(AdminFacet.InvalidRateModelDeviation.selector);
        AdminFacet(address(diamond)).setRateModelMaxDeviationBps(3_000); // > 2_500 max

        // valid tighten to 100 bps
        vm.prank(owner);
        AdminFacet(address(diamond)).setRateModelMaxDeviationBps(100);
        assertEq(AdminFacet(address(diamond)).getRateModelMaxDeviationBps(), 100);

        // resolver now clamps a +5000 model to ref + 100
        RateModelMock wild = new RateModelMock(5_000);
        vm.prank(owner);
        AdminFacet(address(diamond)).setRateModel(address(wild));
        uint256 q = OfferCreateFacet(address(diamond)).quoteOfferRateBps(_input(500));
        assertEq(q, 600, "clamped to reference + tightened 100-bps cap");
    }

    // ── Thesis guarantee ─────────────────────────────────────────────────────

    /// @notice A human's manually-created offer keeps the creator's TYPED rate
    ///         even when a model is registered — the create path never calls
    ///         the model, so market-driven price discovery is preserved.
    function test_humanOffer_keepsTypedRate_evenWithModelRegistered() public {
        vm.prank(owner);
        AdminFacet(address(diamond)).setRateModel(address(model)); // +300 premium

        // Helper splits 50/50 wallet/vault; the create-time escrow pulls the
        // full `amountMax` (1_000) from the WALLET, so provision 2_000 ⇒ 1_000
        // wallet + standing diamond approval.
        address ln = _provisionFundedActorWithVault("rmLender", mockERC20, 2_000 ether);
        vm.prank(ln);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1_000 ether,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 1_800 ether,
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
                amountMax: 1_000 ether,
                interestRateBpsMax: 600,
                collateralAmountMax: 1_800 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );

        LibVaipakam.Offer memory o = OfferCancelFacet(address(diamond)).getOffer(offerId);
        assertEq(o.interestRateBps, 500, "human-typed rate is binding (NOT model-adjusted to 800)");
        assertEq(o.interestRateBpsMax, 600, "human-typed range max is binding (NOT 900)");
    }

    // ── #394 Lever B × #400 substrate ────────────────────────────────────────

    /// @notice The real {RiskPremiumRateModel} (#394 Lever B) registered through
    ///         the #400 resolver: its dual-factor premium is APPLIED, but the
    ///         resolver's deviation clamp BOUNDS it to `ref ± δ`. With a tier-0
    ///         (illiquid) collateral the model quotes ref + 800 (+ tenor), yet
    ///         the default 500-bps cap clamps the resolver output to ref + 500 —
    ///         proving Lever B inherits the substrate's anti-off-market guard
    ///         rather than re-implementing it.
    function test_riskPremiumModel_clampedByResolverDeviationBand() public {
        uint16[4] memory tp = [uint16(800), uint16(500), uint16(300), uint16(100)];
        RiskPremiumRateModel premium = new RiskPremiumRateModel(
            owner,
            address(diamond),
            tp,
            1_000, // 10%/yr tenor
            2_000  // 20% tenor cap
        );
        vm.prank(owner);
        AdminFacet(address(diamond)).setRateModel(address(premium));

        // Tier-0 (illiquid) collateral → highest (800-bps) premium.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(0))
        );

        uint256 q = OfferCreateFacet(address(diamond)).quoteOfferRateBps(_input(500));
        assertEq(q, 1_000, "ref 500 + premium clamped to the default 500-bps deviation band");
    }
}
