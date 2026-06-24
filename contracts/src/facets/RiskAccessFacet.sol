// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRiskAccess} from "../libraries/LibRiskAccess.sol";
import {LibAccessControl, DiamondAccessControl} from
    "../libraries/LibAccessControl.sol";

/**
 * @title RiskAccessFacet
 * @author Vaipakam Developer Team
 * @notice Self-sovereign progressive risk-access controls (#671 — see
 *         `docs/DesignsAndPlans/ProgressiveRiskAccessDesign.md`). Every vault
 *         starts at the safest tier (`BlueChipOnly`, zero-init) and opts UP only
 *         by its OWNER — either directly (`msg.sender == vault`) or via a gasless
 *         EIP-712 self-submit a relayer forwards (`*BySig`). There is NO
 *         governance allow-list of who may reach a tier; the only admin levers
 *         are the global terms version, the opt-up cooldown, and the
 *         protocol-managed-vault exemption set.
 *
 * @dev    A dedicated facet (not a fold into `ProfileFacet`) keeps the EIP-712
 *         verify path off an already-large facet and within EIP-170. The gate
 *         LOGIC lives in `LibRiskAccess` and is consumed at the transaction
 *         chokepoints (create / accept / match); this facet only WRITES the
 *         per-vault state and exposes views.
 *
 *         The setters are intentionally NOT sanctions-gated: opting a tier is
 *         pure config that moves no funds and creates no position — a sanctioned
 *         wallet is already blocked at the Tier-1 `createOffer` / `acceptOffer`
 *         chokepoints regardless of its recorded tier.
 */
contract RiskAccessFacet is DiamondAccessControl {
    /// @notice Hard ceiling on the opt-up cooldown a governance setter may
    ///         configure, so a mis-set cooldown can never brick opt-ups.
    uint64 internal constant MAX_RISK_UNLOCK_COOLDOWN = 30 days;

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @custom:event-category state-change/risk-access
    event VaultRiskTierSet(address indexed vault, uint8 level);
    /// @custom:event-category state-change/risk-access
    event IlliquidPairConsentSet(
        address indexed vault, bytes32 indexed pairKey, bool consent
    );
    /// @custom:event-category informational/config
    event RiskTermsVersionBumped(uint64 newVersion);
    /// @custom:event-category informational/config
    event RiskAccessUnlockCooldownSet(uint64 cooldownSec);
    /// @custom:event-category informational/config
    event ProtocolManagedVaultSet(address indexed vault, bool managed);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error InvalidRiskLevel(uint8 level);
    error RiskSigExpired(uint256 deadline);
    error RiskNonceUsed(address vault, uint256 nonce);
    error RiskBadSignature(address vault);
    error RiskCooldownTooLong(uint64 requested, uint64 maxAllowed);
    error RiskTermsVersionStale(uint64 signed, uint64 current);

    // ─── User-facing setters: direct (msg.sender == vault) ───────────────────

    /// @notice Set the caller's vault risk tier. Raising the tier (more risk)
    ///         is subject to the opt-up cooldown; lowering it takes effect
    ///         immediately.
    function setVaultRiskTier(uint8 level) external {
        _applyTier(msg.sender, level);
    }

    /// @notice Grant or revoke the caller's explicit consent to a specific
    ///         illiquid pair (required for an `IlliquidCustom` vault). The pair
    ///         identity includes asset types + token ids, so a consent binds to
    ///         the exact NFT, not the whole collection.
    function setIlliquidPairConsent(
        LibRiskAccess.PairId calldata p,
        bool consent
    ) external {
        _applyIlliquidConsent(msg.sender, p, consent);
    }

    // ─── User-facing setters: gasless EIP-712 self-submit (relayed) ──────────

    /// @notice Relayer-submittable tier change. `m.vault` is bound into the
    ///         EIP-712 digest and verified (EOA or ERC-1271), so a relayer can
    ///         pay gas but cannot alter the request.
    function setVaultRiskTierBySig(
        LibRiskAccess.SetVaultRiskTier calldata m,
        bytes calldata sig
    ) external {
        _consumeSig(
            m.vault, m.termsVersion, m.nonce, m.deadline,
            LibRiskAccess.digest(m), sig
        );
        _applyTier(m.vault, m.level);
    }

    /// @notice Relayer-submittable illiquid-pair consent.
    function setIlliquidPairConsentBySig(
        LibRiskAccess.SetIlliquidPairConsent calldata m,
        bytes calldata sig
    ) external {
        _consumeSig(
            m.vault, m.termsVersion, m.nonce, m.deadline,
            LibRiskAccess.digest(m), sig
        );
        _applyIlliquidConsent(m.vault, _pairIdOf(m), m.consent);
    }

    // ─── Admin levers (ADMIN_ROLE → Timelock post-handover) ──────────────────

    /// @notice Bump the global risk-terms version. Read-time re-lock: every
    ///         held tier / consent whose anchor is now stale falls back to the
    ///         safest tier with ZERO per-user writes (see `LibRiskAccess`).
    ///         Used when the terms a user agreed to materially change.
    function bumpRiskTermsVersion()
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
        returns (uint64 newVersion)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        newVersion = ++s.currentRiskTermsVersion;
        emit RiskTermsVersionBumped(newVersion);
    }

    /// @notice Set the opt-up cooldown (seconds). Default 0 ⇒ opt-ups are
    ///         immediate. Bounded by {MAX_RISK_UNLOCK_COOLDOWN}.
    function setRiskAccessUnlockCooldown(uint64 cooldownSec)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (cooldownSec > MAX_RISK_UNLOCK_COOLDOWN) {
            revert RiskCooldownTooLong(cooldownSec, MAX_RISK_UNLOCK_COOLDOWN);
        }
        LibVaipakam.storageSlot().riskAccessUnlockCooldown = cooldownSec;
        emit RiskAccessUnlockCooldownSet(cooldownSec);
    }

    /// @notice Flag (or clear) a protocol-managed vault — sale vehicles /
    ///         backstop — which reports its raw tier without the freshness /
    ///         cooldown gate.
    function setProtocolManagedVault(address vault, bool managed)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolManagedVault[vault] = managed;
        emit ProtocolManagedVaultSet(vault, managed);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    /// @notice The raw opted-in tier (ignores freshness / cooldown).
    function getVaultRiskTier(address vault) external view returns (uint8) {
        return uint8(LibVaipakam.storageSlot().userRiskAccess[vault]);
    }

    /// @notice The currently-effective tier (read-time re-locked).
    function getEffectiveRiskTier(address vault)
        external
        view
        returns (uint8)
    {
        return uint8(
            LibRiskAccess.effectiveTier(LibVaipakam.storageSlot(), vault)
        );
    }

    function getCurrentRiskTermsVersion() external view returns (uint64) {
        return LibVaipakam.storageSlot().currentRiskTermsVersion;
    }

    function getRiskAccessUnlockCooldown() external view returns (uint64) {
        return LibVaipakam.storageSlot().riskAccessUnlockCooldown;
    }

    function getRiskTierUnlockAt(address vault)
        external
        view
        returns (uint64)
    {
        return LibVaipakam.storageSlot().riskTierUnlockAt[vault];
    }

    function isProtocolManagedVault(address vault)
        external
        view
        returns (bool)
    {
        return LibVaipakam.storageSlot().protocolManagedVault[vault];
    }

    function riskAccessNonceUsed(address vault, uint256 nonce)
        external
        view
        returns (bool)
    {
        return LibVaipakam.storageSlot().riskAccessNonceUsed[vault][nonce];
    }

    /// @notice Whether `vault` holds an EFFECTIVE illiquid-pair consent
    ///         (set + version-fresh + arming cooldown elapsed).
    function hasIlliquidPairConsent(
        address vault,
        LibRiskAccess.PairId calldata p
    ) external view returns (bool) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32 pk = LibRiskAccess.pairKey(p);
        return s.illiquidPairConsent[vault][pk]
            && s.illiquidPairVersionAt[vault][pk] >= s.currentRiskTermsVersion
            && block.timestamp >= s.pairConsentUnlockAt[vault][pk];
    }

    /// @notice The minimum tier a vault must hold to transact this pair (the
    ///         riskier of the two legs governs; NFT rentals tier off the
    ///         prepay token). Surfaced so the frontend can pre-flight the gate.
    function pairRequiredRiskLevel(LibRiskAccess.PairId calldata p)
        external
        view
        returns (uint8)
    {
        return uint8(
            LibRiskAccess._pairRequiredLevel(LibVaipakam.storageSlot(), p)
        );
    }

    /// @notice Non-reverting mirror of the accept-time risk gate for
    ///         `OfferAcceptFacet.previewAccept`'s dry-run (Codex #729 r3 finding
    ///         C): classifies BOTH the offer creator (re-gated at accept) and the
    ///         `acceptor` candidate against the offer's asset pair, returning the
    ///         FIRST failing block code.
    /// @return 0 = OK (or gate off / sale vehicle), 1 = tier too low,
    ///         2 = illiquid pair needs standing consent.
    /// @dev    The WHOLE decision lives HERE, not in OfferAcceptFacet: that facet
    ///         sits at the EIP-170 ceiling, and the classification chain
    ///         (`previewActorBlock` → `_pairRequiredLevel` → `_isBlueChip` …) is
    ///         already linked into RiskAccessFacet. It even folds in the master-
    ///         switch + sale-vehicle skip so OfferAcceptFacet pays for a single
    ///         staticcall and a two-way branch. Builds the PairId from the offer
    ///         the SAME way `LoanFacet._maybeRunInitialRiskGates` does so the
    ///         preview and the accept gate classify identically. Standing-consent
    ///         semantics (a preview has no #662 ack to substitute) — see
    ///         `LibRiskAccess.previewActorBlock`. Sale vehicles return 0 here:
    ///         their accept gates the buyer against the LINKED loan's pair, which
    ///         the preview does not model.
    function previewOfferAcceptBlock(uint256 offerId, address acceptor)
        external
        view
        returns (uint8)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (
            !LibVaipakam.cfgRiskAccessGateEnabled()
                || s.saleOfferToLoanId[offerId] != 0
        ) {
            return 0;
        }
        LibVaipakam.Offer storage o = s.offers[offerId];
        LibRiskAccess.PairId memory pair = LibRiskAccess.PairId({
            lendAsset: o.lendingAsset,
            lendType: o.assetType,
            lendTokenId: o.tokenId,
            collAsset: o.collateralAsset,
            collType: o.collateralAssetType,
            collTokenId: o.collateralTokenId,
            prepayAsset: o.prepayAsset
        });
        uint8 creatorBlock = LibRiskAccess.previewActorBlock(s, o.creator, pair);
        if (creatorBlock != 0) return creatorBlock;
        return LibRiskAccess.previewActorBlock(s, acceptor, pair);
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    function _applyTier(address vault, uint8 level) private {
        if (level > uint8(LibVaipakam.RiskAccessLevel.IlliquidCustom)) {
            revert InvalidRiskLevel(level);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RiskAccessLevel newLevel =
            LibVaipakam.RiskAccessLevel(level);
        // Compare against the currently EFFECTIVE tier, NOT the raw stored one
        // (Codex #727 r1 P1): re-submitting an already-stored-but-locked high
        // tier (during its cooldown, or after a terms bump re-locked it) would
        // otherwise clear the cooldown via the "same level" branch.
        LibVaipakam.RiskAccessLevel effCur =
            LibRiskAccess.effectiveTier(s, vault);
        s.userRiskAccess[vault] = newLevel;
        // Re-stamp the version anchor to the live terms so the new tier is fresh.
        s.riskTierVersionAt[vault] = s.currentRiskTermsVersion;
        if (uint8(newLevel) > uint8(effCur)) {
            // RAISING risk: arm the cooldown, and keep the PRIOR effective tier
            // available meanwhile so the vault never transiently drops below the
            // access it already held (Codex #727 r4 P2).
            s.riskTierSettled[vault] = effCur;
            s.riskTierUnlockAt[vault] =
                uint64(block.timestamp) + s.riskAccessUnlockCooldown;
        } else {
            // Tightening / same: immediate, and the settled floor tracks it.
            s.riskTierSettled[vault] = newLevel;
            s.riskTierUnlockAt[vault] = uint64(block.timestamp);
        }
        emit VaultRiskTierSet(vault, level);
    }

    function _applyIlliquidConsent(
        address vault,
        LibRiskAccess.PairId memory p,
        bool consent
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32 pk = LibRiskAccess.pairKey(p);
        s.illiquidPairConsent[vault][pk] = consent;
        // Stamp the live version + arm the cooldown on a GRANT; a revoke needs no
        // fresh stamp (it only ever tightens — exempt from the stale-check).
        if (consent) {
            s.illiquidPairVersionAt[vault][pk] = s.currentRiskTermsVersion;
            s.pairConsentUnlockAt[vault][pk] =
                uint64(block.timestamp) + s.riskAccessUnlockCooldown;
        }
        emit IlliquidPairConsentSet(vault, pk, consent);
    }

    /// @dev Map a signed illiquid-consent message onto the canonical `PairId`.
    function _pairIdOf(LibRiskAccess.SetIlliquidPairConsent calldata m)
        private
        pure
        returns (LibRiskAccess.PairId memory)
    {
        return LibRiskAccess.PairId({
            lendAsset: m.lendAsset,
            lendType: LibVaipakam.AssetType(m.lendAssetType),
            lendTokenId: m.lendTokenId,
            collAsset: m.collAsset,
            collType: LibVaipakam.AssetType(m.collAssetType),
            collTokenId: m.collTokenId,
            prepayAsset: m.prepayAsset
        });
    }

    function _consumeSig(
        address vault,
        uint64 termsVersion,
        uint256 nonce,
        uint256 deadline,
        bytes32 digest,
        bytes calldata sig
    ) private {
        if (block.timestamp > deadline) revert RiskSigExpired(deadline);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Bind the grant to the terms version the signer agreed to (Codex #727
        // r1 P1): a stale signature can't be relayed after a terms bump.
        if (termsVersion != s.currentRiskTermsVersion) {
            revert RiskTermsVersionStale(termsVersion, s.currentRiskTermsVersion);
        }
        if (s.riskAccessNonceUsed[vault][nonce]) {
            revert RiskNonceUsed(vault, nonce);
        }
        if (!LibRiskAccess.verify(vault, digest, sig)) {
            revert RiskBadSignature(vault);
        }
        s.riskAccessNonceUsed[vault][nonce] = true;
    }
}
