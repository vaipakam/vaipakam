// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {KeeperBackupUpkeep, IBackupSteps} from "../src/keeper/KeeperBackupUpkeep.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev A stand-in Diamond: each step succeeds only while the test marks it
///      due, and then stops being due (as a real step does once run).
contract MockBackupDiamond {
    error NotDue();

    uint256[] public loans;
    uint256[] public offers;
    mapping(uint256 => uint256) public linkedLoan;
    uint256 public today;
    bool public active;
    address public beacon;

    mapping(bytes4 => mapping(uint256 => bool)) public due;
    mapping(bytes4 => mapping(uint256 => uint256)) public runs;
    mapping(uint256 => uint256) public recyclable;
    uint256 public lastSellAmount = type(uint256).max;
    uint256 public lastAdapterCount = type(uint256).max;
    ERC20Mock public bonusToken;
    uint256 public bonus;

    function setLoans(uint256[] memory ids) external {
        loans = ids;
    }

    function setOffers(uint256[] memory ids) external {
        offers = ids;
    }

    function setLinked(uint256 offerId, uint256 loanId) external {
        linkedLoan[offerId] = loanId;
    }

    function setDay(uint256 day, bool active_) external {
        today = day;
        active = active_;
    }

    function setBeacon(address b) external {
        beacon = b;
    }

    function setDue(bytes4 sel, uint256 arg, bool d) external {
        due[sel][arg] = d;
    }

    function setRecyclable(uint256 day, uint256 amount) external {
        recyclable[day] = amount;
    }

    function setBonus(ERC20Mock token, uint256 amount) external {
        bonusToken = token;
        bonus = amount;
    }

    // ── reads ──
    function getActiveLoansCount() external view returns (uint256) {
        return loans.length;
    }

    function getActiveLoansPaginated(uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _slice(loans, offset, limit);
    }

    function getActiveOffersCount() external view returns (uint256) {
        return offers.length;
    }

    function getActiveOffersPaginated(uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _slice(offers, offset, limit);
    }

    function getOfferLinkedLoanId(uint256 offerId) external view returns (uint256) {
        return linkedLoan[offerId];
    }

    function getInteractionCurrentDay() external view returns (uint256, bool) {
        return (today, active);
    }

    function getVaultBeacon() external view returns (address) {
        return beacon;
    }

    // ── steps ──
    function autoDeductDaily(uint256 id) external {
        _run(id);
    }

    function cancelExpiredPrepayListing(uint256 id) external {
        _run(id);
    }

    function cancelExpiredIntent(uint256 id) external {
        _run(id);
    }

    function autoListAtFloorOnGrace(uint256 id) external {
        _run(id);
    }

    function teardownStaleSaleListing(uint256 id) external {
        _run(id);
    }

    function triggerDefault(uint256 id, uint256 sellAmount, IBackupSteps.AdapterCall[] calldata adapterCalls) external {
        _run(id);
        lastSellAmount = sellAmount;
        lastAdapterCount = adapterCalls.length;
        if (bonus != 0) bonusToken.mint(msg.sender, bonus);
    }

    function settlePeriodicInterest(uint256 id, uint256 sellAmount, IBackupSteps.AdapterCall[] calldata adapterCalls)
        external
    {
        _run(id);
        lastSellAmount = sellAmount;
        lastAdapterCount = adapterCalls.length;
    }

    function closeDay(uint256 d) external payable {
        _run(d);
    }

    function lapseZeroedDay(uint256 d) external {
        _run(d);
    }

    function lapseShortCompensatedDay(uint256 d) external {
        _run(d);
    }

    function skipConflictedDay(uint256 d) external {
        _run(d);
    }

    /// @dev Succeeds with zero once nothing is left, as the real step does.
    function recycleSkippedDayValue(uint256 d) external returns (uint256 amount) {
        amount = recyclable[d];
        recyclable[d] = 0;
        runs[msg.sig][d]++;
    }

    function _run(uint256 arg) internal {
        if (!due[msg.sig][arg]) revert NotDue();
        due[msg.sig][arg] = false;
        runs[msg.sig][arg]++;
    }

    function _slice(uint256[] storage src, uint256 offset, uint256 limit) internal view returns (uint256[] memory out) {
        if (offset >= src.length) return new uint256[](0);
        uint256 end = offset + limit > src.length ? src.length : offset + limit;
        out = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) out[i - offset] = src[i];
    }
}

contract MockBackupBeacon {
    error NoProposal();

    bool public currentDue;
    bool public revokeDue;
    uint256 public currentRuns;

    function setCurrentDue(bool d) external {
        currentDue = d;
    }

    function executeCurrentVersion() external {
        if (!currentDue) revert NoProposal();
        currentDue = false;
        currentRuns++;
    }

    function executeRevoke() external {
        if (!revokeDue) revert NoProposal();
        revokeDue = false;
    }
}

contract KeeperBackupUpkeepTest is Test {
    address constant SIM = 0x1111111111111111111111111111111111111111;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address forwarder = makeAddr("forwarder");

    MockBackupDiamond diamond;
    MockBackupBeacon beacon;
    KeeperBackupUpkeep backup;

    uint8 constant AUTO_DEDUCT = uint8(KeeperBackupUpkeep.Step.AutoDeductDaily);
    uint8 constant DEFAULT_NO_SALE = uint8(KeeperBackupUpkeep.Step.DefaultWithoutSale);
    uint8 constant TEARDOWN = uint8(KeeperBackupUpkeep.Step.TeardownStaleSaleListing);
    uint8 constant CLOSE_DAY = uint8(KeeperBackupUpkeep.Step.CloseDay);
    uint8 constant RECYCLE = uint8(KeeperBackupUpkeep.Step.RecycleSkippedDayValue);
    uint8 constant BEACON_CURRENT = uint8(KeeperBackupUpkeep.Step.BeaconExecuteCurrentVersion);

    function setUp() public {
        vm.warp(1_800_000_000);
        diamond = new MockBackupDiamond();
        beacon = new MockBackupBeacon();
        diamond.setBeacon(address(beacon));
        backup = new KeeperBackupUpkeep(address(diamond), treasury, owner);
        vm.prank(owner);
        backup.setForwarder(forwarder);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 11;
        ids[1] = 12;
        ids[2] = 13;
        diamond.setLoans(ids);
    }

    // ── helpers ──

    function _arm(uint8 step) internal {
        vm.prank(owner);
        backup.setEnabledSteps(backup.enabledSteps() | (uint256(1) << step));
    }

    function _check() internal returns (bool needed, KeeperBackupUpkeep.Action[] memory actions) {
        vm.prank(address(0xBEEF), SIM);
        bytes memory data;
        (needed, data) = backup.checkUpkeep("");
        if (needed) actions = abi.decode(data, (KeeperBackupUpkeep.Action[]));
    }

    function _perform(KeeperBackupUpkeep.Action[] memory actions) internal {
        vm.prank(forwarder);
        backup.performUpkeep(abi.encode(actions));
    }

    function _one(KeeperBackupUpkeep.Mode mode, uint8 step, uint256 arg)
        internal
        pure
        returns (KeeperBackupUpkeep.Action[] memory a)
    {
        a = new KeeperBackupUpkeep.Action[](1);
        a[0] = KeeperBackupUpkeep.Action(mode, step, arg);
    }

    // ── deployment and settings ──

    function test_DeploysWithEveryStepOff() public {
        assertEq(backup.enabledSteps(), 0);
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true);
        (bool needed,) = _check();
        assertFalse(needed);
    }

    function test_SettersAreOwnerOnlyAndBounded() public {
        vm.expectRevert();
        backup.setEnabledSteps(1);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(KeeperBackupUpkeep.StepsOutOfRange.selector, uint256(1) << 14));
        backup.setEnabledSteps(uint256(1) << 14);
        vm.expectRevert(KeeperBackupUpkeep.SettingOutOfRange.selector);
        backup.setTiming(5 minutes, 1 hours, 5 minutes);
        vm.expectRevert(KeeperBackupUpkeep.SettingOutOfRange.selector);
        backup.setTiming(1 hours, 2 days, 5 minutes);
        vm.expectRevert(KeeperBackupUpkeep.SettingOutOfRange.selector);
        backup.setScan(51, 7, 1_500_000, 2);
        vm.expectRevert(KeeperBackupUpkeep.SettingOutOfRange.selector);
        backup.setScan(10, 7, 1_500_000, 5);
        vm.expectRevert(KeeperBackupUpkeep.ZeroAddress.selector);
        backup.setForwarder(address(0));
        vm.stopPrank();
    }

    function test_CheckRefusesARealTransaction() public {
        vm.prank(address(0xBEEF), address(0xBEEF));
        vm.expectRevert(KeeperBackupUpkeep.OnlySimulatedBackend.selector);
        backup.checkUpkeep("");
    }

    function test_ProbeAlwaysRevertsAndChangesNothing() public {
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true);
        vm.expectRevert(abi.encodeWithSelector(KeeperBackupUpkeep.ProbeResult.selector, true, uint256(0)));
        backup.probe(AUTO_DEDUCT, 11);
        assertTrue(diamond.due(diamond.autoDeductDaily.selector, 11));
        assertEq(diamond.runs(diamond.autoDeductDaily.selector, 11), 0);
        assertTrue(backup.isDue(AUTO_DEDUCT, 11));
        assertFalse(backup.isDue(AUTO_DEDUCT, 12));
    }

    // ── note, wait, run ──

    function test_NotesThenRunsOnlyAfterTheLag() public {
        _arm(AUTO_DEDUCT);
        diamond.setDue(diamond.autoDeductDaily.selector, 12, true);

        (bool needed, KeeperBackupUpkeep.Action[] memory a) = _check();
        assertTrue(needed);
        assertEq(a.length, 1);
        assertEq(uint8(a[0].mode), uint8(KeeperBackupUpkeep.Mode.Note));
        assertEq(a[0].arg, 12);
        _perform(a);
        assertEq(diamond.runs(diamond.autoDeductDaily.selector, 12), 0, "a note runs nothing");

        // Inside the lag: nothing to do.
        vm.warp(block.timestamp + 30 minutes);
        (needed,) = _check();
        assertFalse(needed);

        // Past the lag and still due: run.
        vm.warp(block.timestamp + 31 minutes);
        (needed, a) = _check();
        assertTrue(needed);
        assertEq(uint8(a[0].mode), uint8(KeeperBackupUpkeep.Mode.Run));
        vm.expectEmit(address(backup));
        emit KeeperBackupUpkeep.BackupStepRun(AUTO_DEDUCT, 12, true, bytes4(0));
        _perform(a);
        assertEq(diamond.runs(diamond.autoDeductDaily.selector, 12), 1);
        assertEq(backup.firstSeenAt(keccak256(abi.encode(AUTO_DEDUCT, uint256(12)))), 0);
    }

    function test_DoesNothingWhenTheKeeperRanItFirst() public {
        _arm(AUTO_DEDUCT);
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true);
        (, KeeperBackupUpkeep.Action[] memory a) = _check();
        _perform(a);
        diamond.setDue(diamond.autoDeductDaily.selector, 11, false); // our keeper ran it
        vm.warp(block.timestamp + 61 minutes);
        (bool needed,) = _check();
        assertFalse(needed);
    }

    function test_AStaleNoteStartsTheWaitAgain() public {
        _arm(AUTO_DEDUCT);
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true);
        (, KeeperBackupUpkeep.Action[] memory a) = _check();
        _perform(a);
        diamond.setDue(diamond.autoDeductDaily.selector, 11, false);
        // Past the run window: the old note no longer counts.
        vm.warp(block.timestamp + 2 hours + 1);
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true); // due again, a day later
        (bool needed, KeeperBackupUpkeep.Action[] memory b) = _check();
        assertTrue(needed);
        assertEq(uint8(b[0].mode), uint8(KeeperBackupUpkeep.Mode.Note));
    }

    function test_ARevertingRunIsRecordedWithItsSelector() public {
        _arm(AUTO_DEDUCT);
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true);
        (, KeeperBackupUpkeep.Action[] memory a) = _check();
        _perform(a);
        vm.warp(block.timestamp + 61 minutes);
        (, a) = _check();
        diamond.setDue(diamond.autoDeductDaily.selector, 11, false); // ran between check and perform
        vm.expectEmit(address(backup));
        emit KeeperBackupUpkeep.BackupStepRun(AUTO_DEDUCT, 11, false, MockBackupDiamond.NotDue.selector);
        _perform(a);
    }

    // ── perform's own checks ──

    function test_PerformAcceptsOnlyTheForwarder() public {
        KeeperBackupUpkeep.Action[] memory a = _one(KeeperBackupUpkeep.Mode.Note, AUTO_DEDUCT, 11);
        vm.expectRevert(abi.encodeWithSelector(KeeperBackupUpkeep.OnlyForwarder.selector, address(this)));
        backup.performUpkeep(abi.encode(a));
    }

    function test_PerformRunsNothingWithoutAReadyNoteOrWhileDisarmed() public {
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true);
        // Disarmed: even a note is skipped.
        _perform(_one(KeeperBackupUpkeep.Mode.Note, AUTO_DEDUCT, 11));
        assertEq(backup.firstSeenAt(keccak256(abi.encode(AUTO_DEDUCT, uint256(11)))), 0);
        // Armed, but a Run with no note behind it is skipped.
        _arm(AUTO_DEDUCT);
        _perform(_one(KeeperBackupUpkeep.Mode.Run, AUTO_DEDUCT, 11));
        assertEq(diamond.runs(diamond.autoDeductDaily.selector, 11), 0);
        vm.expectRevert(abi.encodeWithSelector(KeeperBackupUpkeep.UnknownStep.selector, uint8(14)));
        _perform(_one(KeeperBackupUpkeep.Mode.Note, 14, 11));
    }

    function test_RunsPerPerformCapsTheRuns() public {
        _arm(AUTO_DEDUCT);
        for (uint256 id = 11; id <= 13; id++) diamond.setDue(diamond.autoDeductDaily.selector, id, true);
        (, KeeperBackupUpkeep.Action[] memory a) = _check();
        assertEq(a.length, 3);
        _perform(a);
        vm.warp(block.timestamp + 61 minutes);
        (, a) = _check();
        assertEq(a.length, 2, "two runs per perform by default");
        _perform(a);
        assertEq(diamond.runs(diamond.autoDeductDaily.selector, 11), 1);
        assertEq(diamond.runs(diamond.autoDeductDaily.selector, 12), 1);
        assertEq(diamond.runs(diamond.autoDeductDaily.selector, 13), 0);
    }

    // ── step shapes ──

    function test_DefaultTakesTheNoSaleRouteAndAPaidBonusGoesToTheTreasury() public {
        ERC20Mock token = new ERC20Mock("Bonus", "BON", 18);
        diamond.setBonus(token, 5e18);
        _arm(DEFAULT_NO_SALE);
        diamond.setDue(diamond.triggerDefault.selector, 13, true);
        (, KeeperBackupUpkeep.Action[] memory a) = _check();
        _perform(a);
        vm.warp(block.timestamp + 61 minutes);
        (, a) = _check();
        _perform(a);
        assertEq(diamond.lastSellAmount(), 0);
        assertEq(diamond.lastAdapterCount(), 0);
        assertEq(token.balanceOf(address(backup)), 5e18);
        vm.prank(makeAddr("anyone"));
        backup.sweep(address(token));
        assertEq(token.balanceOf(treasury), 5e18);
        assertEq(token.balanceOf(address(backup)), 0);
    }

    function test_DaysIncludeDayZeroAndStopAtTheWindow() public {
        _arm(CLOSE_DAY);
        diamond.setDay(1, true);
        diamond.setDue(diamond.closeDay.selector, 0, true);
        (bool needed, KeeperBackupUpkeep.Action[] memory a) = _check();
        assertTrue(needed);
        assertEq(a[0].step, CLOSE_DAY);
        assertEq(a[0].arg, 0);

        // Day 2 is outside a 7-day window seen from day 10.
        diamond.setDay(10, true);
        diamond.setDue(diamond.closeDay.selector, 0, false);
        diamond.setDue(diamond.closeDay.selector, 2, true);
        (needed,) = _check();
        assertFalse(needed);
        diamond.setDue(diamond.closeDay.selector, 3, true);
        (needed, a) = _check();
        assertTrue(needed);
        assertEq(a[0].arg, 3);

        // Before launch nothing is a day.
        diamond.setDay(0, false);
        (needed,) = _check();
        assertFalse(needed);
    }

    function test_RecycleIsDueOnlyWhileSomethingIsLeft() public {
        _arm(RECYCLE);
        diamond.setDay(5, true);
        (bool needed,) = _check();
        assertFalse(needed, "a zero recycle is not due");
        diamond.setRecyclable(4, 1e18);
        KeeperBackupUpkeep.Action[] memory a;
        (needed, a) = _check();
        assertTrue(needed);
        assertEq(a[0].arg, 4);
    }

    function test_TeardownIsReachedFromAnActiveOffersLinkedLoan() public {
        _arm(TEARDOWN);
        diamond.setLoans(new uint256[](0));
        uint256[] memory offers = new uint256[](2);
        offers[0] = 70;
        offers[1] = 71;
        diamond.setOffers(offers);
        diamond.setLinked(71, 99);
        diamond.setDue(diamond.teardownStaleSaleListing.selector, 99, true);
        (bool needed, KeeperBackupUpkeep.Action[] memory a) = _check();
        assertTrue(needed);
        assertEq(a.length, 1);
        assertEq(a[0].arg, 99);
    }

    function test_BeaconStepsCallTheBeacon() public {
        _arm(BEACON_CURRENT);
        beacon.setCurrentDue(true);
        (, KeeperBackupUpkeep.Action[] memory a) = _check();
        assertEq(a[0].step, BEACON_CURRENT);
        _perform(a);
        vm.warp(block.timestamp + 61 minutes);
        (, a) = _check();
        _perform(a);
        assertEq(beacon.currentRuns(), 1);
    }

    function test_TheLoanWindowRotates() public {
        vm.prank(owner);
        backup.setScan(1, 7, 1_500_000, 2);
        _arm(AUTO_DEDUCT);
        diamond.setDue(diamond.autoDeductDaily.selector, 13, true);
        // One loan per check; the window moves every 5 minutes.
        bool seen;
        for (uint256 i; i < 3; i++) {
            (bool needed, KeeperBackupUpkeep.Action[] memory a) = _check();
            if (needed && a[0].arg == 13) seen = true;
            vm.warp(block.timestamp + 5 minutes);
        }
        assertTrue(seen);
    }
}
