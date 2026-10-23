// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {Deployments} from "./Deployments.sol";

/**
 * @title  StorageLayoutRecord
 * @notice The per-chain storage-layout record, and the refusal every in-place
 *         code change runs against it (#2092 item 1).
 *
 *         A Diamond refreshed in place, or a UUPS proxy upgraded, keeps its
 *         storage and swaps its code. The merge check (#2600) keeps `main`
 *         append-only against `main`, but a chain does not run `main`: it runs
 *         whatever it was last deployed or refreshed from. So each chain
 *         carries its own record, `deployments/<slug>/storage-layout.json`, a
 *         copy of `storage-layout/layout.golden.json` as it stood when code
 *         last reached that chain. An in-place change is refused unless the
 *         code this checkout would cut keeps every fact in that record.
 *
 *         **The comparison is not re-implemented here.** It runs the one guard
 *         CI runs, `script/storage-layout-guard.mjs check --base <record>`,
 *         through `vm.tryFfi`. That command rebuilds `src/`'s layouts, refuses
 *         a stale golden file, honours declared renames (`renames.json`) and
 *         never reads acknowledgements (`breaks.ack.json`): an acknowledged
 *         break means no chain may be upgraded in place across it, so it must
 *         still refuse here. A second implementation in Solidity would be a
 *         second opinion about the same rule, free to drift from the first.
 *
 *         **Why `--ffi` and not a wrapper** (owner decision 2026-10-23): the
 *         refusal sits where the code change happens, so no entry point can
 *         reach a chain around it. A script run without `--ffi` reverts at
 *         {requireAppendOnly} before its first transaction; that is the
 *         intended failure, not a configuration nuisance. `foundry.toml` does
 *         not enable ffi: the flag is per invocation, on these scripts only.
 *
 *         **Why over-recording is safe.** Every check is set inclusion
 *         (record ⊆ new layout), so a record that claims MORE than a chain
 *         runs can only refuse more, never admit a break. That is what lets a
 *         simulated broadcast that later fails leave its record written, lets
 *         a facet-only refresh record the whole tree (UUPS roots included),
 *         and lets the live testnets be seeded from a later layout that
 *         contains what they run. A record that claims LESS than a chain runs
 *         is the dangerous direction, which is why a missing record refuses
 *         rather than skipping the check.
 */
library StorageLayoutRecord {
    address private constant VM_ADDR =
        address(uint160(uint256(keccak256("hevm cheat code"))));
    Vm private constant CHEATS = Vm(VM_ADDR);

    /// The record's file name, beside the chain's `addresses.json`.
    string internal constant RECORD_FILE = "storage-layout.json";

    /// The guard CI runs, relative to `foundry.toml#root`.
    string internal constant GUARD = "script/storage-layout-guard.mjs";

    /// Path to the active chain's record (redirect-aware, like every
    /// per-chain artifact: see {Deployments.namedPath}).
    function recordPath() internal view returns (string memory) {
        return Deployments.namedPath(RECORD_FILE);
    }

    /// Refuse unless this checkout's golden layout describes its code, and
    /// prove `--ffi` is on. A fresh deploy calls it before anything else, so
    /// the record it writes at the end cannot fail for either reason after
    /// the deploy's artifacts are already on disk.
    ///
    /// @param who The calling script's name, for the revert message.
    function requireCurrentGolden(string memory who) internal {
        string[] memory cmd = new string[](3);
        cmd[0] = "node";
        cmd[1] = GUARD;
        cmd[2] = "check";
        _runGuard(
            cmd,
            string.concat(
                who,
                ": storage-layout guard refused this checkout (its output is above): storage-layout/layout.golden.json does not describe the code being deployed, so the chain's record would be wrong. Run `node script/storage-layout-guard.mjs write`, commit the golden file, and deploy from that commit."
            )
        );
    }

    /// Refuse unless the code in this checkout keeps every storage-layout fact
    /// recorded for the active chain. Call it at the top of an in-place
    /// entry point, BEFORE `vm.startBroadcast`, so a refusal sends nothing.
    ///
    /// @param who The calling script's name, for the revert message.
    function requireAppendOnly(string memory who) internal {
        string memory base = recordPath();
        require(
            CHEATS.exists(base),
            string.concat(
                who,
                ": no storage-layout record at ",
                base,
                ". An in-place change compares the new code against the layout this chain runs, and without a record that is unknown, so the change is refused. A chain gets its record from a fresh deploy (DeployDiamond writes it); a chain deployed before #2092 is seeded once by committing the golden layout its code is contained in."
            )
        );
        string[] memory cmd = new string[](5);
        cmd[0] = "node";
        cmd[1] = GUARD;
        cmd[2] = "check";
        cmd[3] = "--base";
        cmd[4] = base;
        _runGuard(
            cmd,
            string.concat(
                who,
                ": storage-layout guard refused this in-place change against ",
                base,
                " (its output is above). Either the golden file is stale, or the new code drops a layout fact this chain's storage depends on. Do not upgrade this chain in place across it; redeploy it fresh, or declare a genuine rename in storage-layout/renames.json."
            )
        );
        console.log(string.concat(who, ": storage layout is append-only against ", base));
    }

    /// Write the active chain's record: the golden layout this run's code was
    /// compiled against, written by the guard's `record --to` mode (which
    /// refuses a stale golden file). Called at the end of a fresh deploy and
    /// of a passing in-place change, under the same rule as every other
    /// artifact write ({Deployments.artifactWritesEnabled}: never on a dry
    /// run).
    ///
    /// @dev The guard writes the file, not this library: reading the golden
    ///      from Solidity would need a `foundry.toml` read permission on
    ///      `storage-layout/`, and `foundry.toml` is part of CI's forge cache
    ///      key (#2603).
    ///
    ///      After {requireAppendOnly} the golden file contains the old record,
    ///      so the new record is a superset of the old. A fresh deploy has no
    ///      old record to keep: it ran {requireCurrentGolden} first.
    function record() internal {
        if (!Deployments.artifactWritesEnabled()) return;
        string memory path = recordPath();
        string[] memory cmd = new string[](5);
        cmd[0] = "node";
        cmd[1] = GUARD;
        cmd[2] = "record";
        cmd[3] = "--to";
        cmd[4] = path;
        _runGuard(
            cmd,
            string.concat(
                "storage-layout guard could not write the record at ",
                path,
                " (its output is above). The chain's code changed, so its record must be rewritten before any later in-place change: fix the cause and run `node script/storage-layout-guard.mjs record --to ",
                path,
                "` from the same commit."
            )
        );
        console.log(string.concat("storage-layout record written: ", path));
    }

    /// Run one guard command and revert with `failure` when it exits non-zero.
    /// `tryFfi` itself reverts when ffi is off ("FFI is disabled"), which is
    /// the refusal for a run without `--ffi`.
    function _runGuard(string[] memory cmd, string memory failure) private {
        VmSafe.FfiResult memory r = CHEATS.tryFfi(cmd);
        if (r.exitCode != 0) {
            console.log(string(r.stdout));
            console.log(string(r.stderr));
            revert(failure);
        }
    }
}
