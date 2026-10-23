// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {Deployments} from "./lib/Deployments.sol";
import {LaunchReadiness} from "./lib/LaunchReadiness.sol";

/// @dev The role read this script needs of the Diamond.
interface IRoleTable {
    function hasRole(bytes32 role, address account) external view returns (bool);
}

/// @dev The reads this script needs of the OpenZeppelin `TimelockController`.
interface ILaunchTimelock {
    function getMinDelay() external view returns (uint256);
    function hashOperation(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt)
        external
        pure
        returns (bytes32);
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
 *      `LaunchReadiness` requirement off the live chain. Who unpauses depends
 *      on the chain (owner decision 2026-10-23, "Timelock unpauses after
 *      handover"):
 *
 *        - **Production** (every chain `Deployments.requiresProductionGovernance`
 *          gates): every requirement must be met AND the handover must be
 *          done — the Timelock holds `UNPAUSER_ROLE` and the admin key holds
 *          neither it nor the role root. The script broadcasts NOTHING. It
 *          prints the `schedule` call for the Governance Safe to propose
 *          through the Timelock, the `execute` call for after the delay, and
 *          the operation's current state. So a production Diamond is never
 *          live under the hot admin key, and its first unpause waits out the
 *          same review window as any other governance action.
 *        - **Known testnet**: no requirement may be NOT MET; one the chain
 *          cannot answer is printed as NOT CHECKED (a rehearsal may lack part
 *          of the stack). The admin key unpauses directly while it holds
 *          `UNPAUSER_ROLE`; after a rehearsal handover the Timelock calldata
 *          is printed instead, exactly as on production.
 *        - **Local Anvil (31337)**: every requirement is printed and an unmet
 *          one is a WARNING, then the admin key unpauses. Local fixtures
 *          carry mocks rather than a full stack, and they relied on the
 *          Diamond being live after the deploy; they now get there through
 *          this step and see what a real chain would refuse.
 *
 *      A Diamond that is already unpaused is reported and left alone, so the
 *      step is safe to re-run.
 *
 *      Run (`deploy-{mainnet,testnet}.sh <slug> --phase launch` does this):
 *        forge script script/Launch.s.sol --rpc-url $RPC [--broadcast]
 *
 * @dev Env:
 *        CHAIN_SLUG or ADDRESSES_JSON_PATH — the artifact (`diamond`,
 *            `timelock`, `vpfiTokenPool`).
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
        LaunchReadiness.Check[] memory checks =
            LaunchReadiness.check(diamond, Deployments.readVpfiTokenPoolOptional());
        console.log("Launch readiness (report only)");
        console.log("  paused:", AdminFacet(diamond).paused());
        for (uint256 i; i < checks.length; ++i) {
            console.log(
                string.concat("  [", LaunchReadiness.verdict(checks[i]), "] ", checks[i].label, " - ", checks[i].detail)
            );
        }
        ready = Deployments.requiresProductionGovernance()
            ? LaunchReadiness.allMet(checks)
            : LaunchReadiness.noneUnmet(checks);
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

        if (!AdminFacet(diamond).paused()) {
            console.log("The Diamond is already unpaused - nothing to launch.");
            return Outcome.AlreadyLive;
        }

        LaunchReadiness.Check[] memory checks = LaunchReadiness.check(diamond, pool);
        for (uint256 i; i < checks.length; ++i) {
            console.log(
                string.concat("  [", LaunchReadiness.verdict(checks[i]), "] ", checks[i].label, " - ", checks[i].detail)
            );
        }

        if (production) {
            require(
                LaunchReadiness.allMet(checks),
                "Launch: a production Diamond is unpaused only when every readiness check is met (NOT MET and NOT CHECKED both refuse)"
            );
        } else if (!local) {
            require(LaunchReadiness.noneUnmet(checks), "Launch: a readiness check is NOT MET - complete the deploy phase it names, then re-run");
        } else if (!LaunchReadiness.noneUnmet(checks)) {
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
            _printTimelockProposal(diamond, timelock);
            return Outcome.TimelockProposalPrinted;
        }

        if (adminHolds && adminKey != 0) {
            vm.broadcast(adminKey);
            AdminFacet(diamond).unpause();
            console.log("Unpaused by the admin key:", admin);
            return Outcome.Unpaused;
        }
        if (timelockHolds) {
            _printTimelockProposal(diamond, timelock);
            return Outcome.TimelockProposalPrinted;
        }
        revert("Launch: neither the admin key (ADMIN_PRIVATE_KEY) nor the Timelock holds UNPAUSER_ROLE");
    }

    /// @notice The salt every launch proposal for `diamond` on this chain
    ///         uses, so a re-run finds the operation it printed before.
    function launchSalt(address diamond) public view returns (bytes32) {
        return keccak256(abi.encodePacked("vaipakam-launch-unpause:", block.chainid, diamond));
    }

    function _printTimelockProposal(address diamond, address timelock) internal view {
        ILaunchTimelock tl = ILaunchTimelock(timelock);
        bytes memory data = abi.encodeCall(AdminFacet.unpause, ());
        bytes32 salt = launchSalt(diamond);
        uint256 delay = tl.getMinDelay();
        bytes32 id = tl.hashOperation(diamond, 0, data, bytes32(0), salt);

        string memory state = tl.isOperationDone(id)
            ? "DONE"
            : tl.isOperationReady(id) ? "READY to execute" : tl.isOperationPending(id) ? "PENDING (delay running)" : "not scheduled";

        console.log("The first unpause is a Timelock action. Operation state:", state);
        console.log("  1. The Governance Safe calls the Timelock with:");
        console.log("     to:  ", timelock);
        console.logBytes(
            abi.encodeWithSignature(
                "schedule(address,uint256,bytes,bytes32,bytes32,uint256)", diamond, 0, data, bytes32(0), salt, delay
            )
        );
        console.log("  2. After the delay (seconds):", delay);
        console.log("     anyone calls the Timelock with:");
        console.logBytes(
            abi.encodeWithSignature("execute(address,uint256,bytes,bytes32,bytes32)", diamond, 0, data, bytes32(0), salt)
        );
        console.log("  operation id:");
        console.logBytes32(id);
    }
}
