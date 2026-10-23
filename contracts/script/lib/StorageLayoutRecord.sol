// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
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
 *         **The record is bound to the live chain** (Codex #2684 r1 P1). A
 *         record is a file in one checkout, and a chain can be changed from
 *         another: a refresh whose new record was never committed, or two
 *         branches that each start from the same record. So beside the record
 *         sits its anchor, `deployments/<slug>/storage-layout.anchor.json`,
 *         naming the Diamond, a fingerprint of every code location the record
 *         governs ({CodeMap}: the facets, the vault and adapter templates and
 *         every UUPS proxy the chain reaches) and the record's own hash, all as they stood when the record was written. A change is
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

    /// The EIP-1967 implementation slot, `bytes32(uint256(keccak256(
    /// "eip1967.proxy.implementation")) - 1)`: where every UUPS proxy keeps
    /// the address of the code it runs.
    bytes32 private constant EIP1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// Most addresses the candidate walk ({_liveProxies}) holds at once.
    uint256 private constant MAX_CANDIDATES = 512;

    /// Every code location whose storage layout the record governs, as it
    /// stands now on the active chain (Codex #2684 r2 P1). The record covers
    /// the Diamond's namespaces AND every UUPS root in `roots.json`, so the
    /// anchor has to bind all of them: a fingerprint over the facets alone
    /// let a receiver upgraded by an interrupted refresh pass as unchanged.
    ///
    /// @dev Three parts, each found without a per-contract list, so a new
    ///      proxy cannot be left out by forgetting to name it here:
    ///      - `facets`: the loupe's facet address list (the Diamond's code);
    ///      - `vaultTemplate` / `adapterTemplate`: the templates the Diamond
    ///        upgrades every user vault and aggregator adapter to, which are
    ///        the code those per-user proxies run or are pushed onto;
    ///      - `proxies` / `implementations`: every EIP-1967 proxy the chain
    ///        reaches, sorted by address, with the implementation it points
    ///        at now. Candidates are every address in the chain's
    ///        `addresses.json` (outside `.facets`, which the loupe covers),
    ///        every satellite the Diamond itself names (backstop vault,
    ///        listing executor, reward messenger, remittance and buyback
    ///        receivers, return sender and receiver, cross-chain messenger),
    ///        and the `messenger()` each of those proxies trusts. A candidate
    ///        counts as a proxy when its implementation slot is non-zero.
    ///
    ///      A Diamond getter that does not exist (an older facet set) reads
    ///      as no candidate, never as a revert.
    struct CodeMap {
        address[] facets;
        address vaultTemplate;
        address adapterTemplate;
        address[] proxies;
        address[] implementations;
    }

    /// The {CodeMap} of `diamond`'s chain now.
    function liveCodeMap(address diamond) internal view returns (CodeMap memory m) {
        m.facets = IDiamondLoupe(diamond).facetAddresses();
        m.vaultTemplate = _readWord(diamond, "getVaipakamVaultImplementationAddress()", 0);
        m.adapterTemplate = _readWord(diamond, "aggregatorAdapterTemplate()", 0);
        (m.proxies, m.implementations) = _liveProxies(diamond);
    }

    /// Fingerprint of {liveCodeMap}: any facet cut, template retarget or
    /// proxy upgrade, and any proxy added to or dropped from what the chain
    /// reaches, changes it.
    function liveCodeFingerprint(address diamond) internal view returns (bytes32) {
        return codeFingerprint(liveCodeMap(diamond));
    }

    function codeFingerprint(CodeMap memory m) internal pure returns (bytes32) {
        return keccak256(abi.encode(m.facets, m.vaultTemplate, m.adapterTemplate, m.proxies, m.implementations));
    }

    function _liveProxies(address diamond)
        private
        view
        returns (address[] memory proxies, address[] memory impls)
    {
        address[] memory cand = new address[](MAX_CANDIDATES);
        uint256 n;
        // The satellites the Diamond names. Word indexes follow each getter's
        // return tuple (`getRepatriationPosition` returns the sender and the
        // receiver second and third).
        n = _push(cand, n, _readWord(diamond, "getBackstopVault()", 0));
        n = _push(cand, n, _readWord(diamond, "getCollateralListingExecutor()", 0));
        n = _push(cand, n, _readWord(diamond, "getRewardReporterConfig()", 0));
        n = _push(cand, n, _readWord(diamond, "getRewardRemittanceReceiver()", 0));
        n = _push(cand, n, _readWord(diamond, "getBuybackRemittanceReceiver()", 0));
        n = _push(cand, n, _readWord(diamond, "getCrossChainMessenger()", 0));
        n = _push(cand, n, _readWord(diamond, "getRepatriationPosition()", 1));
        n = _push(cand, n, _readWord(diamond, "getRepatriationPosition()", 2));
        // Every address the chain's artifact names.
        try CHEATS.readFile(Deployments.path()) returns (string memory json) {
            n = _collectArtifactAddresses(json, "$", cand, n);
        } catch {}
        // The adapter each proxy trusts (one hop: the adapter is itself a
        // proxy, and every satellite names the one it calls through).
        uint256 direct = n;
        for (uint256 i = 0; i < direct; ++i) {
            if (_implementationOf(cand[i]) != address(0)) {
                n = _push(cand, n, _readWord(cand[i], "messenger()", 0));
            }
        }
        // Keep the proxies, sorted and without repeats.
        address[] memory sorted = new address[](n);
        uint256 k;
        for (uint256 i = 0; i < n; ++i) {
            address a = cand[i];
            if (_implementationOf(a) == address(0)) continue;
            uint256 j = k;
            bool dup;
            while (j > 0 && uint160(sorted[j - 1]) >= uint160(a)) {
                if (sorted[j - 1] == a) {
                    dup = true;
                    break;
                }
                --j;
            }
            if (dup) continue;
            for (uint256 t = k; t > j; --t) sorted[t] = sorted[t - 1];
            sorted[j] = a;
            ++k;
        }
        proxies = new address[](k);
        impls = new address[](k);
        for (uint256 i = 0; i < k; ++i) {
            proxies[i] = sorted[i];
            impls[i] = _implementationOf(sorted[i]);
        }
    }

    /// Walk `json` from `prefix`, pushing every string value that parses as
    /// an address. `.facets` is skipped: the loupe is the authority on facets.
    function _collectArtifactAddresses(string memory json, string memory prefix, address[] memory cand, uint256 n)
        private
        view
        returns (uint256)
    {
        string[] memory keys;
        try CHEATS.parseJsonKeys(json, prefix) returns (string[] memory k) {
            keys = k;
        } catch {
            return n;
        }
        for (uint256 i = 0; i < keys.length; ++i) {
            string memory key = keccak256(bytes(prefix)) == keccak256("$")
                ? string.concat(".", keys[i])
                : string.concat(prefix, ".", keys[i]);
            if (keccak256(bytes(key)) == keccak256(".facets")) continue;
            try CHEATS.parseJsonAddress(json, key) returns (address a) {
                n = _push(cand, n, a);
            } catch {
                n = _collectArtifactAddresses(json, key, cand, n);
            }
        }
        return n;
    }

    function _push(address[] memory cand, uint256 n, address a) private pure returns (uint256) {
        if (a == address(0)) return n;
        require(n < MAX_CANDIDATES, "StorageLayoutRecord: more code locations than the walk holds; raise MAX_CANDIDATES");
        cand[n] = a;
        return n + 1;
    }

    function _implementationOf(address a) private view returns (address) {
        if (a.code.length == 0) return address(0);
        return address(uint160(uint256(CHEATS.load(a, EIP1967_IMPLEMENTATION_SLOT))));
    }

    /// Word `index` of `target.signature()`'s return data, as an address;
    /// zero when the call reverts, returns too little, or the word is not an
    /// address.
    function _readWord(address target, string memory signature, uint256 index) private view returns (address) {
        if (target.code.length == 0) return address(0);
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature(signature));
        if (!ok || ret.length < 32 * (index + 1)) return address(0);
        bytes memory w = new bytes(32);
        for (uint256 i = 0; i < 32; ++i) w[i] = ret[32 * index + i];
        uint256 word = abi.decode(w, (uint256));
        if (word >> 160 != 0) return address(0);
        return address(uint160(word));
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
            "Binds storage-layout.json beside it to the chain it describes (#2092). Written with the record; an in-place change is refused unless the Diamond, the fingerprint of every code location the record governs (facets, vault and adapter templates, every UUPS proxy the chain reaches) and the record hash still match. The parts beside codeFingerprint are there to say which code moved. Do not edit by hand."
        );
        CHEATS.serializeAddress(key, "diamond", diamond);
        CodeMap memory m = liveCodeMap(diamond);
        // The parts are written beside the fingerprint so a refusal can say
        // WHICH code moved; only the fingerprint is compared.
        CHEATS.serializeAddress(key, "vaultTemplate", m.vaultTemplate);
        CHEATS.serializeAddress(key, "adapterTemplate", m.adapterTemplate);
        CHEATS.serializeAddress(key, "proxies", m.proxies);
        CHEATS.serializeAddress(key, "implementations", m.implementations);
        CHEATS.serializeBytes32(key, "facetsFingerprint", keccak256(abi.encode(m.facets)));
        CHEATS.serializeBytes32(key, "codeFingerprint", codeFingerprint(m));
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
        CodeMap memory live = liveCodeMap(diamond);
        if (CHEATS.parseJsonBytes32(json, ".codeFingerprint") != codeFingerprint(live)) {
            _logCodeDrift(json, live);
            revert(
                string.concat(
                    who,
                    ": this chain's code changed since its storage-layout record was written (what moved is logged above, against ",
                    anchor,
                    "). Another checkout or a run outside these scripts changed it, so this record no longer describes the chain. Pull the record and anchor that change wrote; if none exists, establish what the chain runs and re-anchor with AnchorStorageLayoutRecord.s.sol."
                )
            );
        }
    }

    /// Log each part of the live {CodeMap} that differs from the anchor, so a
    /// refusal names the facet set, template or proxy that moved. An anchor
    /// written before the parts were recorded logs every part as differing.
    function _logCodeDrift(string memory json, CodeMap memory live) private view {
        console.log("storage-layout anchor: the live code differs from the anchor in:");
        if (_anchorBytes32(json, ".facetsFingerprint") != keccak256(abi.encode(live.facets))) {
            console.log("  the Diamond's facet set");
        }
        if (_anchorAddress(json, ".vaultTemplate") != live.vaultTemplate) {
            console.log("  the vault template, now", live.vaultTemplate);
        }
        if (_anchorAddress(json, ".adapterTemplate") != live.adapterTemplate) {
            console.log("  the aggregator adapter template, now", live.adapterTemplate);
        }
        address[] memory ap = _anchorAddresses(json, ".proxies");
        address[] memory ai = _anchorAddresses(json, ".implementations");
        for (uint256 i = 0; i < live.proxies.length; ++i) {
            bool known;
            for (uint256 j = 0; j < ap.length && j < ai.length; ++j) {
                if (ap[j] != live.proxies[i]) continue;
                known = true;
                if (ai[j] != live.implementations[i]) {
                    console.log("  proxy", live.proxies[i]);
                    console.log("    implementation now", live.implementations[i]);
                }
            }
            if (!known) console.log("  a proxy the anchor does not list:", live.proxies[i]);
        }
        for (uint256 j = 0; j < ap.length; ++j) {
            bool present;
            for (uint256 i = 0; i < live.proxies.length; ++i) {
                if (live.proxies[i] == ap[j]) present = true;
            }
            if (!present) console.log("  a listed proxy the chain no longer reaches:", ap[j]);
        }
    }

    function _anchorBytes32(string memory json, string memory key) private pure returns (bytes32) {
        try CHEATS.parseJsonBytes32(json, key) returns (bytes32 v) {
            return v;
        } catch {
            return bytes32(0);
        }
    }

    function _anchorAddress(string memory json, string memory key) private pure returns (address) {
        try CHEATS.parseJsonAddress(json, key) returns (address v) {
            return v;
        } catch {
            return address(type(uint160).max);
        }
    }

    function _anchorAddresses(string memory json, string memory key) private pure returns (address[] memory) {
        try CHEATS.parseJsonAddressArray(json, key) returns (address[] memory v) {
            return v;
        } catch {
            return new address[](0);
        }
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
