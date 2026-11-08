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
    mapping(bytes4 => mapping(uint256 => bool)) public burn;
    uint256 public sink;
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

    /// @dev A step that spends every unit of gas it is given, like a close
    ///      whose frontier is far behind.
    function setBurn(bytes4 sel, uint256 arg, bool b) external {
        burn[sel][arg] = b;
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
        if (burn[msg.sig][arg]) {
            while (true) sink++;
        }
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
        // Read first: a prank applies to the next call, and the read is one.
        uint256 mask = backup.enabledSteps() | (uint256(1) << step);
        vm.prank(owner);
        backup.setEnabledSteps(mask);
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
        assertEq(backup.firstSeenAt(AUTO_DEDUCT, 12), 0);
    }

    function test_DoesNothingWhenTheKeeperRanItFirst() public {
        _arm(AUTO_DEDUCT);
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true);
        (, KeeperBackupUpkeep.Action[] memory a) = _check();
        _perform(a);
        diamond.setDue(diamond.autoDeductDaily.selector, 11, false); // our keeper ran it
        vm.warp(block.timestamp + 61 minutes);
        (bool needed, KeeperBackupUpkeep.Action[] memory b) = _check();
        assertTrue(needed);
        assertEq(b.length, 1);
        assertEq(uint8(b[0].mode), uint8(KeeperBackupUpkeep.Mode.Drop));
        vm.expectEmit(address(backup));
        emit KeeperBackupUpkeep.BackupNoteDropped(AUTO_DEDUCT, 11);
        _perform(b);
        assertEq(diamond.runs(diamond.autoDeductDaily.selector, 11), 0);
        assertEq(backup.pendingCandidates().length, 0);
        (needed,) = _check();
        assertFalse(needed);
    }

    function test_ADropOfAStillDueNoteIsRefused() public {
        _arm(AUTO_DEDUCT);
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true);
        (, KeeperBackupUpkeep.Action[] memory a) = _check();
        _perform(a);
        // Waiting and still due: a drop is refused.
        _perform(_one(KeeperBackupUpkeep.Mode.Drop, AUTO_DEDUCT, 11));
        assertEq(backup.pendingCandidates().length, 1);
        // Ready and still due: a drop is refused too.
        vm.warp(block.timestamp + 61 minutes);
        _perform(_one(KeeperBackupUpkeep.Mode.Drop, AUTO_DEDUCT, 11));
        assertEq(backup.pendingCandidates().length, 1);
    }

    function test_ANoteForADisarmedStepIsDropped() public {
        _arm(AUTO_DEDUCT);
        _arm(CLOSE_DAY); // keep the mask non-zero after disarming
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true);
        (, KeeperBackupUpkeep.Action[] memory a) = _check();
        _perform(a);
        vm.prank(owner);
        backup.setEnabledSteps(uint256(1) << CLOSE_DAY);
        (bool needed, KeeperBackupUpkeep.Action[] memory b) = _check();
        assertTrue(needed);
        assertEq(uint8(b[0].mode), uint8(KeeperBackupUpkeep.Mode.Drop));
        _perform(b);
        assertEq(backup.pendingCandidates().length, 0);
    }

    function test_ANotedCandidateIsRevisitedAfterTheWindowMovesOn() public {
        vm.prank(owner);
        backup.setScan(1, 7, 1_500_000, 2);
        _arm(AUTO_DEDUCT);
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true);
        diamond.setDue(diamond.autoDeductDaily.selector, 12, true);
        diamond.setDue(diamond.autoDeductDaily.selector, 13, true);
        // Note whichever loan the window shows now.
        (, KeeperBackupUpkeep.Action[] memory a) = _check();
        assertEq(a.length, 1);
        uint256 noted = a[0].arg;
        _perform(a);
        // 61 minutes on, the one-loan window has rotated many times, but the
        // queue is visited first, so the noted loan runs.
        uint256 t = block.timestamp + 61 minutes;
        vm.warp(t);
        (, KeeperBackupUpkeep.Action[] memory b) = _check();
        bool run;
        for (uint256 i; i < b.length; i++) {
            if (b[i].mode == KeeperBackupUpkeep.Mode.Run) {
                assertEq(b[i].arg, noted);
                run = true;
            }
        }
        assertTrue(run, "the noted loan runs");
        _perform(b);
        assertEq(diamond.runs(diamond.autoDeductDaily.selector, noted), 1);
    }

    function test_AWaitingNoteIsDroppedOnceTheKeeperRunsIt() public {
        _arm(AUTO_DEDUCT);
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true);
        (, KeeperBackupUpkeep.Action[] memory a) = _check();
        _perform(a);
        // Our keeper runs it a minute later, well inside the wait.
        diamond.setDue(diamond.autoDeductDaily.selector, 11, false);
        uint256 t = block.timestamp + 1 minutes;
        vm.warp(t);
        (bool needed, KeeperBackupUpkeep.Action[] memory b) = _check();
        assertTrue(needed);
        assertEq(b.length, 1);
        assertEq(uint8(b[0].mode), uint8(KeeperBackupUpkeep.Mode.Drop));
        _perform(b);
        assertEq(backup.pendingCandidates().length, 0);
        // The next occurrence starts a wait of its own instead of running on
        // the old note's time.
        t += 60 minutes;
        vm.warp(t);
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true);
        (, b) = _check();
        assertEq(b.length, 1);
        assertEq(uint8(b[0].mode), uint8(KeeperBackupUpkeep.Mode.Note));
        _perform(b);
        assertEq(backup.firstSeenAt(AUTO_DEDUCT, 11), uint64(t));
        assertEq(diamond.runs(diamond.autoDeductDaily.selector, 11), 0);
    }

    function test_ACostlyPartCannotStarveTheOthers() public {
        _arm(CLOSE_DAY);
        _arm(AUTO_DEDUCT);
        diamond.setDay(10, true);
        // Every recent day's close spends its whole probe allowance.
        for (uint256 d = 3; d <= 9; d++) {
            diamond.setBurn(diamond.closeDay.selector, d, true);
        }
        diamond.setDue(diamond.autoDeductDaily.selector, 11, true);
        bool found;
        for (uint256 b = 1; b <= 6; b++) {
            vm.roll(b);
            vm.prank(address(0xBEEF), SIM);
            (bool needed, bytes memory data) = backup.checkUpkeep{gas: 5_000_000}("");
            if (!needed) continue;
            KeeperBackupUpkeep.Action[] memory a = abi.decode(data, (KeeperBackupUpkeep.Action[]));
            for (uint256 i; i < a.length; i++) {
                if (a[i].step == AUTO_DEDUCT && a[i].arg == 11) found = true;
            }
        }
        assertTrue(found, "the loan is found while the recent days burn their gas");
    }

    function test_CostlyLoansCannotHideTheLaterOnesInTheirPage() public {
        _arm(DEFAULT_NO_SALE);
        _arm(uint8(KeeperBackupUpkeep.Step.PeriodicStampWithoutSale));
        // Every loan's default spends its whole probe allowance; the one due
        // step is the last loan's periodic stamp, after all three in the page.
        for (uint256 id = 11; id <= 13; id++) diamond.setBurn(diamond.triggerDefault.selector, id, true);
        diamond.setDue(diamond.settlePeriodicInterest.selector, 13, true);
        bool found;
        for (uint256 b = 1; b <= 42 && !found; b++) {
            vm.roll(b);
            vm.prank(address(0xBEEF), SIM);
            (bool needed, bytes memory data) = backup.checkUpkeep{gas: 5_000_000}("");
            if (!needed) continue;
            KeeperBackupUpkeep.Action[] memory a = abi.decode(data, (KeeperBackupUpkeep.Action[]));
            for (uint256 i; i < a.length; i++) {
                if (a[i].arg == 13 && a[i].step == uint8(KeeperBackupUpkeep.Step.PeriodicStampWithoutSale)) found = true;
            }
        }
        assertTrue(found, "the stamp is found while the defaults before it burn their gas");
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
        assertEq(backup.firstSeenAt(AUTO_DEDUCT, 11), 0);
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
        // Which two run depends on where the queue walk starts this block.
        assertEq(_autoDeductRuns(), 2);
        // The third runs on the next perform.
        (, a) = _check();
        assertEq(a.length, 1);
        _perform(a);
        assertEq(_autoDeductRuns(), 3);
    }

    function _autoDeductRuns() internal view returns (uint256 total) {
        for (uint256 id = 11; id <= 13; id++) {
            uint256 r = diamond.runs(diamond.autoDeductDaily.selector, id);
            assertLe(r, 1);
            total += r;
        }
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

        // From day 10 the recent window is days 9..3; day 3 is found at once.
        diamond.setDay(10, true);
        diamond.setDue(diamond.closeDay.selector, 0, false);
        diamond.setDue(diamond.closeDay.selector, 3, true);
        (needed, a) = _check();
        assertTrue(needed);
        assertEq(a[0].arg, 3);
        diamond.setDue(diamond.closeDay.selector, 3, false);

        // An old day (a lapse opens weeks after its day) is reached by the
        // rotating history window: from day 40 the older days are 0..32.
        diamond.setDay(40, true);
        diamond.setDue(diamond.closeDay.selector, 2, true);
        bool seen;
        uint256 t = block.timestamp;
        for (uint256 i; i < 5; i++) {
            (needed, a) = _check();
            if (needed && a[0].arg == 2) seen = true;
            t += 5 minutes;
            vm.warp(t);
        }
        assertTrue(seen, "day 2 reached by the history window");

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
        // A local clock: under via-IR `block.timestamp` read in a loop can stay
        // at its first value after `vm.warp`.
        uint256 t = block.timestamp;
        for (uint256 i; i < 3; i++) {
            (bool needed, KeeperBackupUpkeep.Action[] memory a) = _check();
            if (needed && a[0].arg == 13) seen = true;
            t += 5 minutes;
            vm.warp(t);
        }
        assertTrue(seen);
    }
}
