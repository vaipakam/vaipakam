// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
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
 *          neither it nor the role root. The script broadcasts NOTHING. It
 *          prints the `scheduleBatch` call for the Governance Safe to propose
 *          through the Timelock, the `executeBatch` call for after the delay,
 *          and the operation's current state. So a production Diamond is
 *          never live under the hot admin key, and its first unpause waits
 *          out the same review window as any other governance action.
 *
 *          The operation is a batch of `LaunchGate.assertReady` then
 *          `unpause()`, so every requirement is read AGAIN, on-chain, in the
 *          transaction that unpauses: one that stopped holding during the
 *          delay reverts the execution and the Diamond stays paused.
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
 *      this launch operation DONE; any other unpause went live outside this
 *      step and the run refuses. On a testnet every answered requirement
 *      must still be met. Local anvil just reports it. So a re-run after a
 *      real launch succeeds, and a stray unpause is never written down as
 *      one.
 *
 *      Run (`deploy-{mainnet,testnet}.sh <slug> --phase launch` does this):
 *        forge script script/Launch.s.sol --rpc-url $RPC [--broadcast]
 *
 * @dev Env:
 *        CHAIN_SLUG or ADDRESSES_JSON_PATH — the artifact (`diamond`,
 *            `timelock`, `vpfiTokenPool`). The gate is not read from it:
 *            its address follows from this checkout's bytecode
 *            (`LaunchGateDeployment`).
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
        address admin = adminKey != 0 ? vm.addr(adminKey) : vm.envOr("ADMIN_ADDRESS", address(0));
        return launch(
            Deployments.readDiamond(),
            Deployments.readVpfiTokenPoolOptional(),
            Deployments.readTimelockOptional(),
            admin,
            adminKey
        );
    }

    /// @notice Prints the readiness checks and the pause state, and changes
    ///         nothing (the deploy scripts' verify phases call this). Returns
    ///         whether a launch would proceed on this chain's rules.
    function report() external view returns (bool ready) {
        address diamond = Deployments.readDiamond();
        LibLaunchReadiness.Check[] memory checks =
            LibLaunchReadiness.check(diamond, Deployments.readVpfiTokenPoolOptional());
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
    /// @param adminKey The admin's private key, or zero when the run must
    ///        not (or cannot) broadcast. Never used on a production chain.
    function launch(address diamond, address pool, address timelock, address admin, uint256 adminKey)
        public
        returns (Outcome)
    {
        require(diamond.code.length != 0, "Launch: the artifact's diamond has no code on this chain");
        bool production = Deployments.requiresProductionGovernance();
        bool local = block.chainid == 31337;

        console.log("Launch readiness");
        console.log("  diamond: ", diamond);
        console.log("  mode:    ", production ? "production (Timelock unpauses)" : local ? "local anvil" : "testnet");

        if (!AdminFacet(diamond).paused()) return _alreadyLive(diamond, pool, timelock, production, local);

        LibLaunchReadiness.Check[] memory checks = LibLaunchReadiness.check(diamond, pool);
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
            require(admin != address(0), "Launch: set ADMIN_ADDRESS so the run can prove the admin key holds no role");
            require(
                !adminHolds && !IRoleTable(diamond).hasRole(bytes32(0), admin),
                "Launch: the admin key still holds UNPAUSER_ROLE or the role root - the handover is not complete"
            );
            _printTimelockProposal(diamond, pool, timelock);
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
            _printTimelockProposal(diamond, pool, timelock);
            return Outcome.TimelockProposalPrinted;
        }
        revert("Launch: neither the admin key (ADMIN_PRIVATE_KEY) nor the Timelock holds UNPAUSER_ROLE");
    }

    /// @notice The Timelock batch that launches `diamond`: the gate re-reads
    ///         every requirement, then the Diamond is unpaused. Both calls
    ///         land in one execution or neither does.
    function launchBatch(address diamond, address pool)
        public
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        targets = new address[](2);
        values = new uint256[](2);
        payloads = new bytes[](2);
        targets[0] = LaunchGateDeployment.predicted();
        payloads[0] = abi.encodeCall(LaunchGate.assertReady, (diamond, pool));
        targets[1] = diamond;
        payloads[1] = abi.encodeCall(AdminFacet.unpause, ());
    }

    /// @notice The Timelock's id for this chain's launch operation.
    function launchOperationId(address diamond, address pool, address timelock) public view returns (bytes32) {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = launchBatch(diamond, pool);
        return ILaunchTimelock(timelock).hashOperationBatch(targets, values, payloads, bytes32(0), launchSalt(diamond));
    }

    /// @notice The salt every launch proposal for `diamond` on this chain
    ///         uses, so a re-run finds the operation it printed before.
    function launchSalt(address diamond) public view returns (bytes32) {
        return keccak256(abi.encodePacked("vaipakam-launch-unpause:", block.chainid, diamond));
    }

    /// @dev An unpaused Diamond is recorded as launched only on evidence.
    function _alreadyLive(address diamond, address pool, address timelock, bool production, bool local)
        internal
        view
        returns (Outcome)
    {
        console.log("The Diamond is already unpaused.");
        if (production) {
            require(
                timelock != address(0) && timelock.code.length != 0
                    && ILaunchTimelock(timelock).isOperationDone(launchOperationId(diamond, pool, timelock)),
                "Launch: the Diamond is unpaused but the Timelock has not executed this checkout's launch operation - it went live outside the launch step, or the launch used a different LaunchGate build; investigate before anything records a launch"
            );
            console.log("  the Timelock executed the launch operation - launched.");
            return Outcome.AlreadyLive;
        }
        if (local) return Outcome.AlreadyLive;
        LibLaunchReadiness.Check[] memory checks = LibLaunchReadiness.check(diamond, pool);
        _printChecks(checks);
        require(
            LibLaunchReadiness.noneUnmet(checks),
            "Launch: the Diamond is unpaused but a readiness check is NOT MET - it went live before it was ready; complete the phase named above, then re-run"
        );
        return Outcome.AlreadyLive;
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

    function _printTimelockProposal(address diamond, address pool, address timelock) internal view {
        address gate = LaunchGateDeployment.predicted();
        require(
            gate.code.length != 0,
            "Launch: the LaunchGate is not deployed at its address - run script/DeployLaunchGate.s.sol (the contracts phase does)"
        );
        ILaunchTimelock tl = ILaunchTimelock(timelock);
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = launchBatch(diamond, pool);
        bytes32 salt = launchSalt(diamond);
        uint256 delay = tl.getMinDelay();
        bytes32 id = launchOperationId(diamond, pool, timelock);

        string memory state = tl.isOperationDone(id)
            ? "DONE"
            : tl.isOperationReady(id) ? "READY to execute" : tl.isOperationPending(id) ? "PENDING (delay running)" : "not scheduled";

        console.log("The first unpause is a Timelock batch. Operation state:", state);
        console.log("  call 1: LaunchGate.assertReady(diamond, vpfiTokenPool) - re-reads every check above when executed");
        console.log("    gate:", gate);
        console.log("    vpfiTokenPool:", pool);
        console.log("  call 2: diamond.unpause()");
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
