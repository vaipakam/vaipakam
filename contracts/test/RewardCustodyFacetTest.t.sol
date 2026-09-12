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

/**
 * @title RewardCustodyFacetTest — #1566 slice 4 PR A
 * @notice The holder's Diamond gate, the one-shot binding, the paused
 *         replacement ceremony (whole balance moves, pointer flips, delta
 *         verified), the paid-side rebase (paused, ADMIN, one-shot, a FLOOR,
 *         canonical-only received rewrite, seeder consumed), and the read
 *         surface that says what it does not know.
 */
contract RewardCustodyFacetTest is SetupTest {
    // Mirrors of the facet's / holder's events, for `vm.expectEmit`.
    event RewardCustodyHolderBound(address indexed holder);
    event RewardCustodyHolderReplaced(
        address indexed previous,
        address indexed successor,
        address indexed token,
        uint256 balanceMoved
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

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;

    VPFIToken internal vpfi;
    RewardCustodyHolder internal holder;
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

        holder = new RewardCustodyHolder(address(diamond));
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

    // ─── 1. The holder itself ───────────────────────────────────────────────

    function test_Holder_ConstructorRefusesZeroDiamond() public {
        vm.expectRevert(RewardCustodyHolder.RewardCustodyHolderZeroAddress.selector);
        new RewardCustodyHolder(address(0));
    }

    function test_Holder_ReleaseIsDiamondGated() public {
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
        vpfi.mint(address(holder), 10 ether);
        vm.prank(address(diamond));
        vm.expectRevert(RewardCustodyHolder.RewardCustodyHolderZeroAddress.selector);
        holder.release(address(vpfi), address(0), 1 ether);
    }

    function test_Holder_ReleaseByDiamondMovesAndEmits() public {
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
        _custody().bindRewardCustodyHolder(address(holder));
    }

    function test_Bind_RefusesZero() public {
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        _custody().bindRewardCustodyHolder(address(0));
    }

    function test_Bind_RefusesAnEoa() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardCustodyHolderNotOurs.selector,
                nonAdmin
            )
        );
        _custody().bindRewardCustodyHolder(nonAdmin);
    }

    function test_Bind_RefusesAHolderBuiltForAnotherDiamond() public {
        RewardCustodyHolder foreign = new RewardCustodyHolder(makeAddr("otherDiamond"));
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardCustodyHolderNotOurs.selector,
                address(foreign)
            )
        );
        _custody().bindRewardCustodyHolder(address(foreign));
    }

    function test_Bind_RefusesAContractWithoutTheGetter() public {
        // The VPFI token is a contract, but it is not a holder.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardCustodyHolderNotOurs.selector,
                address(vpfi)
            )
        );
        _custody().bindRewardCustodyHolder(address(vpfi));
    }

    function test_Bind_SucceedsOnceAndEmits() public {
        assertEq(_custody().rewardCustodyHolder(), address(0), "unbound at start");
        vm.expectEmit(true, false, false, true, address(diamond));
        emit RewardCustodyHolderBound(address(holder));
        _custody().bindRewardCustodyHolder(address(holder));
        assertEq(_custody().rewardCustodyHolder(), address(holder), "bound");

        RewardCustodyHolder another = new RewardCustodyHolder(address(diamond));
        vm.expectRevert(IVaipakamErrors.RewardCustodyHolderAlreadyBound.selector);
        _custody().bindRewardCustodyHolder(address(another));
        assertEq(_custody().rewardCustodyHolder(), address(holder), "first binding stands");
    }

    // ─── 3. Replacement ceremony ────────────────────────────────────────────

    function test_Replace_RequiresPause() public {
        _custody().bindRewardCustodyHolder(address(holder));
        RewardCustodyHolder successor = new RewardCustodyHolder(address(diamond));
        vm.expectRevert(LibPausable.ExpectedPause.selector);
        _custody().replaceRewardCustodyHolder(address(successor));
    }

    function test_Replace_IsAdminOnly() public {
        _custody().bindRewardCustodyHolder(address(holder));
        _pause();
        RewardCustodyHolder successor = new RewardCustodyHolder(address(diamond));
        vm.prank(nonAdmin);
        _expectNotAdmin(nonAdmin);
        _custody().replaceRewardCustodyHolder(address(successor));
    }

    function test_Replace_RefusesWhileUnbound() public {
        _pause();
        vm.expectRevert(IVaipakamErrors.RewardCustodyHolderNotBound.selector);
        _custody().replaceRewardCustodyHolder(address(holder));
    }

    function test_Replace_RefusesTheSameHolder() public {
        _custody().bindRewardCustodyHolder(address(holder));
        _pause();
        vm.expectRevert(IVaipakamErrors.RewardCustodyHolderUnchanged.selector);
        _custody().replaceRewardCustodyHolder(address(holder));
    }

    function test_Replace_RefusesWithoutAVpfiToken() public {
        _custody().bindRewardCustodyHolder(address(holder));
        _mut().setVpfiTokenRaw(address(0));
        _pause();
        RewardCustodyHolder successor = new RewardCustodyHolder(address(diamond));
        vm.expectRevert(IVaipakamErrors.RewardCustodyTokenUnset.selector);
        _custody().replaceRewardCustodyHolder(address(successor));
    }

    function test_Replace_RefusesASuccessorBuiltForAnotherDiamond() public {
        _custody().bindRewardCustodyHolder(address(holder));
        _pause();
        RewardCustodyHolder foreign = new RewardCustodyHolder(makeAddr("otherDiamond"));
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardCustodyHolderNotOurs.selector,
                address(foreign)
            )
        );
        _custody().replaceRewardCustodyHolder(address(foreign));
    }

    function test_Replace_MovesWholeBalanceAndFlipsPointer() public {
        _custody().bindRewardCustodyHolder(address(holder));
        vpfi.mint(address(holder), 1_000 ether);
        RewardCustodyHolder successor = new RewardCustodyHolder(address(diamond));
        _pause();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit RewardCustodyHolderReplaced(
            address(holder), address(successor), address(vpfi), 1_000 ether
        );
        _custody().replaceRewardCustodyHolder(address(successor));

        assertEq(_custody().rewardCustodyHolder(), address(successor), "pointer flipped");
        assertEq(vpfi.balanceOf(address(holder)), 0, "old holder emptied");
        assertEq(vpfi.balanceOf(address(successor)), 1_000 ether, "successor holds it all");

        // The old holder is now unbound: a release from it by the Diamond
        // would still be gated correctly, but the Diamond no longer points
        // at it — the snapshot reads the successor.
        (address h,, bool known, uint256 held,) = _custody().rewardCustodySnapshot();
        assertEq(h, address(successor));
        assertTrue(known);
        assertEq(held, 1_000 ether);
    }

    function test_Replace_WithAnEmptyHolderMovesNothing() public {
        _custody().bindRewardCustodyHolder(address(holder));
        RewardCustodyHolder successor = new RewardCustodyHolder(address(diamond));
        _pause();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit RewardCustodyHolderReplaced(
            address(holder), address(successor), address(vpfi), 0
        );
        _custody().replaceRewardCustodyHolder(address(successor));
        assertEq(_custody().rewardCustodyHolder(), address(successor));
    }

    function test_Replace_RefusesAPreFundedSuccessor() public {
        // Value already sitting in the successor would be custody no row
        // describes, invisible to the delta check — refuse before moving.
        _custody().bindRewardCustodyHolder(address(holder));
        vpfi.mint(address(holder), 1_000 ether);
        RewardCustodyHolder successor = new RewardCustodyHolder(address(diamond));
        vpfi.mint(address(successor), 5 ether);
        _pause();

        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardCustodySuccessorNotEmpty.selector,
                address(successor),
                5 ether
            )
        );
        _custody().replaceRewardCustodyHolder(address(successor));
        assertEq(_custody().rewardCustodyHolder(), address(holder), "pointer untouched");
        assertEq(vpfi.balanceOf(address(holder)), 1_000 ether, "nothing moved");
    }

    function test_Replace_RefusesWhenTheSuccessorCannotAccountForTheMove() public {
        // A token that skims on transfer: the successor receives one wei
        // less than the old holder released. The ceremony must revert
        // rather than flip the pointer onto a custody the ledger would
        // overstate.
        FeeSkimmingERC20 skim = new FeeSkimmingERC20();
        _mut().setVpfiTokenRaw(address(skim));
        _custody().bindRewardCustodyHolder(address(holder));
        skim.mint(address(holder), 100);
        RewardCustodyHolder successor = new RewardCustodyHolder(address(diamond));
        _pause();

        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.RewardCustodyMoveUnverified.selector,
                100,
                99
            )
        );
        _custody().replaceRewardCustodyHolder(address(successor));
        assertEq(_custody().rewardCustodyHolder(), address(holder), "pointer untouched");
        assertEq(skim.balanceOf(address(holder)), 100, "revert undid the move");
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
        assertEq(
            _received(),
            700 ether,
            "canonical: received rewritten to the zero-headroom baseline"
        );
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
        // The fresh-deploy use: role Unconfigured, total 0. Both guards
        // close, the bound stays `max`.
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
        _custody().bindRewardCustodyHolder(address(holder));
        _mut().setVpfiTokenRaw(address(0));
        (, t, known, held,) = _custody().rewardCustodySnapshot();
        assertEq(t, address(0));
        assertFalse(known, "no token: balance unknown");

        // Bound with a token: known, and read from the holder.
        _mut().setVpfiTokenRaw(address(vpfi));
        vpfi.mint(address(holder), 42 ether);
        (h, t, known, held, attributed) = _custody().rewardCustodySnapshot();
        assertEq(h, address(holder));
        assertTrue(known);
        assertEq(held, 42 ether);
        assertEq(attributed, 0, "PR A has no writer: every row is zero");
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
