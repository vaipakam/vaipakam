// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title DeployTimelock
 * @notice Deploys an OpenZeppelin `TimelockController` that will sit between
 *         the multi-sig (proposer) and the Vaipakam Diamond privileged roles
 *         (ADMIN_ROLE, DEFAULT_ADMIN_ROLE, and LibDiamond owner).
 *
 * @dev Ownership transfer is NOT performed here — run
 *      `TransferAdminToTimelock` after this script once the timelock is live
 *      and the multi-sig is comfortable with the proposer/executor wiring.
 *      Keeping the two phases separate lets the deployer EOA reclaim control
 *      cheaply if the multi-sig setup is wrong (before the handover is made).
 *
 *      Default min delay: 48 hours (172800 s). Rationale: long enough for
 *      users to observe a scheduled parameter change on Tenderly / the
 *      subgraph and exit positions if the change is hostile, short enough
 *      that legitimate ops (fee tweaks, 0x proxy rotation) aren't intolerable.
 *
 *      Roles:
 *        - PROPOSER_ROLE : multi-sig (Gnosis Safe) that schedules + cancels
 *        - EXECUTOR_ROLE : same multi-sig OR address(0) for "anyone can
 *                          execute once the delay has elapsed" (reduces the
 *                          chance a malicious multi-sig stalls a benign op)
 *        - DEFAULT_ADMIN : address(0) — the timelock is self-administered,
 *                          i.e. changing the delay or adding proposers also
 *                          goes through the timelock
 *
 *      Required env vars:
 *        - PRIVATE_KEY           : deployer key (any funded EOA)
 *        - TIMELOCK_MIN_DELAY    : optional, defaults to 172800 (48h)
 *        - TIMELOCK_PROPOSER     : proposer/canceller (multi-sig address)
 *        - TIMELOCK_EXECUTOR     : optional, defaults to address(0) = open
 */
contract DeployTimelock is Script {
    uint256 internal constant DEFAULT_MIN_DELAY = 48 hours;

    function run() external returns (address timelock) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 minDelay = vm.envOr("TIMELOCK_MIN_DELAY", DEFAULT_MIN_DELAY);
        address proposer = vm.envAddress("TIMELOCK_PROPOSER");
        address executor = vm.envOr("TIMELOCK_EXECUTOR", address(0));

        require(proposer != address(0), "DeployTimelock: proposer required");
        require(minDelay >= 1 hours, "DeployTimelock: min delay < 1h");

        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor; // address(0) -> anyone can execute

        console.log("=== Deploy TimelockController ===");
        console.log("Chain id:       ", block.chainid);
        console.log("Min delay (s):  ", minDelay);
        console.log("Proposer:       ", proposer);
        console.log("Executor:       ", executor);

        vm.startBroadcast(deployerKey);
        TimelockController tl = new TimelockController(
            minDelay,
            proposers,
            executors,
            address(0) // self-administered — no EOA admin backdoor
        );
        vm.stopBroadcast();

        timelock = address(tl);
        console.log("Timelock:       ", timelock);
        console.log("Record this address in <CHAIN>_TIMELOCK_ADDRESS before running TransferAdminToTimelock.");
    }
}
