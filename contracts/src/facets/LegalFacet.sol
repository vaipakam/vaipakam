// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";

/**
 * @title LegalFacet
 * @author Vaipakam Developer Team
 * @notice On-chain Terms-of-Service acceptance surface. Records, per
 *         wallet, which version of the ToS that wallet has agreed to and
 *         when. The frontend gates `/app/*` routes behind a successful
 *         acceptance call against the current version — so every wallet
 *         that ever creates an offer, accepts an offer, repays a loan,
 *         claims funds, or otherwise interacts with the protocol has a
 *         cryptographically-timestamped agreement on file.
 *
 * @dev Two distinct callers:
 *        - End users call `acceptTerms(version, hash)` to register their
 *          acceptance. The function rejects if the submitted pair does
 *          not match the current governance-configured ToS.
 *        - Governance (via ADMIN_ROLE, which becomes timelock-gated
 *          after the Safe-Timelock handover) calls `setCurrentTos` to
 *          bump the version + hash when the ToS text changes — every
 *          existing user must then re-accept before continuing to
 *          interact with `/app`.
 *
 *      Why on-chain rather than a cookie / localStorage flag: an
 *      on-chain record is an immutable, timestamped agreement anchored
 *      to the same wallet that will sign every subsequent protocol
 *      action. A cookie can be cleared or forged; the on-chain record
 *      cannot. This matches the ToS-signing pattern used by every
 *      serious mainnet DeFi deployment.
 *
 *      `currentTosVersion = 0` is the "gate disabled" state — used
 *      during pre-mainnet and testnet periods. Governance sets the
 *      version to `1` (and the content hash) at mainnet-launch time,
 *      which atomically turns the gate on for all wallets.
 */
contract LegalFacet is DiamondPausable, DiamondAccessControl {
    // ─── Events ────────────────────────────────────────────────────────────

    /// @notice Emitted when a user records their acceptance of a ToS version.
    /// @param user      The wallet address that accepted.
    /// @param version   The ToS version accepted.
    /// @param hash      The content-hash the user submitted (mirrors the
    ///                  current on-chain hash for the version at accept time).
    /// @param timestamp Block timestamp at acceptance.
    event TermsAccepted(
        address indexed user,
        uint32 indexed version,
        bytes32 hash,
        uint64 timestamp
    );

    /// @notice Emitted whenever governance bumps the current ToS. Indexed
    ///         version so off-chain monitoring can detect the change and
    ///         alert users that a re-acceptance is required.
    /// @param version Previous on-chain version (0 if first time).
    /// @param newVersion New version now in force.
    /// @param newHash Content hash of the new ToS text.
    event CurrentTosUpdated(
        uint32 version,
        uint32 indexed newVersion,
        bytes32 newHash
    );

    // ─── Errors ────────────────────────────────────────────────────────────

    /// @notice Thrown when a user submits an `acceptTerms` call whose
    ///         `version` or `hash` do not match the current governance-
    ///         configured pair. Typically means the user's frontend
    ///         cached an old ToS and needs to reload.
    error InvalidTosVersion();

    /// @notice Thrown when governance attempts to install a new ToS whose
    ///         version number does not strictly increase, or whose hash
    ///         is zero.
    error InvalidTosParams();

    // ─── User entry point ─────────────────────────────────────────────────

    /**
     * @notice Record the caller's acceptance of the current Terms of
     *         Service. Must be called with the current on-chain
     *         `version` + `hash` — otherwise reverts {InvalidTosVersion}.
     *         Frontend reads `getCurrentTos()`, displays the matching ToS
     *         text, and passes the exact pair into this call so the
     *         user's signed tx records the pair they actually saw.
     *
     * @dev Re-accepting a version the user has already accepted is a
     *      no-op from the user's perspective (same version+hash lands
     *      in storage, `acceptedAt` is updated). No revert — letting the
     *      frontend re-drive the flow without needing to check state
     *      first is friendlier than a revert.
     *
     *      Not paused-gated: users must still be able to record their
     *      acceptance even when the wider protocol is paused, otherwise
     *      a paused state would strand them out of `/app`.
     *
     * @param version The ToS version the caller is accepting.
     * @param hash    The content hash they were shown for that version.
     */
    function acceptTerms(uint32 version, bytes32 hash) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (version != s.currentTosVersion || hash != s.currentTosHash) {
            revert InvalidTosVersion();
        }
        s.tosAcceptance[msg.sender] = LibVaipakam.TosAcceptance({
            version: version,
            hash: hash,
            acceptedAt: uint64(block.timestamp)
        });
        emit TermsAccepted(msg.sender, version, hash, uint64(block.timestamp));
    }

    // ─── Governance entry point ───────────────────────────────────────────

    /**
     * @notice Install a new Terms of Service version + content hash.
     *         Every wallet whose stored acceptance version is below the
     *         new `version` must call {acceptTerms} again before the
     *         frontend re-opens `/app` routes to them.
     * @dev ADMIN_ROLE-gated, so timelock-gated after governance handover.
     *      Version must strictly increase — downgrading or replaying a
     *      version number is refused so an audit trail stays monotonic.
     *      Hash must be non-zero.
     *
     * @param newVersion The new ToS version (must be > current).
     * @param newHash    The content hash of the new ToS text.
     */
    function setCurrentTos(uint32 newVersion, bytes32 newHash)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (newVersion <= s.currentTosVersion) revert InvalidTosParams();
        if (newHash == bytes32(0)) revert InvalidTosParams();
        uint32 prev = s.currentTosVersion;
        s.currentTosVersion = newVersion;
        s.currentTosHash = newHash;
        emit CurrentTosUpdated(prev, newVersion, newHash);
    }

    // ─── Views ────────────────────────────────────────────────────────────

    /**
     * @notice Returns true iff `user`'s recorded acceptance matches the
     *         current on-chain ToS version AND hash. The hash check is
     *         what catches a version-bump-with-content-change: users who
     *         had accepted a prior hash of the same version number (a
     *         recovery pattern if governance ever has to correct a
     *         mid-flight ToS posting) are correctly treated as not
     *         having accepted the current text.
     * @dev When `currentTosVersion == 0` the gate is disabled — every
     *      wallet is treated as accepted. Used during pre-launch so the
     *      frontend can ship the gating code path without it firing.
     *
     * @param user The wallet to check.
     * @return accepted True iff the user's acceptance record is current.
     */
    function hasAcceptedCurrentTerms(address user)
        external
        view
        returns (bool accepted)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.currentTosVersion == 0) return true;
        LibVaipakam.TosAcceptance storage a = s.tosAcceptance[user];
        return (a.version == s.currentTosVersion && a.hash == s.currentTosHash);
    }

    /**
     * @notice The currently-in-force ToS version + content hash.
     * @return version The current version (0 means the gate is disabled).
     * @return hash    The current content hash (zero when version is 0).
     */
    function getCurrentTos()
        external
        view
        returns (uint32 version, bytes32 hash)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (s.currentTosVersion, s.currentTosHash);
    }

    /**
     * @notice The full acceptance record for a given user.
     * @param user The wallet to inspect.
     * @return acceptance Struct with `version`, `hash`, and `acceptedAt`.
     *         All fields are zero for a user who has never accepted.
     */
    function getUserTosAcceptance(address user)
        external
        view
        returns (LibVaipakam.TosAcceptance memory acceptance)
    {
        return LibVaipakam.storageSlot().tosAcceptance[user];
    }
}
