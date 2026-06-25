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
 *         `LibRiskAccess.assertAcceptorMayTransact(s, ctx.acceptor, pairFromOffer,
 *         s.acceptAckIlliquidLend, s.acceptAckIlliquidColl)` — the riskier leg
 *         governs (tiers 0=BlueChipOnly, 1=BroadLiquid, 2=IlliquidCustom). It
 *         reverts `RiskTierTooLow` when the acceptor is under-tiered, and
 *         `IlliquidPairNotConsented` when an `IlliquidCustom` pair lacks both a
 *         standing per-pair consent AND a covering #662 ack.
 *
 *         THE UNIFICATION proven here (Codex #729 r1 — strengthened from the
 *         original tier-only `assertActorTier`): on this accept path an
 *         `IlliquidCustom` pair's per-pair consent is satisfied by EITHER a
 *         standing fresh `illiquidPairConsent` OR the #662 acceptance-term binding
 *         — but the #662 ack only substitutes when (a) the acceptor's risk terms
 *         are fresh (`riskTierVersionAt[actor] >= currentRiskTermsVersion`) AND
 *         (b) the signed ack names EXACTLY the gate's illiquid legs
 *         (`_ackCoversIlliquidLegs`, reusing the same per-leg classification). So
 *         for a NON-rental illiquid pair the #662 ack covers it and the acceptor
 *         needs only the right TIER (tests 2-4). But for an NFT RENTAL with an
 *         ILLIQUID prepay token the gate classifies the lend leg off `prepayAsset`
 *         while the #662 ack names the rented NFT — the ack does NOT cover it, so
 *         the acceptor must hold a STANDING per-pair consent (test 6). A
 *         governance `bumpRiskTermsVersion` re-locks the ack-substitution by
 *         making the tier anchor stale (test 5).
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

    /// @dev The PairId exactly as `LoanFacet._maybeRunInitialRiskGates` builds it
    ///      from a `_lenderOffer(lendAsset, collAsset)` ERC-20 offer — both legs
    ///      ERC-20, the offer's `prepayAsset == mockERC20` (canonicalized to 0 in
    ///      `pairKey` for a non-NFT lend leg, so the value is immaterial to the
    ///      consent key but kept faithful here).
    function _offerPair(address lendAsset, address collAsset)
        internal
        view
        returns (LibRiskAccess.PairId memory)
    {
        return LibRiskAccess.PairId({
            lendAsset: lendAsset,
            lendType: LibVaipakam.AssetType.ERC20,
            lendTokenId: 0,
            collAsset: collAsset,
            collType: LibVaipakam.AssetType.ERC20,
            collTokenId: 0,
            prepayAsset: mockERC20
        });
    }

    /// @dev Arm the offer CREATOR (the `lender`) to clear the accept-time creator
    ///      RE-CHECK (Codex #729 r3 finding A) for an `IlliquidCustom` pair: opt
    ///      the creator UP to IlliquidCustom AND record a standing per-pair consent
    ///      on the EXACT pair the gate builds from the offer. The creator signs no
    ///      #662 ack, so a standing consent is its only path. Without this the
    ///      creator re-check (which runs first) would revert before the acceptor
    ///      check — these helpers let the post-A tests isolate the acceptor leg.
    function _armCreatorIlliquid(address lendAsset, address collAsset) internal {
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            _offerPair(lendAsset, collAsset), true
        );
    }

    /// @dev Arm the creator's TIER only (BroadLiquid pairs carry no per-pair
    ///      consent — the tier opt-up is itself the consent).
    function _armCreatorTier(uint8 tier) internal {
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(tier);
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
        // Arm the CREATOR so the accept-time creator re-check (Codex #729 r3
        // finding A) passes — isolating the acceptor tier check under test.
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);

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
        // Arm the CREATOR so its accept-time re-check (finding A) passes.
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);

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
        // Arm the CREATOR's tier so its accept-time re-check (finding A) passes
        // (a BroadLiquid pair needs no per-pair consent — tier opt-up suffices).
        _armCreatorTier(BROAD);

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
    // 5 — RE-LOCK: a risk-terms version bump invalidates the #662 ack-substitution
    //     that let an IlliquidCustom pair through on tier alone (Codex #729 r1
    //     finding 2). After the bump the acceptor's tier anchor is stale, so the
    //     effective tier collapses to BlueChipOnly and the SAME accept reverts
    //     RiskTierTooLow — the tier check trips before the consent branch. The
    //     acceptor must re-affirm their tier (fresh anchor) to transact again.
    // ════════════════════════════════════════════════════════════════════════

    function test_acceptGate_versionBumpRelocksAckSubstitution() public {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockIlliquidERC20, 0); // coll leg illiquid => IlliquidCustom

        // Create BOTH offers up front, while the gate is still OFF, so the
        // lender's (creator) create-time gate never fires (the lender is
        // BlueChipOnly and the pair is IlliquidCustom — a create-gate revert here
        // would be the phase-1 creator check, not the accept-time check we're
        // exercising). offerId is the pre-bump baseline; offerId2 re-exercises the
        // gate after the bump.
        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);
        uint256 offerId2 = _lenderOffer(mockERC20, mockIlliquidERC20);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        // Arm the CREATOR (tier + standing consent) so its accept-time re-check
        // (finding A) passes for the pre-bump baseline accept.
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);

        // Acceptor opts UP to IlliquidCustom (cooldown 0 => immediate). As in
        // test 3, the #662 ack substitutes for a standing per-pair consent.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);

        // Sanity: the ack-substitution path lets the FIRST accept of an offer on
        // this illiquid pair succeed (proves the baseline before the bump).
        uint256 firstLoanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(firstLoanId).borrower,
            borrower,
            "ack-substitution accept succeeds pre-bump"
        );

        // Admin bumps the global risk-terms version. The test contract holds
        // ADMIN_ROLE (mirrors RiskAccessFacetTest — no prank), so the call is
        // direct. This re-locks the acceptor's now-stale tier anchor with ZERO
        // per-user writes (read-time re-lock).
        _bumpRiskTerms(keccak256("rt-9"));
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(borrower),
            BLUECHIP,
            "tier re-locked to BlueChipOnly after terms bump"
        );

        // The bump also re-locked the CREATOR's tier + consent. Re-arm the
        // creator (fresh anchors) so its accept-time re-check passes — isolating
        // the borrower's stale-tier re-lock as the revert under test.
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);

        // Re-accepting the SAME illiquid pair now reverts RiskTierTooLow: the
        // stale anchor drops the effective tier to BlueChipOnly, so the tier
        // check trips first (correct re-lock behavior — the ack-substitution is
        // moot once the tier itself is stale).
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) =
            _buildAndSign(borrower, borrowerPk, offerId2);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.RiskTierTooLow.selector,
                borrower,
                ILLIQUID,
                BLUECHIP
            )
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId2, t, sig);

        // Re-affirm the tier against the live terms (fresh anchor) — the accept
        // succeeds once more, confirming the re-lock is recoverable.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(borrower),
            ILLIQUID,
            "tier fresh again after re-affirm"
        );
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId2);
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loanId).borrower,
            borrower,
            "accept succeeds again after re-affirm"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // 6 — NFT RENTAL with an ILLIQUID PREPAY token: the #662 ack does NOT cover
    //     the illiquid prepay leg (Codex #729 r1 findings 1+3). The gate keys the
    //     LEND leg off `prepayAsset` (the rental's economic risk), while the #662
    //     ack names the rented NFT — the two classifications diverge, so the ack
    //     cannot substitute. The acceptor must hold a STANDING per-pair consent.
    //
    //     NOTE: full NFT-rental accept e2e deferred; covered at the gate-logic
    //     layer (this harness has no shared rental-accept helper, and a hand-rolled
    //     ERC4907/prepay accept would be a fragile test). We assert the two pieces
    //     the gate actually depends on: (a) `pairRequiredRiskLevel == IlliquidCustom`
    //     for an NFT-rental-with-illiquid-prepay pair (proving the lend leg is
    //     classified off the illiquid prepay token, not the NFT), and (b) a
    //     standing `setIlliquidPairConsent` on the EXACT PairId — built the way
    //     LoanFacet builds it from the offer — flips `hasIlliquidPairConsent` on.
    //     Together these are the accept-path's consent gate for this case.
    // ════════════════════════════════════════════════════════════════════════

    function test_acceptGate_nftRentalIlliquidPrepayNeedsStandingConsent() public {
        // The rented NFT is illiquid by AssetType (forced to IlliquidCustom in
        // `_collLegLevel`/`_lendLegLevel`), but a RENTAL lend leg is classified by
        // its `prepayAsset` instead — here an illiquid ERC-20 (tier 0). The
        // collateral is a liquid ERC-20 (tier 1 => BroadLiquid), so the riskier
        // lend leg governs and the pair requires IlliquidCustom.
        _mockTier(mockIlliquidERC20, 0); // illiquid prepay token => IlliquidCustom
        _mockTier(mockCollateralERC20, 1); // liquid collateral => BroadLiquid

        // The PairId exactly as LoanFacet._maybeRunInitialRiskGates builds it from
        // a rental lender offer: NFT lend leg (ERC721, the rented tokenId), liquid
        // ERC-20 collateral, and a non-zero illiquid `prepayAsset`.
        LibRiskAccess.PairId memory rentalPair = LibRiskAccess.PairId({
            lendAsset: mockNft721,
            lendType: LibVaipakam.AssetType.ERC721,
            lendTokenId: 1,
            collAsset: mockCollateralERC20,
            collType: LibVaipakam.AssetType.ERC20,
            collTokenId: 0,
            prepayAsset: mockIlliquidERC20
        });

        // (a) Classification: the rental lend leg ties to the illiquid prepay
        //     token, so the pair requires IlliquidCustom (level 2).
        assertEq(
            RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(rentalPair),
            ILLIQUID,
            "NFT-rental-with-illiquid-prepay pair requires IlliquidCustom"
        );

        // The #662 ack for this pair would name the rented NFT (`mockNft721`,
        // illiquid), NOT the prepay token — so it cannot cover the gate's lend leg
        // (classAsset == prepay). Hence the standing consent is the only path.
        // Acceptor (borrower) starts WITHOUT a consent on the pair.
        assertFalse(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(
                borrower, rentalPair
            ),
            "no standing consent before grant"
        );

        // (b) The acceptor records a standing consent on the EXACT pair (cooldown
        //     0 => effective immediately). `hasIlliquidPairConsent` flips on.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(rentalPair, true);
        assertTrue(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(
                borrower, rentalPair
            ),
            "standing consent effective after grant"
        );

        // A consent recorded on a DIFFERENT pair (e.g. the same NFT as plain
        // collateral, no prepay) must NOT satisfy this rental pair — the pairKey
        // folds in `prepayAsset` so the two are distinct consents.
        LibRiskAccess.PairId memory otherPair = LibRiskAccess.PairId({
            lendAsset: mockNft721,
            lendType: LibVaipakam.AssetType.ERC721,
            lendTokenId: 1,
            collAsset: mockCollateralERC20,
            collType: LibVaipakam.AssetType.ERC20,
            collTokenId: 0,
            prepayAsset: address(0)
        });
        assertFalse(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(
                borrower, otherPair
            ),
            "consent does not leak across distinct prepay-keyed pairs"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // 7 — RE-CHECK CREATOR (Codex #729 r3 finding A): an offer authored while the
    //     gate was OFF (creator ungated at create) must STILL revert at accept
    //     once the gate is ON and the stored creator is under-tiered for the pair.
    //     The creator re-check runs BEFORE the acceptor check, so with the
    //     acceptor fully armed the revert names the CREATOR.
    // ════════════════════════════════════════════════════════════════════════

    function test_acceptGate_reChecksStaleCreatorAtAccept() public {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockIlliquidERC20, 0); // coll leg illiquid => IlliquidCustom

        // Offer created gate-off: the creator (lender, BlueChipOnly) is ungated.
        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);

        // Fully arm the ACCEPTOR (tier; the #662 ack covers the illiquid coll
        // leg) so the acceptor gate would pass — isolating the creator re-check.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);

        // The stored creator is still BlueChipOnly => accept reverts on the
        // CREATOR re-check (RiskTierTooLow names the LENDER, not the borrower).
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) =
            _buildAndSign(borrower, borrowerPk, offerId);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.RiskTierTooLow.selector, lender, ILLIQUID, BLUECHIP
            )
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);

        // Arm the creator too => the stale-offer window is closed cleanly and the
        // accept now succeeds.
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loanId).borrower,
            borrower,
            "accept succeeds once the creator is re-armed"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // 8 — VERIFIED-ACK-ONLY substitution (Codex #729 r3 finding B): a leg that is
    //     `IlliquidCustom` by DERIVED tier (effective tier 0) but still
    //     `checkLiquidity == Liquid` is NEVER validated by the #662 ack check, so
    //     a FORGED ack naming it must NOT substitute for a standing consent. The
    //     acceptor must hold a standing per-pair consent.
    // ════════════════════════════════════════════════════════════════════════

    function test_acceptGate_forgedAckOnDerivedTier0NeedsStandingConsent() public {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        // Collateral: liquid by `checkLiquidity` (SetupTest default) but DEMOTED
        // to effective tier 0 => IlliquidCustom per #671, yet NOT `Illiquid` to
        // the #662 check — so its ack is never validated there.
        _mockTier(mockCollateralERC20, 0);

        uint256 offerId = _lenderOffer(mockERC20, mockCollateralERC20);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);

        // Creator armed (tier + standing consent — no ack path). Acceptor armed
        // to the TIER only; deliberately NO standing consent.
        _armCreatorIlliquid(mockERC20, mockCollateralERC20);
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);

        // FORGE the acceptor's ack to name the demoted collateral even though
        // `checkLiquidity` says Liquid (the honest `_ack` returns address(0)).
        LibAcceptTerms.AcceptTerms memory t = LibAcceptTestSigner.buildTerms(
            address(diamond), borrower, offerId, true, 0
        );
        t.acknowledgedIlliquidCollateralAsset = mockCollateralERC20; // forged
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);

        // The forged ack must NOT substitute (never #662-verified) => the
        // IlliquidCustom pair requires a standing consent the acceptor lacks.
        bytes32 pk =
            LibRiskAccess.pairKey(_offerPair(mockERC20, mockCollateralERC20));
        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.IlliquidPairNotConsented.selector, borrower, pk
            )
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);

        // Grant a STANDING consent on the pair => the standing-consent branch
        // returns before the ack check, so the same (still-forged) terms accept.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            _offerPair(mockERC20, mockCollateralERC20), true
        );
        vm.prank(borrower);
        uint256 loanId =
            OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loanId).borrower,
            borrower,
            "accept succeeds once a standing consent is recorded"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // 9 — PREVIEW the gate (Codex #729 r3 finding C): the dedicated, non-reverting
    //     `RiskAccessFacet.previewOfferAcceptBlock(offerId, acceptor)` view surfaces
    //     the risk-access block (0 = OK, 1 = tier too low, 2 = illiquid pair needs
    //     standing consent) so the frontend never quotes an accept that loan-init
    //     would revert. (OfferAcceptFacet is at the EIP-170 ceiling, so the gate is
    //     exposed as this dedicated view rather than folded into `previewAccept`'s
    //     `AcceptError` — the "expose a matching preview error" option.) Uses
    //     STANDING-consent semantics (a preview has no #662 ack to substitute), so
    //     a missing standing consent surfaces code 2 — the conservative UX hint the
    //     frontend clears by collecting the acknowledgement (or a standing consent).
    // ════════════════════════════════════════════════════════════════════════

    function test_previewOfferAcceptBlock_surfacesRiskAccessGate() public {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockIlliquidERC20, 0); // coll leg illiquid => IlliquidCustom

        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);

        // Gate OFF (default): the preview view short-circuits to 0 (OK).
        assertEq(
            RiskAccessFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            0,
            "gate off => 0 (OK)"
        );

        // Gate ON, creator (lender) still BlueChipOnly => the creator block
        // surfaces first as code 1 (tier too low).
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        assertEq(
            RiskAccessFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            1,
            "under-tiered party => 1 (tier too low)"
        );

        // Arm the creator + opt the acceptor UP to the tier (still no standing
        // consent). The acceptor leg is ack-AWARE (#735 item 1): the only illiquid
        // leg (the collateral) is GENUINELY illiquid (`checkLiquidity == Illiquid`),
        // so the acceptor's standard #662 ack WILL cover it at sign-time => the view
        // reports the SOFT code 4, not the hard code 2.
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        assertEq(
            RiskAccessFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            4,
            "tier OK, no standing consent, #662 ack covers => 4 (soft)"
        );

        // Record a standing consent for the acceptor => the view clears to 0.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            _offerPair(mockERC20, mockIlliquidERC20), true
        );
        assertEq(
            RiskAccessFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            0,
            "standing consent => 0 (OK)"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // 9b — ACK-AWARE accept preview (#735 item 1): the ACCEPTOR leg models the
    //      #662 ack substitution, so the preview distinguishes an illiquid pair
    //      the acceptor's standard ack WILL clear (soft code 4) from one it
    //      CANNOT (hard code 2). These guard the boundary that the soft path must
    //      NOT swallow a genuinely-blocking case.
    // ════════════════════════════════════════════════════════════════════════

    // A DERIVED-tier-0 leg — the gate deems it `IlliquidCustom`
    // (`getEffectiveLiquidityTier == 0`) but it reads `checkLiquidity == Liquid`
    // (a liquid-looking ERC-20 demoted on depth) — is NOT covered by the #662 ack:
    // the accept-time check only verifies an ack for a leg it sees `Illiquid`, so
    // the substitution never applies and the preview must stay HARD code 2 (the
    // `*AckVerified` boundary, Codex #729 r3). Softening it to 4 would quote an
    // accept the gate would revert.
    function test_previewOfferAcceptBlock_ackAware_derivedTier0StaysHard()
        public
    {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockIlliquidERC20, 0); // coll leg gate-IlliquidCustom…
        // …but it reads LIQUID (derived tier 0): the #662 ack can't verify it.
        mockOracleLiquidity(mockIlliquidERC20, LibVaipakam.LiquidityStatus.Liquid);

        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);

        // Acceptor is tiered up with no standing consent, but the ack CANNOT cover
        // the derived-tier-0 leg => the preview stays the hard code 2, not 4.
        assertEq(
            RiskAccessFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            2,
            "derived-tier-0 leg: #662 ack can't verify => stays hard 2"
        );

        // A standing consent is the only way past => clears to 0 (proves the hard
        // code 2 was a real block, not a quirk).
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            _offerPair(mockERC20, mockIlliquidERC20), true
        );
        assertEq(
            RiskAccessFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            0,
            "standing consent clears the derived-tier-0 block => 0"
        );
    }

    // The acceptor's #662 ack is the ACCEPTOR's attestation — it can never heal a
    // CREATOR-side illiquid gap. With the creator opted up to IlliquidCustom but
    // holding NO standing consent (e.g. revoked / stale after a bump), the creator
    // leg surfaces first as the hard code 2 and is NOT softened by the acceptor's
    // ack-aware path (which only runs after a clean creator leg).
    function test_previewOfferAcceptBlock_ackAware_creatorSideGapNotSoftened()
        public
    {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockIlliquidERC20, 0); // coll leg illiquid => IlliquidCustom

        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);

        // Creator opts UP to IlliquidCustom but records NO standing consent — the
        // creator's own illiquid-pair gap. (The acceptor is fully armed so only the
        // creator leg can block.)
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            _offerPair(mockERC20, mockIlliquidERC20), true
        );

        assertEq(
            RiskAccessFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            2,
            "creator-side illiquid gap => hard 2 (acceptor ack can't heal it)"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // 10 — SALE-BUYER gate (Codex #729 r3 finding E): a loan-sale BUYER is gated
    //      against the LINKED loan's asset pair (the exiting seller stays exempt).
    //
    //      NOTE: the full sale-accept e2e is deferred for the SAME harness-
    //      fragility reason as tests 6/11 — the path needs `createLoanSaleOffer`
    //      + a fully-provisioned buyer + the `completeLoanSale` cross-facet mocks
    //      (see Scenario7_LenderEarlyWithdrawal). We assert the gate-decision
    //      pieces the LoanFacet wiring composes via the SAME unit-tested
    //      `assertActorMayTransact`: (a) the linked loan's pair (ERC-20 principal
    //      + illiquid collateral) requires IlliquidCustom, (b) a fresh buyer is
    //      below the bar with no consent, and (c) a tier opt-up + standing consent
    //      lifts the buyer over both gate legs.
    // ════════════════════════════════════════════════════════════════════════

    function test_saleBuyerGate_linkedLoanPairClassificationAndConsent() public {
        _mockTier(mockERC20, 3); // linked loan principal: blue-chip
        _mockTier(mockIlliquidERC20, 0); // linked loan collateral: illiquid

        // The PairId exactly as LoanFacet builds from the LINKED loan in the
        // sale-vehicle branch (principalAsset, assetType, collateralAsset,
        // collateralAssetType, token ids, prepayAsset).
        LibRiskAccess.PairId memory linkedPair = LibRiskAccess.PairId({
            lendAsset: mockERC20,
            lendType: LibVaipakam.AssetType.ERC20,
            lendTokenId: 0,
            collAsset: mockIlliquidERC20,
            collType: LibVaipakam.AssetType.ERC20,
            collTokenId: 0,
            prepayAsset: address(0)
        });

        // (a) the linked pair requires IlliquidCustom (illiquid collateral leg).
        assertEq(
            RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(linkedPair),
            ILLIQUID,
            "linked loan pair requires IlliquidCustom"
        );

        // (b) a fresh buyer is BlueChipOnly with no standing consent => below the
        //     bar on BOTH gate legs (would revert RiskTierTooLow at accept).
        address buyer = makeAddr("saleBuyer");
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(buyer),
            BLUECHIP,
            "fresh buyer is BlueChipOnly"
        );
        assertFalse(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(
                buyer, linkedPair
            ),
            "fresh buyer has no standing consent"
        );

        // (c) the buyer opts UP + records a standing consent => clears both legs.
        vm.prank(buyer);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        vm.prank(buyer);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(linkedPair, true);
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(buyer),
            ILLIQUID,
            "buyer effective IlliquidCustom after opt-up"
        );
        assertTrue(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(
                buyer, linkedPair
            ),
            "buyer standing consent effective on the linked pair"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // 10b — #730: a #662 ack signed BEFORE a terms bump can't substitute after,
    //       even when the acceptor re-affirms only their TIER (not the ack).
    // ════════════════════════════════════════════════════════════════════════

    /// @dev The #730 replay vector. The ack-substitution freshness used to be
    ///      anchored ONLY to the vault's tier version, so an acceptor who signed
    ///      a long-deadline illiquid `AcceptTerms` before a governance bump, then
    ///      re-affirmed merely their TIER afterward, could still submit the stale
    ///      ack as fresh per-pair consent. The ack now binds the live
    ///      `currentRiskTermsHash` and the gate requires it to MATCH exactly; a
    ///      bump re-derives the hash, so the pre-bump ack (which named the old
    ///      hash) reverts `IlliquidPairNotConsented`, while a freshly re-signed ack
    ///      substitutes again (recoverable, like a standing consent). Binding the
    ///      unguessable hash — not the predictable numeric version — also blocks a
    ///      UI pre-stamping the NEXT version (see
    ///      `test_acceptGate_guessedFutureHashDoesNotSubstitute`).
    function test_acceptGate_staleAckDoesNotSubstituteAfterBump() public {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockIlliquidERC20, 0); // coll leg illiquid => IlliquidCustom

        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);

        // Acceptor opts UP to IlliquidCustom (cooldown 0 => immediate).
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);

        // Capture a signature NOW, at the current (pre-bump, hash 0) terms — the
        // "long-deadline ack signed before the bump."
        (LibAcceptTerms.AcceptTerms memory staleTerms, bytes memory staleSig) =
            _buildAndSign(borrower, borrowerPk, offerId);
        assertEq(staleTerms.riskTermsHash, bytes32(0), "ack stamped at pre-bump hash 0");

        // Governance bumps the terms version — this re-derives currentRiskTermsHash
        // to a new (non-zero) value.
        _bumpRiskTerms(keccak256("rt-10"));
        bytes32 liveHash =
            RiskAccessFacet(address(diamond)).getCurrentRiskTermsHash();
        assertTrue(liveHash != bytes32(0), "bump re-derives a non-zero terms hash");

        // Acceptor re-affirms ONLY their tier (riskTierVersionAt fresh, effective
        // tier back to IlliquidCustom) — but NOT the ack (still names hash 0).
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(borrower),
            ILLIQUID,
            "tier re-affirmed fresh after bump"
        );

        // Re-arm the creator (the bump re-locked it too) so the borrower's stale
        // ack is the ONLY thing under test.
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);

        // The stale ack no longer substitutes: the tier check passes (re-affirmed),
        // but ack-substitution requires the SIGNED hash to equal the live one
        // (0 != liveHash) and there is no standing consent.
        vm.expectPartialRevert(LibRiskAccess.IlliquidPairNotConsented.selector);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, staleTerms, staleSig);

        // A FRESH ack (stamped at the live hash) substitutes again — the re-lock is
        // recoverable by re-signing, like the standing consent.
        (LibAcceptTerms.AcceptTerms memory freshTerms, bytes memory freshSig) =
            _buildAndSign(borrower, borrowerPk, offerId);
        assertEq(freshTerms.riskTermsHash, liveHash, "fresh ack stamped at the live post-bump hash");
        vm.prank(borrower);
        uint256 loanId =
            OfferAcceptFacet(address(diamond)).acceptOffer(offerId, freshTerms, freshSig);
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loanId).borrower,
            borrower,
            "fresh ack substitutes post-bump"
        );
    }

    /// @dev #730 / Codex #736 r1+r3 — a GUESSED / pre-stamped ack hash must not
    ///      substitute. The numeric version was predictable, so even an exact `==`
    ///      let a UI pre-stamp `N+1` and have the stale ack activate on the next
    ///      bump. The ack now binds `currentRiskTermsHash`, re-derived at bump time
    ///      from block entropy a pre-signing UI can't predict: an ack carrying any
    ///      attacker-chosen hash fails to match the real post-bump hash.
    function test_acceptGate_guessedFutureHashDoesNotSubstitute() public {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockIlliquidERC20, 0); // coll leg illiquid => IlliquidCustom

        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);

        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);

        // Pre-stamp a GUESS of what the next bump's terms hash might be, and sign
        // it — the malicious-UI / relayer scenario where the user is induced to
        // acknowledge a future terms version sight-unseen.
        LibAcceptTerms.AcceptTerms memory t = LibAcceptTestSigner.buildTerms(
            address(diamond), borrower, offerId, true, 0
        );
        t.riskTermsHash = keccak256("attacker-guess-of-next-terms-hash");
        bytes memory sig = LibAcceptTestSigner.sign(address(diamond), t, borrowerPk);

        // Governance bumps — the real hash is derived from block entropy and will
        // not equal the attacker's guess.
        _bumpRiskTerms(keccak256("rt-11"));
        assertTrue(
            RiskAccessFacet(address(diamond)).getCurrentRiskTermsHash() != t.riskTermsHash,
            "real post-bump hash is not the guessed value"
        );

        // Re-affirm the tier so only the guessed ack hash is under test.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);

        // The guessed-hash ack is denied: it doesn't match the unguessable live
        // hash, so it can't substitute for a standing consent.
        vm.expectPartialRevert(LibRiskAccess.IlliquidPairNotConsented.selector);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 11 — keeper-match path is NOT gated by THIS accept-time site.
    // ════════════════════════════════════════════════════════════════════════

    // NOTE: the keeper-match path (`acceptAckActive == false`, e.g. an
    //       `OfferMatchFacet.matchOffers` flow) is deliberately NOT gated by the
    //       accept-time `assertActorTier` site under test here — it re-asserts
    //       each offer's OWN creator at the matcher instead. That re-assertion is
    //       PR-2b's job (#728 PR-2b), so a matchOffers-driven loan-init with an
    //       under-tiered party is out of scope for this PR-2a suite and is
    //       stubbed rather than exercised with a broken test.
}
