// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title  LibTerms
 * @author Vaipakam Developer Team
 * @notice #3734 — the ONE rule for Terms of Service acceptance: a wallet that
 *         takes on a new position must be current on the Terms; a wallet that
 *         only reduces or leaves a position is never asked.
 * @dev    Two halves:
 *         - the rule itself ({state}, {isCurrent}), whose one runtime host is
 *           `LegalFacet` (and the read-only previews it answers);
 *         - {requireCurrent}, which every opening step calls. It is a
 *           self-call to `LegalFacet.requireCurrentTerms`, so the facets that
 *           open positions (several of them close to EIP-170) carry a call,
 *           not a copy of the rule.
 *
 *         Versions. Each network keeps two values: the LATEST version in
 *         force (what a new acceptance names) and the MINIMUM version (the
 *         oldest acceptance that still counts). A wallet is current when it
 *         accepted at least one version that has come into force, numbered
 *         from the minimum to the latest. A pending or withdrawn version
 *         never counts, whatever its number. A pending announcement counts
 *         from its time without any call (`LegalFacet` folds it in on its
 *         next write); before that time standing is on the old values, so
 *         withdrawing it changes nobody's standing. While no version is in
 *         force, nothing is checked.
 *
 *         The platform's own backstop vault is exempt, identified by the
 *         registry pointer, never by a list.
 */
library LibTerms {
    /// @notice `wallet` has not accepted the Terms a new position needs:
    ///         `version` is the latest version in force, the one to accept.
    error TermsNotAccepted(address wallet, uint32 version);

    /// @notice The Terms values that count now.
    /// @param latest        The latest version in force (0 = none; nothing checked).
    /// @param latestHash    Its fingerprint.
    /// @param minimum       The oldest version whose acceptance still counts.
    /// @param pending       The version a pending announcement concerns (0 = none).
    /// @param pendingHash   Its fingerprint.
    /// @param pendingAt     When it comes into force.
    /// @param pendingMinimum The minimum it sets then.
    /// @param pendingIsNew  True when it introduces a new version (a wallet
    ///                      may accept it now); false when it only raises the
    ///                      minimum to the version already latest.
    struct State {
        uint32 latest;
        bytes32 latestHash;
        uint32 minimum;
        uint32 pending;
        bytes32 pendingHash;
        uint64 pendingAt;
        uint32 pendingMinimum;
        bool pendingIsNew;
    }

    /// @notice The Terms values that count now, a matured announcement folded in.
    function state(LibVaipakam.Storage storage s) internal view returns (State memory t) {
        t.latest = s.currentTosVersion;
        t.latestHash = s.currentTosHash;
        t.minimum = s.minTosVersion;
        uint64 at = s.announcedTosEffectiveAt;
        if (at == 0) return t;
        if (block.timestamp >= at) {
            if (s.announcedTosIsNew) {
                t.latest = s.announcedTosVersion;
                t.latestHash = s.announcedTosHash;
            }
            t.minimum = s.announcedTosMinVersion;
        } else {
            t.pending = s.announcedTosVersion;
            t.pendingHash = s.announcedTosHash;
            t.pendingAt = at;
            t.pendingMinimum = s.announcedTosMinVersion;
            t.pendingIsNew = s.announcedTosIsNew;
        }
    }

    /// @notice Whether Terms `version` has come into force (a matured
    ///         announcement of it included).
    function inForce(LibVaipakam.Storage storage s, uint32 version) internal view returns (bool) {
        if (s.tosVersionInForceAt[version] != 0) return true;
        uint64 at = s.announcedTosEffectiveAt;
        return at != 0 && block.timestamp >= at && s.announcedTosIsNew && s.announcedTosVersion == version;
    }

    /// @notice Whether `wallet` may take on a new position as far as the
    ///         Terms go, and the version it needs if not.
    /// @dev A bounded read from the latest version down to the minimum,
    ///      stopping at the first version the wallet accepted that came into
    ///      force. The window is the versions published since the last
    ///      material change, usually one to three.
    /// @return current True when no version is in force, when `wallet` is the
    ///                 backstop vault, or when it accepted a version in force
    ///                 from the minimum to the latest.
    /// @return needed  The latest version in force (0 when `current`).
    function isCurrent(LibVaipakam.Storage storage s, address wallet)
        internal
        view
        returns (bool current, uint32 needed)
    {
        State memory t = state(s);
        if (t.latest == 0) return (true, 0);
        if (wallet != address(0) && wallet == s.backstopVault) return (true, 0);
        uint32 floor = t.minimum == 0 ? 1 : t.minimum;
        for (uint32 v = t.latest; v >= floor; --v) {
            if (s.tosAcceptedVersion[wallet][v].acceptedAt != 0 && inForce(s, v)) return (true, 0);
        }
        return (false, t.latest);
    }

    /// @notice Refuse a new position for `wallet` unless it is current
    ///         ({isCurrent}): a self-call to the rule's one host,
    ///         `LegalFacet.requireCurrentTerms`, whose refusal
    ///         ({TermsNotAccepted}) is passed through unchanged.
    function requireCurrent(address wallet) internal view {
        (bool ok, bytes memory ret) =
            address(this).staticcall(abi.encodeWithSignature("requireCurrentTerms(address)", wallet));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
