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
    /// @dev The SAME liquidity classification the accept-time #662 check feeds to
    ///      `_ackCoversIlliquidLegs` (`ctx.{lending,collateral}Liquidity ==
    ///      Illiquid`, both from `OracleFacet.checkLiquidity`). The ack-aware
    ///      accept preview (#735) reuses it so it models the gate's ack
    ///      substitution with zero drift.
    function checkLiquidity(address asset)
        external
        view
        returns (LibVaipakam.LiquidityStatus);
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

    /// @dev #671 phase 2 RD-1 (#728 PR-2d) — is `actor` subject to the strict-mode
    ///      mid-tier per-pair ack requirement RIGHT NOW? True when the flag is on,
    ///      OR (Codex-hardening) when it was recently turned OFF and the disable-
    ///      cooldown has not yet elapsed — so a strict-mode user can't dodge the
    ///      mid-tier ack by disabling strict mode and originating in the same
    ///      cooldown window. With the default zero cooldown, a disable takes effect
    ///      immediately (no lingering requirement).
    function _strictModeEffective(LibVaipakam.Storage storage s, address actor)
        private
        view
        returns (bool)
    {
        if (s.riskStrictMode[actor]) return true;
        // Disable-cooldown linger: the resolved expiry was frozen at disable-time
        // (Codex #733 P2), so a later `riskAccessUnlockCooldown` change can't
        // retroactively lengthen or shorten the window.
        return block.timestamp < s.strictModeStrictUntil[actor];
    }

    /// @dev True iff `actor` holds a FRESH, ARMED explicit mid-tier ack for `pk`.
    ///      "Fresh" = set AND its version anchor still current (a terms bump
    ///      re-locks it, same read-time re-lock as the tier/consent anchors).
    ///      "Armed" = its arming cooldown has elapsed (`block.timestamp >=
    ///      midTierAckUnlockAt`), closing the atomic sign-and-use window exactly
    ///      like the illiquid consent (Codex #733 P1). Reads the EXPLICIT
    ///      (setter-only) map, never a passive auto-stamp — so strict mode can't be
    ///      satisfied accidentally.
    function _midTierAckEffective(
        LibVaipakam.Storage storage s,
        address actor,
        bytes32 pk
    ) private view returns (bool) {
        return s.midTierExplicitAck[actor][pk] != 0
            && s.midTierExplicitAckVersion[actor][pk] >= s.currentRiskTermsVersion
            && block.timestamp >= s.midTierAckUnlockAt[actor][pk];
    }

    /// @notice Read-only view of the strict-mode mid-tier requirement for a pair —
    ///         used by `RiskAccessFacet` view surfaces and the frontend. True iff
    ///         the actor is (effectively) in strict mode for a BroadLiquid pair and
    ///         lacks a fresh explicit ack — i.e. the gate WOULD block this mid-tier
    ///         origination. Returns false for non-mid-tier pairs.
    function midTierStrictBlock(
        LibVaipakam.Storage storage s,
        address actor,
        PairId memory p
    ) internal view returns (bool) {
        if (_pairRequiredLevel(s, p) != LibVaipakam.RiskAccessLevel.BroadLiquid) {
            return false;
        }
        return _strictModeEffective(s, actor)
            && !_midTierAckEffective(s, actor, pairKey(p));
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
        } else if (required == LibVaipakam.RiskAccessLevel.BroadLiquid) {
            // RD-1 strict mode (#728 PR-2d): a mid-tier pair is NOT per-pair gated
            // by default (the tier opt-up is the consent), but a vault that opted
            // INTO strict mode must hold a fresh EXPLICIT ack for the mid-tier pair
            // too — this is what makes `setRiskStrictMode` enforce anything. No-op
            // for the vast majority (strict mode default-off).
            if (midTierStrictBlock(s, actor, p)) {
                revert MidTierPairNotAcknowledged(actor, pairKey(p));
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
    ///         + verified at the call site). `lendAckVerified` / `collAckVerified`
    ///         say whether the #662 check at the call site ACTUALLY validated that
    ///         leg's ack against the live liquidity read — only a verified ack may
    ///         substitute for standing consent (Codex #729 r3; see
    ///         `_ackCoversIlliquidLegs`).
    function assertAcceptorMayTransact(
        LibVaipakam.Storage storage s,
        address actor,
        PairId memory p,
        address ackLend,
        address ackColl,
        bool lendAckVerified,
        bool collAckVerified
    ) internal view {
        LibVaipakam.RiskAccessLevel required = _pairRequiredLevel(s, p);
        LibVaipakam.RiskAccessLevel actorTier = effectiveTier(s, actor);
        if (uint8(actorTier) < uint8(required)) {
            revert RiskTierTooLow(actor, uint8(required), uint8(actorTier));
        }
        if (required != LibVaipakam.RiskAccessLevel.IlliquidCustom) {
            // RD-1 strict mode (#728 PR-2d): a strict-mode acceptor must hold a
            // fresh EXPLICIT ack for a mid-tier pair too — and the #662 acceptance
            // acknowledgement does NOT substitute (that ack is illiquid-asset
            // identity, not the deliberate per-pair mid-tier attestation strict
            // mode requires). No-op when the acceptor isn't in strict mode.
            if (midTierStrictBlock(s, actor, p)) {
                revert MidTierPairNotAcknowledged(actor, pairKey(p));
            }
            return;
        }
        bytes32 pk = pairKey(p);
        if (_illiquidConsentEffective(s, actor, pk)) return; // standing fresh consent
        // #662 ack-substitution — only with FRESH risk terms (a governance terms
        // bump re-locks the substitution just like a standing consent; Codex #729
        // r1) AND an ack that covers exactly the gate's illiquid legs.
        //
        // TWO freshness anchors, both required (#730): the vault's TIER anchor
        // (`riskTierVersionAt`, refreshed by re-affirming the tier) AND the
        // version named INSIDE the signed acknowledgement (`acceptAckTermsVersion`,
        // injected by `_verifyAndBindAccept`). Anchoring only on the tier let an
        // ack signed before a `bumpRiskTermsVersion` be submitted afterward as
        // fresh per-pair consent once the user refreshed merely their tier (the
        // signature itself was never re-bound to the new terms).
        //
        // The two anchors are DIFFERENT KINDS on purpose (Codex #736 r1+r3):
        //  - the tier anchor is CONTRACT-written (`setVaultRiskTier` stamps it to
        //    the live version), so it is monotonic and can never run ahead — `>=`
        //    on the numeric version is safe and matches the read-time re-lock.
        //  - the ack anchor is SIGNER-controlled (`_verifyAndBindAccept` copies the
        //    acceptor's value verbatim). A NUMERIC version is predictable, so even
        //    an exact `==` lets a UI pre-stamp `N+1` and have the stale ack activate
        //    on the next bump. So the ack binds the UNGUESSABLE `currentRiskTermsHash`
        //    (a commit-reveal random SECRET — `revealRiskTermsBump`, never the public
        //    terms-doc hash) and must match it EXACTLY — a value a pre-signing UI
        //    cannot predict, proving the ack was signed after the live terms were
        //    published.
        if (
            s.riskTierVersionAt[actor] >= s.currentRiskTermsVersion
                && s.acceptAckTermsHash == s.currentRiskTermsHash
                && _ackCoversIlliquidLegs(
                    s, p, ackLend, ackColl, lendAckVerified, collAckVerified
                )
        ) {
            return;
        }
        revert IlliquidPairNotConsented(actor, pk);
    }

    /// @dev True iff the acceptor's #662 acknowledgement names the classification
    ///      asset of EVERY leg this gate deems `IlliquidCustom` — AND that ack was
    ///      actually VERIFIED by the call-site #662 check (`*AckVerified`). Reuses
    ///      `_lendLegLevel` / `_collLegLevel` (the single classification source),
    ///      so a rental's prepay-substituted lend leg (classAsset == prepay) is
    ///      NOT covered by the #662 ack (which names the rented NFT) — that case
    ///      falls through to requiring a standing consent.
    ///
    ///      The `*AckVerified` gate (Codex #729 r3) closes a substitution bypass:
    ///      the #662 check only validates `ack == lendingAsset` for legs it sees
    ///      as `Illiquid` via `checkLiquidity`. A leg that this gate deems
    ///      `IlliquidCustom` for a DIFFERENT reason — a liquid-looking ERC-20
    ///      demoted to effective tier 0, or a rental's illiquid `prepayAsset` — was
    ///      never validated, so its `ack*` slot is attacker-chosen and must NOT be
    ///      allowed to satisfy the equality. Those derived-tier / prepay cases are
    ///      forced back to a standing `illiquidPairConsent`.
    function _ackCoversIlliquidLegs(
        LibVaipakam.Storage storage s,
        PairId memory p,
        address ackLend,
        address ackColl,
        bool lendAckVerified,
        bool collAckVerified
    ) private view returns (bool) {
        (LibVaipakam.RiskAccessLevel lendLvl, address lendClass) =
            _lendLegLevel(s, p);
        if (
            lendLvl == LibVaipakam.RiskAccessLevel.IlliquidCustom
                && !(lendAckVerified && ackLend == lendClass)
        ) {
            return false;
        }
        (LibVaipakam.RiskAccessLevel collLvl, address collClass) =
            _collLegLevel(s, p);
        if (
            collLvl == LibVaipakam.RiskAccessLevel.IlliquidCustom
                && !(collAckVerified && ackColl == collClass)
        ) {
            return false;
        }
        return true;
    }

    /// @notice Non-reverting mirror of `assertActorMayTransact` for dry-run
    ///         surfaces (`OfferAcceptFacet.previewAccept`, Codex #729 r3).
    /// @return 0 = OK, 1 = tier too low, 2 = illiquid pair needs standing consent,
    ///         3 = strict-mode mid-tier pair needs a fresh explicit ack (PR-2d).
    /// @dev    Standing-consent semantics: a preview has no #662 accept ack to
    ///         substitute, so an acceptor who WOULD clear the illiquid boundary by
    ///         acknowledging at sign-time still surfaces code 2 here. That is the
    ///         correct conservative UX hint — the frontend then collects the
    ///         matching acknowledgement (or a standing consent) before enabling
    ///         Accept, rather than the dry-run silently reporting success.
    function previewActorBlock(
        LibVaipakam.Storage storage s,
        address actor,
        PairId memory p
    ) internal view returns (uint8) {
        LibVaipakam.RiskAccessLevel required = _pairRequiredLevel(s, p);
        if (uint8(effectiveTier(s, actor)) < uint8(required)) return 1;
        if (
            required == LibVaipakam.RiskAccessLevel.IlliquidCustom
                && !_illiquidConsentEffective(s, actor, pairKey(p))
        ) {
            return 2;
        }
        // RD-1 strict mode (#728 PR-2d): a strict-mode mid-tier pair lacking a
        // fresh explicit ack would be blocked at origination — surface it so the
        // frontend collects the ack first instead of letting the tx revert.
        if (midTierStrictBlock(s, actor, p)) return 3;
        return 0;
    }

    /// @notice Ack-AWARE variant of {previewActorBlock} for the ACCEPTOR leg of an
    ///         accept preview (#735 item 1). An accept ALWAYS carries the
    ///         acceptor's #662 acknowledgement, so — unlike the conservative
    ///         standing-consent mirror — this models the ack substitution and
    ///         REFINES an illiquid-pair code 2 to code 4 ("the acceptor's standard
    ///         #662 ack, which the dapp's accept-signing flow always produces, WILL
    ///         clear this boundary at sign-time") whenever BOTH hold:
    ///           - the acceptor's TIER anchor is still fresh
    ///             (`riskTierVersionAt >= currentRiskTermsVersion`) — a terms bump
    ///             re-locks the substitution exactly as it re-locks a standing
    ///             consent, so a stale anchor stays a hard code 2; AND
    ///           - every illiquid leg is ACK-COVERABLE under the SAME
    ///             `_ackCoversIlliquidLegs` predicate the gate enforces, fed the
    ///             ack the dapp signs (`ackLend = lendAsset`, `ackColl = collAsset`)
    ///             and the verified flags derived the SAME way the call site does
    ///             (`checkLiquidity(leg) == Illiquid`). The derived-tier-0 and
    ///             rental-prepay legs the gate forces to a standing consent are
    ///             therefore NOT softened — they stay code 2.
    /// @return Same codes as {previewActorBlock} plus 4 (illiquid, but the #662
    ///         ack will cover it — a SOFT warning the dapp may proceed past).
    /// @dev    Codes 1 (tier too low) and 3 (strict mid-tier) are returned
    ///         unchanged — no #662 illiquid ack can heal those. The ack HASH anchor
    ///         (`acceptAckTermsHash == currentRiskTermsHash`) is NOT modeled here:
    ///         there is no signature yet, and the signing flow stamps the LIVE
    ///         `currentRiskTermsHash` immediately before signing, so that anchor
    ///         holds by construction at accept time.
    function previewAcceptorBlockAckAware(
        LibVaipakam.Storage storage s,
        address actor,
        PairId memory p
    ) internal view returns (uint8) {
        uint8 base = previewActorBlock(s, actor, p);
        if (base != 2) return base; // only an illiquid-consent gap can self-heal
        // A terms bump re-locks the ack substitution just like a standing consent
        // (Codex #729 r1); a stale tier anchor can't be cleared by re-signing alone.
        if (s.riskTierVersionAt[actor] < s.currentRiskTermsVersion) return 2;
        if (
            _ackCoversIlliquidLegs(
                s,
                p,
                p.lendAsset, // the dapp acks the literal lending asset…
                p.collAsset, // …and the literal collateral asset
                _legReadsIlliquid(p.lendAsset),
                _legReadsIlliquid(p.collAsset)
            )
        ) {
            return 4;
        }
        return 2;
    }

    /// @dev Models the accept call site's per-leg `*AckVerified` flag: the #662
    ///      check only validates a leg's ack when that leg reads `Illiquid` via
    ///      `OracleFacet.checkLiquidity` (LoanFacet `_maybeRunInitialRiskGates`).
    ///      A zero / non-ERC20 address can't be liquidity-classified, so it is
    ///      treated as unverified (false) rather than reverting the preview.
    function _legReadsIlliquid(address asset) private view returns (bool) {
        if (asset == address(0)) return false;
        return IRiskAccessOracle(address(this)).checkLiquidity(asset)
            == LibVaipakam.LiquidityStatus.Illiquid;
    }

    /// @notice Risk-gate revert reasons (carried in the facet ABI).
    error RiskTierTooLow(address actor, uint8 requiredTier, uint8 actorTier);
    error IlliquidPairNotConsented(address actor, bytes32 pairKey);
    /// @notice RD-1 strict mode (#728 PR-2d) — a vault in (effective) strict mode
    ///         originated a MID-TIER pair without a fresh explicit ack.
    error MidTierPairNotAcknowledged(address actor, bytes32 pairKey);

    // ─────────────────────────────────────────────────────────────────────────
    // EIP-712 self-submit setters
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Opt a vault UP to a tier (or tighten it). Tightening (a lower
    ///         ordinal than currently held) is exempt from the cooldown — a user
    ///         may always reduce their own exposure immediately.
    /// @dev    `termsHash` binds the grant to the UNGUESSABLE risk-terms anchor the
    ///         signer agreed to (#737, replacing the predictable `termsVersion` of
    ///         Codex #727 r1 P1): a `*BySig` submit rejects a signature whose
    ///         `termsHash` != the live `currentRiskTermsHash`, so an old long-deadline
    ///         signature can't be relayed after a terms change to silently
    ///         re-establish freshness. Because the next anchor is hidden behind the
    ///         #730 commit-reveal until activation, a malicious relayer can no longer
    ///         induce a user to PRE-SIGN a future-epoch grant (the numeric version is
    ///         `current + 1` — guessable; the hash is not).
    struct SetVaultRiskTier {
        address vault; // == recovered / 1271 signer
        uint8 level; // target RiskAccessLevel
        bytes32 termsHash; // must == currentRiskTermsHash at submit (#737)
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
        bytes32 termsHash; // must == currentRiskTermsHash at submit (#737)
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice RD-1 strict mode (#728 PR-2d) — relayed toggle of the per-vault
    ///         strict-mode flag. Carries the full signed envelope because turning
    ///         strict mode OFF is a risk-INCREASING privilege change.
    struct SetRiskStrictMode {
        address vault;
        bool enabled;
        bytes32 termsHash; // must == currentRiskTermsHash at submit (#737)
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice RD-1 strict mode (#728 PR-2d) — relayed EXPLICIT mid-tier pair ack.
    ///         Same pair identity as `SetIlliquidPairConsent` (asset types + token
    ///         ids), but records the deliberate mid-tier attestation strict mode
    ///         requires. Always signed + replay-protected + terms-bound, regardless
    ///         of the flag's current value.
    struct SetMidTierPairAck {
        address vault;
        address lendAsset;
        uint8 lendAssetType;
        uint256 lendTokenId;
        address collAsset;
        uint8 collAssetType;
        uint256 collTokenId;
        address prepayAsset;
        bytes32 termsHash; // must == currentRiskTermsHash at submit (#737)
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 internal constant SET_VAULT_RISK_TIER_TYPEHASH = keccak256(
        "SetVaultRiskTier(address vault,uint8 level,bytes32 termsHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant SET_ILLIQUID_PAIR_CONSENT_TYPEHASH = keccak256(
        "SetIlliquidPairConsent(address vault,address lendAsset,uint8 lendAssetType,uint256 lendTokenId,address collAsset,uint8 collAssetType,uint256 collTokenId,address prepayAsset,bool consent,bytes32 termsHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant SET_RISK_STRICT_MODE_TYPEHASH = keccak256(
        "SetRiskStrictMode(address vault,bool enabled,bytes32 termsHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant SET_MID_TIER_PAIR_ACK_TYPEHASH = keccak256(
        "SetMidTierPairAck(address vault,address lendAsset,uint8 lendAssetType,uint256 lendTokenId,address collAsset,uint8 collAssetType,uint256 collTokenId,address prepayAsset,bytes32 termsHash,uint256 nonce,uint256 deadline)"
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
                    m.termsHash,
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
                    abi.encode(m.termsHash, m.nonce, m.deadline)
                )
            )
        );
    }

    function digest(SetRiskStrictMode memory m) internal view returns (bytes32) {
        return _digest(
            keccak256(
                abi.encode(
                    SET_RISK_STRICT_MODE_TYPEHASH,
                    m.vault,
                    m.enabled,
                    m.termsHash,
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
        // Chunked ≤10-value encodes joined by `bytes.concat` (viaIR stack ceiling —
        // same idiom as `SetIlliquidPairConsent`). All fields static EIP-712 types.
        return _digest(
            keccak256(
                bytes.concat(
                    abi.encode(
                        SET_MID_TIER_PAIR_ACK_TYPEHASH,
                        m.vault,
                        m.lendAsset,
                        m.lendAssetType,
                        m.lendTokenId,
                        m.collAsset,
                        m.collAssetType,
                        m.collTokenId,
                        m.prepayAsset
                    ),
                    abi.encode(m.termsHash, m.nonce, m.deadline)
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
