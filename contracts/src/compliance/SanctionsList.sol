// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ISanctionsList} from "../interfaces/ISanctionsList.sol";
import {ComposedSanctionsList} from "./ComposedSanctionsList.sol";

/**
 * @title  SanctionsList
 * @notice Vaipakam's own on-chain record of OFAC SDN digital-currency
 *         addresses, optionally OR-composed with RedStone's Sanctions Oracle
 *         where that oracle is deployed. A wallet is sanctioned when EITHER
 *         source flags it. This is the sanctions oracle a mainnet Diamond is
 *         meant to screen against (owner decision on #2443, 2026-10-17).
 *
 * @dev    Why it exists: Chainalysis retired its on-chain Sanctions Oracle
 *         (last updated 2026-03-18). Its contracts still answer, so a Diamond
 *         pointed at it screens against a frozen list with nothing on-chain
 *         to say so. The replacement keeps the list's freshness and
 *         provenance ON-CHAIN, where any reader can check them:
 *
 *         1. **Updates are attributable to a published OFAC file.** Every
 *            update records the SHA-256 of the exact `sdn_advanced.xml` it
 *            was built from and that file's publication date (its
 *            `DateOfIssue`, as a sortable `YYYYMMDD`), plus the block time it
 *            was applied. An update with no changes is allowed and still
 *            recorded: "checked against the 2026-10-15 publication, nothing
 *            changed" is a freshness fact worth stating. Note the difference
 *            between the two clocks: `lastUpdatedAt` says when the updater
 *            last synced, the publication date says how new the file it
 *            synced against was.
 *
 *         1a. **Publications only move forward** (Codex #2543 r1). An update
 *            built from an OLDER publication would re-list addresses OFAC
 *            has since delisted and drop newer designations, and the version
 *            guard cannot catch it: the diff is computed against the current
 *            state, so it applies cleanly. The ordering is therefore enforced
 *            here, not only in the tool:
 *            - a publication date later than the recorded one is accepted;
 *            - the SAME date is accepted only as a refresh — identical source
 *              hash and no changes — because the date alone cannot order two
 *              different files issued on one day, and an update that changes
 *              the list must be orderable;
 *            - anything else (an earlier date, or a different file on the
 *              same date) needs a one-shot owner authorization naming that
 *              exact date and hash, granted against the list version the
 *              owner reviewed ({authorizePublicationRollback}). Both the
 *              authorization and its use are evented. An authorization for
 *              a NEWER date is refused, and every successful update clears
 *              a pending one (evented when unused), so no authorization
 *              outlives the state it was granted against. A legitimate same-day
 *              OFAC reissue therefore takes the owner's explicit sign-off; it
 *              is rare, and silently accepting one would also accept a
 *              same-day rollback.
 *
 *         2. **The list is reconstructible from logs and enumerable from
 *            state.** Every listing and delisting emits its own event, and
 *            the current set is enumerable on-chain (`listedPage`), so the
 *            off-chain diff tool reads the live set from state at one block
 *            instead of depending on a node that keeps old logs.
 *
 *         3. **An update applies to the state it was computed against, or not
 *            at all.** `applyUpdate` takes the `listVersion` its diff was
 *            computed from and refuses any other; adding an address already
 *            listed, removing one not listed, or adding and removing the same
 *            address in one update each revert. A stale or double-submitted
 *            diff therefore fails loudly instead of leaving a list that
 *            matches no OFAC publication.
 *
 *         4. **Roles are split.** The owner (the chain's admin, two-step
 *            transfer, renouncing disabled) decides WHO may update; updaters
 *            change the list's CONTENT and nothing else. The owner is not an
 *            updater unless it appoints itself.
 *
 *         5. **Attribution.** `sanctionSource` says which source flags an
 *            address, so a surface that tells a flagged user whom to contact
 *            can name OFAC's list or RedStone's oracle truthfully.
 *            `listedByOwnList` answers for the own record alone and never
 *            touches the secondary.
 *
 *         The OR rule and the secondary-failure semantics (a secondary
 *         revert propagates for an address the own record does not flag)
 *         are `ComposedSanctionsList`'s, shared with `TestnetSanctionsOverlay`
 *         — see that base for why propagating is the right choice.
 *
 *         Scope of the own record: OFAC SDN only, and only addresses in EVM
 *         format (`0x` + 40 hex) — an address listed under any digital
 *         currency label is the same key on every EVM chain. EU, UK and UN
 *         lists are not in it; on a chain where RedStone's oracle is
 *         configured as the secondary, that oracle's own coverage applies on
 *         top. A designation reaches the record only when an updater applies
 *         it, which is why the freshness views exist.
 */
contract SanctionsList is ComposedSanctionsList, Ownable2Step {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @dev The currently listed addresses.
    EnumerableSet.AddressSet private _listed;

    /// @notice The update version at which `who` was listed, or 0 when it is
    ///         not listed. Versions start at 1.
    mapping(address who => uint64 version) public listedSinceVersion;

    /// @notice Addresses allowed to apply updates.
    mapping(address account => bool enabled) public isUpdater;

    /// @notice The number of updates applied so far; 0 before the first.
    uint64 public listVersion;

    /// @notice Block timestamp of the last applied update; 0 before the first.
    uint64 public lastUpdatedAt;

    /// @notice SHA-256 of the OFAC source file the last update was built
    ///         from; zero before the first update.
    bytes32 public sourceHash;

    /// @notice That file's publication date (its `DateOfIssue`) as
    ///         `YYYYMMDD`, e.g. `20261015`; 0 before the first update.
    uint32 public sourcePublicationDate;

    /// @notice A pending owner authorization for ONE update whose
    ///         publication is not newer than the recorded one: its date.
    ///         0 when none is pending.
    uint32 public rollbackAuthorizedDate;

    /// @notice The source hash that pending authorization names.
    bytes32 public rollbackAuthorizedHash;

    /// @notice An updater was appointed or removed.
    /// @custom:event-category informational/admin
    event UpdaterSet(address indexed account, bool enabled);
    /// @notice `who` was added to the own record by update `version`.
    /// @custom:event-category informational/config
    event AddressListed(address indexed who, uint64 indexed version);
    /// @notice `who` was removed from the own record by update `version`.
    /// @custom:event-category informational/config
    event AddressDelisted(address indexed who, uint64 indexed version);
    /// @notice An update was applied. Emitted once per update, after its
    ///         per-address events.
    /// @param version              The new `listVersion`.
    /// @param sourceHash           SHA-256 of the OFAC file it was built from.
    /// @param sourcePublicationDate  That file's publication date, `YYYYMMDD`.
    /// @param added                Addresses listed by this update.
    /// @param removed              Addresses delisted by this update.
    /// @param listedCount          Addresses listed after it.
    /// @param updater              Who applied it.
    /// @custom:event-category informational/config
    event ListUpdated(
        uint64 indexed version,
        bytes32 indexed sourceHash,
        uint32 sourcePublicationDate,
        uint256 added,
        uint256 removed,
        uint256 listedCount,
        address indexed updater
    );
    /// @notice The owner authorized one update from a publication that is
    ///         not newer than the recorded one (or cleared a pending
    ///         authorization, with zero values), against list `version`.
    /// @custom:event-category informational/admin
    event PublicationRollbackAuthorized(
        uint64 indexed version, uint32 publicationDate, bytes32 sourceHash, uint32 recordedDate, bytes32 recordedHash
    );
    /// @notice An update that did not need the pending authorization
    ///         cleared it unused (the state it was granted against is gone).
    /// @custom:event-category informational/config
    event PublicationRollbackCleared(uint64 indexed version, uint32 authorizedDate, bytes32 authorizedHash);
    /// @notice An update consumed that authorization.
    /// @custom:event-category informational/config
    event PublicationRollbackApplied(
        uint64 indexed version, uint32 fromDate, bytes32 fromHash, uint32 toDate, bytes32 toHash
    );

    /// @notice The caller is not an updater.
    error NotUpdater(address caller);
    /// @notice A non-zero secondary was given with no code behind it.
    error SecondaryHasNoCode(address secondary);
    /// @notice The diff was computed against a different list version.
    error StaleListVersion(uint64 expected, uint64 actual);
    /// @notice The zero address cannot be listed, delisted or appointed.
    error ZeroAddress();
    /// @notice The address to add is already listed.
    error AlreadyListed(address who);
    /// @notice The address to remove is not listed.
    error NotListed(address who);
    /// @notice One update named the same address to add and to remove.
    error AddedAndRemovedInOneUpdate(address who);
    /// @notice An update named no source file hash.
    error MissingSourceHash();
    /// @notice The publication date is not a valid `YYYYMMDD` calendar
    ///         shape (year 2000–2999, month 1–12, day 1–31).
    error InvalidPublicationDate(uint32 publicationDate);
    /// @notice The publication is not newer than the recorded one, and no
    ///         owner authorization names it.
    error PublicationNotNewer(uint32 publicationDate, bytes32 sourceHash, uint32 recordedDate, bytes32 recordedHash);
    /// @notice A rollback authorization named a publication newer than the
    ///         recorded one, which needs no authorization.
    error RollbackNotNeeded(uint32 publicationDate, uint32 recordedDate);
    /// @notice Renouncing ownership is disabled: it would leave the updater
    ///         set impossible to rotate.
    error RenounceDisabled();

    /// @param owner_      The chain's admin. Two-step ownership applies to
    ///                    every later transfer.
    /// @param secondary_  RedStone's Sanctions Oracle on this chain, or
    ///                    `address(0)` where it is not deployed. Immutable.
    constructor(address owner_, address secondary_) Ownable(owner_) ComposedSanctionsList(secondary_) {}

    modifier onlyUpdater() {
        if (!isUpdater[msg.sender]) revert NotUpdater(msg.sender);
        _;
    }

    // ── Roles ─────────────────────────────────────────────────────────

    /// @notice Appoint or remove an updater.
    function setUpdater(address account, bool enabled) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isUpdater[account] = enabled;
        emit UpdaterSet(account, enabled);
    }

    /// @notice Disabled — see {RenounceDisabled}.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice Authorize ONE update from a publication that is not newer
    ///         than the recorded one — a deliberate rollback, or a different
    ///         file issued on the recorded date. The update must name exactly
    ///         this date and hash; the authorization is consumed by it.
    ///         Pass `(0, 0)` to clear a pending authorization. A date newer
    ///         than the recorded one is refused, and ANY successful update
    ///         clears a pending authorization, used or not, so none can
    ///         outlive the state it was granted against.
    ///
    ///         The grant is bound to the list state the owner reviewed:
    ///         `expectedVersion` must equal `listVersion` when it executes
    ///         (Codex #2543 r5). Without it, an update mined between the
    ///         owner signing and this transaction landing would leave the
    ///         grant to be spent against a state nobody reviewed — the
    ///         clear-on-update rule only covers an update that lands AFTER
    ///         the grant. A clear `(0, 0)` needs no binding and ignores it.
    /// @dev    The owner authorizes the ORDERING exception only; the content
    ///         is still applied by an updater through {applyUpdate}, with its
    ///         usual version, duplicate and provenance checks.
    /// @param expectedVersion   The `listVersion` the owner reviewed.
    /// @param publicationDate   The publication to let through, `YYYYMMDD`.
    /// @param sourceHash_       That file's SHA-256.
    function authorizePublicationRollback(uint64 expectedVersion, uint32 publicationDate, bytes32 sourceHash_)
        external
        onlyOwner
    {
        uint64 current = listVersion;
        if (publicationDate != 0 || sourceHash_ != bytes32(0)) {
            if (expectedVersion != current) revert StaleListVersion(expectedVersion, current);
            _checkPublicationDate(publicationDate);
            if (sourceHash_ == bytes32(0)) revert MissingSourceHash();
            // A newer publication needs no authorization, and one granted for
            // it would never be consumed — it would linger as a standing
            // exception (Codex #2543 r2).
            if (publicationDate > sourcePublicationDate) {
                revert RollbackNotNeeded(publicationDate, sourcePublicationDate);
            }
        }
        rollbackAuthorizedDate = publicationDate;
        rollbackAuthorizedHash = sourceHash_;
        emit PublicationRollbackAuthorized(current, publicationDate, sourceHash_, sourcePublicationDate, sourceHash);
    }

    // ── Updates ───────────────────────────────────────────────────────

    /// @notice Apply one update built from one OFAC publication: list
    ///         `toAdd`, delist `toRemove`, and record the source.
    /// @dev    All or nothing. Additions are applied before removals, so an
    ///         address in both lists is caught by its `listedSinceVersion`
    ///         stamp rather than silently netting to no change. Publication
    ///         ordering is enforced first — see note 1a on the contract.
    /// @param expectedVersion      The `listVersion` the diff was computed
    ///                             against.
    /// @param toAdd                Addresses to list; none may be listed.
    /// @param toRemove             Addresses to delist; each must be listed.
    /// @param sourceHash_          SHA-256 of the OFAC file.
    /// @param publicationDate      That file's publication date, `YYYYMMDD`.
    function applyUpdate(
        uint64 expectedVersion,
        address[] calldata toAdd,
        address[] calldata toRemove,
        bytes32 sourceHash_,
        uint32 publicationDate
    ) external onlyUpdater {
        uint64 current = listVersion;
        if (expectedVersion != current) revert StaleListVersion(expectedVersion, current);
        if (sourceHash_ == bytes32(0)) revert MissingSourceHash();
        _checkPublicationDate(publicationDate);

        uint64 version = current + 1;
        _checkPublicationOrder(version, publicationDate, sourceHash_, toAdd.length + toRemove.length == 0);
        uint256 nAdd = toAdd.length;
        for (uint256 i; i < nAdd; ++i) {
            address who = toAdd[i];
            if (who == address(0)) revert ZeroAddress();
            if (!_listed.add(who)) revert AlreadyListed(who);
            listedSinceVersion[who] = version;
            emit AddressListed(who, version);
        }
        uint256 nRemove = toRemove.length;
        for (uint256 i; i < nRemove; ++i) {
            address who = toRemove[i];
            if (who == address(0)) revert ZeroAddress();
            if (listedSinceVersion[who] == version) revert AddedAndRemovedInOneUpdate(who);
            if (!_listed.remove(who)) revert NotListed(who);
            delete listedSinceVersion[who];
            emit AddressDelisted(who, version);
        }

        listVersion = version;
        lastUpdatedAt = uint64(block.timestamp);
        sourceHash = sourceHash_;
        sourcePublicationDate = publicationDate;
        emit ListUpdated(version, sourceHash_, publicationDate, nAdd, nRemove, _listed.length(), msg.sender);
    }

    /// @dev Accepts a newer publication, or a same-date refresh (identical
    ///      hash, no changes); otherwise consumes a matching owner
    ///      authorization or reverts. Note 1a on the contract says why.
    ///      Whatever path is taken, a successful update leaves NO pending
    ///      authorization: one it did not use is cleared and evented.
    function _checkPublicationOrder(uint64 version, uint32 date, bytes32 hash, bool noChanges) private {
        uint32 recordedDate = sourcePublicationDate;
        bytes32 recordedHash = sourceHash;
        uint32 pendingDate = rollbackAuthorizedDate;
        bytes32 pendingHash = rollbackAuthorizedHash;
        bool ordered = date > recordedDate || (date == recordedDate && hash == recordedHash && noChanges);
        if (!ordered) {
            if (pendingDate == 0 || date != pendingDate || hash != pendingHash) {
                revert PublicationNotNewer(date, hash, recordedDate, recordedHash);
            }
            emit PublicationRollbackApplied(version, recordedDate, recordedHash, date, hash);
        } else if (pendingDate != 0) {
            emit PublicationRollbackCleared(version, pendingDate, pendingHash);
        }
        if (pendingDate != 0) {
            delete rollbackAuthorizedDate;
            delete rollbackAuthorizedHash;
        }
    }

    /// @dev A `YYYYMMDD` shape check. It does not know month lengths; its job
    ///      is to make the value sortable and to refuse an obvious encoding
    ///      mistake (a Unix timestamp, `YYMMDD`, a swapped month and day).
    function _checkPublicationDate(uint32 date) private pure {
        uint32 year = date / 10_000;
        uint32 month = (date / 100) % 100;
        uint32 day = date % 100;
        if (year < 2000 || year > 2999 || month == 0 || month > 12 || day == 0 || day > 31) {
            revert InvalidPublicationDate(date);
        }
    }

    // ── Reads ─────────────────────────────────────────────────────────

    /// @notice RedStone's oracle (or another secondary) this list ORs with,
    ///         or `address(0)` when it has none.
    function secondary() external view returns (ISanctionsList) {
        return _secondary;
    }

    /// @notice True iff the own record lists `who`. Never reads the
    ///         secondary, so it answers during a secondary outage.
    function listedByOwnList(address who) public view returns (bool) {
        return _listed.contains(who);
    }

    /// @notice Which source flags `addr`.
    /// @dev    Reverts when the secondary cannot be read, even for an address
    ///         the own record lists — see `ComposedSanctionsList`. Use
    ///         {listedByOwnList} for the own record alone.
    /// @return byOwnList    The own record lists it.
    /// @return bySecondary  The secondary reports it; always false when there
    ///                      is no secondary.
    function sanctionSource(address addr) external view returns (bool byOwnList, bool bySecondary) {
        return _sanctionSource(addr);
    }

    /// @notice How many addresses the own record lists.
    function listedCount() external view returns (uint256) {
        return _listed.length();
    }

    /// @notice Up to `limit` listed addresses starting at `offset`, in the
    ///         set's internal order. That order is stable between updates
    ///         but NOT across them (a removal moves the last element into the
    ///         gap), so page through the whole set at ONE block.
    function listedPage(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 n = _listed.length();
        if (offset >= n) return new address[](0);
        // `n - offset` cannot underflow (offset < n), and comparing against
        // it avoids overflowing `offset + limit` for a huge `limit`.
        uint256 end = limit > n - offset ? n : offset + limit;
        page = new address[](end - offset);
        for (uint256 i; i < page.length; ++i) {
            page[i] = _listed.at(offset + i);
        }
    }

    /// @notice The secondary's own freshness, when it reports one.
    /// @dev    Calls `getLastUpdateBlockTimestamp()` (RedStone's freshness
    ///         read) with a low-level static call, so a secondary that lacks
    ///         the function, reverts, or answers in an unexpected shape
    ///         yields `known = false` instead of reverting this view. A
    ///         freshness that cannot be read is reported as unknown, never as
    ///         a time.
    /// @return known      The secondary answered with a 32-byte word.
    /// @return timestamp  Its answer; 0 when `known` is false.
    function secondaryLastUpdate() public view returns (bool known, uint256 timestamp) {
        if (address(_secondary) == address(0)) return (false, 0);
        (bool ok, bytes memory ret) =
            address(_secondary).staticcall(abi.encodeWithSignature("getLastUpdateBlockTimestamp()"));
        if (!ok || ret.length != 32) return (false, 0);
        return (true, abi.decode(ret, (uint256)));
    }

    /// @notice Everything a reader needs to judge how current this list is,
    ///         in one call.
    /// @return version                 `listVersion`.
    /// @return ownLastUpdatedAt        When the own record was last updated.
    /// @return ownSourceHash           SHA-256 of the OFAC file behind it.
    /// @return ownSourcePublicationDate That file's publication date, `YYYYMMDD`.
    /// @return hasSecondary            A secondary is configured.
    /// @return secondaryTimestampKnown The secondary reported its freshness.
    /// @return secondaryLastUpdatedAt  That report; 0 when unknown.
    function freshness()
        external
        view
        returns (
            uint64 version,
            uint64 ownLastUpdatedAt,
            bytes32 ownSourceHash,
            uint32 ownSourcePublicationDate,
            bool hasSecondary,
            bool secondaryTimestampKnown,
            uint256 secondaryLastUpdatedAt
        )
    {
        (secondaryTimestampKnown, secondaryLastUpdatedAt) = secondaryLastUpdate();
        return (
            listVersion,
            lastUpdatedAt,
            sourceHash,
            sourcePublicationDate,
            address(_secondary) != address(0),
            secondaryTimestampKnown,
            secondaryLastUpdatedAt
        );
    }

    // ── ComposedSanctionsList hooks ───────────────────────────────────

    /// @inheritdoc ComposedSanctionsList
    function _revertSecondaryHasNoCode(address secondary_) internal pure override {
        revert SecondaryHasNoCode(secondary_);
    }

    /// @inheritdoc ComposedSanctionsList
    function _flaggedByOwnRecord(address addr) internal view override returns (bool) {
        return _listed.contains(addr);
    }
}
