// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SanctionsList} from "../../src/compliance/SanctionsList.sol";
import {SanctionsDelistingTimelock} from "../../src/compliance/SanctionsDelistingTimelock.sol";
import {
    SanctionsClearanceAttestor,
    SANCTIONS_CLEARANCE_WIRE_VERSION
} from "../../src/compliance/SanctionsClearanceAttestor.sol";
import {ICrossChainMessenger} from "../../src/crosschain/ICrossChainMessenger.sol";
import {ISanctionsList} from "../../src/interfaces/ISanctionsList.sol";
import {MockSanctionsList} from "../mocks/MockSanctionsList.sol";

/// @dev A messenger stand-in: records what a handler sends, charges a fixed
///      fee and refunds the rest to the caller, and delivers on demand.
contract ClearanceMessengerMock {
    uint256 public constant FEE = 0.01 ether;
    bytes public lastPayload;
    uint256 public lastDest;
    uint256 public lastGas;

    function sendMessage(uint256 dest, bytes calldata payload, ICrossChainMessenger.TokenAmount[] calldata, uint256 gas)
        external
        payable
        returns (bytes32)
    {
        require(msg.value >= FEE, "fee");
        lastPayload = payload;
        lastDest = dest;
        lastGas = gas;
        uint256 refund = msg.value - FEE;
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            require(ok, "refund");
        }
        return keccak256(payload);
    }

    function quoteMessageFee(uint256, bytes calldata, ICrossChainMessenger.TokenAmount[] calldata, uint256)
        external
        pure
        returns (uint256)
    {
        return FEE;
    }

    function deliver(SanctionsDelistingTimelock to, uint256 sourceChainId, address sourceSender, bytes memory payload)
        external
    {
        to.onCrossChainMessage(sourceChainId, sourceSender, payload, new ICrossChainMessenger.TokenAmount[](0), bytes32(0));
    }

    function deliverWithToken(SanctionsDelistingTimelock to, uint256 sourceChainId, address sourceSender, bytes memory payload)
        external
    {
        ICrossChainMessenger.TokenAmount[] memory t = new ICrossChainMessenger.TokenAmount[](1);
        t[0] = ICrossChainMessenger.TokenAmount(address(1), 1);
        to.onCrossChainMessage(sourceChainId, sourceSender, payload, t, bytes32(0));
    }
}

/**
 * @title  SanctionsDelistingTimelockTest
 * @notice #2443 — automated delisting: the bot proposes against the list's
 *         own publication, the Safe can veto during the window and keeps its
 *         direct delist, and execution needs RedStone to clear every address,
 *         read live where the list has it as a secondary or carried over
 *         CCIP by the attestor from a chain where it is deployed.
 */
contract SanctionsDelistingTimelockTest is Test {
    address internal admin = makeAddr("admin");
    address internal safe = makeAddr("safe");
    address internal adder = makeAddr("adder");
    address internal bot = makeAddr("bot");
    address internal stranger = makeAddr("stranger");
    address internal a = makeAddr("a");
    address internal b = makeAddr("b");
    address internal c = makeAddr("c");

    bytes32 internal constant H1 = keccak256("sdn@20261015");
    bytes32 internal constant H2 = keccak256("sdn@20261016");
    uint32 internal constant D1 = 20261015;
    uint32 internal constant D2 = 20261016;
    uint256 internal constant SRC = 8453;

    MockSanctionsList internal redstone;
    ClearanceMessengerMock internal messenger;
    address internal attestorAddr = makeAddr("attestor");

    event DelistingProposed(
        uint256 indexed id,
        address indexed proposer,
        address[] accounts,
        bytes32 sourceHash,
        uint32 publicationDate,
        uint64 eta
    );
    event DelistingExecuted(
        uint256 indexed id, address indexed by, SanctionsDelistingTimelock.GateMode gate, uint64 listVersion
    );
    event DelistingCancelled(uint256 indexed id, address indexed by);
    event ClearanceRecorded(address indexed account, bool flagged, uint64 asOf, uint32 indexed epoch);

    function setUp() public {
        vm.warp(1_800_000_000);
        redstone = new MockSanctionsList();
        messenger = new ClearanceMessengerMock();
    }

    // ── Fixtures ──────────────────────────────────────────────────────

    /// @dev A list recording `a`, `b`, `c` from D1, then D2's publication
    ///      calling for `a` and `b` to be delisted (declared outstanding by
    ///      the adder, not applied), and a timelock appointed as remover.
    function _deploy(address secondary) internal returns (SanctionsList list, SanctionsDelistingTimelock tl) {
        list = new SanctionsList(admin, secondary);
        tl = new SanctionsDelistingTimelock(admin, list);
        vm.startPrank(admin);
        list.setAdder(adder, true);
        list.setRemover(safe, true);
        list.setRemover(address(tl), true);
        tl.setProposer(bot, true);
        vm.stopPrank();
        vm.prank(adder);
        list.applyUpdate(0, _arr(a, b, c), _none(), H1, D1, 0, 0);
        vm.prank(adder);
        list.applyUpdate(1, _none(), _none(), H2, D2, 0, 2);
    }

    function _local() internal returns (SanctionsList, SanctionsDelistingTimelock) {
        return _deploy(address(redstone));
    }

    function _crossChain() internal returns (SanctionsList list, SanctionsDelistingTimelock tl) {
        (list, tl) = _deploy(address(0));
        vm.prank(admin);
        tl.setClearanceSource(address(messenger), SRC, attestorAddr);
    }

    function _clear(SanctionsDelistingTimelock tl, address[] memory accts, bool[] memory flags, uint64 asOf) internal {
        messenger.deliver(tl, SRC, attestorAddr, abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, accts, flags, asOf));
    }

    function _propose(SanctionsDelistingTimelock tl, address[] memory accts) internal returns (uint256 id) {
        vm.prank(bot);
        id = tl.propose(accts, H2, D2);
    }

    function _arr(address x) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = x;
    }

    function _arr(address x, address y) internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = x;
        r[1] = y;
    }

    function _arr(address x, address y, address z) internal pure returns (address[] memory r) {
        r = new address[](3);
        r[0] = x;
        r[1] = y;
        r[2] = z;
    }

    function _none() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _flags(bool x, bool y) internal pure returns (bool[] memory r) {
        r = new bool[](2);
        r[0] = x;
        r[1] = y;
    }

    function _flags(bool x) internal pure returns (bool[] memory r) {
        r = new bool[](1);
        r[0] = x;
    }

    // ── Proposing ─────────────────────────────────────────────────────

    function test_Propose_RecordsAgainstTheListsPublication() public {
        (, SanctionsDelistingTimelock tl) = _local();
        uint64 eta = uint64(block.timestamp) + tl.DEFAULT_DELAY();
        vm.expectEmit(address(tl));
        emit DelistingProposed(1, bot, _arr(a, b), H2, D2, eta);
        uint256 id = _propose(tl, _arr(a, b));
        assertEq(id, 1);
        assertEq(tl.proposalOf(a), 1);
        assertEq(tl.proposalOf(b), 1);
        SanctionsDelistingTimelock.Proposal memory p = tl.getProposal(id);
        assertEq(uint8(p.status), uint8(SanctionsDelistingTimelock.Status.Pending));
        assertEq(p.eta, eta);
        assertEq(p.accounts.length, 2);
    }

    function test_Propose_Refusals() public {
        (, SanctionsDelistingTimelock tl) = _local();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotProposer.selector, stranger));
        tl.propose(_arr(a), H2, D2);

        vm.startPrank(bot);
        vm.expectRevert(SanctionsDelistingTimelock.EmptyBatch.selector);
        tl.propose(_none(), H2, D2);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.PublicationMismatch.selector, H1, D1, H2, D2));
        tl.propose(_arr(a), H1, D1);
        // D2 declared two delistings outstanding, not three.
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ExceedsPendingDelistings.selector, 3, 2));
        tl.propose(_arr(a, b, c), H2, D2);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotListedByOwnList.selector, stranger));
        tl.propose(_arr(stranger), H2, D2);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.AlreadyProposed.selector, a, 1));
        tl.propose(_arr(a, a), H2, D2);
        tl.propose(_arr(a), H2, D2);
        // The refused batch above reverted whole, so this was proposal 1.
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.AlreadyProposed.selector, a, 1));
        tl.propose(_arr(a), H2, D2);
        vm.stopPrank();
    }

    // ── The Safe's veto and direct delist ─────────────────────────────

    function test_Cancel_BySafeOwnerOrProposer_NotByStranger() public {
        (, SanctionsDelistingTimelock tl) = _local();
        uint256 id1 = _propose(tl, _arr(a));
        uint256 id2 = _propose(tl, _arr(b));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotCanceller.selector, stranger));
        tl.cancel(id1);

        vm.expectEmit(address(tl));
        emit DelistingCancelled(id1, safe);
        vm.prank(safe);
        tl.cancel(id1);
        assertEq(tl.proposalOf(a), 0, "released");

        vm.prank(admin);
        tl.cancel(id2);

        // A cancelled proposal never executes, even after its eta.
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                SanctionsDelistingTimelock.NotPending.selector, id1, SanctionsDelistingTimelock.Status.Cancelled
            )
        );
        tl.execute(id1);

        // The Safe's and the owner's cancels are vetoes: neither address
        // can be proposed again.
        assertTrue(tl.vetoed(a));
        assertTrue(tl.vetoed(b));
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.Vetoed.selector, a));
        tl.propose(_arr(a), H2, D2);

        // Until the Safe lifts the veto.
        vm.prank(safe);
        tl.setVetoed(_arr(a), false);
        uint256 id3 = _propose(tl, _arr(a));

        // The proposer withdrawing its own proposal vetoes nothing.
        vm.prank(bot);
        tl.cancel(id3);
        assertFalse(tl.vetoed(a));
        assertEq(_propose(tl, _arr(a)), 4);
    }

    function test_Veto_BeforeOrDuringAWindow_BlocksExecution() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _local();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotVetoer.selector, stranger));
        tl.setVetoed(_arr(a), true);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotVetoer.selector, bot));
        tl.setVetoed(_arr(a), false);

        // A veto set ahead of any proposal.
        vm.prank(safe);
        tl.setVetoed(_arr(a), true);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.Vetoed.selector, a));
        tl.propose(_arr(a, b), H2, D2);

        // A veto set during a window stops execution.
        uint256 id = _propose(tl, _arr(b));
        vm.prank(admin);
        tl.setVetoed(_arr(b), true);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.Vetoed.selector, b));
        tl.execute(id);
        assertTrue(list.listedByOwnList(b));
        assertEq(list.pendingDelistings(), 2, "the publication's call stays visible as outstanding");
    }

    function test_SafeKeepsItsDirectDelist_DuringAWindow() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _local();
        uint256 id = _propose(tl, _arr(a));
        // The Safe delists `a` at once, without waiting.
        vm.prank(safe);
        list.applyUpdate(2, _none(), _arr(a), H2, D2, 0, 1);
        assertFalse(list.listedByOwnList(a));
        // The pending proposal can no longer apply, and the Safe clears it.
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotListed.selector, a));
        tl.execute(id);
        vm.prank(safe);
        tl.cancel(id);
    }

    // ── Local RedStone gate ───────────────────────────────────────────

    function test_Execute_Local_AfterWindow_WhenRedStoneClears() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _local();
        uint256 id = _propose(tl, _arr(a, b));
        vm.expectRevert(
            abi.encodeWithSelector(SanctionsDelistingTimelock.TooEarly.selector, id, block.timestamp + 2 days)
        );
        tl.execute(id);

        vm.warp(block.timestamp + 2 days);
        vm.expectEmit(address(tl));
        emit DelistingExecuted(id, stranger, SanctionsDelistingTimelock.GateMode.Local, 3);
        vm.prank(stranger); // permissionless
        tl.execute(id);

        assertFalse(list.listedByOwnList(a));
        assertFalse(list.listedByOwnList(b));
        assertTrue(list.listedByOwnList(c));
        assertEq(list.pendingDelistings(), 0, "the publication is now fully applied");
        assertEq(list.sourceHash(), H2);
        assertEq(tl.proposalOf(a), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                SanctionsDelistingTimelock.NotPending.selector, id, SanctionsDelistingTimelock.Status.Executed
            )
        );
        tl.execute(id);
    }

    function test_Execute_Local_RefusedWhileRedStoneFlags() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _local();
        uint256 id = _propose(tl, _arr(a, b));
        redstone.setFlagged(b, true);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                SanctionsDelistingTimelock.StillSanctioned.selector, b, SanctionsDelistingTimelock.GateMode.Local
            )
        );
        tl.execute(id);
        assertTrue(list.listedByOwnList(a), "all or nothing");
    }

    function test_Execute_Local_OracleOutageFailsClosed() public {
        (, SanctionsDelistingTimelock tl) = _local();
        uint256 id = _propose(tl, _arr(a));
        redstone.setRevertOnRead(true);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(bytes("oracle-outage"));
        tl.execute(id);
    }

    // ── Publication moves during the window ───────────────────────────

    function test_NewPublication_Refuses_UntilReconfirmed_KeepingEta() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _local();
        uint256 id = _propose(tl, _arr(a));
        uint64 eta = tl.getProposal(id).eta;
        // A day later the adder records a newer publication that still calls
        // for `a` and `b` to go.
        vm.warp(block.timestamp + 1 days);
        bytes32 h3 = keccak256("sdn@20261017");
        vm.prank(adder);
        list.applyUpdate(2, _none(), _none(), h3, 20261017, 0, 2);

        vm.warp(eta);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.PublicationChanged.selector, id, h3, 20261017));
        tl.execute(id);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotProposer.selector, stranger));
        tl.reconfirm(id, h3, 20261017);
        vm.startPrank(bot);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.PublicationMismatch.selector, H2, D2, h3, 20261017));
        tl.reconfirm(id, H2, D2);
        tl.reconfirm(id, h3, 20261017);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NothingToReconfirm.selector, id));
        tl.reconfirm(id, h3, 20261017);
        vm.stopPrank();

        assertEq(tl.getProposal(id).eta, eta, "the window does not restart");
        tl.execute(id);
        assertFalse(list.listedByOwnList(a));
        assertEq(list.pendingDelistings(), 1);
    }

    // ── Cross-chain RedStone gate ─────────────────────────────────────

    function test_Execute_NoGateConfigured_IsClosed() public {
        (, SanctionsDelistingTimelock tl) = _deploy(address(0));
        uint256 id = _propose(tl, _arr(a));
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(SanctionsDelistingTimelock.ClearanceUnavailable.selector);
        tl.execute(id);
    }

    function test_Execute_CrossChain_NeedsAFreshClearanceFromAfterTheEta() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _crossChain();
        uint256 id = _propose(tl, _arr(a, b));
        uint64 eta = tl.getProposal(id).eta;

        // A clearance observed during the window does not count.
        _clear(tl, _arr(a, b), _flags(false, false), uint64(block.timestamp));
        vm.warp(eta);
        vm.expectRevert(
            abi.encodeWithSelector(SanctionsDelistingTimelock.ClearanceMissingOrStale.selector, a, eta - 2 days, eta)
        );
        tl.execute(id);

        // One observed at the eta does.
        _clear(tl, _arr(a, b), _flags(false, false), eta);
        // ...but not once it is older than the max age.
        vm.warp(eta + 1 days + 1);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ClearanceMissingOrStale.selector, a, eta, eta));
        tl.execute(id);

        // A literal, not `block.timestamp`: under viaIR a test may read the
        // pre-warp value back.
        _clear(tl, _arr(a, b), _flags(false, false), eta + 1 days + 1);
        (bool ready,) = tl.readiness(id);
        assertTrue(ready);
        vm.expectEmit(address(tl));
        emit DelistingExecuted(id, address(this), SanctionsDelistingTimelock.GateMode.CrossChain, 3);
        tl.execute(id);
        assertFalse(list.listedByOwnList(a));
        assertFalse(list.listedByOwnList(b));
    }

    function test_Execute_CrossChain_RefusedWhenFlagged() public {
        (, SanctionsDelistingTimelock tl) = _crossChain();
        uint256 id = _propose(tl, _arr(a, b));
        vm.warp(block.timestamp + 2 days);
        _clear(tl, _arr(a, b), _flags(false, true), uint64(block.timestamp));
        vm.expectRevert(
            abi.encodeWithSelector(
                SanctionsDelistingTimelock.StillSanctioned.selector, b, SanctionsDelistingTimelock.GateMode.CrossChain
            )
        );
        tl.execute(id);
        (bool ready, bytes4 reason) = tl.readiness(id);
        assertFalse(ready);
        assertEq(reason, SanctionsDelistingTimelock.StillSanctioned.selector);
    }

    function test_Clearance_NewestWins_AndFutureClockIsClamped() public {
        (, SanctionsDelistingTimelock tl) = _crossChain();
        uint64 t = uint64(block.timestamp);
        _clear(tl, _arr(a), _flags(true), t);
        // An older reading delivered late does not replace it.
        _clear(tl, _arr(a), _flags(false), t - 10);
        (uint64 asOf,, bool flagged) = tl.clearanceOf(a);
        assertEq(asOf, t);
        assertTrue(flagged);
        // A reading stamped in our future is recorded as now.
        vm.expectEmit(address(tl));
        emit ClearanceRecorded(b, false, t, 1);
        _clear(tl, _arr(b), _flags(false), t + 1 hours);
    }

    function test_Clearance_NewSourceInvalidatesOldClearances() public {
        (, SanctionsDelistingTimelock tl) = _crossChain();
        uint256 id = _propose(tl, _arr(a));
        vm.warp(block.timestamp + 2 days);
        _clear(tl, _arr(a), _flags(false), uint64(block.timestamp));
        address attestor2 = makeAddr("attestor2");
        vm.prank(admin);
        tl.setClearanceSource(address(messenger), SRC, attestor2);
        vm.expectRevert(
            abi.encodeWithSelector(
                SanctionsDelistingTimelock.ClearanceMissingOrStale.selector, a, block.timestamp, block.timestamp
            )
        );
        tl.execute(id);
        // The old attestor is no longer accepted; the new one is.
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.UnauthorizedClearanceSender.selector, SRC, attestorAddr));
        _clear(tl, _arr(a), _flags(false), uint64(block.timestamp));
        messenger.deliver(
            tl, SRC, attestor2, abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, _arr(a), _flags(false), uint64(block.timestamp))
        );
        tl.execute(id);
    }

    function test_Clearance_InboundRefusals() public {
        (, SanctionsDelistingTimelock tl) = _crossChain();
        bytes memory ok = abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, _arr(a), _flags(false), uint64(block.timestamp));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotMessenger.selector, stranger));
        tl.onCrossChainMessage(SRC, attestorAddr, ok, new ICrossChainMessenger.TokenAmount[](0), bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.UnauthorizedClearanceSender.selector, 1, attestorAddr));
        messenger.deliver(tl, 1, attestorAddr, ok);

        vm.expectRevert(SanctionsDelistingTimelock.UnexpectedTokens.selector);
        messenger.deliverWithToken(tl, SRC, attestorAddr, ok);

        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.UnsupportedClearanceVersion.selector, 2));
        messenger.deliver(tl, SRC, attestorAddr, abi.encode(uint16(2), _arr(a), _flags(false), uint64(block.timestamp)));

        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.LengthMismatch.selector, 2, 1));
        messenger.deliver(
            tl, SRC, attestorAddr, abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, _arr(a, b), _flags(false), uint64(1))
        );

        // Turned off, nothing is accepted.
        vm.prank(admin);
        tl.setClearanceSource(address(0), 0, address(0));
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotMessenger.selector, address(messenger)));
        messenger.deliver(tl, SRC, attestorAddr, ok);
    }

    // ── Owner configuration ───────────────────────────────────────────

    function test_Config_BoundsAndOwnership() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _local();
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.DelayOutOfRange.selector, 1 days - 1));
        tl.setDelay(1 days - 1);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.DelayOutOfRange.selector, 30 days + 1));
        tl.setDelay(30 days + 1);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ClearanceMaxAgeOutOfRange.selector, 59 minutes));
        tl.setClearanceMaxAge(59 minutes);
        vm.expectRevert(SanctionsDelistingTimelock.InvalidClearanceSource.selector);
        tl.setClearanceSource(address(messenger), 0, attestorAddr);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotAContract.selector, stranger));
        tl.setClearanceSource(stranger, SRC, attestorAddr);
        vm.expectRevert(SanctionsDelistingTimelock.RenounceDisabled.selector);
        tl.renounceOwnership();
        vm.stopPrank();

        vm.startPrank(stranger);
        vm.expectRevert();
        tl.setDelay(3 days);
        vm.expectRevert();
        tl.setProposer(stranger, true);
        vm.expectRevert();
        tl.setClearanceSource(address(messenger), SRC, attestorAddr);
        vm.stopPrank();

        // A new delay applies to new proposals only.
        uint256 id1 = _propose(tl, _arr(a));
        vm.prank(admin);
        tl.setDelay(5 days);
        uint256 id2 = _propose(tl, _arr(b));
        assertEq(tl.getProposal(id1).eta, block.timestamp + 2 days);
        assertEq(tl.getProposal(id2).eta, block.timestamp + 5 days);

        // Removing the proposer stops new proposals at once.
        vm.prank(admin);
        tl.setProposer(bot, false);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotProposer.selector, bot));
        tl.propose(_arr(c), H2, D2);
        assertTrue(list.listedByOwnList(c));
    }

    function test_WithoutRemoverRole_ExecutionCannotDelist() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _local();
        uint256 id = _propose(tl, _arr(a));
        vm.prank(admin);
        list.setRemover(address(tl), false);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotRemover.selector, address(tl)));
        tl.execute(id);
    }

    // ── Attestor ──────────────────────────────────────────────────────

    function test_Attestor_SendsWhatTheOracleSays_AndRefunds() public {
        SanctionsClearanceAttestor att =
            new SanctionsClearanceAttestor(ISanctionsList(address(redstone)), ICrossChainMessenger(address(messenger)));
        redstone.setFlagged(b, true);
        assertEq(att.quote(84532, _arr(a, b)), messenger.FEE());
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        att.attest{value: 0.05 ether}(84532, _arr(a, b));
        assertEq(stranger.balance, 1 ether - messenger.FEE(), "overpayment returned to the caller");
        assertEq(address(att).balance, 0);
        assertEq(messenger.lastDest(), 84532);
        assertEq(messenger.lastGas(), att.DEST_GAS_BASE() + 2 * att.DEST_GAS_PER_ACCOUNT());
        (uint16 v, address[] memory accts, bool[] memory flags, uint64 asOf) =
            abi.decode(messenger.lastPayload(), (uint16, address[], bool[], uint64));
        assertEq(v, SANCTIONS_CLEARANCE_WIRE_VERSION);
        assertEq(accts[0], a);
        assertEq(accts[1], b);
        assertFalse(flags[0]);
        assertTrue(flags[1]);
        assertEq(asOf, block.timestamp);
    }

    function test_Attestor_Refusals() public {
        SanctionsClearanceAttestor att =
            new SanctionsClearanceAttestor(ISanctionsList(address(redstone)), ICrossChainMessenger(address(messenger)));
        vm.deal(address(this), 1 ether);
        redstone.setRevertFor(b, true);
        vm.expectRevert(bytes("oracle-outage"));
        att.attest{value: 0.01 ether}(84532, _arr(a, b));
        vm.expectRevert(SanctionsClearanceAttestor.EmptyBatch.selector);
        att.attest{value: 0.01 ether}(84532, _none());
        vm.expectRevert(SanctionsClearanceAttestor.NotAReceiver.selector);
        att.onCrossChainMessage(1, a, "", new ICrossChainMessenger.TokenAmount[](0), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(SanctionsClearanceAttestor.UnexpectedNative.selector, address(this)));
        (bool sent,) = address(att).call{value: 1}("");
        sent;
        vm.expectRevert(abi.encodeWithSelector(SanctionsClearanceAttestor.NotAContract.selector, stranger));
        new SanctionsClearanceAttestor(ISanctionsList(stranger), ICrossChainMessenger(address(messenger)));
    }

    /// @dev End to end through the attestor's own payload: what it sends is
    ///      what the timelock accepts.
    function test_AttestorPayload_IsAcceptedByTheTimelock() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _deploy(address(0));
        SanctionsClearanceAttestor att =
            new SanctionsClearanceAttestor(ISanctionsList(address(redstone)), ICrossChainMessenger(address(messenger)));
        vm.prank(admin);
        tl.setClearanceSource(address(messenger), SRC, address(att));
        uint256 id = _propose(tl, _arr(a));
        vm.warp(block.timestamp + 2 days);
        vm.deal(address(this), 1 ether);
        att.attest{value: 0.01 ether}(block.chainid, _arr(a));
        messenger.deliver(tl, SRC, address(att), messenger.lastPayload());
        tl.execute(id);
        assertFalse(list.listedByOwnList(a));
    }

    receive() external payable {}
}
