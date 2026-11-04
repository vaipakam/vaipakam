// src/facets/VaultPayoutFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibProtectedAccount} from "../libraries/LibProtectedAccount.sol";
import {LibDepositoryLedger} from "../libraries/LibDepositoryLedger.sol";
import {LibDelivery} from "../libraries/LibDelivery.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";

/// @dev The vault withdraw routes, reached by self-call so a release pays
///      through exactly the code (lien guard, measured delivery, tracked
///      ledger) every other payout uses.
interface IVaultWithdrawRoutes {
    function vaultWithdrawERC20(address user, address token, address recipient, uint256 amount)
        external
        returns (uint256 delivered);
    function vaultWithdrawERC721(address user, address nftContract, uint256 tokenId, address recipient) external;
    function vaultWithdrawERC1155(
        address user,
        address nftContract,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) external;
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
    /// @notice A secondary signer co-signed queued position transfer `id`.
    event PositionTransferCosigned(address indexed account, uint256 indexed id, address indexed signer);

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
        LibProtectedAccount.setDepositoryContext(true);
        delivered = _pay(p.kind, p.user, p.asset, p.tokenId, p.amount, p.recipient);
        LibProtectedAccount.setDepositoryContext(false);
        LibProtectedAccount.recordReleased(id, delivered);
    }

    function _pay(uint8 kind, address user, address asset, uint256 tokenId, uint256 amount, address recipient)
        private
        returns (uint256 delivered)
    {
        IVaultWithdrawRoutes routes = IVaultWithdrawRoutes(address(this));
        if (kind == uint8(LibVaipakam.AssetType.ERC20)) {
            return routes.vaultWithdrawERC20(user, asset, recipient, amount);
        }
        if (kind == uint8(LibVaipakam.AssetType.ERC721)) {
            routes.vaultWithdrawERC721(user, asset, tokenId, recipient);
            return 1;
        }
        routes.vaultWithdrawERC1155(user, asset, tokenId, amount, recipient);
        return amount;
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

    /// @notice Co-sign queued position transfer `id`. Caller: one of the
    ///         account's secondary signers. Needed before release while the
    ///         account requires co-signing, exactly as for a payout.
    function cosignPositionTransfer(uint256 id) external nonReentrant {
        LibVaipakam.PendingPositionTransfer storage t = LibVaipakam.storageSlot().pendingPositionTransfers[id];
        if (t.state != LibProtectedAccount.ROW_QUEUED) revert LibProtectedAccount.RowNotQueued(id);
        if (!LibProtectedAccount.isSigner(t.from, msg.sender)) revert LibProtectedAccount.NotSigner(t.from, msg.sender);
        t.cosigned = true;
        emit PositionTransferCosigned(t.from, id, msg.sender);
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
     * @notice During a manual pause that has lasted `ESCAPE_GRACE` since the
     *         Diamond's launch, take `amount` of a FREE asset out of your own
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
        LibProtectedAccount.setDepositoryContext(true);
        _pay(kind, msg.sender, asset, tokenId, amount, msg.sender);
        LibProtectedAccount.setDepositoryContext(false);
        emit EscapeWithdrawal(msg.sender, asset, tokenId, amount);
    }

    /// @notice Whether the escape route is open now.
    function isEscapeOpen() external view returns (bool) {
        return _escapeOpen();
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

    /// @notice Position-transfer row `id`, in whatever state it is.
    function getPendingPositionTransfer(uint256 id)
        external
        view
        returns (LibVaipakam.PendingPositionTransfer memory)
    {
        return LibVaipakam.storageSlot().pendingPositionTransfers[id];
    }

    /// @notice Ids of `account`'s queued position transfers.
    function getPendingTransferIds(address account) external view returns (uint256[] memory) {
        return LibVaipakam.storageSlot().pendingTransferIds[account].values();
    }

    /// @notice What `account`'s queued payouts hold back of `asset` / `tokenId`.
    function getPayoutEarmark(address account, address asset, uint256 tokenId) external view returns (uint256) {
        return LibVaipakam.storageSlot().pendingPayoutEarmark[account][asset][tokenId];
    }

    /**
     * @notice The short code the app and every alert show beside row `id`
     *         (a payout or a position transfer), so a user can match a
     *         message to a request. 30 bits, rendered as six base32
     *         characters off-chain. Derived from the chain, the Diamond and
     *         the id, so a phishing message cannot reuse a real code for a
     *         different request.
     */
    function requestCode(uint256 id) external view returns (uint32) {
        return uint32(uint256(keccak256(abi.encode(block.chainid, address(this), id)))) & 0x3FFFFFFF;
    }
}
