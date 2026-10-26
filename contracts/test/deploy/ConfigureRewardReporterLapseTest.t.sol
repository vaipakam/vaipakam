// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ConfigureRewardReporter} from "../../script/ConfigureRewardReporter.s.sol";

/// @dev Stand-in for the three `RewardCommitmentFacet` lapse-schedule entry
///      points the configure step reads and writes: an append-only list of
///      versions, version 0 meaning "none set".
contract LapseScheduleStub {
    uint64[] internal windows;
    uint64[] internal gaps;
    uint256 public setCalls;

    function getCurrentLapseScheduleVersion() external view returns (uint32) {
        return uint32(windows.length);
    }

    function getLapseSchedule(uint32 version) external view returns (uint64, uint64) {
        if (version == 0) return (0, 0);
        return (windows[version - 1], gaps[version - 1]);
    }

    function setLapseSchedule(uint64 window, uint64 gap) external {
        windows.push(window);
        gaps.push(gap);
        ++setCalls;
    }
}

/// @dev Exposes the internal helper under test.
contract ConfigureRewardReporterHarness is ConfigureRewardReporter {
    function applyLapseSchedule(address diamond, uint64 window, uint64 gap) external {
        _applyLapseSchedule(diamond, window, gap);
    }
}

/// @title  ConfigureRewardReporterLapseTest
/// @notice #2909 — the configure step makes `(window, gap)` the schedule in
///         force, and mints a new version only when the one in force
///         differs. Versions are append-only and every finalized day keeps
///         the version it froze, so a rerun of configure with the same
///         values must leave the version history untouched.
contract ConfigureRewardReporterLapseTest is Test {
    LapseScheduleStub internal stub;
    ConfigureRewardReporterHarness internal harness;

    function setUp() public {
        stub = new LapseScheduleStub();
        harness = new ConfigureRewardReporterHarness();
    }

    function test_SetsVersionOneWhenNoneIsInForce() public {
        harness.applyLapseSchedule(address(stub), 7 days, 24 hours);
        assertEq(stub.getCurrentLapseScheduleVersion(), 1);
        (uint64 w, uint64 g) = stub.getLapseSchedule(1);
        assertEq(w, 7 days);
        assertEq(g, 24 hours);
    }

    function test_RerunWithSameValuesMintsNoVersion() public {
        harness.applyLapseSchedule(address(stub), 7 days, 24 hours);
        harness.applyLapseSchedule(address(stub), 7 days, 24 hours);
        assertEq(stub.setCalls(), 1, "the second run is a no-op");
        assertEq(stub.getCurrentLapseScheduleVersion(), 1);
    }

    function test_ChangedValuesMintTheNextVersion() public {
        harness.applyLapseSchedule(address(stub), 7 days, 24 hours);
        harness.applyLapseSchedule(address(stub), 3 days, 6 hours);
        assertEq(stub.setCalls(), 2);
        assertEq(stub.getCurrentLapseScheduleVersion(), 2);
        (uint64 w, uint64 g) = stub.getLapseSchedule(2);
        assertEq(w, 3 days);
        assertEq(g, 6 hours);
    }

    /// @dev Only the gap differs: still a change, still a new version.
    function test_ChangedGapAloneMintsTheNextVersion() public {
        harness.applyLapseSchedule(address(stub), 7 days, 24 hours);
        harness.applyLapseSchedule(address(stub), 7 days, 12 hours);
        assertEq(stub.getCurrentLapseScheduleVersion(), 2);
    }
}
