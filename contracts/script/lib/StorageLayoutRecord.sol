// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {Deployments} from "./Deployments.sol";

/// @dev The one VaultFactoryFacet read the anchor needs, declared here so this
///      library does not pull a facet into every script that links it.
interface IVaultTemplateRead {
    function getVaipakamVaultImplementationAddress() external view returns (address);
}

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
 *         **The record is bound to the live chain** (Codex #2684 r1 P1). A
 *         record is a file in one checkout, and a chain can be changed from
 *         another: a refresh whose new record was never committed, or two
 *         branches that each start from the same record. So beside the record
 *         sits its anchor, `deployments/<slug>/storage-layout.anchor.json`,
 *         naming the Diamond, a fingerprint of the code it runs (the loupe's
 *         facet address list and the vault template) and the record's own
 *         hash, all as they stood when the record was written. A change is
 *         refused unless the live chain still matches the anchor and the
 *         record is the one the anchor names; a chain changed from elsewhere
 *         then fails here instead of being checked against a record that no
 *         longer describes it. Two runs racing from different checkouts can
 *         both pass before either broadcasts; nothing off-chain can close
 *         that, so these scripts are run one at a time per chain.
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
 *         reach a chain around it. A script run without `--ffi` reverts at its
 *         first guard call, before its first transaction; that is the intended
 *         failure, not a configuration nuisance. `foundry.toml` does not
 *         enable ffi: the flag is per invocation, on these scripts only.
 *
 *         **Where it does not run** ({active}): under `forge test`, which has
 *         no ffi and no chain, and for a run whose artifact root is redirected
 *         to a scratch directory, which `ArtifactRootBase` allows only on
 *         Anvil or under test and which can therefore hold no live chain's
 *         record. Everywhere else it runs, so the calls sit in each script's
 *         one body (its `runWith`), and selecting that function with `--sig`
 *         does not skip them (Codex #2684 r1 P1).
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

    /// The record's anchor to the live chain, beside the record.
    string internal constant ANCHOR_FILE = "storage-layout.anchor.json";

    /// The guard CI runs, relative to `foundry.toml#root`.
    string internal constant GUARD = "script/storage-layout-guard.mjs";

    /// Path to the active chain's record (redirect-aware, like every
    /// per-chain artifact: see {Deployments.namedPath}).
    function recordPath() internal view returns (string memory) {
        return Deployments.namedPath(RECORD_FILE);
    }

    /// Path to the active chain's anchor.
    function anchorPath() internal view returns (string memory) {
        return Deployments.namedPath(ANCHOR_FILE);
    }

    /// FALSE under `forge test` and for a redirected artifact root; TRUE for
    /// every other run, dry runs included. See the contract note.
    function active() internal view returns (bool) {
        return !CHEATS.isContext(VmSafe.ForgeContext.TestGroup) && !Deployments.artifactIsRedirected();
    }

    /// Fingerprint of the code `diamond` runs now: its facet address list, in
    /// the loupe's order, and the vault template every user vault upgrades to.
    /// Any facet cut or template retarget changes it.
    function liveCodeFingerprint(address diamond) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                IDiamondLoupe(diamond).facetAddresses(),
                IVaultTemplateRead(diamond).getVaipakamVaultImplementationAddress()
            )
        );
    }

    /// Refuse unless this checkout's golden layout describes its code, and
    /// prove `--ffi` is on. A fresh deploy calls it before anything else, so
    /// the record it writes at the end cannot fail for either reason after
    /// the deploy's artifacts are already on disk.
    ///
    /// @param who The calling script's name, for the revert message.
    function requireCurrentGolden(string memory who) internal {
        if (!active()) return;
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

    /// Refuse unless the record is bound to `diamond` as it runs now, and the
    /// code in this checkout keeps every storage-layout fact it records. Call
    /// it before the first `vm.startBroadcast`, so a refusal sends nothing.
    ///
    /// @param who     The calling script's name, for the revert message.
    /// @param diamond The Diamond this run changes.
    function requireAppendOnly(string memory who, address diamond) internal {
        if (!active()) return;
        string memory base = recordPath();
        require(
            CHEATS.exists(base),
            string.concat(
                who,
                ": no storage-layout record at ",
                base,
                ". An in-place change compares the new code against the layout this chain runs, and without a record that is unknown, so the change is refused. A chain gets its record from a fresh deploy (DeployDiamond writes it); a chain deployed before #2092 is seeded once (AnchorStorageLayoutRecord.s.sol)."
            )
        );
        _requireAnchored(who, diamond, base);
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

    /// Write the active chain's record, the golden layout this run's code was
    /// compiled against, written by the guard's `record --to` mode (which
    /// refuses a stale golden file), and then its anchor to `diamond` as it
    /// runs after this run's changes. Called at the end of a fresh deploy and
    /// of a passing in-place change, under the same rule as every other
    /// artifact write ({Deployments.artifactWritesEnabled}: never on a dry
    /// run).
    ///
    /// @dev The guard writes the record, not this library: reading the golden
    ///      from Solidity would need a `foundry.toml` read permission on
    ///      `storage-layout/`, and `foundry.toml` is part of CI's forge cache
    ///      key (#2603).
    ///
    ///      After {requireAppendOnly} the golden file contains the old record,
    ///      so the new record is a superset of the old. A fresh deploy has no
    ///      old record to keep: it ran {requireCurrentGolden} first.
    function record(address diamond) internal {
        if (!active() || !Deployments.artifactWritesEnabled()) return;
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
                " (its output is above). The chain's code changed, so its record must be rewritten before any later in-place change: fix the cause, confirm the record describes the chain, and run AnchorStorageLayoutRecord.s.sol from the same commit."
            )
        );
        writeAnchor(diamond);
        console.log(string.concat("storage-layout record written: ", path));
    }

    /// Bind the active chain's CURRENT record to `diamond` as it runs now.
    /// {record} calls it; the one-time seed of a chain deployed before #2092,
    /// and the recovery after a run that changed the chain without recording,
    /// call it through `AnchorStorageLayoutRecord.s.sol`. Writing an anchor
    /// asserts that the record describes the code `diamond` runs, so it is
    /// only ever run once that is established.
    function writeAnchor(address diamond) internal {
        string memory rec = recordPath();
        require(CHEATS.exists(rec), string.concat("StorageLayoutRecord: no record to anchor at ", rec));
        string memory key = "storage-layout-anchor";
        CHEATS.serializeString(
            key,
            "_readme",
            "Binds storage-layout.json beside it to the chain it describes (#2092). Written with the record; an in-place change is refused unless the Diamond, its code fingerprint and the record hash still match. Do not edit by hand."
        );
        CHEATS.serializeAddress(key, "diamond", diamond);
        CHEATS.serializeBytes32(key, "codeFingerprint", liveCodeFingerprint(diamond));
        string memory json = CHEATS.serializeBytes32(key, "recordHash", keccak256(bytes(CHEATS.readFile(rec))));
        CHEATS.writeJson(json, anchorPath());
    }

    function _requireAnchored(string memory who, address diamond, string memory rec) private view {
        string memory anchor = anchorPath();
        require(
            CHEATS.exists(anchor),
            string.concat(
                who,
                ": the record at ",
                rec,
                " has no anchor (",
                anchor,
                "), so nothing ties it to the chain. Bind it with AnchorStorageLayoutRecord.s.sol, once you have established that it describes the code this chain runs."
            )
        );
        string memory json = CHEATS.readFile(anchor);
        require(
            CHEATS.parseJsonAddress(json, ".diamond") == diamond,
            string.concat(who, ": the storage-layout record is anchored to a different Diamond (", anchor, "). It describes another deployment; this chain's Diamond needs its own record.")
        );
        require(
            CHEATS.parseJsonBytes32(json, ".recordHash") == keccak256(bytes(CHEATS.readFile(rec))),
            string.concat(who, ": ", rec, " is not the record its anchor names. The two are written together; restore the pair that matches, never one file alone.")
        );
        require(
            CHEATS.parseJsonBytes32(json, ".codeFingerprint") == liveCodeFingerprint(diamond),
            string.concat(
                who,
                ": this chain's code changed since its storage-layout record was written (its facets or vault template differ from ",
                anchor,
                "). Another checkout or a run outside these scripts changed it, so this record no longer describes the chain. Pull the record and anchor that change wrote; if none exists, establish what the chain runs and re-anchor with AnchorStorageLayoutRecord.s.sol."
            )
        );
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
