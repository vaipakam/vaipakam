// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {VaipakamTimelock} from "../src/governance/VaipakamTimelock.sol";
import {Deployments} from "./lib/Deployments.sol";
import {HandoverPlan} from "./lib/HandoverPlan.sol";

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
 *      Two waits (owner decision 2026-11-19, option A):
 *        - the STANDARD delay, default and mainnet minimum 7 days, which
 *          every operation waits unless it is one of the two below;
 *        - the RESTART delay (OZ's min delay), default and mainnet minimum
 *          48 hours, for an operation that only lifts a pause (the
 *          timelock's fixed restart list) or an urgent fix whose exact id
 *          the Pauser Safe approved first.
 *      Both are permanent floors: neither can be lowered below its
 *      deploy-time value.
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
 *        - TIMELOCK_MIN_DELAY    : optional, the restart delay; defaults
 *                                  to 172800 (48h)
 *        - TIMELOCK_STANDARD_DELAY : optional, the standard delay; defaults
 *                                  to 604800 (7 days)
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
 *                                  It is also the one urgent approver
 *                                  (URGENT_APPROVER_ROLE).
 */
contract DeployTimelock is Script {
    uint256 internal constant DEFAULT_MIN_DELAY = 48 hours;
    uint256 internal constant DEFAULT_STANDARD_DELAY = 7 days;

    /// @notice Everything the deploy decides from, as plain values.
    /// @dev    `run()` fills it from the environment; tests build it directly
    ///         and call `runWith`, so no test reads or writes the process
    ///         environment. `vm.setEnv` writes one environment shared by
    ///         every test thread, and forge runs tests in parallel, so a
    ///         test that set these as env vars could read another test's
    ///         values (#2716; the `DeployDiamond.runWith` precedent is #72).
    /// @param deployerKey Broadcasting key (`DEPLOYER_PRIVATE_KEY`).
    /// @param minDelay    The restart delay in seconds (`TIMELOCK_MIN_DELAY`, default 48h).
    /// @param standardDelay The standard delay in seconds (`TIMELOCK_STANDARD_DELAY`, default 7 days).
    /// @param proposer    The Governance Safe (`TIMELOCK_PROPOSER`).
    /// @param executor    Executor, or zero for "anyone may execute" (`TIMELOCK_EXECUTOR`).
    /// @param canceller   The Pauser Safe, the independent canceller (`PAUSER_ADDRESS`).
    /// @param revoker     `EMERGENCY_REVOKER_ADDRESS`, or zero when unset; when
    ///                    set it must name the same Safe as `proposer`.
    /// @param diamond     The chain's Diamond (`addresses.json` `.diamond`):
    ///                    the only target of the timelock's restart list. It
    ///                    must route every restart selector.
    struct Config {
        uint256 deployerKey;
        uint256 minDelay;
        uint256 standardDelay;
        address proposer;
        address executor;
        address canceller;
        address revoker;
        address diamond;
    }

    function run() external returns (address timelock) {
        return runWith(configFromEnv());
    }

    /// @notice Reads the deploy inputs from the environment.
    /// @dev    The retired `TIMELOCK_CANCELLER` is refused here, because it
    ///         is a property of the environment, not of the deploy: the
    ///         canceller is only ever `PAUSER_ADDRESS`.
    function configFromEnv() public view returns (Config memory c) {
        require(
            vm.envOr("TIMELOCK_CANCELLER", address(0)) == address(0),
            "DeployTimelock: TIMELOCK_CANCELLER is retired - the canceller is PAUSER_ADDRESS; unset it"
        );
        c.deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        c.minDelay = vm.envOr("TIMELOCK_MIN_DELAY", DEFAULT_MIN_DELAY);
        c.standardDelay = vm.envOr("TIMELOCK_STANDARD_DELAY", DEFAULT_STANDARD_DELAY);
        c.proposer = vm.envAddress("TIMELOCK_PROPOSER");
        c.executor = vm.envOr("TIMELOCK_EXECUTOR", address(0));
        // The canceller IS the Pauser Safe — read from the same variable
        // `Handover.s.sol` grants PAUSER_ROLE from, never from a separate
        // one (Codex #2642 r1).
        c.canceller = vm.envOr("PAUSER_ADDRESS", address(0));
        c.revoker = vm.envOr("EMERGENCY_REVOKER_ADDRESS", address(0));
        c.diamond = Deployments.readDiamond();
    }

    /// @notice Checks `c` and deploys the Timelock. Every refusal happens
    ///         before anything is broadcast.
    function runWith(Config memory c) public returns (address timelock) {
        uint256 deployerKey = c.deployerKey;
        uint256 minDelay = c.minDelay;
        address proposer = c.proposer;
        address executor = c.executor;
        address canceller = c.canceller;

        require(proposer != address(0), "DeployTimelock: proposer required");
        // The proposer is the Governance Safe, which Handover also names as
        // EMERGENCY_REVOKER_ADDRESS and refuses unless it holds PROPOSER_ROLE
        // here. Catch a mismatch now rather than at handover.
        require(
            c.revoker == address(0) || c.revoker == proposer,
            "DeployTimelock: TIMELOCK_PROPOSER must equal EMERGENCY_REVOKER_ADDRESS (one Governance Safe)"
        );
        require(minDelay >= 1 hours, "DeployTimelock: min delay < 1h");
        require(c.standardDelay >= minDelay, "DeployTimelock: standard delay < restart delay");
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
            require(c.standardDelay >= 7 days, "DeployTimelock: mainnet standard delay < 7 days");
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
        // The restart list's one target. The timelock deploys after the
        // Diamond, and on mainnet after the switch host merges, so every
        // restart selector must already be routed (checked after the
        // construction below, before anything is recorded).
        require(c.diamond.code.length > 0, "DeployTimelock: no Diamond deployed at .diamond (the restart target)");

        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor; // address(0) -> anyone can execute

        console.log("=== Deploy TimelockController ===");
        console.log("Chain id:       ", block.chainid);
        console.log("Restart delay (s):  ", minDelay);
        console.log("Standard delay (s): ", c.standardDelay);
        console.log("Proposer:       ", proposer);
        console.log("Executor:       ", executor);
        console.log("Canceller (Pauser Safe):", canceller);

        address[] memory cancellers = new address[](1);
        cancellers[0] = canceller;

        vm.startBroadcast(deployerKey);
        // The Pauser Safe is both the independent canceller and the one
        // urgent approver; the timelock refuses an approver that proposes.
        VaipakamTimelock tl = new VaipakamTimelock(
            minDelay,
            c.standardDelay,
            c.diamond,
            proposers,
            executors,
            cancellers, // self-administered by construction — no admin argument
            cancellers
        );
        vm.stopBroadcast();

        timelock = address(tl);
        // The simulation reaches this before `--broadcast` sends anything, so
        // a misfit refuses the whole run.
        string memory restartProblem = HandoverPlan.restartListProblem(timelock, c.diamond);
        require(bytes(restartProblem).length == 0, string.concat("DeployTimelock: restart list: ", restartProblem));
        Deployments.writeTimelock(timelock);
        console.log("Timelock:       ", timelock);
        console.log("Recorded in deployments/<chain>/addresses.json under .timelock");
    }
}
