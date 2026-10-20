// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SanctionsList} from "../../src/compliance/SanctionsList.sol";
import {SanctionsDelistingTimelock} from "../../src/compliance/SanctionsDelistingTimelock.sol";
import {TestnetSanctionsOracleStandIn} from "../../src/compliance/TestnetSanctionsOracleStandIn.sol";
import {SanctionsClearanceReport} from "../../script/lib/SanctionsClearanceReport.sol";

/// @dev Answers every call with nothing.
contract ReportSilentOracle {
    fallback() external {}
}

/// @dev Answers every call with the word 2: not a bool, so not a yes.
contract ReportTwoOracle {
    fallback() external {
        assembly {
            mstore(0, 2)
            return(0, 32)
        }
    }
}

/// @dev Says outright that it is not the stand-in.
contract ReportNotAStandIn {
    function isTestnetStandIn() external pure returns (bool) {
        return false;
    }
}

/// @dev Exposes the library.
contract ReportHarness {
    function isStandIn(address oracle) external view returns (bool) {
        return SanctionsClearanceReport.isStandIn(oracle);
    }

    function logRoute(SanctionsDelistingTimelock tl) external view returns (SanctionsDelistingTimelock.Route) {
        return SanctionsClearanceReport.logRoute(tl);
    }

    function logAutomation(SanctionsDelistingTimelock tl) external view returns (bool) {
        return SanctionsClearanceReport.logAutomation(tl, tl.clearanceRoute());
    }
}

/**
 * @title  SanctionsClearanceReportTest
 * @notice #2443 — how the sanctions scripts name a clearance oracle: the
 *         stand-in only on the contract's own `true`, anything else not
 *         identified, and no answer — however malformed — stops the run.
 */
contract SanctionsClearanceReportTest is Test {
    address internal admin = makeAddr("admin");
    ReportHarness internal h;

    function setUp() public {
        vm.chainId(84532);
        h = new ReportHarness();
    }

    function test_TheStandInOnlyOnItsOwnTrue() public {
        assertTrue(h.isStandIn(address(new TestnetSanctionsOracleStandIn(admin))));
        assertFalse(h.isStandIn(address(new ReportNotAStandIn())), "an explicit false");
        assertFalse(h.isStandIn(address(new ReportSilentOracle())), "an empty answer");
        assertFalse(h.isStandIn(address(new ReportTwoOracle())), "a word that is not a bool");
        assertFalse(h.isStandIn(address(h)), "no such function");
        assertFalse(h.isStandIn(makeAddr("no code")), "no contract");
    }

    /// @dev The report reads the route and names whatever local oracle it
    ///      finds without reverting, whatever that oracle answers.
    function test_TheRouteReportNeverStopsOnAnOraclesAnswer() public {
        address[3] memory secondaries = [
            address(new TestnetSanctionsOracleStandIn(admin)),
            address(new ReportSilentOracle()),
            address(new ReportTwoOracle())
        ];
        for (uint256 i; i < secondaries.length; ++i) {
            SanctionsList list = new SanctionsList(admin, secondaries[i]);
            SanctionsDelistingTimelock tl = new SanctionsDelistingTimelock(admin, list);
            assertEq(uint8(h.logRoute(tl)), uint8(SanctionsDelistingTimelock.Route.Local));
        }
        SanctionsDelistingTimelock none = new SanctionsDelistingTimelock(admin, new SanctionsList(admin, address(0)));
        assertEq(uint8(h.logRoute(none)), uint8(SanctionsDelistingTimelock.Route.Unavailable));
    }

    /// @dev Open only while the timelock is a remover of its list AND has a
    ///      clearance check: revoking the role is the owner's one-step
    ///      shutdown, and no wired check reopens it.
    function test_AutomationIsOpenOnlyWithTheRemoverRoleAndACheck() public {
        SanctionsList list = new SanctionsList(admin, address(new TestnetSanctionsOracleStandIn(admin)));
        SanctionsDelistingTimelock tl = new SanctionsDelistingTimelock(admin, list);
        assertFalse(h.logAutomation(tl), "a check but no remover role: closed");
        vm.prank(admin);
        list.setRemover(address(tl), true);
        assertTrue(h.logAutomation(tl), "the role and a check: open");
        vm.prank(admin);
        list.setRemover(address(tl), false);
        assertFalse(h.logAutomation(tl), "revoked: closed again");

        SanctionsList bare = new SanctionsList(admin, address(0));
        SanctionsDelistingTimelock unwired = new SanctionsDelistingTimelock(admin, bare);
        vm.prank(admin);
        bare.setRemover(address(unwired), true);
        assertFalse(h.logAutomation(unwired), "the role but no check: closed");
    }
}
