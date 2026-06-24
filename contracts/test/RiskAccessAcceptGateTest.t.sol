// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibRiskAccess} from "../src/libraries/LibRiskAccess.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";

/**
 * @title RiskAccessAcceptGateTest
 * @notice #671 phase-2 / PR-2a — the ACCEPTOR-side progressive-risk gate at
 *         loan-init (`LoanFacet._maybeRunInitialRiskGates`). On the DIRECT-ACCEPT
 *         path (`s.acceptAckActive == true`) and only when
 *         `cfgRiskAccessGateEnabled()` is ON, the protocol asserts the ACCEPTOR's
 *         vault tier covers the offer's pair via
 *         `LibRiskAccess.assertActorTier(s, ctx.acceptor, pairFromOffer)` — the
 *         riskier leg governs (tiers 0=BlueChipOnly, 1=BroadLiquid,
 *         2=IlliquidCustom). It reverts `RiskTierTooLow` when the acceptor is
 *         under-tiered.
 *
 *         THE UNIFICATION proven here: on this accept path the acceptor needs NO
 *         separate `setIlliquidPairConsent`. The #662 acceptance-term binding
 *         (an EIP-712 `AcceptTerms` that names every illiquid leg) already covers
 *         the per-pair consent, so an acceptor with the right TIER can accept an
 *         illiquid pair WITHOUT ever calling `setIlliquidPairConsent`. Only the
 *         TIER gates them (this is why the site calls `assertActorTier`, the
 *         tier-only variant, not `assertActorMayTransact`).
 *
 *         Isolating the acceptor gate from the CREATOR gate: the create-time gate
 *         in `OfferCreateFacet` fires only if `cfgRiskAccessGateEnabled()` was ON
 *         AT CREATE TIME. Every test here CREATES THE OFFER FIRST (gate OFF, the
 *         default) and only THEN flips the gate ON before the accept — so the
 *         creator's create call never runs the gate and the only check under test
 *         is the accept-time acceptor assertion. (`vm.mockCall` tier forcing set
 *         before create persists, but the off gate makes it a no-op at create.)
 *
 *         Mirrors AcceptTermBindingTest's setUp + `_lenderOffer` and reuses the
 *         shared `LibAcceptTestSigner` build+sign+accept helper (via SetupTest's
 *         `_signAndAcceptOffer`). Tier forcing uses the `_mockTier` idiom from
 *         RiskAccessFacetTest.
 */
contract RiskAccessAcceptGateTest is SetupTest {
    uint8 constant BLUECHIP = uint8(LibVaipakam.RiskAccessLevel.BlueChipOnly);
    uint8 constant BROAD = uint8(LibVaipakam.RiskAccessLevel.BroadLiquid);
    uint8 constant ILLIQUID = uint8(LibVaipakam.RiskAccessLevel.IlliquidCustom);

    function setUp() public {
        setupHelper();
    }

    // ─── Tier-forcing helper (mirrors RiskAccessFacetTest / DepthTieredLtv) ───

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

    // ─── Offer builder (copied from AcceptTermBindingTest._lenderOffer) ───────

    /// @dev A single-value ERC-20 Lender offer (creator consents), parameterised
    ///      on the lend/collateral legs so the illiquid scenarios swap one in.
    ///      The lender is the creator; the BORROWER is the acceptor under test.
    function _lenderOffer(address lendAsset, address collAsset)
        internal
        returns (uint256 offerId)
    {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: lendAsset,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: collAsset,
                collateralAmount: 1500 ether,
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
                amountMax: 1000 ether,
                interestRateBpsMax: 500,
                collateralAmountMax: 1500 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    /// @dev Build + sign the acceptor's AcceptTerms WITHOUT submitting — for the
    ///      revert tests, whose `acceptOffer` call must run under `expectRevert`
    ///      (the build/sign view-calls would otherwise consume the expectRevert).
    function _buildAndSign(address acceptor, uint256 pk, uint256 offerId)
        internal
        view
        returns (LibAcceptTerms.AcceptTerms memory t, bytes memory sig)
    {
        t = LibAcceptTestSigner.buildTerms(address(diamond), acceptor, offerId, true, 0);
        sig = LibAcceptTestSigner.sign(address(diamond), t, pk);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 1 — gate OFF (default) is a no-op: a BlueChipOnly acceptor accepts a pair
    //     that WOULD require IlliquidCustom and the loan initiates fine.
    // ════════════════════════════════════════════════════════════════════════

    function test_acceptGate_offNoOpAllowsBlueChipOnlyAcceptor() public {
        // Lend leg blue-chip (tier 3); collateral leg illiquid (tier 0) so the
        // pair WOULD require IlliquidCustom were the gate on.
        _mockTier(mockERC20, 3);
        _mockTier(mockIlliquidERC20, 0);

        // Offer created with gate OFF (default) so neither create nor accept gate.
        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);
        assertFalse(
            ConfigFacet(address(diamond)).getRiskAccessGateEnabled(),
            "gate off by default"
        );

        // Borrower (BlueChipOnly default) accepts; mutual illiquid consent
        // (creator + acceptor both consent) skips the LTV/HF leg, and the gate
        // is off, so the loan initiates.
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.borrower, borrower, "loan created with gate off");
    }

    // ════════════════════════════════════════════════════════════════════════
    // 2 — gate ON, under-tiered acceptor reverts RiskTierTooLow. Creator gate is
    //     dodged by enabling the gate AFTER the offer is created.
    // ════════════════════════════════════════════════════════════════════════

    function test_acceptGate_onRevertsForUnderTieredAcceptor() public {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockIlliquidERC20, 0); // coll leg illiquid => IlliquidCustom

        // Create FIRST (gate off) so the creator's create call is ungated; then
        // flip the gate ON so only the accept-time acceptor check fires.
        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);

        // Borrower is BlueChipOnly (default); pair requires IlliquidCustom. The
        // #662 ack still passes (buildTerms names the illiquid collateral), so
        // the revert is the #671 tier gate, not the ack check.
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) =
            _buildAndSign(borrower, borrowerPk, offerId);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.RiskTierTooLow.selector,
                borrower,
                ILLIQUID,
                BLUECHIP
            )
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 3 — THE UNIFICATION: gate ON, acceptor opts UP to IlliquidCustom but does
    //     NOT call setIlliquidPairConsent — the #662 acceptance ack already
    //     satisfies the per-pair consent, so the loan initiates on tier alone.
    // ════════════════════════════════════════════════════════════════════════

    function test_acceptGate_onSucceedsOnTierAloneWithoutPerPairConsent() public {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockIlliquidERC20, 0); // coll leg illiquid => IlliquidCustom

        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);

        // Acceptor opts UP to IlliquidCustom (cooldown 0 default => immediate).
        // Deliberately NO `setIlliquidPairConsent` call — the only #671 step the
        // acceptor takes on this path is raising their TIER.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(borrower),
            ILLIQUID,
            "acceptor effective IlliquidCustom"
        );

        // The accept's signed AcceptTerms names the illiquid collateral (the
        // #662 flow enforces this via `_ack`), satisfying the per-pair consent.
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(
            loan.borrower,
            borrower,
            "illiquid loan initiated on tier alone (no per-pair consent)"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // 4 — gate ON, BroadLiquid pair passes on the acceptor's tier alone (no
    //     per-pair step): under-tiered reverts, then opt-up to BroadLiquid wins.
    // ════════════════════════════════════════════════════════════════════════

    function test_acceptGate_broadLiquidPassesOnAcceptorTierAlone() public {
        // Both legs liquid tier-1 (neither blue-chip) => the pair requires
        // BroadLiquid. Both legs stay `checkLiquidity == Liquid` (SetupTest
        // default), so `bothLiquid` is true and the mocked LTV/HF check applies
        // and passes — isolating the tier gate as the only variable.
        _mockTier(mockERC20, 1);
        _mockTier(mockCollateralERC20, 1);

        uint256 offerId = _lenderOffer(mockERC20, mockCollateralERC20);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);

        // BlueChipOnly (default) acceptor is under-tiered for a BroadLiquid pair.
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) =
            _buildAndSign(borrower, borrowerPk, offerId);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.RiskTierTooLow.selector,
                borrower,
                BROAD,
                BLUECHIP
            )
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);

        // Opt UP to BroadLiquid (cooldown 0 => immediate) — NO per-pair consent.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);

        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(
            loan.borrower,
            borrower,
            "BroadLiquid pair accepted on tier alone"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // 5 — keeper-match path is NOT gated by THIS accept-time site.
    // ════════════════════════════════════════════════════════════════════════

    // NOTE: the keeper-match path (`acceptAckActive == false`, e.g. an
    //       `OfferMatchFacet.matchOffers` flow) is deliberately NOT gated by the
    //       accept-time `assertActorTier` site under test here — it re-asserts
    //       each offer's OWN creator at the matcher instead. That re-assertion is
    //       PR-2b's job (#728 PR-2b), so a matchOffers-driven loan-init with an
    //       under-tiered party is out of scope for this PR-2a suite and is
    //       stubbed rather than exercised with a broken test.
}
