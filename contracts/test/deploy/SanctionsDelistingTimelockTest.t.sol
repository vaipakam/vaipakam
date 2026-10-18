// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SanctionsList} from "../../src/compliance/SanctionsList.sol";
import {SanctionsDelistingTimelock} from "../../src/compliance/SanctionsDelistingTimelock.sol";
import {
    SanctionsClearanceAttestor,
    SANCTIONS_CLEARANCE_WIRE_VERSION,
    CLEARANCE_REQUEST,
    CLEARANCE_RESPONSE
} from "../../src/compliance/SanctionsClearanceAttestor.sol";
import {ICrossChainMessenger, ICrossChainMessageRecipient} from "../../src/crosschain/ICrossChainMessenger.sol";
import {ISanctionsList} from "../../src/interfaces/ISanctionsList.sol";
import {MockSanctionsList} from "../mocks/MockSanctionsList.sol";
import {MockTimestampedSanctionsOracle} from "../mocks/MockTimestampedSanctionsOracle.sol";

/// @dev A messenger stand-in: records what a handler sends, charges a fixed
///      fee and refunds the rest to the caller (as `CcipMessenger` does), and
///      delivers on demand.
contract ClearanceMessengerMock {
    uint256 public constant FEE = 0.01 ether;
    bytes public lastPayload;
    uint256 public lastDest;
    uint256 public lastGas;
    address public lastSender;
    bytes32 public lastMessageId;
    uint256 public sent;

    function sendMessage(uint256 dest, bytes calldata payload, ICrossChainMessenger.TokenAmount[] calldata, uint256 gas)
        external
        payable
        returns (bytes32 messageId)
    {
        require(msg.value >= FEE, "fee");
        lastPayload = payload;
        lastDest = dest;
        lastGas = gas;
        lastSender = msg.sender;
        messageId = keccak256(abi.encode(++sent, payload));
        lastMessageId = messageId;
        uint256 refund = msg.value - FEE;
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            require(ok, "refund");
        }
    }

    function quoteMessageFee(uint256, bytes calldata, ICrossChainMessenger.TokenAmount[] calldata, uint256)
        external
        pure
        returns (uint256)
    {
        return FEE;
    }

    function deliver(address to, uint256 sourceChainId, address sourceSender, bytes memory payload, bytes32 messageId)
        public
    {
        ICrossChainMessageRecipient(to).onCrossChainMessage(
            sourceChainId, sourceSender, payload, new ICrossChainMessenger.TokenAmount[](0), messageId
        );
    }

    function deliver(address to, uint256 sourceChainId, address sourceSender, bytes memory payload) external {
        deliver(to, sourceChainId, sourceSender, payload, bytes32(0));
    }

    function deliverWithToken(address to, uint256 sourceChainId, address sourceSender, bytes memory payload) external {
        ICrossChainMessenger.TokenAmount[] memory t = new ICrossChainMessenger.TokenAmount[](1);
        t[0] = ICrossChainMessenger.TokenAmount(address(1), 1);
        ICrossChainMessageRecipient(to).onCrossChainMessage(sourceChainId, sourceSender, payload, t, bytes32(0));
    }

    /// @dev Bubbles the recipient's revert so a test can match it.
    function sendNative(address to) external payable {
        (bool ok, bytes memory ret) = to.call{value: msg.value}("");
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}

/**
 * @title  SanctionsDelistingTimelockTest
 * @notice #2443 — automated delisting: the bot proposes against the list's
 *         own publication, the Safe can veto during the window and keeps its
 *         direct delist, and execution needs RedStone to clear every address,
 *         read live where the list has it as a secondary, or asked over CCIP
 *         of the attestor on a chain where it is deployed once the window
 *         has ended.
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
    address internal d = makeAddr("d");

    bytes32 internal constant H1 = keccak256("sdn@20261015");
    bytes32 internal constant H2 = keccak256("sdn@20261016");
    uint32 internal constant D1 = 20261015;
    uint32 internal constant D2 = 20261016;
    uint256 internal constant SRC = 8453;
    /// @dev The test's start time. Later times are written as literals from
    ///      it, not read from `block.timestamp`: under viaIR a test may read
    ///      the pre-warp value back.
    uint256 internal constant T0 = 1_800_000_000;

    MockTimestampedSanctionsOracle internal redstone;
    ClearanceMessengerMock internal messenger;
    address internal attestorAddr = makeAddr("attestor");
    uint256 internal fee;

    function setUp() public {
        vm.warp(T0);
        redstone = new MockTimestampedSanctionsOracle();
        redstone.setLastUpdate(T0);
        messenger = new ClearanceMessengerMock();
        fee = messenger.FEE();
        vm.deal(address(this), 100 ether);
    }

    // ── Fixtures ──────────────────────────────────────────────────────

    /// @dev A list recording `a`, `b`, `c` from D1, then D2's publication
    ///      calling for `a` and `b` to be delisted (declared outstanding by
    ///      the adder, not applied) and `additionsLeft` additions, and a
    ///      timelock appointed as remover.
    function _deployWith(address secondary, uint32 additionsLeft)
        internal
        returns (SanctionsList list, SanctionsDelistingTimelock tl)
    {
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
        list.applyUpdate(1, _none(), _none(), H2, D2, additionsLeft, 2);
    }

    function _deploy(address secondary) internal returns (SanctionsList, SanctionsDelistingTimelock) {
        return _deployWith(secondary, 0);
    }

    function _local() internal returns (SanctionsList, SanctionsDelistingTimelock) {
        return _deploy(address(redstone));
    }

    function _crossChain() internal returns (SanctionsList list, SanctionsDelistingTimelock tl) {
        (list, tl) = _deploy(address(0));
        vm.prank(admin);
        tl.setClearanceSource(address(messenger), SRC, attestorAddr);
    }

    function _payload(uint64 requestId, address[] memory accts, bool[] memory flags, uint64 oracleUpdatedAt)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_RESPONSE, requestId, accts, flags, oracleUpdatedAt);
    }

    function _answer(
        SanctionsDelistingTimelock tl,
        uint64 requestId,
        address[] memory accts,
        bool[] memory flags,
        uint64 oracleUpdatedAt
    ) internal {
        messenger.deliver(address(tl), SRC, attestorAddr, _payload(requestId, accts, flags, oracleUpdatedAt));
    }

    /// @dev Send a clearance request, paying the fee, and return its id.
    function _request(SanctionsDelistingTimelock tl, uint256 id) internal returns (uint64 requestId) {
        tl.requestClearance{value: fee}(id);
        (requestId,,,,) = tl.clearanceOf(id);
    }

    function _state(SanctionsDelistingTimelock tl, uint256 id)
        internal
        view
        returns (SanctionsDelistingTimelock.ClearanceState state)
    {
        (,,,, state) = tl.clearanceOf(id);
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
        uint64 eta = uint64(T0 + 2 days);
        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.DelistingProposed(1, bot, _arr(a, b), H2, D2, eta);
        uint256 id = _propose(tl, _arr(a, b));
        assertEq(id, 1);
        assertEq(tl.proposalOf(a), 1);
        assertEq(tl.proposalOf(b), 1);
        assertEq(tl.reservedDelistings(), 2);
        SanctionsDelistingTimelock.Proposal memory p = tl.getProposal(id);
        assertEq(uint8(p.status), uint8(SanctionsDelistingTimelock.Status.Pending));
        assertEq(p.proposer, bot);
        assertEq(p.eta, eta);
        assertEq(p.accounts.length, 2);
        assertEq(p.accountsHash, keccak256(abi.encode(_arr(a, b))));
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

    /// @dev Pending proposals together may not ask for more delistings than
    ///      the publication has outstanding, so a stolen proposer key cannot
    ///      queue a flood for the Safe to sift through.
    function test_Propose_AllPendingTogether_WithinTheOutstandingDelistings() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _local();
        _propose(tl, _arr(a));
        _propose(tl, _arr(b));
        assertEq(tl.reservedDelistings(), 2);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ExceedsPendingDelistings.selector, 3, 2));
        tl.propose(_arr(c), H2, D2);

        // A closed proposal frees its share.
        vm.prank(bot);
        tl.cancel(1);
        assertEq(tl.reservedDelistings(), 1);
        uint256 id3 = _propose(tl, _arr(c));
        assertEq(tl.reservedDelistings(), 2);

        // Executing frees its share as the list's own count drops with it.
        vm.warp(T0 + 2 days);
        tl.execute(2);
        assertEq(tl.reservedDelistings(), 1);
        assertEq(list.pendingDelistings(), 1);
        tl.execute(id3);
        assertEq(tl.reservedDelistings(), 0);
        assertEq(list.pendingDelistings(), 0);
    }

    // ── The Safe's veto and direct delist ─────────────────────────────

    function test_Cancel_BySafeOwnerOrProposer_NotByStranger() public {
        (, SanctionsDelistingTimelock tl) = _local();
        uint256 id1 = _propose(tl, _arr(a));
        uint256 id2 = _propose(tl, _arr(b));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotItsProposer.selector, id1, stranger));
        tl.cancel(id1);

        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.DelistingCancelled(id1, safe);
        vm.prank(safe);
        tl.cancel(id1);
        assertEq(tl.proposalOf(a), 0, "released");

        vm.prank(admin);
        tl.cancel(id2);
        assertEq(tl.reservedDelistings(), 0);

        // A cancelled proposal never executes, even after its eta.
        vm.warp(T0 + 3 days);
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
        vm.warp(T0 + 2 days);
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
        vm.warp(T0 + 2 days);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotListed.selector, a));
        tl.execute(id);
        vm.prank(safe);
        tl.cancel(id);
    }

    // ── A removed proposer's proposals ────────────────────────────────

    function test_RemovedProposer_CannotExecute_AndAnyoneMayDiscard() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _local();
        uint256 id = _propose(tl, _arr(a, b));

        // Not while its proposer is still trusted.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ProposerStillAppointed.selector, id, bot));
        tl.discard(id);

        vm.prank(admin);
        tl.setProposer(bot, false);
        vm.warp(T0 + 2 days);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ProposerRemoved.selector, id, bot));
        tl.execute(id);
        (bool ready, bytes4 reason) = tl.readiness(id);
        assertFalse(ready);
        assertEq(reason, SanctionsDelistingTimelock.ProposerRemoved.selector);

        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.DelistingDiscarded(id, bot, stranger);
        vm.prank(stranger);
        tl.discard(id);
        assertEq(tl.reservedDelistings(), 0);
        assertEq(tl.proposalOf(a), 0);
        assertFalse(tl.vetoed(a), "removing a key vetoes nothing");
        assertTrue(list.listedByOwnList(a));
        vm.expectRevert(
            abi.encodeWithSelector(
                SanctionsDelistingTimelock.NotPending.selector, id, SanctionsDelistingTimelock.Status.Cancelled
            )
        );
        tl.discard(id);

        // A newly appointed proposer can propose the same addresses again.
        address bot2 = makeAddr("bot2");
        vm.prank(admin);
        tl.setProposer(bot2, true);
        vm.prank(bot2);
        tl.propose(_arr(a, b), H2, D2);
    }

    /// @dev With several proposer keys, each acts only on its own
    ///      proposals: another key can neither withdraw them (and refill the
    ///      freed share) nor move them to a publication it has not re-checked.
    function test_AProposal_BelongsToTheKeyThatMadeIt() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _local();
        address bot2 = makeAddr("bot2");
        vm.prank(admin);
        tl.setProposer(bot2, true);
        uint256 id = _propose(tl, _arr(a));

        vm.prank(bot2);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotItsProposer.selector, id, bot2));
        tl.cancel(id);

        bytes32 h3 = keccak256("sdn@20261017");
        vm.prank(adder);
        list.applyUpdate(2, _none(), _none(), h3, 20261017, 0, 2);
        vm.prank(bot2);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotItsProposer.selector, id, bot2));
        tl.reconfirm(id, h3, 20261017);

        // Its own proposer may, until it is removed.
        vm.prank(bot);
        tl.reconfirm(id, h3, 20261017);
        vm.prank(admin);
        tl.setProposer(bot, false);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotItsProposer.selector, id, bot));
        tl.cancel(id);
        // The Safe's veto is unaffected.
        vm.prank(safe);
        tl.cancel(id);
        assertTrue(tl.vetoed(a));
    }

    // ── Additions before removals ─────────────────────────────────────

    function test_Execute_WaitsForThePublicationsAdditions() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _deployWith(address(redstone), 1);
        uint256 id = _propose(tl, _arr(a));
        vm.warp(T0 + 2 days);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.AdditionsOutstanding.selector, 1));
        tl.execute(id);

        // The adder applies the publication's addition; the delisting may
        // then follow.
        vm.prank(adder);
        list.applyUpdate(2, _arr(d), _none(), H2, D2, 0, 2);
        tl.execute(id);
        assertTrue(list.listedByOwnList(d));
        assertFalse(list.listedByOwnList(a));
        assertEq(list.pendingAdditions(), 0);
        assertEq(list.pendingDelistings(), 1);
    }

    // ── Which RedStone check applies ──────────────────────────────────

    function test_ClearanceRoute_IsTheOneAnswerForEveryReader() public {
        (, SanctionsDelistingTimelock none_) = _deploy(address(0));
        assertEq(uint8(none_.clearanceRoute()), uint8(SanctionsDelistingTimelock.Route.Unavailable));
        vm.prank(admin);
        none_.setClearanceSource(address(messenger), SRC, attestorAddr);
        assertEq(uint8(none_.clearanceRoute()), uint8(SanctionsDelistingTimelock.Route.CrossChain));
        vm.prank(admin);
        none_.setClearanceSource(address(0), 0, address(0));
        assertEq(uint8(none_.clearanceRoute()), uint8(SanctionsDelistingTimelock.Route.Unavailable));

        // The list's own secondary wins even with a source configured.
        (, SanctionsDelistingTimelock local_) = _local();
        vm.prank(admin);
        local_.setClearanceSource(address(messenger), SRC, attestorAddr);
        assertEq(uint8(local_.clearanceRoute()), uint8(SanctionsDelistingTimelock.Route.Local));
        uint256 id = _propose(local_, _arr(a));
        vm.warp(T0 + 2 days);
        assertEq(uint8(local_.checkExecutable(id)), uint8(SanctionsDelistingTimelock.Route.Local));
        vm.expectRevert(
            abi.encodeWithSelector(
                SanctionsDelistingTimelock.NotCrossChainRoute.selector, SanctionsDelistingTimelock.Route.Local
            )
        );
        local_.requestClearance{value: fee}(id);
    }

    // ── Local RedStone check ──────────────────────────────────────────

    function test_Execute_Local_AfterWindow_WhenRedStoneClears() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _local();
        uint256 id = _propose(tl, _arr(a, b));
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.TooEarly.selector, id, T0 + 2 days));
        tl.execute(id);

        vm.warp(T0 + 2 days);
        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.DelistingExecuted(id, stranger, SanctionsDelistingTimelock.Route.Local, 3);
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
        vm.warp(T0 + 2 days);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.StillSanctioned.selector, b));
        tl.execute(id);
        assertTrue(list.listedByOwnList(a), "all or nothing");
    }

    function test_Execute_Local_UnknownOrStaleOracle_FailsClosed() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _local();
        uint256 id = _propose(tl, _arr(a));
        vm.warp(T0 + 8 days);
        // RedStone last updated at T0: eight days ago, past the default.
        vm.expectRevert(
            abi.encodeWithSelector(
                SanctionsDelistingTimelock.OracleStale.selector, SanctionsDelistingTimelock.Route.Local, T0, 7 days
            )
        );
        tl.execute(id);
        redstone.setRevertOnTimestamp(true);
        vm.expectRevert(
            abi.encodeWithSelector(
                SanctionsDelistingTimelock.OracleFreshnessUnknown.selector, SanctionsDelistingTimelock.Route.Local
            )
        );
        tl.execute(id);
        redstone.setRevertOnTimestamp(false);
        redstone.setLastUpdate(T0 + 7 days);
        tl.execute(id);
        assertFalse(list.listedByOwnList(a));
    }

    function test_Execute_Local_OracleOutageFailsClosed() public {
        (, SanctionsDelistingTimelock tl) = _local();
        uint256 id = _propose(tl, _arr(a));
        redstone.setRevertOnRead(true);
        vm.warp(T0 + 2 days);
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
        vm.warp(T0 + 1 days);
        bytes32 h3 = keccak256("sdn@20261017");
        vm.prank(adder);
        list.applyUpdate(2, _none(), _none(), h3, 20261017, 0, 2);

        vm.warp(eta);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.PublicationChanged.selector, id, h3, 20261017));
        tl.execute(id);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotItsProposer.selector, id, stranger));
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

    // ── Cross-chain RedStone check ────────────────────────────────────

    function test_Execute_NoRouteConfigured_IsClosed() public {
        (, SanctionsDelistingTimelock tl) = _deploy(address(0));
        uint256 id = _propose(tl, _arr(a));
        vm.warp(T0 + 2 days);
        vm.expectRevert(SanctionsDelistingTimelock.ClearanceUnavailable.selector);
        tl.execute(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                SanctionsDelistingTimelock.NotCrossChainRoute.selector, SanctionsDelistingTimelock.Route.Unavailable
            )
        );
        tl.requestClearance{value: fee}(id);
    }

    function test_CrossChain_RequestSentAfterTheEta_ThenAnswered() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _crossChain();
        uint256 id = _propose(tl, _arr(a, b));

        // No request can be sent during the window.
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.TooEarly.selector, id, T0 + 2 days));
        tl.requestClearance{value: fee}(id);

        vm.warp(T0 + 2 days);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ClearanceNotRequested.selector, id));
        tl.execute(id);

        // Permissionless; the overpayment comes back to the caller.
        assertEq(tl.quoteClearanceRequest(id), fee);
        vm.deal(stranger, 1 ether);
        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.ClearanceRequested(
            id, 1, 1, uint64(T0 + 3 days), keccak256(abi.encode(uint256(1), abi.encode(
                SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_REQUEST, uint64(1), _arr(a, b)
            )))
        );
        vm.prank(stranger);
        tl.requestClearance{value: 0.05 ether}(id);
        assertEq(stranger.balance, 1 ether - fee);
        assertEq(address(tl).balance, 0);

        // What went out: the request id and the batch, to the source chain,
        // with gas sized to the batch.
        assertEq(messenger.lastDest(), SRC);
        assertEq(messenger.lastSender(), address(tl));
        assertEq(messenger.lastGas(), tl.REQUEST_GAS_BASE() + 2 * tl.REQUEST_GAS_PER_ACCOUNT());
        (uint16 v, uint8 kind, uint64 requestId, address[] memory accts) =
            abi.decode(messenger.lastPayload(), (uint16, uint8, uint64, address[]));
        assertEq(v, SANCTIONS_CLEARANCE_WIRE_VERSION);
        assertEq(kind, CLEARANCE_REQUEST);
        assertEq(requestId, 1);
        assertEq(accts[0], a);
        assertEq(accts[1], b);
        assertEq(tl.proposalOfRequest(1), id);
        (, uint64 requestedAt,, uint32 epoch, SanctionsDelistingTimelock.ClearanceState state) = tl.clearanceOf(id);
        assertEq(requestedAt, T0 + 2 days);
        assertEq(epoch, 1);
        assertEq(uint8(state), uint8(SanctionsDelistingTimelock.ClearanceState.Requested));

        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ClearanceNotAnswered.selector, id, 1));
        tl.execute(id);

        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.ClearanceAnswered(
            id, 1, _flags(false, false), uint64(T0), SanctionsDelistingTimelock.ClearanceState.Cleared
        );
        _answer(tl, 1, _arr(a, b), _flags(false, false), uint64(T0));
        (bool ready,) = tl.readiness(id);
        assertTrue(ready);
        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.DelistingExecuted(
            id, address(this), SanctionsDelistingTimelock.Route.CrossChain, 3
        );
        tl.execute(id);
        assertFalse(list.listedByOwnList(a));
        assertFalse(list.listedByOwnList(b));
    }

    /// @dev Only an answer naming a request the timelock sent counts; an
    ///      answer for anything else is ignored.
    function test_CrossChain_AnswerToAnUnknownRequest_IsIgnored() public {
        (, SanctionsDelistingTimelock tl) = _crossChain();
        uint256 id = _propose(tl, _arr(a));
        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.ClearanceIgnored(1, 0, SanctionsDelistingTimelock.IgnoreReason.UnknownRequest);
        _answer(tl, 1, _arr(a), _flags(false), uint64(T0));
        vm.warp(T0 + 2 days);
        uint64 rid = _request(tl, id);
        assertEq(rid, 1);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ClearanceNotAnswered.selector, id, rid));
        tl.execute(id);
    }

    function test_CrossChain_AFlaggedAnswerWins_InEitherOrder() public {
        (, SanctionsDelistingTimelock tl) = _crossChain();
        uint256 id1 = _propose(tl, _arr(a));
        uint256 id2 = _propose(tl, _arr(b));
        vm.warp(T0 + 2 days);
        uint64 r1 = _request(tl, id1);
        uint64 r2 = _request(tl, id2);
        assertTrue(r1 != r2);

        // Cleared first, then flagged.
        _answer(tl, r1, _arr(a), _flags(false), uint64(T0));
        _answer(tl, r1, _arr(a), _flags(true), uint64(T0));
        // Flagged first, then cleared, even with a fresher oracle.
        _answer(tl, r2, _arr(b), _flags(true), uint64(T0));
        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.ClearanceAnswered(
            id2, r2, _flags(false), uint64(T0 + 1 days), SanctionsDelistingTimelock.ClearanceState.Flagged
        );
        _answer(tl, r2, _arr(b), _flags(false), uint64(T0 + 1 days));

        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ClearanceFlagged.selector, id1, r1));
        tl.execute(id1);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ClearanceFlagged.selector, id2, r2));
        tl.execute(id2);
        (bool ready, bytes4 reason) = tl.readiness(id2);
        assertFalse(ready);
        assertEq(reason, SanctionsDelistingTimelock.ClearanceFlagged.selector);
    }

    function test_CrossChain_UnknownOrStaleOracle_FailsClosed() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _crossChain();
        uint256 id = _propose(tl, _arr(a));
        vm.warp(T0 + 10 days);
        uint64 rid = _request(tl, id);

        // The oracle reported no last-update time.
        _answer(tl, rid, _arr(a), _flags(false), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                SanctionsDelistingTimelock.OracleFreshnessUnknown.selector, SanctionsDelistingTimelock.Route.CrossChain
            )
        );
        tl.execute(id);

        // It last updated eight days ago: older than the seven-day default.
        _answer(tl, rid, _arr(a), _flags(false), uint64(T0 + 2 days));
        vm.expectRevert(
            abi.encodeWithSelector(
                SanctionsDelistingTimelock.OracleStale.selector,
                SanctionsDelistingTimelock.Route.CrossChain,
                T0 + 2 days,
                7 days
            )
        );
        tl.execute(id);

        // A later answer from a current oracle; an older one after it does
        // not lower the recorded freshness.
        _answer(tl, rid, _arr(a), _flags(false), uint64(T0 + 9 days));
        _answer(tl, rid, _arr(a), _flags(false), uint64(T0 + 2 days));
        (,, uint64 oracleUpdatedAt,,) = tl.clearanceOf(id);
        assertEq(oracleUpdatedAt, T0 + 9 days);
        tl.execute(id);
        assertFalse(list.listedByOwnList(a));
    }

    function test_CrossChain_OracleClockAheadOfOurs_IsClamped() public {
        (, SanctionsDelistingTimelock tl) = _crossChain();
        uint256 id = _propose(tl, _arr(a));
        vm.warp(T0 + 2 days);
        uint64 rid = _request(tl, id);
        _answer(tl, rid, _arr(a), _flags(false), uint64(T0 + 3 days));
        (,, uint64 oracleUpdatedAt,,) = tl.clearanceOf(id);
        assertEq(oracleUpdatedAt, T0 + 2 days);
    }

    function test_CrossChain_RequestExpires_AndOnlyThenCanBeResent() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _crossChain();
        uint256 id = _propose(tl, _arr(a));
        vm.warp(T0 + 2 days);
        uint64 rid = _request(tl, id);
        uint64 expiresAt = uint64(T0 + 3 days);

        // Not while it is usable: an answer may be in flight.
        vm.expectRevert(
            abi.encodeWithSelector(SanctionsDelistingTimelock.ClearanceOutstanding.selector, id, rid, expiresAt)
        );
        tl.requestClearance{value: fee}(id);

        _answer(tl, rid, _arr(a), _flags(false), uint64(T0 + 2 days));
        vm.warp(T0 + 3 days + 1);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ClearanceExpired.selector, id, expiresAt));
        tl.execute(id);

        uint64 rid2 = _request(tl, id);
        assertEq(tl.proposalOfRequest(rid), 0, "the old request is forgotten");
        // An answer to the old one now changes nothing.
        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.ClearanceIgnored(rid, 0, SanctionsDelistingTimelock.IgnoreReason.UnknownRequest);
        _answer(tl, rid, _arr(a), _flags(false), uint64(T0 + 3 days));
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ClearanceNotAnswered.selector, id, rid2));
        tl.execute(id);

        _answer(tl, rid2, _arr(a), _flags(false), uint64(T0 + 3 days));
        tl.execute(id);
        assertFalse(list.listedByOwnList(a));
    }

    function test_CrossChain_AnswersForOtherAccountsOrClosedProposals_AreIgnored() public {
        (, SanctionsDelistingTimelock tl) = _crossChain();
        uint256 id = _propose(tl, _arr(a, b));
        vm.warp(T0 + 2 days);
        uint64 rid = _request(tl, id);

        // A subset, or the same addresses in another order, is not the batch.
        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.ClearanceIgnored(rid, id, SanctionsDelistingTimelock.IgnoreReason.AccountsMismatch);
        _answer(tl, rid, _arr(a), _flags(false), uint64(T0));
        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.ClearanceIgnored(rid, id, SanctionsDelistingTimelock.IgnoreReason.AccountsMismatch);
        _answer(tl, rid, _arr(b, a), _flags(false, false), uint64(T0));
        assertEq(uint8(_state(tl, id)), uint8(SanctionsDelistingTimelock.ClearanceState.Requested));

        vm.prank(bot);
        tl.cancel(id);
        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.ClearanceIgnored(rid, id, SanctionsDelistingTimelock.IgnoreReason.ProposalClosed);
        _answer(tl, rid, _arr(a, b), _flags(false, false), uint64(T0));
    }

    function test_CrossChain_NewSourceVoidsTheRequest() public {
        (, SanctionsDelistingTimelock tl) = _crossChain();
        uint256 id = _propose(tl, _arr(a));
        vm.warp(T0 + 2 days);
        uint64 rid = _request(tl, id);
        _answer(tl, rid, _arr(a), _flags(false), uint64(T0));
        address attestor2 = makeAddr("attestor2");
        vm.prank(admin);
        tl.setClearanceSource(address(messenger), SRC, attestor2);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.ClearanceNotRequested.selector, id));
        tl.execute(id);

        // The old attestor is no longer accepted, and the new one's answer
        // to a request sent under the old source is ignored.
        vm.expectRevert(
            abi.encodeWithSelector(SanctionsDelistingTimelock.UnauthorizedClearanceSender.selector, SRC, attestorAddr)
        );
        _answer(tl, rid, _arr(a), _flags(false), uint64(T0));
        vm.expectEmit(address(tl));
        emit SanctionsDelistingTimelock.ClearanceIgnored(rid, id, SanctionsDelistingTimelock.IgnoreReason.Superseded);
        messenger.deliver(address(tl), SRC, attestor2, _payload(rid, _arr(a), _flags(false), uint64(T0)));

        // A voided request may be replaced at once.
        uint64 rid2 = _request(tl, id);
        messenger.deliver(address(tl), SRC, attestor2, _payload(rid2, _arr(a), _flags(false), uint64(T0)));
        tl.execute(id);
    }

    /// @dev A caller gets back what its own call overpaid, never value the
    ///      contract holds for another reason.
    function test_Refunds_OnlyTheCallsOwnOverpayment() public {
        (, SanctionsDelistingTimelock tl) = _deploy(address(0));
        SanctionsClearanceAttestor att = _attestor(ISanctionsList(address(redstone)));
        vm.prank(admin);
        tl.setClearanceSource(address(messenger), SRC, address(att));
        uint256 id = _propose(tl, _arr(a));
        vm.warp(T0 + 2 days);
        vm.deal(address(tl), 1 ether); // as if forced in
        vm.deal(address(att), 2 ether);

        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        tl.requestClearance{value: 0.05 ether}(id);
        uint64 rid = 1;
        assertEq(stranger.balance, 1 ether - fee);
        assertEq(address(tl).balance, 1 ether, "the forced balance stays");

        bytes32 mid = messenger.lastMessageId();
        messenger.deliver(address(att), block.chainid, address(tl), messenger.lastPayload(), mid);
        bytes memory reply =
            abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_RESPONSE, rid, _arr(a), _flags(false), uint64(T0));
        vm.prank(stranger);
        att.sendReply{value: 0.05 ether}(mid, reply);
        assertEq(stranger.balance, 1 ether - 2 * fee);
        assertEq(address(att).balance, 2 ether, "the forced balance stays");
    }

    function test_Clearance_InboundRefusals() public {
        (, SanctionsDelistingTimelock tl) = _crossChain();
        bytes memory ok = _payload(1, _arr(a), _flags(false), uint64(T0));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotMessenger.selector, stranger));
        tl.onCrossChainMessage(SRC, attestorAddr, ok, new ICrossChainMessenger.TokenAmount[](0), bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.UnauthorizedClearanceSender.selector, 1, attestorAddr));
        messenger.deliver(address(tl), 1, attestorAddr, ok);

        vm.expectRevert(SanctionsDelistingTimelock.UnexpectedTokens.selector);
        messenger.deliverWithToken(address(tl), SRC, attestorAddr, ok);

        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.UnsupportedClearanceVersion.selector, 2));
        messenger.deliver(
            address(tl),
            SRC,
            attestorAddr,
            abi.encode(uint16(2), CLEARANCE_RESPONSE, uint64(1), _arr(a), _flags(false), uint64(T0))
        );

        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.UnexpectedKind.selector, CLEARANCE_REQUEST));
        messenger.deliver(
            address(tl),
            SRC,
            attestorAddr,
            abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_REQUEST, uint64(1), _arr(a), _flags(false), uint64(T0))
        );

        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.LengthMismatch.selector, 2, 1));
        messenger.deliver(address(tl), SRC, attestorAddr, _payload(1, _arr(a, b), _flags(false), uint64(1)));

        // Native value only as the messenger's refund.
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.UnexpectedNative.selector, address(this)));
        (bool sent,) = address(tl).call{value: 1}("");
        sent;

        // Turned off, nothing is accepted.
        vm.prank(admin);
        tl.setClearanceSource(address(0), 0, address(0));
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotMessenger.selector, address(messenger)));
        messenger.deliver(address(tl), SRC, attestorAddr, ok);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.UnexpectedNative.selector, address(messenger)));
        messenger.sendNative{value: 1}(address(tl));
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
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.OracleMaxAgeOutOfRange.selector, 1 days - 1));
        tl.setOracleMaxAge(1 days - 1);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.OracleMaxAgeOutOfRange.selector, 30 days + 1));
        tl.setOracleMaxAge(30 days + 1);
        tl.setOracleMaxAge(30 days);
        assertEq(tl.oracleMaxAge(), 30 days);
        vm.expectRevert(SanctionsDelistingTimelock.InvalidClearanceSource.selector);
        tl.setClearanceSource(address(messenger), 0, attestorAddr);
        vm.expectRevert(abi.encodeWithSelector(SanctionsDelistingTimelock.NotAContract.selector, stranger));
        tl.setClearanceSource(stranger, SRC, attestorAddr);
        vm.expectRevert(SanctionsDelistingTimelock.ZeroAddress.selector);
        tl.setProposer(address(0), true);
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
        vm.expectRevert();
        tl.setOracleMaxAge(3 days);
        vm.stopPrank();

        // A new delay applies to new proposals only.
        uint256 id1 = _propose(tl, _arr(a));
        vm.prank(admin);
        tl.setDelay(5 days);
        uint256 id2 = _propose(tl, _arr(b));
        assertEq(tl.getProposal(id1).eta, T0 + 2 days);
        assertEq(tl.getProposal(id2).eta, T0 + 5 days);

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
        vm.warp(T0 + 2 days);
        vm.expectRevert(abi.encodeWithSelector(SanctionsList.NotRemover.selector, address(tl)));
        tl.execute(id);
    }

    // ── Attestor ──────────────────────────────────────────────────────

    function _attestor(ISanctionsList oracle) internal returns (SanctionsClearanceAttestor) {
        return new SanctionsClearanceAttestor(oracle, ICrossChainMessenger(address(messenger)));
    }

    function _requestPayload(uint64 requestId, address[] memory accts) internal pure returns (bytes memory) {
        return abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_REQUEST, requestId, accts);
    }

    function test_Attestor_ReadsWhenTheRequestArrives_ThenAnyoneSendsTheReply() public {
        SanctionsClearanceAttestor att = _attestor(ISanctionsList(address(redstone)));
        redstone.setFlagged(b, true);
        redstone.setLastUpdate(T0 - 1 hours);
        bytes32 mid = keccak256("request");
        bytes memory reply = abi.encode(
            SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_RESPONSE, uint64(7), _arr(a, b), _flags(false, true), uint64(T0 - 1 hours)
        );

        vm.expectEmit(address(att));
        emit SanctionsClearanceAttestor.ClearanceRead(
            mid, 84532, 7, _arr(a, b), _flags(false, true), uint64(T0 - 1 hours), reply
        );
        messenger.deliver(address(att), 84532, makeAddr("timelock"), _requestPayload(7, _arr(a, b)), mid);
        (uint256 dest, bytes32 hash, uint32 n, bool sentAlready) = att.replyOf(mid);
        assertEq(dest, 84532);
        assertEq(hash, keccak256(reply));
        assertEq(n, 2);
        assertFalse(sentAlready);

        // A later change at the oracle does not alter the reply owed: it was
        // read when the request arrived.
        redstone.setFlagged(b, false);
        vm.expectRevert(abi.encodeWithSelector(SanctionsClearanceAttestor.ReplyMismatch.selector, mid));
        att.sendReply{value: fee}(
            mid,
            abi.encode(
                SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_RESPONSE, uint64(7), _arr(a, b), _flags(false, false), uint64(T0 - 1 hours)
            )
        );

        assertEq(att.quoteReply(mid, reply), fee);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        att.sendReply{value: 0.05 ether}(mid, reply);
        assertEq(stranger.balance, 1 ether - fee, "overpayment returned to the caller");
        assertEq(address(att).balance, 0);
        assertEq(messenger.lastDest(), 84532);
        assertEq(messenger.lastGas(), att.REPLY_GAS_BASE() + 2 * att.REPLY_GAS_PER_ACCOUNT());
        assertEq(keccak256(messenger.lastPayload()), keccak256(reply));
        (,,, sentAlready) = att.replyOf(mid);
        assertTrue(sentAlready);

        vm.expectRevert(abi.encodeWithSelector(SanctionsClearanceAttestor.ReplyAlreadySent.selector, mid));
        att.sendReply{value: fee}(mid, reply);
    }

    function test_Attestor_OracleWithoutFreshness_RepliesZero() public {
        MockSanctionsList plain = new MockSanctionsList();
        SanctionsClearanceAttestor att = _attestor(ISanctionsList(address(plain)));
        bytes32 mid = keccak256("request");
        messenger.deliver(address(att), 84532, makeAddr("timelock"), _requestPayload(1, _arr(a)), mid);
        bytes memory reply =
            abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_RESPONSE, uint64(1), _arr(a), _flags(false), uint64(0));
        (, bytes32 hash,,) = att.replyOf(mid);
        assertEq(hash, keccak256(reply));
    }

    function test_Attestor_Refusals() public {
        SanctionsClearanceAttestor att = _attestor(ISanctionsList(address(redstone)));
        address tlAddr = makeAddr("timelock");
        bytes memory req = _requestPayload(1, _arr(a));

        vm.expectRevert(abi.encodeWithSelector(SanctionsClearanceAttestor.NotMessenger.selector, address(this)));
        att.onCrossChainMessage(1, tlAddr, req, new ICrossChainMessenger.TokenAmount[](0), keccak256("m"));
        vm.expectRevert(SanctionsClearanceAttestor.UnexpectedTokens.selector);
        messenger.deliverWithToken(address(att), 1, tlAddr, req);
        vm.expectRevert(abi.encodeWithSelector(SanctionsClearanceAttestor.UnsupportedClearanceVersion.selector, 2));
        messenger.deliver(address(att), 1, tlAddr, abi.encode(uint16(2), CLEARANCE_REQUEST, uint64(1), _arr(a)), keccak256("m"));
        vm.expectRevert(abi.encodeWithSelector(SanctionsClearanceAttestor.UnexpectedKind.selector, CLEARANCE_RESPONSE));
        messenger.deliver(
            address(att),
            1,
            tlAddr,
            abi.encode(SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_RESPONSE, uint64(1), _arr(a)),
            keccak256("m")
        );
        vm.expectRevert(SanctionsClearanceAttestor.EmptyBatch.selector);
        messenger.deliver(address(att), 1, tlAddr, _requestPayload(1, _none()), keccak256("m"));
        address[] memory big = new address[](101);
        for (uint256 i; i < 101; ++i) {
            big[i] = address(uint160(i + 1));
        }
        vm.expectRevert(abi.encodeWithSelector(SanctionsClearanceAttestor.BatchTooLarge.selector, 101, 100));
        messenger.deliver(address(att), 1, tlAddr, _requestPayload(1, big), keccak256("m"));
        vm.expectRevert(SanctionsClearanceAttestor.ZeroAddress.selector);
        messenger.deliver(address(att), 1, tlAddr, _requestPayload(1, _arr(address(0))), keccak256("m"));

        // An unreadable oracle reverts the arrival: never a "not flagged".
        redstone.setRevertFor(b, true);
        vm.expectRevert(bytes("oracle-outage"));
        messenger.deliver(address(att), 1, tlAddr, _requestPayload(1, _arr(a, b)), keccak256("m"));
        redstone.setRevertFor(b, false);

        // Read once per inbound message.
        messenger.deliver(address(att), 1, tlAddr, req, keccak256("m"));
        vm.expectRevert(abi.encodeWithSelector(SanctionsClearanceAttestor.AlreadyRead.selector, keccak256("m")));
        messenger.deliver(address(att), 1, tlAddr, req, keccak256("m"));

        vm.expectRevert(abi.encodeWithSelector(SanctionsClearanceAttestor.NoReplyOwed.selector, keccak256("other")));
        att.sendReply{value: fee}(keccak256("other"), "");
        vm.expectRevert(abi.encodeWithSelector(SanctionsClearanceAttestor.UnexpectedNative.selector, address(this)));
        (bool sent,) = address(att).call{value: 1}("");
        sent;
        vm.expectRevert(abi.encodeWithSelector(SanctionsClearanceAttestor.NotAContract.selector, stranger));
        new SanctionsClearanceAttestor(ISanctionsList(stranger), ICrossChainMessenger(address(messenger)));
        vm.expectRevert(SanctionsClearanceAttestor.ZeroAddress.selector);
        new SanctionsClearanceAttestor(ISanctionsList(address(redstone)), ICrossChainMessenger(address(0)));
    }

    /// @dev End to end through both contracts' own payloads: the timelock's
    ///      request reaches the attestor, which reads RedStone then; the reply
    ///      it owes is what the timelock accepts.
    function test_RequestAndReply_EndToEnd() public {
        (SanctionsList list, SanctionsDelistingTimelock tl) = _deploy(address(0));
        SanctionsClearanceAttestor att = _attestor(ISanctionsList(address(redstone)));
        vm.prank(admin);
        tl.setClearanceSource(address(messenger), SRC, address(att));
        uint256 id = _propose(tl, _arr(a, b));
        vm.warp(T0 + 2 days);
        uint64 rid = _request(tl, id);

        // The messenger carries the request to the attestor's chain.
        bytes32 requestMessageId = messenger.lastMessageId();
        messenger.deliver(address(att), block.chainid, address(tl), messenger.lastPayload(), requestMessageId);

        bytes memory reply = abi.encode(
            SANCTIONS_CLEARANCE_WIRE_VERSION, CLEARANCE_RESPONSE, rid, _arr(a, b), _flags(false, false), uint64(T0)
        );
        att.sendReply{value: fee}(requestMessageId, reply);
        assertEq(messenger.lastDest(), block.chainid);
        messenger.deliver(address(tl), SRC, address(att), messenger.lastPayload());
        tl.execute(id);
        assertFalse(list.listedByOwnList(a));
        assertFalse(list.listedByOwnList(b));
    }

    receive() external payable {}
}
