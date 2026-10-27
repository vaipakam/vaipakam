// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IRateModel} from "../src/interfaces/IRateModel.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {RateModelFacet} from "../src/facets/RateModelFacet.sol";
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
        uint256 q = RateModelFacet(address(diamond)).quoteOfferRateBps(_input(500));
        assertEq(q, 500, "identity model returns the reference rate unchanged");
    }

    /// @notice With a model registered → the resolver returns the model quote.
    function test_quote_withModel_returnsModelOutput() public {
        vm.prank(owner);
        RateModelFacet(address(diamond)).setRateModel(address(model));
        // A 10% reference leaves a 5-point band, so the +300 premium passes whole.
        uint256 q = RateModelFacet(address(diamond)).quoteOfferRateBps(_input(1_000));
        assertEq(q, 1_300, "registered model adjusts the reference (+300)");
    }

    // ── Registry setter ──────────────────────────────────────────────────────

    function test_setRateModel_accessAndGuards() public {
        // non-admin rejected
        vm.prank(borrower);
        vm.expectRevert();
        RateModelFacet(address(diamond)).setRateModel(address(model));

        // EOA (no bytecode) rejected
        vm.prank(owner);
        vm.expectRevert(RateModelFacet.RateModelNotContract.selector);
        RateModelFacet(address(diamond)).setRateModel(address(0xBEEF));

        // setRateModel(address(0)) is rejected — disable goes through the
        // dedicated fast path
        vm.prank(owner);
        vm.expectRevert(RateModelFacet.UseDisableRateModel.selector);
        RateModelFacet(address(diamond)).setRateModel(address(0));

        // valid set + getter reflects
        vm.prank(owner);
        RateModelFacet(address(diamond)).setRateModel(address(model));
        assertEq(RateModelFacet(address(diamond)).getRateModel(), address(model));
    }

    /// @notice Fast-disable (enable-slow / disable-fast asymmetry): WATCHER (or
    ///         ADMIN) flips the model off to identity; a stranger cannot.
    function test_disableRateModel_fastPath() public {
        vm.prank(owner);
        RateModelFacet(address(diamond)).setRateModel(address(model));

        // stranger (neither watcher nor admin) rejected
        vm.prank(borrower);
        vm.expectRevert(RateModelFacet.NotWatcherOrAdmin.selector);
        RateModelFacet(address(diamond)).disableRateModel();

        // owner holds WATCHER_ROLE (granted at init) → fast disable works
        vm.prank(owner);
        RateModelFacet(address(diamond)).disableRateModel();
        assertEq(RateModelFacet(address(diamond)).getRateModel(), address(0), "reverted to identity");
    }

    /// @notice #400 / #2748 — a registered model is CLAMPED to the band
    ///         around the reference. With the defaults (cap 5 points, share
    ///         50%, floor 1 point) a 5% reference has a half-width of
    ///         min(500, 250) = 250 bps, so a +5000-bps model lands on 7.5%.
    function test_quote_clampedToDeviationBand() public {
        _registerModel(address(new RateModelMock(5_000)));
        uint256 q = RateModelFacet(address(diamond)).quoteOfferRateBps(_input(500));
        assertEq(q, 750, "share binds: 5% + 50% of 5%");
    }

    /// @notice #2748 — the points cap binds on a high reference: 12% x 50% is
    ///         6 points, above the 5-point cap.
    function test_band_capBindsOnHighReference() public {
        _registerModel(address(new RateModelMock(5_000)));
        assertEq(RateModelFacet(address(diamond)).quoteOfferRateBps(_input(1_200)), 1_700, "cap binds: 12% + 5 points");
        _registerModel(address(new ZeroRateModel()));
        assertEq(RateModelFacet(address(diamond)).quoteOfferRateBps(_input(1_200)), 700, "cap binds below: 12% - 5 points");
    }

    /// @notice #2748 — the points floor binds on a low reference: 1% x 50% is
    ///         half a point, below the 1-point floor.
    function test_band_floorBindsOnLowReference() public {
        _registerModel(address(new RateModelMock(5_000)));
        assertEq(RateModelFacet(address(diamond)).quoteOfferRateBps(_input(100)), 200, "floor binds: 1% + 1 point");
        _registerModel(address(new ZeroRateModel()));
        assertEq(RateModelFacet(address(diamond)).quoteOfferRateBps(_input(100)), 0, "floored at 0%");
    }

    /// @notice #2748 — a zero reference (no market yet) still leaves the floor,
    ///         so a model's quote is not pinned to 0%.
    function test_band_zeroReferenceKeepsTheFloor() public {
        _registerModel(address(new RateModelMock(5_000)));
        assertEq(RateModelFacet(address(diamond)).quoteOfferRateBps(_input(0)), 100, "0% market: up to the 1-point floor");
    }

    /// @notice #2748 — each knob is range-checked; a floor equal to the cap
    ///         is allowed.
    function test_setRateModelBand_boundsAndEffect() public {
        vm.startPrank(owner);
        vm.expectRevert(RateModelFacet.InvalidRateModelDeviation.selector);
        RateModelFacet(address(diamond)).setRateModelBand(3_000, 0, 0); // cap > 25 points
        vm.expectRevert(RateModelFacet.InvalidRateModelDeviation.selector);
        RateModelFacet(address(diamond)).setRateModelBand(0, 400, 0); // share < 5%
        vm.expectRevert(RateModelFacet.InvalidRateModelDeviation.selector);
        RateModelFacet(address(diamond)).setRateModelBand(0, 10_001, 0); // share > 100%
        vm.expectRevert(RateModelFacet.InvalidRateModelDeviation.selector);
        RateModelFacet(address(diamond)).setRateModelBand(0, 0, 600); // floor > 5 points
        // A floor equal to the cap is allowed: the band is then a fixed 1 point.
        RateModelFacet(address(diamond)).setRateModelBand(100, 0, 0);
        assertEq(RateModelFacet(address(diamond)).getRateModelMaxDeviationBps(), 100);
        vm.stopPrank();
    }

    function test_setRateModelBand_floorAboveCapRefused() public {
        vm.prank(owner);
        vm.expectRevert(RateModelFacet.InvalidRateModelDeviation.selector);
        RateModelFacet(address(diamond)).setRateModelBand(50, 0, 0); // 0.5-point cap under the default 1-point floor
    }

    function test_setRateModelBand_setsAndClamps() public {
        vm.prank(owner);
        vm.expectEmit(address(diamond));
        emit RateModelFacet.RateModelBandSet(200, 10_000, 50);
        RateModelFacet(address(diamond)).setRateModelBand(200, 10_000, 50);
        assertEq(RateModelFacet(address(diamond)).getRateModelMaxDeviationBps(), 200);
        assertEq(RateModelFacet(address(diamond)).getRateModelRelativeDeviationBps(), 10_000);
        assertEq(RateModelFacet(address(diamond)).getRateModelMinDeviationBps(), 50);

        _registerModel(address(new RateModelMock(5_000)));
        // 5% x 100% = 5 points, capped at 2.
        assertEq(RateModelFacet(address(diamond)).quoteOfferRateBps(_input(500)), 700, "tightened cap binds");
        // 0.2% x 100% = 0.2 points, under the 0.5-point floor, so the floor binds.
        assertEq(RateModelFacet(address(diamond)).quoteOfferRateBps(_input(20)), 70, "floor binds");

        vm.prank(owner);
        RateModelFacet(address(diamond)).setRateModelBand(0, 0, 0);
        assertEq(RateModelFacet(address(diamond)).getRateModelMaxDeviationBps(), 500, "default cap");
        assertEq(RateModelFacet(address(diamond)).getRateModelRelativeDeviationBps(), 5_000, "default share");
        assertEq(RateModelFacet(address(diamond)).getRateModelMinDeviationBps(), 100, "default floor");
    }

    /// @dev A cap kept from the old single-knob setter (0.5 points) with the
    ///      appended floor field still unset, as an in-place refresh leaves
    ///      it. The floor's 1-point default must not widen the band past the
    ///      cap: the effective floor is bounded by the cap.
    function test_legacyCapBelowDefaultFloor_floorBoundedByCap() public {
        // Write the stored cap directly (slot 276, offset 20, uint16), the way
        // a pre-#2748 Diamond holds it; the new setter would refuse this pair.
        bytes32 slot = bytes32(uint256(LibVaipakam.VANGKI_STORAGE_POSITION) + 276);
        uint256 word = uint256(vm.load(address(diamond), slot));
        word = (word & ~(uint256(0xffff) << 160)) | (uint256(50) << 160);
        vm.store(address(diamond), slot, bytes32(word));
        assertEq(RateModelFacet(address(diamond)).getRateModelMaxDeviationBps(), 50, "legacy cap read");
        assertEq(RateModelFacet(address(diamond)).getRateModelMinDeviationBps(), 50, "floor bounded by the cap");

        _registerModel(address(new RateModelMock(5_000)));
        assertEq(RateModelFacet(address(diamond)).quoteOfferRateBps(_input(400)), 450, "band stays within the cap");
    }

    function _registerModel(address model) internal {
        vm.prank(owner);
        RateModelFacet(address(diamond)).setRateModel(model);
    }

    // ── Thesis guarantee ─────────────────────────────────────────────────────

    /// @notice A human's manually-created offer keeps the creator's TYPED rate
    ///         even when a model is registered — the create path never calls
    ///         the model, so market-driven price discovery is preserved.
    function test_humanOffer_keepsTypedRate_evenWithModelRegistered() public {
        vm.prank(owner);
        RateModelFacet(address(diamond)).setRateModel(address(model)); // +300 premium

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
    ///         at a 10% reference the default 5-point cap clamps the resolver
    ///         output to ref + 500 —
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
        RateModelFacet(address(diamond)).setRateModel(address(premium));

        // Tier-0 (illiquid) collateral → highest (800-bps) premium.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(0))
        );

        uint256 q = RateModelFacet(address(diamond)).quoteOfferRateBps(_input(1_000));
        assertEq(q, 1_500, "ref 1000 + premium clamped to the default 5-point cap");
    }
}

/// @dev A model that always quotes 0%, to exercise the band's lower edge.
contract ZeroRateModel is IRateModel {
    function quoteRateBps(IRateModel.RateModelInput calldata) external pure returns (uint256) {
        return 0;
    }
}
