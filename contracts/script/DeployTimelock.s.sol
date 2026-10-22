// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {VaipakamTimelock} from "../src/governance/VaipakamTimelock.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title DeployTimelock
 * @notice Deploys an OpenZeppelin `TimelockController` that will sit between
 *         the multi-sig (proposer) and the Vaipakam Diamond privileged roles
 *         (ADMIN_ROLE, DEFAULT_ADMIN_ROLE, and LibDiamond owner).
 *
 * @dev Ownership transfer is NOT performed here — the deploy pipeline's
 *      `--phase handover` (`Handover.s.sol`) does it once the timelock is
 *      live and the multi-sig is comfortable with the proposer/executor
 *      wiring.
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
 *        - CANCELLER_ROLE: the proposer (OZ grants it) PLUS an independent
 *                          canceller — the Pauser Safe — so a queued
 *                          operation has a veto party other than the Safe
 *                          that queued it (#938). Required on every
 *                          chain: `Handover.s.sol` refuses a Timelock
 *                          whose Pauser Safe lacks CANCELLER_ROLE, so a
 *                          canceller-free Timelock could never be handed
 *                          the Diamond (Codex #2642 r6).
 *        - DEFAULT_ADMIN : none — `VaipakamTimelock` is self-administered
 *                          by construction, i.e. changing the delay or
 *                          adding proposers also goes through the timelock.
 *                          The delay can never drop below the deploy-time
 *                          value (`MIN_DELAY_FLOOR`, #938).
 *
 *      Required env vars:
 *        - DEPLOYER_PRIVATE_KEY           : deployer key (any funded EOA)
 *        - TIMELOCK_MIN_DELAY    : optional, defaults to 172800 (48h)
 *        - TIMELOCK_PROPOSER     : proposer/canceller (multi-sig address)
 *        - TIMELOCK_EXECUTOR     : optional, defaults to address(0) = open
 *        - PAUSER_ADDRESS        : the Pauser Safe. It becomes the
 *                                  Timelock's independent canceller
 *                                  (#938): it can veto a queued operation
 *                                  but not propose one. Required on every
 *                                  chain, must differ from the proposer,
 *                                  and must be a deployed contract on any
 *                                  chain that is not a known testnet.
 *                                  There is deliberately no separate
 *                                  canceller variable: one address names
 *                                  the Pauser Safe for both this script and
 *                                  `Handover.s.sol`, so the veto cannot be
 *                                  given to anything else by a typo, and
 *                                  the handover re-checks that the Timelock
 *                                  it hands the Diamond to has it.
 */
contract DeployTimelock is Script {
    uint256 internal constant DEFAULT_MIN_DELAY = 48 hours;

    function run() external returns (address timelock) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 minDelay = vm.envOr("TIMELOCK_MIN_DELAY", DEFAULT_MIN_DELAY);
        address proposer = vm.envAddress("TIMELOCK_PROPOSER");
        address executor = vm.envOr("TIMELOCK_EXECUTOR", address(0));
        // The canceller IS the Pauser Safe — read from the same variable
        // `Handover.s.sol` grants PAUSER_ROLE from, never from a separate
        // one (Codex #2642 r1).
        address canceller = vm.envOr("PAUSER_ADDRESS", address(0));
        require(
            vm.envOr("TIMELOCK_CANCELLER", address(0)) == address(0),
            "DeployTimelock: TIMELOCK_CANCELLER is retired - the canceller is PAUSER_ADDRESS; unset it"
        );

        require(proposer != address(0), "DeployTimelock: proposer required");
        // The proposer is the Governance Safe, which Handover also names as
        // EMERGENCY_REVOKER_ADDRESS and refuses unless it holds PROPOSER_ROLE
        // here. Catch a mismatch now rather than at handover.
        address revoker = vm.envOr("EMERGENCY_REVOKER_ADDRESS", address(0));
        require(
            revoker == address(0) || revoker == proposer,
            "DeployTimelock: TIMELOCK_PROPOSER must equal EMERGENCY_REVOKER_ADDRESS (one Governance Safe)"
        );
        require(minDelay >= 1 hours, "DeployTimelock: min delay < 1h");
        // #1195 F4 (Pass-2 hardening) — on a Phase-1 MAINNET the Timelock must
        // enforce the ratified 48h minimum delay; the `TIMELOCK_MIN_DELAY` env
        // must not be able to floor governance to the 1h dev minimum with no
        // gate. Known testnets keep the 1h floor for iteration speed; every other
        // chain is gated (Deployments.requiresProductionGovernance, fail-closed,
        // so BNB Chain is covered too). Phase-1 mainnet
        // set per ProjectDetailsREADME / TokenomicsTechSpec: Ethereum, Base,
        // Polygon, Arbitrum, Optimism.
        bool phase1Mainnet = Deployments.requiresProductionGovernance();
        if (phase1Mainnet) {
            require(minDelay >= 48 hours, "DeployTimelock: mainnet min delay < 48h");
        }
        // #938 — every Timelock gets a veto party other than the Safe that
        // queues operations. Required on testnets too: the handover refuses
        // a Timelock without it on every chain, so a canceller-free deploy
        // would only fail later, after the Timelock is recorded (r6).
        require(canceller != address(0), "DeployTimelock: PAUSER_ADDRESS (the canceller) required");
        if (phase1Mainnet) {
            // A Safe is a contract. An EOA or a mistyped address here would
            // be a veto nobody can exercise, reported as if one existed.
            require(canceller.code.length > 0, "DeployTimelock: PAUSER_ADDRESS has no code (not a Safe)");
            require(proposer.code.length > 0, "DeployTimelock: TIMELOCK_PROPOSER has no code (not a Safe)");
        }
        require(canceller != proposer, "DeployTimelock: PAUSER_ADDRESS must differ from TIMELOCK_PROPOSER");

        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor; // address(0) -> anyone can execute

        console.log("=== Deploy TimelockController ===");
        console.log("Chain id:       ", block.chainid);
        console.log("Min delay (s):  ", minDelay);
        console.log("Proposer:       ", proposer);
        console.log("Executor:       ", executor);
        console.log("Canceller (Pauser Safe):", canceller);

        address[] memory cancellers = new address[](1);
        cancellers[0] = canceller;

        vm.startBroadcast(deployerKey);
        VaipakamTimelock tl = new VaipakamTimelock(
            minDelay,
            proposers,
            executors,
            cancellers // self-administered by construction — no admin argument
        );
        vm.stopBroadcast();

        timelock = address(tl);
        Deployments.writeTimelock(timelock);
        console.log("Timelock:       ", timelock);
        console.log("Recorded in deployments/<chain>/addresses.json under .timelock");
    }
}
