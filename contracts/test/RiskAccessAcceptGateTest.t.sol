// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibRiskAccess} from "../src/libraries/LibRiskAccess.sol";
import {LibAcceptTerms} from "../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {RiskPreviewFacet} from "../src/facets/RiskPreviewFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";

/**
 * @title RiskAccessAcceptGateTest
 * @notice #671 phase-2 / PR-2a — the ACCEPTOR-side progressive-risk gate at
 *         loan-init (`LoanFacet._maybeRunInitialRiskGates`). On the DIRECT-ACCEPT
 *         path (`s.acceptAckActive == true`) and only when
 *         `cfgRiskAccessGateEnabled()` is ON, the protocol asserts the ACCEPTOR's
 *         vault tier covers the offer's pair via
 *         `LibRiskAccess.assertActorMayTransact(s, acceptingParty, pairFromOffer)`
 *         — the same rule the creator faces. The riskier leg governs (tiers
 *         0=BlueChipOnly, 1=BroadLiquid, 2=IlliquidCustom). It reverts
 *         `RiskTierTooLow` when the acceptor is under-tiered, and
 *         `IlliquidPairNotConsented` when an `IlliquidCustom` pair lacks an ARMED
 *         standing per-pair consent.
 *
 *         #3231 retired the #662⇄#671 ack substitution (Codex #729 r1), under
 *         which the acceptor's signed accept acknowledgement could stand in for
 *         the standing consent. A consent given inside the deal skipped the
 *         unlock cooldown, so a stolen key could approve a junk pair and accept
 *         in one sitting. Tests 3 and 3b prove the acknowledgement no longer
 *         substitutes and that a consent recorded just before the deal waits the
 *         cooldown; test 5 that a terms bump re-locks tier and consent.

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
                // #998 S15: 2000 clears the create-time collateral floor
                collateralAmount: 2000 ether,
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
                // #998 S15: 2000 clears the create-time collateral floor
                collateralAmountMax: 2000 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            }),
            type(uint64).max
        );
    }

    /// @dev Build + sign the acceptor's AcceptTerms WITHOUT submitting — for the
    ///      revert tests, whose `acceptOffer` call must run under `expectRevert`
    ///      (the build/sign view-calls would otherwise consume the expectRevert).
    function _buildAndSign(address acceptor, uint256 pk, uint256 offerId)
        internal
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
    // 3 — #3231: gate ON, acceptor opts UP to IlliquidCustom but holds NO
    //     standing per-pair consent. The honest #662 accept acknowledgement
    //     (naming the illiquid collateral) NO LONGER stands in for it: the
    //     accept reverts until the acceptor records the consent.
    // ════════════════════════════════════════════════════════════════════════

    function test_acceptGate_illiquidPairNeedsStandingConsentAckDoesNotSubstitute()
        public
    {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockIlliquidERC20, 0); // coll leg illiquid => IlliquidCustom

        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        // Arm the CREATOR so its accept-time re-check passes.
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);

        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);

        // The signed AcceptTerms names the illiquid collateral (the honest #662
        // acknowledgement), and the terms are fresh — before #3231 this alone
        // let the loan through. Now it reverts for want of a standing consent.
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) =
            _buildAndSign(borrower, borrowerPk, offerId);
        assertEq(
            t.acknowledgedIlliquidCollateralAsset,
            mockIlliquidERC20,
            "honest ack names the illiquid collateral"
        );
        bytes32 pk =
            LibRiskAccess.pairKey(_offerPair(mockERC20, mockIlliquidERC20));
        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.IlliquidPairNotConsented.selector, borrower, pk
            )
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);

        // Record the standing consent (cooldown 0 here) => the accept goes through.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            _offerPair(mockERC20, mockIlliquidERC20), true
        );
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loanId).borrower,
            borrower,
            "illiquid loan initiated once a standing consent is armed"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // 3b — #3231: with the unlock cooldown set (48h, the testnet/mainnet value),
    //      a consent recorded just before the deal is NOT yet armed, so a thief
    //      holding the key cannot consent and accept in one sitting. Only once
    //      the cooldown has passed does the same accept go through.
    // ════════════════════════════════════════════════════════════════════════

    function test_acceptGate_consentRecordedJustBeforeDealWaitsCooldown() public {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockIlliquidERC20, 0); // coll leg illiquid => IlliquidCustom

        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);
        // #3443 — let the offer's terms age first, so signing the accept
        // below moves no time and the cooldown is measured from the consent.
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        // Creator and acceptor tiers are raised while the cooldown is still 0.
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);

        uint64 cooldown = 48 hours;
        RiskAccessFacet(address(diamond)).setRiskAccessUnlockCooldown(cooldown);

        // The acceptor records the pair consent now: it is pending, not armed.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            _offerPair(mockERC20, mockIlliquidERC20), true
        );
        bytes32 pk =
            LibRiskAccess.pairKey(_offerPair(mockERC20, mockIlliquidERC20));
        (LibAcceptTerms.AcceptTerms memory t, bytes memory sig) =
            _buildAndSign(borrower, borrowerPk, offerId);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.IlliquidPairNotConsented.selector, borrower, pk
            )
        );
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId, t, sig);
        assertEq(
            RiskPreviewFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            2,
            "pending consent => preview code 2"
        );

        // One second short of the cooldown it is still not armed.
        vm.warp(block.timestamp + cooldown - 1);
        assertEq(
            RiskPreviewFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            2,
            "still pending 1s before the cooldown ends"
        );

        // Once the cooldown has passed the consent is armed and the accept goes.
        vm.warp(block.timestamp + 1);
        assertEq(
            RiskPreviewFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            0,
            "armed after the cooldown => 0"
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
    // 5 — RE-LOCK: a risk-terms version bump re-locks both the acceptor's tier
    //     and their standing pair consent. After the bump the tier anchor is
    //     stale, so the effective tier collapses to BlueChipOnly and the SAME
    //     accept reverts RiskTierTooLow; re-affirming the tier then exposes the
    //     stale consent (IlliquidPairNotConsented); re-recording it recovers.
    // ════════════════════════════════════════════════════════════════════════

    function test_acceptGate_versionBumpRelocksTierAndConsent() public {
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

        // Acceptor opts UP to IlliquidCustom and records the standing per-pair
        // consent (cooldown 0 => both immediate; #3231 — no ack substitution).
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            _offerPair(mockERC20, mockIlliquidERC20), true
        );

        // Sanity: the FIRST accept of an offer on this illiquid pair succeeds
        // (proves the baseline before the bump).
        uint256 firstLoanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(firstLoanId).borrower,
            borrower,
            "standing-consent accept succeeds pre-bump"
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
        // check trips first (correct re-lock behavior).
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

        // Re-affirm the tier against the live terms (fresh anchor). The bump
        // re-locked the standing consent too, so re-affirming the tier alone is
        // not enough: the accept now trips the consent check.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(borrower),
            ILLIQUID,
            "tier fresh again after re-affirm"
        );
        (t, sig) = _buildAndSign(borrower, borrowerPk, offerId2);
        vm.expectPartialRevert(LibRiskAccess.IlliquidPairNotConsented.selector);
        vm.prank(borrower);
        OfferAcceptFacet(address(diamond)).acceptOffer(offerId2, t, sig);

        // Re-record the consent against the live terms — the accept succeeds once
        // more, confirming the re-lock is recoverable.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            _offerPair(mockERC20, mockIlliquidERC20), true
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

        // Fully arm the ACCEPTOR (tier + standing pair consent, #3231) so the
        // acceptor gate would pass — isolating the creator re-check.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            _offerPair(mockERC20, mockIlliquidERC20), true
        );

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
            RiskPreviewFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            0,
            "gate off => 0 (OK)"
        );

        // Gate ON, creator (lender) still BlueChipOnly => the creator block
        // surfaces first as code 1 (tier too low).
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        assertEq(
            RiskPreviewFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            1,
            "under-tiered party => 1 (tier too low)"
        );

        // Arm the creator + opt the acceptor UP to the tier (still no standing
        // consent). #3231: the accept acknowledgement no longer covers an
        // illiquid pair, so the view reports the hard code 2 (the retired soft
        // code 4 is never returned).
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        assertEq(
            RiskPreviewFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            2,
            "tier OK, no standing consent => 2"
        );

        // Record a standing consent for the acceptor => the view clears to 0.
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            _offerPair(mockERC20, mockIlliquidERC20), true
        );
        assertEq(
            RiskPreviewFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            0,
            "standing consent => 0 (OK)"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // 9b — ACK-AWARE accept preview (#735 item 1): the ACCEPTOR leg models the
    //      #662 ack substitution [retired by #3231 — every case below is now
    //      code 2 by construction; kept as regressions], so the preview distinguishes an illiquid pair
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
        // #998 S15 (#900) — a derived-tier-0 collateral is a REAL liquid ERC-20
        // (positive init-LTV) that is depth-demoted for RISK-ACCESS only; only its
        // `getEffectiveLiquidityTier` (mocked 0 above) drops, not its loan-init LTV.
        // Give it an explicit init-LTV ceiling so the offer's admission shape is
        // pinned (an unset row would mean "no extra ceiling", #2696) — the
        // preview classification still comes from the mocked tier, so the
        // derived-tier-0 assertion below is unchanged.
        TestMutatorFacet(address(diamond)).setLoanInitMaxLtvBpsRaw(
            mockIlliquidERC20, 8000
        );

        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);
        vm.prank(borrower);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);

        // Acceptor is tiered up with no standing consent, but the ack CANNOT cover
        // the derived-tier-0 leg => the preview stays the hard code 2, not 4.
        assertEq(
            RiskPreviewFacet(address(diamond))
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
            RiskPreviewFacet(address(diamond))
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
            RiskPreviewFacet(address(diamond))
                .previewOfferAcceptBlock(offerId, borrower),
            2,
            "creator-side illiquid gap => hard 2 (acceptor ack can't heal it)"
        );
    }

    // #735 item 3 — `acceptMidTierAckPair` resolves the EXACT pair an accept gates
    // against, so the dapp records a strict-mode mid-tier acknowledgement for the
    // right pair. For a NORMAL offer that is the offer's own pair. (The sale-vehicle
    // branch — where it must return the SOLD LOAN's pair, not the offer's surface —
    // is asserted in EarlyWithdrawalFacetTest alongside the sale-buyer preview test,
    // which already has the linked-loan harness.)
    function test_acceptMidTierAckPair_normalOfferReturnsOfferPair() public {
        _mockTier(mockERC20, 3);
        _mockTier(mockIlliquidERC20, 0);
        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);

        LibRiskAccess.PairId memory got =
            RiskPreviewFacet(address(diamond)).acceptMidTierAckPair(offerId);
        LibRiskAccess.PairId memory want = _offerPair(mockERC20, mockIlliquidERC20);
        assertEq(got.lendAsset, want.lendAsset, "lendAsset");
        assertEq(uint8(got.lendType), uint8(want.lendType), "lendType");
        assertEq(got.lendTokenId, want.lendTokenId, "lendTokenId");
        assertEq(got.collAsset, want.collAsset, "collAsset");
        assertEq(uint8(got.collType), uint8(want.collType), "collType");
        assertEq(got.collTokenId, want.collTokenId, "collTokenId");
        assertEq(got.prepayAsset, want.prepayAsset, "prepayAsset");
    }

    // #735 item 3 — `previewCreatorBlock` surfaces the block code the OFFER CREATOR
    // faces for their own posted offer (so the dapp can offer an in-flow ack / tier
    // prompt). Same codes as the accept preview; gate-off and the sale-vehicle
    // seller-exemption return 0 (the latter is asserted in EarlyWithdrawalFacetTest
    // alongside the sale harness).
    function test_previewCreatorBlock_surfacesCreatorGate() public {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockIlliquidERC20, 0); // coll leg illiquid => IlliquidCustom
        uint256 offerId = _lenderOffer(mockERC20, mockIlliquidERC20);

        // Gate OFF (default) => 0.
        assertEq(
            RiskPreviewFacet(address(diamond)).previewCreatorBlock(offerId),
            0,
            "gate off => 0"
        );

        // Gate ON, creator (lender) still BlueChipOnly, pair IlliquidCustom => the
        // creator is under-tiered (code 1).
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        assertEq(
            RiskPreviewFacet(address(diamond)).previewCreatorBlock(offerId),
            1,
            "creator under-tiered => 1 (tier too low)"
        );

        // Arm the creator (tier + standing consent) => clears to 0.
        _armCreatorIlliquid(mockERC20, mockIlliquidERC20);
        assertEq(
            RiskPreviewFacet(address(diamond)).previewCreatorBlock(offerId),
            0,
            "armed creator => 0"
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
