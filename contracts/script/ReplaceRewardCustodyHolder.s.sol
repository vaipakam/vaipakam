// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {RewardCustodyHolder} from "../src/RewardCustodyHolder.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title  ReplaceRewardCustodyHolder — the paused holder-replacement
 *         ceremony, executable before AND after governance handover, with
 *         the deployment artifact reconciled only against chain state
 *         (#1566 slice 4 PR A, design §5d; Codex #2158 r1 P2 + r2 P1)
 *
 * @notice Three entry points, one ceremony:
 *
 *  - `run()`     — DIRECT. One key holds `ADMIN_ROLE` and, when the Diamond
 *                  is not already paused, `PAUSER_ROLE` + `UNPAUSER_ROLE`
 *                  (testnets stay deployer/admin-owned, and every chain is
 *                  in this state before `Handover`). Deploys the successor,
 *                  pauses if needed, replaces, restores the pause state,
 *                  verifies the pointer and rewrites `.rewardCustodyHolder`.
 *                  Refuses — before any broadcast — when the key lacks a
 *                  role it would need, and points at `stage()`.
 *  - `stage()`   — STAGED, for a handed-over deployment where
 *                  `Handover.s.sol` put `ADMIN_ROLE` + `UNPAUSER_ROLE` on the
 *                  Timelock and `PAUSER_ROLE` on the Pauser Safe, so no single
 *                  key can run the three calls. Deploys the successor (any
 *                  funded key; the constructor is permissionless) and writes
 *                  a CEREMONY RECORD next to the artifact —
 *                  `deployments/<chain-slug>/reward-custody-replacement.json`
 *                  — holding the previous holder, the successor and the three
 *                  calldatas each signer executes against the Diamond:
 *                    1. Pauser Safe:  `pause()`            (skip if already paused)
 *                    2. Timelock:     `replaceRewardCustodyHolder(successor)`
 *                    3. Timelock:     `unpause()`          (skip if it was paused before)
 *                  Nothing on-chain changes in this step beyond the successor
 *                  deployment, and the artifact is NOT touched: an
 *                  unexecuted successor is not custody.
 *  - `record()`  — after the signers executed the bundle: reads the ceremony
 *                  record, requires the Diamond to report the successor as
 *                  the bound holder, rewrites `.rewardCustodyHolder`, and
 *                  removes the ceremony record. Refuses while the pointer
 *                  still reads the previous holder (the bundle has not
 *                  executed) or reads a third address (the record is stale).
 *
 * @dev    Why the artifact is written only from chain state, in both modes:
 *         `addresses.json` is what `Deployments` documents as the source of
 *         truth for later scripts and the package sync. Writing the successor
 *         at staging time would advertise custody that has not moved;
 *         writing it only after the pointer is read back cannot lie.
 *
 *         Refuses, in every mode, when the artifact's `.rewardCustodyHolder`
 *         already disagrees with the bound holder — the two records are
 *         already out of step and an operator must reconcile them before a
 *         replacement widens the gap — and when no holder is bound
 *         (`DeployRewardCustodyHolder` first).
 *
 *         Env:
 *           - `ADMIN_PRIVATE_KEY`     — `run()`: the role-holding key.
 *           - `DEPLOYER_PRIVATE_KEY`  — `stage()`: any funded key, deploys
 *                                        the successor only.
 *           - the Diamond and the recorded holder from `addresses.json`.
 *
 *         Artifact writes follow the same dry-run / `DEPLOY_SKIP_ARTIFACTS`
 *         rule as every deploy script; the ceremony record is written
 *         unconditionally by `stage()` because it IS the staged state.
 */
contract ReplaceRewardCustodyHolder is Script {
    // ─── Shared preconditions ───────────────────────────────────────────────

    struct Ctx {
        address diamond;
        address bound;
    }

    function _ctx() internal view returns (Ctx memory c) {
        c.diamond = Deployments.readDiamond();
        c.bound = RewardCustodyFacet(c.diamond).rewardCustodyHolder();
        require(
            c.bound != address(0),
            "ReplaceRewardCustodyHolder: no holder is bound -- run DeployRewardCustodyHolder first"
        );
        address recorded = Deployments.readRewardCustodyHolderOptional();
        require(
            recorded == c.bound,
            "ReplaceRewardCustodyHolder: the artifact's .rewardCustodyHolder does not match the bound holder -- reconcile the record before replacing"
        );
    }

    function _recordPath() internal view returns (string memory) {
        return string.concat("deployments/", Deployments.chainSlug(), "/reward-custody-replacement.json");
    }

    function _writeArtifact(address successor) internal {
        if (!Deployments.artifactWritesEnabled()) {
            console.log("artifact writes are off for this run -- .rewardCustodyHolder NOT rewritten; the artifact is STALE until it is.");
            return;
        }
        Deployments.writeRewardCustodyHolder(successor);
        console.log("Recorded .rewardCustodyHolder =", successor, "in", Deployments.path());
    }

    // ─── DIRECT ─────────────────────────────────────────────────────────────

    function run() external {
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address admin = vm.addr(adminKey);
        Ctx memory c = _ctx();
        AccessControlFacet acl = AccessControlFacet(c.diamond);
        bool wasPaused = AdminFacet(c.diamond).paused();

        // Every role the direct path will exercise is checked BEFORE any
        // broadcast, so a handed-over deployment is told to stage rather
        // than failing on the second of three transactions.
        require(
            acl.hasRole(LibAccessControl.ADMIN_ROLE, admin),
            "ReplaceRewardCustodyHolder: ADMIN_PRIVATE_KEY does not hold ADMIN_ROLE -- after governance handover use stage() / record()"
        );
        require(
            wasPaused
                || (
                    acl.hasRole(LibAccessControl.PAUSER_ROLE, admin)
                        && acl.hasRole(LibAccessControl.UNPAUSER_ROLE, admin)
                ),
            "ReplaceRewardCustodyHolder: the Diamond is not paused and ADMIN_PRIVATE_KEY does not hold PAUSER_ROLE + UNPAUSER_ROLE -- pause it through the Pauser Safe first, or use stage() / record()"
        );

        console.log("=== Reward custody holder replacement (direct) ===");
        console.log("Diamond:         ", c.diamond);
        console.log("Previous holder: ", c.bound);
        console.log("Admin:           ", admin);

        vm.startBroadcast(adminKey);
        if (!wasPaused) AdminFacet(c.diamond).pause();
        RewardCustodyHolder successor = new RewardCustodyHolder(c.diamond);
        RewardCustodyFacet(c.diamond).replaceRewardCustodyHolder(address(successor));
        if (!wasPaused) AdminFacet(c.diamond).unpause();
        vm.stopBroadcast();

        require(
            RewardCustodyFacet(c.diamond).rewardCustodyHolder() == address(successor),
            "ReplaceRewardCustodyHolder: the pointer did not flip to the successor"
        );
        console.log("Successor holder:", address(successor));
        _writeArtifact(address(successor));
    }

    // ─── STAGED ─────────────────────────────────────────────────────────────

    function stage() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Ctx memory c = _ctx();
        require(
            !vm.exists(_recordPath()),
            "ReplaceRewardCustodyHolder: a ceremony record already exists -- run record() once the bundle has executed, or remove the stale record deliberately"
        );
        bool wasPaused = AdminFacet(c.diamond).paused();

        vm.startBroadcast(deployerKey);
        RewardCustodyHolder successor = new RewardCustodyHolder(c.diamond);
        vm.stopBroadcast();

        bytes memory pauseCall = abi.encodeCall(AdminFacet.pause, ());
        bytes memory replaceCall =
            abi.encodeCall(RewardCustodyFacet.replaceRewardCustodyHolder, (address(successor)));
        bytes memory unpauseCall = abi.encodeCall(AdminFacet.unpause, ());

        string memory obj = "ceremony";
        vm.serializeAddress(obj, "diamond", c.diamond);
        vm.serializeAddress(obj, "previousHolder", c.bound);
        vm.serializeAddress(obj, "successor", address(successor));
        vm.serializeBool(obj, "diamondWasPaused", wasPaused);
        vm.serializeUint(obj, "stagedAtBlock", block.number);
        vm.serializeBytes(obj, "step1_pauserSafe_pause", pauseCall);
        vm.serializeBytes(obj, "step2_timelock_replaceRewardCustodyHolder", replaceCall);
        string memory json = vm.serializeBytes(obj, "step3_timelock_unpause", unpauseCall);
        vm.writeJson(json, _recordPath());

        console.log("=== Reward custody holder replacement (staged) ===");
        console.log("Diamond:         ", c.diamond);
        console.log("Previous holder: ", c.bound);
        console.log("Successor:       ", address(successor));
        console.log("Ceremony record: ", _recordPath());
        console.log("Execute against the Diamond, in order:");
        if (wasPaused) {
            console.log("  1. (already paused - skip)");
        } else {
            console.log("  1. Pauser Safe  pause()");
            console.logBytes(pauseCall);
        }
        console.log("  2. Timelock     replaceRewardCustodyHolder(successor)");
        console.logBytes(replaceCall);
        if (wasPaused) {
            console.log("  3. (was paused before - leave it; skip)");
        } else {
            console.log("  3. Timelock     unpause()");
            console.logBytes(unpauseCall);
        }
        console.log("Then run record() to reconcile the artifact. The artifact is unchanged until then.");
    }

    function record() external {
        require(
            vm.exists(_recordPath()),
            "ReplaceRewardCustodyHolder: no ceremony record -- run stage() first"
        );
        string memory json = vm.readFile(_recordPath());
        address diamond = vm.parseJsonAddress(json, ".diamond");
        address previous = vm.parseJsonAddress(json, ".previousHolder");
        address successor = vm.parseJsonAddress(json, ".successor");
        require(
            diamond == Deployments.readDiamond(),
            "ReplaceRewardCustodyHolder: the ceremony record names a different Diamond"
        );

        address bound = RewardCustodyFacet(diamond).rewardCustodyHolder();
        require(
            bound != previous,
            "ReplaceRewardCustodyHolder: the Diamond still reports the previous holder -- the bundle has not executed"
        );
        require(
            bound == successor,
            "ReplaceRewardCustodyHolder: the Diamond reports a holder that is neither the previous nor the staged successor -- the ceremony record is stale; reconcile by hand"
        );

        console.log("=== Reward custody holder replacement (record) ===");
        console.log("Diamond:         ", diamond);
        console.log("Previous holder: ", previous);
        console.log("Bound successor: ", bound);
        _writeArtifact(successor);
        vm.removeFile(_recordPath());
        console.log("Ceremony record removed:", _recordPath());
    }
}
