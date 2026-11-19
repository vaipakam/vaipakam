// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaultBeacon} from "../../src/VaultBeacon.sol";

/// @dev A registrable vault implementation: reports the layout id, nothing else.
contract BeaconInvImpl {
    function vaultLayoutId() external pure returns (bytes32) {
        return keccak256("vaipakam.vault.layout.v1");
    }
}

/// @dev The Diamond as the beacon sees it: a paused flag the handler flips.
contract BeaconInvDiamond {
    bool public paused;

    function setPaused(bool p) external {
        paused = p;
    }
}

/// @dev A vault as the beacon sees it: the owner it recorded at creation.
contract BeaconInvVault {
    address public immutable vaultOwner;

    constructor(address o) {
        vaultOwner = o;
    }
}

/**
 * @title  VaultBeaconHandler
 * @notice Drives every VaultBeacon entry as every role it can be called by
 *         (the Timelock owner, the guardian, the Diamond, the vault owner, a
 *         stranger with its own key), and records in ghost state what each
 *         role was able to change. The invariants in {VaultBeaconInvariantTest}
 *         read the ghosts (#3436).
 */
contract VaultBeaconHandler is Test {
    VaultBeacon public immutable beacon;
    BeaconInvDiamond public immutable diamond;
    address public immutable owner;
    address public immutable guardian;

    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant STRANGER_KEY = 0xBAD;

    address[] public vaults;

    // ─── Ghosts ──────────────────────────────────────────────────────────
    /// Set when currentVersionId changed to a version registered less than
    /// a code delay earlier (invariant 1).
    bool public ghostTooNewBecameCurrent;
    /// Set when a call by the Diamond or a stranger changed the current version (invariant 5).
    bool public ghostCurrentMovedByUnauthorised;
    /// Set when a pin or pin delay changed without a fresh owner signature (invariant 3).
    bool public ghostPinMovedWithoutOwner;
    /// Set when one signature was accepted twice (invariant 3).
    bool public ghostSignatureReused;
    /// Set when a revoked version became live again (invariant 6).
    bool public ghostUnrevoked;
    /// Set when the Diamond's no-signature raise left a delay above its cap (invariant 4/5).
    bool public ghostDiamondRaiseAboveCap;

    mapping(uint256 => bool) public everRevoked;
    mapping(uint256 => uint256) public registeredAt;
    mapping(bytes32 => bool) internal _usedSig;

    constructor(VaultBeacon b, BeaconInvDiamond d, address o, address g) {
        beacon = b;
        diamond = d;
        owner = o;
        guardian = g;
        registeredAt[1] = 0; // the constructor's version: the stated exception
        vaults.push(address(new BeaconInvVault(vm.addr(OWNER_KEY))));
        vaults.push(address(new BeaconInvVault(vm.addr(OWNER_KEY + 1))));
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _vault(uint256 seed) internal view returns (address) {
        return vaults[seed % vaults.length];
    }

    function _keyOf(address vault) internal view returns (uint256) {
        return vault == vaults[0] ? OWNER_KEY : OWNER_KEY + 1;
    }

    /// Mostly a registered id; one draw in eight is 0 or one past the last,
    /// so the refusals stay exercised too.
    function _id(uint256 seed) internal view returns (uint256) {
        uint256 n = beacon.versionCount();
        if (seed % 8 == 0) return (seed / 8) % 2 == 0 ? 0 : n + 1;
        return 1 + (seed / 8) % n;
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    struct Snap {
        uint256 current;
        uint256[2] pinned;
        uint256[2] delay;
        uint256[2] nonce;
    }

    function _snap() internal view returns (Snap memory s) {
        s.current = beacon.currentVersionId();
        for (uint256 i; i < 2; ++i) {
            s.pinned[i] = beacon.pinnedVersion(vaults[i]);
            s.delay[i] = beacon.pinDelay(vaults[i]);
            s.nonce[i] = beacon.nonces(vaults[i]);
        }
    }

    /// Checks after every step: current is seasoned, and nothing revoked is live.
    /// How often the current version actually moved, and pins actually
    /// changed: a campaign that never reaches these proves nothing.
    uint256 public currentMoves;
    uint256 public pinsApplied;
    uint256 public steps;

    function _after(Snap memory b, bool currentMayMove) internal {
        ++steps;
        uint256 cur = beacon.currentVersionId();
        for (uint256 i; i < 2; ++i) {
            if (beacon.pinnedVersion(vaults[i]) != b.pinned[i]) ++pinsApplied;
        }
        if (cur != b.current) {
            ++currentMoves;
            if (!currentMayMove) ghostCurrentMovedByUnauthorised = true;
            if (cur != 1 && block.timestamp < registeredAt[cur] + beacon.MIN_CODE_DELAY()) {
                ghostTooNewBecameCurrent = true;
            }
        }
        uint256 n = beacon.versionCount();
        for (uint256 id = 1; id <= n; ++id) {
            (, VaultBeacon.VersionStatus st) = beacon.versionOf(id);
            if (st == VaultBeacon.VersionStatus.Revoked) everRevoked[id] = true;
            else if (everRevoked[id]) ghostUnrevoked = true;
        }
    }

    // ─── Owner (Timelock) ────────────────────────────────────────────────

    function register() external {
        if (beacon.versionCount() >= 6) return;
        Snap memory b = _snap();
        address impl = address(new BeaconInvImpl());
        vm.prank(owner);
        uint256 id = beacon.registerVersion(impl);
        registeredAt[id] = block.timestamp;
        _after(b, false);
    }

    function proposeCurrent(uint256 seed) external {
        uint256 id = _id(seed);
        vm.prank(owner);
        try beacon.proposeCurrentVersion(id) {} catch {}
    }

    function proposeRevoke(uint256 seed, uint256 succSeed) external {
        (uint256 id, uint256 succ) = (_id(seed), _id(succSeed));
        vm.prank(owner);
        try beacon.proposeRevoke(id, succ) {} catch {}
    }

    function executeCurrent() external {
        Snap memory b = _snap();
        try beacon.executeCurrentVersion() {} catch {}
        _after(b, true);
    }

    function executeRevoke() external {
        Snap memory b = _snap();
        try beacon.executeRevoke() {} catch {}
        _after(b, true);
    }

    function cancelProposal(bool asGuardian) external {
        vm.prank(asGuardian ? guardian : owner);
        try beacon.cancelProposal() {} catch {}
    }

    // ─── Guardian ────────────────────────────────────────────────────────

    function guardianRevoke(uint256 seed, uint256 succSeed, bool pause) external {
        diamond.setPaused(pause);
        Snap memory b = _snap();
        (uint256 id, uint256 succ) = (_id(seed), _id(succSeed));
        vm.prank(guardian);
        try beacon.guardianRevokeVersion(id, succ) {} catch {}
        _after(b, true);
    }

    // ─── Diamond (no owner signature of its own) ─────────────────────────

    function diamondForgedPin(uint256 vSeed, uint256 idSeed, bytes calldata junk) external {
        address v = _vault(vSeed);
        uint256 id = _id(idSeed);
        Snap memory b = _snap();
        vm.prank(address(diamond));
        try beacon.requestPin(v, id, junk) {} catch {}
        vm.prank(address(diamond));
        try beacon.requestUnpin(v, junk) {} catch {}
        _checkNoPinMove(b);
        _after(b, false);
    }

    function diamondStrangerSignedPin(uint256 vSeed, uint256 idSeed) external {
        address v = _vault(vSeed);
        uint256 id = _id(idSeed);
        bytes memory sig = _sign(STRANGER_KEY, beacon.pinChangeDigest(v, id));
        Snap memory b = _snap();
        vm.prank(address(diamond));
        try beacon.requestPin(v, id, sig) {} catch {}
        _checkNoPinMove(b);
        _after(b, false);
    }

    function diamondRaise(uint256 vSeed, uint256 delay) external {
        address v = _vault(vSeed);
        Snap memory b = _snap();
        delay = bound(delay, 0, 40 days);
        vm.prank(address(diamond));
        try beacon.raisePinDelay(v, delay) {
            if (beacon.pinDelay(v) > beacon.MAX_DIAMOND_PIN_DELAY()) ghostDiamondRaiseAboveCap = true;
        } catch {}
        _after(b, false);
    }

    function diamondCancelOrVoid(uint256 vSeed, bool voidAll) external {
        address v = _vault(vSeed);
        Snap memory b = _snap();
        vm.prank(address(diamond));
        if (voidAll) {
            try beacon.voidPending(v) {} catch {}
        } else {
            try beacon.cancelPin(v, "") {} catch {}
        }
        _checkNoPinMove(b);
        _after(b, false);
    }

    // ─── The vault owner's signatures, submitted through the Diamond ─────

    function ownerPin(uint256 vSeed, uint256 idSeed, bool unpin) external {
        address v = _vault(vSeed);
        uint256 id = unpin ? 0 : _id(idSeed);
        bytes memory sig = _sign(_keyOf(v), beacon.pinChangeDigest(v, id));
        _submitPin(v, id, sig, unpin);
    }

    /// Replays the last pin signature the owner made for this vault.
    function replayPin(uint256 vSeed) external {
        address v = _vault(vSeed);
        bytes memory sig = _lastPinSig[v];
        if (sig.length == 0) return;
        _submitPin(v, _lastPinTarget[v], sig, _lastPinTarget[v] == 0);
    }

    mapping(address => bytes) internal _lastPinSig;
    mapping(address => uint256) internal _lastPinTarget;

    function _submitPin(address v, uint256 id, bytes memory sig, bool unpin) internal {
        uint256 nonceBefore = beacon.nonces(v);
        Snap memory b = _snap();
        vm.prank(address(diamond));
        bool ok;
        if (unpin) {
            try beacon.requestUnpin(v, sig) { ok = true; } catch {}
        } else {
            try beacon.requestPin(v, id, sig) { ok = true; } catch {}
        }
        if (ok) {
            bytes32 k = keccak256(sig);
            if (_usedSig[k]) ghostSignatureReused = true;
            _usedSig[k] = true;
            if (beacon.nonces(v) != nonceBefore + 1) ghostPinMovedWithoutOwner = true;
            _lastPinSig[v] = sig;
            _lastPinTarget[v] = id;
        } else {
            _checkNoPinMove(b);
        }
        _after(b, false);
    }

    function ownerSetDelay(uint256 vSeed, uint256 delay) external {
        address v = _vault(vSeed);
        delay = bound(delay, 0, 31 days);
        bytes memory sig = _sign(_keyOf(v), beacon.pinDelayDigest(v, delay));
        Snap memory b = _snap();
        try beacon.setPinDelay(v, delay, sig) {
            bytes32 k = keccak256(sig);
            if (_usedSig[k]) ghostSignatureReused = true;
            _usedSig[k] = true;
        } catch {}
        _after(b, false);
    }

    function strangerSetDelay(uint256 vSeed, uint256 delay) external {
        address v = _vault(vSeed);
        delay = bound(delay, 0, 31 days);
        bytes memory sig = _sign(STRANGER_KEY, beacon.pinDelayDigest(v, delay));
        Snap memory b = _snap();
        try beacon.setPinDelay(v, delay, sig) {} catch {}
        _checkNoPinMove(b);
        _after(b, false);
    }

    // ─── Anyone ──────────────────────────────────────────────────────────

    /// Executing a matured change applies what the owner signed earlier;
    /// it never moves the current version.
    function executePin(uint256 vSeed) external {
        Snap memory b = _snap();
        try beacon.executePin(_vault(vSeed)) {} catch {}
        _after(b, false);
    }

    function executePinDelay(uint256 vSeed) external {
        Snap memory b = _snap();
        try beacon.executePinDelay(_vault(vSeed)) {} catch {}
        _after(b, false);
    }

    function strangerCalls(uint256 seed) external {
        Snap memory b = _snap();
        address s = vm.addr(STRANGER_KEY);
        address impl = address(new BeaconInvImpl());
        (uint256 id, uint256 succ) = (_id(seed), _id(seed / 2));
        address v = _vault(seed);
        vm.startPrank(s);
        try beacon.registerVersion(impl) {} catch {}
        try beacon.proposeCurrentVersion(id) {} catch {}
        try beacon.guardianRevokeVersion(id, succ) {} catch {}
        try beacon.raisePinDelay(v, 1 days) {} catch {}
        try beacon.setGuardian(s) {} catch {}
        try beacon.renounceOwnership() {} catch {}
        try beacon.transferOwnership(s) {} catch {}
        vm.stopPrank();
        _checkNoPinMove(b);
        _after(b, false);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 10 days));
    }

    function _checkNoPinMove(Snap memory b) internal {
        for (uint256 i; i < 2; ++i) {
            if (
                beacon.pinnedVersion(vaults[i]) != b.pinned[i] || beacon.pinDelay(vaults[i]) != b.delay[i]
                    || beacon.nonces(vaults[i]) != b.nonce[i]
            ) ghostPinMovedWithoutOwner = true;
        }
    }
}

/**
 * @title  VaultBeaconInvariantTest
 * @notice The six VaultBeacon properties of #3436 as stateful invariants:
 *         every reachable sequence of calls, by every role, keeps them.
 *         A fuzzing campaign, not a proof; the design note
 *         `docs/DesignsAndPlans/VaultBeaconVerification.md` states the gap.
 */
contract VaultBeaconInvariantTest is Test {
    VaultBeacon internal beacon;
    VaultBeaconHandler internal handler;
    address internal constant OWNER = address(0x7111);
    address internal constant GUARDIAN = address(0x6A2D);

    function setUp() public {
        vm.warp(1_000_000);
        BeaconInvDiamond d = new BeaconInvDiamond();
        beacon = new VaultBeacon(OWNER, address(d), GUARDIAN, address(new BeaconInvImpl()));
        handler = new VaultBeaconHandler(beacon, d, OWNER, GUARDIAN);
        targetContract(address(handler));
    }

    /// 1. No version becomes current until a code delay after registration,
    ///    the guardian's emergency revoke included.
    function invariant_1_NoFreshCodeBecomesCurrent() public view {
        assertFalse(handler.ghostTooNewBecameCurrent(), "a version became current too soon");
    }

    /// 2. The current version is always live, and every vault resolves to
    ///    its pin while the pin is live, else to the current version.
    function invariant_2_ResolutionRule() public view {
        uint256 cur = beacon.currentVersionId();
        (, VaultBeacon.VersionStatus st) = beacon.versionOf(cur);
        assertEq(uint8(st), uint8(VaultBeacon.VersionStatus.Registered), "current is not live");
        for (uint256 i; i < 2; ++i) {
            address v = handler.vaults(i);
            uint256 p = beacon.pinnedVersion(v);
            (, VaultBeacon.VersionStatus ps) = beacon.versionOf(p);
            uint256 want = (p != 0 && ps == VaultBeacon.VersionStatus.Registered) ? p : cur;
            assertEq(beacon.resolvedVersionOf(v), want, "resolution rule");
        }
    }

    /// 3. Pins and pin delays move only on a valid owner signature, each used once.
    function invariant_3_OnlyTheOwnerSignatureMovesAPin() public view {
        assertFalse(handler.ghostPinMovedWithoutOwner(), "a pin moved without the owner");
        assertFalse(handler.ghostSignatureReused(), "a signature landed twice");
    }

    /// 4. A pin requested when a code change is proposed always executes first:
    ///    the Diamond's no-signature raise stays strictly below the code delay.
    function invariant_4_PinBeatsACodeChange() public view {
        assertLt(beacon.MAX_DIAMOND_PIN_DELAY(), beacon.MIN_CODE_DELAY(), "cap not below the code delay");
        assertFalse(handler.ghostDiamondRaiseAboveCap(), "the Diamond raised past its cap");
    }

    /// 5. The Diamond (and a stranger) never set a version.
    function invariant_5_DiamondNeverSetsAVersion() public view {
        assertFalse(handler.ghostCurrentMovedByUnauthorised(), "current moved by the Diamond or a stranger");
    }

    /// Coverage is reported, not asserted per run: a single run may
    /// legitimately never execute a proposal. The deterministic walk in
    /// {VaultBeaconHandlerReachTest} asserts the handler can reach each state.
    function afterInvariant() external {
        emit log_named_uint("steps", handler.steps());
        emit log_named_uint("current moves", handler.currentMoves());
        emit log_named_uint("pins applied", handler.pinsApplied());
    }

    /// 6. Revocation is final; ownership is never renounced or taken.
    function invariant_6_RevokeFinal_OwnerKept() public view {
        assertFalse(handler.ghostUnrevoked(), "a revoked version came back");
        assertEq(beacon.owner(), OWNER, "owner changed");
        assertEq(beacon.guardian(), GUARDIAN, "guardian changed");
    }
}


/// @notice The handler can reach every state the invariants are about: an
///         executed proposal, a guardian revoke on a seasoned successor, a
///         refused guardian revoke on a fresh one, and an applied pin. Guards
///         the campaign against a handler bug (a prank spent on a view call)
///         that would leave every privileged call refused and the invariants
///         vacuously green.
contract VaultBeaconHandlerReachTest is VaultBeaconInvariantTest {
    function test_handlerReachesEveryState() public {
        handler.ownerPin(0, 1, false); // pin vault 0 to version 1
        assertEq(handler.pinsApplied(), 1, "pin applied");

        handler.register(); // version 2
        handler.proposeCurrent(9); // (9 / 8) % 2 + 1 = 2
        handler.warp(7 days);
        handler.executeCurrent();
        assertEq(beacon.currentVersionId(), 2, "proposal executed");

        handler.register(); // version 3, fresh
        handler.guardianRevoke(9, 17, true); // revoke 2 onto 3: too new, refused
        assertEq(beacon.currentVersionId(), 2, "fresh successor refused");
        handler.warp(7 days);
        handler.guardianRevoke(9, 17, true);
        assertEq(beacon.currentVersionId(), 3, "seasoned successor accepted");
        assertEq(handler.currentMoves(), 2);

        assertFalse(handler.ghostTooNewBecameCurrent());
        assertFalse(handler.ghostCurrentMovedByUnauthorised());
    }
}
