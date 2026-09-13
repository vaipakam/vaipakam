// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";

import {RewardCustodyHolder} from "../../src/RewardCustodyHolder.sol";
import {RewardCustodyFacet} from "../../src/facets/RewardCustodyFacet.sol";
import {Deployments} from "./Deployments.sol";

/**
 * @title  RewardCustodyCeremonyBase — the one implementation of "a custody
 *         ceremony that works before and after governance handover"
 *         (#1566 slice 4 PR A; Codex #2158 r2 P1, r3 P2, r4 P1)
 *
 * @notice Both custody ceremonies — the one-shot initial bind
 *         (`DeployRewardCustodyHolder`) and the replacement
 *         (`ReplaceRewardCustodyHolder`) — share three properties, and they
 *         live here exactly once so the two scripts cannot drift:
 *
 *  1. **The artifact is written only from LIVE chain state, by `record()`.**
 *     `addresses.json` is what `Deployments` documents as the source of
 *     truth for later scripts and the package sync; nothing is ever written
 *     from intent — and nothing from a script's OWN broadcast either (Codex
 *     #2158 r9 P2): Forge simulates the script body first and submits the
 *     recorded transactions afterwards, so a read inside `run()` sees the
 *     simulated result whether or not the transaction is later rejected,
 *     dropped or interrupted. `run()` therefore leaves a ceremony record
 *     exactly as `stage()` does, and `record()` — a separate, non-broadcast
 *     invocation after the transactions confirmed — reads the chain and
 *     writes the artifact. One writer, one source.
 *  2. **A pending ceremony is a record beside the artifact**
 *     (`deployments/<chain-slug>/reward-custody-<kind>.json`) holding the
 *     previous state and — for a staged ceremony — the calldata each
 *     handed-over signer executes against the Diamond. The record is
 *     created and removed ONLY under a write rule that matches the step's
 *     own nature: a BROADCASTING step (`run()`) follows the artifact's rule
 *     (`Deployments.artifactWritesEnabled()`, which reads Forge's dry-run
 *     context — a simulation must not invent a record for transactions it
 *     never sent), while a NON-BROADCASTING step (`stage()`, `record()`)
 *     has no dry run to speak of — the invocation IS the real run — so it
 *     writes unless under `forge test` or an explicit
 *     `DEPLOY_SKIP_ARTIFACTS` (Codex #2158 r10 P1: gating `record()` on the
 *     dry-run context made the documented `--sig record()` invocation skip
 *     the very artifact write it exists for). A record's absence is
 *     required BEFORE any broadcast, never discovered after.
 *  3. **The artifact and the chain must already agree before a ceremony
 *     starts.** If `.rewardCustodyHolder` disagrees with the bound holder,
 *     the two records are out of step and an operator reconciles them first;
 *     a ceremony must not widen the gap.
 *
 * @dev    A ceremony never resumes service, and never relies on a pause it
 *         observed earlier. The replacement executes its own `pause()`
 *         immediately before the switch — idempotent on an already paused
 *         Diamond — because any pause seen at staging time can lapse (an
 *         auto-pause window) or be lifted by an authorised Unpauser before
 *         a delayed Timelock call executes (Codex #2158 r6 P1, r7 P2).
 *         Both scripts leave the Diamond paused and say so; unpausing is a
 *         fresh decision by the Unpauser, because a ceremony that unpaused
 *         could lift an unrelated emergency pause raised in the meantime
 *         (Codex #2158 r3 P1, r4 P1).
 */
abstract contract RewardCustodyCeremonyBase is Script {
    // ─── Chain + artifact agreement ─────────────────────────────────────────

    /// @dev The Diamond from the artifact, its bound holder (zero while
    ///      unbound), and the artifact's record of that holder — required to
    ///      agree before any ceremony proceeds.
    function _diamondAndBound() internal view returns (address diamond, address bound) {
        diamond = Deployments.readDiamond();
        bound = RewardCustodyFacet(diamond).rewardCustodyHolder();
        address recorded = Deployments.readRewardCustodyHolderOptional();
        require(
            recorded == bound,
            "reward-custody ceremony: the artifact's .rewardCustodyHolder does not match the bound holder -- reconcile the record before running a ceremony"
        );
    }

    // ─── Ceremony record ────────────────────────────────────────────────────

    function _recordPath(string memory kind) internal view returns (string memory) {
        return string.concat("deployments/", Deployments.chainSlug(), "/reward-custody-", kind, ".json");
    }

    /// @dev A pending record must be dealt with BEFORE a new ceremony
    ///      broadcasts anything — discovering it afterwards would leave the
    ///      chain changed with nothing to reconcile from.
    function _requireNoPendingRecord(string memory kind) internal view {
        require(
            !vm.exists(_recordPath(kind)),
            "reward-custody ceremony: a ceremony record already exists -- run record() once the transactions have confirmed, or remove the stale record deliberately"
        );
    }

    /// @dev Whether a NON-broadcasting step (`stage()`, `record()`) may write.
    ///      Forge's dry-run context is not a signal here — such a step sends
    ///      nothing, so there is no "simulated" outcome to protect against;
    ///      only `forge test` and an explicit `DEPLOY_SKIP_ARTIFACTS` refuse.
    function _nonBroadcastWritesEnabled() internal view returns (bool) {
        if (vm.isContext(VmSafe.ForgeContext.TestGroup)) return false;
        return !vm.envOr("DEPLOY_SKIP_ARTIFACTS", false);
    }

    /// @dev Write a pending ceremony record. `json` is a serialised object
    ///      the caller built with `vm.serialize*`. `broadcasts` says whether
    ///      the calling step sent transactions: a broadcasting step follows
    ///      the artifact's dry-run-aware rule, a non-broadcasting one its
    ///      own.
    function _writeRecord(string memory kind, string memory json, bool broadcasts) internal {
        string memory p = _recordPath(kind);
        bool enabled = broadcasts ? Deployments.artifactWritesEnabled() : _nonBroadcastWritesEnabled();
        if (!enabled) {
            console.log("writes are off for this run -- ceremony record NOT written:", p);
            return;
        }
        vm.writeJson(json, p);
        console.log("Ceremony record:", p);
        console.log("Then, once the transactions have CONFIRMED on chain, run record() to reconcile the artifact from live state. The artifact is unchanged until then.");
    }

    /// @dev Read a staged ceremony record; refuses when none exists or it
    ///      names a different Diamond than the artifact.
    function _readRecord(string memory kind) internal view returns (string memory json) {
        string memory p = _recordPath(kind);
        require(vm.exists(p), "reward-custody ceremony: no ceremony record -- run stage() first");
        json = vm.readFile(p);
        require(
            vm.parseJsonAddress(json, ".diamond") == Deployments.readDiamond(),
            "reward-custody ceremony: the ceremony record names a different Diamond"
        );
    }

    /// @dev Remove the record only when the artifact was actually written —
    ///      `record()` is non-broadcasting, so its own rule applies.
    function _removeRecord(string memory kind) internal {
        string memory p = _recordPath(kind);
        if (!_nonBroadcastWritesEnabled()) {
            console.log("writes are off for this run -- ceremony record kept:", p);
            return;
        }
        vm.removeFile(p);
        console.log("Ceremony record removed:", p);
    }

    // ─── Reconcile the artifact from chain state ────────────────────────────

    /// @dev Called ONLY from `record()` — a non-broadcast invocation after the
    ///      ceremony's transactions confirmed. The bound holder is read from
    ///      live chain state, required to differ from `previous` (zero for
    ///      the initial bind) and to answer to this Diamond, and THEN
    ///      recorded. Returns the holder now bound.
    function _reconcileFromChain(address diamond, address previous) internal returns (address bound) {
        bound = RewardCustodyFacet(diamond).rewardCustodyHolder();
        require(
            bound != address(0) && bound != previous,
            "reward-custody ceremony: the Diamond does not yet report a new holder -- the bundle has not executed"
        );
        require(
            RewardCustodyHolder(bound).DIAMOND() == diamond,
            "reward-custody ceremony: the bound holder does not answer to this Diamond"
        );
        console.log("Bound holder:", bound);
        // `record()` broadcasts nothing: a plain `forge script --sig "record()"`
        // IS the real run, so the artifact's dry-run-aware rule does not apply.
        if (!_nonBroadcastWritesEnabled()) {
            console.log("writes are off for this run (forge test / DEPLOY_SKIP_ARTIFACTS) -- .rewardCustodyHolder NOT rewritten; the artifact is STALE until it is.");
            return bound;
        }
        Deployments.writeRewardCustodyHolder(bound);
        console.log("Recorded .rewardCustodyHolder =", bound, "in", Deployments.path());
    }
}
