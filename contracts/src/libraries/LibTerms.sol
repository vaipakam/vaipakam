// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title  LibTerms
 * @author Vaipakam Developer Team
 * @notice The ONE rule for taking on a new position (#3734, #3864): a step
 *         that commits a wallet's money or standing consent to a new position
 *         asks one question with two parts, in this order:
 *         1. the network is open: no closing switch is on ({NetworkClosing},
 *            #3864). It binds every wallet, the backstop vault included;
 *         2. the wallet is current on the Terms ({TermsNotAccepted}, #3734).
 *         A wallet that only reduces or leaves a position is never asked.
 * @dev    Three halves:
 *         - the rule itself ({closingSince}, {state}, {isCurrent}), whose one
 *           runtime host is `LegalFacet` (and the read-only previews it
 *           answers);
 *         - {requireMayOpen}, which every opening step calls. It is a
 *           self-call to `LegalFacet.requireMayOpen`, so the facets that open
 *           positions (several of them close to EIP-170) carry a call, not a
 *           copy of the rule;
 *         - the two named exceptions: {requireCurrentTerms} asks the Terms
 *           part alone (setting standing instructions on a loan, which must
 *           stay open while a network closes because every run helps the loan
 *           end), and {requireNetworkOpen} asks the closing part alone (the
 *           standing-intent slot's re-commit of held payments and its roll of
 *           a repaid loan, whose Terms behaviour is deliberately unchanged).
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
 *         registry pointer, never by a list. An aggregator adapter answers
 *         with its principal's standing ({subject}): it never accepts and is
 *         never exempt.
 */
library LibTerms {
    /// @notice `wallet` has not accepted the Terms a new position needs:
    ///         `version` is the latest version in force, the one to accept.
    ///         For an aggregator adapter, `wallet` names its principal.
    error TermsNotAccepted(address wallet, uint32 version);

    /// @notice #3864 — this network has been closing since `since`: no step
    ///         may commit a wallet's money or standing consent to a new
    ///         position here. Every position already open runs to its end.
    error NetworkClosing(uint64 since);

    /// @notice #3864 — when this network began closing (0 = open).
    function closingSince(LibVaipakam.Storage storage s) internal view returns (uint64) {
        return s.networkClosingSince;
    }

    /// @notice #3864 — refuse with {NetworkClosing} while the network is
    ///         closing. The closing part of the opening rule, inlined: one
    ///         storage read. Asked alone only by the two standing-intent slot
    ///         steps named in the library header; every other opening step
    ///         asks it through {requireMayOpen}.
    function requireNetworkOpen(LibVaipakam.Storage storage s) internal view {
        uint64 since = s.networkClosingSince;
        if (since != 0) revert NetworkClosing(since);
    }

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

    /// @notice Whose Terms standing answers for `wallet`: an aggregator
    ///         adapter's principal for a registered adapter (the adapter never
    ///         accepts and is never exempt), else the wallet itself.
    function subject(LibVaipakam.Storage storage s, address wallet) internal view returns (address) {
        return s.isAggregatorAdapter[wallet] ? s.adapterPrincipal[wallet] : wallet;
    }

    /// @notice Whether `wallet` may take on a new position as far as the
    ///         Terms go, and the version it needs if not.
    /// @dev The wallet's latest acceptance first, then a bounded read from
    ///      the latest version down to the minimum, stopping at the first
    ///      version the wallet accepted that came into force. The window is
    ///      the versions published since the last material change, at most
    ///      `LegalFacet.MAX_TOS_WINDOW` + 1.
    /// @return current True when no version is in force, when `wallet` is the
    ///                 backstop vault, or when it accepted a version in force
    ///                 from the minimum to the latest.
    /// @return needed  The latest version in force (0 when `current`).
    /// @dev The Terms part only. The backstop vault's exemption is from the
    ///      Terms, never from the closing part: {requireMayOpen}'s host asks
    ///      {requireNetworkOpen} first, so the vault's lending is refused on
    ///      a closing network like any wallet's (#3864).
    function isCurrent(LibVaipakam.Storage storage s, address wallet)
        internal
        view
        returns (bool current, uint32 needed)
    {
        State memory t = state(s);
        if (t.latest == 0) return (true, 0);
        if (wallet != address(0) && wallet == s.backstopVault) return (true, 0);
        wallet = subject(s, wallet);
        uint32 floor = t.minimum == 0 ? 1 : t.minimum;
        // The wallet's latest acceptance first: one read settles the usual
        // case. It may name a pending or withdrawn version, so it must also
        // have come into force.
        uint32 last = s.tosAcceptance[wallet].version;
        if (last >= floor && last <= t.latest && inForce(s, last)) return (true, 0);
        for (uint32 v = t.latest; v >= floor; --v) {
            if (s.tosAcceptedVersion[wallet][v].acceptedAt != 0 && inForce(s, v)) return (true, 0);
        }
        return (false, t.latest);
    }

    /// @notice Refuse a new position for `wallet` unless the network is open
    ///         and `wallet` is current ({isCurrent}): a self-call to the
    ///         rule's one host, `LegalFacet.requireMayOpen`, whose refusal
    ///         ({NetworkClosing} first, else {TermsNotAccepted}) is passed
    ///         through unchanged.
    function requireMayOpen(address wallet) internal view {
        _selfCall(abi.encodeWithSignature("requireMayOpen(address)", wallet));
    }

    /// @notice The Terms part alone: refuse unless `wallet` is current
    ///         ({TermsNotAccepted}), whatever the closing state. Only for the
    ///         exception named in the library header (standing instructions).
    function requireCurrentTerms(address wallet) internal view {
        _selfCall(abi.encodeWithSignature("requireCurrentTerms(address)", wallet));
    }

    /// @dev A static self-call to the rule's host, its refusal passed through.
    function _selfCall(bytes memory data) private view {
        (bool ok, bytes memory ret) = address(this).staticcall(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
