// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardCustodyHolder} from "../src/RewardCustodyHolder.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

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

/// @dev A "token" whose balanceOf reverts — a proxy upgraded into a broken
///      implementation. The snapshot must report the balance as unknown.
contract RevertingBalanceToken {
    function balanceOf(address) external pure returns (uint256) {
        revert("broken");
    }
}

/**
 * @title RewardCustodyFacetTest — #1566 slice 4 PR A
 * @notice The holder's Diamond gate, the one-shot Diamond-constructed
 *         binding, the paused replacement ceremony (successor constructed
 *         in the same transaction, whole balance moves, pointer flips,
 *         growth verified, dust reported not refused), the paid-side rebase
 *         (paused, ADMIN, one-shot, a FLOOR, canonical-only received
 *         rewrite, inactive-role gate, seeder consumed), and the read
 *         surface that says what it does not know.
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
    event ArmedFreshPaidRebased(
        uint8 role,
        uint256 requestedTotal,
        uint256 paidBefore,
        uint256 paidAfter,
        uint256 receivedBefore,
        uint256 receivedAfter
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
        uint256 amount
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

    /// @dev The received counter as stored — read through the custody
    ///      facet's raw pair, since the bound getter cannot report it.
    function _received() internal view returns (uint256 received) {
        (received,) = _custody().armedFreshLedger();
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
        vm.expectRevert(LibPausable.ExpectedPause.selector);
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

    // ─── 4. The paid-side rebase ────────────────────────────────────────────

    function test_Rebase_RequiresPause() public {
        _becomeCanonical();
        vm.expectRevert(LibPausable.ExpectedPause.selector);
        _custody().rebaseArmedFreshPaid(1);
    }

    function test_Rebase_IsAdminOnly() public {
        _becomeCanonical();
        _pause();
        vm.prank(nonAdmin);
        _expectNotAdmin(nonAdmin);
        _custody().rebaseArmedFreshPaid(1);
    }

    function test_Rebase_Canonical_SetsPaidAndReceivedToTheTotal() public {
        _becomeCanonical();
        _mut().setArmedFreshLedgerRaw(1_000 ether, 400 ether);
        _pause();

        vm.expectEmit(false, false, false, true, address(diamond));
        emit ArmedFreshPaidRebased(
            uint8(LibVaipakam.RewardRole.Canonical),
            700 ether, 400 ether, 700 ether, 1_000 ether, 700 ether
        );
        _custody().rebaseArmedFreshPaid(700 ether);

        (uint256 paid,) = _lens().getDeliveredFreshBound();
        assertEq(paid, 700 ether, "paid set to the total");
        assertEq(_received(), 700 ether, "canonical: received rewritten to the zero-headroom baseline");
        assertTrue(_custody().armedFreshPaidRebased());
    }

    function test_Rebase_Canonical_IsAFloorNeverALowering() public {
        _becomeCanonical();
        _mut().setArmedFreshLedgerRaw(1_000 ether, 400 ether);
        _pause();

        // 60 of payouts followed by a retirement at 400: importing 100 must
        // keep 400, and received follows the RESULT, not the request.
        _custody().rebaseArmedFreshPaid(100 ether);

        (uint256 paid,) = _lens().getDeliveredFreshBound();
        assertEq(paid, 400 ether, "existing counter is the floor");
        assertEq(_received(), 400 ether, "received = resulting paid");
    }

    function test_Rebase_Mirror_LeavesReceivedAlone() public {
        _becomeMirror();
        _mut().setArmedFreshLedgerRaw(1_000 ether, 400 ether);
        _pause();

        vm.expectEmit(false, false, false, true, address(diamond));
        emit ArmedFreshPaidRebased(
            uint8(LibVaipakam.RewardRole.Mirror),
            700 ether, 400 ether, 700 ether, 1_000 ether, 1_000 ether
        );
        _custody().rebaseArmedFreshPaid(700 ether);

        (uint256 paid, uint256 remaining) = _lens().getDeliveredFreshBound();
        assertEq(paid, 700 ether, "paid set to the total");
        assertEq(_received(), 1_000 ether, "mirror: received untouched");
        assertEq(remaining, 300 ether, "bound = received - paid");
    }

    function test_Rebase_Mirror_AboveReceivedSaturatesTheBoundToZero() public {
        _becomeMirror();
        _mut().setArmedFreshLedgerRaw(500 ether, 0);
        _pause();
        _custody().rebaseArmedFreshPaid(800 ether);
        (uint256 paid, uint256 remaining) = _lens().getDeliveredFreshBound();
        assertEq(paid, 800 ether);
        assertEq(remaining, 0, "over-paid mirror has no headroom, not an underflow");
    }

    function test_Rebase_IsOneShot() public {
        _becomeCanonical();
        _pause();
        _custody().rebaseArmedFreshPaid(10 ether);
        vm.expectRevert(IVaipakamErrors.ArmedFreshPaidAlreadyRebased.selector);
        _custody().rebaseArmedFreshPaid(20 ether);
        (uint256 paid,) = _lens().getDeliveredFreshBound();
        assertEq(paid, 10 ether, "a refused re-run changes nothing");
    }

    function test_Rebase_ConsumesTheAdditiveSeeder() public {
        _becomeMirror();
        _mut().setArmedFreshLedgerRaw(1_000 ether, 0);
        assertFalse(_rep().armedFreshPaidSeeded(), "seeder never ran");
        _pause();
        _custody().rebaseArmedFreshPaid(300 ether);
        assertTrue(_rep().armedFreshPaidSeeded(), "rebase consumed the seed guard");

        // The stale additive path can no longer double-count on top.
        vm.expectRevert(IVaipakamErrors.ArmedFreshPaidAlreadySeeded.selector);
        _rep().seedArmedFreshPaid(300 ether);
        (uint256 paid,) = _lens().getDeliveredFreshBound();
        assertEq(paid, 300 ether, "the absolute total stands");
    }

    function test_Rebase_StillAvailableAfterTheSeederRan() public {
        _becomeMirror();
        _mut().setArmedFreshLedgerRaw(1_000 ether, 0);
        _rep().seedArmedFreshPaid(400 ether);
        assertTrue(_rep().armedFreshPaidSeeded());
        _pause();
        // Closure 2 widened the paid history: the reconciled total is 650.
        _custody().rebaseArmedFreshPaid(650 ether);
        (uint256 paid, uint256 remaining) = _lens().getDeliveredFreshBound();
        assertEq(paid, 650 ether, "set, not added: 400 + 650 would be wrong");
        assertEq(remaining, 350 ether);
    }

    function test_Rebase_Unconfigured_ConsumesGuardsWithoutTouchingTheBound() public {
        // The fresh-deploy use: role Unconfigured, total 0, paid 0. Both
        // guards close, the bound stays `max`.
        _pause();
        vm.expectEmit(false, false, false, true, address(diamond));
        emit ArmedFreshPaidRebased(
            uint8(LibVaipakam.RewardRole.Unconfigured), 0, 0, 0, 0, 0
        );
        _custody().rebaseArmedFreshPaid(0);
        assertTrue(_custody().armedFreshPaidRebased());
        assertTrue(_rep().armedFreshPaidSeeded());
        (uint256 paid, uint256 remaining) = _lens().getDeliveredFreshBound();
        assertEq(paid, 0);
        assertEq(remaining, type(uint256).max, "Unconfigured never reads this ledger");
    }

    /// @dev Codex #2158 r1 P2 — an inactive role may not import history:
    ///      the role decides whether the received baseline is installed, so
    ///      a one-shot that ran before the role was known would close the
    ///      door on a deficit.
    function test_Rebase_Unconfigured_RefusesANonzeroTotal() public {
        _pause();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ArmedFreshRebaseRequiresActiveRole.selector,
                uint8(LibVaipakam.RewardRole.Unconfigured),
                5 ether,
                0,
                0
            )
        );
        _custody().rebaseArmedFreshPaid(5 ether);
        assertFalse(_custody().armedFreshPaidRebased(), "guard stays open");
        assertFalse(_rep().armedFreshPaidSeeded(), "seed guard untouched");
    }

    function test_Rebase_Unconfigured_RefusesToCloseOverAnExistingPaidCounter() public {
        // A seeded-but-unconfigured chain: consuming the guard with a zero
        // total would leave the seeded paid figure without its baseline.
        _rep().seedArmedFreshPaid(300 ether);
        _pause();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ArmedFreshRebaseRequiresActiveRole.selector,
                uint8(LibVaipakam.RewardRole.Unconfigured),
                0,
                300 ether,
                0
            )
        );
        _custody().rebaseArmedFreshPaid(0);
        assertFalse(_custody().armedFreshPaidRebased(), "guard stays open");
    }

    function test_Rebase_Detached_HistoryFreeChainConsumesGuards() public {
        _becomeDetached();
        _pause();
        _custody().rebaseArmedFreshPaid(0);
        assertTrue(_custody().armedFreshPaidRebased());
        assertTrue(_rep().armedFreshPaidSeeded());
    }

    function test_Rebase_Detached_WithPaidHistoryKeepsTheGuardOpen() public {
        // A detached mirror carrying history: the rebase waits for the
        // re-attachment ceremony, where the active role decides the baseline.
        _becomeDetached();
        _mut().setArmedFreshLedgerRaw(0, 500 ether);
        _pause();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ArmedFreshRebaseRequiresActiveRole.selector,
                uint8(LibVaipakam.RewardRole.Detached),
                0,
                500 ether,
                0
            )
        );
        _custody().rebaseArmedFreshPaid(0);
        assertFalse(_custody().armedFreshPaidRebased(), "guard stays open for re-attachment");

        // Re-attached as a mirror, the same call now runs.
        _becomeMirror();
        _custody().rebaseArmedFreshPaid(700 ether);
        (, uint256 paid) = _custody().armedFreshLedger();
        assertEq(paid, 700 ether);
        assertTrue(_custody().armedFreshPaidRebased());
    }

    /// @dev Codex #2158 r5 P1 — a pre-role-field chain detached before its
    ///      residual was retired carries `received > 0, paid == 0`. That is
    ///      NOT history-free: a zero rebase must not close the door, or a
    ///      later direct promotion to Canonical would expose the stale
    ///      received side as headroom with no way to install the baseline.
    function test_Rebase_Detached_WithReceivedHistoryKeepsTheGuardOpen() public {
        _becomeDetached();
        _mut().setArmedFreshLedgerRaw(800 ether, 0);
        _pause();
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ArmedFreshRebaseRequiresActiveRole.selector,
                uint8(LibVaipakam.RewardRole.Detached),
                0,
                0,
                800 ether
            )
        );
        _custody().rebaseArmedFreshPaid(0);
        assertFalse(_custody().armedFreshPaidRebased(), "guard stays open");

        // Promoted DIRECTLY to Canonical (never through Mirror, so no
        // residual retirement levels the counters on the way): the baseline
        // can still be installed because the guard stayed open.
        vm.chainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        assertEq(uint8(_rep().getRewardRole()), uint8(LibVaipakam.RewardRole.Canonical));
        (uint256 receivedBefore, uint256 paidBefore) = _custody().armedFreshLedger();
        assertEq(receivedBefore, 800 ether, "direct promotion left the stale received side in place");
        assertEq(paidBefore, 0);
        _custody().rebaseArmedFreshPaid(0);
        (uint256 received, uint256 paid) = _custody().armedFreshLedger();
        assertEq(paid, 0);
        assertEq(received, 0, "canonical: received levelled to paid, the stale headroom is gone");
        assertTrue(_custody().armedFreshPaidRebased());
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

    function test_Sweep_RefusesAHolderThatIsNotOurs() public {
        _bind();
        _treasury();
        PlainERC20 foreign = new PlainERC20();
        RewardCustodyHolder other = new RewardCustodyHolder(makeAddr("otherDiamond"));
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RewardCustodyHolderNotOurs.selector, address(other))
        );
        _custody().sweepForeignTokenFromRewardCustody(address(other), address(foreign), 1);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.RewardCustodyHolderNotOurs.selector, nonAdmin)
        );
        _custody().sweepForeignTokenFromRewardCustody(nonAdmin, address(foreign), 1);
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
        emit RewardCustodyForeignTokenSwept(holder, address(foreign), treasury, 70);
        _custody().sweepForeignTokenFromRewardCustody(holder, address(foreign), 70);
        assertEq(foreign.balanceOf(treasury), 70, "recovered to the treasury");
        assertEq(foreign.balanceOf(holder), 0);

        foreign.mint(successor, 5);
        _custody().sweepForeignTokenFromRewardCustody(successor, address(foreign), 5);
        assertEq(foreign.balanceOf(treasury), 75, "also from the bound holder");
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
