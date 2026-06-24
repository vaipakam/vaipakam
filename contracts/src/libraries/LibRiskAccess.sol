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

    /// @notice Full identity of an offer's asset pair for classification +
    ///         consent keying. Carries asset TYPES and TOKEN IDS (Codex #727 r1
    ///         P2) so a per-pair consent is bound to the exact NFT the user
    ///         reviewed, not the whole collection. ERC-20 legs carry tokenId 0.
    struct PairId {
        address lendAsset;
        LibVaipakam.AssetType lendType;
        uint256 lendTokenId;
        address collAsset;
        LibVaipakam.AssetType collType;
        uint256 collTokenId;
        address prepayAsset;
    }

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

    /// @notice Per-leg classification — the SINGLE source of truth reused by the
    ///         gate AND the accept-time #662-ack coverage check (Codex #729 r1),
    ///         so the two can never diverge. Returns the required level + the
    ///         CLASSIFICATION ASSET that level was derived from.
    /// @dev    Forces any NFT-typed leg to `IlliquidCustom` by AssetType BEFORE
    ///         consulting ERC-20 liquidity (#727 r4) — except a rental's NFT
    ///         LENDING leg, whose risk is the substituted `prepayAsset` (so the
    ///         classification asset for a rental lend leg is the prepay token,
    ///         NOT the rented NFT).
    function _lendLegLevel(LibVaipakam.Storage storage s, PairId memory p)
        private
        view
        returns (LibVaipakam.RiskAccessLevel level, address classAsset)
    {
        if (_isNft(p.lendType)) {
            if (p.prepayAsset != address(0)) {
                return (_assetRequiredLevel(s, p.prepayAsset), p.prepayAsset); // rental
            }
            return (LibVaipakam.RiskAccessLevel.IlliquidCustom, p.lendAsset); // bare NFT loan
        }
        return (_assetRequiredLevel(s, p.lendAsset), p.lendAsset);
    }

    function _collLegLevel(LibVaipakam.Storage storage s, PairId memory p)
        private
        view
        returns (LibVaipakam.RiskAccessLevel level, address classAsset)
    {
        // An NFT collateral is always genuine illiquid collateral.
        if (_isNft(p.collType)) {
            return (LibVaipakam.RiskAccessLevel.IlliquidCustom, p.collAsset);
        }
        return (_assetRequiredLevel(s, p.collAsset), p.collAsset);
    }

    /// @notice The riskier of the two legs governs the pair's required tier.
    function _pairRequiredLevel(LibVaipakam.Storage storage s, PairId memory p)
        internal
        view
        returns (LibVaipakam.RiskAccessLevel)
    {
        (LibVaipakam.RiskAccessLevel lend,) = _lendLegLevel(s, p);
        (LibVaipakam.RiskAccessLevel coll,) = _collLegLevel(s, p);
        return uint8(lend) >= uint8(coll) ? lend : coll;
    }

    /// @notice Stable identity of an asset pair, keying the per-pair ack /
    ///         consent maps. Order-sensitive (lend vs coll are distinct roles)
    ///         and folds in the asset TYPES + TOKEN IDS (Codex #727 r1 P2) so a
    ///         consent to one concrete NFT can't be reused for a different token
    ///         id in the same collection, plus `prepayAsset` so a rental and a
    ///         loan on the same NFT are distinct consents. ERC-20 legs carry
    ///         tokenId 0, so the key is uniform across asset classes.
    function pairKey(PairId memory p) internal pure returns (bytes32) {
        // Canonicalize fields that are meaningless for the leg's asset class
        // (Codex #727 r2 P2) so a junk value can't fork the consent key:
        //  - token ids are zeroed for non-NFT legs;
        //  - `prepayAsset` is a value-bearing (rental) leg ONLY when the LENDING
        //    asset is an NFT, so it's zeroed otherwise (an unused prepay on an
        //    ERC-20 offer must not change the key the user consented to).
        bool lendIsNft = _isNft(p.lendType);
        uint256 lendTokenId = lendIsNft ? p.lendTokenId : 0;
        uint256 collTokenId = _isNft(p.collType) ? p.collTokenId : 0;
        address prepay = lendIsNft ? p.prepayAsset : address(0);
        return keccak256(
            abi.encode(
                p.lendAsset,
                uint8(p.lendType),
                lendTokenId,
                p.collAsset,
                uint8(p.collType),
                collTokenId,
                prepay
            )
        );
    }

    function _isNft(LibVaipakam.AssetType t) private pure returns (bool) {
        return t == LibVaipakam.AssetType.ERC721
            || t == LibVaipakam.AssetType.ERC1155;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Effective (read-time re-locked) tier + consent
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The actor's currently-effective tier.
    /// @dev    A protocol-managed vault (sale vehicle / backstop) reports its raw
    ///         opted-in tier with no freshness/cooldown gate. Otherwise:
    ///          - if the version anchor is STALE (a terms bump re-locked it), the
    ///            tier falls all the way to `BlueChipOnly` — the user must
    ///            re-affirm the new terms (Codex #727 r1);
    ///          - else if the higher tier's cooldown has NOT elapsed, the
    ///            previously-SETTLED tier stays effective (so raising
    ///            Broad->Illiquid never transiently drops the vault below the
    ///            BroadLiquid access it already held — Codex #727 r4 P2);
    ///          - else the held tier is effective.
    function effectiveTier(LibVaipakam.Storage storage s, address actor)
        internal
        view
        returns (LibVaipakam.RiskAccessLevel)
    {
        LibVaipakam.RiskAccessLevel held = s.userRiskAccess[actor];
        if (held == LibVaipakam.RiskAccessLevel.BlueChipOnly) return held;
        if (s.protocolManagedVault[actor]) return held;
        if (s.riskTierVersionAt[actor] < s.currentRiskTermsVersion) {
            return LibVaipakam.RiskAccessLevel.BlueChipOnly; // stale terms
        }
        if (block.timestamp < s.riskTierUnlockAt[actor]) {
            return s.riskTierSettled[actor]; // higher tier still cooling down
        }
        return held;
    }

    /// @dev A pair grant is effective only while (a) it is set, (b) its version
    ///      anchor is still current (read-time re-lock), AND (c) its arming
    ///      cooldown has elapsed (Codex #727 r1 P1 — no atomic sign-and-use).
    function _illiquidConsentEffective(
        LibVaipakam.Storage storage s,
        address actor,
        bytes32 pk
    ) private view returns (bool) {
        return s.illiquidPairConsent[actor][pk]
            && s.illiquidPairVersionAt[actor][pk] >= s.currentRiskTermsVersion
            && block.timestamp >= s.pairConsentUnlockAt[actor][pk];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The gate
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Assert `actor`'s effective tier covers this pair, plus the
    ///         per-pair consent the `IlliquidCustom` boundary requires.
    /// @dev    This function does NOT self-guard: it always evaluates the gate.
    ///         The CALLER is responsible for the master kill-switch
    ///         (`cfgRiskAccessGateEnabled()`) and the `saleVehicleCreate`
    ///         exemption — see `OfferCreateFacet`, which skips this call when the
    ///         gate is off or a protocol sale vehicle is mid-create. Reverts
    ///         `RiskTierTooLow` / `IlliquidPairNotConsented` when the actor is
    ///         under-qualified.
    ///
    ///         BroadLiquid (liquid-but-not-blue-chip) pairs are NOT per-pair
    ///         gated: the BroadLiquid tier opt-up is itself the consent, and the
    ///         quantitative LTV/HF check still applies (design RD-1; Codex #727
    ///         r4). Only `IlliquidCustom` needs blocking per-pair consent.
    function assertActorMayTransact(
        LibVaipakam.Storage storage s,
        address actor,
        PairId memory p
    ) internal view {
        LibVaipakam.RiskAccessLevel required = _pairRequiredLevel(s, p);
        LibVaipakam.RiskAccessLevel actorTier = effectiveTier(s, actor);
        if (uint8(actorTier) < uint8(required)) {
            revert RiskTierTooLow(actor, uint8(required), uint8(actorTier));
        }
        // Only the illiquid boundary carries a blocking per-pair consent.
        if (required == LibVaipakam.RiskAccessLevel.IlliquidCustom) {
            bytes32 pk = pairKey(p);
            if (!_illiquidConsentEffective(s, actor, pk)) {
                revert IlliquidPairNotConsented(actor, pk);
            }
        }
    }

    /// @notice Accept-path gate (#671 phase 2 / #728) — the acceptor's tier must
    ///         cover the pair, and for an `IlliquidCustom` pair the acceptor must
    ///         have consented to it.
    /// @dev    The #662⇄#671 UNIFICATION (Codex #729 r1): the illiquid consent is
    ///         satisfied by EITHER a standing fresh per-pair `illiquidPairConsent`
    ///         OR the acceptor's #662 acceptance acknowledgement — but ONLY when
    ///         that ack names EXACTLY the assets this gate classifies illiquid for
    ///         the pair (`_ackCoversIlliquidLegs`, reusing the SAME per-leg
    ///         classification so #662 and #671 can't diverge) AND the acceptor's
    ///         risk terms are still fresh. The two classifications differ for an
    ///         NFT RENTAL (this gate keys the lend leg off `prepayAsset`, while the
    ///         #662 ack names the rented NFT), so a rental with an illiquid prepay
    ///         token correctly falls back to requiring a standing per-pair consent.
    ///         `ackLend` / `ackColl` are the acceptor's signed
    ///         `acknowledgedIlliquid{Lending,Collateral}Asset` (already injected
    ///         + verified at the call site).
    function assertAcceptorMayTransact(
        LibVaipakam.Storage storage s,
        address actor,
        PairId memory p,
        address ackLend,
        address ackColl
    ) internal view {
        LibVaipakam.RiskAccessLevel required = _pairRequiredLevel(s, p);
        LibVaipakam.RiskAccessLevel actorTier = effectiveTier(s, actor);
        if (uint8(actorTier) < uint8(required)) {
            revert RiskTierTooLow(actor, uint8(required), uint8(actorTier));
        }
        if (required != LibVaipakam.RiskAccessLevel.IlliquidCustom) return;
        bytes32 pk = pairKey(p);
        if (_illiquidConsentEffective(s, actor, pk)) return; // standing fresh consent
        // #662 ack-substitution — only with FRESH risk terms (a governance terms
        // bump re-locks the substitution just like a standing consent; Codex #729
        // r1) AND an ack that covers exactly the gate's illiquid legs.
        if (
            s.riskTierVersionAt[actor] >= s.currentRiskTermsVersion
                && _ackCoversIlliquidLegs(s, p, ackLend, ackColl)
        ) {
            return;
        }
        revert IlliquidPairNotConsented(actor, pk);
    }

    /// @dev True iff the acceptor's #662 acknowledgement names the classification
    ///      asset of EVERY leg this gate deems `IlliquidCustom`. Reuses
    ///      `_lendLegLevel` / `_collLegLevel` (the single classification source),
    ///      so a rental's prepay-substituted lend leg (classAsset == prepay) is
    ///      NOT covered by the #662 ack (which names the rented NFT) — that case
    ///      falls through to requiring a standing consent.
    function _ackCoversIlliquidLegs(
        LibVaipakam.Storage storage s,
        PairId memory p,
        address ackLend,
        address ackColl
    ) private view returns (bool) {
        (LibVaipakam.RiskAccessLevel lendLvl, address lendClass) =
            _lendLegLevel(s, p);
        if (
            lendLvl == LibVaipakam.RiskAccessLevel.IlliquidCustom
                && ackLend != lendClass
        ) {
            return false;
        }
        (LibVaipakam.RiskAccessLevel collLvl, address collClass) =
            _collLegLevel(s, p);
        if (
            collLvl == LibVaipakam.RiskAccessLevel.IlliquidCustom
                && ackColl != collClass
        ) {
            return false;
        }
        return true;
    }

    /// @notice Risk-gate revert reasons (carried in the facet ABI).
    error RiskTierTooLow(address actor, uint8 requiredTier, uint8 actorTier);
    error IlliquidPairNotConsented(address actor, bytes32 pairKey);

    // ─────────────────────────────────────────────────────────────────────────
    // EIP-712 self-submit setters
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Opt a vault UP to a tier (or tighten it). Tightening (a lower
    ///         ordinal than currently held) is exempt from the cooldown — a user
    ///         may always reduce their own exposure immediately.
    /// @dev    `termsVersion` binds the grant to the risk-terms version the
    ///         signer agreed to (Codex #727 r1 P1): a `*BySig` submit rejects a
    ///         signature whose `termsVersion` != the live `currentRiskTermsVersion`,
    ///         so an old long-deadline signature can't be relayed after a
    ///         `bumpRiskTermsVersion()` to silently re-establish freshness.
    struct SetVaultRiskTier {
        address vault; // == recovered / 1271 signer
        uint8 level; // target RiskAccessLevel
        uint64 termsVersion; // must == currentRiskTermsVersion at submit
        uint256 nonce; // per-vault replay nonce
        uint256 deadline; // unix-seconds
    }

    /// @notice Record (or revoke) explicit consent to a specific ILLIQUID pair.
    ///         Carries the full pair identity (asset types + token ids) so the
    ///         consent is bound to the exact NFT the signer reviewed, not the
    ///         whole collection (Codex #727 r1 P2).
    struct SetIlliquidPairConsent {
        address vault;
        address lendAsset;
        uint8 lendAssetType;
        uint256 lendTokenId;
        address collAsset;
        uint8 collAssetType;
        uint256 collTokenId;
        address prepayAsset;
        bool consent; // true = grant, false = revoke
        uint64 termsVersion;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 internal constant SET_VAULT_RISK_TIER_TYPEHASH = keccak256(
        "SetVaultRiskTier(address vault,uint8 level,uint64 termsVersion,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant SET_ILLIQUID_PAIR_CONSENT_TYPEHASH = keccak256(
        "SetIlliquidPairConsent(address vault,address lendAsset,uint8 lendAssetType,uint256 lendTokenId,address collAsset,uint8 collAssetType,uint256 collTokenId,address prepayAsset,bool consent,uint64 termsVersion,uint256 nonce,uint256 deadline)"
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
                    m.termsVersion,
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
        // Chunked into ≤10-value `abi.encode`s joined by `bytes.concat` (viaIR
        // whole-unit stack ceiling — same idiom as LibAcceptTerms.hashStruct).
        // All fields are static EIP-712 types, so the concat is byte-identical
        // to a single 13-value encode.
        return _digest(
            keccak256(
                bytes.concat(
                    abi.encode(
                        SET_ILLIQUID_PAIR_CONSENT_TYPEHASH,
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

    function verify(address signer, bytes32 d, bytes memory signature)
        internal
        view
        returns (bool)
    {
        return SignatureChecker.isValidSignatureNow(signer, d, signature);
    }
}
