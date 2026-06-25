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
    event RiskTermsVersionBumped(uint64 newVersion, bytes32 newTermsHash);
    /// @custom:event-category informational/config
    event RiskTermsBumpCommitted(bytes32 commitment);
    /// @custom:event-category informational/config
    event RiskAccessUnlockCooldownSet(uint64 cooldownSec);
    /// @custom:event-category informational/config
    event ProtocolManagedVaultSet(address indexed vault, bool managed);
    /// @notice RD-1 strict mode (#728 PR-2d).
    /// @custom:event-category state-change/risk-access
    event RiskStrictModeSet(address indexed vault, bool enabled);
    /// @custom:event-category state-change/risk-access
    event MidTierPairAckSet(address indexed vault, bytes32 indexed pairKey);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error InvalidRiskLevel(uint8 level);
    error RiskSigExpired(uint256 deadline);
    error RiskNonceUsed(address vault, uint256 nonce);
    error RiskBadSignature(address vault);
    error RiskCooldownTooLong(uint64 requested, uint64 maxAllowed);
    error RiskTermsVersionStale(uint64 signed, uint64 current);
    /// @notice The revealed terms hash was zero or unchanged from the live one
    ///         (#730) — every change must publish a fresh, non-zero anchor.
    error InvalidRiskTermsHash();
    /// @notice `revealRiskTermsBump` was called with no pending commitment (#730).
    error NoPendingRiskTermsCommitment();
    /// @notice The revealed `(hash, salt)` did not match the pending commitment
    ///         (#730).
    error RiskTermsRevealMismatch();
    /// @notice The revealed terms hash was already published once (#730) — each
    ///         hash is single-use, so rolling terms A→B→A can't revive a stale ack.
    error RiskTermsHashAlreadyUsed();

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

    // ─── RD-1 strict mode (#728 PR-2d) ───────────────────────────────────────

    /// @notice Opt the caller's vault INTO or OUT of strict mode. In strict mode
    ///         the origination gate requires a fresh EXPLICIT per-pair ack
    ///         ({setMidTierPairAck}) for every mid-tier (BroadLiquid) pair too,
    ///         not just illiquid ones. Enabling is immediate (risk-reducing);
    ///         disabling stamps a cooldown anchor so the mid-tier ack requirement
    ///         lingers for `riskAccessUnlockCooldown` (zero by default ⇒ immediate),
    ///         closing the disable→exploit window.
    function setRiskStrictMode(bool enabled) external {
        _applyStrictMode(msg.sender, enabled);
    }

    /// @notice Relayer-submittable strict-mode toggle. Carries the full signed
    ///         envelope because the OFF direction is risk-increasing.
    function setRiskStrictModeBySig(
        LibRiskAccess.SetRiskStrictMode calldata m,
        bytes calldata sig
    ) external {
        _consumeSig(
            m.vault, m.termsVersion, m.nonce, m.deadline,
            LibRiskAccess.digest(m), sig
        );
        _applyStrictMode(m.vault, m.enabled);
    }

    /// @notice Record the caller's EXPLICIT acknowledgement of a specific mid-tier
    ///         pair (the strict-mode prerequisite). Carries the full pair identity
    ///         so it binds to the exact assets the signer reviewed. Stamps the live
    ///         terms version, so a later terms bump re-locks it.
    function setMidTierPairAck(LibRiskAccess.PairId calldata p) external {
        _applyMidTierAck(msg.sender, p);
    }

    /// @notice Relayer-submittable explicit mid-tier pair ack.
    function setMidTierPairAckBySig(
        LibRiskAccess.SetMidTierPairAck calldata m,
        bytes calldata sig
    ) external {
        _consumeSig(
            m.vault, m.termsVersion, m.nonce, m.deadline,
            LibRiskAccess.digest(m), sig
        );
        _applyMidTierAck(m.vault, _midTierPairIdOf(m));
    }

    // ─── Admin levers (ADMIN_ROLE → Timelock post-handover) ──────────────────

    /// @notice STEP 1 of a risk-terms change (#730 commit-reveal — see
    ///         `docs/DesignsAndPlans/AcceptAckFreshnessAnchorDesign.md`). Records a
    ///         HIDING commitment to the next anchor; reveals nothing about it.
    /// @dev    Held by `ADMIN_ROLE` (the slow / timelock-governed authority): the
    ///         *decision* to change terms is reviewable, but `commitment =
    ///         keccak256(abi.encode(termsAnchor))` is preimage-hiding, so the future
    ///         anchor is NOT exposed in the timelock's public queued calldata —
    ///         closing the pre-sign attack a cleartext anchor argument left open
    ///         (Codex #736 r5). A new commit supersedes any un-revealed one (lets
    ///         governance cancel/replace a queued change). The version + anchor only
    ///         move at {revealRiskTermsBump}.
    /// @param  commitment `keccak256(abi.encode(termsAnchor))`.
    function commitRiskTermsBump(bytes32 commitment)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        // Reject both the zero commitment AND a commitment to the zero anchor
        // (`keccak256(abi.encode(bytes32(0)))`) — the latter would only be caught
        // at reveal (anchor != 0), wasting a governance commit; fail fast (#736 r13).
        if (
            commitment == bytes32(0)
                || commitment == keccak256(abi.encode(bytes32(0)))
        ) {
            revert InvalidRiskTermsHash();
        }
        LibVaipakam.storageSlot().pendingRiskTermsCommitment = commitment;
        emit RiskTermsBumpCommitted(commitment);
    }

    /// @notice STEP 2 of a risk-terms change (#730 commit-reveal). Reveals the
    ///         committed anchor and atomically bumps the version + publishes it.
    ///         Read-time re-lock: every held tier / consent whose anchor is now
    ///         stale falls back to the safest tier with ZERO per-user writes (see
    ///         `LibRiskAccess`).
    /// @dev    Held by `PAUSER_ROLE` — the OFF-TIMELOCK operational guardian role,
    ///         deliberately NOT one of the roles `TransferAdminToTimelock` migrates
    ///         to the 48h timelock (`ADMIN/ORACLE/RISK/VAULT_ADMIN`). `RISK_ADMIN_ROLE`
    ///         can't be used: it IS migrated to the timelock, so a reveal queued
    ///         through it would expose the secret for the delay (Codex #736 r7). The
    ///         publisher's power is BOUNDED — it can only reveal what `ADMIN` already
    ///         committed, never choose the anchor — so reusing the guardian role is
    ///         low-blast-radius. The secret `termsAnchor` is exposed only in this
    ///         tx's brief mempool window, and the reveal IS the activation (atomic).
    ///
    ///         `termsAnchor` is a fresh RANDOM SECRET, NOT the published risk-terms
    ///         document hash (Codex #736 r7): a doc hash is public once the document
    ///         is published for review, so binding to it would be pre-stampable. The
    ///         document hash is published SEPARATELY (off-chain); the on-chain anchor
    ///         is this unguessable secret. It becomes `currentRiskTermsHash`, the
    ///         value the signer-controlled #662 accept ack binds; required non-zero
    ///         and never-before-used (single-use, #736 r6) so every change re-locks
    ///         and rolling A→B→A can't revive a stale ack. The numeric version stays
    ///         the anchor for the contract-written tier / consent freshness.
    ///
    ///         MULTI-CHAIN (Codex #736 r13): governance MUST use a fresh, INDEPENDENT
    ///         secret per diamond/chain. The same secret cannot mix in a per-chain
    ///         value on-chain (chainid / `address(this)` are public, so any
    ///         derivation is computable), so reusing one anchor across chains and
    ///         revealing at different times would leak it from the first chain's
    ///         reveal and let it be pre-stamped on chains where it is still pending.
    ///         (The accept ack is already domain-bound to one diamond+chainid, so a
    ///         signed ack never cross-replays; this is purely about the SECRET's
    ///         reuse.) An operational requirement on the terms-publisher.
    /// @param  termsAnchor The secret anchor preimage of the pending commitment.
    function revealRiskTermsBump(bytes32 termsAnchor)
        external
        onlyRole(LibAccessControl.PAUSER_ROLE)
        returns (uint64 newVersion)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32 pending = s.pendingRiskTermsCommitment;
        if (pending == bytes32(0)) revert NoPendingRiskTermsCommitment();
        if (keccak256(abi.encode(termsAnchor)) != pending) {
            revert RiskTermsRevealMismatch();
        }
        if (termsAnchor == bytes32(0)) revert InvalidRiskTermsHash();
        // #736 r7+r8 — seed the OUTGOING live anchor into the single-use ledger
        // FIRST, BEFORE the used-check, so re-publishing the live anchor is rejected
        // every time — including the first reveal on a diamond upgraded from a
        // pre-ledger #730 build whose live anchor predates `riskTermsHashUsed`
        // (otherwise that reveal could re-publish the live hash, advancing the
        // version without re-locking). Normally idempotent.
        if (s.currentRiskTermsHash != bytes32(0)) {
            s.riskTermsHashUsed[s.currentRiskTermsHash] = true;
        }
        if (s.riskTermsHashUsed[termsAnchor]) revert RiskTermsHashAlreadyUsed();
        delete s.pendingRiskTermsCommitment;
        s.riskTermsHashUsed[termsAnchor] = true;
        newVersion = ++s.currentRiskTermsVersion;
        s.currentRiskTermsHash = termsAnchor;
        emit RiskTermsVersionBumped(newVersion, termsAnchor);
    }

    /// @notice The live risk-terms anchor the current #662 accept ack must bind
    ///         (#730). Zero before the first reveal. The dapp reads this to stamp
    ///         `AcceptTerms.riskTermsHash`.
    function getCurrentRiskTermsHash() external view returns (bytes32) {
        return LibVaipakam.storageSlot().currentRiskTermsHash;
    }

    /// @notice The pending (un-revealed) risk-terms commitment, or zero if none.
    ///         Ops visibility only — reveals nothing about the future hash.
    function getPendingRiskTermsCommitment() external view returns (bytes32) {
        return LibVaipakam.storageSlot().pendingRiskTermsCommitment;
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

    /// @notice The risk-terms version a vault's TIER opt-in was last anchored to
    ///         (#735). The gate honours the opted-in tier only while this is fresh
    ///         (`>= currentRiskTermsVersion`); a governance terms bump leaves it
    ///         stale until the vault re-affirms its tier. The dapp reads this
    ///         alongside `getCurrentRiskTermsVersion` + `getRiskTierUnlockAt` to tell
    ///         a tier that is merely COOLING DOWN (raise cooldown not yet elapsed)
    ///         from one made STALE by a terms bump — the latter offering an
    ///         in-place "re-affirm" instead of forcing a lower-then-raise.
    function getVaultRiskTierVersion(address vault)
        external
        view
        returns (uint64)
    {
        return LibVaipakam.storageSlot().riskTierVersionAt[vault];
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

    // ─── RD-1 strict mode views (#728 PR-2d) ─────────────────────────────────

    /// @notice The raw strict-mode flag (ignores the disable-cooldown).
    function getRiskStrictMode(address vault) external view returns (bool) {
        return LibVaipakam.storageSlot().riskStrictMode[vault];
    }

    /// @notice The strict-mode disable-linger EXPIRY (absolute timestamp the
    ///         vault stops being treated as strict after a disable; 0 if never
    ///         disabled / re-enabled). Frozen at disable-time.
    function getStrictModeStrictUntil(address vault)
        external
        view
        returns (uint64)
    {
        return LibVaipakam.storageSlot().strictModeStrictUntil[vault];
    }

    /// @notice Whether a strict-mode mid-tier origination of `p` by `vault` WOULD
    ///         be blocked right now (effective strict mode + no fresh, armed
    ///         explicit ack). False for non-mid-tier pairs, and false when the
    ///         master gate is off (Codex #733 P3 — the gate isn't enforced then,
    ///         so the view must not report a phantom block). Lets the frontend
    ///         collect the ack before submitting.
    function midTierStrictBlocked(
        address vault,
        LibRiskAccess.PairId calldata p
    ) external view returns (bool) {
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return false;
        return LibRiskAccess.midTierStrictBlock(
            LibVaipakam.storageSlot(), vault, p
        );
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
    ///         C; sale-offer handling r4): returns the FIRST failing block code.
    /// @return 0 = OK (or gate off), 1 = tier too low,
    ///         2 = illiquid pair needs standing consent (the acceptor's #662 ack
    ///             cannot cover it — a creator-side gap, a rental-prepay / derived-
    ///             tier-0 leg, or a stale tier anchor),
    ///         3 = strict-mode mid-tier pair needs a fresh explicit ack (PR-2d),
    ///         4 = #735 — illiquid pair, but the ACCEPTOR's standard #662
    ///             acknowledgement (always produced by the accept-signing flow)
    ///             WILL clear it at sign-time; a SOFT warning the dapp proceeds
    ///             past, NOT a hard block.
    /// @dev    The WHOLE decision lives HERE, not in OfferAcceptFacet: that facet
    ///         sits at the EIP-170 ceiling, and the classification chain
    ///         (`previewActorBlock` → `_pairRequiredLevel` → `_isBlueChip` …) is
    ///         already linked into RiskAccessFacet. It even folds in the master-
    ///         switch so OfferAcceptFacet pays for a single staticcall and a
    ///         two-way branch. Builds the PairId the SAME way the matching accept
    ///         gate does so the preview and the gate classify identically.
    ///
    ///         #735 item 1 — the ACCEPTOR leg is evaluated ack-AWARE
    ///         (`previewAcceptorBlockAckAware`): an accept always carries the
    ///         acceptor's #662 ack, so modeling it lets the dapp soft-warn (code 4)
    ///         on the common illiquid-accept the ack self-heals instead of hard-
    ///         blocking every illiquid pair. The CREATOR leg stays standing-consent
    ///         only (it authors no accept ack — see `previewActorBlock`), and the
    ///         lender-sale-vehicle branch stays conservative (the buyer's #662 ack
    ///         is derived from the sale offer, not the linked loan's pair, so
    ///         softening it is out of scope here — never a false soften).
    ///
    ///         Two shapes (mirroring `LoanFacet._maybeRunInitialRiskGates`):
    ///          - **lender-sale vehicle** (`saleOfferToLoanId[offerId] != 0`): the
    ///            accept gates only the BUYER (the `acceptor`) against the LINKED
    ///            loan's pair — the exiting seller is exempt — so the preview does
    ///            the same (Codex #729 r4: NOT a blanket `return 0`, which would
    ///            quote an under-tiered sale buyer as OK);
    ///          - **normal offer**: the creator (re-gated at accept) then the
    ///            acceptor against the offer's own pair.
    function previewOfferAcceptBlock(uint256 offerId, address acceptor)
        external
        view
        returns (uint8)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return 0;
        uint256 saleLoanId = s.saleOfferToLoanId[offerId];
        if (saleLoanId != 0) {
            LibVaipakam.Loan storage sold = s.loans[saleLoanId];
            return LibRiskAccess.previewActorBlock(
                s,
                acceptor, // the buyer = incoming lender on the sale vehicle
                LibRiskAccess.PairId({
                    lendAsset: sold.principalAsset,
                    lendType: sold.assetType,
                    lendTokenId: sold.tokenId,
                    collAsset: sold.collateralAsset,
                    collType: sold.collateralAssetType,
                    collTokenId: sold.collateralTokenId,
                    prepayAsset: sold.prepayAsset
                })
            );
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
        // #735 item 1 — the acceptor leg is ack-aware: an accept always carries
        // the acceptor's #662 ack, so an illiquid pair the ack self-heals reports
        // code 4 (soft) instead of code 2 (hard).
        return LibRiskAccess.previewAcceptorBlockAckAware(s, acceptor, pair);
    }

    /// @notice #671 phase 2 (#728 PR-2c) — assert the INCOMING borrower of a
    ///         Preclose Option-2 obligation transfer may take on the resulting
    ///         loan's pair. Reverts `RiskTierTooLow` / `IlliquidPairNotConsented`
    ///         (from `LibRiskAccess`) when the incoming borrower's live vault tier
    ///         or standing illiquid-pair consent does not cover the position he
    ///         is assuming; no-op when the gate is off. Standing consent only —
    ///         this is not an accept flow, so there is no #662 acknowledgement to
    ///         substitute.
    /// @dev    A cross-facet entrypoint consumed by `PrecloseFacet.
    ///         transferObligationViaOffer`. PrecloseFacet sits at the EIP-170
    ///         ceiling, so the PairId construction lives here rather than inline
    ///         in that facet. The gated party is the offer's creator (the new
    ///         borrower the transfer installs). The pair is the POST-TRANSFER
    ///         loan: the lend leg stays the loan's principal, but the collateral
    ///         leg is taken from the BORROWER OFFER — `transferObligationViaOffer`
    ///         reassigns `loan.collateralTokenId = offer.collateralTokenId`, and
    ///         `assertAssetContinuity` pins the collateral asset/type/prepay but
    ///         NOT the token id, so an NFT-collateral transfer can install a
    ///         DIFFERENT token id than the loan currently holds. Classifying off
    ///         the offer's collateral id keeps the illiquid-pair consent key bound
    ///         to the collateral the new borrower actually backs. Reads-only +
    ///         reverts; safe to call via the diamond fallback from the
    ///         (non-reentrant) transfer flow.
    /// @param loanId The loan whose obligation is being transferred.
    /// @param borrowerOfferId The borrower offer being consumed; its creator is
    ///        the incoming borrower and its collateral leg is what backs the loan.
    function assertObligationTransferAllowed(
        uint256 loanId,
        uint256 borrowerOfferId
    ) external view {
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.Offer storage offer = s.offers[borrowerOfferId];
        LibRiskAccess.assertActorMayTransact(
            s,
            offer.creator,
            LibRiskAccess.PairId({
                lendAsset: loan.principalAsset,
                lendType: loan.assetType,
                lendTokenId: loan.tokenId,
                collAsset: offer.collateralAsset,
                collType: offer.collateralAssetType,
                collTokenId: offer.collateralTokenId,
                prepayAsset: offer.prepayAsset
            })
        );
    }

    /// @notice #671 phase 2 (#728 PR-2b) — assert a keeper match's risk-access.
    ///         Reverts `RiskTierTooLow` / `IlliquidPairNotConsented` when a gated
    ///         party's live tier / standing consent doesn't cover the resulting
    ///         loan's pair; no-op when the gate is off. Standing consent only —
    ///         a keeper match authors no #662 acknowledgement to substitute.
    /// @dev    Cross-facet entrypoint consumed by `OfferMatchFacet._executeMatch`
    ///         (which is near the EIP-170 ceiling, so the classifier lives here).
    ///         The gated parties + pair come from {_resolveMatchActors}: a normal
    ///         match gates BOTH creators against the borrower offer's pair; a
    ///         lender-sale vehicle exempts the exiting seller and gates only the
    ///         buyer against the linked loan's pair.
    function assertMatchAllowed(uint256 lenderOfferId, uint256 borrowerOfferId)
        external
        view
    {
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (
            address actorA,
            address actorB,
            LibRiskAccess.PairId memory pair
        ) = _resolveMatchActors(s, lenderOfferId, borrowerOfferId);
        LibRiskAccess.assertActorMayTransact(s, actorA, pair);
        if (actorB != address(0)) {
            LibRiskAccess.assertActorMayTransact(s, actorB, pair);
        }
    }

    /// @notice #671 phase 2 (#728 PR-2b) — NON-reverting risk preview for a
    ///         candidate keeper match, so a bot can filter a pair the gate would
    ///         reject instead of burning gas on a reverting `matchOffers`.
    ///         Returns 0 = OK, 1 = a gated party's tier is too low, 2 = an
    ///         illiquid pair lacks standing consent, 3 = a strict-mode mid-tier
    ///         pair needs a fresh explicit ack (same codes as
    ///         {previewOfferAcceptBlock}). 0 when the gate is off. The block of
    ///         the FIRST failing gated party (buyer/lender side first) is
    ///         reported.
    function previewMatchRiskBlock(uint256 lenderOfferId, uint256 borrowerOfferId)
        external
        view
        returns (uint8)
    {
        if (!LibVaipakam.cfgRiskAccessGateEnabled()) return 0;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (
            address actorA,
            address actorB,
            LibRiskAccess.PairId memory pair
        ) = _resolveMatchActors(s, lenderOfferId, borrowerOfferId);
        uint8 a = LibRiskAccess.previewActorBlock(s, actorA, pair);
        if (a != 0) return a;
        if (actorB != address(0)) {
            return LibRiskAccess.previewActorBlock(s, actorB, pair);
        }
        return 0;
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    /// @dev Resolve the gated parties + the pair they are gated against for a
    ///      keeper match — the single source of truth shared by the enforcing
    ///      {assertMatchAllowed} and the non-reverting {previewMatchRiskBlock}.
    ///      `actorA` is always gated; `actorB` is gated only when non-zero.
    ///
    ///      NORMAL match: `_executeMatch` calls `acceptOfferInternal(borrowerOfferId)`,
    ///      so the resulting loan copies its `tokenId` / `collateralTokenId` /
    ///      `prepayAsset` from the BORROWER offer (the match-time asset check pins
    ///      only the asset contracts + types, not those ids). Both creators are
    ///      therefore gated against the BORROWER offer's pair — the actual loan —
    ///      so the lender consents to the pair it joins, not its own offer's
    ///      possibly-different one. actorA = lender-offer creator, actorB =
    ///      borrower-offer creator.
    ///
    ///      LENDER-SALE vehicle (borrower offer linked via `saleOfferToLoanId`):
    ///      the exiting seller (borrower-offer creator) is EXEMPT — that risk was
    ///      accepted at the original loan — and only the BUYER (the lender-offer
    ///      creator, who acquires the sold lender position) is gated, against the
    ///      LINKED loan's pair. Mirrors `LoanFacet._maybeRunInitialRiskGates`'s
    ///      sale-vehicle branch + the PR-2a sale-buyer treatment. actorA = buyer,
    ///      actorB = address(0).
    function _resolveMatchActors(
        LibVaipakam.Storage storage s,
        uint256 lenderOfferId,
        uint256 borrowerOfferId
    )
        private
        view
        returns (address actorA, address actorB, LibRiskAccess.PairId memory pair)
    {
        uint256 soldLoanId = s.saleOfferToLoanId[borrowerOfferId];
        if (soldLoanId != 0) {
            LibVaipakam.Loan storage sold = s.loans[soldLoanId];
            actorA = s.offers[lenderOfferId].creator; // buyer (incoming lender)
            actorB = address(0); // seller exempt
            pair = LibRiskAccess.PairId({
                lendAsset: sold.principalAsset,
                lendType: sold.assetType,
                lendTokenId: sold.tokenId,
                collAsset: sold.collateralAsset,
                collType: sold.collateralAssetType,
                collTokenId: sold.collateralTokenId,
                prepayAsset: sold.prepayAsset
            });
            return (actorA, actorB, pair);
        }
        LibVaipakam.Offer storage bo = s.offers[borrowerOfferId];
        actorA = s.offers[lenderOfferId].creator;
        actorB = bo.creator;
        pair = LibRiskAccess.PairId({
            lendAsset: bo.lendingAsset,
            lendType: bo.assetType,
            lendTokenId: bo.tokenId,
            collAsset: bo.collateralAsset,
            collType: bo.collateralAssetType,
            collTokenId: bo.collateralTokenId,
            prepayAsset: bo.prepayAsset
        });
    }

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

    /// @dev Apply a strict-mode toggle. Enabling is immediate and clears any
    ///      pending disable-cooldown; disabling stamps `strictModeDisabledAt` so
    ///      the gate keeps treating the vault as strict for `riskAccessUnlockCooldown`
    ///      (closes the disable→exploit window; zero by default ⇒ immediate).
    function _applyStrictMode(address vault, bool enabled) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bool was = s.riskStrictMode[vault];
        s.riskStrictMode[vault] = enabled;
        if (enabled) {
            s.strictModeStrictUntil[vault] = 0; // re-enable clears any linger
        } else if (was) {
            // Freeze the linger EXPIRY now (Codex #733 P2) so a later cooldown
            // change can't move it. Zero cooldown ⇒ expiry == now ⇒ immediate.
            s.strictModeStrictUntil[vault] =
                uint64(block.timestamp) + s.riskAccessUnlockCooldown;
        }
        emit RiskStrictModeSet(vault, enabled);
    }

    /// @dev Record an EXPLICIT mid-tier pair ack at the live terms version, and arm
    ///      it for `riskAccessUnlockCooldown` (Codex #733 P1 — no atomic
    ///      sign-and-use), mirroring the illiquid-consent arming anchor.
    function _applyMidTierAck(address vault, LibRiskAccess.PairId memory p)
        private
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        bytes32 pk = LibRiskAccess.pairKey(p);
        s.midTierExplicitAck[vault][pk] = uint64(block.timestamp);
        s.midTierExplicitAckVersion[vault][pk] = s.currentRiskTermsVersion;
        s.midTierAckUnlockAt[vault][pk] =
            uint64(block.timestamp) + s.riskAccessUnlockCooldown;
        emit MidTierPairAckSet(vault, pk);
    }

    /// @dev Map a signed mid-tier-ack message onto the canonical `PairId`.
    function _midTierPairIdOf(LibRiskAccess.SetMidTierPairAck calldata m)
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
