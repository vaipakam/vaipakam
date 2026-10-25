// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DeployTimelock} from "../../script/DeployTimelock.s.sol";

/// @title DeployTimelockGuardTest
/// @notice #1195 F4 (Pass-2 hardening) — `DeployTimelock` must refuse a
///         sub-48h minimum delay on a Phase-1 mainnet, so a governance
///         timelock can't be floored to the 1h dev minimum with no gate.
/// @dev    Every test passes its inputs to `runWith` as a `Config` and never
///         touches the process environment (#2716). `vm.setEnv` writes one
///         environment shared by every test thread, and forge runs tests in
///         parallel, so env-driven cases read each other's values and failed
///         depending on what else was running.
contract DeployTimelockGuardTest is Test {
    address internal constant GOVERNANCE_SAFE = 0x000000000000000000000000000000000000dEaD;
    address internal constant OTHER_SAFE = 0x000000000000000000000000000000000000bEEF;
    address internal constant PAUSER_SAFE = 0x000000000000000000000000000000000000cafE;

    /// @dev A config every guard accepts on a known testnet; each test
    ///      changes only the input it is about.
    function _config() internal pure returns (DeployTimelock.Config memory c) {
        c.deployerKey = 0x1;
        c.minDelay = 172800;
        c.proposer = GOVERNANCE_SAFE;
        c.executor = address(0);
        c.canceller = PAUSER_SAFE;
        c.revoker = GOVERNANCE_SAFE;
    }

    /// @dev On a Phase-1 mainnet chain id, a 1h min delay passes the >=1h floor
    ///      but must trip the >=48h mainnet gate.
    function testMainnetMinDelayBelow48hReverts() public {
        DeployTimelock s = new DeployTimelock();
        DeployTimelock.Config memory c = _config();
        c.minDelay = 3600; // 1h: clears >=1h, fails >=48h mainnet gate

        vm.chainId(1); // Ethereum mainnet → 48h gate active
        vm.expectRevert(bytes("DeployTimelock: mainnet min delay < 48h"));
        s.runWith(c);
    }

    /// @dev The proposer and the emergency revoker are one Governance Safe;
    ///      a different TIMELOCK_PROPOSER is refused before anything deploys
    ///      (Codex #2642 r3).
    function testProposerMustBeTheRevokerSafe() public {
        DeployTimelock s = new DeployTimelock();
        DeployTimelock.Config memory c = _config();
        c.revoker = OTHER_SAFE;
        vm.expectRevert(
            bytes("DeployTimelock: TIMELOCK_PROPOSER must equal EMERGENCY_REVOKER_ADDRESS (one Governance Safe)")
        );
        s.runWith(c);
    }

    /// @dev The canceller (the Pauser Safe) is required on testnets too: the
    ///      handover refuses a Timelock without it on every chain, so the
    ///      deploy must not record one it could never hand over to
    ///      (Codex #2642 r6).
    function testCancellerRequiredOnTestnet() public {
        DeployTimelock s = new DeployTimelock();
        DeployTimelock.Config memory c = _config();
        c.minDelay = 3600;
        c.canceller = address(0);
        vm.chainId(84532); // Base Sepolia: a known testnet
        vm.expectRevert(bytes("DeployTimelock: PAUSER_ADDRESS (the canceller) required"));
        s.runWith(c);
    }
}
