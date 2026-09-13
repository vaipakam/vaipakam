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
 *         (#1566 slice 4 PR A, design §5d; Codex #2158 r1 P2, r2 P1, r3)
 *
 * @notice The Diamond constructs the successor itself inside
 *         `replaceRewardCustodyHolder()` — one transaction creates it,
 *         moves the old holder's whole balance into it and flips the
 *         pointer. No address is staged, supplied or predicted by anyone
 *         here. Three entry points, one ceremony:
 *
 *  - `run()`     — DIRECT. One key holds `ADMIN_ROLE` and, when the Diamond
 *                  is not already paused, `PAUSER_ROLE` + `UNPAUSER_ROLE`
 *                  (testnets stay deployer/admin-owned, and every chain is
 *                  in this state before `Handover`). Pauses if needed,
 *                  replaces, restores the pause state ONLY when no auto-pause
 *                  began meanwhile, verifies the pointer and rewrites
 *                  `.rewardCustodyHolder`. Refuses — before any broadcast —
 *                  when the key lacks a role it would need, and points at
 *                  `stage()`.
 *  - `stage()`   — STAGED, for a handed-over deployment where
 *                  `Handover.s.sol` put `ADMIN_ROLE` + `UNPAUSER_ROLE` on the
 *                  Timelock and `PAUSER_ROLE` on the Pauser Safe, so no single
 *                  key can run the calls. Broadcasts nothing. Writes a
 *                  CEREMONY RECORD next to the artifact —
 *                  `deployments/<chain-slug>/reward-custody-replacement.json`
 *                  — holding the previous holder and the calldata each signer
 *                  executes against the Diamond:
 *                    1. Pauser Safe:  `pause()`   (skip if already paused)
 *                    2. Timelock:     `replaceRewardCustodyHolder()`
 *                  There is deliberately NO third step. A pre-authorised
 *                  `unpause()` scheduled today would execute whatever else
 *                  paused the Diamond in the meantime — an incident pause,
 *                  an auto-pause — because `unpause` clears both (Codex #2158
 *                  r3 P1). The replaced Diamond stays paused; resuming
 *                  service is a fresh decision by the Unpauser after
 *                  `record()` confirms the ceremony and nothing else is
 *                  holding the pause.
 *  - `record()`  — after the signers executed the bundle: reads the ceremony
 *                  record, requires the Diamond to report a holder OTHER than
 *                  the previous one that answers to this Diamond, rewrites
 *                  `.rewardCustodyHolder` from that chain state, and removes
 *                  the ceremony record. Refuses while the pointer still reads
 *                  the previous holder (the bundle has not executed).
 *
 * @dev    Why the artifact is written only from chain state, in both modes:
 *         `addresses.json` is what `Deployments` documents as the source of
 *         truth for later scripts and the package sync. Nothing is written
 *         from intent — a staged ceremony is not custody.
 *
 *         Why the ceremony record and its removal follow the artifact's own
 *         write rule (`Deployments.artifactWritesEnabled()`, Codex #2158 r3
 *         P2): a plain `forge script` simulation must neither invent a
 *         record (which would make the real `stage()` refuse on "already
 *         staged") nor erase the only reconciliation record while skipping
 *         the artifact write it exists to gate.
 *
 *         Refuses, in every mode, when the artifact's `.rewardCustodyHolder`
 *         already disagrees with the bound holder — the two records are
 *         already out of step and an operator must reconcile them before a
 *         replacement widens the gap — and when no holder is bound
 *         (`DeployRewardCustodyHolder` first).
 *
 *         Env:
 *           - `ADMIN_PRIVATE_KEY` — `run()` only: the role-holding key.
 *           - the Diamond and the recorded holder from `addresses.json`.
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

    /// @dev The artifact follows chain state only: the bound holder is read
    ///      back, required to differ from `previous` and to answer to this
    ///      Diamond, and THEN recorded.
    function _verifyAndRecord(address diamond, address previous) internal returns (address successor) {
        successor = RewardCustodyFacet(diamond).rewardCustodyHolder();
        require(
            successor != address(0) && successor != previous,
            "ReplaceRewardCustodyHolder: the Diamond still reports the previous holder -- the replacement has not executed"
        );
        require(
            RewardCustodyHolder(successor).DIAMOND() == diamond,
            "ReplaceRewardCustodyHolder: the bound holder does not answer to this Diamond"
        );
        console.log("Successor holder:", successor);
        if (!Deployments.artifactWritesEnabled()) {
            console.log("artifact writes are off for this run -- .rewardCustodyHolder NOT rewritten; the artifact is STALE until it is.");
            return successor;
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
        AdminFacet adminFacet = AdminFacet(c.diamond);
        bool wasPaused = adminFacet.paused();

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
        if (!wasPaused) adminFacet.pause();
        RewardCustodyFacet(c.diamond).replaceRewardCustodyHolder();
        // Restore the pause state this script created — and ONLY that state.
        // An auto-pause that began between the two calls sets a bounded
        // window; lifting it here would end an incident response on the
        // way out of a maintenance step, so it is left in place and named.
        if (!wasPaused) {
            if (adminFacet.pausedUntil() != 0) {
                console.log("an auto-pause began during the ceremony -- NOT unpausing; resume service deliberately once it has been reviewed");
            } else {
                adminFacet.unpause();
            }
        }
        vm.stopBroadcast();

        _verifyAndRecord(c.diamond, c.bound);
    }

    // ─── STAGED ─────────────────────────────────────────────────────────────

    function stage() external {
        Ctx memory c = _ctx();
        bool wasPaused = AdminFacet(c.diamond).paused();

        bytes memory pauseCall = abi.encodeCall(AdminFacet.pause, ());
        bytes memory replaceCall = abi.encodeCall(RewardCustodyFacet.replaceRewardCustodyHolder, ());

        console.log("=== Reward custody holder replacement (staged) ===");
        console.log("Diamond:         ", c.diamond);
        console.log("Previous holder: ", c.bound);
        console.log("Execute against the Diamond, in order:");
        if (wasPaused) {
            console.log("  1. (already paused - skip)");
        } else {
            console.log("  1. Pauser Safe  pause()");
            console.logBytes(pauseCall);
        }
        console.log("  2. Timelock     replaceRewardCustodyHolder()  -- constructs the successor and moves the balance in that transaction");
        console.logBytes(replaceCall);
        console.log("No unpause is staged: the Diamond stays paused after step 2. Resume service by a fresh Unpauser decision after record() confirms the ceremony.");

        if (!Deployments.artifactWritesEnabled()) {
            console.log("artifact writes are off for this run -- ceremony record NOT written (simulation).");
            return;
        }
        require(
            !vm.exists(_recordPath()),
            "ReplaceRewardCustodyHolder: a ceremony record already exists -- run record() once the bundle has executed, or remove the stale record deliberately"
        );
        string memory obj = "ceremony";
        vm.serializeAddress(obj, "diamond", c.diamond);
        vm.serializeAddress(obj, "previousHolder", c.bound);
        vm.serializeBool(obj, "diamondWasPaused", wasPaused);
        vm.serializeUint(obj, "stagedAtBlock", block.number);
        vm.serializeBytes(obj, "step1_pauserSafe_pause", pauseCall);
        string memory json = vm.serializeBytes(obj, "step2_timelock_replaceRewardCustodyHolder", replaceCall);
        vm.writeJson(json, _recordPath());
        console.log("Ceremony record: ", _recordPath());
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
        require(
            diamond == Deployments.readDiamond(),
            "ReplaceRewardCustodyHolder: the ceremony record names a different Diamond"
        );

        console.log("=== Reward custody holder replacement (record) ===");
        console.log("Diamond:         ", diamond);
        console.log("Previous holder: ", previous);
        _verifyAndRecord(diamond, previous);

        if (!Deployments.artifactWritesEnabled()) {
            console.log("artifact writes are off for this run -- ceremony record kept (simulation).");
            return;
        }
        vm.removeFile(_recordPath());
        console.log("Ceremony record removed:", _recordPath());
    }
}
