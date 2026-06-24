// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibRiskAccess} from "../src/libraries/LibRiskAccess.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";

/**
 * @title RiskAccessMatchGateTest
 * @notice #671 phase-2 / PR-2b — the KEEPER-MATCH dual-creator re-assertion in
 *         `OfferMatchFacet._executeMatch` (`_assertMatchCreatorsRiskAccess`).
 *
 *         The acceptor-side gate in `LoanFacet._maybeRunInitialRiskGates` is
 *         scoped to the DIRECT-ACCEPT path (`s.acceptAckActive == true`) and is
 *         SKIPPED on the keeper-match path (a match authors no accept-ack — both
 *         sides are self-authored offers, design §5). So on a match NEITHER
 *         creator is re-validated downstream. PR-2b re-asserts each paired
 *         offer's OWN creator at the matcher, against the LIVE tier/consent
 *         state, before any state mutation — mirroring the create-time
 *         chokepoint but catching a creator who down-tiered, revoked their
 *         illiquid-pair consent, went stale after a terms bump, OR was never
 *         gated at create because the kill-switch was off then.
 *
 *         Isolating the matcher gate from the create-time gate: every test
 *         CREATES BOTH OFFERS FIRST (gate OFF, the default) and only THEN flips
 *         the gate ON before `matchOffers`. So the create call never ran the
 *         gate and the only check under test is the matcher re-assertion. Tier
 *         forcing uses the `_mockTier` idiom (mirrors RiskAccessAcceptGateTest);
 *         the BroadLiquid pair keeps both legs liquid so the match HF/LTV gate
 *         passes and the only revert in play is the risk-access one.
 */
contract RiskAccessMatchGateTest is SetupTest {
    uint8 constant BLUECHIP = uint8(LibVaipakam.RiskAccessLevel.BlueChipOnly);
    uint8 constant BROAD = uint8(LibVaipakam.RiskAccessLevel.BroadLiquid);
    uint8 constant ILLIQUID = uint8(LibVaipakam.RiskAccessLevel.IlliquidCustom);

    function setUp() public {
        setupHelper();

        // Range Orders / partial-fill master switches ON so `matchOffers`
        // reaches `_executeMatch` (otherwise it reverts on the kill-switch).
        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setRangeAmountEnabled(true);
        ConfigFacet(address(diamond)).setRangeRateEnabled(true);
        ConfigFacet(address(diamond)).setRangeCollateralEnabled(true);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        vm.stopPrank();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    /// @dev Force `getEffectiveLiquidityTier(asset) == tier` for the gate's
    ///      classification path (it reads this selector via `address(this)`).
    function _mockTier(address asset, uint8 tier) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector, asset
            ),
            abi.encode(tier)
        );
    }

    /// @dev A single-value ERC-20 Lender offer on the canonical
    ///      mockERC20 → mockCollateralERC20 pair.
    function _lenderOffer() internal returns (uint256 offerId) {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 5_000 ether,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                // Must clear `minCollateralForLending(amountMax)` (≈8.823k ether
                // for a 5k loan) — the Range Orders system-derived floor.
                collateralAmount: 10_000 ether,
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
                amountMax: 5_000 ether,
                interestRateBpsMax: 600,
                collateralAmountMax: 10_000 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    /// @dev A borrower range offer on the same pair, generously
    ///      over-collateralised so a BroadLiquid match passes the HF/LTV gate.
    function _borrowerOffer() internal returns (uint256 offerId) {
        vm.prank(borrower);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: 5_000 ether,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 10_000 ether,
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
                amountMax: 5_000 ether,
                interestRateBpsMax: 600,
                collateralAmountMax: 10_000 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    /// @dev Mock both legs to `tier` so the matched pair classifies uniformly.
    function _mockBothLegs(uint8 tier) internal {
        _mockTier(mockERC20, tier);
        _mockTier(mockCollateralERC20, tier);
    }

    function _enableGate() internal {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 1 — gate OFF (default) is a no-op: a BroadLiquid pair matches even though
    //     both creators are the default BlueChipOnly tier.
    // ════════════════════════════════════════════════════════════════════════

    function test_matchGate_offNoOpAllowsDefaultTierCreators() public {
        _mockBothLegs(1); // both legs BroadLiquid
        uint256 lenderOfferId = _lenderOffer();
        uint256 borrowerOfferId = _borrowerOffer();

        // Gate stays OFF — neither creator armed; match must still settle.
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);

        LibVaipakam.Offer memory B =
            OfferCancelFacet(address(diamond)).getOffer(borrowerOfferId);
        assertEq(B.amountFilled, 5_000 ether, "match filled with gate off");
    }

    // ════════════════════════════════════════════════════════════════════════
    // 2 — gate ON, BroadLiquid pair, LENDER creator under-tiered (default
    //     BlueChipOnly) → matcher re-assertion reverts RiskTierTooLow for the
    //     lender creator BEFORE any state mutation. Proves the matcher gate
    //     fires even though the create-time gate never ran (offers pre-date the
    //     kill-switch flip).
    // ════════════════════════════════════════════════════════════════════════

    function test_matchGate_revertsWhenLenderCreatorUnderTiered() public {
        _mockBothLegs(1);
        uint256 lenderOfferId = _lenderOffer();
        uint256 borrowerOfferId = _borrowerOffer();

        // Arm only the BORROWER creator; leave the lender at the default tier.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);

        _enableGate();

        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.RiskTierTooLow.selector, lender, BROAD, BLUECHIP
            )
        );
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 3 — gate ON, BroadLiquid pair, lender armed but BORROWER creator
    //     under-tiered → the second leg of the re-assertion reverts
    //     RiskTierTooLow for the borrower creator. Guards that BOTH creators are
    //     checked, not just the lender.
    // ════════════════════════════════════════════════════════════════════════

    function test_matchGate_revertsWhenBorrowerCreatorUnderTiered() public {
        _mockBothLegs(1);
        uint256 lenderOfferId = _lenderOffer();
        uint256 borrowerOfferId = _borrowerOffer();

        // Arm only the LENDER creator this time.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);

        _enableGate();

        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.RiskTierTooLow.selector, borrower, BROAD, BLUECHIP
            )
        );
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 4 — gate ON, BroadLiquid pair, BOTH creators armed to BroadLiquid → the
    //     match settles. The armed path is the matcher gate passing on live
    //     state.
    // ════════════════════════════════════════════════════════════════════════

    function test_matchGate_passesWhenBothCreatorsArmed() public {
        _mockBothLegs(1);
        uint256 lenderOfferId = _lenderOffer();
        uint256 borrowerOfferId = _borrowerOffer();

        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);

        _enableGate();

        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);

        LibVaipakam.Offer memory B =
            OfferCancelFacet(address(diamond)).getOffer(borrowerOfferId);
        assertEq(B.amountFilled, 5_000 ether, "match filled with both creators armed");
    }

    // ════════════════════════════════════════════════════════════════════════
    // 5 — LIVE re-check closes the stale-snapshot window: both creators armed to
    //     BroadLiquid, then the lender DOWN-tiers back to BlueChipOnly after the
    //     offers exist. The matcher reads the live (downgraded) tier and reverts
    //     — a create-time snapshot would have wrongly let it through.
    // ════════════════════════════════════════════════════════════════════════

    function test_matchGate_reChecksLiveTierAfterDowngrade() public {
        _mockBothLegs(1);
        uint256 lenderOfferId = _lenderOffer();
        uint256 borrowerOfferId = _borrowerOffer();

        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);

        _enableGate();

        // Lender down-tiers AFTER the offer was authored & armed.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BLUECHIP);

        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.RiskTierTooLow.selector, lender, BROAD, BLUECHIP
            )
        );
        OfferMatchFacet(address(diamond)).matchOffers(lenderOfferId, borrowerOfferId);
    }
}
