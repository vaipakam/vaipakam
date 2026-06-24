// test/RiskAccessFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibRiskAccess} from "../src/libraries/LibRiskAccess.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";

/**
 * @title RiskAccessFacetTest
 * @notice #671 — exercises the self-sovereign progressive risk-access facet
 *         ({RiskAccessFacet}) and the {LibRiskAccess} classification + gate
 *         logic. Mirrors the SetupTest idioms used by `AcceptTermBindingTest`
 *         (EIP-712 sign + relay, `lender`/`borrower` + their PKs) and the
 *         `vm.mockCall` tier-forcing idiom from `DepthTieredLtv`.
 *
 *         The asset classification path runs through
 *         `IRiskAccessOracle(address(this)).getEffectiveLiquidityTier(asset)`
 *         (routed through the diamond), so every classification test forces an
 *         asset's effective tier with `vm.mockCall` on that selector — exactly
 *         the deterministic-tier idiom `DepthTieredLtv` uses, but on the
 *         effective (keeper-min) tier the gate consults.
 *
 *         Levels (LibVaipakam.RiskAccessLevel): 0 = BlueChipOnly (default),
 *         1 = BroadLiquid, 2 = IlliquidCustom. Asset types
 *         (LibVaipakam.AssetType): 0 = ERC20, 1 = ERC721, 2 = ERC1155.
 */
contract RiskAccessFacetTest is SetupTest {
    // Convenience tier ordinals for readability in assertions / calls.
    uint8 constant BLUECHIP = uint8(LibVaipakam.RiskAccessLevel.BlueChipOnly);
    uint8 constant BROAD = uint8(LibVaipakam.RiskAccessLevel.BroadLiquid);
    uint8 constant ILLIQUID = uint8(LibVaipakam.RiskAccessLevel.IlliquidCustom);

    uint8 constant T_ERC20 = uint8(LibVaipakam.AssetType.ERC20);
    uint8 constant T_ERC721 = uint8(LibVaipakam.AssetType.ERC721);

    address relayer;
    address newVault; // a fresh, non-actor address used for protocol-managed tests
    address blueChipPaa; // an asset configured into the PAA basket
    address tier1Asset; // an asset whose effective liquidity tier is forced to 1
    address tier0Asset; // an asset whose effective liquidity tier is forced to 0
    address tier3Asset; // an asset whose effective liquidity tier is forced to 3
    address prepayTok; // a non-zero prepay token used for the NFT-rental leg

    function setUp() public {
        setupHelper();
        relayer = makeAddr("relayer");
        newVault = makeAddr("newVault");
        blueChipPaa = makeAddr("blueChipPaa");
        tier1Asset = makeAddr("tier1Asset");
        tier0Asset = makeAddr("tier0Asset");
        tier3Asset = makeAddr("tier3Asset");
        prepayTok = makeAddr("prepayTok");

        // Default block.timestamp of 1 can make `riskTierUnlockAt == now`
        // ambiguous in cooldown math; warp to a comfortable baseline.
        vm.warp(1_000_000);
    }

    // ─── Tier-forcing helper (mirrors DepthTieredLtv's mockCall idiom) ────────

    /// @dev Force `getEffectiveLiquidityTier(asset) == tier` for the gate's
    ///      classification path (it calls this selector via `address(this)`).
    function _mockTier(address asset, uint8 tier) internal {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector, asset
            ),
            abi.encode(tier)
        );
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

    function _tierDigest(LibRiskAccess.SetVaultRiskTier memory m)
        internal
        view
        returns (bytes32)
    {
        return _digest(
            keccak256(
                abi.encode(
                    LibRiskAccess.SET_VAULT_RISK_TIER_TYPEHASH,
                    m.vault,
                    m.level,
                    m.nonce,
                    m.deadline
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
    // DIRECT SETTERS
    // ════════════════════════════════════════════════════════════════════════

    function test_directSetTier_storesAndIsEffective() public {
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);
        assertEq(
            RiskAccessFacet(address(diamond)).getVaultRiskTier(lender),
            BROAD,
            "raw tier"
        );
        // Cooldown defaults to 0 => opt-up is immediately effective, and the
        // version anchor was re-stamped fresh by the setter.
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            BROAD,
            "effective tier"
        );
    }

    function test_directSetTier_revertsOnInvalidLevel() public {
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskAccessFacet.InvalidRiskLevel.selector, uint8(3)
            )
        );
        RiskAccessFacet(address(diamond)).setVaultRiskTier(3);
    }

    function test_directIlliquidConsent_grantThenRevoke() public {
        // Grant.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            mockERC20, mockCollateralERC20, address(0), true
        );
        assertTrue(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(
                lender, mockERC20, mockCollateralERC20, address(0)
            ),
            "consent granted"
        );
        // Revoke.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            mockERC20, mockCollateralERC20, address(0), false
        );
        assertFalse(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(
                lender, mockERC20, mockCollateralERC20, address(0)
            ),
            "consent revoked"
        );
    }

    function test_directMidTierAck_grantThenRevoke() public {
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setMidTierPairAck(
            mockERC20, mockCollateralERC20, address(0), true
        );
        assertTrue(
            RiskAccessFacet(address(diamond)).hasMidTierPairAck(
                lender, mockERC20, mockCollateralERC20, address(0)
            ),
            "ack granted"
        );
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setMidTierPairAck(
            mockERC20, mockCollateralERC20, address(0), false
        );
        assertFalse(
            RiskAccessFacet(address(diamond)).hasMidTierPairAck(
                lender, mockERC20, mockCollateralERC20, address(0)
            ),
            "ack revoked"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // SIGNED RELAY (EIP-712 self-submit forwarded by a relayer)
    // ════════════════════════════════════════════════════════════════════════

    function test_signedSetTier_relayerSubmitsAppliesToSigner() public {
        LibRiskAccess.SetVaultRiskTier memory m = LibRiskAccess.SetVaultRiskTier({
            vault: lender,
            level: BROAD,
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig = _sign(lenderPk, _tierDigest(m));

        // Submitted by a DIFFERENT address (the relayer pays gas).
        vm.prank(relayer);
        RiskAccessFacet(address(diamond)).setVaultRiskTierBySig(m, sig);

        assertEq(
            RiskAccessFacet(address(diamond)).getVaultRiskTier(lender),
            BROAD,
            "change applied to signer's vault"
        );
        assertTrue(
            RiskAccessFacet(address(diamond)).riskAccessNonceUsed(lender, 1),
            "nonce marked used"
        );
    }

    function test_signedSetTier_replayRevertsNonceUsed() public {
        LibRiskAccess.SetVaultRiskTier memory m = LibRiskAccess.SetVaultRiskTier({
            vault: lender,
            level: BROAD,
            nonce: 7,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig = _sign(lenderPk, _tierDigest(m));

        vm.prank(relayer);
        RiskAccessFacet(address(diamond)).setVaultRiskTierBySig(m, sig);

        // Replaying the exact same (m, sig) — nonce already consumed.
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskAccessFacet.RiskNonceUsed.selector, lender, uint256(7)
            )
        );
        RiskAccessFacet(address(diamond)).setVaultRiskTierBySig(m, sig);
    }

    function test_signedSetTier_pastDeadlineReverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        LibRiskAccess.SetVaultRiskTier memory m = LibRiskAccess.SetVaultRiskTier({
            vault: lender,
            level: BROAD,
            nonce: 2,
            deadline: deadline
        });
        bytes memory sig = _sign(lenderPk, _tierDigest(m));

        vm.warp(deadline + 1);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskAccessFacet.RiskSigExpired.selector, deadline
            )
        );
        RiskAccessFacet(address(diamond)).setVaultRiskTierBySig(m, sig);
    }

    function test_signedSetTier_wrongSignerReverts() public {
        LibRiskAccess.SetVaultRiskTier memory m = LibRiskAccess.SetVaultRiskTier({
            vault: lender,
            level: BROAD,
            nonce: 3,
            deadline: block.timestamp + 1 hours
        });
        // Signed by the BORROWER's key over a message that names `lender` as the
        // vault => recovered signer != m.vault => bad signature.
        bytes memory sig = _sign(borrowerPk, _tierDigest(m));

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskAccessFacet.RiskBadSignature.selector, lender
            )
        );
        RiskAccessFacet(address(diamond)).setVaultRiskTierBySig(m, sig);
    }

    // ════════════════════════════════════════════════════════════════════════
    // CLASSIFICATION (pairRequiredRiskLevel)
    // ════════════════════════════════════════════════════════════════════════

    function test_classify_wethIsBlueChip() public {
        // WETH is blue-chip via the `asset == wethContract` clause even at
        // effective tier 0. `setWethContract` is owner-only — the test contract
        // IS the diamond owner (SetupTest: `owner = address(this)`).
        address weth = makeAddr("wethCanonical");
        OracleAdminFacet(address(diamond)).setWethContract(weth);
        _mockTier(weth, 0); // tier 0, yet still blue-chip by the WETH clause

        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            weth, T_ERC20, weth, T_ERC20, address(0)
        );
        assertEq(required, BLUECHIP, "WETH/WETH => BlueChipOnly");
    }

    function test_classify_paaAssetIsBlueChip() public {
        // Configure the PAA basket to include `blueChipPaa`. `setPaaAssets`
        // validates non-zero entries and rejects WETH duplicates implicitly;
        // a plain address is fine. ADMIN_ROLE — owner (test contract) holds it.
        address[] memory paa = new address[](1);
        paa[0] = blueChipPaa;
        ConfigFacet(address(diamond)).setPaaAssets(paa);
        _mockTier(blueChipPaa, 0); // tier 0, blue-chip purely via the PAA clause

        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            blueChipPaa, T_ERC20, blueChipPaa, T_ERC20, address(0)
        );
        assertEq(required, BLUECHIP, "PAA asset => BlueChipOnly");
    }

    function test_classify_tier3IsBlueChip() public {
        _mockTier(tier3Asset, 3);
        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            tier3Asset, T_ERC20, tier3Asset, T_ERC20, address(0)
        );
        assertEq(required, BLUECHIP, "effective tier 3 => BlueChipOnly");
    }

    function test_classify_tier1RequiresBroadLiquid() public {
        _mockTier(tier1Asset, 1);
        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            tier1Asset, T_ERC20, tier1Asset, T_ERC20, address(0)
        );
        assertEq(required, BROAD, "tier 1 => BroadLiquid");
    }

    function test_classify_tier0NonNumeraireRequiresIlliquidCustom() public {
        _mockTier(tier0Asset, 0); // tier 0, not WETH, not PAA => illiquid
        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            tier0Asset, T_ERC20, tier0Asset, T_ERC20, address(0)
        );
        assertEq(required, ILLIQUID, "tier 0 non-numeraire => IlliquidCustom");
    }

    function test_classify_riskierLegGoverns() public {
        // One blue-chip leg (tier 3) + one illiquid leg (tier 0) => the riskier
        // (IlliquidCustom) governs the pair.
        _mockTier(tier3Asset, 3);
        _mockTier(tier0Asset, 0);
        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            tier3Asset, T_ERC20, tier0Asset, T_ERC20, address(0)
        );
        assertEq(required, ILLIQUID, "riskier leg governs");
    }

    function test_classify_nftRentalLegTiersOffPrepayToken() public {
        // An ERC721 leg WITH a non-zero prepayAsset classifies off the prepay
        // token, NOT the NFT. Force the prepay token to tier 1 => the NFT leg
        // contributes BroadLiquid (not IlliquidCustom as a bare NFT would).
        _mockTier(prepayTok, 1);
        // Pair the NFT (as the collateral leg) against a blue-chip lend leg so
        // the prepay-substituted NFT leg is the governing one.
        _mockTier(tier3Asset, 3);
        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            tier3Asset, T_ERC20, mockNft721, T_ERC721, prepayTok
        );
        assertEq(required, BROAD, "NFT-rental leg classifies off prepay token");
    }

    function test_classify_bareNftLegRequiresIlliquidCustom() public {
        // An ERC721 leg with ZERO prepayAsset keeps the NFT leg => tier 0 =>
        // IlliquidCustom (sanity counterpart to the prepay-substitution case).
        _mockTier(mockNft721, 0);
        _mockTier(tier3Asset, 3);
        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            tier3Asset, T_ERC20, mockNft721, T_ERC721, address(0)
        );
        assertEq(required, ILLIQUID, "bare NFT leg => IlliquidCustom");
    }

    // ════════════════════════════════════════════════════════════════════════
    // READ-TIME RE-LOCK (version bump invalidates a stale opt-up)
    // ════════════════════════════════════════════════════════════════════════

    function test_readTimeRelock_versionBumpStalesHeldTier() public {
        // Opt up to IlliquidCustom — immediately effective (cooldown 0).
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            ILLIQUID,
            "fresh opt-up effective"
        );

        // Governance bumps the terms version — every held tier whose anchor is
        // now stale re-locks to BlueChipOnly with ZERO per-user writes.
        RiskAccessFacet(address(diamond)).bumpRiskTermsVersion();
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            BLUECHIP,
            "stale anchor => re-locked"
        );
        // Raw held tier is unchanged — only the effective read re-locks.
        assertEq(
            RiskAccessFacet(address(diamond)).getVaultRiskTier(lender),
            ILLIQUID,
            "raw tier unchanged"
        );

        // Re-affirming the tier re-stamps the anchor to the live version.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            ILLIQUID,
            "re-affirmed => fresh again"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // COOLDOWN (opt-up delayed; tightening immediate)
    // ════════════════════════════════════════════════════════════════════════

    function test_cooldown_optUpDelayedThenEffective() public {
        RiskAccessFacet(address(diamond)).setRiskAccessUnlockCooldown(
            uint64(1 days)
        );
        assertEq(
            RiskAccessFacet(address(diamond)).getRiskAccessUnlockCooldown(),
            uint64(1 days),
            "cooldown set"
        );

        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        // Within the cooldown window => not yet effective.
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            BLUECHIP,
            "opt-up not yet cooled"
        );

        uint64 unlockAt =
            RiskAccessFacet(address(diamond)).getRiskTierUnlockAt(lender);
        vm.warp(unlockAt);
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            ILLIQUID,
            "effective once cooled"
        );
    }

    function test_cooldown_tighteningIsImmediate() public {
        RiskAccessFacet(address(diamond)).setRiskAccessUnlockCooldown(
            uint64(1 days)
        );
        // Reach IlliquidCustom (after warping past its cooldown).
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        vm.warp(RiskAccessFacet(address(diamond)).getRiskTierUnlockAt(lender));
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            ILLIQUID,
            "at IlliquidCustom"
        );

        // Tighten DOWN to BroadLiquid — immediate, no cooldown wait.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            BROAD,
            "tightening is immediate"
        );
    }

    function test_cooldown_rejectsTooLong() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskAccessFacet.RiskCooldownTooLong.selector,
                uint64(31 days),
                uint64(30 days)
            )
        );
        RiskAccessFacet(address(diamond)).setRiskAccessUnlockCooldown(
            uint64(31 days)
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // PROTOCOL-MANAGED VAULT (raw tier reported, bypasses freshness/cooldown)
    // ════════════════════════════════════════════════════════════════════════

    function test_protocolManagedVault_reportsRawTierAfterVersionBump() public {
        // Mark `newVault` protocol-managed, then opt it up via a direct call
        // from that vault address.
        RiskAccessFacet(address(diamond)).setProtocolManagedVault(newVault, true);
        assertTrue(
            RiskAccessFacet(address(diamond)).isProtocolManagedVault(newVault),
            "flagged managed"
        );

        vm.prank(newVault);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(newVault),
            ILLIQUID,
            "raw tier effective"
        );

        // A version bump would re-lock an ordinary vault — but a protocol-
        // managed vault reports its raw held tier unconditionally.
        RiskAccessFacet(address(diamond)).bumpRiskTermsVersion();
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(newVault),
            ILLIQUID,
            "managed vault unaffected by version bump"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN ACCESS-CONTROL (non-admin reverts; gate setter is admin-only)
    // ════════════════════════════════════════════════════════════════════════

    function test_adminOnly_bumpRiskTermsVersion() public {
        vm.prank(relayer);
        vm.expectRevert();
        RiskAccessFacet(address(diamond)).bumpRiskTermsVersion();
    }

    function test_adminOnly_setRiskAccessUnlockCooldown() public {
        vm.prank(relayer);
        vm.expectRevert();
        RiskAccessFacet(address(diamond)).setRiskAccessUnlockCooldown(
            uint64(1 hours)
        );
    }

    function test_adminOnly_setProtocolManagedVault() public {
        vm.prank(relayer);
        vm.expectRevert();
        RiskAccessFacet(address(diamond)).setProtocolManagedVault(newVault, true);
    }

    function test_adminOnly_setRiskAccessGateEnabled() public {
        vm.prank(relayer);
        vm.expectRevert();
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
    }

    function test_bumpRiskTermsVersion_incrementsAndReturns() public {
        uint64 before = RiskAccessFacet(address(diamond))
            .getCurrentRiskTermsVersion();
        uint64 next = RiskAccessFacet(address(diamond)).bumpRiskTermsVersion();
        assertEq(next, before + 1, "returns incremented version");
        assertEq(
            RiskAccessFacet(address(diamond)).getCurrentRiskTermsVersion(),
            before + 1,
            "view reflects bump"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // CREATE-GATE INTEGRATION (mirrors AcceptTermBindingTest's create path)
    // ════════════════════════════════════════════════════════════════════════

    /// @dev Build a single-value ERC-20 Lender offer (creator consents) on the
    ///      given legs, mirroring AcceptTermBindingTest._lenderOffer. The lend
    ///      leg uses `mockERC20` (the lender is pre-funded + approved in
    ///      SetupTest); only the collateral leg varies to drive classification.
    function _createLenderOffer(address lendAsset, address collAsset)
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

    function test_createGate_offNoOpAllowsBlueChipOnlyCreator() public {
        // Gate defaults OFF — a BlueChipOnly (default) lender CAN create an
        // offer whose collateral is a forced tier-0 (illiquid) asset; the gate
        // is a no-op. Force both legs deterministically so the classification
        // can't depend on the real oracle.
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockCollateralERC20, 0); // coll leg illiquid

        assertFalse(
            ConfigFacet(address(diamond)).getRiskAccessGateEnabled(),
            "gate off by default"
        );
        uint256 offerId =
            _createLenderOffer(mockERC20, mockCollateralERC20);
        assertGt(offerId, 0, "offer created with gate off");
    }

    function test_createGate_onRevertsForUnderTieredCreator() public {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockCollateralERC20, 0); // coll leg illiquid => IlliquidCustom

        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);

        // Lender is at BlueChipOnly (default) but the pair requires
        // IlliquidCustom => RiskTierTooLow.
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.RiskTierTooLow.selector,
                lender,
                ILLIQUID,
                BLUECHIP
            )
        );
        OfferCreateFacet(address(diamond)).createOffer(
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

    function test_createGate_onSucceedsAfterOptUpAndConsent() public {
        _mockTier(mockERC20, 3); // lend leg blue-chip
        _mockTier(mockCollateralERC20, 0); // coll leg illiquid => IlliquidCustom

        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);

        // Creator opts UP to IlliquidCustom (cooldown 0 => immediate) AND records
        // the per-pair illiquid consent the boundary tier requires. The
        // consent's pairKey is (lendAsset, collAsset, prepayAsset) — the create
        // path passes `params.prepayAsset` (= mockERC20 in `_createLenderOffer`).
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            mockERC20, mockCollateralERC20, mockERC20, true
        );

        uint256 offerId =
            _createLenderOffer(mockERC20, mockCollateralERC20);
        assertGt(offerId, 0, "offer created after opt-up + consent");
    }

    // NOTE: sale-vehicle exemption covered separately (needs an active loan).
}
