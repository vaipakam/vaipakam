// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {TestnetSanctionsOracleStandIn} from "../../src/compliance/TestnetSanctionsOracleStandIn.sol";
import {ConfigureSanctionsClearance} from "../../script/ConfigureSanctionsClearance.s.sol";

/// @dev Exposes the script's reuse rule for the stand-in.
contract ConfigureSanctionsClearanceHarness is ConfigureSanctionsClearance {
    function reusableStandIn(address candidate, address admin) external view returns (bool) {
        return _reusableStandIn(candidate, admin);
    }
}

/**
 * @title  ConfigureSanctionsClearanceTest
 * @notice #2443 — the parts of `ConfigureSanctionsClearance` that need no
 *         live CCIP lane: it refuses a mainnet before reading anything, and it
 *         reuses a recorded stand-in only while the admin alone controls it.
 *         An attestor binds its oracle for good, so a stand-in with a pending
 *         ownership transfer, or another owner, must never be bound. The
 *         wiring itself is proven against the live testnets by
 *         `SanctionsClearanceLiveForkTest`.
 */
contract ConfigureSanctionsClearanceTest is Test {
    address internal admin = makeAddr("admin");
    address internal other = makeAddr("other");
    ConfigureSanctionsClearanceHarness internal script;
    TestnetSanctionsOracleStandIn internal standIn;

    function setUp() public {
        vm.chainId(97);
        script = new ConfigureSanctionsClearanceHarness();
        standIn = new TestnetSanctionsOracleStandIn(admin);
    }

    function test_ReusesAStandInOnlyTheAdminControls() public {
        assertTrue(script.reusableStandIn(address(standIn), admin), "the admin's own stand-in is reused");
        assertFalse(script.reusableStandIn(address(standIn), other), "never one another account owns");

        vm.prank(admin);
        standIn.transferOwnership(other);
        assertFalse(script.reusableStandIn(address(standIn), admin), "not while a transfer is pending");

        vm.prank(other);
        standIn.acceptOwnership();
        assertFalse(script.reusableStandIn(address(standIn), admin), "not once another account owns it");
    }

    function test_RefusesAContractThatIsNotAStandIn() public view {
        // A contract with code but no stand-in marker (the script itself).
        assertFalse(script.reusableStandIn(address(script), admin));
    }

    function test_RefusesEveryMainnetBeforeReadingAnything() public {
        uint256[] memory timelocks = new uint256[](1);
        timelocks[0] = 8453;
        uint256[4] memory mainnets = [uint256(1), 8453, 42161, 56];
        for (uint256 i; i < mainnets.length; ++i) {
            vm.chainId(mainnets[i]);
            vm.expectRevert(
                bytes(
                    "ConfigureSanctionsClearance: mainnet refused - it deploys a testnet stand-in for RedStone; a mainnet clearance route reads RedStone itself, which waits on RedStone's terms (#2443)"
                )
            );
            script.runWith(admin, admin, 56, timelocks);
        }
    }
}
