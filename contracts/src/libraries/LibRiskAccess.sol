// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SignatureChecker} from
    "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {LibVaipakam} from "./LibVaipakam.sol";

/// @dev Minimal diamond-routed view the risk gate needs. `getEffectiveLiquidityTier`
///      lives on `OracleFacet`; calling it through `address(this)` (the Diamond)
///      reuses the SAME depth-classification the LTV/HF machinery uses, so the
///      risk gate can never disagree with the rest of the protocol about how deep
///      an asset is. A `staticcall` (view) — no state, no reentrancy surface.
interface IRiskAccessOracle {
    function getEffectiveLiquidityTier(address asset) external view returns (uint8);
}

/**
 * @title LibRiskAccess
 * @author Vaipakam Developer Team
 * @notice On-chain progressive risk-access gate (#671 — see
 *         `docs/DesignsAndPlans/ProgressiveRiskAccessDesign.md`). Two concerns,
 *         one bytecode blob shared by every gate site:
 *
 *         1. **Classification + gate** — derive each asset's required tier from
 *            on-chain liquidity (NO governance allow-list) and assert the actor's
 *            opted-in tier covers the riskier leg of the pair, plus the per-pair
 *            acknowledgement / consent for the boundary tier.
 *
 *         2. **EIP-712 self-submit setters** — a vault owner opts UP their tier
 *            (or records a per-pair ack/consent) with a typed signature a relayer
 *            can submit, mirroring `LibAcceptTerms` (#662). The acceptance-specific
 *            domain `"Vaipakam RiskAccess"` keeps these prompts un-replayable as an
 *            offer / acceptance and correctly labelled in the wallet.
 *
 * @dev    **O6 (numeraire-basket union)** — a "blue-chip" asset is the numeraire
 *         basket (WETH + the configured PAA quote assets) OR an asset that earns
 *         `getEffectiveLiquidityTier == 3`. The basket is blue-chip BY
 *         CONSTRUCTION: it is the set the depth oracle measures every other asset
 *         against, so a numeraire cannot route-quote against itself and would
 *         otherwise tier as 0. The design's worry that a thin asset "inherits"
 *         WETH's depth is a non-issue — `OracleFacet._routeOverQuote` measures the
 *         asset/quote POOL itself, so a thin WETH-paired asset tiers low on its own
 *         pool's slippage.
 *
 *         **Read-time re-lock** — a tier / consent is "effective" only while its
 *         per-user version anchor is ≥ the global `currentRiskTermsVersion` AND its
 *         cooldown has elapsed. A governance bump of `currentRiskTermsVersion`
 *         therefore re-locks every held level with ZERO writes (the gate just reads
 *         stale → falls back to the safest tier), and a phished opt-up can't
 *         transact until the cooldown passes.
 */
library LibRiskAccess {
    using LibVaipakam for LibVaipakam.Storage;

    // ─────────────────────────────────────────────────────────────────────────
    // Classification
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice O6 — is `asset` blue-chip for the risk gate?
    /// @dev    `asset==wethContract` covers WETH even when it is the sole
    ///         (implicit-fallback) numeraire and so tiers as 0 against itself;
    ///         `isPaaAsset` covers the explicitly-configured quote basket; the
    ///         tier-3 clause covers everything that earns blue-chip depth on its
    ///         own pools.
    function _isBlueChip(LibVaipakam.Storage storage s, address asset)
        internal
        view
        returns (bool)
    {
        if (asset == address(0)) return false;
        if (asset == s.wethContract) return true;
        if (LibVaipakam.isPaaAsset(asset)) return true;
        return IRiskAccessOracle(address(this)).getEffectiveLiquidityTier(asset)
            == 3;
    }

    /// @notice The minimum `RiskAccessLevel` a vault must hold to transact a
    ///         single asset leg.
    /// @dev    Blue-chip ⇒ `BlueChipOnly` (every vault). Else tier ≥ 1 (liquid)
    ///         ⇒ `BroadLiquid`. Else (tier 0, unpriced/illiquid, and not a
    ///         numeraire) ⇒ `IlliquidCustom`.
    function _assetRequiredLevel(LibVaipakam.Storage storage s, address asset)
        internal
        view
        returns (LibVaipakam.RiskAccessLevel)
    {
        if (_isBlueChip(s, asset)) {
            return LibVaipakam.RiskAccessLevel.BlueChipOnly;
        }
        uint8 tier =
            IRiskAccessOracle(address(this)).getEffectiveLiquidityTier(asset);
        if (tier >= 1) return LibVaipakam.RiskAccessLevel.BroadLiquid;
        return LibVaipakam.RiskAccessLevel.IlliquidCustom;
    }

    /// @notice The classification leg for a position side — substitutes the
    ///         value-bearing `prepayAsset` for an NFT leg of a rental.
    /// @dev    #671: an NFT rental's risk is the prepayment token the renter
    ///         streams, NOT the rented ERC721/1155 (which never leaves custody
    ///         on a clean close). So an ERC721/ERC1155 leg with a non-zero
    ///         `prepayAsset` is classified by that prepay token; an outright NFT
    ///         loan (no prepay) keeps the NFT leg and so requires `IlliquidCustom`.
    function _legAsset(
        address asset,
        LibVaipakam.AssetType assetType,
        address prepayAsset
    ) private pure returns (address) {
        if (
            (assetType == LibVaipakam.AssetType.ERC721
                || assetType == LibVaipakam.AssetType.ERC1155)
                && prepayAsset != address(0)
        ) {
            return prepayAsset;
        }
        return asset;
    }

    /// @notice The riskier of the two legs governs the pair's required tier.
    function _pairRequiredLevel(
        LibVaipakam.Storage storage s,
        address lendAsset,
        LibVaipakam.AssetType lendType,
        address collAsset,
        LibVaipakam.AssetType collType,
        address prepayAsset
    ) internal view returns (LibVaipakam.RiskAccessLevel) {
        LibVaipakam.RiskAccessLevel lend = _assetRequiredLevel(
            s, _legAsset(lendAsset, lendType, prepayAsset)
        );
        LibVaipakam.RiskAccessLevel coll = _assetRequiredLevel(
            s, _legAsset(collAsset, collType, prepayAsset)
        );
        return uint8(lend) >= uint8(coll) ? lend : coll;
    }

    /// @notice Stable per-(user-agnostic) identity of an asset pair, used to key
    ///         the per-pair ack / consent maps. Order-sensitive (lend vs coll are
    ///         distinct roles) and folds in `prepayAsset` so a rental and a loan
    ///         on the same NFT are distinct consents.
    function pairKey(address lendAsset, address collAsset, address prepayAsset)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(lendAsset, collAsset, prepayAsset));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Effective (read-time re-locked) tier + consent
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The actor's currently-effective tier: the opted-in tier ONLY while
    ///         its version anchor is fresh and its cooldown has elapsed; otherwise
    ///         the safest tier. A protocol-managed vault (sale vehicle / backstop)
    ///         reports its raw opted-in tier with no freshness/cooldown gate.
    function effectiveTier(LibVaipakam.Storage storage s, address actor)
        internal
        view
        returns (LibVaipakam.RiskAccessLevel)
    {
        LibVaipakam.RiskAccessLevel held = s.userRiskAccess[actor];
        if (held == LibVaipakam.RiskAccessLevel.BlueChipOnly) return held;
        if (s.protocolManagedVault[actor]) return held;
        bool fresh = s.riskTierVersionAt[actor] >= s.currentRiskTermsVersion;
        bool cooled = block.timestamp >= s.riskTierUnlockAt[actor];
        return (fresh && cooled)
            ? held
            : LibVaipakam.RiskAccessLevel.BlueChipOnly;
    }

    function _illiquidConsentEffective(
        LibVaipakam.Storage storage s,
        address actor,
        bytes32 pk
    ) private view returns (bool) {
        return s.illiquidPairConsent[actor][pk]
            && s.illiquidPairVersionAt[actor][pk] >= s.currentRiskTermsVersion;
    }

    function _midTierAckEffective(
        LibVaipakam.Storage storage s,
        address actor,
        bytes32 pk
    ) private view returns (bool) {
        return s.midTierPairAck[actor][pk]
            && s.midTierVersionAt[actor][pk] >= s.currentRiskTermsVersion;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The gate
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Assert `actor`'s effective tier covers this pair, with the
    ///         per-pair acknowledgement / consent the boundary tier requires.
    /// @dev    No-op when the kill-switch is off OR the sale-vehicle transient is
    ///         set — callers should still wrap with `cfgRiskAccessGateEnabled()`
    ///         to avoid the diamond view hop, but the internal guards here make
    ///         the function safe to call unconditionally.
    function assertActorMayTransact(
        LibVaipakam.Storage storage s,
        address actor,
        address lendAsset,
        LibVaipakam.AssetType lendType,
        address collAsset,
        LibVaipakam.AssetType collType,
        address prepayAsset
    ) internal view {
        LibVaipakam.RiskAccessLevel required = _pairRequiredLevel(
            s, lendAsset, lendType, collAsset, collType, prepayAsset
        );
        LibVaipakam.RiskAccessLevel actorTier = effectiveTier(s, actor);
        if (uint8(actorTier) < uint8(required)) {
            revert RiskTierTooLow(actor, uint8(required), uint8(actorTier));
        }
        if (required == LibVaipakam.RiskAccessLevel.BlueChipOnly) return;
        bytes32 pk = pairKey(lendAsset, collAsset, prepayAsset);
        if (required == LibVaipakam.RiskAccessLevel.IlliquidCustom) {
            if (!_illiquidConsentEffective(s, actor, pk)) {
                revert IlliquidPairNotConsented(actor, pk);
            }
        } else {
            // BroadLiquid boundary — one-time mid-tier ack.
            if (!_midTierAckEffective(s, actor, pk)) {
                revert MidTierPairNotAcknowledged(actor, pk);
            }
        }
    }

    /// @notice Risk-gate revert reasons (carried in the facet ABI).
    error RiskTierTooLow(address actor, uint8 requiredTier, uint8 actorTier);
    error IlliquidPairNotConsented(address actor, bytes32 pairKey);
    error MidTierPairNotAcknowledged(address actor, bytes32 pairKey);

    // ─────────────────────────────────────────────────────────────────────────
    // EIP-712 self-submit setters
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Opt a vault UP to a tier (or tighten it). Tightening (a lower
    ///         ordinal than currently held) is exempt from the cooldown — a user
    ///         may always reduce their own exposure immediately.
    struct SetVaultRiskTier {
        address vault; // == recovered / 1271 signer
        uint8 level; // target RiskAccessLevel
        uint256 nonce; // per-vault replay nonce
        uint256 deadline; // unix-seconds
    }

    /// @notice Record (or revoke) explicit consent to a specific ILLIQUID pair.
    struct SetIlliquidPairConsent {
        address vault;
        address lendAsset;
        address collAsset;
        address prepayAsset;
        bool consent; // true = grant, false = revoke
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice Record (or revoke) the one-time mid-tier acknowledgement for a pair.
    struct SetMidTierPairAck {
        address vault;
        address lendAsset;
        address collAsset;
        address prepayAsset;
        bool ack;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 internal constant SET_VAULT_RISK_TIER_TYPEHASH = keccak256(
        "SetVaultRiskTier(address vault,uint8 level,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant SET_ILLIQUID_PAIR_CONSENT_TYPEHASH = keccak256(
        "SetIlliquidPairConsent(address vault,address lendAsset,address collAsset,address prepayAsset,bool consent,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant SET_MID_TIER_PAIR_ACK_TYPEHASH = keccak256(
        "SetMidTierPairAck(address vault,address lendAsset,address collAsset,address prepayAsset,bool ack,uint256 nonce,uint256 deadline)"
    );

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    /// @dev RiskAccess-specific domain — distinct from `"Vaipakam AcceptOffer"`
    ///      / `"Vaipakam SignedOffer"` so these prompts can't be cross-replayed
    ///      and the wallet labels them as a risk-tier change.
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("Vaipakam RiskAccess");
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("1");

    function domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                DOMAIN_NAME_HASH,
                DOMAIN_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), structHash)
        );
    }

    function digest(SetVaultRiskTier memory m) internal view returns (bytes32) {
        return _digest(
            keccak256(
                abi.encode(
                    SET_VAULT_RISK_TIER_TYPEHASH,
                    m.vault,
                    m.level,
                    m.nonce,
                    m.deadline
                )
            )
        );
    }

    function digest(SetIlliquidPairConsent memory m)
        internal
        view
        returns (bytes32)
    {
        return _digest(
            keccak256(
                abi.encode(
                    SET_ILLIQUID_PAIR_CONSENT_TYPEHASH,
                    m.vault,
                    m.lendAsset,
                    m.collAsset,
                    m.prepayAsset,
                    m.consent,
                    m.nonce,
                    m.deadline
                )
            )
        );
    }

    function digest(SetMidTierPairAck memory m)
        internal
        view
        returns (bytes32)
    {
        return _digest(
            keccak256(
                abi.encode(
                    SET_MID_TIER_PAIR_ACK_TYPEHASH,
                    m.vault,
                    m.lendAsset,
                    m.collAsset,
                    m.prepayAsset,
                    m.ack,
                    m.nonce,
                    m.deadline
                )
            )
        );
    }

    function verify(address signer, bytes32 d, bytes memory signature)
        internal
        view
        returns (bool)
    {
        return SignatureChecker.isValidSignatureNow(signer, d, signature);
    }
}
