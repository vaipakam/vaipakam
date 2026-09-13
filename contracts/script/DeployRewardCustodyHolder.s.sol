// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";

import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {Deployments} from "./lib/Deployments.sol";
import {RewardCustodyCeremonyBase} from "./lib/RewardCustodyCeremonyBase.sol";

/**
 * @title  DeployRewardCustodyHolder — bind the FIRST `RewardCustodyHolder` on
 *         a LIVE Diamond that predates it (#1566 slice 4 PR A, design §5d)
 * @notice Runs ONCE per live chain, after the in-place facet refresh that
 *         cut `RewardCustodyFacet`. A fresh `DeployDiamond` binds its own
 *         holder and never needs this script. The Diamond CONSTRUCTS the
 *         holder inside `bindRewardCustodyHolder()` — nothing is deployed or
 *         supplied here, so there is nothing that could be pointed at the
 *         wrong contract.
 *
 *  - `run()`    — DIRECT: `ADMIN_PRIVATE_KEY` holds `ADMIN_ROLE` (every chain
 *                 before `Handover`; testnets stay admin-owned). Binds, then
 *                 leaves a ceremony record; the artifact is written by
 *                 `record()` once the transaction has confirmed (never from
 *                 the script's own simulated read — Codex #2158 r9 P2).
 *                 Refuses before any broadcast when the key lacks the role,
 *                 pointing at `stage()`.
 *  - `stage()`  — STAGED, for a handed-over deployment where `ADMIN_ROLE`
 *                 sits on the Timelock (Codex #2158 r4 P1): broadcasts
 *                 nothing; writes a ceremony record with the calldata the
 *                 Timelock executes against the Diamond —
 *                 `bindRewardCustodyHolder()`. No pause is needed: nothing
 *                 reads the holder before PR B.
 *  - `record()` — after the Timelock executed it: rewrites
 *                 `.rewardCustodyHolder` from the chain's own report of the
 *                 bound holder, then removes the record.
 *
 * @dev    Why this is its own script and not a block inside
 *         `RefreshAllFacetsInPlace`: a refresh is re-runnable, and a holder
 *         must be bound exactly once. A refresh that bound one would, on its
 *         next run, leave every attributed balance at the old address while
 *         the Diamond read an empty one. The holder's lifecycle is part of
 *         the design, not of the refresh.
 *
 *         Refuses, in every mode, when the artifact already records a holder
 *         or the Diamond already has one bound (binding is one-shot on-chain,
 *         `RewardCustodyHolderAlreadyBound`) — replacement is
 *         `ReplaceRewardCustodyHolder` — and when `RewardCustodyFacet` is not
 *         routed yet (the read reverts `FunctionDoesNotExist`): run the facet
 *         refresh first. Artifact and ceremony-record writes follow the same
 *         dry-run / `DEPLOY_SKIP_ARTIFACTS` rule every deploy script follows.
 */
contract DeployRewardCustodyHolder is RewardCustodyCeremonyBase {
    string internal constant KIND = "bind";

    function _unboundDiamond() internal view returns (address diamond) {
        address bound;
        (diamond, bound) = _diamondAndBound();
        require(
            bound == address(0),
            "DeployRewardCustodyHolder: a holder is already bound -- replacement is the paused ceremony (ReplaceRewardCustodyHolder), not a re-run"
        );
    }

    function run() external {
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address admin = vm.addr(adminKey);
        address diamond = _unboundDiamond();
        _requireNoPendingRecord(KIND);
        require(
            AccessControlFacet(diamond).hasRole(LibAccessControl.ADMIN_ROLE, admin),
            "DeployRewardCustodyHolder: ADMIN_PRIVATE_KEY does not hold ADMIN_ROLE -- after governance handover use stage() / record()"
        );

        console.log("=== Reward custody holder (initial bind, direct) ===");
        console.log("Diamond:", diamond);
        console.log("Admin:  ", admin);

        vm.startBroadcast(adminKey);
        RewardCustodyFacet(diamond).bindRewardCustodyHolder();
        vm.stopBroadcast();

        string memory obj = "ceremony";
        vm.serializeAddress(obj, "diamond", diamond);
        vm.serializeString(obj, "mode", "direct");
        string memory json = vm.serializeUint(obj, "broadcastAtBlock", block.number);
        _writeRecord(KIND, json, true);
    }

    function stage() external {
        address diamond = _unboundDiamond();
        _requireNoPendingRecord(KIND);
        bytes memory bindCall = abi.encodeCall(RewardCustodyFacet.bindRewardCustodyHolder, ());

        console.log("=== Reward custody holder (initial bind, staged) ===");
        console.log("Diamond:", diamond);
        console.log("Execute against the Diamond:");
        console.log("  1. Timelock  bindRewardCustodyHolder()  -- constructs and binds the holder in that transaction");
        console.logBytes(bindCall);

        string memory obj = "ceremony";
        vm.serializeAddress(obj, "diamond", diamond);
        vm.serializeString(obj, "mode", "staged");
        vm.serializeUint(obj, "stagedAtBlock", block.number);
        string memory json = vm.serializeBytes(obj, "step1_timelock_bindRewardCustodyHolder", bindCall);
        _writeRecord(KIND, json, false);
    }

    function record() external {
        string memory json = _readRecord(KIND);
        address diamond = vm.parseJsonAddress(json, ".diamond");
        console.log("=== Reward custody holder (initial bind, record) ===");
        console.log("Diamond:", diamond);
        _reconcileFromChain(diamond, address(0));
        _removeRecord(KIND);
    }
}
