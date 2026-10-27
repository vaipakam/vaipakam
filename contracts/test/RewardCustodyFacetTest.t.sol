// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardCustodyHolder} from "../src/RewardCustodyHolder.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRentableNFT721} from "./mocks/MockRentableNFT721.sol";
import {ERC1155Mock} from "./mocks/ERC1155Mock.sol";

/// @dev A minimal ERC-20 that skims a fee on every transfer. The ONLY use is
///      to make the replacement ceremony's delta check fail for the right
///      reason: the successor receives less than the old holder released,
///      so the ledger would describe a custody the successor does not hold.
///      VPFI itself never behaves this way; the check exists for the token
///      a misconfigured `setVPFIToken` might point at.
contract FeeSkimmingERC20 {
    string public constant name = "FeeSkim";
    string public constant symbol = "SKIM";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        // One wei is skimmed on every transfer.
        balanceOf[to] += amount - 1;
        return true;
    }
}

/// @dev A plain minimal ERC-20 — the "foreign" token someone sends to a holder.
contract PlainERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev A broken "token" that credits the recipient WITHOUT debiting the
///      sender — the successor grows by the release while the previous holder
///      keeps its balance. The replacement must refuse to flip the pointer.
contract CreditOnlyERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[to] += amount; // sender is never debited
        return true;
    }
}

/// @dev An impostor that answers `DIAMOND()` with the real Diamond — the
///      getter-spoofing contract the sweeps must never call `release` on.
contract ImpostorHolder {
    address public immutable DIAMOND;
    constructor(address d) { DIAMOND = d; }
    function release(address, address, uint256) external {}
}

/// @dev A "token" whose balanceOf reverts — a proxy upgraded into a broken
///      implementation. The snapshot must report the balance as unknown.
contract RevertingBalanceToken {
    function balanceOf(address) external pure returns (uint256) {
        revert("broken");
    }
}

/// @dev An ERC-1155 that credits the recipient WITHOUT debiting the sender.
///      The sweep must refuse rather than report a recovery that moved nothing.
contract CreditOnlyERC1155 {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;

    function mint(address to, uint256 id, uint256 amount) external {
        balanceOf[to][id] += amount;
    }

    function safeTransferFrom(address, address to, uint256 id, uint256 amount, bytes calldata) external {
        balanceOf[to][id] += amount;
    }
}

/// @dev A treasury whose receive path forces the value straight back into
///      the sender — the holder's net native debit is then zero although the
///      release "succeeded". The sweep must refuse (Codex #2158 r26 P2).
contract RefundingTreasury {
    receive() external payable {
        new Refunder{value: msg.value}(payable(msg.sender));
    }
}

contract Refunder {
    constructor(address payable target) payable {
        selfdestruct(target); // a same-transaction selfdestruct still transfers
    }
}

/// @dev An ERC-721 whose safe transfer returns without moving ownership — a
///      proxy upgraded into a broken implementation. The sweep must refuse.
contract NoopERC721 {
    mapping(uint256 => address) public ownerOf;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function safeTransferFrom(address, address, uint256) external {}
}

/**
 * @title RewardCustodyFacetTest — #1566 slice 4 PR A
 * @notice The holder's Diamond gate, the one-shot Diamond-constructed
 *         binding, the paused replacement ceremony (successor constructed
 *         in the same transaction, whole balance moves, pointer flips,
 *         growth verified, dust reported not refused), and the read
 *         surface that says what it does not know. (The paid-side rebase
 *         this suite also covered was retired in #2910: a fresh deploy has
 *         no paid history to import.)
 */
contract RewardCustodyFacetTest is SetupTest {
    // Mirrors of the facet's / holder's events, for `vm.expectEmit`.
    event RewardCustodyHolderBound(address indexed holder);
    event RewardCustodyHolderReplaced(
        address indexed previous,
        address indexed successor,
        address indexed token,
        uint256 balanceMoved,
        uint256 successorPreBalance
    );
    event RewardCustodyReleased(
        address indexed token,
        address indexed to,
        uint256 amount
    );
    event RewardCustodyForeignTokenSwept(
        address indexed holder,
        address indexed token,
        address indexed treasury,
        uint256 requested,
        uint256 received
    );
    event RewardCustodyNativeSwept(
        address indexed holder,
        address indexed treasury,
        uint256 requested,
        uint256 received
    );
    event RewardCustodyPredecessorVpfiRecovered(
        address indexed predecessor,
        address indexed bound,
        uint256 amount
    );
    event RewardCustodyERC721Swept(
        address indexed holder,
        address indexed token,
        address indexed treasury,
        uint256 tokenId
    );
    event RewardCustodyERC1155Swept(
        address indexed holder,
        address indexed token,
        address indexed treasury,
        uint256 id,
        uint256 requested,
        uint256 received
    );
    event RewardCustodyUnattributedVpfiSwept(
        address indexed holder,
        address indexed treasury,
        uint256 amount,
        uint256 unattributedBefore
    );

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;

    VPFIToken internal vpfi;
    address internal nonAdmin;

    function setUp() public {
        setupHelper();

        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIToken.initialize,
                (address(this), address(this), address(this))
            )
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));

        nonAdmin = makeAddr("nonAdmin");
    }

    // ─── Accessors ──────────────────────────────────────────────────────────

    function _custody() internal view returns (RewardCustodyFacet) {
        return RewardCustodyFacet(address(diamond));
    }

    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }

    function _lens() internal view returns (RewardRemittanceLensFacet) {
        return RewardRemittanceLensFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _pause() internal {
        AdminFacet(address(diamond)).pause();
    }

    /// @dev The address the Diamond's NEXT `new` will land on — what an
    ///      attacker can compute and dust ahead of a replacement.
    function _nextHolderAddress() internal view returns (address) {
        return vm.computeCreateAddress(address(diamond), vm.getNonce(address(diamond)));
    }

    function _bind() internal returns (address holder) {
        holder = _custody().bindRewardCustodyHolder();
    }

    function _expectNotAdmin(address who) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                LibAccessControl.AccessControlUnauthorizedAccount.selector,
                who,
                LibAccessControl.ADMIN_ROLE
            )
        );
    }

    function _becomeCanonical() internal {
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
    }

    function _becomeMirror() internal {
        vm.chainId(CHAIN_ARB);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(false);
    }

    /// @dev A chain that WAS a mirror and was detached: `rewardRoleConfigured`
    ///      is set, `baseChainId` is zero.
    function _becomeDetached() internal {
        _becomeMirror();
        _rep().setBaseChainId(0);
        assertEq(uint8(_rep().getRewardRole()), uint8(LibVaipakam.RewardRole.Detached));
    }

    // ─── 1. The holder itself ───────────────────────────────────────────────

    function test_Holder_ConstructorRefusesZeroDiamond() public {
        vm.expectRevert(RewardCustodyHolder.RewardCustodyHolderZeroAddress.selector);
        new RewardCustodyHolder(address(0));
    }

    function test_Holder_ReleaseIsDiamondGated() public {
        RewardCustodyHolder holder = RewardCustodyHolder(_bind());
        vpfi.mint(address(holder), 10 ether);
        vm.prank(nonAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardCustodyHolder.RewardCustodyHolderOnlyDiamond.selector,
                nonAdmin
            )
        );
        holder.release(address(vpfi), nonAdmin, 1 ether);
        assertEq(vpfi.balanceOf(address(holder)), 10 ether, "nothing moved");
    }

    function test_Holder_ReleaseRefusesZeroRecipient() public {
        RewardCustodyHolder holder = RewardCustodyHolder(_bind());
        vpfi.mint(address(holder), 10 ether);
        vm.prank(address(diamond));
        vm.expectRevert(RewardCustodyHolder.RewardCustodyHolderZeroAddress.selector);
        holder.release(address(vpfi), address(0), 1 ether);
    }

    function test_Holder_ReleaseByDiamondMovesAndEmits() public {
        RewardCustodyHolder holder = RewardCustodyHolder(_bind());
        vpfi.mint(address(holder), 10 ether);
        address to = makeAddr("recipient");
        vm.expectEmit(true, true, false, true, address(holder));
        emit RewardCustodyReleased(address(vpfi), to, 3 ether);
        vm.prank(address(diamond));
        holder.release(address(vpfi), to, 3 ether);
        assertEq(vpfi.balanceOf(to), 3 ether, "recipient got the release");
        assertEq(vpfi.balanceOf(address(holder)), 7 ether, "holder debited");
    }

    // ─── 2. Binding ─────────────────────────────────────────────────────────

    function test_Bind_IsAdminOnly() public {
        vm.prank(nonAdmin);
        _expectNotAdmin(nonAdmin);
        _custody().bindRewardCustodyHolder();
    }

    function test_Bind_ConstructsAHolderOwnedByThisDiamondAndEmits() public {
        assertEq(_custody().rewardCustodyHolder(), address(0), "unbound at start");
        address predicted = _nextHolderAddress();
        vm.expectEmit(true, false, false, true, address(diamond));
        emit RewardCustodyHolderBound(predicted);
        address holder = _bind();

        assertEq(holder, predicted, "the Diamond constructed it");
        assertEq(_custody().rewardCustodyHolder(), holder, "bound");
        assertGt(holder.code.length, 0, "has code");
        assertEq(RewardCustodyHolder(holder).DIAMOND(), address(diamond), "answers to this Diamond");
        // Byte-identical to a reference holder built for the same Diamond:
        // authenticity is by construction, not by a getter.
        RewardCustodyHolder canonical = new RewardCustodyHolder(address(diamond));
        assertEq(keccak256(holder.code), keccak256(address(canonical).code), "canonical implementation");
    }

    function test_Bind_IsOneShot() public {
        address holder = _bind();
        vm.expectRevert(IVaipakamErrors.RewardCustodyHolderAlreadyBound.selector);
        _custody().bindRewardCustodyHolder();
        assertEq(_custody().rewardCustodyHolder(), holder, "first binding stands");
    }

    // ─── 3. Replacement ceremony ────────────────────────────────────────────

    function test_Replace_RequiresPause() public {
        _bind();
        vm.expectRevert(LibPausable.ExpectedManualPause.selector);
        _custody().replaceRewardCustodyHolder();
    }

    function test_Replace_IsAdminOnly() public {
        _bind();
        _pause();
        vm.prank(nonAdmin);
        _expectNotAdmin(nonAdmin);
        _custody().replaceRewardCustodyHolder();
    }

    function test_Replace_RefusesWhileUnbound() public {
        _pause();
        vm.expectRevert(IVaipakamErrors.RewardCustodyHolderNotBound.selector);
        _custody().replaceRewardCustodyHolder();
    }

    function test_Replace_RefusesWithoutAVpfiToken() public {
        _bind();
        _mut().setVpfiTokenRaw(address(0));
        _pause();
        vm.expectRevert(IVaipakamErrors.RewardCustodyTokenUnset.selector);
        _custody().replaceRewardCustodyHolder();
    }

    function test_Replace_ConstructsSuccessorMovesWholeBalanceAndFlipsPointer() public {
        address holder = _bind();
        vpfi.mint(holder, 1_000 ether);
        _pause();
        address predicted = _nextHolderAddress();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit RewardCustodyHolderReplaced(holder, predicted, address(vpfi), 1_000 ether, 0);
        address successor = _custody().replaceRewardCustodyHolder();

        assertEq(successor, predicted, "constructed in the ceremony");
        assertEq(RewardCustodyHolder(successor).DIAMOND(), address(diamond));
        assertEq(_custody().rewardCustodyHolder(), successor, "pointer flipped");
        assertEq(vpfi.balanceOf(holder), 0, "old holder emptied");
        assertEq(vpfi.balanceOf(successor), 1_000 ether, "successor holds it all");

        (address h,, bool known, uint256 held,) = _custody().rewardCustodySnapshot();
        assertEq(h, successor);
        assertTrue(known);
        assertEq(held, 1_000 ether);
    }

    function test_Replace_WithAnEmptyHolderMovesNothing() public {
        address holder = _bind();
        _pause();
        address predicted = _nextHolderAddress();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit RewardCustodyHolderReplaced(holder, predicted, address(vpfi), 0, 0);
        address successor = _custody().replaceRewardCustodyHolder();
        assertEq(_custody().rewardCustodyHolder(), successor);
    }

    /// @dev Codex #2158 r3 P1 — the successor address is predictable, so a
    ///      one-wei dusting ahead of the ceremony must NOT block it. The
    ///      dust is reported in the event and shows as the unattributed
    ///      remainder; the move itself is still verified as growth.
    function test_Replace_DustAtThePredictedSuccessorIsReportedNotRefused() public {
        address holder = _bind();
        vpfi.mint(holder, 1_000 ether);
        address predicted = _nextHolderAddress();
        vpfi.mint(predicted, 5); // the attacker's dust, before construction
        _pause();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit RewardCustodyHolderReplaced(holder, predicted, address(vpfi), 1_000 ether, 5);
        address successor = _custody().replaceRewardCustodyHolder();

        assertEq(successor, predicted);
        assertEq(vpfi.balanceOf(successor), 1_000 ether + 5, "dust rides along, unattributed");
        (,, bool known, uint256 held, uint256 attributed) = _custody().rewardCustodySnapshot();
        assertTrue(known);
        assertEq(held - attributed, 1_000 ether + 5, "PR A: no writer, so all of it is the unattributed remainder");
    }

    function test_Replace_RefusesWhenTheSuccessorCannotAccountForTheMove() public {
        // A token that skims on transfer: the successor GROWS by one wei
        // less than the old holder released. The ceremony must revert
        // rather than flip the pointer onto a custody the ledger would
        // overstate.
        FeeSkimmingERC20 skim = new FeeSkimmingERC20();
        _mut().setVpfiTokenRaw(address(skim));
        address holder = _bind();
        skim.mint(holder, 100);
        _pause();

        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardCustodyMoveUnverified.selector,
                100,
                99
            )
        );
        _custody().replaceRewardCustodyHolder();
        assertEq(_custody().rewardCustodyHolder(), holder, "pointer untouched");
        assertEq(skim.balanceOf(holder), 100, "revert undid the move");
    }

    /// @dev Codex #2158 r12 P2 — both ends of the move are measured: a token
    ///      that credits the successor without debiting the previous holder
    ///      passes the growth check but leaves VPFI stranded at an address
    ///      nothing can reach, so the ceremony refuses.
    function test_Replace_RefusesWhenThePreviousHolderIsNotEmptied() public {
        CreditOnlyERC20 broken = new CreditOnlyERC20();
        _mut().setVpfiTokenRaw(address(broken));
        address holder = _bind();
        broken.mint(holder, 100);
        _pause();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardCustodySourceNotDebited.selector, holder, 100, 0
            )
        );
        _custody().replaceRewardCustodyHolder();
        assertEq(_custody().rewardCustodyHolder(), holder, "pointer untouched");
    }

    // ─── 4. The manual-pause ceremonies ─────────────────────────────────────

    /// @dev Codex #2158 r18 P2 — an auto-pause window does not qualify: it
    ///      lapses on its own, so a ceremony run under it alone would be
    ///      followed by service resuming by no one's decision. Only the manual
    ///      pause lets the replacement through.
    function test_CeremoniesRequireTheManualPauseNotAnAutoPause() public {
        _bind();
        _becomeCanonical();
        address watcher = makeAddr("watcher");
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.WATCHER_ROLE, watcher);
        vm.prank(watcher);
        AdminFacet(address(diamond)).autoPause("anomaly");
        assertTrue(AdminFacet(address(diamond)).paused(), "auto-paused");
        vm.expectRevert(LibPausable.ExpectedManualPause.selector);
        _custody().replaceRewardCustodyHolder();
        _pause(); // the manual pause
        _custody().replaceRewardCustodyHolder();
    }

    /// @dev Codex #2158 r26 — the deploy tooling reads the pause library's one
    ///      slot raw (before a refresh routes any newer getter); pin the
    ///      decoder to the live functions across every state, including the
    ///      manual pause that coexists with an auto-pause window, which
    ///      `pausedUntil() == 0` would misread.
    function test_PausableSlotDecoderMatchesTheLiveFunctions() public {
        AdminFacet admin = AdminFacet(address(diamond));
        address watcher = makeAddr("watcher");
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.WATCHER_ROLE, watcher);

        // The setup Diamond was paused at construction and unpaused by the
        // helper, so a boundary is already stamped; only its later moves are
        // asserted against block time.
        (bool manual, uint64 until, uint64 boundary) = _decodeLive();
        assertFalse(manual); assertEq(until, 0);
        uint64 setupBoundary = boundary;
        uint64 t0 = _epoch();

        vm.warp(block.timestamp + 100);
        vm.prank(watcher);
        admin.autoPause("anomaly");
        (manual, until, boundary) = _decodeLive();
        assertFalse(manual, "auto-pause is not the manual flag");
        assertEq(until, admin.pausedUntil()); assertEq(boundary, block.timestamp);
        assertGt(boundary, setupBoundary, "the boundary moved with the auto-pause");
        assertEq(_epoch(), t0 + 1, "one transition");

        admin.pause(); // manual pause BESIDE the still-active window, SAME timestamp
        (manual, until, boundary) = _decodeLive();
        assertTrue(manual, "manual flag read directly");
        assertGt(until, 0, "the window is left intact by pause()");
        assertEq(boundary, block.timestamp, "same-second boundary: a timestamp cannot tell the two apart");
        assertEq(_epoch(), t0 + 2, "the transition count can");

        admin.unpause();
        (manual, until,) = _decodeLive();
        assertFalse(manual); assertEq(until, 0);
        assertEq(_epoch(), t0 + 3);
        admin.unpause(); // a no-op unpause is not a transition
        assertEq(_epoch(), t0 + 3);
    }

    function _decodeLive() internal view returns (bool manual, uint64 until, uint64 boundary) {
        (manual, until, boundary,) =
            LibPausable.decodePausableSlot(vm.load(address(diamond), LibPausable.PAUSABLE_STORAGE_POSITION));
    }

    /// @dev The live pause epoch — the transition count — as the tooling
    ///      reads it: from the pause library's slot.
    function _epoch() internal view returns (uint64 transitions) {
        (,,, transitions) =
            LibPausable.decodePausableSlot(vm.load(address(diamond), LibPausable.PAUSABLE_STORAGE_POSITION));
    }

    /// @dev Codex #2158 post-cap P2 (reversing the r29 pin) — a Diamond that
    ///      is its own treasury has no NFT withdrawal path, so both NFT
    ///      sweeps refuse that destination and the tokens stay at the
    ///      holder, releasable to an external treasury; the Diamond itself
    ///      stays closed to every inbound NFT.
    function test_Sweep_RefusesNftsIntoADiamondTreasury() public {
        address holder = _bind();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        address alice = makeAddr("alice");

        MockRentableNFT721 nft = new MockRentableNFT721();
        nft.mint(alice, 1);
        vm.prank(alice);
        nft.transferFrom(alice, holder, 1);
        vm.expectRevert(IVaipakamErrors.RewardCustodyNftToDiamondTreasury.selector);
        _custody().sweepERC721FromRewardCustody(holder, address(nft), 1);
        assertEq(nft.ownerOf(1), holder, "stays at the holder");

        ERC1155Mock units = new ERC1155Mock();
        address predicted = _nextHolderAddress();
        units.mint(predicted, 7, 3);
        _pause();
        address successor = _custody().replaceRewardCustodyHolder();
        assertEq(successor, predicted);
        vm.expectRevert(IVaipakamErrors.RewardCustodyNftToDiamondTreasury.selector);
        _custody().sweepERC1155FromRewardCustody(successor, address(units), 7, 3);
        assertEq(units.balanceOf(successor, 7), 3, "stays at the holder");

        // The Diamond is closed to inbound NFTs.
        nft.mint(alice, 2);
        vm.prank(alice);
        vm.expectRevert();
        nft.safeTransferFrom(alice, address(diamond), 2);
    }

    /// @dev Codex #2158 post-cap P1 — a watcher firing while the MANUAL pause
    ///      is in force is recorded (window, transition, event) rather than
    ///      swallowed, so the conditional unpause refuses over it; an active
    ///      window is still never extended.
    function test_AutoPauseWhileManuallyPausedIsRecorded() public {
        AdminFacet admin = AdminFacet(address(diamond));
        address watcher = makeAddr("watcher");
        AccessControlFacet(address(diamond)).grantRole(LibAccessControl.WATCHER_ROLE, watcher);
        admin.pause();
        uint64 afterOurPause = _epoch();

        vm.prank(watcher);
        admin.autoPause("incident during a refresh");
        assertEq(_epoch(), afterOurPause + 1, "the incident is a transition");
        assertGt(admin.pausedUntil(), 0, "the window is recorded");
        uint256 window = admin.pausedUntil();
        vm.prank(watcher);
        admin.autoPause("again");
        assertEq(_epoch(), afterOurPause + 1, "an active window is never extended");
        assertEq(admin.pausedUntil(), window);

        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.PauseEpochMoved.selector, afterOurPause, afterOurPause + 1));
        admin.unpauseIfPauseEpoch(afterOurPause);
        assertTrue(admin.paused(), "still paused: the incident stands");
        admin.unpause(); // a person's decision clears both
        assertFalse(admin.paused());
        assertEq(admin.pausedUntil(), 0);
    }

    /// @dev Codex #2158 post-cap P1 — the conditional unpause refuses ON CHAIN
    ///      when the pause epoch moved, so a scripted restore of service can
    ///      never clear a pause someone else raised in between.
    function test_UnpauseIfPauseEpoch_RefusesAMovedEpoch() public {
        AdminFacet admin = AdminFacet(address(diamond));
        admin.pause();
        uint64 expected = _epoch();
        admin.unpause();
        admin.pause(); // someone else lifted and re-raised the pause
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.PauseEpochMoved.selector, expected, _epoch()));
        admin.unpauseIfPauseEpoch(expected);
        assertTrue(admin.paused(), "still paused");
        admin.unpauseIfPauseEpoch(_epoch());
        assertFalse(admin.paused());
    }

    /// @dev Codex #2158 post-cap P2 — an ERC-20 recovered to a Diamond that is
    ///      its own treasury is credited to the tracked treasury balance the
    ///      claim path releases, both for a foreign token and for the bound
    ///      holder's unattributed VPFI; nothing lands uncredited in the raw
    ///      balance.
    function test_Sweep_CreditsADiamondTreasurysTrackedBalance() public {
        address holder = _bind();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        TreasuryFacet tf = TreasuryFacet(address(diamond));

        PlainERC20 foreign = new PlainERC20();
        foreign.mint(holder, 70);
        _custody().sweepForeignTokenFromRewardCustody(holder, address(foreign), 70);
        assertEq(tf.getTreasuryBalance(address(foreign)), 70, "foreign receipt credited to the tracked balance");

        vpfi.mint(holder, 40 ether); // unsolicited, no row describes it
        _pause();
        _custody().sweepUnattributedVpfiFromRewardCustody(40 ether);
        assertEq(tf.getTreasuryBalance(address(vpfi)), 40 ether, "unattributed VPFI credited to the tracked balance");
    }

    /// @dev Codex #2158 post-cap P2 — native currency has no claim path on a
    ///      Diamond that is its own treasury, so the native sweep refuses that
    ///      destination instead of stranding the value in the raw balance.
    function test_SweepNative_RefusesADiamondTreasury() public {
        address holder = _bind();
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        vm.deal(holder, 1 ether);
        vm.expectRevert(IVaipakamErrors.RewardCustodyNativeToDiamondTreasury.selector);
        _custody().sweepNativeFromRewardCustody(holder, 1 ether);
        assertEq(holder.balance, 1 ether, "stays at the holder, which can still release it to an external treasury");
    }

    /// @dev Codex #2158 post-cap P2 — the ERC-721 sweep refuses a token the
    ///      named holder does not own, so a token already sitting with the
    ///      treasury can never be reported as recovered from a holder.
    function test_Sweep_RefusesAnERC721TheHolderDoesNotOwn() public {
        address holder = _bind();
        address treasury = _treasury();
        MockRentableNFT721 nft = new MockRentableNFT721();
        nft.mint(treasury, 5);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RewardCustodyErc721NotAtHolder.selector, address(nft), 5, treasury)
        );
        _custody().sweepERC721FromRewardCustody(holder, address(nft), 5);
    }

    /// @dev Codex #2158 r5 P1, slice 4 PR C-1 — a chain detached carrying a
    ///      stale received side (`received > 0, paid == 0`) and then promoted
    ///      DIRECTLY to Canonical exposes none of it as headroom: the promotion
    ///      is an effective role change, so it retires the live era and levels
    ///      paid up to the stale received side before anything else. (Until
    ///      #2910 this was pinned beside the retired paid-side rebase; the
    ///      levelling is the role change's own, so it stands without it.)
    function test_RoleChange_FromDetachedLevelsAStaleReceivedSide() public {
        _becomeDetached();
        _mut().setArmedFreshLedgerRaw(800 ether, 0);
        vm.chainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        assertEq(uint8(_rep().getRewardRole()), uint8(LibVaipakam.RewardRole.Canonical));
        (uint256 received, uint256 paid) = _custody().armedFreshLedger();
        assertEq(received, 800 ether, "the stale received side is kept as history");
        assertEq(paid, 800 ether, "the era retirement levelled paid to it: no stale headroom");
    }

    // ─── 4b. Foreign-token sweep ────────────────────────────────────────────

    function _treasury() internal returns (address t) {
        t = makeAddr("treasury");
        AdminFacet(address(diamond)).setTreasury(t);
    }

    function test_Sweep_IsAdminOnly() public {
        address holder = _bind();
        vm.prank(nonAdmin);
        _expectNotAdmin(nonAdmin);
        _custody().sweepForeignTokenFromRewardCustody(holder, address(1), 1);
    }

    function test_Sweep_RefusesTheConfiguredVpfi() public {
        address holder = _bind();
        _treasury();
        vpfi.mint(holder, 5 ether);
        vm.expectRevert(IVaipakamErrors.RewardCustodySweepIsVpfi.selector);
        _custody().sweepForeignTokenFromRewardCustody(holder, address(vpfi), 1 ether);
        assertEq(vpfi.balanceOf(holder), 5 ether, "custody untouched");
    }

    /// @dev Codex #2158 r13 P2 — the sweeps consult the registry of holders
    ///      this Diamond CONSTRUCTED, never a getter: a holder built for
    ///      another Diamond, an EOA, a genuine holder built by someone else
    ///      for THIS Diamond, and an impostor answering `DIAMOND() == this`
    ///      are all refused.
    function test_Sweep_RefusesAnythingThisDiamondDidNotConstruct() public {
        address holder = _bind();
        _treasury();
        PlainERC20 foreign = new PlainERC20();
        address[4] memory outsiders = [
            address(new RewardCustodyHolder(makeAddr("otherDiamond"))),
            nonAdmin,
            address(new RewardCustodyHolder(address(diamond))),
            address(new ImpostorHolder(address(diamond)))
        ];
        for (uint256 i; i < outsiders.length; ++i) {
            assertFalse(_custody().rewardCustodyHolderConstructed(outsiders[i]));
            vm.expectRevert(
                abi.encodeWithSelector(IVaipakamErrors.RewardCustodyHolderNotConstructedHere.selector, outsiders[i])
            );
            _custody().sweepForeignTokenFromRewardCustody(outsiders[i], address(foreign), 1);
            vm.expectRevert(
                abi.encodeWithSelector(IVaipakamErrors.RewardCustodyHolderNotConstructedHere.selector, outsiders[i])
            );
            _custody().sweepNativeFromRewardCustody(outsiders[i], 1);
        }
        assertTrue(_custody().rewardCustodyHolderConstructed(holder), "the bound holder is registered");
    }

    /// @dev Codex #2158 r13 P2 — native currency forced into a holder (no
    ///      receive) is reported and recoverable to the treasury, from the
    ///      bound holder and from a predecessor.
    function test_SweepNative_RecoversForcedNativeFromBoundAndPreviousHolders() public {
        address holder = _bind();
        address treasury = _treasury();
        vm.deal(holder, 1 ether); // forced in (SELFDESTRUCT / coinbase / pre-construction)
        assertEq(_custody().rewardCustodyNativeHeld(holder), 1 ether, "reported, never silent");

        _pause();
        address successor = _custody().replaceRewardCustodyHolder();
        assertEq(holder.balance, 1 ether, "replacement moves only the configured VPFI; native stays behind");
        assertTrue(_custody().rewardCustodyHolderConstructed(holder), "a predecessor stays registered");

        vm.expectEmit(true, true, false, true, address(diamond));
        emit RewardCustodyNativeSwept(holder, treasury, 1 ether, 1 ether);
        _custody().sweepNativeFromRewardCustody(holder, 1 ether);
        assertEq(treasury.balance, 1 ether, "recovered to the treasury");
        assertEq(holder.balance, 0);

        vm.deal(successor, 0.5 ether);
        _custody().sweepNativeFromRewardCustody(successor, 0.5 ether);
        assertEq(treasury.balance, 1.5 ether, "also from the bound holder");
    }

    /// @dev Codex #2158 r14 P2 — configured VPFI sent to a RETIRED predecessor
    ///      after its replacement is brought back into the bound holder as
    ///      unattributed remainder; the bound holder itself and outsiders are
    ///      refused, and the foreign-token sweep still refuses VPFI.
    function test_RecoverVpfi_FromAPredecessorIntoTheBoundHolder() public {
        address holder = _bind();
        vpfi.mint(holder, 1_000 ether);
        _pause();
        address successor = _custody().replaceRewardCustodyHolder();
        assertEq(vpfi.balanceOf(holder), 0, "predecessor proven empty at retirement");

        vpfi.mint(holder, 7 ether); // unsolicited VPFI at the retired predecessor
        vm.expectEmit(true, true, false, true, address(diamond));
        emit RewardCustodyPredecessorVpfiRecovered(holder, successor, 7 ether);
        _custody().recoverVpfiFromPredecessor(holder, 7 ether);
        assertEq(vpfi.balanceOf(holder), 0);
        assertEq(vpfi.balanceOf(successor), 1_007 ether, "back in custody");
        (,, bool known, uint256 held, uint256 attributed) = _custody().rewardCustodySnapshot();
        assertTrue(known); assertEq(held - attributed, 1_007 ether, "visible as the unattributed remainder");

        // The bound holder is not a predecessor; outsiders are not ours.
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.RewardCustodyRecoverTargetsBoundHolder.selector, successor));
        _custody().recoverVpfiFromPredecessor(successor, 1);
        vm.expectRevert(abi.encodeWithSelector(IVaipakamErrors.RewardCustodyHolderNotConstructedHere.selector, nonAdmin));
        _custody().recoverVpfiFromPredecessor(nonAdmin, 1);
    }

    function test_RecoverVpfi_IsAdminOnly() public {
        address holder = _bind();
        vm.prank(nonAdmin);
        _expectNotAdmin(nonAdmin);
        _custody().recoverVpfiFromPredecessor(holder, 1);
    }

    /// @dev Codex #2158 r15 P2 — the recovery measures BOTH ends, through the
    ///      same measured move the replacement uses. A token rotated in after
    ///      the replacement that credits the bound holder without debiting the
    ///      predecessor would otherwise report a recovery that moved nothing
    ///      and could be repeated forever; one that skims a fee cannot account
    ///      for the amount at the destination. Both refuse and every balance
    ///      is left as it was.
    function test_RecoverVpfi_RefusesAMoveEitherEndCannotAccountFor() public {
        address holder = _bind();
        _pause();
        address successor = _custody().replaceRewardCustodyHolder();

        // Credits without debiting: the predecessor keeps what it "released".
        CreditOnlyERC20 creditOnly = new CreditOnlyERC20();
        _mut().setVpfiTokenRaw(address(creditOnly));
        creditOnly.mint(holder, 100);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardCustodySourceNotDebited.selector, holder, 100, 0
            )
        );
        _custody().recoverVpfiFromPredecessor(holder, 100);
        assertEq(creditOnly.balanceOf(holder), 100, "predecessor untouched");
        assertEq(creditOnly.balanceOf(successor), 0, "bound holder untouched");

        // Skims a fee: the bound holder grows by less than was released.
        FeeSkimmingERC20 skim = new FeeSkimmingERC20();
        _mut().setVpfiTokenRaw(address(skim));
        skim.mint(holder, 100);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardCustodyMoveUnverified.selector, 100, 99
            )
        );
        _custody().recoverVpfiFromPredecessor(holder, 100);
        assertEq(skim.balanceOf(holder), 100, "revert undid the move");
        assertEq(skim.balanceOf(successor), 0, "bound holder untouched");
    }

    /// @dev Codex #2158 r16 P2 — an NFT can reach a holder: a non-safe
    ///      ERC-721 `transferFrom` (a holder has no receiver hook, so a SAFE
    ///      transfer is refused by the token itself), or delivery to the
    ///      predicted address before construction. Nothing else could ever
    ///      move it, so the Diamond recovers it to the treasury — from the
    ///      bound holder and from a predecessor, only through the registry.
    function test_Sweep_RecoversAnERC721ThatReachedAHolder() public {
        address holder = _bind();
        address treasury = _treasury();
        address alice = makeAddr("alice");
        MockRentableNFT721 nft = new MockRentableNFT721();
        nft.mint(alice, 1);
        nft.mint(alice, 2);

        // A safe transfer into a constructed holder is refused by the token.
        vm.prank(alice);
        vm.expectRevert();
        nft.safeTransferFrom(alice, holder, 2);
        // A non-safe one lands.
        vm.prank(alice);
        nft.transferFrom(alice, holder, 1);
        assertEq(nft.ownerOf(1), holder);

        vm.expectEmit(true, true, true, true, address(diamond));
        emit RewardCustodyERC721Swept(holder, address(nft), treasury, 1);
        _custody().sweepERC721FromRewardCustody(holder, address(nft), 1);
        assertEq(nft.ownerOf(1), treasury, "recovered to the treasury");

        // From a retired predecessor too, and only from the registry.
        _pause();
        _custody().replaceRewardCustodyHolder();
        vm.prank(alice);
        nft.transferFrom(alice, holder, 2);
        _custody().sweepERC721FromRewardCustody(holder, address(nft), 2);
        assertEq(nft.ownerOf(2), treasury, "also from a retired predecessor");
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RewardCustodyHolderNotConstructedHere.selector, alice)
        );
        _custody().sweepERC721FromRewardCustody(alice, address(nft), 2);
        vm.prank(nonAdmin);
        _expectNotAdmin(nonAdmin);
        _custody().sweepERC721FromRewardCustody(holder, address(nft), 2);
    }

    /// @dev Codex #2158 r16 P2 — an ERC-1155 has only safe transfers, so
    ///      units can reach a holder only at its PREDICTED address before
    ///      construction; the Diamond recovers them to the treasury with the
    ///      measured receipt reported.
    function test_Sweep_RecoversERC1155DeliveredBeforeConstruction() public {
        address treasury = _treasury();
        address alice = makeAddr("alice");
        ERC1155Mock units = new ERC1155Mock();
        address predicted = _nextHolderAddress();
        units.mint(predicted, 7, 3); // no code there yet, so the mint lands
        address holder = _bind();
        assertEq(holder, predicted);
        assertEq(units.balanceOf(holder, 7), 3, "delivered ahead of construction");

        // Once constructed, the holder refuses a safe transfer.
        units.mint(alice, 7, 1);
        vm.prank(alice);
        vm.expectRevert();
        units.safeTransferFrom(alice, holder, 7, 1, "");

        vm.expectEmit(true, true, true, true, address(diamond));
        emit RewardCustodyERC1155Swept(holder, address(units), treasury, 7, 3, 3);
        _custody().sweepERC1155FromRewardCustody(holder, address(units), 7, 3);
        assertEq(units.balanceOf(treasury, 7), 3, "recovered to the treasury");
        assertEq(units.balanceOf(holder, 7), 0);
        vm.prank(nonAdmin);
        _expectNotAdmin(nonAdmin);
        _custody().sweepERC1155FromRewardCustody(holder, address(units), 7, 1);
    }

    /// @dev Codex #2158 r17 P2 — the sweep reads ownership back: a token
    ///      whose transfer returns without moving anything is refused, so no
    ///      "recovered" event can stand over an NFT still in the holder.
    function test_Sweep_RefusesAnERC721ThatDidNotMove() public {
        address holder = _bind();
        _treasury();
        NoopERC721 broken = new NoopERC721();
        broken.mint(holder, 9);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardCustodyErc721NotDelivered.selector, address(broken), 9, holder
            )
        );
        _custody().sweepERC721FromRewardCustody(holder, address(broken), 9);
        assertEq(broken.ownerOf(9), holder, "nothing moved, nothing reported");
    }

    /// @dev Codex #2158 r22 P2 — every release from a holder verifies the
    ///      holder's debit, foreign assets included: a token that credits the
    ///      treasury without debiting the holder is refused, so no sweep can
    ///      be reported over units that never left.
    function test_Sweep_RefusesForeignAssetsThatDoNotDebitTheHolder() public {
        address holder = _bind();
        _treasury();

        CreditOnlyERC20 erc20 = new CreditOnlyERC20();
        erc20.mint(holder, 50);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RewardCustodySourceNotDebited.selector, holder, 50, 0)
        );
        _custody().sweepForeignTokenFromRewardCustody(holder, address(erc20), 50);
        assertEq(erc20.balanceOf(holder), 50, "still at the holder, nothing reported");

        CreditOnlyERC1155 units = new CreditOnlyERC1155();
        units.mint(holder, 7, 3);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RewardCustodySourceNotDebited.selector, holder, 3, 0)
        );
        _custody().sweepERC1155FromRewardCustody(holder, address(units), 7, 3);
        assertEq(units.balanceOf(holder, 7), 3, "still at the holder, nothing reported");
    }

    /// @dev Codex #2158 r23 P2 — configured VPFI sent straight to the BOUND
    ///      holder has a disposition: the unattributed remainder (what no
    ///      ledger row describes) can be moved to the treasury, ADMIN, under
    ///      the manual pause, never beyond that remainder. With no row writer
    ///      in PR A every row is zero, so the remainder is the whole balance;
    ///      the bound is exercised by asking for more than is held.
    function test_SweepUnattributed_DrainsOnlyWhatNoRowDescribes() public {
        address holder = _bind();
        address treasury = _treasury();
        vpfi.mint(holder, 100 ether); // unsolicited, no writer credited it
        (,, bool known, uint256 held, uint256 attributed) = _custody().rewardCustodySnapshot();
        assertTrue(known); assertEq(held - attributed, 100 ether, "all of it is unattributed");

        vm.expectRevert(LibPausable.ExpectedManualPause.selector);
        _custody().sweepUnattributedVpfiFromRewardCustody(60 ether);
        _pause();
        vm.prank(nonAdmin);
        _expectNotAdmin(nonAdmin);
        _custody().sweepUnattributedVpfiFromRewardCustody(60 ether);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit RewardCustodyUnattributedVpfiSwept(holder, treasury, 60 ether, 100 ether);
        _custody().sweepUnattributedVpfiFromRewardCustody(60 ether);
        assertEq(vpfi.balanceOf(treasury), 60 ether, "to the treasury");
        assertEq(vpfi.balanceOf(holder), 40 ether);

        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RewardCustodyExceedsUnattributed.selector, 50 ether, 40 ether)
        );
        _custody().sweepUnattributedVpfiFromRewardCustody(50 ether);
    }

    function test_SweepNative_IsAdminOnly() public {
        address holder = _bind();
        vm.prank(nonAdmin);
        _expectNotAdmin(nonAdmin);
        _custody().sweepNativeFromRewardCustody(holder, 1);
    }

    /// @dev Codex #2158 r26 P2 — the native sweep verifies the holder's debit:
    ///      a treasury that forces the value back into the holder leaves the
    ///      holder's balance unchanged, and the sweep refuses.
    function test_SweepNative_RefusesWhenTheTreasuryForcesTheValueBack() public {
        address holder = _bind();
        RefundingTreasury refunding = new RefundingTreasury();
        AdminFacet(address(diamond)).setTreasury(address(refunding));
        vm.deal(holder, 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RewardCustodySourceNotDebited.selector, holder, 1 ether, 0)
        );
        _custody().sweepNativeFromRewardCustody(holder, 1 ether);
        assertEq(holder.balance, 1 ether, "nothing left the holder");
    }

    /// @dev Codex #2158 r8 P2 — a token that is not the configured VPFI is
    ///      invisible to the snapshot and would stay behind at a replaced
    ///      holder; the sweep recovers it from the bound holder AND from a
    ///      previous one, to the treasury only.
    function test_Sweep_RecoversAForeignTokenFromBoundAndPreviousHolders() public {
        address holder = _bind();
        address treasury = _treasury();
        PlainERC20 foreign = new PlainERC20();
        foreign.mint(holder, 70);

        // Invisible to the snapshot (which covers the configured VPFI only).
        (,, bool known, uint256 held,) = _custody().rewardCustodySnapshot();
        assertTrue(known); assertEq(held, 0, "snapshot sees no VPFI; the foreign token is outside it");

        _pause();
        address successor = _custody().replaceRewardCustodyHolder();
        assertEq(foreign.balanceOf(holder), 70, "replacement moved only the configured VPFI; the foreign token stayed behind");

        vm.expectEmit(true, true, true, true, address(diamond));
        emit RewardCustodyForeignTokenSwept(holder, address(foreign), treasury, 70, 70);
        _custody().sweepForeignTokenFromRewardCustody(holder, address(foreign), 70);
        assertEq(foreign.balanceOf(treasury), 70, "recovered to the treasury");
        assertEq(foreign.balanceOf(holder), 0);

        foreign.mint(successor, 5);
        _custody().sweepForeignTokenFromRewardCustody(successor, address(foreign), 5);
        assertEq(foreign.balanceOf(treasury), 75, "also from the bound holder");
    }

    /// @dev Codex #2158 r9 P2 — the sweep reports the treasury's MEASURED
    ///      receipt, not the requested amount: a fee-on-transfer token
    ///      credits less.
    function test_Sweep_ReportsTheMeasuredReceiptNotTheRequest() public {
        address holder = _bind();
        address treasury = _treasury();
        FeeSkimmingERC20 skim = new FeeSkimmingERC20();
        skim.mint(holder, 100);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit RewardCustodyForeignTokenSwept(holder, address(skim), treasury, 100, 99);
        _custody().sweepForeignTokenFromRewardCustody(holder, address(skim), 100);
        assertEq(skim.balanceOf(treasury), 99);
    }

    // ─── 5. Read surface ────────────────────────────────────────────────────

    function test_Snapshot_SaysWhatItDoesNotKnow() public {
        // Unbound: no balance can be read.
        (address h, address t, bool known, uint256 held, uint256 attributed) =
            _custody().rewardCustodySnapshot();
        assertEq(h, address(0));
        assertEq(t, address(vpfi));
        assertFalse(known, "unbound: balance unknown, not zero");
        assertEq(held, 0);
        assertEq(attributed, 0);

        // Bound but token unset: still unknown.
        address holder = _bind();
        _mut().setVpfiTokenRaw(address(0));
        (, t, known, held,) = _custody().rewardCustodySnapshot();
        assertEq(t, address(0));
        assertFalse(known, "no token: balance unknown");

        // Bound with a token: known, and read from the holder.
        _mut().setVpfiTokenRaw(address(vpfi));
        vpfi.mint(holder, 42 ether);
        (h, t, known, held, attributed) = _custody().rewardCustodySnapshot();
        assertEq(h, holder);
        assertTrue(known);
        assertEq(held, 42 ether);
        assertEq(attributed, 0, "PR A has no writer: every row is zero");
    }

    /// @dev Codex #2158 r3 P2 — a token that cannot answer `balanceOf` (an
    ///      EOA, a non-conforming contract, a proxy upgraded into a reverting
    ///      implementation) must read as UNKNOWN, never revert the snapshot
    ///      and never read as empty.
    function test_Snapshot_UnreadableTokenReportsUnknownNotZeroAndNeverReverts() public {
        _bind();

        _mut().setVpfiTokenRaw(nonAdmin); // an EOA
        (,, bool known, uint256 held,) = _custody().rewardCustodySnapshot();
        assertFalse(known, "EOA token: unknown");
        assertEq(held, 0);

        _mut().setVpfiTokenRaw(address(new RevertingBalanceToken()));
        (,, known, held,) = _custody().rewardCustodySnapshot();
        assertFalse(known, "reverting balanceOf: unknown");
        assertEq(held, 0);

        _mut().setVpfiTokenRaw(address(diamond)); // a contract without balanceOf
        (,, known,,) = _custody().rewardCustodySnapshot();
        assertFalse(known, "no balanceOf: unknown");
    }

    function test_Rows_AllReadZeroOnAPrAADiamond() public view {
        uint256 last = uint256(LibVaipakam.RewardCustodyRow.Restitution);
        for (uint256 i = 0; i <= last; ++i) {
            assertEq(
                _custody().rewardCustodyRow(LibVaipakam.RewardCustodyRow(i)),
                0
            );
        }
    }
}
