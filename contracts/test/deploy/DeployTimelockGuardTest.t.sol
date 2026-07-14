// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DeployTimelock} from "../../script/DeployTimelock.s.sol";

/// @title DeployTimelockGuardTest
/// @notice #1195 F4 (Pass-2 hardening) — `DeployTimelock.run()` must refuse a
///         sub-48h `TIMELOCK_MIN_DELAY` on a Phase-1 mainnet, so a governance
///         timelock can't be floored to the 1h dev minimum with no gate.
contract DeployTimelockGuardTest is Test {
    /// @dev On a Phase-1 mainnet chain id, a 1h min delay passes the >=1h floor
    ///      but must trip the >=48h mainnet gate.
    function testMainnetMinDelayBelow48hReverts() public {
        DeployTimelock s = new DeployTimelock();
        // run() reads these unconditionally before the gate.
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "0x1");
        vm.setEnv("TIMELOCK_PROPOSER", "0x000000000000000000000000000000000000dEaD");
        vm.setEnv("TIMELOCK_MIN_DELAY", "3600"); // 1h: clears >=1h, fails >=48h mainnet gate

        vm.chainId(1); // Ethereum mainnet → 48h gate active
        vm.expectRevert(bytes("DeployTimelock: mainnet min delay < 48h"));
        s.run();
    }
}
