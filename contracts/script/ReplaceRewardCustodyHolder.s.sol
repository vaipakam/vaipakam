// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";

import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {RewardCustodyCeremonyBase} from "./lib/RewardCustodyCeremonyBase.sol";

/**
 * @title  ReplaceRewardCustodyHolder — the paused holder-replacement
 *         ceremony, executable before AND after governance handover
 *         (#1566 slice 4 PR A, design §5d; Codex #2158 r1–r4)
 *
 * @notice The Diamond constructs the successor itself inside
 *         `replaceRewardCustodyHolder()` — one transaction creates it, moves
 *         the old holder's whole balance into it and flips the pointer.
 *         Nothing is staged, supplied or predicted here.
 *
 *  - `run()`    — DIRECT: `ADMIN_PRIVATE_KEY` holds `ADMIN_ROLE` and, when the
 *                 Diamond is not already paused, `PAUSER_ROLE`. Pauses if
 *                 needed, replaces, reconciles the artifact from chain state
 *                 — and LEAVES THE DIAMOND PAUSED. Refuses before any
 *                 broadcast when the key lacks a role it would need.
 *  - `stage()`  — STAGED, for a handed-over deployment where `ADMIN_ROLE`
 *                 sits on the Timelock and `PAUSER_ROLE` on the Pauser Safe:
 *                 broadcasts nothing; writes a ceremony record with the
 *                 calldata each signer executes against the Diamond —
 *                   1. Pauser Safe: `pause()`  (skip if already paused)
 *                   2. Timelock:    `replaceRewardCustodyHolder()`
 *  - `record()` — after the signers executed the bundle: rewrites
 *                 `.rewardCustodyHolder` from the chain's own report of a NEW
 *                 holder bound, then removes the record.
 *
 * @dev    No mode resumes service (Codex #2158 r3 P1, r4 P1). A pre-authorised
 *         `unpause()` would execute whatever else paused the Diamond in the
 *         meantime, and a direct-path unpause could clear a concurrent
 *         emergency pause that rewrote the same flag — so the ceremony ends
 *         paused and says so. Resuming service is a fresh decision by the
 *         Unpauser once the reconciliation is confirmed and nothing else is
 *         holding the pause. The shared base (`RewardCustodyCeremonyBase`)
 *         owns the artifact-in-sync check, the ceremony record and the
 *         reconcile-from-chain-state step, identically for the initial bind.
 */
contract ReplaceRewardCustodyHolder is RewardCustodyCeremonyBase {
    string internal constant KIND = "replacement";

    function _boundDiamond() internal view returns (address diamond, address bound) {
        (diamond, bound) = _diamondAndBound();
        require(
            bound != address(0),
            "ReplaceRewardCustodyHolder: no holder is bound -- run DeployRewardCustodyHolder first"
        );
    }

    function run() external {
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address admin = vm.addr(adminKey);
        (address diamond, address previous) = _boundDiamond();
        AccessControlFacet acl = AccessControlFacet(diamond);
        AdminFacet adminFacet = AdminFacet(diamond);
        bool wasPaused = adminFacet.paused();

        // Every role the direct path will exercise is checked BEFORE any
        // broadcast, so a handed-over deployment is told to stage rather
        // than failing on the second transaction.
        require(
            acl.hasRole(LibAccessControl.ADMIN_ROLE, admin),
            "ReplaceRewardCustodyHolder: ADMIN_PRIVATE_KEY does not hold ADMIN_ROLE -- after governance handover use stage() / record()"
        );
        require(
            wasPaused || acl.hasRole(LibAccessControl.PAUSER_ROLE, admin),
            "ReplaceRewardCustodyHolder: the Diamond is not paused and ADMIN_PRIVATE_KEY does not hold PAUSER_ROLE -- pause it through the Pauser Safe first, or use stage() / record()"
        );

        console.log("=== Reward custody holder replacement (direct) ===");
        console.log("Diamond:         ", diamond);
        console.log("Previous holder: ", previous);
        console.log("Admin:           ", admin);

        vm.startBroadcast(adminKey);
        if (!wasPaused) adminFacet.pause();
        RewardCustodyFacet(diamond).replaceRewardCustodyHolder();
        vm.stopBroadcast();

        _reconcileFromChain(diamond, previous);
        console.log("The Diamond is left PAUSED. Resume service by a fresh Unpauser decision once nothing else holds the pause.");
    }

    function stage() external {
        (address diamond, address previous) = _boundDiamond();
        bool wasPaused = AdminFacet(diamond).paused();
        bytes memory pauseCall = abi.encodeCall(AdminFacet.pause, ());
        bytes memory replaceCall = abi.encodeCall(RewardCustodyFacet.replaceRewardCustodyHolder, ());

        console.log("=== Reward custody holder replacement (staged) ===");
        console.log("Diamond:         ", diamond);
        console.log("Previous holder: ", previous);
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

        string memory obj = "ceremony";
        vm.serializeAddress(obj, "diamond", diamond);
        vm.serializeAddress(obj, "previousHolder", previous);
        vm.serializeBool(obj, "diamondWasPaused", wasPaused);
        vm.serializeUint(obj, "stagedAtBlock", block.number);
        vm.serializeBytes(obj, "step1_pauserSafe_pause", pauseCall);
        string memory json = vm.serializeBytes(obj, "step2_timelock_replaceRewardCustodyHolder", replaceCall);
        _writeRecord(KIND, json);
    }

    function record() external {
        string memory json = _readRecord(KIND);
        address diamond = vm.parseJsonAddress(json, ".diamond");
        address previous = vm.parseJsonAddress(json, ".previousHolder");
        console.log("=== Reward custody holder replacement (record) ===");
        console.log("Diamond:         ", diamond);
        console.log("Previous holder: ", previous);
        _reconcileFromChain(diamond, previous);
        _removeRecord(KIND);
    }
}
