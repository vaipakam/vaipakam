// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {Deployments} from "./lib/Deployments.sol";
import {LibLaunchReadiness} from "../src/governance/LibLaunchReadiness.sol";
import {LaunchGate} from "../src/governance/LaunchGate.sol";
import {LaunchGateDeployment} from "./lib/LaunchGateDeployment.sol";

/// @dev The role read this script needs of the Diamond.
interface IRoleTable {
    function hasRole(bytes32 role, address account) external view returns (bool);
}

/// @dev The reads this script needs of the OpenZeppelin `TimelockController`.
interface ILaunchTimelock {
    function getMinDelay() external view returns (uint256);
    function hashOperationBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt
    ) external pure returns (bytes32);
    function isOperationPending(bytes32 id) external view returns (bool);
    function isOperationReady(bytes32 id) external view returns (bool);
    function isOperationDone(bytes32 id) external view returns (bool);
}

/**
 * @title Launch
 * @notice The ONE way a Diamond is unpaused for the first time (#945, #946).
 *
 * @dev A Diamond is born paused and `DeployDiamond` now leaves it paused, so
 *      nothing is publicly callable until this step has read every
 *      `LibLaunchReadiness` requirement off the live chain. Who unpauses depends
 *      on the chain (owner decision 2026-10-23, "Timelock unpauses after
 *      handover"):
 *
 *        - **Production** (every chain `Deployments.requiresProductionGovernance`
 *          gates): every requirement must be met AND the handover must be
 *          done — the Timelock holds `UNPAUSER_ROLE` and the admin key holds
 *          no Diamond role at all (`LibAccessControl.knownRoles()`). The
 *          script broadcasts NOTHING. It
 *          prints the `scheduleBatch` call for the Governance Safe to propose
 *          through the Timelock, the `executeBatch` call for after the delay,
 *          and the operation's current state. So a production Diamond is
 *          never live under the hot admin key, and its first unpause waits
 *          out the same review window as any other governance action.
 *
 *          The operation is a batch of `LaunchGate.assertReady` then
 *          `unpauseIfPauseEpoch(epoch)`, so every requirement — and the
 *          admin key holding no role — is read AGAIN, on-chain, in the
 *          transaction that unpauses: one that stopped holding during the
 *          delay reverts the execution and the Diamond stays paused. The
 *          epoch is the pause library's transition count when the proposal
 *          was printed, so an incident pause (a Pauser or the watcher's
 *          auto-pause) recorded during the delay also makes the execution
 *          revert: a launch decision taken before an incident never clears
 *          it. That case needs a fresh proposal.
 *        - **Known testnet**: no requirement may be NOT MET; one the chain
 *          cannot answer is printed as NOT CHECKED (a rehearsal may lack part
 *          of the stack). The admin key unpauses directly while it holds
 *          `UNPAUSER_ROLE` and the Diamond is still at its birth pause epoch
 *          ({BIRTH_EPOCH}); after a rehearsal handover the Timelock batch is
 *          printed instead, exactly as on production, and needs every
 *          requirement met because the gate inside it does.
 *        - **Local Anvil (31337)**: every requirement is printed and an unmet
 *          one is a WARNING, then the admin key unpauses. Local fixtures
 *          carry mocks rather than a full stack, and they relied on the
 *          Diamond being live after the deploy; they now get there through
 *          this step and see what a real chain would refuse.
 *
 *      One decision ({decide}) drives the run, the report and the evidence
 *      check, so the three cannot disagree. Launch evidence is read FIRST,
 *      paused or not: once the Timelock reports this checkout's launch
 *      operation DONE at some pause epoch, the Diamond has launched, and a
 *      pause it is under now is an incident — no second unpause is
 *      proposed or broadcast. An already-unpaused Diamond is never recorded
 *      as launched on trust: on production without that evidence it went
 *      live outside this step and the run refuses; on a testnet every
 *      answered requirement must still be met; local anvil just reports it.
 *      A testnet admin launch leaves no such evidence, so the admin key
 *      unpauses only a Diamond still at its birth epoch: any pause since
 *      then may be an incident after a launch, which the chain cannot tell
 *      from a pause before one, and the run refuses unless the operator
 *      names that epoch in `LAUNCH_ACK_PAUSE_EPOCH`. The deploy wrappers
 *      record the phase only when `requireLaunched()` passes, never from
 *      the pause bit.
 *
 *      Run (`deploy-{mainnet,testnet}.sh <slug> --phase launch` does this):
 *        forge script script/Launch.s.sol --rpc-url $RPC [--broadcast]
 *
 * @dev Env:
 *        CHAIN_SLUG or ADDRESSES_JSON_PATH — the artifact (`diamond`,
 *            `timelock`). The gate is not read from it: its address follows
 *            from this checkout's bytecode (`LaunchGateDeployment`).
 *        CCIP_TOKEN_ADMIN_REGISTRY — the chain's CCIP TokenAdminRegistry.
 *            The VPFI pool is read from it for the Diamond's own VPFI
 *            token; unset leaves the lane check NOT CHECKED, which a
 *            production or Timelock launch refuses.
 *        ADMIN_PRIVATE_KEY — the admin key; unused (and optional) on
 *            production, where only its address is read to prove it holds
 *            no role. ADMIN_ADDRESS is accepted instead there.
 *        LAUNCH_ACK_PAUSE_EPOCH — optional, testnet/local admin launch only:
 *            the operator's statement that a Diamond paused again since its
 *            birth never went live, naming the epoch the refusal printed.
 */
contract Launch is Script {
    /// @notice What a launch run did.
    enum Outcome {
        AlreadyLive,
        Unpaused,
        TimelockProposalPrinted
    }

    /// @notice What a launch run would do on this chain now.
    enum Path {
        Refuse,
        Launched,
        AdminUnpause,
        TimelockProposal
    }

    /// @notice The one launch decision `launch`, `report` and
    ///         `checkLaunched` all read, so none of them can disagree.
    struct Decision {
        Path path;
        /// @dev Why it refuses, or what the launch evidence is.
        string reason;
        /// @dev The readiness checks, when the decision read them.
        LibLaunchReadiness.Check[] checks;
        /// @dev The pause epoch now; an unpause this run makes is bound to it.
        uint64 epoch;
    }

    /// @notice The pause epoch a Diamond is born with: its constructor's
    ///         pause is its one transition. A Diamond still at it has never
    ///         been unpaused, so it has never launched.
    uint64 public constant BIRTH_EPOCH = 1;

    function run() external returns (Outcome) {
        uint256 adminKey = vm.envOr("ADMIN_PRIVATE_KEY", uint256(0));
        return launch(
            Deployments.readDiamond(), _registryFromEnv(), Deployments.readTimelockOptional(), _adminFromEnv(), adminKey
        );
    }

    /// @notice Reverts unless this chain's launch has happened, by the same
    ///         decision a re-run of the launch applies; changes nothing. The
    ///         deploy wrappers record the launch phase only when this passes.
    function requireLaunched() external view {
        checkLaunched(Deployments.readDiamond(), _registryFromEnv(), Deployments.readTimelockOptional(), _adminFromEnv());
        console.log("launched: the launch evidence holds for this chain");
    }

    /// @notice Prints what a launch run would do now, and why, and changes
    ///         nothing (the deploy scripts' verify phases call this). It is
    ///         the launch's own decision — readiness, the handover, the gate
    ///         and the launch evidence — so it never calls a deployment
    ///         launchable that the launch would refuse. Returns whether a
    ///         launch run would proceed, or has already launched. The admin
    ///         key is assumed to be supplied when its address is known.
    function report() external view returns (bool ready) {
        address diamond = Deployments.readDiamond();
        address admin = _adminFromEnv();
        Decision memory d =
            decide(diamond, _registryFromEnv(), Deployments.readTimelockOptional(), admin, admin != address(0));
        console.log("Launch readiness (report only)");
        console.log("  paused:", AdminFacet(diamond).paused());
        console.log("  pause epoch:", uint256(d.epoch));
        _printChecks(d.checks);
        console.log("  launch gate:", LaunchGateDeployment.predicted());
        console.log(LaunchGateDeployment.isDeployed() ? "    deployed" : "    NOT deployed");
        ready = d.path != Path.Refuse;
        if (d.path == Path.Launched) console.log("  -> launched:", d.reason);
        else if (d.path == Path.AdminUnpause) console.log("  -> a launch would proceed: the admin key unpauses");
        else if (d.path == Path.TimelockProposal) console.log("  -> a launch would proceed: it prints the Timelock proposal");
        else console.log("  -> a launch would REFUSE:", d.reason);
    }

    /// @notice Takes the launch decision ({decide}) and acts on it: unpauses
    ///         with the admin key, prints the Timelock proposal, reports a
    ///         launch that already happened, or refuses with the reason.
    /// @param tokenAdminRegistry The chain's CCIP TokenAdminRegistry, or zero.
    /// @param admin The admin key's address: the Timelock batch re-checks
    ///        that it holds no Diamond role, so every Timelock path needs it.
    /// @param adminKey The admin's private key, or zero when the run must
    ///        not (or cannot) broadcast. Never used on a production chain.
    function launch(address diamond, address tokenAdminRegistry, address timelock, address admin, uint256 adminKey)
        public
        returns (Outcome)
    {
        bool production = Deployments.requiresProductionGovernance();
        bool local = block.chainid == 31337;
        console.log("Launch readiness");
        console.log("  diamond: ", diamond);
        console.log("  mode:    ", production ? "production (Timelock unpauses)" : local ? "local anvil" : "testnet");

        Decision memory d = decide(diamond, tokenAdminRegistry, timelock, admin, adminKey != 0);
        _printChecks(d.checks);
        if (d.path == Path.Refuse) revert(d.reason);
        if (d.path == Path.Launched) {
            console.log(d.reason);
            return Outcome.AlreadyLive;
        }
        if (d.path == Path.TimelockProposal) {
            _printTimelockProposal(diamond, tokenAdminRegistry, timelock, admin, d.epoch);
            return Outcome.TimelockProposalPrinted;
        }
        if (local && !LibLaunchReadiness.noneUnmet(d.checks)) {
            console.log("WARNING: local anvil - unpausing with the NOT MET checks above; a testnet or production launch would refuse");
        }
        // Bound to the epoch the decision read, so a pause recorded between
        // that read and the broadcast makes the transaction revert.
        vm.broadcast(adminKey);
        AdminFacet(diamond).unpauseIfPauseEpoch(d.epoch);
        console.log("Unpaused by the admin key:", admin);
        return Outcome.Unpaused;
    }

    /// @notice What a launch run on this chain would do now, and why.
    /// @dev In order:
    ///      1. Launch evidence first, paused or not: the Timelock reports
    ///         this checkout's launch operation DONE at some earlier pause
    ///         epoch. The Diamond HAS launched, and a pause it is under now
    ///         is an incident: lifting it is incident response, never a
    ///         second launch, so nothing is proposed or unpaused.
    ///      2. Unpaused with no evidence: production refuses (it went live
    ///         outside the launch step); a testnet counts it as launched only
    ///         while no answered requirement is NOT MET; local anvil counts
    ///         it.
    ///      3. Paused with no evidence: the readiness checks decide, then who
    ///         unpauses. The admin key unpauses directly (never on
    ///         production) only while the pause epoch is still
    ///         {BIRTH_EPOCH}. A Diamond with any pause history since birth may
    ///         have launched and then been paused for an incident, which the
    ///         chain cannot tell apart from a pause before launch, so the run
    ///         refuses rather than guess; `LAUNCH_ACK_PAUSE_EPOCH` set to the
    ///         printed epoch is the operator's statement that it never went
    ///         live. A Timelock proposal is printed at any epoch: it waits out
    ///         the delay under review, and it states the pause history.
    /// @param adminKeyGiven Whether the run holds the admin's private key.
    function decide(address diamond, address tokenAdminRegistry, address timelock, address admin, bool adminKeyGiven)
        public
        view
        returns (Decision memory d)
    {
        require(diamond.code.length != 0, "Launch: the artifact's diamond has no code on this chain");
        bool production = Deployments.requiresProductionGovernance();
        bool local = block.chainid == 31337;
        bool paused = AdminFacet(diamond).paused();
        d.epoch = pauseEpoch(diamond);

        if (_launchOperationDone(diamond, tokenAdminRegistry, timelock, admin)) {
            d.path = Path.Launched;
            d.reason = paused
                ? "launched by the Timelock's launch operation, and paused since: lifting that pause is incident response (GovernanceRunbook), not a launch"
                : "launched by the Timelock's launch operation";
            return d;
        }

        if (!paused) {
            if (production) {
                d.reason =
                    "Launch: the Timelock has not executed this checkout's launch operation - the Diamond went live outside the launch step, the launch used a different LaunchGate build, registry or admin address, or it has not launched; investigate before anything records a launch";
                return d;
            }
            d.path = Path.Launched;
            d.reason = "the Diamond is unpaused";
            if (local) return d;
            d.checks = LibLaunchReadiness.check(diamond, tokenAdminRegistry);
            if (!LibLaunchReadiness.noneUnmet(d.checks)) {
                d.path = Path.Refuse;
                d.reason =
                    "Launch: the Diamond is unpaused but a readiness check is NOT MET - it went live before it was ready; complete the phase named above, then re-run";
            }
            return d;
        }

        d.checks = LibLaunchReadiness.check(diamond, tokenAdminRegistry);
        if (production && !LibLaunchReadiness.allMet(d.checks)) {
            d.reason =
                "Launch: a production Diamond is unpaused only when every readiness check is met (NOT MET and NOT CHECKED both refuse)";
            return d;
        }
        if (!production && !local && !LibLaunchReadiness.noneUnmet(d.checks)) {
            d.reason = "Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run";
            return d;
        }

        bool timelockHolds =
            timelock != address(0) && IRoleTable(diamond).hasRole(LibAccessControl.UNPAUSER_ROLE, timelock);
        bool adminHolds = admin != address(0) && IRoleTable(diamond).hasRole(LibAccessControl.UNPAUSER_ROLE, admin);

        if (!production && adminHolds && adminKeyGiven) {
            if (d.epoch != BIRTH_EPOCH && vm.envOr("LAUNCH_ACK_PAUSE_EPOCH", uint256(0)) != d.epoch) {
                console.log("  pause epoch now:", uint256(d.epoch));
                d.reason =
                    "Launch: the Diamond has been paused since its birth pause, so it may have launched and be paused for an incident - lifting that is incident response, not a launch. If it never went live, re-run with LAUNCH_ACK_PAUSE_EPOCH set to the epoch printed above";
                return d;
            }
            d.path = Path.AdminUnpause;
            return d;
        }
        if (!timelockHolds) {
            d.reason = production
                ? "Launch: the Timelock does not hold UNPAUSER_ROLE - run the handover and its gate first"
                : "Launch: neither the admin key (ADMIN_PRIVATE_KEY) nor the Timelock holds UNPAUSER_ROLE";
            return d;
        }
        if (!LibLaunchReadiness.allMet(d.checks)) {
            d.reason =
                "Launch: a Timelock launch needs every readiness check met - the LaunchGate inside the batch refuses NOT CHECKED too";
            return d;
        }
        if (admin == address(0)) {
            d.reason = "Launch: set ADMIN_ADDRESS so the run can prove the admin key holds no role";
            return d;
        }
        (bool held, bytes32 role) = LibLaunchReadiness.firstRoleHeld(diamond, admin);
        if (held) {
            console.log("  the admin key still holds role:");
            console.logBytes32(role);
            d.reason = "Launch: the admin key still holds a Diamond role - the handover is not complete";
            return d;
        }
        if (!LaunchGateDeployment.isDeployed()) {
            d.reason =
                "Launch: the LaunchGate is not deployed at its address - run script/DeployLaunchGate.s.sol (the contracts phase does)";
            return d;
        }
        d.path = Path.TimelockProposal;
    }

    /// @notice The Timelock batch that launches `diamond`: the gate re-reads
    ///         every requirement and that `deployKey` holds no role, then the
    ///         Diamond is unpaused only if the pause epoch is still `epoch`.
    ///         Both calls land in one execution or neither does.
    function launchBatch(address diamond, address tokenAdminRegistry, address deployKey, uint64 epoch)
        public
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        targets = new address[](2);
        values = new uint256[](2);
        payloads = new bytes[](2);
        targets[0] = LaunchGateDeployment.predicted();
        payloads[0] = abi.encodeCall(LaunchGate.assertReady, (diamond, tokenAdminRegistry, deployKey));
        targets[1] = diamond;
        payloads[1] = abi.encodeCall(AdminFacet.unpauseIfPauseEpoch, (epoch));
    }

    /// @notice The Timelock's id for this chain's launch operation at `epoch`.
    function launchOperationId(
        address diamond,
        address tokenAdminRegistry,
        address deployKey,
        uint64 epoch,
        address timelock
    ) public view returns (bytes32) {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launchBatch(diamond, tokenAdminRegistry, deployKey, epoch);
        return ILaunchTimelock(timelock).hashOperationBatch(targets, values, payloads, bytes32(0), launchSalt(diamond));
    }

    /// @notice The salt every launch proposal for `diamond` on this chain
    ///         uses, so a re-run finds the operation it printed before.
    function launchSalt(address diamond) public view returns (bytes32) {
        return keccak256(abi.encodePacked("vaipakam-launch-unpause:", block.chainid, diamond));
    }

    /// @notice The pause library's transition count on `diamond` now — the
    ///         epoch a proposal printed now binds its unpause to. Read from
    ///         storage, since no facet exposes it.
    function pauseEpoch(address diamond) public view returns (uint64 epoch) {
        (,,, epoch) = LibPausable.decodePausableSlot(vm.load(diamond, LibPausable.PAUSABLE_STORAGE_POSITION));
    }

    /// @notice Reverts unless `diamond` has launched, by the launch decision
    ///         ({decide}): on production the Timelock's DONE launch operation
    ///         at some pause epoch (a later incident pause does not hide it);
    ///         on a testnet an unpaused Diamond with no answered requirement
    ///         NOT MET; on local anvil an unpaused Diamond.
    function checkLaunched(address diamond, address tokenAdminRegistry, address timelock, address admin)
        public
        view
    {
        Decision memory d = decide(diamond, tokenAdminRegistry, timelock, admin, false);
        if (d.path == Path.Launched) return;
        _printChecks(d.checks);
        // An unpaused Diamond the decision refuses names why; a paused one
        // simply has not launched, whatever a launch run would do next.
        revert(AdminFacet(diamond).paused() ? "Launch: the Diamond has not launched" : d.reason);
    }

    function _launchOperationDone(address diamond, address tokenAdminRegistry, address timelock, address admin)
        internal
        view
        returns (bool)
    {
        if (timelock == address(0) || timelock.code.length == 0 || admin == address(0)) return false;
        for (uint64 e = pauseEpoch(diamond); e > 0; --e) {
            if (ILaunchTimelock(timelock).isOperationDone(launchOperationId(diamond, tokenAdminRegistry, admin, e - 1, timelock))) {
                return true;
            }
        }
        return false;
    }

    function _registryFromEnv() internal view returns (address) {
        return vm.envOr("CCIP_TOKEN_ADMIN_REGISTRY", address(0));
    }

    function _adminFromEnv() internal view returns (address) {
        uint256 adminKey = vm.envOr("ADMIN_PRIVATE_KEY", uint256(0));
        return adminKey != 0 ? vm.addr(adminKey) : vm.envOr("ADMIN_ADDRESS", address(0));
    }

    function _printChecks(LibLaunchReadiness.Check[] memory checks) internal pure {
        for (uint256 i; i < checks.length; ++i) {
            console.log(
                string.concat(
                    "  [", LibLaunchReadiness.verdict(checks[i]), "] ", checks[i].label, " - ", checks[i].detail
                )
            );
        }
    }

    function _printTimelockProposal(
        address diamond,
        address tokenAdminRegistry,
        address timelock,
        address admin,
        uint64 epoch
    ) internal view {
        address gate = LaunchGateDeployment.predicted();
        ILaunchTimelock tl = ILaunchTimelock(timelock);
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launchBatch(diamond, tokenAdminRegistry, admin, epoch);
        bytes32 salt = launchSalt(diamond);
        uint256 delay = tl.getMinDelay();
        bytes32 id = launchOperationId(diamond, tokenAdminRegistry, admin, epoch, timelock);

        string memory state = tl.isOperationDone(id)
            ? "DONE"
            : tl.isOperationReady(id) ? "READY to execute" : tl.isOperationPending(id) ? "PENDING (delay running)" : "not scheduled";

        console.log("The first unpause is a Timelock batch. Operation state:", state);
        console.log("  call 1: LaunchGate.assertReady(diamond, tokenAdminRegistry, adminKey)");
        console.log("    re-reads every check above, and that the admin key holds no role, when executed");
        console.log("    gate:", gate);
        console.log("    tokenAdminRegistry:", tokenAdminRegistry);
        console.log("    admin key:", admin);
        console.log("  call 2: diamond.unpauseIfPauseEpoch(epoch), epoch:", uint256(epoch));
        console.log("    reverts if a pause or auto-pause is recorded before execution; propose again then");
        if (epoch != BIRTH_EPOCH) {
            console.log("  NOTE: the Diamond has been paused since its birth pause. No launch operation of this");
            console.log("    checkout is DONE, but confirm it never went live before scheduling: if it did, this");
            console.log("    pause is an incident and lifting it is incident response, not a launch.");
        }
        console.log("  1. The Governance Safe calls the Timelock with:");
        console.log("     to:  ", timelock);
        console.logBytes(
            abi.encodeWithSignature(
                "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)",
                targets,
                values,
                payloads,
                bytes32(0),
                salt,
                delay
            )
        );
        console.log("  2. After the delay (seconds):", delay);
        console.log("     anyone calls the Timelock with:");
        console.logBytes(
            abi.encodeWithSignature(
                "executeBatch(address[],uint256[],bytes[],bytes32,bytes32)", targets, values, payloads, bytes32(0), salt
            )
        );
        console.log("     It reverts, and the Diamond stays paused, if any check no longer holds then.");
        console.log("  operation id:");
        console.logBytes32(id);
    }
}
