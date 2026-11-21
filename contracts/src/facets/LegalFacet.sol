// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibTerms} from "../libraries/LibTerms.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";

/**
 * @title LegalFacet
 * @author Vaipakam Developer Team
 * @notice Terms of Service: which versions are in force, which wallets have
 *         accepted which version, the network's closing switch (#3864), and
 *         the rule every new position passes: the network is open, and the
 *         wallet taking on the position is current on the Terms (#3734). A
 *         wallet that only reduces or leaves a position is never asked, and a
 *         loan always settles.
 *
 * @dev Accepting. A wallet accepts only by its own paid transaction
 *      ({acceptTerms}, `msg.sender` is the wallet; it also works as the
 *      wallet's own `multicall` item). No entry records an acceptance for
 *      another address: no signature route, no keeper, no manager of a
 *      protected account (owner decision 2026-11-18). A wallet accepts only
 *      the latest version in force or a new version announced to come into
 *      force, never an older one. The record is per version, so accepting an
 *      announced version never overwrites the acceptance of the one in force.
 *      Acceptances are local to this network: no cross-chain message carries
 *      one.
 *
 *      Versions. Each network keeps two values: the LATEST version (what a
 *      new acceptance names) and the MINIMUM version (the oldest acceptance
 *      that still counts). A wallet is current when it accepted a version
 *      that came into force, numbered from the minimum to the latest
 *      (`LibTerms`). Governance (ADMIN_ROLE, timelock-gated after the
 *      handover) changes them in two ways:
 *      - a SMALL change ({publishTos}) becomes the latest at once, with no
 *        notice, and leaves the minimum where it is: nobody loses standing;
 *      - a MATERIAL change raises the minimum, announced with at least
 *        {MIN_TOS_NOTICE}: to a new version ({announceTos}) or to the version
 *        already latest ({announceTosMinimum}). Until its time, standing is on
 *        the old minimum; a wallet may accept an announced new version early,
 *        which carries it over at that time. It comes into force at its time
 *        without any call; the next write here records it
 *        ({TosVersionInForce}).
 *      One open change at a time: while an announcement is pending nothing
 *      else is published or announced; a correction that cannot wait
 *      withdraws it first ({withdrawTosAnnouncement}), which changes nobody's
 *      standing. A withdrawn new version's number is spent and never counts;
 *      a withdrawn raise of the minimum leaves the version it named published
 *      and counted as before. The first version on a network needs no notice.
 *      A wallet that joins during a notice accepts both versions in one
 *      transaction of its own: a `multicall` with one {acceptTerms} item per
 *      version.
 *
 *      An aggregator adapter never accepts and is never exempt: its standing
 *      is its principal's, who accepts with its own wallet before the adapter
 *      can be created or take new positions.
 *
 *      The opening rule (#3864). Every step that commits a wallet's money or
 *      standing consent to a new position asks ONE question with two parts:
 *      the network is open ({setNetworkClosing} is off), then the wallet is
 *      current on the Terms. The rule lives once, in `LibTerms`;
 *      {requireMayOpen} is its one runtime host, which the opening steps
 *      self-call: loan creation (both parties), the two position migrations
 *      in `LibLoan` (a lender sale or takeover, an obligation handover),
 *      posting an offer (`OfferBookFacet`; a sale listing is exempt from the
 *      Terms part only, and the closing refusal reaches its fill at loan
 *      creation), setting and funding a standing-intent slot, and the
 *      in-place extension (both holders). An aggregator adapter asks it
 *      through {requireMayOpen} / {mayOpen}. The previews ask
 *      {openingBlocker}, which reports the closing state first.
 *      Two named exceptions ask one part alone:
 *      - setting standing instructions on a loan asks the Terms part alone
 *        ({requireCurrentTerms}): a top-up, an interest payment and a
 *        repayment at the due date all help a loan end, so a closing network
 *        leaves it open;
 *      - the standing-intent slot's re-commit of held payments
 *        (`LenderIntentFacet.recommitHeldToIntent`) and its roll of a repaid
 *        loan (`rollIntentLoan`) ask the closing part alone
 *        (`LibTerms.requireNetworkOpen`): each commits money to the slot's
 *        future lending, and neither asked the Terms before.
 *      Nothing else here is pause-gated: a wallet can accept, and the switch
 *      can move, while the protocol is paused.
 *
 *      The closing switch (#3864). {setNetworkClosing}(true) — ADMIN_ROLE or
 *      PAUSER_ROLE, the quick hands — starts Closing; (false) — ADMIN_ROLE or
 *      UNPAUSER_ROLE, the slower ones — reopens. The shape is the per-asset
 *      pause's. It stops growth without stopping a repayment, a claim, a
 *      liquidation or a default, and moves no deadline. Every position
 *      already open runs to its own end; a plain transfer of a position token
 *      passes no opening site and is never refused by it.
 */
contract LegalFacet is DiamondPausable, DiamondAccessControl {
    // ─── Constants ─────────────────────────────────────────────────────────

    /// @notice The shortest notice for raising the minimum version (the
    ///         first version on a network needs none).
    uint64 public constant MIN_TOS_NOTICE = 7 days;

    /// @notice The most a small change may put the latest version above the
    ///         minimum. It bounds the read every opening step makes; past it,
    ///         raise the minimum ({announceTosMinimum}) first.
    uint32 public constant MAX_TOS_WINDOW = 16;

    // ─── Events ────────────────────────────────────────────────────────────

    /// @notice A wallet's acceptance of a Terms version was recorded.
    /// @param user        The wallet that accepted.
    /// @param version     The version accepted.
    /// @param hash        That version's fingerprint.
    /// @param timestamp   When it was recorded.
    /// @custom:event-category informational/governance
    event TermsAccepted(address indexed user, uint32 indexed version, bytes32 hash, uint64 timestamp);

    /// @notice A small change: `version` is the latest from `at`, at once and
    ///         with no notice. The minimum does not move (`minVersion` is the
    ///         minimum in force, unchanged; for the first version on a
    ///         network it is `version` itself).
    /// @custom:event-category informational/governance
    event TosPublished(uint32 indexed version, bytes32 hash, uint32 minVersion, uint64 at);

    /// @notice A material change was announced: from `effectiveAt` the
    ///         minimum becomes `minVersion`. `newVersion` says whether
    ///         `version` is a new version (a wallet may accept it from now)
    ///         or the version already latest (only the minimum moves).
    /// @custom:event-category informational/governance
    event TosAnnounced(uint32 indexed version, bytes32 hash, uint64 effectiveAt, uint32 minVersion, bool newVersion);

    /// @notice The pending announcement was withdrawn before its time; the
    ///         minimum does not move. A withdrawn new version's number is
    ///         spent; a withdrawn raise leaves `version` published as before.
    /// @custom:event-category informational/governance
    event TosAnnouncementWithdrawn(uint32 indexed version, bytes32 hash, bool newVersion);

    /// @notice An announcement came into force at `effectiveAt`: the minimum
    ///         is `minVersion` from then, and `version` is the latest. Emitted
    ///         by the first write here at or after that time (the change
    ///         counted from `effectiveAt` whether or not this was emitted).
    /// @custom:event-category informational/governance
    event TosVersionInForce(uint32 indexed version, bytes32 hash, uint64 effectiveAt, uint32 minVersion, bool newVersion);

    /// @notice #3864 — the closing switch moved. `closing` true: the network
    ///         has been closing since `since` (on a repeat switch-on, still the
    ///         first time); false: it is open again and `since` is 0.
    /// @custom:event-category informational/governance
    event NetworkClosingSet(bool closing, uint64 since);

    // ─── Errors ────────────────────────────────────────────────────────────

    /// @notice The version and fingerprint are neither the latest version in
    ///         force nor a new version announced.
    error InvalidTosVersion();

    /// @notice A version that does not exceed every number used before, or a
    ///         zero fingerprint.
    error InvalidTosParams();

    /// @notice An announcement whose time gives less than the notice floor.
    error TosNoticeTooShort(uint64 effectiveAt, uint64 earliest);

    /// @notice An announcement is pending; nothing else is published or
    ///         announced until it comes into force or is withdrawn.
    error TosAnnouncementPending(uint32 version);

    /// @notice No announcement is pending.
    error NoTosAnnouncement();

    /// @notice A small change would put `version` more than {MAX_TOS_WINDOW}
    ///         above the minimum `minimum`; raise the minimum first.
    error TosVersionWindowTooWide(uint32 version, uint32 minimum);

    /// @notice The minimum is already the latest version (or none is in
    ///         force), so there is nothing to raise it to.
    error TosMinimumAlreadyLatest();

    // ─── Accepting ─────────────────────────────────────────────────────────

    /**
     * @notice Record the caller's acceptance of Terms `version` with
     *         fingerprint `hash`: the latest version in force, or a new
     *         version announced to come into force.
     * @dev A no-op when the caller already accepted that version (the first
     *      time is kept). Open while the protocol is paused.
     */
    function acceptTerms(uint32 version, bytes32 hash) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _settle(s);
        LibTerms.State memory t = LibTerms.state(s);
        if (
            version == 0
                || !((version == t.latest && hash == t.latestHash)
                    || (t.pendingIsNew && version == t.pending && hash == t.pendingHash))
        ) revert InvalidTosVersion();
        address wallet = msg.sender;
        // A repeat keeps the first acceptance time.
        if (s.tosAcceptedVersion[wallet][version].acceptedAt != 0) return;
        LibVaipakam.TosAcceptance memory a =
            LibVaipakam.TosAcceptance({version: version, hash: hash, acceptedAt: uint64(block.timestamp)});
        s.tosAcceptedVersion[wallet][version] = a;
        if (version >= s.tosAcceptance[wallet].version) s.tosAcceptance[wallet] = a;
        emit TermsAccepted(wallet, version, hash, uint64(block.timestamp));
    }

    // ─── Governance ────────────────────────────────────────────────────────

    /**
     * @notice A small change: Terms `version` with fingerprint `hash` is the
     *         latest at once, with no notice; the minimum does not move (the
     *         first version on a network sets it to itself).
     * @dev `version` must exceed every number used before, and may sit at
     *      most {MAX_TOS_WINDOW} above the minimum. Refused while an
     *      announcement is pending.
     */
    function publishTos(uint32 version, bytes32 hash) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _settle(s);
        _requireNoAnnouncement(s);
        _requireNewNumber(s, version, hash);
        uint32 minimum = s.minTosVersion;
        if (s.currentTosVersion != 0 && version - minimum > MAX_TOS_WINDOW) {
            revert TosVersionWindowTooWide(version, minimum);
        }
        s.highestTosVersionAnnounced = version;
        if (s.currentTosVersion == 0) s.minTosVersion = version;
        s.currentTosVersion = version;
        s.currentTosHash = hash;
        s.tosVersionInForceAt[version] = uint64(block.timestamp);
        emit TosPublished(version, hash, s.minTosVersion, uint64(block.timestamp));
    }

    /**
     * @notice A material change to a new version: Terms `version` with
     *         fingerprint `hash` becomes the latest AND the minimum at
     *         `effectiveAt`. The notice is at least {MIN_TOS_NOTICE}; the
     *         first version on a network may take effect at once.
     * @dev `version` must exceed every number used before, a withdrawn one
     *      included. Refused while another announcement is pending.
     */
    function announceTos(uint32 version, bytes32 hash, uint64 effectiveAt)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _settle(s);
        _requireNoAnnouncement(s);
        _requireNewNumber(s, version, hash);
        _requireNotice(effectiveAt, s.currentTosVersion == 0 ? 0 : MIN_TOS_NOTICE);
        s.highestTosVersionAnnounced = version;
        _announce(s, version, hash, effectiveAt, true);
    }

    /**
     * @notice A material change with no new text: the minimum rises to the
     *         version already latest at `effectiveAt`, after at least
     *         {MIN_TOS_NOTICE}. Wallets that accepted only an older version
     *         must accept the latest by then.
     * @dev Refused while another announcement is pending, and when the
     *      minimum is already the latest.
     */
    function announceTosMinimum(uint64 effectiveAt) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _settle(s);
        _requireNoAnnouncement(s);
        uint32 latest = s.currentTosVersion;
        if (latest == 0 || s.minTosVersion >= latest) revert TosMinimumAlreadyLatest();
        _requireNotice(effectiveAt, MIN_TOS_NOTICE);
        _announce(s, latest, s.currentTosHash, effectiveAt, false);
    }

    /// @notice Withdraw the pending announcement before its time. Nobody's
    ///         standing changes. A withdrawn new version's number stays
    ///         spent; a withdrawn raise of the minimum leaves the version it
    ///         named published and counted as before.
    function withdrawTosAnnouncement() external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _settle(s);
        if (s.announcedTosEffectiveAt == 0) revert NoTosAnnouncement();
        emit TosAnnouncementWithdrawn(s.announcedTosVersion, s.announcedTosHash, s.announcedTosIsNew);
        _clearAnnouncement(s);
    }

    // ─── The closing switch (#3864) ──────────────────────────────────────

    /**
     * @notice Start or end this network's Closing state. While closing, no
     *         step may commit a wallet's money or standing consent to a new
     *         position here ({LibTerms.NetworkClosing}); every position
     *         already open runs to its own end on its own terms.
     * @dev Switching on: ADMIN_ROLE or PAUSER_ROLE. Switching off: ADMIN_ROLE
     *      or UNPAUSER_ROLE — the per-asset pause's asymmetry, so a fast key
     *      cannot undo its own switch. Idempotent: a repeat switch-on keeps the
     *      first `since`, a repeat switch-off stays open; each call emits
     *      {NetworkClosingSet} with the state after it. Not pause-gated.
     * @param closing True to start Closing, false to reopen.
     */
    function setNetworkClosing(bool closing) external {
        bytes32 second = closing ? LibAccessControl.PAUSER_ROLE : LibAccessControl.UNPAUSER_ROLE;
        if (
            !LibAccessControl.hasRole(LibAccessControl.ADMIN_ROLE, msg.sender)
                && !LibAccessControl.hasRole(second, msg.sender)
        ) revert LibAccessControl.AccessControlUnauthorizedAccount(msg.sender, second);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint64 since = s.networkClosingSince;
        if (closing && since == 0) since = uint64(block.timestamp);
        if (!closing) since = 0;
        s.networkClosingSince = since;
        emit NetworkClosingSet(closing, since);
    }

    /// @notice Whether this network is closing, and since when (0 = open).
    function getNetworkClosing() external view returns (bool closing, uint64 since) {
        since = LibTerms.closingSince(LibVaipakam.storageSlot());
        closing = since != 0;
    }

    // ─── The rule ──────────────────────────────────────────────────────────

    /// @notice Revert unless `wallet` may take on a new position now: first
    ///         {LibTerms.NetworkClosing} while the network is closing (the
    ///         backstop vault included), then {LibTerms.TermsNotAccepted}
    ///         unless `wallet` is current on the Terms. The one runtime host
    ///         of the opening rule; every opening step self-calls it.
    function requireMayOpen(address wallet) external view {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibTerms.requireNetworkOpen(s);
        _requireTerms(s, wallet);
    }

    /// @notice The Terms part alone: revert {LibTerms.TermsNotAccepted}
    ///         unless `wallet` is current, whatever the closing state. For the
    ///         one opening-adjacent step a closing network leaves open
    ///         (setting standing instructions on a loan); every other opening
    ///         step asks {requireMayOpen}.
    function requireCurrentTerms(address wallet) external view {
        _requireTerms(LibVaipakam.storageSlot(), wallet);
    }

    /// @notice Whether `wallet` may take on a new position now: the network
    ///         is open and `wallet` is current on the Terms ({requireMayOpen}
    ///         as a bool).
    function mayOpen(address wallet) external view returns (bool) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.networkClosingSince != 0) return false;
        (bool current,) = LibTerms.isCurrent(s, wallet);
        return current;
    }

    /// @notice Whether `wallet` is current on the Terms, whatever the closing
    ///         state: true when no version is in force, or when it accepted a
    ///         version in force from the minimum to the latest.
    function isTermsCurrent(address wallet) external view returns (bool) {
        (bool current,) = LibTerms.isCurrent(LibVaipakam.storageSlot(), wallet);
        return current;
    }

    /// @notice Why a new position between `a` and `b` (0 = skip) would be
    ///         refused now, in the opening rule's order, for the previews,
    ///         which report a refusal before a transaction is sent.
    /// @return closingSince Non-zero when the network is closing (the first
    ///                      reason; `wallet` and `version` are then 0).
    /// @return wallet       Else the first of `a`, `b` not current on the
    ///                      Terms (an aggregator adapter's principal for an
    ///                      adapter), 0 when both are.
    /// @return version      The latest version `wallet` should accept.
    function openingBlocker(address a, address b)
        external
        view
        returns (uint64 closingSince, address wallet, uint32 version)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        closingSince = s.networkClosingSince;
        if (closingSince != 0) return (closingSince, address(0), 0);
        bool current;
        if (a != address(0)) {
            (current, version) = LibTerms.isCurrent(s, a);
            if (!current) return (0, LibTerms.subject(s, a), version);
        }
        if (b != address(0)) {
            (current, version) = LibTerms.isCurrent(s, b);
            if (!current) return (0, LibTerms.subject(s, b), version);
        }
        return (0, address(0), 0);
    }

    /// @dev Revert {LibTerms.TermsNotAccepted} unless `wallet` is current.
    function _requireTerms(LibVaipakam.Storage storage s, address wallet) private view {
        (bool current, uint32 needed) = LibTerms.isCurrent(s, wallet);
        if (!current) revert LibTerms.TermsNotAccepted(LibTerms.subject(s, wallet), needed);
    }

    // ─── Views ─────────────────────────────────────────────────────────────

    /// @notice Kept name: whether `user` is current ({isTermsCurrent}).
    function hasAcceptedCurrentTerms(address user) external view returns (bool accepted) {
        (accepted,) = LibTerms.isCurrent(LibVaipakam.storageSlot(), user);
    }

    /// @notice The latest version in force now and its fingerprint (0 =
    ///         none). A pending announcement counts from its time.
    function getCurrentTos() external view returns (uint32 version, bytes32 hash) {
        LibTerms.State memory t = LibTerms.state(LibVaipakam.storageSlot());
        return (t.latest, t.latestHash);
    }

    /// @notice The two values in force now: the latest version (what a new
    ///         acceptance names), its fingerprint, and the minimum version
    ///         (the oldest acceptance that still counts).
    function getTosVersions() external view returns (uint32 latest, bytes32 latestHash, uint32 minimum) {
        LibTerms.State memory t = LibTerms.state(LibVaipakam.storageSlot());
        return (t.latest, t.latestHash, t.minimum);
    }

    /// @notice The pending announcement, if its time has not come: the
    ///         version it concerns, its fingerprint, when it comes into force,
    ///         the minimum then, and whether it is a new version (a wallet may
    ///         accept it now). All zero when none is pending.
    function getAnnouncedTos()
        external
        view
        returns (uint32 version, bytes32 hash, uint64 effectiveAt, uint32 minVersion, bool newVersion)
    {
        LibTerms.State memory t = LibTerms.state(LibVaipakam.storageSlot());
        return (t.pending, t.pendingHash, t.pendingAt, t.pendingMinimum, t.pendingIsNew);
    }

    /// @notice When Terms `version` came into force (0 = it never did:
    ///         pending, withdrawn or never used).
    function getTosVersionInForceAt(uint32 version) external view returns (uint64 at) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        at = s.tosVersionInForceAt[version];
        if (at == 0 && LibTerms.inForce(s, version)) at = s.announcedTosEffectiveAt;
    }

    /// @notice Every Terms version `user` has accepted, in ascending order
    ///         (a withdrawn or pending one included; {getTosVersionInForceAt}
    ///         says which came into force).
    function getUserAcceptedTosVersions(address user) external view returns (uint32[] memory versions) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint32 highest = s.highestTosVersionAnnounced;
        uint256 n;
        for (uint32 v = 1; v <= highest; ++v) {
            if (s.tosAcceptedVersion[user][v].acceptedAt != 0) ++n;
        }
        versions = new uint32[](n);
        n = 0;
        for (uint32 v = 1; v <= highest; ++v) {
            if (s.tosAcceptedVersion[user][v].acceptedAt != 0) versions[n++] = v;
        }
    }

    /// @notice `user`'s latest recorded acceptance (zero if none).
    function getUserTosAcceptance(address user) external view returns (LibVaipakam.TosAcceptance memory acceptance) {
        return LibVaipakam.storageSlot().tosAcceptance[user];
    }

    /// @notice `user`'s acceptance of `version` (zero if it never accepted it).
    function getUserTosAcceptanceOf(address user, uint32 version)
        external
        view
        returns (LibVaipakam.TosAcceptance memory acceptance)
    {
        return LibVaipakam.storageSlot().tosAcceptedVersion[user][version];
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    function _requireNoAnnouncement(LibVaipakam.Storage storage s) private view {
        if (s.announcedTosEffectiveAt != 0) revert TosAnnouncementPending(s.announcedTosVersion);
    }

    function _requireNewNumber(LibVaipakam.Storage storage s, uint32 version, bytes32 hash) private view {
        if (hash == bytes32(0) || version <= s.highestTosVersionAnnounced || version <= s.currentTosVersion) {
            revert InvalidTosParams();
        }
    }

    function _requireNotice(uint64 effectiveAt, uint64 notice) private view {
        uint64 earliest = uint64(block.timestamp) + notice;
        if (effectiveAt < earliest) revert TosNoticeTooShort(effectiveAt, earliest);
    }

    /// @dev Record the one pending announcement (the minimum it sets is the
    ///      version it names) and fold it in at once when its time is now.
    function _announce(LibVaipakam.Storage storage s, uint32 version, bytes32 hash, uint64 effectiveAt, bool isNew)
        private
    {
        s.announcedTosVersion = version;
        s.announcedTosHash = hash;
        s.announcedTosEffectiveAt = effectiveAt;
        s.announcedTosMinVersion = version;
        s.announcedTosIsNew = isNew;
        emit TosAnnounced(version, hash, effectiveAt, version, isNew);
        _settle(s);
    }

    /// @dev Fold an announcement whose time has come into the values in
    ///      force, and say so. The rule already counted it from its time.
    function _settle(LibVaipakam.Storage storage s) private {
        uint64 at = s.announcedTosEffectiveAt;
        if (at == 0 || block.timestamp < at) return;
        uint32 version = s.announcedTosVersion;
        bool isNew = s.announcedTosIsNew;
        if (isNew) {
            s.currentTosVersion = version;
            s.currentTosHash = s.announcedTosHash;
            s.tosVersionInForceAt[version] = at;
        }
        s.minTosVersion = s.announcedTosMinVersion;
        emit TosVersionInForce(version, s.announcedTosHash, at, s.minTosVersion, isNew);
        _clearAnnouncement(s);
    }

    function _clearAnnouncement(LibVaipakam.Storage storage s) private {
        s.announcedTosVersion = 0;
        s.announcedTosHash = bytes32(0);
        s.announcedTosEffectiveAt = 0;
        s.announcedTosMinVersion = 0;
        s.announcedTosIsNew = false;
    }
}
