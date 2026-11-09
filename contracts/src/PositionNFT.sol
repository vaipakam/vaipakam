// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @notice The pluggable part that draws a position NFT. It can only answer
///         reads; nothing it returns can move a token.
interface IPositionRenderer {
    function tokenURI(uint256 tokenId) external view returns (string memory);
    function contractURI() external view returns (string memory);
    function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address receiver, uint256 amount);
}

/// @notice The pluggable part that may refuse a transfer. Called after the
///         core has recorded the move and before a safe transfer's receiver
///         hook; a revert refuses the transfer. It cannot move a token: the
///         core grants it no right to call any mutating entry.
interface IPositionTransferCheck {
    function checkPositionTransfer(address operator, address from, address to, uint256 tokenId) external;
}

/**
 * @title  PositionNFT
 * @author Vaipakam Developer Team
 * @notice The ownership record of every Vaipakam position (lender and borrower
 *         sides of an offer or a loan), held outside the Diamond (#3205,
 *         `docs/DesignsAndPlans/VaultOutflowPolicyDesign.md` §3.9). Before
 *         #3205 the owners lived in Diamond storage, so a faulty facet could
 *         rewrite who holds a position, and every payout follows the holder.
 *
 * @dev    Rules this contract holds by itself, whatever the Diamond does:
 *         - It is not upgradeable, so no upgrade can rewrite owners.
 *         - The Diamond (an immutable) may MINT a new position's token, and
 *           nothing else that moves one: it cannot transfer, approve or burn.
 *           No token is ever burned; a closed position's token stays with its
 *           holder as a receipt, and the Diamond reads the position as closed.
 *         - Every transfer adds one to the token's {transferCount}, which only
 *           ever rises. A protocol route records it when it starts and
 *           requires it unchanged at completion, so a position that moved
 *           (even away and back) cannot complete a route its earlier holder
 *           opened. That replaces the route locks the Diamond used to hold.
 *         - A holder may LOCK their own tokens (protected account mode's NFT
 *           protection): a locked holder's tokens do not move, they grant no
 *           approval, and approvals they gave before the lock are not honoured.
 *           Locking is immediate; unlocking waits the holder's lock delay.
 *           The Diamond may lock a holder, raise their delay up to
 *           {MAX_DIAMOND_LOCK_DELAY} and void a pending unlock or delay
 *           lowering (the powers protected mode needs, mirroring the
 *           VaultBeacon's pin-delay powers). It can never unlock a holder or
 *           lower a delay.
 *         - The renderer and the transfer check are each replaced only by the
 *           owner (the Timelock), in two steps no less than
 *           {MIN_COMPONENT_DELAY} apart; the owner or the guardian may cancel a
 *           pending replacement. A renderer only draws; a check can only
 *           refuse a transfer.
 *         - Ownership can never be renounced.
 *
 *         Known residual until #3205 PR 2: the recovery transfer (a vault
 *         that recorded its owner's primary replacement moves that owner's
 *         tokens to the new wallet) needs the vault's own replacement record,
 *         which PR 2 adds. Until then a replaced account's tokens stay with
 *         the old wallet, guarded only by the holder lock. Both PRs land
 *         before any deploy.
 */
contract PositionNFT is ERC721Enumerable, IERC2981, Ownable2Step {
    using EnumerableSet for EnumerableSet.AddressSet;

    // ─── Constants ───────────────────────────────────────────────────────

    /// @notice The minimum wait between proposing and executing a renderer or
    ///         transfer-check replacement. A constant, so no configuration can
    ///         shorten the window in which holders see a change coming.
    uint256 public constant MIN_COMPONENT_DELAY = 3 days;

    /// @notice The longest lock delay any path may set, the holder's own
    ///         included. Bounds every stored waiting time.
    uint256 public constant MAX_LOCK_DELAY = 30 days;

    /// @notice The highest lock delay the Diamond can set for a holder: the
    ///         longest protected-account delay (`LibProtectedAccount.MAX_DELAY`,
    ///         5 days), so protected mode can match the account's own delay.
    /// @dev    This bounds the delay, not the hold: the Diamond may also lock
    ///         a holder and void a pending unlock, and each void restarts the
    ///         holder's wait. Protected mode voids on its lock, replacement,
    ///         switch-off and re-enable, which a signer or a keeper with the
    ///         lock right can trigger, so a holder can be held longer than one
    ///         delay. That is the intended protection against a stolen key; it
    ///         also means a faulty Diamond can keep a holder locked, never move
    ///         or unlock its tokens.
    uint256 public constant MAX_DIAMOND_LOCK_DELAY = 5 days;

    // ─── Types ───────────────────────────────────────────────────────────

    /// @dev The two replaceable parts.
    enum Component { Renderer, TransferCheck }

    /// @dev A pending replacement. `executableAt` 0 means none.
    struct PendingComponent {
        address target;
        uint64 executableAt;
    }

    /// @dev A holder's lock. `unlockAt` is a pending unlock (0 = none);
    ///      `lowerDelay`/`lowerAt` a pending lowering of `delay` (`lowerAt`
    ///      0 = none). `epoch` rises on every lock, which retires every
    ///      approval the holder granted before it.
    struct HolderLock {
        bool locked;
        uint64 delay;
        uint64 unlockAt;
        uint64 lowerDelay;
        uint64 lowerAt;
        uint64 epoch;
    }

    // ─── Storage ─────────────────────────────────────────────────────────

    /// @notice The Diamond: the only minter, and the holder of the narrow
    ///         lock powers above.
    address public immutable diamond;
    /// @notice The Pauser Safe: may cancel a pending component replacement.
    address public guardian;
    /// @notice The contract that draws tokens (tokenURI, contractURI, royalty).
    address public renderer;
    /// @notice The contract that may refuse a transfer (0 = none).
    address public transferCheck;

    mapping(Component => PendingComponent) private _pendingComponent;
    /// @notice How many times each token has moved since it was minted.
    mapping(uint256 => uint256) public transferCount;
    mapping(address => HolderLock) private _locks;
    /// @dev The approval epoch a per-token approval was granted in.
    mapping(uint256 => uint64) private _tokenApprovalEpoch;
    /// @dev The approval epoch an operator approval was granted in.
    mapping(address => mapping(address => uint64)) private _operatorApprovalEpoch;
    /// @dev Every holder with a pending unlock (`unlockAt` != 0). Kept in step
    ///      by {_setUnlockAt}, the one writer of `unlockAt`, so a keeper can
    ///      find every unlock that will mature without replaying events.
    EnumerableSet.AddressSet private _pendingUnlocks;
    /// @dev Every holder with a pending delay lowering (`lowerAt` != 0). Kept
    ///      in step by {_setLowering}, the one writer of `lowerAt`.
    EnumerableSet.AddressSet private _pendingDelayChanges;

    // ─── Events ──────────────────────────────────────────────────────────

    /// @custom:event-category informational/governance
    event ComponentProposed(Component indexed kind, address indexed target, uint256 executableAt);
    /// @custom:event-category informational/governance
    event ComponentSet(Component indexed kind, address indexed oldTarget, address indexed newTarget);
    /// @custom:event-category informational/governance
    event ComponentProposalCancelled(Component indexed kind, address indexed target, address by);
    /// @custom:event-category informational/governance
    event GuardianSet(address indexed oldGuardian, address indexed newGuardian);
    /// @custom:event-category state-change/nft-mutation
    event HolderLocked(address indexed holder, address indexed by);
    /// @custom:event-category state-change/nft-mutation
    event HolderUnlockRequested(address indexed holder, uint256 executableAt);
    /// @custom:event-category state-change/nft-mutation
    event HolderUnlockCancelled(address indexed holder, address indexed by);
    /// @custom:event-category state-change/nft-mutation
    event HolderUnlocked(address indexed holder);
    /// @custom:event-category state-change/nft-mutation
    event LockDelaySet(address indexed holder, uint256 oldDelay, uint256 newDelay);
    /// @custom:event-category state-change/nft-mutation
    event LockDelayLowerRequested(address indexed holder, uint256 newDelay, uint256 executableAt);
    /// @custom:event-category state-change/nft-mutation
    event LockDelayLowerCancelled(address indexed holder, uint256 newDelay, address indexed by);

    // ─── Errors ──────────────────────────────────────────────────────────

    error ZeroAddress();
    error NoCode(address target);
    error NotDiamond(address caller);
    error NotOwnerOrGuardian(address caller);
    error RenounceDisabled();
    error ProposalPending(Component kind);
    error NoProposal(Component kind);
    error TooEarly(uint256 executableAt);
    error HolderIsLocked(address holder);
    error HolderNotLocked(address holder);
    error UnlockPending(address holder);
    error NoUnlockPending(address holder);
    error NoDelayChange(address holder);
    error DelayTooLong(uint256 requested, uint256 max);
    error DelayAboveDiamondCap(uint256 requested, uint256 cap);
    error DelayNotHigher(uint256 current, uint256 requested);

    // ─── Construction ────────────────────────────────────────────────────

    /// @param owner_     The Timelock (the deployer's admin until handover).
    /// @param diamond_   The Diamond: the only minter.
    /// @param guardian_  The Pauser Safe.
    /// @param renderer_  The first renderer (the Diamond's metadata facets).
    /// @param check_     The first transfer check (the Diamond), or 0.
    constructor(address owner_, address diamond_, address guardian_, address renderer_, address check_)
        ERC721("Vaipakam NFT", "VAIPAK")
        Ownable(owner_)
    {
        if (diamond_ == address(0) || guardian_ == address(0) || renderer_ == address(0)) revert ZeroAddress();
        if (renderer_.code.length == 0) revert NoCode(renderer_);
        if (check_ != address(0) && check_.code.length == 0) revert NoCode(check_);
        diamond = diamond_;
        guardian = guardian_;
        renderer = renderer_;
        transferCheck = check_;
        emit GuardianSet(address(0), guardian_);
        emit ComponentSet(Component.Renderer, address(0), renderer_);
        emit ComponentSet(Component.TransferCheck, address(0), check_);
    }

    // ─── Reads ───────────────────────────────────────────────────────────

    /// @notice The holder of `tokenId`, or 0 if it was never minted. Never
    ///         reverts (no token is ever burned, so 0 means "not minted").
    function holderOf(uint256 tokenId) external view returns (address) {
        return _ownerOf(tokenId);
    }

    /// @notice A holder's lock: whether it is on, its delay, a pending unlock
    ///         time and a pending delay lowering (0 = none pending).
    function lockOf(address holder)
        external
        view
        returns (bool locked, uint256 delay, uint256 unlockAt, uint256 lowerDelay, uint256 lowerAt)
    {
        HolderLock storage l = _locks[holder];
        return (l.locked, l.delay, l.unlockAt, l.lowerDelay, l.lowerAt);
    }

    /// @notice How many holders have an unlock pending.
    function pendingUnlockCount() external view returns (uint256) {
        return _pendingUnlocks.length();
    }

    /// @notice Up to `limit` holders with an unlock pending, from position
    ///         `offset`, with each one's `unlockAt`. Order is not stable
    ///         across a change to the set; a keeper re-reads from 0 each pass.
    function pendingUnlocks(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory holders, uint256[] memory unlockAt)
    {
        holders = _page(_pendingUnlocks, offset, limit);
        unlockAt = new uint256[](holders.length);
        for (uint256 i; i < holders.length; ++i) unlockAt[i] = _locks[holders[i]].unlockAt;
    }

    /// @notice How many holders have a lock-delay lowering pending.
    function pendingDelayChangeCount() external view returns (uint256) {
        return _pendingDelayChanges.length();
    }

    /// @notice Up to `limit` holders with a lock-delay lowering pending, from
    ///         position `offset`, with each one's new delay and `lowerAt`.
    function pendingDelayChanges(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory holders, uint256[] memory lowerDelay, uint256[] memory lowerAt)
    {
        holders = _page(_pendingDelayChanges, offset, limit);
        lowerDelay = new uint256[](holders.length);
        lowerAt = new uint256[](holders.length);
        for (uint256 i; i < holders.length; ++i) {
            HolderLock storage l = _locks[holders[i]];
            lowerDelay[i] = l.lowerDelay;
            lowerAt[i] = l.lowerAt;
        }
    }

    /// @notice Whether `holder`'s tokens are locked now.
    function isLocked(address holder) public view returns (bool) {
        return _locks[holder].locked;
    }

    /// @notice A pending component replacement (`executableAt` 0 = none).
    function pendingComponentOf(Component kind) external view returns (address target, uint256 executableAt) {
        PendingComponent storage p = _pendingComponent[kind];
        return (p.target, p.executableAt);
    }

    /// @inheritdoc ERC721
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return IPositionRenderer(renderer).tokenURI(tokenId);
    }

    /// @notice The collection metadata, drawn by the renderer.
    function contractURI() external view returns (string memory) {
        return IPositionRenderer(renderer).contractURI();
    }

    /// @inheritdoc IERC2981
    function royaltyInfo(uint256 tokenId, uint256 salePrice) external view returns (address, uint256) {
        return IPositionRenderer(renderer).royaltyInfo(tokenId, salePrice);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view override(ERC721Enumerable, IERC165) returns (bool) {
        return interfaceId == type(IERC2981).interfaceId || super.supportsInterface(interfaceId);
    }

    /// @inheritdoc ERC721
    /// @dev An operator approval granted before the holder's latest lock is
    ///      not honoured, and none is honoured while the holder is locked.
    function isApprovedForAll(address holder, address operator) public view override(ERC721, IERC721) returns (bool) {
        HolderLock storage l = _locks[holder];
        if (l.locked) return false;
        return super.isApprovedForAll(holder, operator) && _operatorApprovalEpoch[holder][operator] == l.epoch;
    }

    // ─── Minting (the Diamond) ───────────────────────────────────────────

    /// @notice Mint a new position's token to `to`. The Diamond only. A
    ///         contract recipient must accept it (ERC-721 safe mint). A token
    ///         minted to a locked holder is locked from the start.
    function mint(address to, uint256 tokenId) external onlyDiamond {
        _safeMint(to, tokenId);
    }

    // ─── Holder lock ─────────────────────────────────────────────────────

    /// @notice Lock the caller's tokens now. Drops a pending unlock.
    function lock() external {
        _lock(msg.sender);
    }

    /// @notice Ask to unlock the caller's tokens. Waits the caller's lock
    ///         delay; immediate when the delay is 0.
    function requestUnlock() external {
        HolderLock storage l = _locks[msg.sender];
        if (!l.locked) revert HolderNotLocked(msg.sender);
        if (l.unlockAt != 0) revert UnlockPending(msg.sender);
        if (l.delay == 0) {
            _unlock(msg.sender);
            return;
        }
        uint64 at = _at(l.delay);
        _setUnlockAt(msg.sender, at);
        emit HolderUnlockRequested(msg.sender, at);
    }

    /// @notice Withdraw the caller's pending unlock.
    function cancelUnlock() external {
        HolderLock storage l = _locks[msg.sender];
        if (l.unlockAt == 0) revert NoUnlockPending(msg.sender);
        _setUnlockAt(msg.sender, 0);
        emit HolderUnlockCancelled(msg.sender, msg.sender);
    }

    /// @notice Apply `holder`'s requested unlock once its delay has passed. Anyone.
    function executeUnlock(address holder) external {
        HolderLock storage l = _locks[holder];
        if (l.unlockAt == 0) revert NoUnlockPending(holder);
        if (block.timestamp < l.unlockAt) revert TooEarly(l.unlockAt);
        _unlock(holder);
    }

    /// @notice Set the caller's lock delay. A raise (or an equal value) takes
    ///         effect at once and drops a pending lowering; a lowering waits
    ///         the current delay and is applied by {executeLockDelay}.
    function setLockDelay(uint256 delay) external {
        _checkDelay(delay);
        HolderLock storage l = _locks[msg.sender];
        uint256 old = l.delay;
        if (delay >= old) {
            _dropLowering(msg.sender, msg.sender);
            if (delay != old) _setDelay(msg.sender, old, delay);
            return;
        }
        uint64 at = _at(old);
        _setLowering(msg.sender, SafeCast.toUint64(delay), at);
        emit LockDelayLowerRequested(msg.sender, delay, at);
    }

    /// @notice Apply `holder`'s requested lowering once the delay that held it
    ///         has passed. Anyone.
    function executeLockDelay(address holder) external {
        HolderLock storage l = _locks[holder];
        if (l.lowerAt == 0) revert NoDelayChange(holder);
        if (block.timestamp < l.lowerAt) revert TooEarly(l.lowerAt);
        uint256 newDelay = l.lowerDelay;
        _setLowering(holder, 0, 0);
        _setDelay(holder, l.delay, newDelay);
    }

    /// @notice Lock `holder`'s tokens. The Diamond only (protected mode).
    function lockFor(address holder) external onlyDiamond {
        _lock(holder);
    }

    /// @notice Raise `holder`'s lock delay, up to {MAX_DIAMOND_LOCK_DELAY}.
    ///         The Diamond only. Only ever raises.
    function raiseLockDelay(address holder, uint256 delay) external onlyDiamond {
        if (delay > MAX_DIAMOND_LOCK_DELAY) revert DelayAboveDiamondCap(delay, MAX_DIAMOND_LOCK_DELAY);
        uint256 old = _locks[holder].delay;
        if (delay <= old) revert DelayNotHigher(old, delay);
        _setDelay(holder, old, delay);
    }

    /// @notice Void `holder`'s pending unlock and pending delay lowering. The
    ///         Diamond only, whenever the holder's protected state begins or
    ///         ends, so nothing requested under one posture matures under the
    ///         next. Only ever refuses a change.
    function voidPending(address holder) external onlyDiamond {
        HolderLock storage l = _locks[holder];
        if (l.unlockAt != 0) {
            _setUnlockAt(holder, 0);
            emit HolderUnlockCancelled(holder, msg.sender);
        }
        _dropLowering(holder, msg.sender);
    }

    // ─── Components (the Timelock) ───────────────────────────────────────

    /// @notice Propose replacing a component. Executable after {MIN_COMPONENT_DELAY}.
    ///         A renderer must be a contract; a transfer check may be 0 (none).
    function proposeComponent(Component kind, address target) external onlyOwner {
        if (kind == Component.Renderer && target == address(0)) revert ZeroAddress();
        // A code-less target would make every read (renderer) or every
        // transfer (check) revert; refuse it at the proposal.
        if (target != address(0) && target.code.length == 0) revert NoCode(target);
        PendingComponent storage p = _pendingComponent[kind];
        if (p.executableAt != 0) revert ProposalPending(kind);
        uint64 at = _at(MIN_COMPONENT_DELAY);
        p.target = target;
        p.executableAt = at;
        emit ComponentProposed(kind, target, at);
    }

    /// @notice Execute a pending replacement after its delay. Anyone.
    function executeComponent(Component kind) external {
        PendingComponent memory p = _pendingComponent[kind];
        if (p.executableAt == 0) revert NoProposal(kind);
        if (block.timestamp < p.executableAt) revert TooEarly(p.executableAt);
        delete _pendingComponent[kind];
        if (kind == Component.Renderer) {
            emit ComponentSet(kind, renderer, p.target);
            renderer = p.target;
        } else {
            emit ComponentSet(kind, transferCheck, p.target);
            transferCheck = p.target;
        }
    }

    /// @notice Cancel a pending replacement. The Timelock or the guardian.
    function cancelComponent(Component kind) external {
        if (msg.sender != owner() && msg.sender != guardian) revert NotOwnerOrGuardian(msg.sender);
        PendingComponent memory p = _pendingComponent[kind];
        if (p.executableAt == 0) revert NoProposal(kind);
        delete _pendingComponent[kind];
        emit ComponentProposalCancelled(kind, p.target, msg.sender);
    }

    /// @notice Set the guardian. The Timelock only.
    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit GuardianSet(guardian, newGuardian);
        guardian = newGuardian;
    }

    /// @notice Ownership can never be renounced: an ownerless contract could
    ///         never replace a faulty renderer or transfer check.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ─── ERC-721 hooks ───────────────────────────────────────────────────

    /// @dev Every move passes here. A transfer (not a mint) is refused out of
    ///      a locked holder, counts one move, and is then shown to the
    ///      transfer check, which may refuse it. Burning has no entry.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0)) {
            if (_locks[from].locked) revert HolderIsLocked(from);
            unchecked {
                ++transferCount[tokenId];
            }
            address check = transferCheck;
            if (check != address(0)) {
                IPositionTransferCheck(check).checkPositionTransfer(auth, from, to, tokenId);
            }
        }
    }

    /// @dev A per-token approval is refused while the holder is locked and is
    ///      stamped with the holder's epoch, so a later lock retires it.
    function _approve(address to, uint256 tokenId, address auth, bool emitEvent) internal override {
        if (to != address(0)) {
            address holder = _requireOwned(tokenId);
            HolderLock storage l = _locks[holder];
            if (l.locked) revert HolderIsLocked(holder);
            _tokenApprovalEpoch[tokenId] = l.epoch;
        }
        super._approve(to, tokenId, auth, emitEvent);
    }

    /// @dev An operator approval is refused while the holder is locked and is
    ///      stamped with the holder's epoch. Revoking is always allowed.
    function _setApprovalForAll(address holder, address operator, bool approved) internal override {
        if (approved) {
            HolderLock storage l = _locks[holder];
            if (l.locked) revert HolderIsLocked(holder);
            _operatorApprovalEpoch[holder][operator] = l.epoch;
        }
        super._setApprovalForAll(holder, operator, approved);
    }

    /// @dev A per-token approval granted before the holder's latest lock, or
    ///      any approval while the holder is locked, is not honoured.
    function _getApproved(uint256 tokenId) internal view override returns (address) {
        address approved = super._getApproved(tokenId);
        if (approved == address(0)) return address(0);
        HolderLock storage l = _locks[_ownerOf(tokenId)];
        if (l.locked || _tokenApprovalEpoch[tokenId] != l.epoch) return address(0);
        return approved;
    }

    // ─── Internals ───────────────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert NotDiamond(msg.sender);
        _;
    }

    function _lock(address holder) private {
        HolderLock storage l = _locks[holder];
        _setUnlockAt(holder, 0);
        if (!l.locked) {
            l.locked = true;
            unchecked {
                ++l.epoch;
            }
        }
        emit HolderLocked(holder, msg.sender);
    }

    function _unlock(address holder) private {
        HolderLock storage l = _locks[holder];
        l.locked = false;
        _setUnlockAt(holder, 0);
        emit HolderUnlocked(holder);
    }

    function _dropLowering(address holder, address by) private {
        HolderLock storage l = _locks[holder];
        if (l.lowerAt == 0) return;
        emit LockDelayLowerCancelled(holder, l.lowerDelay, by);
        _setLowering(holder, 0, 0);
    }

    /// @dev THE writer of `unlockAt`: keeps {_pendingUnlocks} in step.
    function _setUnlockAt(address holder, uint64 at) private {
        _locks[holder].unlockAt = at;
        if (at == 0) _pendingUnlocks.remove(holder);
        else _pendingUnlocks.add(holder);
    }

    /// @dev THE writer of a pending lowering: keeps {_pendingDelayChanges}
    ///      in step. `at` 0 clears it.
    function _setLowering(address holder, uint64 newDelay, uint64 at) private {
        HolderLock storage l = _locks[holder];
        l.lowerDelay = newDelay;
        l.lowerAt = at;
        if (at == 0) _pendingDelayChanges.remove(holder);
        else _pendingDelayChanges.add(holder);
    }

    /// @dev A page of `set` from `offset`, at most `limit` long.
    function _page(EnumerableSet.AddressSet storage set, uint256 offset, uint256 limit)
        private
        view
        returns (address[] memory out)
    {
        uint256 n = set.length();
        if (offset >= n) return new address[](0);
        uint256 len = n - offset;
        if (limit < len) len = limit;
        out = new address[](len);
        for (uint256 i; i < out.length; ++i) out[i] = set.at(offset + i);
    }

    /// @dev THE lock-delay bound, applied by every path that sets one.
    function _checkDelay(uint256 delay) private pure {
        if (delay > MAX_LOCK_DELAY) revert DelayTooLong(delay, MAX_LOCK_DELAY);
    }

    function _setDelay(address holder, uint256 old, uint256 delay) private {
        _checkDelay(delay);
        // Any raise drops a pending lowering, so an older lowering can never
        // undo a later raise (protected mode turned on in between).
        if (delay > old) _dropLowering(holder, msg.sender);
        _locks[holder].delay = SafeCast.toUint64(delay);
        emit LockDelaySet(holder, old, delay);
    }

    /// @dev The one place a waiting time becomes a stored timestamp: computed
    ///      at full width and narrowed with a checked cast.
    function _at(uint256 wait) private view returns (uint64) {
        return SafeCast.toUint64(block.timestamp + wait);
    }
}
