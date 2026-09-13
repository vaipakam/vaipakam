// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";

import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {RewardCustodyCeremonyBase} from "./lib/RewardCustodyCeremonyBase.sol";
import {Deployments} from "./lib/Deployments.sol";

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
 *  - `run()`    — DIRECT: `ADMIN_PRIVATE_KEY` holds `ADMIN_ROLE` and
 *                 `PAUSER_ROLE`. Pauses (always — idempotent on a paused
 *                 Diamond, and a pause observed a moment earlier can be
 *                 lifted or lapse), replaces, leaves a ceremony record — and
 *                 LEAVES THE DIAMOND PAUSED. The artifact is written by
 *                 `record()` once the transactions have confirmed, never
 *                 from the script's own simulated read (Codex #2158 r9 P2).
 *                 Refuses before any broadcast when the key lacks either
 *                 role.
 *  - `stage()`  — STAGED, for a handed-over deployment where `ADMIN_ROLE`
 *                 sits on the Timelock and `PAUSER_ROLE` on the Pauser Safe:
 *                 broadcasts nothing; writes a ceremony record with the
 *                 calldata each signer executes against the Diamond —
 *                   1. Pauser Safe: `pause()`  — ALWAYS, immediately before
 *                      step 2, whatever the pause state was at staging: an
 *                      auto-pause window can expire and an authorised
 *                      Unpauser can resume service while the Timelock delay
 *                      runs, and either would fail step 2's `requirePaused()`
 *                      (Codex #2158 r6 P1, r7 P2). Idempotent on a paused
 *                      Diamond.
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
        _requireNoPendingRecord(KIND);
        AccessControlFacet acl = AccessControlFacet(diamond);
        AdminFacet adminFacet = AdminFacet(diamond);

        // Every role the direct path will exercise is checked BEFORE any
        // broadcast, so a handed-over deployment is told to stage rather
        // than failing on the second transaction.
        require(
            acl.hasRole(LibAccessControl.ADMIN_ROLE, admin),
            "ReplaceRewardCustodyHolder: ADMIN_PRIVATE_KEY does not hold ADMIN_ROLE -- after governance handover use stage() / record()"
        );
        require(
            acl.hasRole(LibAccessControl.PAUSER_ROLE, admin),
            "ReplaceRewardCustodyHolder: ADMIN_PRIVATE_KEY does not hold PAUSER_ROLE -- the ceremony always pauses immediately before the switch; after governance handover use stage() / record()"
        );

        console.log("=== Reward custody holder replacement (direct) ===");
        console.log("Diamond:         ", diamond);
        console.log("Previous holder: ", previous);
        console.log("Admin:           ", admin);

        vm.startBroadcast(adminKey);
        // Always — a pause observed a moment ago can be lifted or lapse;
        // `pause()` on an already paused Diamond rewrites the same flag.
        adminFacet.pause();
        RewardCustodyFacet(diamond).replaceRewardCustodyHolder();
        vm.stopBroadcast();

        string memory obj = "ceremony";
        vm.serializeAddress(obj, "diamond", diamond);
        vm.serializeAddress(obj, "previousHolder", previous);
        vm.serializeString(obj, "mode", "direct");
        // The fork head this run was PREPARED against, not an inclusion
        // block — see DeployRewardCustodyHolder.run() (Codex #2158 r17 P2).
        string memory json = vm.serializeUint(obj, "preparedAtBlock", block.number);
        _writeRecord(KIND, json, true);
        console.log("The Diamond is left PAUSED. Resume service by a fresh Unpauser decision once record() has confirmed the ceremony and nothing else holds the pause.");
    }

    /// @notice Validate the pending replacement record and write nothing —
    ///         what record() will require (Codex #2158 r17 P2): parseable,
    ///         this Diamond, and a predecessor that is the artifact's current
    ///         holder (r22 P2).
    function check() external view {
        _checkRecord(KIND);
        _recordedPredecessor(_readRecord(KIND));
        console.log("predecessor matches the artifact's current holder");
    }

    /// @dev The record's predecessor must be the artifact's CURRENT holder —
    ///      the one this ceremony set out to replace (Codex #2158 r22 P2). A
    ///      zero or foreign predecessor would let a live holder that merely
    ///      differs from it — the original, still bound, when the bundle
    ///      never executed — pass reconciliation, rewrite the artifact and
    ///      retire the record, after which service could resume on the very
    ///      holder the ceremony meant to replace.
    function _recordedPredecessor(string memory json) private view returns (address previous) {
        previous = vm.parseJsonAddress(json, ".previousHolder");
        require(
            previous != address(0),
            "ReplaceRewardCustodyHolder: the ceremony record names no predecessor -- stale or corrupted; remove it deliberately or re-stage"
        );
        require(
            previous == Deployments.readRewardCustodyHolderOptional(),
            "ReplaceRewardCustodyHolder: the ceremony record's predecessor is not the artifact's current holder -- stale or foreign record; remove it deliberately or re-stage"
        );
    }

    function stage() external {
        (address diamond, address previous) = _boundDiamond();
        _requireNoPendingRecord(KIND);
        bytes memory pauseCall = abi.encodeCall(AdminFacet.pause, ());
        bytes memory replaceCall = abi.encodeCall(RewardCustodyFacet.replaceRewardCustodyHolder, ());

        console.log("=== Reward custody holder replacement (staged) ===");
        console.log("Diamond:         ", diamond);
        console.log("Previous holder: ", previous);
        console.log("Execute against the Diamond, in order:");
        console.log("  1. Pauser Safe  pause()  -- ALWAYS, immediately before step 2, whatever the pause state is now (idempotent)");
        console.logBytes(pauseCall);
        console.log("  2. Timelock     replaceRewardCustodyHolder()  -- constructs the successor and moves the balance in that transaction");
        console.logBytes(replaceCall);
        console.log("No unpause is staged: the Diamond stays paused after step 2. Resume service by a fresh Unpauser decision after record() confirms the ceremony.");

        string memory obj = "ceremony";
        vm.serializeAddress(obj, "diamond", diamond);
        vm.serializeAddress(obj, "previousHolder", previous);
        vm.serializeString(obj, "mode", "staged");
        vm.serializeUint(obj, "stagedAtBlock", block.number);
        vm.serializeBytes(obj, "step1_pauserSafe_pause", pauseCall);
        string memory json = vm.serializeBytes(obj, "step2_timelock_replaceRewardCustodyHolder", replaceCall);
        _writeRecord(KIND, json, false);
    }

    function record() external {
        string memory json = _readRecord(KIND);
        address diamond = vm.parseJsonAddress(json, ".diamond");
        address previous = _recordedPredecessor(json);
        console.log("=== Reward custody holder replacement (record) ===");
        console.log("Diamond:         ", diamond);
        console.log("Previous holder: ", previous);
        _reconcileFromChain(diamond, previous);
        _removeRecord(KIND);
    }
}
