// src/libraries/LibProtectedAccount.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibProtectedAccount
 * @notice The rules of protected account mode, in one place, so the vault
 *         withdraw routes, the delivery layer and the three account facets
 *         cannot disagree.
 * @dev    Protected account mode puts a delay between a user's own payouts
 *         and their wallet. While it is on:
 *
 *         - A protocol payout from the owner's vault to the owner's wallet
 *           is QUEUED, not paid: the asset stays in the vault, held back by
 *           an earmark (`pendingPayoutEarmark`, subtracted by
 *           `LibEncumbrance.freeBalance`), and anyone may release it once
 *           its delay has passed. A queued payout to any other address is
 *           only possible to an allowlisted one.
 *         - A protocol payment from the Diamond's own balance to the owner's
 *           wallet is credited to the owner's vault instead
 *           (`LibDelivery`), so it, too, leaves only through the queue.
 *         - Every change that could help a thief (switching the mode off,
 *           shortening the delay, adding a destination or a signer, removing
 *           a signer, unlocking) waits the delay and can be cancelled; every
 *           change that can only reduce what a thief could take (locking,
 *           cancelling, raising the delay, removing a destination) is
 *           immediate.
 *         - A lock cancels every queued row and refuses every new position.
 *
 *         Accounts are keyed by the owner WALLET, like every other per-user
 *         ledger in the Diamond (`encumbered`, the tracked holding, loan
 *         parties). A replacement primary therefore does not rename the
 *         account: it RETIRES it and names a controller, which is then the
 *         only wallet that may manage it, and every payout the retired
 *         account makes goes to the controller, through the delay.
 *
 *         Written only through this library; storage lives at the tail of
 *         `LibVaipakam.Storage`.
 */
library LibProtectedAccount {
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSet for EnumerableSet.UintSet;

    // ─── Bounds ──────────────────────────────────────────────────────────

    /// @dev Shortest delay an account may run (owner decision 2026-11-02).
    uint32 internal constant MIN_DELAY = 2 days;
    /// @dev Longest delay an account may run.
    uint32 internal constant MAX_DELAY = 5 days;
    /// @dev Most secondary signers one account may have.
    uint256 internal constant MAX_SIGNERS = 5;
    /// @dev Fewest active secondary signers a signer-led replacement needs.
    uint256 internal constant MIN_RECOVERY_SIGNERS = 3;
    /// @dev Most extra destinations one account may allow (the owner wallet,
    ///      or a retired account's controller, is always allowed besides).
    uint256 internal constant MAX_ALLOWLIST = 5;
    /// @dev Most rows (payouts plus position transfers) one account may have
    ///      queued at once, so a lock can cancel them all in one call.
    uint256 internal constant MAX_OPEN_ROWS = 16;
    /// @dev How long the Diamond must have been under a manual pause, after
    ///      its launch, before the escape route opens (longer than the
    ///      governance timelock's 48-hour delay, so a pause that is part of
    ///      an ordinary fix never opens it).
    uint256 internal constant ESCAPE_GRACE = 3 days;

    uint8 internal constant ROW_QUEUED = 1;
    uint8 internal constant ROW_RELEASED = 2;
    uint8 internal constant ROW_CANCELLED = 3;

    /// @dev Transient slot binding one release to the vault withdraw route
    ///      it calls, so that one call (and nothing else) passes the gate.
    ///      keccak256("vaipakam.protected.release") - 1.
    bytes32 private constant RELEASE_SLOT =
        0x62b976649fb28f5447dd1b77efb2bc2bdd87d5a31ccb45a449a2815773f96fdb;
    /// @dev Transient flag: the current vault resolution is for a depository
    ///      step (deposit, withdraw, release, escape), which a pinned vault
    ///      below the mandatory version may still take.
    ///      keccak256("vaipakam.protected.depository") - 1.
    bytes32 private constant DEPOSITORY_SLOT =
        0xb13a1b53160943d1671bc33777959cbc7ce57085294bea3fc22d1b695a3f2c8f;

    // ─── Errors ──────────────────────────────────────────────────────────

    error ProtectedModeOff(address account);
    error ProtectedModeAlreadyOn(address account);
    error AccountRetired(address account);
    error NotAccountManager(address account, address caller);
    error NotManagerOrSigner(address account, address caller);
    error NotSigner(address account, address caller);
    error ProtectedVaultLocked(address account);
    error ProtectedVaultNotLocked(address account);
    error RecipientNotAllowlisted(address account, address recipient);
    error PayoutNotDue(uint256 id, uint256 releaseAt);
    error RowNotQueued(uint256 id);
    error CosignRequired(uint256 id);
    error TooManySigners();
    error TooManyAllowlisted();
    error TooManyPendingRows();
    error ChangeNotRequested();
    error ChangeNotMatured(uint256 at);
    error ChangeExpired(uint256 expiredAt);
    error PendingRowsExist();
    error DelayOutOfBounds(uint256 minDelay, uint256 maxDelay);
    error PrimaryInCooldown(uint256 until);
    error InvalidSigner(address signer);
    error SignerNotAccepted(address signer);
    error InvalidNominee(address nominee);
    error NotEnoughSigners(uint256 have, uint256 need);
    error NoReplacementProposed();
    error ReplacementNotReady();
    error OwnerCannotCancelWhileSignerLock();
    error AlreadyApproved();
    error AmountExceedsFree(uint256 requested, uint256 free);
    error EscapeClosed();

    // ─── Events (state-change/vault-mutation) ────────────────────────────

    /// @notice A payout from `account`'s vault was queued instead of paid.
    /// @custom:event-category state-change/vault-mutation
    event PayoutQueued(
        address indexed account,
        uint256 indexed id,
        address indexed asset,
        uint8 kind,
        uint256 tokenId,
        uint256 amount,
        address recipient,
        uint256 releaseAt
    );
    /// @notice A queued payout was paid. `delivered` is what the recipient
    ///         measurably received (an ERC-20 can deliver less than sent).
    /// @custom:event-category state-change/vault-mutation
    event PayoutReleased(
        address indexed account,
        uint256 indexed id,
        address indexed asset,
        uint256 amount,
        uint256 delivered,
        address recipient
    );
    /// @notice A queued payout was cancelled; the asset stays in the vault.
    /// @custom:event-category state-change/vault-mutation
    event PayoutCancelled(address indexed account, uint256 indexed id, address by);
    /// @notice A protocol payout to a LOCKED account's wallet was kept in its
    ///         vault rather than queued. Nothing left the vault.
    /// @custom:event-category state-change/vault-mutation
    event PayoutHeldInVault(
        address indexed account,
        address indexed asset,
        uint256 tokenId,
        uint256 amount
    );
    /// @notice A payment the Diamond made to a protected account's wallet was
    ///         credited to that account's vault instead (`received` is what
    ///         the vault measurably got).
    /// @custom:event-category state-change/vault-mutation
    event PaymentCreditedToVault(
        address indexed account,
        address indexed asset,
        uint256 amount,
        uint256 received
    );
    /// @custom:event-category state-change/vault-mutation
    event PositionTransferQueued(
        address indexed account,
        uint256 indexed id,
        uint256 indexed tokenId,
        address to,
        uint256 releaseAt
    );
    /// @custom:event-category state-change/vault-mutation
    event PositionTransferReleased(
        address indexed account,
        uint256 indexed id,
        uint256 indexed tokenId,
        address to
    );
    /// @custom:event-category state-change/vault-mutation
    event PositionTransferCancelled(address indexed account, uint256 indexed id, address by);

    // ─── Reads ───────────────────────────────────────────────────────────

    function _s() private pure returns (LibVaipakam.Storage storage) {
        return LibVaipakam.storageSlot();
    }

    /// @notice Whether protected account mode is on for `account`.
    function isEnabled(address account) internal view returns (bool) {
        return _s().protectedAccount[account].enabled;
    }

    /// @notice Whether `account`'s position NFTs carry the owner-level lock.
    function protectsNfts(address account) internal view returns (bool) {
        LibVaipakam.ProtectedAccount storage a = _s().protectedAccount[account];
        return a.enabled && a.protectNfts;
    }

    /// @notice The wallet that manages `account`: its controller once
    ///         retired by a replacement, else the account wallet itself.
    function manager(address account) internal view returns (address) {
        LibVaipakam.ProtectedAccount storage a = _s().protectedAccount[account];
        return a.retired ? a.controller : account;
    }

    /// @notice Whether `account` is an active secondary signer's account.
    function isSigner(address account, address who) internal view returns (bool) {
        return _s().protectedSigners[account].contains(who);
    }

    /// @notice Whether a payout from `account` may go to `recipient`: the
    ///         manager wallet always may; otherwise only an active
    ///         allowlisted destination.
    function isAllowed(address account, address recipient) internal view returns (bool) {
        if (recipient == manager(account)) return true;
        return _s().protectedAllowlist[account].contains(recipient);
    }

    /// @notice Refuse a NEW position (an offer, an accept, a match, a lender
    ///         intent, a signed fill, a sale or offset listing) for a locked
    ///         or retired account. Loan servicing is never refused.
    function requireCanOpen(address account) internal view {
        LibVaipakam.ProtectedAccount storage a = _s().protectedAccount[account];
        if (!a.enabled) return;
        if (a.retired) revert AccountRetired(account);
        if (a.locked) revert ProtectedVaultLocked(account);
    }

    /// @notice Open rows (payouts plus position transfers) of `account`.
    function openRows(address account) internal view returns (uint256) {
        return _s().pendingPayoutIds[account].length() + _s().pendingTransferIds[account].length();
    }

    /// @notice Whether the escape route is open: the Diamond has launched,
    ///         is under a manual pause, and has been for `ESCAPE_GRACE`.
    function escapeOpen(bool manuallyPaused, bool everUnpaused, uint256 pausedSince)
        internal
        view
        returns (bool)
    {
        return manuallyPaused && everUnpaused && block.timestamp >= pausedSince + ESCAPE_GRACE;
    }

    // ─── Transient bindings ──────────────────────────────────────────────

    /// @dev Bind the next gate pass to exactly one release.
    function bindRelease(address account, address asset, uint256 tokenId, uint256 amount, address recipient)
        internal
    {
        bytes32 key = keccak256(abi.encode(account, asset, tokenId, amount, recipient));
        bytes32 slot = RELEASE_SLOT;
        assembly ("memory-safe") {
            tstore(slot, key)
        }
    }

    /// @dev Consume the binding if it matches this call; true when it did.
    function consumeRelease(address account, address asset, uint256 tokenId, uint256 amount, address recipient)
        private
        returns (bool)
    {
        bytes32 slot = RELEASE_SLOT;
        bytes32 bound;
        assembly ("memory-safe") {
            bound := tload(slot)
        }
        if (bound == bytes32(0)) return false;
        if (bound != keccak256(abi.encode(account, asset, tokenId, amount, recipient))) return false;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
        return true;
    }

    /// @dev Mark (or clear) the current call as a depository step.
    function setDepositoryContext(bool on) internal {
        bytes32 slot = DEPOSITORY_SLOT;
        assembly ("memory-safe") {
            tstore(slot, on)
        }
    }

    /// @dev Whether the current call is a depository step.
    function inDepositoryContext() internal view returns (bool on) {
        bytes32 slot = DEPOSITORY_SLOT;
        assembly ("memory-safe") {
            on := tload(slot)
        }
    }

    // ─── The payout gate ─────────────────────────────────────────────────

    /// @notice The gate every vault withdraw route runs after its lien
    ///         check. Returns true when the payout must NOT be paid now
    ///         (it was queued, or held in the vault because the account is
    ///         locked), in which case the route returns `amount` to its
    ///         caller without moving anything.
    /// @dev    Gated: a payout from a protected `account`'s vault to the
    ///         account's own wallet, or to its controller once retired.
    ///         A payout to anyone else (a counterparty, a vault) is the
    ///         protocol settling a position and passes untouched; so does
    ///         the one call a release has bound.
    ///         A retired account's payout to its OLD wallet is redirected:
    ///         it is queued to the controller, because the old wallet is
    ///         the one the replacement took the account away from.
    function gate(
        address account,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) internal returns (bool held) {
        LibVaipakam.ProtectedAccount storage a = _s().protectedAccount[account];
        if (!a.enabled) return false;
        if (consumeRelease(account, asset, tokenId, amount, recipient)) return false;
        if (recipient != account && recipient != a.controller) return false;
        // Held, never refused: a protocol settlement must not revert because
        // the payee's account is locked or its queue is full. The asset stays
        // in the vault, tracked, for the owner to withdraw later.
        if (a.locked || openRows(account) >= MAX_OPEN_ROWS) {
            emit PayoutHeldInVault(account, asset, tokenId, amount);
            return true;
        }
        address to = a.retired ? a.controller : recipient;
        queuePayout(account, kind, asset, tokenId, amount, to);
        return true;
    }

    /// @notice Queue a payout of `amount` of `asset` / `tokenId` from
    ///         `account`'s vault to `recipient`, holding it back with an
    ///         earmark. The caller has already checked the amount is free.
    function queuePayout(
        address account,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) internal returns (uint256 id) {
        LibVaipakam.Storage storage s = _s();
        LibVaipakam.ProtectedAccount storage a = s.protectedAccount[account];
        if (a.locked) revert ProtectedVaultLocked(account);
        if (!isAllowed(account, recipient)) revert RecipientNotAllowlisted(account, recipient);
        if (openRows(account) >= MAX_OPEN_ROWS) revert TooManyPendingRows();
        id = ++s.protectedRowSeq;
        uint64 releaseAt = uint64(block.timestamp) + a.delaySeconds;
        s.pendingPayouts[id] = LibVaipakam.PendingPayout({
            user: account,
            kind: kind,
            state: ROW_QUEUED,
            cosigned: false,
            releaseAt: releaseAt,
            asset: asset,
            recipient: recipient,
            tokenId: tokenId,
            amount: amount,
            delivered: 0
        });
        s.pendingPayoutIds[account].add(id);
        s.pendingPayoutEarmark[account][asset][tokenId] += amount;
        emit PayoutQueued(account, id, asset, kind, tokenId, amount, recipient, releaseAt);
    }
    /// @notice Cancel queued payout `id`, releasing its earmark. The asset
    ///         never left the vault, so nothing moves.
    function cancelPayout(uint256 id, address by) internal {
        LibVaipakam.Storage storage s = _s();
        LibVaipakam.PendingPayout storage p = s.pendingPayouts[id];
        if (p.state != ROW_QUEUED) revert RowNotQueued(id);
        p.state = ROW_CANCELLED;
        s.pendingPayoutIds[p.user].remove(id);
        s.pendingPayoutEarmark[p.user][p.asset][p.tokenId] -= p.amount;
        emit PayoutCancelled(p.user, id, by);
    }

    /// @notice Take queued payout `id` off the queue for its release: the
    ///         earmark is lowered first, so the withdraw route's free-balance
    ///         check sees the amount as free again, and the route is bound
    ///         to this one payout. The caller then calls the route and
    ///         records what was delivered with {recordReleased}.
    function beginRelease(uint256 id) internal returns (LibVaipakam.PendingPayout storage p) {
        LibVaipakam.Storage storage s = _s();
        p = s.pendingPayouts[id];
        if (p.state != ROW_QUEUED) revert RowNotQueued(id);
        if (block.timestamp < p.releaseAt) revert PayoutNotDue(id, p.releaseAt);
        LibVaipakam.ProtectedAccount storage a = s.protectedAccount[p.user];
        if (a.locked) revert ProtectedVaultLocked(p.user);
        if (a.requireCosign && !p.cosigned) revert CosignRequired(id);
        p.state = ROW_RELEASED;
        s.pendingPayoutIds[p.user].remove(id);
        s.pendingPayoutEarmark[p.user][p.asset][p.tokenId] -= p.amount;
        bindRelease(p.user, p.asset, p.tokenId, p.amount, p.recipient);
    }

    /// @notice Record what a released payout delivered.
    function recordReleased(uint256 id, uint256 delivered) internal {
        LibVaipakam.PendingPayout storage p = _s().pendingPayouts[id];
        p.delivered = delivered;
        emit PayoutReleased(p.user, id, p.asset, p.amount, delivered, p.recipient);
    }

    /// @notice Queue a transfer of position NFT `tokenId` from `account` to
    ///         `to`. The caller has checked `account` holds it.
    function queueTransfer(address account, uint256 tokenId, address to) internal returns (uint256 id) {
        LibVaipakam.Storage storage s = _s();
        LibVaipakam.ProtectedAccount storage a = s.protectedAccount[account];
        if (a.locked) revert ProtectedVaultLocked(account);
        if (openRows(account) >= MAX_OPEN_ROWS) revert TooManyPendingRows();
        uint256 open = s.pendingTransferByToken[tokenId];
        if (open != 0) cancelTransfer(open, account);
        id = ++s.protectedRowSeq;
        uint64 releaseAt = uint64(block.timestamp) + a.delaySeconds;
        s.pendingPositionTransfers[id] = LibVaipakam.PendingPositionTransfer({
            from: account,
            state: ROW_QUEUED,
            releaseAt: releaseAt,
            to: to,
            tokenId: tokenId
        });
        s.pendingTransferIds[account].add(id);
        s.pendingTransferByToken[tokenId] = id;
        emit PositionTransferQueued(account, id, tokenId, to, releaseAt);
    }

    /// @notice Cancel queued position transfer `id`.
    function cancelTransfer(uint256 id, address by) internal {
        LibVaipakam.Storage storage s = _s();
        LibVaipakam.PendingPositionTransfer storage t = s.pendingPositionTransfers[id];
        if (t.state != ROW_QUEUED) revert RowNotQueued(id);
        t.state = ROW_CANCELLED;
        s.pendingTransferIds[t.from].remove(id);
        delete s.pendingTransferByToken[t.tokenId];
        emit PositionTransferCancelled(t.from, id, by);
    }

    /// @notice Take queued position transfer `id` off the queue for its
    ///         release. The caller then moves the NFT.
    function beginTransferRelease(uint256 id)
        internal
        returns (LibVaipakam.PendingPositionTransfer storage t)
    {
        LibVaipakam.Storage storage s = _s();
        t = s.pendingPositionTransfers[id];
        if (t.state != ROW_QUEUED) revert RowNotQueued(id);
        if (block.timestamp < t.releaseAt) revert PayoutNotDue(id, t.releaseAt);
        if (s.protectedAccount[t.from].locked) revert ProtectedVaultLocked(t.from);
        t.state = ROW_RELEASED;
        s.pendingTransferIds[t.from].remove(id);
        delete s.pendingTransferByToken[t.tokenId];
        emit PositionTransferReleased(t.from, id, t.tokenId, t.to);
    }

    /// @notice Cancel every queued row of `account` (a lock, a replacement,
    ///         a removed destination). Bounded by `MAX_OPEN_ROWS`.
    function cancelAllRows(address account, address by) internal {
        LibVaipakam.Storage storage s = _s();
        EnumerableSet.UintSet storage payouts = s.pendingPayoutIds[account];
        while (payouts.length() != 0) cancelPayout(payouts.at(payouts.length() - 1), by);
        EnumerableSet.UintSet storage transfers = s.pendingTransferIds[account];
        while (transfers.length() != 0) cancelTransfer(transfers.at(transfers.length() - 1), by);
    }

    /// @notice Cancel every queued payout of `account` addressed to
    ///         `recipient` (the destination was just removed).
    function cancelRowsTo(address account, address recipient, address by) internal {
        LibVaipakam.Storage storage s = _s();
        EnumerableSet.UintSet storage payouts = s.pendingPayoutIds[account];
        uint256 i = payouts.length();
        while (i != 0) {
            --i;
            uint256 id = payouts.at(i);
            if (s.pendingPayouts[id].recipient == recipient) cancelPayout(id, by);
        }
    }
}
