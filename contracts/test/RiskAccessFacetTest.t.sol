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
 *
 *         Codex #727 r1 update: the facet's pair API now takes a single
 *         `LibRiskAccess.PairId` (carries asset TYPES + TOKEN IDS so a consent
 *         binds to the exact NFT, not the whole collection), and every signed
 *         struct carries a `termsVersion` field bound into the EIP-712 digest.
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

    // ─── PairId construction helpers (reduce duplication) ─────────────────────

    /// @dev Full PairId constructor.
    function _pair(
        address lendAsset,
        uint8 lendType,
        uint256 lendTokenId,
        address collAsset,
        uint8 collType,
        uint256 collTokenId,
        address prepayAsset
    ) internal pure returns (LibRiskAccess.PairId memory) {
        return LibRiskAccess.PairId({
            lendAsset: lendAsset,
            lendType: LibVaipakam.AssetType(lendType),
            lendTokenId: lendTokenId,
            collAsset: collAsset,
            collType: LibVaipakam.AssetType(collType),
            collTokenId: collTokenId,
            prepayAsset: prepayAsset
        });
    }

    /// @dev Common case: an ERC-20 lend / ERC-20 collateral pair, no prepay.
    function _erc20Pair(address lendAsset, address collAsset)
        internal
        pure
        returns (LibRiskAccess.PairId memory)
    {
        return
            _pair(lendAsset, T_ERC20, 0, collAsset, T_ERC20, 0, address(0));
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
        // SetVaultRiskTier digest — single abi.encode in struct order
        // (typehash, vault, level, termsVersion, nonce, deadline).
        return _digest(
            keccak256(
                abi.encode(
                    LibRiskAccess.SET_VAULT_RISK_TIER_TYPEHASH,
                    m.vault,
                    m.level,
                    m.termsVersion,
                    m.nonce,
                    m.deadline
                )
            )
        );
    }

    function _illiquidDigest(LibRiskAccess.SetIlliquidPairConsent memory m)
        internal
        view
        returns (bytes32)
    {
        // Chunked into two abi.encode()s joined by bytes.concat to mirror
        // LibRiskAccess.digest (viaIR ≤10-value-per-encode idiom). Chunk 1 =
        // typehash + 9 struct fields up to `consent` (10 values); chunk 2 =
        // termsVersion, nonce, deadline. All fields are static EIP-712 types,
        // so the concat is byte-identical to a single 13-value encode.
        return _digest(
            keccak256(
                bytes.concat(
                    abi.encode(
                        LibRiskAccess.SET_ILLIQUID_PAIR_CONSENT_TYPEHASH,
                        m.vault,
                        m.lendAsset,
                        m.lendAssetType,
                        m.lendTokenId,
                        m.collAsset,
                        m.collAssetType,
                        m.collTokenId,
                        m.prepayAsset,
                        m.consent
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

    /// @dev The live risk-terms version a fresh signature must bind to.
    function _currentVersion() internal view returns (uint64) {
        return RiskAccessFacet(address(diamond)).getCurrentRiskTermsVersion();
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
        LibRiskAccess.PairId memory p =
            _erc20Pair(mockERC20, mockCollateralERC20);
        // Grant.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(p, true);
        assertTrue(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(lender, p),
            "consent granted"
        );
        // Revoke.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(p, false);
        assertFalse(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(lender, p),
            "consent revoked"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // SIGNED RELAY (EIP-712 self-submit forwarded by a relayer)
    // ════════════════════════════════════════════════════════════════════════

    function test_signedSetTier_relayerSubmitsAppliesToSigner() public {
        LibRiskAccess.SetVaultRiskTier memory m = LibRiskAccess.SetVaultRiskTier({
            vault: lender,
            level: BROAD,
            termsVersion: _currentVersion(),
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
            termsVersion: _currentVersion(),
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
            termsVersion: _currentVersion(),
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
            termsVersion: _currentVersion(),
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
    // F1 — termsVersion binding (a stale-version signature is rejected)
    // ════════════════════════════════════════════════════════════════════════

    function test_signedSetTier_staleTermsVersionReverts() public {
        // Sign over termsVersion = 0 (the current version), then governance
        // bumps the terms version before the relayer submits — the bound
        // version no longer matches the live one => RiskTermsVersionStale.
        LibRiskAccess.SetVaultRiskTier memory m = LibRiskAccess.SetVaultRiskTier({
            vault: lender,
            level: BROAD,
            termsVersion: _currentVersion(), // 0
            nonce: 11,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig = _sign(lenderPk, _tierDigest(m));

        _bumpRiskTerms(keccak256("rt-2")); // now version 1

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskAccessFacet.RiskTermsVersionStale.selector,
                uint64(0),
                uint64(1)
            )
        );
        RiskAccessFacet(address(diamond)).setVaultRiskTierBySig(m, sig);
    }

    function test_signedIlliquidConsent_staleTermsVersionReverts() public {
        LibRiskAccess.SetIlliquidPairConsent memory m = LibRiskAccess
            .SetIlliquidPairConsent({
            vault: lender,
            lendAsset: mockERC20,
            lendAssetType: T_ERC20,
            lendTokenId: 0,
            collAsset: mockCollateralERC20,
            collAssetType: T_ERC20,
            collTokenId: 0,
            prepayAsset: address(0),
            consent: true,
            termsVersion: _currentVersion(), // 0
            nonce: 12,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig = _sign(lenderPk, _illiquidDigest(m));

        _bumpRiskTerms(keccak256("rt-3")); // now version 1

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskAccessFacet.RiskTermsVersionStale.selector,
                uint64(0),
                uint64(1)
            )
        );
        RiskAccessFacet(address(diamond)).setIlliquidPairConsentBySig(m, sig);
    }

    function test_signedIlliquidConsent_freshVersionApplies() public {
        // Positive path for the chunked illiquid-consent digest: a fresh-version
        // signature relays and the consent becomes effective (cooldown 0).
        LibRiskAccess.SetIlliquidPairConsent memory m = LibRiskAccess
            .SetIlliquidPairConsent({
            vault: lender,
            lendAsset: mockERC20,
            lendAssetType: T_ERC20,
            lendTokenId: 0,
            collAsset: mockCollateralERC20,
            collAssetType: T_ERC20,
            collTokenId: 0,
            prepayAsset: address(0),
            consent: true,
            termsVersion: _currentVersion(),
            nonce: 13,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig = _sign(lenderPk, _illiquidDigest(m));

        vm.prank(relayer);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsentBySig(m, sig);

        assertTrue(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(
                lender, _erc20Pair(mockERC20, mockCollateralERC20)
            ),
            "signed consent effective"
        );
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
            _erc20Pair(weth, weth)
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
            _erc20Pair(blueChipPaa, blueChipPaa)
        );
        assertEq(required, BLUECHIP, "PAA asset => BlueChipOnly");
    }

    function test_classify_tier3IsBlueChip() public {
        _mockTier(tier3Asset, 3);
        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            _erc20Pair(tier3Asset, tier3Asset)
        );
        assertEq(required, BLUECHIP, "effective tier 3 => BlueChipOnly");
    }

    function test_classify_tier1RequiresBroadLiquid() public {
        _mockTier(tier1Asset, 1);
        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            _erc20Pair(tier1Asset, tier1Asset)
        );
        assertEq(required, BROAD, "tier 1 => BroadLiquid");
    }

    function test_classify_tier0NonNumeraireRequiresIlliquidCustom() public {
        _mockTier(tier0Asset, 0); // tier 0, not WETH, not PAA => illiquid
        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            _erc20Pair(tier0Asset, tier0Asset)
        );
        assertEq(required, ILLIQUID, "tier 0 non-numeraire => IlliquidCustom");
    }

    function test_classify_riskierLegGoverns() public {
        // One blue-chip leg (tier 3) + one illiquid leg (tier 0) => the riskier
        // (IlliquidCustom) governs the pair.
        _mockTier(tier3Asset, 3);
        _mockTier(tier0Asset, 0);
        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            _erc20Pair(tier3Asset, tier0Asset)
        );
        assertEq(required, ILLIQUID, "riskier leg governs");
    }

    function test_classify_nftRentalLegTiersOffPrepayToken() public {
        // An ERC721 LEND leg WITH a non-zero prepayAsset classifies off the
        // prepay token, NOT the NFT. Force the prepay token to tier 1 => the NFT
        // lend leg contributes BroadLiquid (not IlliquidCustom as a bare NFT
        // would). Pair it against a blue-chip collateral leg so the
        // prepay-substituted lend leg is the governing one.
        _mockTier(prepayTok, 1);
        _mockTier(tier3Asset, 3);
        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            _pair(
                mockNft721, T_ERC721, 1, tier3Asset, T_ERC20, 0, prepayTok
            )
        );
        assertEq(required, BROAD, "NFT-rental lend leg classifies off prepay");
    }

    function test_classify_bareNftLegRequiresIlliquidCustom() public {
        // An ERC721 LEND leg with ZERO prepayAsset keeps the NFT leg => tier 0
        // => IlliquidCustom (sanity counterpart to the prepay-substitution case).
        _mockTier(mockNft721, 0);
        _mockTier(tier3Asset, 3);
        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            _pair(
                mockNft721, T_ERC721, 1, tier3Asset, T_ERC20, 0, address(0)
            )
        );
        assertEq(required, ILLIQUID, "bare NFT lend leg => IlliquidCustom");
    }

    function test_classify_nftLegForcedIlliquidEvenIfMockedDeep() public {
        // F3 (Codex #727 r4 P2): `_pairRequiredLevel` forces any NFT-typed leg
        // to IlliquidCustom by AssetType BEFORE consulting the oracle (except a
        // rental's NFT lending leg, which uses the prepay token). Even if the NFT
        // contract is mocked to return a deep tier 3, the AssetType wins.
        _mockTier(mockNft721, 3); // pretend the NFT contract reports a deep tier
        _mockTier(mockERC20, 3); // ERC-20 blue-chip lend leg

        // NFT as COLLATERAL (ERC-20 blue-chip lend) => IlliquidCustom.
        uint8 asCollateral = RiskAccessFacet(address(diamond))
            .pairRequiredRiskLevel(
            _pair(mockERC20, T_ERC20, 0, mockNft721, T_ERC721, 1, address(0))
        );
        assertEq(
            asCollateral,
            ILLIQUID,
            "NFT collateral forced IlliquidCustom despite deep mock"
        );

        // SAME NFT as a BARE lending leg (no prepay) => IlliquidCustom.
        uint8 asBareLend = RiskAccessFacet(address(diamond))
            .pairRequiredRiskLevel(
            _pair(mockNft721, T_ERC721, 1, mockERC20, T_ERC20, 0, address(0))
        );
        assertEq(
            asBareLend,
            ILLIQUID,
            "bare NFT lend leg forced IlliquidCustom despite deep mock"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // F5 — prepayAsset must NOT mask an NFT COLLATERAL leg
    // ════════════════════════════════════════════════════════════════════════

    function test_classify_prepayDoesNotMaskNftCollateral() public {
        // An ERC20-lent / ERC721-COLLATERAL pair with `prepayAsset` set to a
        // blue-chip token must STILL classify as IlliquidCustom: the prepay
        // substitution is confined to the LEND leg (Codex #727 r1 P1) — an NFT
        // used as collateral is genuine illiquid collateral and cannot be
        // masked by an attacker-chosen prepay.
        _mockTier(tier1Asset, 1); // liquid ERC20 lend leg
        _mockTier(mockNft721, 0); // NFT collateral => illiquid
        _mockTier(prepayTok, 3); // attacker-chosen blue-chip prepay (ignored)
        uint8 required = RiskAccessFacet(address(diamond)).pairRequiredRiskLevel(
            _pair(
                tier1Asset, T_ERC20, 0, mockNft721, T_ERC721, 1, prepayTok
            )
        );
        assertEq(
            required, ILLIQUID, "prepay cannot mask NFT collateral leg"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // F6 — NFT identity is part of the consent key (token id matters)
    // ════════════════════════════════════════════════════════════════════════

    function test_consentKey_nftTokenIdScoped() public {
        // Grant consent for collateral NFT tokenId 1, then confirm the SAME
        // collection's tokenId 2 is NOT covered — the pair key folds in the
        // token id so a consent to one concrete NFT can't be reused.
        LibRiskAccess.PairId memory pid1 = _pair(
            mockERC20, T_ERC20, 0, mockNft721, T_ERC721, 1, address(0)
        );
        LibRiskAccess.PairId memory pid2 = _pair(
            mockERC20, T_ERC20, 0, mockNft721, T_ERC721, 2, address(0)
        );

        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(pid1, true);

        assertTrue(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(
                lender, pid1
            ),
            "tokenId 1 consented"
        );
        assertFalse(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(
                lender, pid2
            ),
            "tokenId 2 NOT covered by tokenId 1 consent"
        );
    }

    /// @dev Codex #727 r2 P2 — an unused `prepayAsset` on a non-rental (ERC-20
    ///      lending) pair must be normalized OUT of the consent key, so a junk
    ///      prepay can't fork the key away from what the user consented to.
    function test_consentKey_normalizesUnusedPrepayOnNonRental() public {
        // Consent granted with no prepay (the canonical form).
        LibRiskAccess.PairId memory clean =
            _pair(mockERC20, T_ERC20, 0, mockCollateralERC20, T_ERC20, 0, address(0));
        // The SAME ERC-20 pair but with a junk prepay set — prepay is not a
        // value-bearing leg here (lend leg is ERC-20, not an NFT rental).
        LibRiskAccess.PairId memory withJunkPrepay =
            _pair(mockERC20, T_ERC20, 0, mockCollateralERC20, T_ERC20, 0, mockNft721);

        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(clean, true);

        // Both forms resolve to the same key, so the consent covers both.
        assertTrue(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(
                lender, clean
            ),
            "clean pair consented"
        );
        assertTrue(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(
                lender, withJunkPrepay
            ),
            "junk prepay normalized to the same key on a non-rental pair"
        );
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
        _bumpRiskTerms(keccak256("rt-4"));
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
        // A FRESH BlueChip -> IlliquidCustom raise: the prior settled tier is
        // BlueChipOnly, so during the cooldown the effective tier stays at 0.
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

    function test_cooldown_raiseKeepsPriorTierDuringCooldown() public {
        // F1 (Codex #727 r4 P2): raising Broad -> Illiquid must NOT transiently
        // drop the vault below the BroadLiquid access it already held — during
        // the new cooldown `effectiveTier` reports the PRIOR settled tier
        // (BroadLiquid), not BlueChipOnly.
        RiskAccessFacet(address(diamond)).setRiskAccessUnlockCooldown(
            uint64(1 days)
        );

        // Opt up to BroadLiquid and warp past its cooldown so it is settled.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);
        vm.warp(RiskAccessFacet(address(diamond)).getRiskTierUnlockAt(lender));
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            BROAD,
            "BroadLiquid settled"
        );

        // Opt UP to IlliquidCustom — raises risk, so a new cooldown arms.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        // Immediately: the prior BroadLiquid is preserved (NOT BlueChipOnly).
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            BROAD,
            "prior BroadLiquid preserved during new cooldown"
        );
        uint64 unlockAt =
            RiskAccessFacet(address(diamond)).getRiskTierUnlockAt(lender);
        assertGt(unlockAt, block.timestamp, "new unlock in the future");

        // Once the new cooldown elapses, the raised IlliquidCustom is effective.
        vm.warp(unlockAt);
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            ILLIQUID,
            "IlliquidCustom effective after cooldown"
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
    // F2 — re-submitting a LOCKED tier RE-ARMS the cooldown
    // ════════════════════════════════════════════════════════════════════════

    function test_cooldown_lockedResubmitReArmsAgainstEffectiveTier() public {
        // _applyTier compares the new level against the EFFECTIVE tier, not the
        // raw stored one. A vault that holds IlliquidCustom but is currently
        // LOCKED (effective == BlueChipOnly after a terms bump) and re-submits
        // IlliquidCustom is RAISING effective risk, so the cooldown MUST re-arm.
        RiskAccessFacet(address(diamond)).setRiskAccessUnlockCooldown(
            uint64(1 days)
        );

        // Opt up to IlliquidCustom and warp past its cooldown so it's effective.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        vm.warp(RiskAccessFacet(address(diamond)).getRiskTierUnlockAt(lender));
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            ILLIQUID,
            "effective before bump"
        );

        // Governance bump re-locks the held tier => effective falls to 0.
        _bumpRiskTerms(keccak256("rt-5"));
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            BLUECHIP,
            "locked after bump"
        );

        // Re-submit the SAME IlliquidCustom level. Because the EFFECTIVE tier is
        // currently 0 (locked), this is an opt-UP => the cooldown re-arms and
        // the tier stays locked until the new cooldown elapses.
        uint64 reSubmitTime = uint64(block.timestamp);
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);

        uint64 unlockAt =
            RiskAccessFacet(address(diamond)).getRiskTierUnlockAt(lender);
        assertEq(
            unlockAt, reSubmitTime + uint64(1 days), "cooldown re-armed"
        );
        // Still locked (effective 0) until the re-armed cooldown elapses.
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            BLUECHIP,
            "still locked immediately after re-submit"
        );
        // Effective once the re-armed cooldown passes.
        vm.warp(unlockAt);
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(lender),
            ILLIQUID,
            "effective after re-armed cooldown"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // F4 — per-pair illiquid consent also gated by the arming cooldown
    // ════════════════════════════════════════════════════════════════════════

    function test_cooldown_illiquidConsentDelayedThenEffective() public {
        RiskAccessFacet(address(diamond)).setRiskAccessUnlockCooldown(
            uint64(1 days)
        );
        LibRiskAccess.PairId memory p =
            _erc20Pair(mockERC20, mockCollateralERC20);

        uint64 grantTime = uint64(block.timestamp);
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(p, true);

        // Within the arming window => consent not yet effective.
        assertFalse(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(lender, p),
            "consent not yet cooled"
        );

        vm.warp(grantTime + uint64(1 days));
        assertTrue(
            RiskAccessFacet(address(diamond)).hasIlliquidPairConsent(lender, p),
            "consent effective once cooled"
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
        _bumpRiskTerms(keccak256("rt-6"));
        assertEq(
            RiskAccessFacet(address(diamond)).getEffectiveRiskTier(newVault),
            ILLIQUID,
            "managed vault unaffected by version bump"
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // ADMIN ACCESS-CONTROL (non-admin reverts; gate setter is admin-only)
    // ════════════════════════════════════════════════════════════════════════

    function test_adminOnly_commitRiskTermsBump() public {
        vm.prank(relayer);
        vm.expectRevert();
        RiskAccessFacet(address(diamond)).commitRiskTermsBump(keccak256("rt-7"));
    }

    function test_pauserOnly_revealRiskTermsBump() public {
        // Commit as admin (the test contract), then a non-PAUSER reveal reverts —
        // reveal is the OFF-TIMELOCK guardian (PAUSER) authority (#736 r7).
        bytes32 anchor = keccak256("rt-7b");
        RiskAccessFacet(address(diamond)).commitRiskTermsBump(
            keccak256(abi.encode(anchor))
        );
        vm.prank(relayer);
        vm.expectRevert();
        RiskAccessFacet(address(diamond)).revealRiskTermsBump(anchor);
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
        uint64 next = _bumpRiskTerms(keccak256("rt-8"));
        assertEq(next, before + 1, "returns incremented version");
        assertEq(
            RiskAccessFacet(address(diamond)).getCurrentRiskTermsVersion(),
            before + 1,
            "view reflects bump"
        );
    }

    // ─── #730 commit-reveal mechanics ────────────────────────────────────────

    /// @dev A commit alone neither advances the version nor publishes the hash —
    ///      and crucially the future hash is NOT derivable from the commitment, so
    ///      the live anchor stays 0 (a pre-reveal ack can't match it).
    function test_commit_hidesAnchorUntilReveal() public {
        bytes32 anchor = keccak256("rt-hide");
        RiskAccessFacet(address(diamond)).commitRiskTermsBump(
            keccak256(abi.encode(anchor))
        );
        assertEq(
            RiskAccessFacet(address(diamond)).getCurrentRiskTermsHash(),
            bytes32(0),
            "anchor not published by commit alone"
        );
        assertEq(
            RiskAccessFacet(address(diamond)).getCurrentRiskTermsVersion(),
            0,
            "version not advanced by commit alone"
        );
        // After reveal the anchor is the committed secret and the version advances.
        uint64 v = RiskAccessFacet(address(diamond)).revealRiskTermsBump(anchor);
        assertEq(v, 1, "reveal advances version");
        assertEq(
            RiskAccessFacet(address(diamond)).getCurrentRiskTermsHash(),
            anchor,
            "reveal publishes the committed anchor"
        );
        assertEq(
            RiskAccessFacet(address(diamond)).getPendingRiskTermsCommitment(),
            bytes32(0),
            "commitment cleared on reveal"
        );
    }

    function test_reveal_revertsWithoutCommit() public {
        vm.expectRevert(RiskAccessFacet.NoPendingRiskTermsCommitment.selector);
        RiskAccessFacet(address(diamond)).revealRiskTermsBump(keccak256("rt-nc"));
    }

    function test_reveal_revertsOnMismatch() public {
        bytes32 anchor = keccak256("rt-mm");
        RiskAccessFacet(address(diamond)).commitRiskTermsBump(
            keccak256(abi.encode(anchor))
        );
        // A different preimage cannot satisfy the hiding commitment.
        vm.expectRevert(RiskAccessFacet.RiskTermsRevealMismatch.selector);
        RiskAccessFacet(address(diamond)).revealRiskTermsBump(keccak256("wrong"));
    }

    function test_commit_revertsOnZeroAnchorCommitment() public {
        // #736 r13 — committing to the zero anchor fails fast at commit, not only
        // later at reveal (where `termsAnchor == 0` would trip InvalidRiskTermsHash).
        vm.expectRevert(RiskAccessFacet.InvalidRiskTermsHash.selector);
        RiskAccessFacet(address(diamond)).commitRiskTermsBump(
            keccak256(abi.encode(bytes32(0)))
        );
    }

    /// @dev #736 r6 — anchors are SINGLE-USE: rolling A→B→A cannot re-publish A,
    ///      so an ack stamped during the first A-period can never substitute again.
    function test_reveal_revertsOnReusedAnchor_rollingABA() public {
        bytes32 a = keccak256("rt-A");
        bytes32 b = keccak256("rt-B");
        _bumpRiskTerms(a); // version 1, anchor A (A now used)
        _bumpRiskTerms(b); // version 2, anchor B
        RiskAccessFacet(address(diamond)).commitRiskTermsBump(
            keccak256(abi.encode(a))
        );
        vm.expectRevert(RiskAccessFacet.RiskTermsHashAlreadyUsed.selector);
        RiskAccessFacet(address(diamond)).revealRiskTermsBump(a);
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
        // consent's pair identity is (lendAsset, lendType, lendTokenId,
        // collAsset, collType, collTokenId, prepayAsset) — the create path
        // passes ERC20 legs (tokenId 0) and `params.prepayAsset` (= mockERC20
        // in `_createLenderOffer`).
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(ILLIQUID);
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setIlliquidPairConsent(
            _pair(
                mockERC20, T_ERC20, 0, mockCollateralERC20, T_ERC20, 0, mockERC20
            ),
            true
        );

        uint256 offerId =
            _createLenderOffer(mockERC20, mockCollateralERC20);
        assertGt(offerId, 0, "offer created after opt-up + consent");
    }

    function test_createGate_broadLiquidPassesOnTierAlone() public {
        // A BroadLiquid-required pair (both legs liquid tier-1, neither
        // blue-chip) is NOT per-pair gated (Codex #727 r4): the BroadLiquid tier
        // opt-up is itself the consent. A BlueChipOnly creator is rejected; after
        // opting UP to BroadLiquid the create SUCCEEDS with no per-pair step.
        _mockTier(mockERC20, 1); // lend leg liquid, non-blue-chip => BroadLiquid
        _mockTier(mockCollateralERC20, 1); // coll leg liquid => BroadLiquid

        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);

        // BlueChipOnly (default) creator is under-tiered for a BroadLiquid pair.
        // (No outer `vm.prank` here — `_createLenderOffer` pranks `lender`
        // itself; a second overlapping prank would revert at cheatcode depth.)
        vm.expectRevert(
            abi.encodeWithSelector(
                LibRiskAccess.RiskTierTooLow.selector,
                lender,
                BROAD,
                BLUECHIP
            )
        );
        _createLenderOffer(mockERC20, mockCollateralERC20);

        // Opt UP to BroadLiquid (cooldown 0 => immediate) — NO per-pair consent.
        vm.prank(lender);
        RiskAccessFacet(address(diamond)).setVaultRiskTier(BROAD);

        uint256 offerId =
            _createLenderOffer(mockERC20, mockCollateralERC20);
        assertGt(offerId, 0, "BroadLiquid pair passes on tier alone");
    }

    // NOTE: sale-vehicle exemption covered separately (needs an active loan).
    // NOTE: offset-create gating (F3 — Codex r1 P1) is covered by the
    //       PrecloseFacet offset integration in phase 2 — it needs an active
    //       loan to exercise the offset-create path, out of scope for this
    //       unit suite, so it is deliberately not stubbed here.
}
