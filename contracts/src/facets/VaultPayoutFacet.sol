// src/facets/VaultPayoutFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {LibVaultOutflow} from "../libraries/LibVaultOutflow.sol";
import {OutflowReason} from "../vault/VaultOutflowTypes.sol";
import {LibDepositoryLedger} from "../libraries/LibDepositoryLedger.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";

/// @dev The vault withdraw routes, reached by self-call so a release pays
///      through exactly the code (lien guard, measured delivery, tracked
///      ledger) every other payout uses.
interface IVaultWithdrawRoutes {
}

/**
 * @title VaultPayoutFacet
 * @author Vaipakam Developer Team
 * @notice The payout queue of protected account mode: releasing, co-signing
 *         and cancelling queued payouts, the vault credit that replaces a
 *         wallet payment to a protected owner, and the escape route that
 *         lets every user reach their own free assets during a long pause.
 * @dev    Rows are created by the vault withdraw routes' gate and by
 *         `VaultDepositoryFacet.withdrawFromVault`, through
 *         `LibProtectedAccount`. A release lowers the earmark, binds the one
 *         route call it makes, and pays through that route, so the lien
 *         guard, the measured delivery and the tracked ledger apply to it
 *         exactly as to any other payout.
 */
contract VaultPayoutFacet is DiamondReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    error OnlySelf();
    error NoVaultForProtectedAccount(address owner);
    error EscapeNotForProtected(address account);

    /// @notice A user took free assets out of their own vault through the
    ///         escape route during a long pause.
    /// @custom:event-category state-change/vault-mutation
    event EscapeWithdrawal(address indexed account, address indexed asset, uint256 tokenId, uint256 amount);
    /// @notice A secondary signer co-signed queued payout `id`.
    /// @custom:event-category state-change/vault-mutation
    event PayoutCosigned(address indexed account, uint256 indexed id, address indexed signer);

    function _requireLiveOrEscape() private view {
        if (LibPausable.paused() && !_escapeOpen()) revert LibPausable.EnforcedPause();
    }

    function _escapeOpen() private view returns (bool) {
        return LibProtectedAccount.escapeOpen();
    }

    // ─── Vault credit (self-call host for LibDelivery) ───────────────────

    /**
     * @notice Credit `amount` of `token`, held by the Diamond, to protected
     *         wallet `owner`'s vault instead of paying the wallet.
     * @dev    Self-call only (`LibDelivery.creditIfProtected`). Measured at
     *         the vault: the tracked ledger rises by what arrived, and the
     *         Diamond may lose no more than `amount`. A protected account
     *         always has a vault (enabling the mode creates it); the vault is
     *         read directly, never created and never refused for a pending
     *         mandatory upgrade, because a forced close-out must not stall on
     *         the payee's vault version.
     * @return received What the vault received, at most `amount`.
     */
    function creditOwnerVault(address token, address owner, uint256 amount) external returns (uint256 received) {
        if (msg.sender != address(this)) revert OnlySelf();
        address proxy = LibVaipakam.storageSlot().userVaipakamVaults[owner];
        if (proxy == address(0)) revert NoVaultForProtectedAccount(owner);
        received = LibDelivery.pushMeasured(token, proxy, amount);
        LibProtectedAccount.creditPayment(owner, token, 0, amount, received);
    }

    /**
     * @notice The payout gate every vault withdraw route consults for an
     *         account with protected mode on (`LibProtectedAccount.gate`).
     * @dev    Self-call only. True when the payout must not be paid now.
     */
    function applyPayoutGate(
        address user,
        uint8 kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) external returns (bool held) {
        if (msg.sender != address(this)) revert OnlySelf();
        return LibProtectedAccount.gate(user, kind, asset, tokenId, amount, recipient);
    }

    // ─── Release, co-sign, cancel ────────────────────────────────────────

    /**
     * @notice Pay queued payout `id` once its delay has passed. Permissionless
     *         (the keeper backs it).
     * @dev    Refused while the account is locked, before the release time, or
     *         without a required co-sign. A payout whose destination is no
     *         longer allowed is CANCELLED instead of paid (the asset stays in
     *         the vault). The recipient is screened fail-closed, as a claim
     *         is: a flagged recipient's row stays queued, never lost. Runs
     *         during a long pause once the escape route is open.
     * @param id The pending payout.
     * @return delivered What the recipient measurably received (the amount
     *         for an NFT); zero when the row was cancelled.
     */
    function releasePayout(uint256 id) external nonReentrant returns (uint256 delivered) {
        _requireLiveOrEscape();
        LibVaipakam.PendingPayout storage row = LibVaipakam.storageSlot().pendingPayouts[id];
        if (row.state == LibProtectedAccount.ROW_QUEUED && !LibProtectedAccount.isAllowed(row.user, row.recipient)) {
            LibProtectedAccount.cancelPayout(id, address(this));
            return 0;
        }
        LibVaipakam.PendingPayout storage p = LibProtectedAccount.beginRelease(id);
        LibVaipakam.assertRecipientNotBarred(p.recipient);
        delivered = _pay(p.kind, p.user, p.asset, p.tokenId, p.amount, p.recipient, OutflowReason.PAYOUT_RELEASE);
        LibProtectedAccount.recordReleased(id, delivered);
    }

    /// @dev #3205 part 2 — through the one policy: the owner's wallet (the
    ///      vault's owner record, so a retired account's controller) is the
    ///      Owner class; an allowlisted address is OwnerAllowlisted (the policy
    ///      re-checks the allowlist). The release this call pays is bound beforehand, so the
    ///      payout gate lets exactly it through.
    function _pay(uint8 kind, address user, address asset, uint256 tokenId, uint256 amount, address recipient, uint8 reason)
        private
        returns (uint256 delivered)
    {
        // #3379 B2 — the owner class pays the vault's owner record (the
        // controller once a replacement moved it); anyone else on the
        // allowlist is OwnerAllowlisted.
        if (recipient == LibProtectedAccount.manager(user)) {
            return LibVaultOutflow.toOwner(user, kind, asset, tokenId, amount, reason);
        }
        return LibVaultOutflow.toAllowlisted(user, kind, asset, tokenId, amount, recipient, reason);
    }

    /// @notice A secondary signer co-signs queued payout `id` (needed for its
    ///         release while the account requires co-signing).
    function cosignPayout(uint256 id) external nonReentrant {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.PendingPayout storage p = s.pendingPayouts[id];
        if (p.state != LibProtectedAccount.ROW_QUEUED) revert LibProtectedAccount.RowNotQueued(id);
        if (!LibProtectedAccount.isSigner(p.user, msg.sender)) revert LibProtectedAccount.NotSigner(p.user, msg.sender);
        p.cosigned = true;
        emit PayoutCosigned(p.user, id, msg.sender);
    }

    /// @notice Cancel queued payout `id`; the asset stays in the vault. Works
    ///         during a pause. Caller: the account's manager or a signer.
    function cancelPayout(uint256 id) external nonReentrant {
        address account = LibVaipakam.storageSlot().pendingPayouts[id].user;
        if (msg.sender != LibProtectedAccount.manager(account) && !LibProtectedAccount.isSigner(account, msg.sender)) {
            revert LibProtectedAccount.NotManagerOrSigner(account, msg.sender);
        }
        LibProtectedAccount.cancelPayout(id, msg.sender);
    }

    // ─── Escape route ────────────────────────────────────────────────────

    /**
     * @notice During a manual pause that has lasted its escape period (#3173:
     *         the governance setting in force when the pause started, default
     *         3 days) after the Diamond's launch, take `amount` of a FREE asset out of your own
     *         vault to your own wallet.
     * @dev    For accounts without protected mode. A protected account's
     *         queued payouts keep releasing during the same window
     *         ({releasePayout}); its new payouts still queue through
     *         `VaultDepositoryFacet.withdrawFromVault`, which is not
     *         pause-gated for that reason. Bounded like the depository
     *         withdraw: by the depository ledger (what the user deposited,
     *         adopted or was paid into the vault) and by the tracked ledger
     *         minus liens and earmarks; nothing a loan, offer or claim holds
     *         can leave.
     * @param kind    `AssetType` as a uint8.
     * @param asset   The token.
     * @param tokenId Zero for an ERC-20.
     * @param amount  Units (one for an ERC-721).
     */
    function escapeWithdraw(uint8 kind, address asset, uint256 tokenId, uint256 amount) external nonReentrant {
        if (!_escapeOpen()) revert LibProtectedAccount.EscapeClosed();
        if (LibProtectedAccount.isEnabled(msg.sender)) revert EscapeNotForProtected(msg.sender);
        // Funds out: a barred wallet does not escape with them either.
        LibVaipakam.assertRecipientNotBarred(msg.sender);
        if (kind == uint8(LibVaipakam.AssetType.ERC20)) tokenId = 0;
        if (kind == uint8(LibVaipakam.AssetType.ERC721)) amount = 1;
        // The route below enforces the free holding; this bounds the escape by
        // what is the user's own.
        uint256 own = LibDepositoryLedger.holding(msg.sender, asset, tokenId);
        if (amount > own) revert LibProtectedAccount.AmountExceedsFree(amount, own);
        LibDepositoryLedger.debit(msg.sender, asset, tokenId, amount);
        _pay(kind, msg.sender, asset, tokenId, amount, msg.sender, OutflowReason.ESCAPE);
        emit EscapeWithdrawal(msg.sender, asset, tokenId, amount);
    }

    /// @notice Whether the escape route is open now.
    function isEscapeOpen() external view returns (bool) {
        return _escapeOpen();
    }

    /// @notice #3173 — when the escape route opens under the current manual
    ///         pause: the pause's start plus the escape period it started with.
    ///         Zero when no manual pause is in force or the Diamond has never
    ///         launched. A countdown reads this, never a hard-coded period.
    function escapeOpensAt() external view returns (uint256) {
        return LibProtectedAccount.escapeOpensAt();
    }

    // ─── Views ───────────────────────────────────────────────────────────

    /// @notice Payout row `id`, in whatever state it is.
    function getPendingPayout(uint256 id) external view returns (LibVaipakam.PendingPayout memory) {
        return LibVaipakam.storageSlot().pendingPayouts[id];
    }

    /// @notice Ids of `account`'s queued payouts.
    function getPendingPayoutIds(address account) external view returns (uint256[] memory) {
        return LibVaipakam.storageSlot().pendingPayoutIds[account].values();
    }

    /// @notice #3361 — how many payouts are queued now, across all accounts.
    function getOpenPayoutCount() external view returns (uint256) {
        return LibVaipakam.storageSlot().openPayoutIds.length();
    }

    /**
     * @notice #3361 — up to `limit` queued payout ids, across all accounts,
     *         from position `offset` of the open set. The set's order is not
     *         stable: a release or cancel moves the last id into the freed
     *         position, so a reader paging through it may see an id twice or
     *         miss one that moved. A keeper re-reads each row
     *         ({getPendingPayout}) before acting, and pages again later.
     * @return ids The ids; shorter than `limit` at the end of the set.
     */
    function getOpenPayoutIds(uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        EnumerableSet.UintSet storage open = LibVaipakam.storageSlot().openPayoutIds;
        uint256 len = open.length();
        if (offset >= len) return new uint256[](0);
        uint256 end = len - offset < limit ? len : offset + limit;
        ids = new uint256[](end - offset);
        for (uint256 i; i < ids.length; i++) ids[i] = open.at(offset + i);
    }

    /// @notice What `account`'s queued payouts hold back of `asset` / `tokenId`.
    function getPayoutEarmark(address account, address asset, uint256 tokenId) external view returns (uint256) {
        return LibVaipakam.storageSlot().pendingPayoutEarmark[account][asset][tokenId];
    }

    /**
     * @notice The short code the app and every alert show beside row `id`
     *         (a payout), so a user can match a
     *         message to a request. 30 bits, rendered as six base32
     *         characters off-chain. Derived from the chain, the Diamond and
     *         the id, so a phishing message cannot reuse a real code for a
     *         different request.
     */
    function requestCode(uint256 id) external view returns (uint32) {
        return uint32(uint256(keccak256(abi.encode(block.chainid, address(this), id)))) & 0x3FFFFFFF;
    }
}
