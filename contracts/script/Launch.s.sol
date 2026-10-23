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
 *          `UNPAUSER_ROLE`; after a rehearsal handover the Timelock batch is
 *          printed instead, exactly as on production, and needs every
 *          requirement met because the gate inside it does.
 *        - **Local Anvil (31337)**: every requirement is printed and an unmet
 *          one is a WARNING, then the admin key unpauses. Local fixtures
 *          carry mocks rather than a full stack, and they relied on the
 *          Diamond being live after the deploy; they now get there through
 *          this step and see what a real chain would refuse.
 *
 *      An already-unpaused Diamond is never recorded as launched on trust.
 *      On production it counts as launched only when the Timelock reports
 *      this checkout's launch operation DONE for some pause epoch; any other
 *      unpause went live outside this step and the run refuses. On a testnet
 *      every answered requirement must still be met. Local anvil just
 *      reports it. So a re-run after a real launch succeeds, and a stray
 *      unpause is never written down as one. The deploy wrappers record the
 *      phase only when `requireLaunched()` — the same evidence rule — passes,
 *      never from the pause bit.
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
 */
contract Launch is Script {
    /// @notice What a launch run did.
    enum Outcome {
        AlreadyLive,
        Unpaused,
        TimelockProposalPrinted
    }

    function run() external returns (Outcome) {
        uint256 adminKey = vm.envOr("ADMIN_PRIVATE_KEY", uint256(0));
        return launch(
            Deployments.readDiamond(), _registryFromEnv(), Deployments.readTimelockOptional(), _adminFromEnv(), adminKey
        );
    }

    /// @notice Reverts unless this chain's launch has happened, by the same
    ///         evidence rule a re-run of the launch applies; changes nothing.
    ///         The deploy wrappers record the launch phase only when this
    ///         passes.
    function requireLaunched() external view {
        checkLaunched(Deployments.readDiamond(), _registryFromEnv(), Deployments.readTimelockOptional(), _adminFromEnv());
        console.log("launched: the launch evidence holds for this chain");
    }

    /// @notice Prints the readiness checks and the pause state, and changes
    ///         nothing (the deploy scripts' verify phases call this). Returns
    ///         whether a launch would proceed on this chain's rules.
    function report() external view returns (bool ready) {
        address diamond = Deployments.readDiamond();
        LibLaunchReadiness.Check[] memory checks = LibLaunchReadiness.check(diamond, _registryFromEnv());
        console.log("Launch readiness (report only)");
        console.log("  paused:", AdminFacet(diamond).paused());
        _printChecks(checks);
        console.log("  launch gate:", LaunchGateDeployment.predicted());
        console.log(
            LaunchGateDeployment.isDeployed()
                ? "    deployed (a Timelock launch re-checks the list above inside its execution)"
                : "    NOT deployed - run script/DeployLaunchGate.s.sol before a Timelock launch"
        );
        ready = Deployments.requiresProductionGovernance()
            ? (LibLaunchReadiness.allMet(checks) && LaunchGateDeployment.isDeployed())
            : LibLaunchReadiness.noneUnmet(checks);
        console.log(ready ? "  -> a launch would proceed" : "  -> a launch would REFUSE until the checks above are met");
    }

    /// @notice Reads readiness and either unpauses or prints the Timelock
    ///         proposal, per the chain rules above.
    /// @param tokenAdminRegistry The chain's CCIP TokenAdminRegistry, or zero.
    /// @param admin The admin key's address: the Timelock batch re-checks
    ///        that it holds no Diamond role, so every Timelock path needs it.
    /// @param adminKey The admin's private key, or zero when the run must
    ///        not (or cannot) broadcast. Never used on a production chain.
    function launch(address diamond, address tokenAdminRegistry, address timelock, address admin, uint256 adminKey)
        public
        returns (Outcome)
    {
        require(diamond.code.length != 0, "Launch: the artifact's diamond has no code on this chain");
        bool production = Deployments.requiresProductionGovernance();
        bool local = block.chainid == 31337;

        console.log("Launch readiness");
        console.log("  diamond: ", diamond);
        console.log("  mode:    ", production ? "production (Timelock unpauses)" : local ? "local anvil" : "testnet");

        if (!AdminFacet(diamond).paused()) {
            console.log("The Diamond is already unpaused.");
            checkLaunched(diamond, tokenAdminRegistry, timelock, admin);
            return Outcome.AlreadyLive;
        }

        LibLaunchReadiness.Check[] memory checks = LibLaunchReadiness.check(diamond, tokenAdminRegistry);
        _printChecks(checks);

        if (production) {
            require(
                LibLaunchReadiness.allMet(checks),
                "Launch: a production Diamond is unpaused only when every readiness check is met (NOT MET and NOT CHECKED both refuse)"
            );
        } else if (!local) {
            require(LibLaunchReadiness.noneUnmet(checks), "Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run");
        } else if (!LibLaunchReadiness.noneUnmet(checks)) {
            console.log("WARNING: local anvil - unpausing with the NOT MET checks above; a testnet or production launch would refuse");
        }

        bool timelockHolds =
            timelock != address(0) && IRoleTable(diamond).hasRole(LibAccessControl.UNPAUSER_ROLE, timelock);
        bool adminHolds = admin != address(0) && IRoleTable(diamond).hasRole(LibAccessControl.UNPAUSER_ROLE, admin);

        if (production) {
            require(timelockHolds, "Launch: the Timelock does not hold UNPAUSER_ROLE - run the handover and its gate first");
            _requireAdminHoldsNoRole(diamond, admin);
            _printTimelockProposal(diamond, tokenAdminRegistry, timelock, admin);
            return Outcome.TimelockProposalPrinted;
        }

        if (adminHolds && adminKey != 0) {
            vm.broadcast(adminKey);
            AdminFacet(diamond).unpause();
            console.log("Unpaused by the admin key:", admin);
            return Outcome.Unpaused;
        }
        if (timelockHolds) {
            require(
                LibLaunchReadiness.allMet(checks),
                "Launch: a Timelock launch needs every readiness check met - the LaunchGate inside the batch refuses NOT CHECKED too"
            );
            _requireAdminHoldsNoRole(diamond, admin);
            _printTimelockProposal(diamond, tokenAdminRegistry, timelock, admin);
            return Outcome.TimelockProposalPrinted;
        }
        revert("Launch: neither the admin key (ADMIN_PRIVATE_KEY) nor the Timelock holds UNPAUSER_ROLE");
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

    /// @notice Reverts unless `diamond` has launched, by this chain's rule.
    /// @dev An unpaused Diamond is recorded as launched only on evidence:
    ///      - production: the Timelock reports this checkout's launch
    ///        operation DONE at some pause epoch. Its execution unpaused the
    ///        Diamond and so moved the epoch past the one it was bound to;
    ///        every earlier epoch is searched, so a later incident pause and
    ///        its lifting do not hide it. The current pause state is not
    ///        read: a launched Diamond paused for an incident since has still
    ///        launched;
    ///      - testnet: unpaused, and no answered requirement NOT MET;
    ///      - local anvil: unpaused.
    function checkLaunched(address diamond, address tokenAdminRegistry, address timelock, address admin)
        public
        view
    {
        require(diamond.code.length != 0, "Launch: the artifact's diamond has no code on this chain");
        if (Deployments.requiresProductionGovernance()) {
            require(
                _launchOperationDone(diamond, tokenAdminRegistry, timelock, admin),
                "Launch: the Timelock has not executed this checkout's launch operation - the Diamond went live outside the launch step, the launch used a different LaunchGate build, registry or admin address, or it has not launched; investigate before anything records a launch"
            );
            console.log("  the Timelock executed the launch operation - launched.");
            return;
        }
        require(!AdminFacet(diamond).paused(), "Launch: the Diamond is paused - it has not launched");
        if (block.chainid == 31337) return;
        LibLaunchReadiness.Check[] memory checks = LibLaunchReadiness.check(diamond, tokenAdminRegistry);
        _printChecks(checks);
        require(
            LibLaunchReadiness.noneUnmet(checks),
            "Launch: the Diamond is unpaused but a readiness check is NOT MET - it went live before it was ready; complete the phase named above, then re-run"
        );
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

    /// @dev The handover ends with the admin key holding NO Diamond role
    ///      (#669), and a Diamond goes live through the Timelock only in that
    ///      state: every role `LibAccessControl.knownRoles()` lists is
    ///      checked, the same rule the gate re-applies on execution.
    function _requireAdminHoldsNoRole(address diamond, address admin) internal view {
        require(admin != address(0), "Launch: set ADMIN_ADDRESS so the run can prove the admin key holds no role");
        (bool held, bytes32 role) = LibLaunchReadiness.firstRoleHeld(diamond, admin);
        if (held) {
            console.log("  the admin key still holds role:");
            console.logBytes32(role);
            revert("Launch: the admin key still holds a Diamond role - the handover is not complete");
        }
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

    function _printTimelockProposal(address diamond, address tokenAdminRegistry, address timelock, address admin)
        internal
        view
    {
        address gate = LaunchGateDeployment.predicted();
        require(
            gate.code.length != 0,
            "Launch: the LaunchGate is not deployed at its address - run script/DeployLaunchGate.s.sol (the contracts phase does)"
        );
        ILaunchTimelock tl = ILaunchTimelock(timelock);
        uint64 epoch = pauseEpoch(diamond);
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
