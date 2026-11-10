// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IBeacon} from "@openzeppelin/contracts/proxy/beacon/IBeacon.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

/// @dev The one Diamond read the beacon makes: whether the protocol is paused.
///      A faulty facet can only set it to paused, which lets the guardian move
///      vaults to code that is already registered, and nothing more.
interface IDiamondPauseView {
    function paused() external view returns (bool);
}

/// @dev What every registered vault implementation must answer.
interface IVaultCode {
    /// @notice The storage-layout identity of the vault family.
    function vaultLayoutId() external view returns (bytes32);
}

/// @dev What every vault (a proxy running a registered implementation) answers.
interface IVaultOwnerRecord {
    /// @notice The owner wallet the vault recorded at creation.
    function vaultOwner() external view returns (address);
}

/**
 * @title  VaultBeacon
 * @author Vaipakam Developer Team
 * @notice The one place that decides which code every user vault runs (#3204,
 *         `docs/DesignsAndPlans/VaultCentralImplementationDesign.md`). Each
 *         vault is an OpenZeppelin `BeaconProxy` pointing here; on every call
 *         the proxy asks {implementation}, and the answer is given for the
 *         CALLING vault: its pinned version while that version is not revoked,
 *         otherwise the current version.
 *
 * @dev    Why a separate contract and not the Diamond: every facet runs in the
 *         Diamond's storage, so a faulty facet could overwrite a pointer kept
 *         there and every vault would run its code. No facet's storage write
 *         reaches this contract. The Diamond's only entries here are the pin
 *         requests (each carrying the vault owner's signature, verified here),
 *         a cancel (which can only refuse a change), and a capped raise of a
 *         vault's pin delay.
 *
 *         Rules this contract holds by itself, whatever its owner's own
 *         configuration says:
 *         - It is not upgradeable. A different rule set is a new deploy.
 *         - Setting the current version and revoking one are two steps, a
 *           proposal and an execution no sooner than {MIN_CODE_DELAY} later.
 *         - The guardian (the Pauser Safe) may cancel a pending proposal and,
 *           only while the Diamond reports paused, revoke a version onto code
 *           already registered. It can never register or propose code.
 *         - Revocation is final; one resolution rule: pinned and not revoked,
 *           else current.
 *         - A pin change (pin, re-pin, unpin) waits the vault's own pin delay,
 *           held here, so a facet holding a valid owner signature can neither
 *           execute it early nor after a cancel.
 *
 *         Known residual until #3205: the owner wallet is the one the vault
 *         recorded at creation. A protected account whose primary wallet was
 *         replaced cannot pin or unpin until #3205 records replacements in the
 *         vault. Testnets only: #3205 ships before any mainnet deploy.
 */
contract VaultBeacon is IBeacon, Ownable2Step, EIP712 {
    // ─── Constants ───────────────────────────────────────────────────────

    /// @notice The minimum wait between proposing and executing a change to
    ///         the current version, or a revoke. A constant, so no later
    ///         configuration (of this contract or of the Timelock) can shorten
    ///         the window in which owners see a change coming and pin.
    uint256 public constant MIN_CODE_DELAY = 3 days;

    /// @notice The highest pin delay the Diamond can set without the owner's
    ///         signature. Strictly below {MIN_CODE_DELAY}, so a pin requested
    ///         as soon as a code change is proposed can always execute before
    ///         that change does, whatever a faulty Diamond raised it to.
    uint256 public constant MAX_DIAMOND_PIN_DELAY = 2 days;

    /// @notice The longest pin delay any path may set, the owner's own
    ///         signature included. Bounds every stored waiting time, so no
    ///         delay can overflow the time it is added to.
    uint256 public constant MAX_PIN_DELAY = 30 days;

    /// @notice The layout identity every registered implementation must report.
    bytes32 public constant VAULT_LAYOUT_ID = keccak256("vaipakam.vault.layout.v1");

    bytes32 private constant PIN_CHANGE_TYPEHASH =
        keccak256("PinChange(address vault,uint256 target,uint256 nonce)");
    bytes32 private constant CANCEL_PIN_TYPEHASH =
        keccak256("CancelPin(address vault,uint256 nonce)");
    bytes32 private constant PIN_DELAY_TYPEHASH =
        keccak256("PinDelay(address vault,uint256 delay,uint256 nonce)");

    // ─── Types ───────────────────────────────────────────────────────────

    enum VersionStatus { None, Registered, Revoked }
    enum ProposalKind { None, CurrentVersion, Revoke }

    struct Version {
        address implementation;
        VersionStatus status;
    }

    struct Proposal {
        ProposalKind kind;
        uint64 id;
        uint64 successorId;
        uint64 executableAt;
    }

    /// @dev A requested pin change. `target` 0 means unpin; `executableAt` 0
    ///      means nothing is pending.
    struct PendingPin {
        uint64 target;
        uint64 executableAt;
    }

    /// @dev A requested lowering of a vault's pin delay.
    struct PendingDelay {
        uint64 delay;
        uint64 executableAt;
    }

    // ─── Storage ─────────────────────────────────────────────────────────

    /// @notice The Diamond: the only caller of the pin request entries, and
    ///         the source of the paused flag.
    address public immutable diamond;
    /// @notice The Pauser Safe: may cancel proposals and, while paused, revoke.
    address public guardian;

    mapping(uint256 => Version) private _versions;
    /// @notice The highest version id. Ids start at 1.
    uint256 public versionCount;
    /// @notice The version every unpinned vault runs.
    uint256 public currentVersionId;
    /// @notice The single pending code proposal, if any.
    Proposal public pendingProposal;

    /// @notice The version a vault's owner pinned (0 = not pinned).
    mapping(address => uint256) public pinnedVersion;
    /// @notice How long a pin change on a vault waits.
    mapping(address => uint256) public pinDelay;
    mapping(address => PendingPin) private _pendingPin;
    mapping(address => PendingDelay) private _pendingDelay;
    /// @notice Per-vault nonce for every owner-signed change; each use consumes one.
    mapping(address => uint256) public nonces;

    // ─── Events ──────────────────────────────────────────────────────────

    event VaultVersionRegistered(uint256 indexed id, address indexed implementation);
    event CurrentVaultVersionProposed(uint256 indexed id, uint256 executableAt);
    event CurrentVaultVersionSet(uint256 indexed oldId, uint256 indexed newId);
    event VaultRevokeProposed(uint256 indexed id, uint256 indexed successorId, uint256 executableAt);
    event VaultCodeProposalCancelled(uint8 indexed kind, uint256 indexed id, address indexed by);
    event VaultVersionRevoked(uint256 indexed id, uint256 indexed successorId, bool byGuardian);
    event VaultPinRequested(address indexed vault, uint256 indexed target, uint256 executableAt);
    event VaultVersionPinned(address indexed vault, uint256 indexed id);
    event VaultVersionUnpinned(address indexed vault);
    event VaultPinCancelled(address indexed vault, uint256 indexed target, address indexed by);
    event VaultPinDelaySet(address indexed vault, uint256 oldDelay, uint256 newDelay);
    event VaultPinDelayLowerRequested(address indexed vault, uint256 newDelay, uint256 executableAt);
    event VaultPinDelayLowerCancelled(address indexed vault, uint256 newDelay, address indexed by);
    event GuardianSet(address indexed oldGuardian, address indexed newGuardian);

    // ─── Errors ──────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotGuardian(address caller);
    error NotOwnerOrGuardian(address caller);
    error NotDiamond(address caller);
    error NoCode(address implementation);
    error NotAVaultImplementation(address implementation);
    error AlreadyRegistered(address implementation);
    error VersionNotLive(uint256 id);
    error ProposalPending();
    error NoProposal();
    error TooEarly(uint256 executableAt);
    error BadSuccessor(uint256 id, uint256 successorId);
    error NotPaused();
    error PinChangePending(address vault);
    error NoPinChange(address vault);
    error InvalidSignature(address vault, address signer);
    error DelayNotHigher(uint256 current, uint256 requested);
    error DelayAboveDiamondCap(uint256 requested, uint256 cap);
    error NoDelayChange(address vault);
    error RenounceDisabled();
    error DelayTooLong(uint256 requested, uint256 max);

    // ─── Construction ────────────────────────────────────────────────────

    /// @param owner_    The Timelock.
    /// @param diamond_  The Diamond.
    /// @param guardian_ The Pauser Safe.
    /// @param firstImplementation The first vault implementation; registered
    ///        as version 1 and made current at once (a fresh deploy has no
    ///        vault to protect yet, and the factory needs code to point at).
    /// @notice #3393 — the init-code hash of every vault proxy this beacon
    ///         serves: a BeaconProxy pointing here, constructed with no call
    ///         data (the factory initializes it in the same transaction). With
    ///         the Diamond as deployer and the creation owner as salt, a
    ///         vault's address is a function of its creation owner alone, so a
    ///         vault can tell a genuine vault from a look-alike by address.
    bytes32 public immutable PROXY_INIT_CODE_HASH;

    constructor(address owner_, address diamond_, address guardian_, address firstImplementation)
        Ownable(owner_)
        EIP712("Vaipakam VaultBeacon", "1")
    {
        if (diamond_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        diamond = diamond_;
        guardian = guardian_;
        PROXY_INIT_CODE_HASH =
            keccak256(abi.encodePacked(type(BeaconProxy).creationCode, abi.encode(address(this), bytes(""))));
        emit GuardianSet(address(0), guardian_);
        uint256 id = _register(firstImplementation);
        currentVersionId = id;
        emit CurrentVaultVersionSet(0, id);
    }

    // ─── Resolution ──────────────────────────────────────────────────────

    /// @inheritdoc IBeacon
    /// @dev Answered for `msg.sender`, the calling vault proxy: its pinned
    ///      version while that version is not revoked, otherwise the current
    ///      one. Any other caller gets the current version.
    function implementation() external view returns (address) {
        return _versions[resolvedVersionOf(msg.sender)].implementation;
    }

    /// @notice The version `vault` runs now.
    function resolvedVersionOf(address vault) public view returns (uint256) {
        uint256 pinned = pinnedVersion[vault];
        if (pinned != 0 && _versions[pinned].status == VersionStatus.Registered) return pinned;
        return currentVersionId;
    }

    /// @notice A version's implementation and status.
    function versionOf(uint256 id) external view returns (address implementation_, VersionStatus status) {
        Version storage v = _versions[id];
        return (v.implementation, v.status);
    }

    /// @notice A vault's pending pin change (`executableAt` 0 = none; `target` 0 = unpin).
    function pendingPinOf(address vault) external view returns (uint256 target, uint256 executableAt) {
        PendingPin storage p = _pendingPin[vault];
        return (p.target, p.executableAt);
    }

    /// @notice A vault's pending pin-delay lowering (`executableAt` 0 = none).
    function pendingPinDelayOf(address vault) external view returns (uint256 delay, uint256 executableAt) {
        PendingDelay storage p = _pendingDelay[vault];
        return (p.delay, p.executableAt);
    }

    // ─── Version registry (the Timelock) ─────────────────────────────────

    /// @notice Register a new vault implementation. It runs nowhere until a
    ///         proposal makes it current or an owner pins it.
    /// @dev    The implementation must report {VAULT_LAYOUT_ID}, so a contract
    ///         that is not a vault cannot be registered by mistake. That its
    ///         initializers are disabled cannot be read on-chain; the deploy
    ///         script and a test check it.
    function registerVersion(address impl) external onlyOwner returns (uint256 id) {
        id = _register(impl);
    }

    /// @notice Propose making `id` the current version.
    function proposeCurrentVersion(uint256 id) external onlyOwner {
        _requireLive(id);
        _openProposal(ProposalKind.CurrentVersion, id, 0);
        emit CurrentVaultVersionProposed(id, pendingProposal.executableAt);
    }

    /// @notice Execute the pending current-version proposal, after its delay.
    function executeCurrentVersion() external {
        Proposal memory p = _takeProposal(ProposalKind.CurrentVersion);
        _requireLive(p.id);
        uint256 old = currentVersionId;
        currentVersionId = p.id;
        emit CurrentVaultVersionSet(old, p.id);
    }

    /// @notice Propose revoking `id`. Revoking the current version needs a
    ///         live `successorId`, which becomes current in the same step;
    ///         otherwise `successorId` must be 0.
    function proposeRevoke(uint256 id, uint256 successorId) external onlyOwner {
        _checkRevoke(id, successorId);
        _openProposal(ProposalKind.Revoke, id, successorId);
        emit VaultRevokeProposed(id, successorId, pendingProposal.executableAt);
    }

    /// @notice Execute the pending revoke, after its delay.
    function executeRevoke() external {
        Proposal memory p = _takeProposal(ProposalKind.Revoke);
        _revoke(p.id, p.successorId, false);
    }

    /// @notice Cancel the pending proposal. The Timelock or the guardian.
    function cancelProposal() external {
        if (msg.sender != owner() && msg.sender != guardian) revert NotOwnerOrGuardian(msg.sender);
        Proposal memory p = pendingProposal;
        if (p.kind == ProposalKind.None) revert NoProposal();
        delete pendingProposal;
        emit VaultCodeProposalCancelled(uint8(p.kind), p.id, msg.sender);
    }

    /// @notice The emergency path: revoke `id` at once, only while the Diamond
    ///         is paused, and only onto code already registered.
    function guardianRevokeVersion(uint256 id, uint256 successorId) external {
        if (msg.sender != guardian) revert NotGuardian(msg.sender);
        if (!IDiamondPauseView(diamond).paused()) revert NotPaused();
        _revoke(id, successorId, true);
    }

    /// @notice Ownership can never be renounced: an ownerless beacon could
    ///         never register or revoke a version again, freezing every
    ///         vault's code. Ownership moves only by the two-step transfer.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @notice Set the guardian. The Timelock only.
    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit GuardianSet(guardian, newGuardian);
        guardian = newGuardian;
    }

    // ─── Pins (the owner's choice, held here) ────────────────────────────

    /// @notice Request pinning `vault` to version `id`, with its owner's
    ///         signature over (vault, id, nonce). The Diamond only.
    function requestPin(address vault, uint256 id, bytes calldata signature) external onlyDiamond {
        _requireLive(id);
        _requestPinChange(vault, id, signature);
    }

    /// @notice Request unpinning `vault`, with its owner's signature over
    ///         (vault, 0, nonce). The Diamond only.
    function requestUnpin(address vault, bytes calldata signature) external onlyDiamond {
        _requestPinChange(vault, 0, signature);
    }

    /// @notice Apply a requested pin change once its delay has passed. Anyone.
    function executePin(address vault) external {
        PendingPin memory p = _pendingPin[vault];
        if (p.executableAt == 0) revert NoPinChange(vault);
        if (block.timestamp < p.executableAt) revert TooEarly(p.executableAt);
        delete _pendingPin[vault];
        // A version revoked while the request waited is never pinned: the
        // request lapses, so it cannot hold the vault's pin slot forever.
        if (p.target != 0 && _versions[p.target].status != VersionStatus.Registered) {
            emit VaultPinCancelled(vault, p.target, address(this));
            return;
        }
        _applyPin(vault, p.target);
    }

    /// @notice Cancel a requested pin change. The Diamond (its protected-mode
    ///         cancel path), or anyone carrying the owner's signature over
    ///         (vault, nonce). Cancelling only ever refuses a change.
    function cancelPin(address vault, bytes calldata signature) external {
        PendingPin memory p = _pendingPin[vault];
        if (p.executableAt == 0) revert NoPinChange(vault);
        if (msg.sender != diamond) {
            _consumeSignature(vault, keccak256(abi.encode(CANCEL_PIN_TYPEHASH, vault, nonces[vault])), signature);
        }
        delete _pendingPin[vault];
        emit VaultPinCancelled(vault, p.target, msg.sender);
    }

    /// @notice Void every change pending for `vault`: a pin change and a
    ///         pin-delay lowering. The Diamond only, whenever the vault's
    ///         protected state begins or ends (switching protection on, a lock,
    ///         a primary replacement, a switch-off), so no change requested
    ///         under one posture can mature under the next. Cancelling only
    ///         ever refuses a change; it moves nothing.
    function voidPending(address vault) external onlyDiamond {
        PendingPin memory p = _pendingPin[vault];
        if (p.executableAt != 0) {
            delete _pendingPin[vault];
            emit VaultPinCancelled(vault, p.target, msg.sender);
        }
        PendingDelay memory d = _pendingDelay[vault];
        if (d.executableAt != 0) {
            delete _pendingDelay[vault];
            emit VaultPinDelayLowerCancelled(vault, d.delay, msg.sender);
        }
    }

    /// @notice Raise `vault`'s pin delay without the owner's signature, up to
    ///         {MAX_DIAMOND_PIN_DELAY}. The Diamond only (turning protected
    ///         mode on). Only ever raises.
    function raisePinDelay(address vault, uint256 delay) external onlyDiamond {
        if (delay > MAX_DIAMOND_PIN_DELAY) revert DelayAboveDiamondCap(delay, MAX_DIAMOND_PIN_DELAY);
        _checkDelay(delay);
        uint256 old = pinDelay[vault];
        if (delay <= old) revert DelayNotHigher(old, delay);
        _setDelay(vault, old, delay);
    }

    /// @notice Change `vault`'s pin delay with its owner's signature over
    ///         (vault, delay, nonce). Anyone may submit it. A raise takes
    ///         effect at once, with no cap; a lowering waits the current delay
    ///         and is then applied by {executePinDelay}.
    function setPinDelay(address vault, uint256 delay, bytes calldata signature) external {
        _checkDelay(delay);
        _consumeSignature(vault, keccak256(abi.encode(PIN_DELAY_TYPEHASH, vault, delay, nonces[vault])), signature);
        uint256 old = pinDelay[vault];
        if (delay >= old) {
            // Equal: nothing to change, but a pending lowering is withdrawn.
            delete _pendingDelay[vault];
            if (delay != old) _setDelay(vault, old, delay);
            return;
        }
        uint64 at = _at(old);
        _pendingDelay[vault] = PendingDelay({delay: SafeCast.toUint64(delay), executableAt: at});
        emit VaultPinDelayLowerRequested(vault, delay, at);
    }

    /// @notice Apply a requested lowering once the delay that held it has passed. Anyone.
    function executePinDelay(address vault) external {
        PendingDelay memory p = _pendingDelay[vault];
        if (p.executableAt == 0) revert NoDelayChange(vault);
        if (block.timestamp < p.executableAt) revert TooEarly(p.executableAt);
        delete _pendingDelay[vault];
        _setDelay(vault, pinDelay[vault], p.delay);
    }

    /// @notice The EIP-712 digest an owner signs to pin (`target` = id) or unpin (`target` = 0).
    function pinChangeDigest(address vault, uint256 target) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PIN_CHANGE_TYPEHASH, vault, target, nonces[vault])));
    }

    /// @notice The EIP-712 digest an owner signs to cancel a pending pin change.
    function cancelPinDigest(address vault) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CANCEL_PIN_TYPEHASH, vault, nonces[vault])));
    }

    /// @notice The EIP-712 digest an owner signs to set the pin delay.
    function pinDelayDigest(address vault, uint256 delay) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PIN_DELAY_TYPEHASH, vault, delay, nonces[vault])));
    }

    // ─── Internals ───────────────────────────────────────────────────────

    modifier onlyDiamond() {
        if (msg.sender != diamond) revert NotDiamond(msg.sender);
        _;
    }

    function _register(address impl) private returns (uint256 id) {
        if (impl.code.length == 0) revert NoCode(impl);
        bytes32 layoutId;
        try IVaultCode(impl).vaultLayoutId() returns (bytes32 l) {
            layoutId = l;
        } catch {
            revert NotAVaultImplementation(impl);
        }
        if (layoutId != VAULT_LAYOUT_ID) revert NotAVaultImplementation(impl);
        uint256 n = versionCount;
        for (uint256 i = 1; i <= n; ++i) {
            if (_versions[i].implementation == impl) revert AlreadyRegistered(impl);
        }
        id = n + 1;
        versionCount = id;
        _versions[id] = Version({implementation: impl, status: VersionStatus.Registered});
        emit VaultVersionRegistered(id, impl);
    }

    function _requireLive(uint256 id) private view {
        if (_versions[id].status != VersionStatus.Registered) revert VersionNotLive(id);
    }

    function _openProposal(ProposalKind kind, uint256 id, uint256 successorId) private {
        if (pendingProposal.kind != ProposalKind.None) revert ProposalPending();
        pendingProposal = Proposal({
            kind: kind,
            id: SafeCast.toUint64(id),
            successorId: SafeCast.toUint64(successorId),
            executableAt: _at(MIN_CODE_DELAY)
        });
    }

    function _takeProposal(ProposalKind kind) private returns (Proposal memory p) {
        p = pendingProposal;
        if (p.kind != kind) revert NoProposal();
        if (block.timestamp < p.executableAt) revert TooEarly(p.executableAt);
        delete pendingProposal;
    }

    function _checkRevoke(uint256 id, uint256 successorId) private view {
        _requireLive(id);
        if (id == currentVersionId) {
            if (successorId == id) revert BadSuccessor(id, successorId);
            _requireLive(successorId);
        } else if (successorId != 0) {
            revert BadSuccessor(id, successorId);
        }
    }

    function _revoke(uint256 id, uint256 successorId, bool byGuardian) private {
        _checkRevoke(id, successorId);
        _versions[id].status = VersionStatus.Revoked;
        if (id == currentVersionId) {
            currentVersionId = successorId;
            emit CurrentVaultVersionSet(id, successorId);
        }
        emit VaultVersionRevoked(id, successorId, byGuardian);
    }

    function _requestPinChange(address vault, uint256 target, bytes calldata signature) private {
        if (_pendingPin[vault].executableAt != 0) revert PinChangePending(vault);
        _consumeSignature(vault, keccak256(abi.encode(PIN_CHANGE_TYPEHASH, vault, target, nonces[vault])), signature);
        uint256 delay = pinDelay[vault];
        if (delay == 0) {
            emit VaultPinRequested(vault, target, block.timestamp);
            _applyPin(vault, target);
            return;
        }
        uint64 at = _at(delay);
        _pendingPin[vault] = PendingPin({target: SafeCast.toUint64(target), executableAt: at});
        emit VaultPinRequested(vault, target, at);
    }

    function _applyPin(address vault, uint256 target) private {
        if (target == 0) {
            delete pinnedVersion[vault];
            emit VaultVersionUnpinned(vault);
        } else {
            pinnedVersion[vault] = target;
            emit VaultVersionPinned(vault, target);
        }
    }

    /// @dev THE pin-delay bound, applied by every path that sets one (the
    ///      Diamond's raise, the owner's raise and the owner's lowering).
    function _checkDelay(uint256 delay) private pure {
        if (delay > MAX_PIN_DELAY) revert DelayTooLong(delay, MAX_PIN_DELAY);
    }

    /// @dev The one place a waiting time becomes a stored timestamp: computed
    ///      at full width and narrowed with a checked cast, never truncated.
    function _at(uint256 wait) private view returns (uint64) {
        return SafeCast.toUint64(block.timestamp + wait);
    }

    function _setDelay(address vault, uint256 old, uint256 delay) private {
        // Any raise also drops a pending lowering, so an older lowering can
        // never undo a later raise (protected mode turned on in between).
        if (delay > old) delete _pendingDelay[vault];
        pinDelay[vault] = delay;
        emit VaultPinDelaySet(vault, old, delay);
    }

    /// @dev Verify the vault owner's signature (EOA or ERC-1271) over `structHash`
    ///      and consume the vault's nonce. The owner is the wallet the vault
    ///      itself recorded at creation, never an answer from the Diamond.
    function _consumeSignature(address vault, bytes32 structHash, bytes calldata signature) private {
        address signer = IVaultOwnerRecord(vault).vaultOwner();
        if (signer == address(0) || !SignatureChecker.isValidSignatureNow(signer, _hashTypedDataV4(structHash), signature)) {
            revert InvalidSignature(vault, signer);
        }
        unchecked {
            ++nonces[vault];
        }
    }
}
