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
    /// @custom:event-category state-change/risk-access
    event MidTierPairAckSet(
        address indexed vault, bytes32 indexed pairKey, bool ack
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

    // ─── User-facing setters: direct (msg.sender == vault) ───────────────────

    /// @notice Set the caller's vault risk tier. Raising the tier (more risk)
    ///         is subject to the opt-up cooldown; lowering it takes effect
    ///         immediately.
    function setVaultRiskTier(uint8 level) external {
        _applyTier(msg.sender, level);
    }

    /// @notice Grant or revoke the caller's explicit consent to a specific
    ///         illiquid pair (required for an `IlliquidCustom` vault).
    function setIlliquidPairConsent(
        address lendAsset,
        address collAsset,
        address prepayAsset,
        bool consent
    ) external {
        _applyIlliquidConsent(
            msg.sender, lendAsset, collAsset, prepayAsset, consent
        );
    }

    /// @notice Grant or revoke the caller's one-time mid-tier acknowledgement
    ///         for a specific pair (required for a `BroadLiquid` vault).
    function setMidTierPairAck(
        address lendAsset,
        address collAsset,
        address prepayAsset,
        bool ack
    ) external {
        _applyMidTierAck(msg.sender, lendAsset, collAsset, prepayAsset, ack);
    }

    // ─── User-facing setters: gasless EIP-712 self-submit (relayed) ──────────

    /// @notice Relayer-submittable tier change. `m.vault` is bound into the
    ///         EIP-712 digest and verified (EOA or ERC-1271), so a relayer can
    ///         pay gas but cannot alter the request.
    function setVaultRiskTierBySig(
        LibRiskAccess.SetVaultRiskTier calldata m,
        bytes calldata sig
    ) external {
        _consumeSig(m.vault, m.nonce, m.deadline, LibRiskAccess.digest(m), sig);
        _applyTier(m.vault, m.level);
    }

    /// @notice Relayer-submittable illiquid-pair consent.
    function setIlliquidPairConsentBySig(
        LibRiskAccess.SetIlliquidPairConsent calldata m,
        bytes calldata sig
    ) external {
        _consumeSig(m.vault, m.nonce, m.deadline, LibRiskAccess.digest(m), sig);
        _applyIlliquidConsent(
            m.vault, m.lendAsset, m.collAsset, m.prepayAsset, m.consent
        );
    }

    /// @notice Relayer-submittable mid-tier acknowledgement.
    function setMidTierPairAckBySig(
        LibRiskAccess.SetMidTierPairAck calldata m,
        bytes calldata sig
    ) external {
        _consumeSig(m.vault, m.nonce, m.deadline, LibRiskAccess.digest(m), sig);
        _applyMidTierAck(
            m.vault, m.lendAsset, m.collAsset, m.prepayAsset, m.ack
        );
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

    /// @notice Whether `vault` holds a (version-fresh) illiquid-pair consent.
    function hasIlliquidPairConsent(
        address vault,
        address lendAsset,
        address collAsset,
        address prepayAsset
    ) external view returns (bool) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32 pk =
            LibRiskAccess.pairKey(lendAsset, collAsset, prepayAsset);
        return s.illiquidPairConsent[vault][pk]
            && s.illiquidPairVersionAt[vault][pk] >= s.currentRiskTermsVersion;
    }

    /// @notice Whether `vault` holds a (version-fresh) mid-tier acknowledgement.
    function hasMidTierPairAck(
        address vault,
        address lendAsset,
        address collAsset,
        address prepayAsset
    ) external view returns (bool) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32 pk =
            LibRiskAccess.pairKey(lendAsset, collAsset, prepayAsset);
        return s.midTierPairAck[vault][pk]
            && s.midTierVersionAt[vault][pk] >= s.currentRiskTermsVersion;
    }

    /// @notice The minimum tier a vault must hold to transact this pair (the
    ///         riskier of the two legs governs; NFT rentals tier off the
    ///         prepay token). Surfaced so the frontend can pre-flight the gate.
    function pairRequiredRiskLevel(
        address lendAsset,
        uint8 lendType,
        address collAsset,
        uint8 collType,
        address prepayAsset
    ) external view returns (uint8) {
        return uint8(
            LibRiskAccess._pairRequiredLevel(
                LibVaipakam.storageSlot(),
                lendAsset,
                LibVaipakam.AssetType(lendType),
                collAsset,
                LibVaipakam.AssetType(collType),
                prepayAsset
            )
        );
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    function _applyTier(address vault, uint8 level) private {
        if (level > uint8(LibVaipakam.RiskAccessLevel.IlliquidCustom)) {
            revert InvalidRiskLevel(level);
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RiskAccessLevel newLevel =
            LibVaipakam.RiskAccessLevel(level);
        LibVaipakam.RiskAccessLevel current = s.userRiskAccess[vault];
        s.userRiskAccess[vault] = newLevel;
        // Always re-stamp the version anchor to the live terms so the new tier
        // is fresh.
        s.riskTierVersionAt[vault] = s.currentRiskTermsVersion;
        // Cooldown applies only to RAISING risk; tightening is immediate.
        s.riskTierUnlockAt[vault] = uint8(newLevel) > uint8(current)
            ? uint64(block.timestamp) + s.riskAccessUnlockCooldown
            : uint64(block.timestamp);
        emit VaultRiskTierSet(vault, level);
    }

    function _applyIlliquidConsent(
        address vault,
        address lendAsset,
        address collAsset,
        address prepayAsset,
        bool consent
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32 pk =
            LibRiskAccess.pairKey(lendAsset, collAsset, prepayAsset);
        s.illiquidPairConsent[vault][pk] = consent;
        // Stamp the live version on a grant; a revoke needs no fresh stamp (it
        // only ever tightens — exempt from the stale-check per the design).
        if (consent) {
            s.illiquidPairVersionAt[vault][pk] = s.currentRiskTermsVersion;
        }
        emit IlliquidPairConsentSet(vault, pk, consent);
    }

    function _applyMidTierAck(
        address vault,
        address lendAsset,
        address collAsset,
        address prepayAsset,
        bool ack
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32 pk =
            LibRiskAccess.pairKey(lendAsset, collAsset, prepayAsset);
        s.midTierPairAck[vault][pk] = ack;
        if (ack) {
            s.midTierVersionAt[vault][pk] = s.currentRiskTermsVersion;
        }
        emit MidTierPairAckSet(vault, pk, ack);
    }

    function _consumeSig(
        address vault,
        uint256 nonce,
        uint256 deadline,
        bytes32 digest,
        bytes calldata sig
    ) private {
        if (block.timestamp > deadline) revert RiskSigExpired(deadline);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.riskAccessNonceUsed[vault][nonce]) {
            revert RiskNonceUsed(vault, nonce);
        }
        if (!LibRiskAccess.verify(vault, digest, sig)) {
            revert RiskBadSignature(vault);
        }
        s.riskAccessNonceUsed[vault][nonce] = true;
    }
}
