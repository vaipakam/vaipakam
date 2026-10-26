// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {Deployments} from "./lib/Deployments.sol";
import {LibLaunchReadiness, ILaunchReadableDiamond} from "../src/governance/LibLaunchReadiness.sol";
import {ILaunchGate} from "../src/interfaces/ILaunchGate.sol";
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
 *          The operation is ONE call, `AdminFacet.launch(epoch, gate,
 *          gateCall)`: the Diamond calls `LaunchGate.assertReady` itself and
 *          unpauses only when it returns, so every requirement is read
 *          AGAIN, on-chain, in the transaction that unpauses — and so is the
 *          handover: the admin key holds no role, the owner is still the
 *          Timelock, and the role epoch is still the one the handover gate
 *          proved (`HANDOVER_ROLE_EPOCH`), so no role changed hands
 *          unreviewed, and the Timelock has executed no call since that
 *          proof (`HANDOVER_TIMELOCK_CALLS`): the launch must be its next
 *          call, so no governance action the gate never saw lands first.
 *          One that stopped holding during the delay reverts the
 *          execution and the Diamond stays paused. The epoch is the pause
 *          library's transition count when the proposal was printed, so an
 *          incident pause (a Pauser or the watcher's auto-pause) recorded
 *          during the delay also makes the execution revert: a launch
 *          decision taken before an incident never clears it. That case,
 *          like a moved role epoch, needs a fresh proposal. The Diamond's
 *          first-unpause record names the gate it went through, so a
 *          Timelock operation that only unpauses can never pass for a
 *          launch (Codex #2686 r9).
 *        - **Known testnet**: no requirement may be NOT MET; one the chain
 *          cannot answer is printed as NOT CHECKED (a rehearsal may lack part
 *          of the stack). The admin key unpauses directly while it holds
 *          `UNPAUSER_ROLE`; after a rehearsal handover the Timelock batch is
 *          printed instead, exactly as on production, and needs every
 *          requirement met because the gate inside it does.
 *        - **Local Anvil (31337)**: every requirement is printed and an unmet
 *          one is a WARNING, then the admin key unpauses. Local fixtures
 *          carry mocks rather than a full stack, and they relied on the
 *          Diamond being live after the deploy; they now get there through
 *          this step and see what a real chain would refuse.
 *
 *      One decision ({decide}) drives the run, the report and the evidence
 *      check, so the three cannot disagree. The launch is read FIRST, paused
 *      or not, and from the Diamond itself: its pause library records who
 *      first lifted its birth pause, and when (`LibPausable`, written once).
 *      A Diamond with that record has launched, and a pause it is under now
 *      is an incident — no second unpause is proposed or broadcast. The
 *      record does not depend on this checkout (a later LaunchGate build, a
 *      changed registry or admin address) or on how far later pauses moved
 *      the pause epoch, so neither can make a launched Diamond look
 *      unlaunched. On production the first unpause must have been the
 *      Timelock's, through a launch gate; one by anyone else, or a plain
 *      Timelock unpause, went live outside this step and the run refuses.
 *      An unpaused Diamond with no record predates the record:
 *      production refuses it, a testnet counts it as launched only while no
 *      answered requirement is NOT MET, local anvil reports it. The deploy
 *      wrappers record the phase only when `requireLaunched()` passes, never
 *      from the pause bit.
 *
 *      Run (`deploy-{mainnet,testnet}.sh <slug> --phase launch` does this):
 *        forge script script/Launch.s.sol --rpc-url $RPC [--broadcast]
 *
 * @dev Env:
 *        CHAIN_SLUG or ADDRESSES_JSON_PATH — the artifact (`diamond`,
 *            `timelock`). The gate is not read from it: its address follows
 *            from this checkout's bytecode (`LaunchGateDeployment`).
 *            The artifact's `vpfiTokenPool` is the declared VPFI pool.
 *        CCIP_TOKEN_ADMIN_REGISTRY — the chain's CCIP TokenAdminRegistry.
 *            The VPFI pool is read from it for the Diamond's own VPFI
 *            token and compared with the declared one; unset leaves both
 *            CCIP checks NOT CHECKED, which a production or Timelock launch
 *            refuses.
 *        CCIP_LANE_CHAIN_IDS — the chain ids of every lane the VPFI pool
 *            must carry, exactly (the deploy wrappers resolve
 *            `CCIP_LANE_CHAIN_IDS_<SLUG>` into it). Unset declares no lane:
 *            NOT CHECKED while the Diamond records a VPFI token, met as
 *            not applicable on a deployment with none (`--skip-vpfi`).
 *        HANDOVER_ROLE_EPOCH — the Diamond's role epoch at which the
 *            handover gate proved every role's holders; the deploy wrappers
 *            set it from the handover-gate phase's output. Required for a
 *            production proposal; a testnet one without it binds the live
 *            epoch and says so.
 *        HANDOVER_TIMELOCK_CALLS — the Timelock's executed-call count in
 *            the same state, which the handover gate proves alongside the
 *            role epoch (Codex #2686 r14). Required with it: the proposal
 *            refuses once any Timelock call has executed since that proof,
 *            so an operation the gate never saw (a pool ownership offer
 *            queued before the proof, say) forces the gate to run again.
 *        ADMIN_PRIVATE_KEY — the admin key; unused (and optional) on
 *            production, where only its address is read to prove it holds
 *            no role. ADMIN_ADDRESS is accepted instead there.
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
        /// @dev On the Timelock path: the governance state the batch binds
        ///      (the admin key, the Diamond owner, the role epoch, the
        ///      Timelock's call count), and whether the role epoch and call
        ///      count are the ones the handover gate proved.
        ILaunchGate.Handover handover;
        bool roleEpochProven;
    }

    /// @dev The role epoch and Timelock call count the handover gate
    ///      proved, when given programmatically ({setHandoverProof});
    ///      otherwise read from `HANDOVER_ROLE_EPOCH` and
    ///      `HANDOVER_TIMELOCK_CALLS`.
    bool private _proofSet;
    uint64 private _proofEpoch;
    uint64 private _proofCalls;

    function run() external returns (Outcome) {
        uint256 adminKey = vm.envOr("ADMIN_PRIVATE_KEY", uint256(0));
        address diamond_ = Deployments.readDiamond();
        return launch(
            diamond_, declaredFromEnv(diamond_), Deployments.readTimelockOptional(), _adminFromEnv(), adminKey
        );
    }

    /// @notice Reverts unless this chain's launch has happened, by the same
    ///         decision a re-run of the launch applies; changes nothing. The
    ///         deploy wrappers record the launch phase only when this passes.
    ///         It prints the evidence, and whether the Diamond is paused now,
    ///         on a line starting `launched:` that the wrappers repeat.
    function requireLaunched() external view {
        address diamond_ = Deployments.readDiamond();
        string memory evidence =
            checkLaunched(diamond_, declaredFromEnv(diamond_), Deployments.readTimelockOptional(), _adminFromEnv());
        console.log(string.concat("launched: ", evidence));
    }

    /// @notice Reverts unless a launch run would proceed now, or has already
    ///         launched, by the same decision; changes nothing. The verify
    ///         phases read it to state the launch verdict, not to pass or
    ///         fail: verify runs before the handover, when a production
    ///         launch still refuses by design.
    function requireLaunchable() external view {
        address diamond_ = Deployments.readDiamond();
        Decision memory d = decide(
            diamond_, declaredFromEnv(diamond_), Deployments.readTimelockOptional(), _adminFromEnv(), _adminKeyGiven()
        );
        if (d.path == Path.Refuse) revert(d.reason);
    }

    /// @notice Prints what a launch run would do now, and why, and changes
    ///         nothing (the deploy scripts' verify phases call this). It is
    ///         the launch's own decision — readiness, the handover, the gate
    ///         and the launch evidence — so it never calls a deployment
    ///         launchable that the launch would refuse. Returns whether a
    ///         launch run would proceed, or has already launched. Like the
    ///         run, it counts the admin key only when `ADMIN_PRIVATE_KEY` is
    ///         set: a known address alone cannot unpause.
    function report() external view returns (bool ready) {
        address diamond = Deployments.readDiamond();
        LibLaunchReadiness.Declared memory declared = declaredFromEnv(diamond);
        Decision memory d =
            decide(diamond, declared, Deployments.readTimelockOptional(), _adminFromEnv(), _adminKeyGiven());
        // A decision that stopped early (a refusal, or local anvil) read no
        // checks; the report lists them anyway, as the chain answers them now.
        if (d.checks.length == 0) d.checks = LibLaunchReadiness.check(diamond, declared);
        console.log("Launch readiness (report only)");
        console.log("  paused:", AdminFacet(diamond).paused());
        console.log("  pause epoch:", uint256(d.epoch));
        (address liveBy, uint64 liveAt) = firstUnpause(diamond);
        if (liveBy == address(0)) {
            console.log("  first unpaused: never");
        } else {
            console.log(
                string.concat(
                    "  first unpaused by ",
                    vm.toString(liveBy),
                    _gateClause(firstUnpauseGate(diamond)),
                    " at ",
                    vm.toString(uint256(liveAt))
                )
            );
        }
        _printChecks(d.checks);
        _printNotChecked();
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
    /// @param declared What the chain must match ({declaredFromEnv}): the
    ///        CCIP registry and the declared WETH, VPFI pool and lanes.
    /// @param admin The admin key's address: the Timelock batch re-checks
    ///        that it holds no Diamond role, so every Timelock path needs it.
    /// @param adminKey The admin's private key, or zero when the run must
    ///        not (or cannot) broadcast. Never used on a production chain.
    function launch(address diamond, LibLaunchReadiness.Declared memory declared, address timelock, address admin, uint256 adminKey)
        public
        returns (Outcome)
    {
        bool production = Deployments.requiresProductionGovernance();
        bool local = block.chainid == 31337;
        console.log("Launch readiness");
        console.log("  diamond: ", diamond);
        console.log("  mode:    ", production ? "production (Timelock unpauses)" : local ? "local anvil" : "testnet");

        Decision memory d = decide(diamond, declared, timelock, admin, adminKey != 0);
        _printChecks(d.checks);
        _printNotChecked();
        if (d.path == Path.Refuse) revert(d.reason);
        if (d.path == Path.Launched) {
            console.log(d.reason);
            return Outcome.AlreadyLive;
        }
        if (d.path == Path.TimelockProposal) {
            _printTimelockProposal(diamond, declared, timelock, d);
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
    ///      1. The launch record first, paused or not ({firstUnpause}): a
    ///         Diamond whose birth pause was ever lifted HAS launched, and a
    ///         pause it is under now is an incident: lifting it is incident
    ///         response, never a second launch, so nothing is proposed or
    ///         unpaused. On production the first unpause must have been the
    ///         Timelock's, through this checkout's launch gate
    ///         (`AdminFacet.launch`), or the run refuses. The readiness
    ///         checks are read after a launch too: one NOT MET now is stated
    ///         beside the record, and a testnet record with no gate counts
    ///         only while none is NOT MET, paused now or not.
    ///      2. Unpaused with no record (a Diamond older than the record):
    ///         production refuses; a testnet counts it as launched only while
    ///         no answered requirement is NOT MET; local anvil counts it.
    ///      3. Paused with no record — it has never been live: the readiness
    ///         checks decide, then who unpauses. The admin key unpauses
    ///         directly (never on production); otherwise the Timelock
    ///         proposal is printed, once the owner is the Timelock and the
    ///         role epoch is the one the handover gate proved (a testnet
    ///         without that proof binds the live epoch and says so).
    /// @param adminKeyGiven Whether the run holds the admin's private key.
    function decide(address diamond, LibLaunchReadiness.Declared memory declared, address timelock, address admin, bool adminKeyGiven)
        public
        view
        returns (Decision memory d)
    {
        require(diamond.code.length != 0, "Launch: the artifact's diamond has no code on this chain");
        bool production = Deployments.requiresProductionGovernance();
        bool local = block.chainid == 31337;
        bool paused = AdminFacet(diamond).paused();
        d.epoch = pauseEpoch(diamond);

        (address liveBy,) = firstUnpause(diamond);
        if (liveBy != address(0)) {
            if (production && liveBy != timelock) {
                d.reason = string.concat(
                    "Launch: the Diamond was first unpaused by ",
                    vm.toString(liveBy),
                    ", not the Timelock - it went live outside the launch step; investigate before anything records a launch"
                );
                return d;
            }
            address via = firstUnpauseGate(diamond);
            address predictedGate = LaunchGateDeployment.predicted();
            // Only this checkout's gate is known to have read the
            // requirements: any other contract answering `assertReady` (a
            // permissive fallback would) vouches for nothing this run can
            // verify (Codex #2686 r10).
            bool gated = via != address(0) && via == predictedGate;
            if (production && !gated) {
                d.reason = via == address(0)
                    ? string.concat(
                        "Launch: the Diamond was first unpaused by the Timelock, but not through a launch gate ",
                        "(AdminFacet.launch) - no readiness check vouched for it in that call; investigate before ",
                        "anything records a launch"
                    )
                    : string.concat(
                        "Launch: the Diamond was first unpaused through ",
                        vm.toString(via),
                        ", which is not this checkout's launch gate (",
                        vm.toString(predictedGate),
                        ") - what it checked is unknown to this run; verify its code, or re-run from the checkout that built it"
                    );
                return d;
            }
            d.path = Path.Launched;
            d.reason = string.concat(
                "first unpaused by ",
                vm.toString(liveBy),
                _gateClause(via),
                paused
                    ? ", and PAUSED now: lifting that pause is incident response (GovernanceRunbook), not a launch"
                    : ", and unpaused now"
            );
            // The launch record is history; readiness is read now as well, so
            // the report and the verify verdict never hide a requirement that
            // stopped holding after the launch (Codex #2686 r10).
            if (local) return d;
            d.checks = LibLaunchReadiness.check(diamond, declared);
            if (LibLaunchReadiness.noneUnmet(d.checks)) return d;
            if (!production && !gated) {
                // A testnet first unpause outside a launch gate (the admin's,
                // in or out of this step) leaves no proof the Diamond was
                // ready when it went live, paused now or not, so it counts as
                // launched only while every answered requirement is met.
                d.path = Path.Refuse;
                d.reason = paused
                    ? "Launch: the Diamond was first unpaused outside a launch gate and a readiness check is NOT MET now - whether it was ready when it went live is unknown, so it is not recorded as launched; complete the phase named above, then re-run"
                    : "Launch: the Diamond is unpaused but a readiness check is NOT MET - it went live before it was ready; complete the phase named above, then re-run";
                return d;
            }
            d.reason = string.concat(
                d.reason, "; a readiness check is NOT MET now (listed above) - restore it through governance"
            );
            return d;
        }

        if (!paused) {
            if (production) {
                d.reason =
                    "Launch: the Diamond is unpaused but carries no first-unpause record - it predates the launch record or went live outside the launch step; investigate before anything records a launch";
                return d;
            }
            d.path = Path.Launched;
            d.reason = "unpaused now, with no first-unpause record (a Diamond older than the record)";
            if (local) return d;
            d.checks = LibLaunchReadiness.check(diamond, declared);
            if (!LibLaunchReadiness.noneUnmet(d.checks)) {
                d.path = Path.Refuse;
                d.reason =
                    "Launch: the Diamond is unpaused but a readiness check is NOT MET - it went live before it was ready; complete the phase named above, then re-run";
            }
            return d;
        }

        d.checks = LibLaunchReadiness.check(diamond, declared);
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
        if (ILaunchReadableDiamond(diamond).owner() != timelock) {
            d.reason = "Launch: the Diamond's owner is not the Timelock - the handover is not complete";
            return d;
        }
        uint64 liveRoles = roleEpoch(diamond);
        (bool proven, uint64 provenRoles, bool callsProven, uint64 provenCalls) = _handoverProof();
        if (proven && !callsProven) {
            d.reason =
                "Launch: the handover proof carries no Timelock call count (HANDOVER_TIMELOCK_CALLS) - re-run the handover-gate phase; the deploy wrapper passes both values it proved";
            return d;
        }
        if (proven && provenRoles != liveRoles) {
            d.reason = string.concat(
                "Launch: the Diamond's roles changed after the handover gate proved them (role epoch ",
                vm.toString(uint256(provenRoles)),
                " proven, ",
                vm.toString(uint256(liveRoles)),
                " now) - re-run the handover-gate phase, then launch"
            );
            return d;
        }
        if (production && !proven) {
            d.reason =
                "Launch: no role epoch from the handover gate (HANDOVER_ROLE_EPOCH) - run the handover-gate phase first; the deploy wrapper passes the epoch it proved";
            return d;
        }
        (bool callsRead, uint64 calls) = LibLaunchReadiness.timelockCalls(timelock);
        if (!callsRead) {
            d.reason =
                "Launch: the Timelock does not count its executed calls (executedCalls) - it predates the launch binding; deploy a current VaipakamTimelock";
            return d;
        }
        // The batch binds the count the handover gate PROVED, never one read
        // later (Codex #2686 r14): a Timelock call executed between the
        // proof and this proposal is one the gate never saw (a queued pool
        // `transferOwnership`, whose pending owner its event scan would have
        // refused), so the proposal refuses and the gate runs again.
        if (proven && provenCalls != calls) {
            d.reason = string.concat(
                "Launch: the Timelock executed a call after the handover gate proved the topology (",
                vm.toString(uint256(provenCalls)),
                " calls proven, ",
                vm.toString(uint256(calls)),
                " now) - re-run the handover-gate phase, then launch"
            );
            return d;
        }
        d.handover =
            ILaunchGate.Handover({deployKey: admin, owner: timelock, roleEpoch: liveRoles, timelockCalls: calls});
        d.roleEpochProven = proven;
        if (!LaunchGateDeployment.isDeployed()) {
            d.reason =
                "Launch: the LaunchGate is not deployed at its address - run script/DeployLaunchGate.s.sol (the contracts phase does)";
            return d;
        }
        d.path = Path.TimelockProposal;
    }

    /// @notice The Timelock batch that launches `diamond`: ONE call,
    ///         `diamond.launch(epoch, gate, gateCall)`. The Diamond makes the
    ///         gate's `assertReady(diamond, declared, handover)` call itself
    ///         and unpauses only when it returns and the pause epoch is still
    ///         `epoch`, recording the gate as its launch's.
    function launchBatch(
        address diamond,
        LibLaunchReadiness.Declared memory declared,
        ILaunchGate.Handover memory handover,
        uint64 epoch
    ) public pure returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads) {
        targets = new address[](1);
        values = new uint256[](1);
        payloads = new bytes[](1);
        targets[0] = diamond;
        payloads[0] = abi.encodeCall(
            AdminFacet.launch,
            (epoch, LaunchGateDeployment.predicted(), abi.encodeCall(ILaunchGate.assertReady, (diamond, declared, handover)))
        );
    }

    /// @notice The Timelock's id for this chain's launch operation at `epoch`.
    function launchOperationId(
        address diamond,
        LibLaunchReadiness.Declared memory declared,
        ILaunchGate.Handover memory handover,
        uint64 epoch,
        address timelock
    ) public view returns (bytes32) {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launchBatch(diamond, declared, handover, epoch);
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

    /// @notice Who first lifted `diamond`'s birth pause, and when: its launch.
    ///         Zero `by` means it has never been live. Read from storage like
    ///         the epoch; written once by the pause library.
    function firstUnpause(address diamond) public view returns (address by, uint64 at) {
        (by, at) = LibPausable.decodeFirstUnpauseSlot(vm.load(diamond, LibPausable.FIRST_UNPAUSE_SLOT));
    }

    /// @notice Reverts unless `diamond` has launched, by the launch decision
    ///         ({decide}): its first-unpause record (on production, the
    ///         Timelock's; a later incident pause does not hide it), or, for
    ///         a Diamond older than the record, an unpaused Diamond with no
    ///         answered requirement NOT MET on a testnet, or unpaused on
    ///         local anvil.
    /// @return evidence What the launch evidence is, and whether the Diamond
    ///         is paused now: a launched Diamond under an incident pause is
    ///         not live, and the wrappers must not say it is.
    function checkLaunched(address diamond, LibLaunchReadiness.Declared memory declared, address timelock, address admin)
        public
        view
        returns (string memory evidence)
    {
        Decision memory d = decide(diamond, declared, timelock, admin, false);
        if (d.path == Path.Launched) return d.reason;
        _printChecks(d.checks);
        // An unpaused Diamond the decision refuses names why; a paused one
        // with no record simply has not launched, whatever a launch run would
        // do next.
        (address liveBy,) = firstUnpause(diamond);
        revert(
            AdminFacet(diamond).paused() && liveBy == address(0) ? "Launch: the Diamond has not launched" : d.reason
        );
    }

    /// @notice Supplies the role epoch and Timelock call count the handover
    ///         gate proved, in place of `HANDOVER_ROLE_EPOCH` and
    ///         `HANDOVER_TIMELOCK_CALLS`, for a caller that runs this
    ///         contract rather than the script (a test or a fixture).
    function setHandoverProof(uint64 provenEpoch, uint64 provenCalls) external {
        _proofSet = true;
        _proofEpoch = provenEpoch;
        _proofCalls = provenCalls;
    }

    /// @notice The Diamond's role epoch now (`AccessControlFacet.roleEpoch`).
    function roleEpoch(address diamond) public view returns (uint64) {
        return ILaunchReadableDiamond(diamond).roleEpoch();
    }

    /// @notice The launch gate `diamond`'s first unpause went through, or
    ///         zero when it went through a plain unpause (or has not
    ///         happened). Read from storage like the record beside it.
    function firstUnpauseGate(address diamond) public view returns (address) {
        return address(uint160(uint256(vm.load(diamond, LibPausable.FIRST_UNPAUSE_VIA_SLOT))));
    }

    /// @dev What the handover gate proved: {setHandoverProof}, or
    ///      `HANDOVER_ROLE_EPOCH` and `HANDOVER_TIMELOCK_CALLS`, which the
    ///      deploy wrappers set from the handover-gate phase's own output
    ///      (`lib/handover-proof.sh`). `given` is the role epoch's presence;
    ///      `callsGiven` the call count's, which a given proof must carry.
    function _handoverProof() internal view returns (bool given, uint64 epoch, bool callsGiven, uint64 calls) {
        if (_proofSet) return (true, _proofEpoch, true, _proofCalls);
        if (vm.envExists("HANDOVER_ROLE_EPOCH")) {
            given = true;
            epoch = uint64(vm.envUint("HANDOVER_ROLE_EPOCH"));
        }
        if (vm.envExists("HANDOVER_TIMELOCK_CALLS")) {
            callsGiven = true;
            calls = uint64(vm.envUint("HANDOVER_TIMELOCK_CALLS"));
        }
    }

    /// @notice What this chain's launch declares it must match
    ///         ({LibLaunchReadiness.Declared}), from the sources the deploy
    ///         itself wired from, never read back from the configuration
    ///         under test:
    ///           - the CCIP registry: `CCIP_TOKEN_ADMIN_REGISTRY`;
    ///           - the VPFI pool and its rate governor: the artifact's
    ///             `vpfiTokenPool` and `vpfiPoolRateGovernor`, which the
    ///             handover gate proves Timelock-owned and bound to the
    ///             registry and to each other;
    ///           - the lanes: `CCIP_LANE_CHAIN_IDS` (the deploy wrappers
    ///             resolve the per-chain `CCIP_LANE_CHAIN_IDS_<SLUG>` into
    ///             it), as CCIP chain selectors;
    ///           - the WETH: the one configured now, which the proposal
    ///             names for the Safe to verify against the chain's official
    ///             bridge registry (no on-chain record says which token is
    ///             the chain's bridged WETH9). The gate then refuses any
    ///             other;
    ///           - the feed registry: the artifact's `feedRegistry` (#2880),
    ///             the only registry the Diamond may price through.
    function declaredFromEnv(address diamond) public view returns (LibLaunchReadiness.Declared memory d) {
        d.tokenAdminRegistry = vm.envOr("CCIP_TOKEN_ADMIN_REGISTRY", address(0));
        d.vpfiPool = Deployments.readVpfiTokenPoolOptional();
        d.rateGovernor = Deployments.readVpfiPoolRateGovernorOptional();
        uint256[] memory ids = vm.envOr("CCIP_LANE_CHAIN_IDS", ",", new uint256[](0));
        d.lanes = new LibLaunchReadiness.Lane[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            // The peer comes from the remote chain's artifact, through the
            // derivation ConfigureCcip wires the lane with.
            d.lanes[i] = LibLaunchReadiness.Lane({
                selector: Deployments.ccipSelectorForChainId(ids[i]),
                remotePool: Deployments.vpfiLanePoolOptionalForChain(ids[i]),
                remoteToken: Deployments.vpfiLaneTokenOptionalForChain(ids[i])
            });
        }
        try ILaunchReadableDiamond(diamond).getWethContract() returns (address w) {
            d.weth = w;
        } catch {}
        d.mirrorToken = !Deployments.isCanonicalVpfiChainId(block.chainid);
        d.feedRegistry = Deployments.readFeedRegistryOptional();
    }

    /// @dev How a launch record names its gate: nothing for a plain unpause,
    ///      and whether a recorded gate is the one this checkout would
    ///      propose (a later build moves the predicted address; the record
    ///      still names the gate that vouched, whose code is at it).
    function _gateClause(address via) internal view returns (string memory) {
        if (via == address(0)) return "";
        address predicted = LaunchGateDeployment.predicted();
        return string.concat(
            " through launch gate ",
            vm.toString(via),
            via == predicted
                ? " (this checkout's gate)"
                : string.concat(" (not this checkout's gate ", vm.toString(predicted), "; its code is at the recorded address)")
        );
    }

    /// @dev Whether the run holds the admin's private key: a known
    ///      `ADMIN_ADDRESS` alone cannot unpause, so it never makes the
    ///      report or the verdict expect an admin unpause.
    function _adminKeyGiven() internal view returns (bool) {
        return vm.envOr("ADMIN_PRIVATE_KEY", uint256(0)) != 0;
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

    /// @dev What the readiness checks do NOT cover, stated so a green list
    ///      is never read as "ready to lend" (owner decision 2026-10-23).
    function _printNotChecked() internal pure {
        console.log("  [NOT A CHECK] per-asset risk parameters - optional tightenings, and no declared asset list");
        console.log("    exists to check intended values against. An asset with none set backs liquid loans up to");
        console.log("    the health-factor floor (and its tier cap when depth-tiered LTV is on), with no extra");
        console.log("    per-asset LTV ceiling or liquidator-bonus cap (#2696).");
    }

    function _printTimelockProposal(
        address diamond,
        LibLaunchReadiness.Declared memory declared,
        address timelock,
        Decision memory d
    ) internal view {
        address gate = LaunchGateDeployment.predicted();
        ILaunchTimelock tl = ILaunchTimelock(timelock);
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            launchBatch(diamond, declared, d.handover, d.epoch);
        bytes32 salt = launchSalt(diamond);
        uint256 delay = tl.getMinDelay();
        bytes32 id = launchOperationId(diamond, declared, d.handover, d.epoch, timelock);

        string memory state = tl.isOperationDone(id)
            ? "DONE"
            : tl.isOperationReady(id) ? "READY to execute" : tl.isOperationPending(id) ? "PENDING (delay running)" : "not scheduled";

        console.log("The first unpause is ONE Timelock call. Operation state:", state);
        console.log("  diamond.launch(epoch, gate, LaunchGate.assertReady(diamond, declared, handover))");
        console.log("    the Diamond calls the gate itself, which re-reads every check above when executed,");
        console.log("    and unpauses only if it returns; its first-unpause record then names this gate");
        console.log("    gate:", gate);
        console.log("    epoch:", uint256(d.epoch));
        console.log("      reverts if a pause or auto-pause is recorded before execution; propose again then");
        console.log("    declared - REVIEW each value before signing; the gate refuses anything else:");
        console.log("      tokenAdminRegistry:", declared.tokenAdminRegistry);
        console.log("      VPFI pool (the artifact's vpfiTokenPool, checked by the handover gate):", declared.vpfiPool);
        console.log("      rate governor (the artifact's vpfiPoolRateGovernor):", declared.rateGovernor);
        console.log("      CCIP lanes (CCIP_LANE_CHAIN_IDS), exactly:", declared.lanes.length);
        for (uint256 i; i < declared.lanes.length; ++i) {
            console.log("        selector:", uint256(declared.lanes[i].selector));
            console.log("          remote pool, the only one accepted (that chain's vpfiTokenPool):", declared.lanes[i].remotePool);
            console.log("          remote token (that chain's vpfiToken or vpfiMirror):", declared.lanes[i].remoteToken);
        }
        console.log(
            declared.mirrorToken
                ? "      VPFI kind: mirror - its tokenPool (mint authority) must be the routed pool"
                : "      VPFI kind: canonical (lock/release)"
        );
        console.log("      WETH:", declared.weth);
        console.log("        verify it against the chain's official bridge registry: the bridged WETH9,");
        console.log("        never the wrapped native token (OracleAdminFacet.setWethContract policy)");
        console.log("      feed registry (the artifact's feedRegistry):", declared.feedRegistry);
        console.log("        the chain's VaipakamFeedRegistry; its owner and veto are proven by the handover gate");
        console.log("    handover - the governance state the launch is bound to:");
        console.log("      admin key, which must hold no role:", d.handover.deployKey);
        console.log("      Diamond owner:", d.handover.owner);
        console.log("      role epoch:", uint256(d.handover.roleEpoch));
        console.log(
            d.roleEpochProven
                ? "        the epoch at which the handover gate proved every role's holders; any grant,"
                : "        NOTE: the live epoch, NOT one the handover gate proved in this run (testnet only);"
        );
        console.log(
            d.roleEpochProven
                ? "        revoke or renounce before execution makes the launch revert"
                : "        a launch on production refuses without that proof"
        );
        console.log("      Timelock calls executed so far:", uint256(d.handover.timelockCalls));
        console.log(
            d.roleEpochProven
                ? "        the count the handover gate proved; the launch must be the Timelock's next call:"
                : "        NOTE: the live count, NOT one the handover gate proved (testnet only); the launch"
        );
        console.log(
            d.roleEpochProven
                ? "        if any other queued operation executes first, it reverts - run those first, then"
                : "        must be the Timelock's next call, or it reverts"
        );
        if (d.roleEpochProven) console.log("        re-run the handover gate and propose again");
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
