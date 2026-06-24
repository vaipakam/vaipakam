// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibRiskAccess} from "../src/libraries/LibRiskAccess.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";

/**
 * @title RiskStrictModeTest
 * @notice #671 phase-2 / PR-2d — RD-1 opt-in STRICT MODE. A vault that calls
 *         `setRiskStrictMode(true)` must hold a fresh EXPLICIT per-pair ack
 *         (`setMidTierPairAck`) for every MID-TIER (BroadLiquid) pair it
 *         originates, not just illiquid ones — this is what makes the flag do
 *         something. Default-off: a normal vault never sees the requirement.
 *
 *         Enforcement lives in `LibRiskAccess.assertActorMayTransact` (shared by
 *         the create / match / obligation gates) + `assertAcceptorMayTransact`
 *         (accept) — exercised here through the CREATE chokepoint
 *         (`OfferCreateFacet` gates the creator). The explicit ack is keyed +
 *         version-anchored exactly like the illiquid consent, so a terms bump
 *         re-locks it; turning strict mode OFF stamps a disable-cooldown anchor
 *         so the requirement lingers (closing the disable→exploit window).
 *
 *         Tier forcing uses the `_mockTier` idiom (mirrors RiskAccessAcceptGateTest);
 *         a BroadLiquid pair (both legs tier 1) is the subject. Offers under test
 *         are created with the gate already ON so the create-time creator gate
 *         (which is where strict mode is enforced) actually runs.
 */
contract RiskStrictModeTest is SetupTest {
    uint8 constant BROAD = uint8(LibVaipakam.RiskAccessLevel.BroadLiquid);

    function setUp() public {
        setupHelper();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _mockTier(address asset, uint8 tier) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector, asset
            ),
            abi.encode(tier)
        );
    }

    /// @dev The PairId exactly as `OfferCreateFacet` builds it from the lender
    ///      offer below (both legs ERC-20, prepay == mockERC20).
    function _pair() internal view returns (LibRiskAccess.PairId memory) {
        return LibRiskAccess.PairId({
            lendAsset: mockERC20,
            lendType: LibVaipakam.AssetType.ERC20,
            lendTokenId: 0,
            collAsset: mockCollateralERC20,
            collType: LibVaipakam.AssetType.ERC20,
            collTokenId: 0,
            prepayAsset: mockERC20
        });
    }

    /// @dev `lender` creates a single-value BroadLiquid lender offer. Caller wraps
    ///      with `vm.expectRevert` for the blocked cases.
    function _createOffer() internal returns (uint256 offerId) {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
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

    /// @dev Gate ON + arm `lender` to BroadLiquid so only the strict-mode mid-tier
    ///      check is left to vary. Both legs mocked tier 1 (BroadLiquid pair).
    function _armBroadLiquidGate() internal {
        _mockTier(mockERC20, 1);
        _mockTier(mockCollateralERC20, 1);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);
    }

    // ─── EIP-712 digest builders (replicate LibRiskAccess field order) ────────

    bytes32 constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256("Vaipakam RiskAccess"),
                keccak256("1"),
                block.chainid,
                address(diamond)
            )
        );
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", _domainSeparator(), structHash)
        );
    }

    function _strictDigest(LibRiskAccess.SetRiskStrictMode memory m)
        internal
        view
        returns (bytes32)
    {
        return _digest(
            keccak256(
                abi.encode(
                    LibRiskAccess.SET_RISK_STRICT_MODE_TYPEHASH,
                    m.vault, m.enabled, m.termsVersion, m.nonce, m.deadline
                )
            )
        );
    }

    function _ackDigest(LibRiskAccess.SetMidTierPairAck memory m)
        internal
        view
        returns (bytes32)
    {
        return _digest(
            keccak256(
                bytes.concat(
                    abi.encode(
                        LibRiskAccess.SET_MID_TIER_PAIR_ACK_TYPEHASH,
                        m.vault, m.lendAsset, m.lendAssetType, m.lendTokenId,
                        m.collAsset, m.collAssetType, m.collTokenId, m.prepayAsset
                    ),
                    abi.encode(m.termsVersion, m.nonce, m.deadline)
                )
            )
        );
    }

    function _sign(uint256 pk, bytes32 digest)
        internal
        pure
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 1 — strict mode OFF (default): a BroadLiquid create needs NO per-pair ack.
    // ════════════════════════════════════════════════════════════════════════

    function test_strictOff_midTierCreateNeedsNoAck() public {
        _armBroadLiquidGate();
        assertFalse(
            RiskAccessFacet(address(diamond)).getRiskStrictMode(lender),
            "strict off by default"
        );
        uint256 offerId = _createOffer();
        assertGt(offerId, 0, "mid-tier create succeeds without strict mode");
    }

    // ════════════════════════════════════════════════════════════════════════
    // 2 — strict mode ON, no explicit ack → the create gate reverts
    //     MidTierPairNotAcknowledged. This is what makes the flag enforce.
    // ════════════════════════════════════════════════════════════════════════

    function test_strictOn_midTierCreateRevertsWithoutAck() public {
        _armBroadLiquidGate();
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setRiskStrictMode(true);

        // The view agrees the origination would be blocked.
        assertTrue(
            RiskAccessFacet(address(diamond)).midTierStrictBlocked(lender, _pair()),
            "view reports the strict mid-tier block"
        );

        bytes32 pk = LibRiskAccess.pairKey(_pair());
        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.MidTierPairNotAcknowledged.selector, lender, pk
            )
        );
        _createOffer();
    }

    // ════════════════════════════════════════════════════════════════════════
    // 3 — strict mode ON + explicit ack → create succeeds; view clears.
    // ════════════════════════════════════════════════════════════════════════

    function test_strictOn_midTierCreateSucceedsWithAck() public {
        _armBroadLiquidGate();
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setRiskStrictMode(true);
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setMidTierPairAck(_pair());

        assertFalse(
            RiskAccessFacet(address(diamond)).midTierStrictBlocked(lender, _pair()),
            "ack clears the strict mid-tier block"
        );
        uint256 offerId = _createOffer();
        assertGt(offerId, 0, "mid-tier create succeeds once acked");
    }

    // ════════════════════════════════════════════════════════════════════════
    // 4 — a terms-version bump re-locks the explicit ack (read-time re-lock),
    //     so the create reverts again until the vault re-acks.
    // ════════════════════════════════════════════════════════════════════════

    function test_strictOn_termsBumpRelocksAck() public {
        _armBroadLiquidGate();
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setRiskStrictMode(true);
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setMidTierPairAck(_pair());

        // Governance bumps the terms version → the ack's anchor is now stale.
        vm.prank(owner);
        RiskAccessFacet(address(diamond)).bumpRiskTermsVersion();

        // But the tier anchor is ALSO stale now, so re-arm the tier first to
        // isolate the ack staleness (otherwise it would revert RiskTierTooLow).
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);

        bytes32 pk = LibRiskAccess.pairKey(_pair());
        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.MidTierPairNotAcknowledged.selector, lender, pk
            )
        );
        _createOffer();

        // Re-acking at the new version restores access.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setMidTierPairAck(_pair());
        assertGt(_createOffer(), 0, "re-ack at the new terms version restores access");
    }

    // ════════════════════════════════════════════════════════════════════════
    // 5 — disable-cooldown: with a non-zero cooldown, turning strict mode OFF
    //     leaves the mid-tier ack requirement in force until the cooldown elapses
    //     (closes the disable→exploit window). After it elapses, the requirement
    //     drops.
    // ════════════════════════════════════════════════════════════════════════

    function test_strictDisable_cooldownLingersThenClears() public {
        _mockTier(mockERC20, 1);
        _mockTier(mockCollateralERC20, 1);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        // Arm the tier FIRST under the default (zero) cooldown so it is effective
        // immediately — no warp needed. Only THEN set a non-zero cooldown for the
        // strict-mode disable, so the whole test needs a SINGLE warp (this harness
        // doesn't accumulate `block.timestamp` across multiple `vm.warp`s cleanly).
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);
        vm.prank(owner);
        RiskAccessFacet(address(diamond)).setRiskAccessUnlockCooldown(1 days);

        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setRiskStrictMode(true);
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setRiskStrictMode(false); // stamps anchor

        // Strict flag is OFF but the disable-cooldown still treats it as strict —
        // the gate's mid-tier ack requirement lingers. Asserted via the
        // non-reverting view (the create-revert itself is covered by test 2).
        assertTrue(
            RiskAccessFacet(address(diamond)).midTierStrictBlocked(lender, _pair()),
            "disable-cooldown keeps the mid-tier ack required"
        );

        // After the cooldown elapses, the requirement drops and a mid-tier create
        // succeeds again without any ack. (Single warp — see note above.)
        vm.warp(block.timestamp + 1 days + 1);
        assertFalse(
            RiskAccessFacet(address(diamond)).midTierStrictBlocked(lender, _pair()),
            "requirement clears once the disable-cooldown elapses"
        );
        assertGt(_createOffer(), 0, "create succeeds after the disable-cooldown");
    }

    // ════════════════════════════════════════════════════════════════════════
    // 6 — the relayed (EIP-712 *BySig) setters work: a relayer submits the
    //     vault's signed strict-mode toggle + mid-tier ack, then the create
    //     succeeds. Proves the typehashes / digests are correct.
    // ════════════════════════════════════════════════════════════════════════

    function test_strictMode_bySigPaths() public {
        _armBroadLiquidGate();
        uint64 ver =
            RiskAccessFacet(address(diamond)).getCurrentRiskTermsVersion();

        // Relayer enables strict mode on the lender's behalf.
        LibRiskAccess.SetRiskStrictMode memory sm = LibRiskAccess.SetRiskStrictMode({
            vault: lender, enabled: true, termsVersion: ver, nonce: 1,
            deadline: block.timestamp + 1 hours
        });
        vm.prank(makeAddr("relayer"));
        RiskAccessFacet(address(diamond)).setRiskStrictModeBySig(
            sm, _sign(lenderPk, _strictDigest(sm))
        );
        assertTrue(RiskAccessFacet(address(diamond)).getRiskStrictMode(lender));

        // Without the ack the create is blocked.
        bytes32 pk = LibRiskAccess.pairKey(_pair());
        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.MidTierPairNotAcknowledged.selector, lender, pk
            )
        );
        _createOffer();

        // Relayer submits the lender's signed mid-tier ack.
        LibRiskAccess.SetMidTierPairAck memory am = LibRiskAccess.SetMidTierPairAck({
            vault: lender,
            lendAsset: mockERC20,
            lendAssetType: uint8(LibVaipakam.AssetType.ERC20),
            lendTokenId: 0,
            collAsset: mockCollateralERC20,
            collAssetType: uint8(LibVaipakam.AssetType.ERC20),
            collTokenId: 0,
            prepayAsset: mockERC20,
            termsVersion: ver,
            nonce: 2,
            deadline: block.timestamp + 1 hours
        });
        vm.prank(makeAddr("relayer"));
        RiskAccessFacet(address(diamond)).setMidTierPairAckBySig(
            am, _sign(lenderPk, _ackDigest(am))
        );

        assertGt(_createOffer(), 0, "relayed strict toggle + ack unblock the create");
    }

    // ════════════════════════════════════════════════════════════════════════
    // 7 — Codex #733 P1: a mid-tier ack is ARMED on a cooldown — with a non-zero
    //     `riskAccessUnlockCooldown` it is NOT effective until the cooldown
    //     elapses (no atomic sign-and-use), mirroring the illiquid consent.
    // ════════════════════════════════════════════════════════════════════════

    function test_strictOn_midTierAckArmingCooldown() public {
        _mockTier(mockERC20, 1);
        _mockTier(mockCollateralERC20, 1);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        // Arm the tier under zero cooldown (immediate), then set the cooldown so
        // only the ACK arming is exercised — single warp (harness note in test 5).
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);
        vm.prank(owner);
        RiskAccessFacet(address(diamond)).setRiskAccessUnlockCooldown(1 days);
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setRiskStrictMode(true);

        // Ack the pair — but it is armed only after the cooldown, so it does NOT
        // satisfy the gate yet.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setMidTierPairAck(_pair());
        assertTrue(
            RiskAccessFacet(address(diamond)).midTierStrictBlocked(lender, _pair()),
            "fresh ack is not yet armed (cooldown not elapsed)"
        );

        // After the arming cooldown, the ack is effective.
        vm.warp(block.timestamp + 1 days + 1);
        assertFalse(
            RiskAccessFacet(address(diamond)).midTierStrictBlocked(lender, _pair()),
            "ack effective once its arming cooldown elapses"
        );
        assertGt(_createOffer(), 0, "create succeeds once the ack is armed");
    }

    // ════════════════════════════════════════════════════════════════════════
    // 8 — Codex #733 P3: the strict-block view honors the master gate — it
    //     reports no block when `riskAccessGateEnabled` is off (the gate isn't
    //     enforced then), so the frontend doesn't show a phantom requirement.
    // ════════════════════════════════════════════════════════════════════════

    function test_midTierStrictBlocked_falseWhenGateOff() public {
        _mockTier(mockERC20, 1);
        _mockTier(mockCollateralERC20, 1);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setRiskStrictMode(true);

        // Gate ON, strict, no ack → blocked.
        assertTrue(
            RiskAccessFacet(address(diamond)).midTierStrictBlocked(lender, _pair()),
            "blocked while the master gate is on"
        );

        // Flip the master gate off → the view reports no block (gate not enforced).
        vm.prank(owner);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(false);
        assertFalse(
            RiskAccessFacet(address(diamond)).midTierStrictBlocked(lender, _pair()),
            "no phantom block when the master gate is off"
        );
    }
}
