// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IProtocolRegistryReader} from "../interfaces/IProtocolRegistryReader.sol";

/**
 * @title  ProtocolRegistry
 * @author Vaipakam Developer Team
 * @notice The endpoints that the Diamond and every user vault must agree on,
 *         held outside the Diamond so that no facet can change them (#3272;
 *         `docs/DesignsAndPlans/VaultOutflowPolicyDesign.md` §3.6). It holds
 *         two kinds of entry, each named by a `bytes32` key from
 *         {RegistryKeys}:
 *         - a **pointer**: one address per key (the price guard, and later
 *           the treasury and the backstop);
 *         - a **membership set**: any number of addresses per key (later the
 *           swap adapters and conduits).
 *         Pointers and sets are separate namespaces; {RegistryKeys} never
 *         gives one name to both.
 *
 * @dev    Rules this contract holds by itself, whatever its owner's own
 *         configuration says:
 *         - It is not upgradeable. A different rule set is a new deploy.
 *         - The pointers passed to the constructor are the only writes that
 *           do not wait, and they exist only at construction.
 *         - Every change that ADDS trust waits: a pointer change, a new set
 *           member and a lowered delay are each a proposal by the owner (the
 *           Timelock) and an execution, by anyone, no sooner than the delay
 *           later. There is no instant path for any of them.
 *         - The delay is never below {MIN_DELAY} (the VaultBeacon's code
 *           delay) and never above {MAX_DELAY}. Raising it applies at once,
 *           because a longer wait only tightens. Lowering it waits the
 *           current delay.
 *         - Every waiting time is fixed when it is proposed. A later change of
 *           the delay never moves the execution time of a change already
 *           pending, in either direction.
 *         - One pending change at a time per pointer key, per set member and
 *           for the delay. Proposing again while one is pending reverts; the
 *           pending one is cancelled first. So every execution time and every
 *           event names exactly one change.
 *         - The guardian (the Pauser Safe) and the owner may cancel any
 *           pending change. Cancelling only ever refuses a change.
 *         - Removing a set member is instant, for the owner or the guardian,
 *           because a removal can only stop value moving. It also cancels a
 *           pending add of the same member.
 *         - A pointer is never cleared to zero: it is replaced, through the
 *           same delay. Consumers read it through {requirePointer}, which
 *           refuses an unset key, so no caller treats `address(0)` as a real
 *           endpoint.
 *
 *         The guardian itself is set by the owner directly, as on the
 *         VaultBeacon and the feed registry: the owner is the Timelock, whose
 *         own delay and canceller already stand in front of that call, and
 *         the handover moves every guardian to the Pauser Safe in one loop.
 */
contract ProtocolRegistry is Ownable2Step, IProtocolRegistryReader {
    using EnumerableSet for EnumerableSet.AddressSet;

    // ─── Constants ───────────────────────────────────────────────────────

    /// @notice The shortest delay the registry accepts. A constant, so no
    ///         later configuration can shorten the window in which a change
    ///         is visible before it applies.
    uint256 public constant MIN_DELAY = 3 days;

    /// @notice The longest delay the registry accepts. Bounds every stored
    ///         waiting time, and keeps a raised delay from freezing every
    ///         future change.
    uint256 public constant MAX_DELAY = 30 days;

    // ─── Types ───────────────────────────────────────────────────────────

    /// @dev A proposed pointer value. `executableAt` 0 means nothing is pending.
    struct PendingPointer {
        address next;
        uint64 executableAt;
    }

    /// @dev A proposed lowering of the delay. `executableAt` 0 means nothing is pending.
    struct PendingDelay {
        uint64 delay;
        uint64 executableAt;
    }

    // ─── Storage ─────────────────────────────────────────────────────────

    /// @notice The Pauser Safe: may cancel any pending change and remove a set member.
    address public guardian;

    /// @notice The wait between proposing and executing a change.
    uint256 public delay;

    mapping(bytes32 => address) private _pointers;
    mapping(bytes32 => PendingPointer) private _pendingPointers;
    mapping(bytes32 => EnumerableSet.AddressSet) private _members;
    /// @dev set => member => the time its pending add may execute (0 = none).
    mapping(bytes32 => mapping(address => uint64)) private _pendingAdds;
    PendingDelay private _pendingDelay;

    // ─── Events ──────────────────────────────────────────────────────────

    event PointerProposed(bytes32 indexed key, address indexed current, address indexed next, uint256 executableAt);
    event PointerSet(bytes32 indexed key, address indexed oldValue, address indexed newValue);
    event PointerCancelled(bytes32 indexed key, address indexed next, address indexed by);
    event MemberProposed(bytes32 indexed set, address indexed member, uint256 executableAt);
    event MemberAdded(bytes32 indexed set, address indexed member);
    event MemberAddCancelled(bytes32 indexed set, address indexed member, address indexed by);
    event MemberRemoved(bytes32 indexed set, address indexed member, address indexed by);
    event DelayProposed(uint256 oldDelay, uint256 newDelay, uint256 executableAt);
    event DelaySet(uint256 oldDelay, uint256 newDelay);
    event DelayCancelled(uint256 newDelay, address indexed by);
    event GuardianSet(address indexed oldGuardian, address indexed newGuardian);

    // ─── Errors ──────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotOwnerOrGuardian(address caller);
    error NoChange();
    error ChangePending();
    error NothingPending();
    error TooEarly(uint256 executableAt);
    error AlreadyMember(bytes32 set, address member);
    error NotMember(bytes32 set, address member);
    error DelayOutOfRange(uint256 requested, uint256 min, uint256 max);
    error RenounceDisabled();
    error LengthMismatch();

    // ─── Construction ────────────────────────────────────────────────────

    /// @param owner_    The owner: the deployer's admin, then the Timelock at handover.
    /// @param guardian_ The guardian: the admin until the handover moves it to the Pauser Safe.
    /// @param delay_    The starting delay, within [{MIN_DELAY}, {MAX_DELAY}].
    /// @param keys      Pointer keys set at construction, with no wait: a fresh
    ///                  deploy has nothing in use to protect yet. This is the
    ///                  ONLY write to the registry that does not wait the
    ///                  delay, and it exists only here: once deployed, every
    ///                  pointer change goes through {proposePointer}.
    /// @param values    Their values, one per key, none zero.
    constructor(
        address owner_,
        address guardian_,
        uint256 delay_,
        bytes32[] memory keys,
        address[] memory values
    ) Ownable(owner_) {
        if (guardian_ == address(0)) revert ZeroAddress();
        _checkDelay(delay_);
        if (keys.length != values.length) revert LengthMismatch();
        guardian = guardian_;
        emit GuardianSet(address(0), guardian_);
        delay = delay_;
        emit DelaySet(0, delay_);
        for (uint256 i; i < keys.length; ++i) {
            if (values[i] == address(0)) revert ZeroAddress();
            if (_pointers[keys[i]] != address(0)) revert NoChange();
            _pointers[keys[i]] = values[i];
            emit PointerSet(keys[i], address(0), values[i]);
        }
    }

    // ─── Reads ───────────────────────────────────────────────────────────

    /// @notice The value of pointer `key`, or `address(0)` when it was never set.
    function pointer(bytes32 key) external view returns (address) {
        return _pointers[key];
    }

    /// @notice The value of pointer `key`. Reverts {PointerUnset} when it was
    ///         never set, so a consumer fails closed instead of reading zero.
    function requirePointer(bytes32 key) external view returns (address value) {
        value = _pointers[key];
        if (value == address(0)) revert PointerUnset(key);
    }

    /// @notice The pending change of pointer `key` (`executableAt` 0 = none).
    function pendingPointer(bytes32 key) external view returns (address next, uint256 executableAt) {
        PendingPointer storage p = _pendingPointers[key];
        return (p.next, p.executableAt);
    }

    /// @notice Whether `member` is in set `set`.
    function isMember(bytes32 set, address member) external view returns (bool) {
        return _members[set].contains(member);
    }

    /// @notice Every member of set `set`, in no particular order.
    function members(bytes32 set) external view returns (address[] memory) {
        return _members[set].values();
    }

    /// @notice How many members set `set` has.
    function memberCount(bytes32 set) external view returns (uint256) {
        return _members[set].length();
    }

    /// @notice When the pending add of `member` to `set` may execute (0 = none pending).
    function pendingAdd(bytes32 set, address member) external view returns (uint256 executableAt) {
        return _pendingAdds[set][member];
    }

    /// @notice The pending lowering of the delay (`executableAt` 0 = none).
    function pendingDelay() external view returns (uint256 newDelay, uint256 executableAt) {
        PendingDelay storage p = _pendingDelay;
        return (p.delay, p.executableAt);
    }

    // ─── Pointers ────────────────────────────────────────────────────────

    /// @notice Propose setting pointer `key` to `next`. The owner only. It may
    ///         execute no sooner than the current delay from now.
    function proposePointer(bytes32 key, address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        if (_pendingPointers[key].executableAt != 0) revert ChangePending();
        address current = _pointers[key];
        if (next == current) revert NoChange();
        uint64 at = _at(delay);
        _pendingPointers[key] = PendingPointer({next: next, executableAt: at});
        emit PointerProposed(key, current, next, at);
    }

    /// @notice Apply the pending change of pointer `key` once its time has come. Anyone.
    function executePointer(bytes32 key) external {
        PendingPointer memory p = _pendingPointers[key];
        if (p.executableAt == 0) revert NothingPending();
        if (block.timestamp < p.executableAt) revert TooEarly(p.executableAt);
        delete _pendingPointers[key];
        address old = _pointers[key];
        _pointers[key] = p.next;
        emit PointerSet(key, old, p.next);
    }

    /// @notice Cancel the pending change of pointer `key`. The owner or the guardian.
    function cancelPointer(bytes32 key) external onlyOwnerOrGuardian {
        PendingPointer memory p = _pendingPointers[key];
        if (p.executableAt == 0) revert NothingPending();
        delete _pendingPointers[key];
        emit PointerCancelled(key, p.next, msg.sender);
    }

    // ─── Membership sets ─────────────────────────────────────────────────

    /// @notice Propose adding `member` to `set`. The owner only. It may
    ///         execute no sooner than the current delay from now.
    function proposeAdd(bytes32 set, address member) external onlyOwner {
        if (member == address(0)) revert ZeroAddress();
        if (_members[set].contains(member)) revert AlreadyMember(set, member);
        if (_pendingAdds[set][member] != 0) revert ChangePending();
        uint64 at = _at(delay);
        _pendingAdds[set][member] = at;
        emit MemberProposed(set, member, at);
    }

    /// @notice Apply the pending add of `member` to `set` once its time has come. Anyone.
    function executeAdd(bytes32 set, address member) external {
        uint64 at = _pendingAdds[set][member];
        if (at == 0) revert NothingPending();
        if (block.timestamp < at) revert TooEarly(at);
        delete _pendingAdds[set][member];
        _members[set].add(member);
        emit MemberAdded(set, member);
    }

    /// @notice Cancel the pending add of `member` to `set`. The owner or the guardian.
    function cancelAdd(bytes32 set, address member) external onlyOwnerOrGuardian {
        if (_pendingAdds[set][member] == 0) revert NothingPending();
        delete _pendingAdds[set][member];
        emit MemberAddCancelled(set, member, msg.sender);
    }

    /// @notice Remove `member` from `set` at once, and cancel a pending add of
    ///         it. The owner or the guardian. Instant, because a removal can
    ///         only stop value moving.
    function remove(bytes32 set, address member) external onlyOwnerOrGuardian {
        bool pending = _pendingAdds[set][member] != 0;
        bool present = _members[set].contains(member);
        if (!pending && !present) revert NotMember(set, member);
        if (pending) {
            delete _pendingAdds[set][member];
            emit MemberAddCancelled(set, member, msg.sender);
        }
        if (present) {
            _members[set].remove(member);
            emit MemberRemoved(set, member, msg.sender);
        }
    }

    // ─── The delay ───────────────────────────────────────────────────────

    /// @notice Change the delay. The owner only. A raise applies at once and
    ///         also withdraws a pending lowering, so an older lowering can
    ///         never undo a later raise. A lowering waits the current delay
    ///         and is then applied by {executeDelay}. Neither moves the
    ///         execution time of any change already pending.
    function proposeDelay(uint256 newDelay) external onlyOwner {
        _checkDelay(newDelay);
        uint256 old = delay;
        if (newDelay == old) revert NoChange();
        if (newDelay > old) {
            if (_pendingDelay.executableAt != 0) {
                emit DelayCancelled(_pendingDelay.delay, msg.sender);
                delete _pendingDelay;
            }
            delay = newDelay;
            emit DelaySet(old, newDelay);
            return;
        }
        if (_pendingDelay.executableAt != 0) revert ChangePending();
        uint64 at = _at(old);
        _pendingDelay = PendingDelay({delay: SafeCast.toUint64(newDelay), executableAt: at});
        emit DelayProposed(old, newDelay, at);
    }

    /// @notice Apply the pending lowering of the delay once its time has come. Anyone.
    function executeDelay() external {
        PendingDelay memory p = _pendingDelay;
        if (p.executableAt == 0) revert NothingPending();
        if (block.timestamp < p.executableAt) revert TooEarly(p.executableAt);
        delete _pendingDelay;
        uint256 old = delay;
        delay = p.delay;
        emit DelaySet(old, p.delay);
    }

    /// @notice Cancel the pending lowering of the delay. The owner or the guardian.
    function cancelDelay() external onlyOwnerOrGuardian {
        PendingDelay memory p = _pendingDelay;
        if (p.executableAt == 0) revert NothingPending();
        delete _pendingDelay;
        emit DelayCancelled(p.delay, msg.sender);
    }

    // ─── Roles ───────────────────────────────────────────────────────────

    /// @notice Set the guardian. The owner only.
    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit GuardianSet(guardian, newGuardian);
        guardian = newGuardian;
    }

    /// @notice Ownership can never be renounced: an ownerless registry could
    ///         never replace a broken endpoint again. Ownership moves only by
    ///         the two-step transfer.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ─── Internals ───────────────────────────────────────────────────────

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != guardian) revert NotOwnerOrGuardian(msg.sender);
        _;
    }

    /// @dev THE delay bound, applied by the constructor and every change.
    function _checkDelay(uint256 d) private pure {
        if (d < MIN_DELAY || d > MAX_DELAY) revert DelayOutOfRange(d, MIN_DELAY, MAX_DELAY);
    }

    /// @dev The one place a waiting time becomes a stored timestamp: computed
    ///      at full width and narrowed with a checked cast, never truncated.
    function _at(uint256 wait) private view returns (uint64) {
        return SafeCast.toUint64(block.timestamp + wait);
    }
}
