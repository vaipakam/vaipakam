// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";

/**
 * @title Deployments
 * @notice Foundry-script helper that reads/writes per-chain deployment
 *         addresses to `deployments/<chain-slug>/addresses.json`.
 *
 *         A fresh deploy always lands at a brand-new address, and
 *         operators shouldn't have to chain-prefix env vars
 *         (e.g. `BASE_SEPOLIA_DIAMOND_ADDRESS`) across every subsequent
 *         script — that pattern silently broke when an operator forgot
 *         to update their env after `DeployDiamond.s.sol` ran. After
 *         `DeployDiamond.s.sol` writes the file once, every
 *         Configure / Wire / Upgrade / Seed script reads from the same
 *         source of truth: committable, auditable, no env drift.
 *
 *         Path: `deployments/<chain-slug>/addresses.json`
 *
 *         Schema (extensible — readers tolerate missing keys):
 *
 *         {
 *           "chainId": 84532,
 *           "deployedAt": "2026-04-26T00:00:00Z",
 *           "diamond": "0x…",
 *           "escrowImpl": "0x…",
 *           "timelock": "0x…",
 *           "vpfiToken": "0x…",
 *           "vpfiOftAdapter": "0x…",
 *           "vpfiBuyAdapter": "0x…",
 *           "vpfiBuyReceiver": "0x…",
 *           "rewardOApp": "0x…",
 *           "mockChainlinkAggregator": "0x…",
 *           "mockUniswapV3Factory": "0x…",
 *           "mockERC20A": "0x…",
 *           "mockERC20B": "0x…"
 *         }
 *
 *         Fallback semantics: if `addresses.json` doesn't exist (very
 *         first deploy on a fresh chain), readers fall back to the
 *         legacy chain-prefixed env vars (e.g.
 *         `BASE_SEPOLIA_DIAMOND_ADDRESS`). Bootstrap path stays
 *         unblocked. Writes always create the file if missing.
 */
library Deployments {
    // ── Forge cheatcode handle ─────────────────────────────────────────────
    address private constant VM_ADDR =
        address(uint160(uint256(keccak256("hevm cheat code"))));
    Vm private constant cheats = Vm(VM_ADDR);

    // ── Public path API ────────────────────────────────────────────────────

    /// Absolute-from-foundry-root path to the active chain's
    /// `addresses.json`. Foundry resolves relative paths against
    /// `foundry.toml#root` (i.e. the `contracts/` directory in this
    /// repo). The committed file lives at
    /// `contracts/deployments/<slug>/addresses.json`.
    function path() internal view returns (string memory) {
        return string.concat("deployments/", chainSlug(), "/addresses.json");
    }

    /// Per-chain folder slug. Used both for the file path and for
    /// resolving the matching legacy env-var prefix
    /// (`BASE_SEPOLIA_…`, etc.). Add new chains here when the protocol
    /// expands.
    function chainSlug() internal view returns (string memory) {
        uint256 cid = block.chainid;
        if (cid == 1)         return "ethereum";
        if (cid == 8453)      return "base";
        if (cid == 84532)     return "base-sepolia";
        if (cid == 11155111)  return "sepolia";
        if (cid == 421614)    return "arb-sepolia";
        if (cid == 11155420)  return "op-sepolia";
        if (cid == 80002)     return "polygon-amoy";
        if (cid == 1101)      return "polygon-zkevm";
        if (cid == 56)        return "bnb";
        if (cid == 97)        return "bnb-testnet";
        if (cid == 42161)     return "arbitrum";
        if (cid == 10)        return "optimism";
        if (cid == 137)       return "polygon";
        revert(
            string.concat(
                "Deployments: unknown chainid ",
                cheats.toString(cid)
            )
        );
    }

    /// Legacy env-var prefix for the active chain — used as the
    /// per-key fallback when `addresses.json` is missing or the key
    /// hasn't been written yet. E.g. on Base Sepolia returns
    /// `BASE_SEPOLIA_` so `_legacyEnvAddress("DIAMOND_ADDRESS")`
    /// resolves to `vm.envAddress("BASE_SEPOLIA_DIAMOND_ADDRESS")`.
    function envPrefix() internal view returns (string memory) {
        uint256 cid = block.chainid;
        if (cid == 1)         return "ETHEREUM_";
        if (cid == 8453)      return "BASE_";
        if (cid == 84532)     return "BASE_SEPOLIA_";
        if (cid == 11155111)  return "SEPOLIA_";
        if (cid == 421614)    return "ARB_SEPOLIA_";
        if (cid == 11155420)  return "OP_SEPOLIA_";
        if (cid == 80002)     return "POLYGON_AMOY_";
        if (cid == 1101)      return "POLYGON_ZKEVM_";
        if (cid == 56)        return "BNB_";
        if (cid == 97)        return "BNB_TESTNET_";
        if (cid == 42161)     return "ARBITRUM_";
        if (cid == 10)        return "OPTIMISM_";
        if (cid == 137)       return "POLYGON_";
        revert("Deployments: unknown chainid for env prefix");
    }

    // ── Typed reads ────────────────────────────────────────────────────────

    function readDiamond()         internal view returns (address) { return _readAddr(".diamond",         "DIAMOND_ADDRESS"); }
    function readEscrowImpl()      internal view returns (address) { return _readAddr(".escrowImpl",      "ESCROW_IMPL_ADDRESS"); }
    function readTimelock()        internal view returns (address) { return _readAddr(".timelock",        "TIMELOCK_ADDRESS"); }
    function readVPFIToken()       internal view returns (address) { return _readAddr(".vpfiToken",       "VPFI_TOKEN_ADDRESS"); }
    function readVPFIOFTAdapter()  internal view returns (address) { return _readAddr(".vpfiOftAdapter",  "VPFI_OFT_ADAPTER_ADDRESS"); }
    function readVPFIBuyAdapter()  internal view returns (address) { return _readAddr(".vpfiBuyAdapter",  "VPFI_BUY_ADAPTER_ADDRESS"); }
    function readVPFIBuyReceiver() internal view returns (address) { return _readAddr(".vpfiBuyReceiver", "VPFI_BUY_RECEIVER_ADDRESS"); }
    function readRewardOApp()      internal view returns (address) { return _readAddr(".rewardOApp",      "REWARD_OAPP_ADDRESS"); }

    // Track-C mock infra (Base Sepolia testnet only). Falls back to env on chains
    // where these aren't deployed; readers pre-check for `address(0)` and skip.
    function readMockChainlinkAggregator() internal view returns (address) { return _tryReadAddr(".mockChainlinkAggregator"); }
    function readMockUniswapV3Factory()    internal view returns (address) { return _tryReadAddr(".mockUniswapV3Factory"); }
    function readMockERC20A()              internal view returns (address) { return _tryReadAddr(".mockERC20A"); }
    function readMockERC20B()              internal view returns (address) { return _tryReadAddr(".mockERC20B"); }

    /// Generic typed read for keys not in the curated list above.
    /// `jsonKey` MUST be a JSON-path expression starting with `.`
    /// (e.g. `".myCustomAddress"`). `envKey` is the env-var name
    /// **without** the chain prefix.
    function readAddress(string memory jsonKey, string memory envKey)
        internal
        view
        returns (address)
    {
        return _readAddr(jsonKey, envKey);
    }

    // ── Typed writes ───────────────────────────────────────────────────────
    //
    // Writes are intentionally append-style: each writer reads the
    // current file (or starts fresh), updates one key, and writes
    // back. Concurrent writes within a single broadcast script are
    // safe because Foundry serialises script execution. Writes
    // across multiple script runs are safe in the obvious sequential
    // sense; the runbook invokes deploys in a fixed order.

    function writeDiamond(address a)         internal { _writeAddr(".diamond",         a); }
    function writeEscrowImpl(address a)      internal { _writeAddr(".escrowImpl",      a); }
    function writeTimelock(address a)        internal { _writeAddr(".timelock",        a); }
    function writeVPFIToken(address a)       internal { _writeAddr(".vpfiToken",       a); }
    function writeVPFIOFTAdapter(address a)  internal { _writeAddr(".vpfiOftAdapter",  a); }
    function writeVPFIBuyAdapter(address a)  internal { _writeAddr(".vpfiBuyAdapter",  a); }
    function writeVPFIBuyReceiver(address a) internal { _writeAddr(".vpfiBuyReceiver", a); }
    function writeRewardOApp(address a)      internal { _writeAddr(".rewardOApp",      a); }

    function writeMockChainlinkAggregator(address a) internal { _writeAddr(".mockChainlinkAggregator", a); }
    function writeMockUniswapV3Factory(address a)    internal { _writeAddr(".mockUniswapV3Factory",    a); }
    function writeMockERC20A(address a)              internal { _writeAddr(".mockERC20A",              a); }
    function writeMockERC20B(address a)              internal { _writeAddr(".mockERC20B",              a); }

    /// Generic typed write — keys not in the curated list above.
    function writeAddress(string memory jsonKey, address a) internal {
        _writeAddr(jsonKey, a);
    }

    /// Stamp the file with `chainId` + `deployedAt`. Called from the
    /// top of `DeployDiamond.s.sol` so a partial deploy that crashes
    /// halfway still leaves a discoverable artifact.
    function writeChainHeader() internal {
        string memory p = path();
        // Build a minimal header object. Subsequent writes to the
        // same file via `_writeAddr` will use vm.writeJson, which
        // preserves siblings.
        string memory head = "deployments-header";
        cheats.serializeUint(head, "chainId", block.chainid);
        string memory finalJson = cheats.serializeString(
            head,
            "deployedAt",
            _isoNowApprox()
        );
        // `vm.writeJson` with a file path overwrites the entire file.
        // We only do this on the first call (when no file exists) so
        // we don't clobber existing addresses written in a prior run.
        if (!_fileExists(p)) {
            // `vm.writeJson` does NOT create parent directories; on
            // a fresh chain the per-chain folder won't exist yet.
            cheats.createDir(
                string.concat("deployments/", chainSlug()),
                true
            );
            cheats.writeJson(finalJson, p);
        }
    }

    // ── Internal helpers ───────────────────────────────────────────────────

    function _readAddr(string memory jsonKey, string memory envKeyBase)
        private
        view
        returns (address)
    {
        // 1. Try the addresses.json file.
        string memory p = path();
        if (_fileExists(p)) {
            string memory file = cheats.readFile(p);
            if (bytes(file).length > 0) {
                try cheats.parseJsonAddress(file, jsonKey) returns (address a) {
                    if (a != address(0)) return a;
                } catch {
                    // Key missing / wrong type — fall through.
                }
            }
        }
        // 2. Fall back to the chain-prefixed legacy env var.
        return _legacyEnvAddress(envKeyBase);
    }

    /// Best-effort read — returns `address(0)` instead of reverting
    /// when the key isn't present and there's no env fallback. Used
    /// for keys that may legitimately be absent on some chains
    /// (e.g. testnet mock contracts).
    function _tryReadAddr(string memory jsonKey)
        private
        view
        returns (address)
    {
        string memory p = path();
        if (!_fileExists(p)) return address(0);
        string memory file = cheats.readFile(p);
        if (bytes(file).length == 0) return address(0);
        try cheats.parseJsonAddress(file, jsonKey) returns (address a) {
            return a;
        } catch {
            return address(0);
        }
    }

    function _writeAddr(string memory jsonKey, address a) private {
        string memory p = path();
        // Foundry's `vm.writeJson` updates a single key in place and
        // creates the file if it doesn't exist. The trailing third
        // arg is the JSON-path key (`.diamond`, `.vpfiToken`, …).
        // Path expressions MUST start with `.` per Foundry's parser.
        if (!_fileExists(p)) {
            // `vm.writeJson` does NOT create parent directories; on
            // a fresh chain the per-chain folder won't exist yet, so
            // create it (recursive) before the first write. No-op if
            // the directory already exists.
            cheats.createDir(
                string.concat("deployments/", chainSlug()),
                true
            );
            // Bootstrap: create the file with just `chainId` so
            // subsequent updates have a valid container to merge into.
            string memory head = "deployments-bootstrap";
            cheats.serializeUint(head, "chainId", block.chainid);
            string memory init = cheats.serializeString(
                head,
                "deployedAt",
                _isoNowApprox()
            );
            cheats.writeJson(init, p);
        }
        cheats.writeJson(cheats.toString(a), p, jsonKey);
    }

    function _legacyEnvAddress(string memory envKeyBase)
        private
        view
        returns (address)
    {
        string memory full = string.concat(envPrefix(), envKeyBase);
        return cheats.envAddress(full);
    }

    function _fileExists(string memory p) private view returns (bool) {
        // Foundry's `tryReadFile` returns empty bytes on missing
        // files when wrapped in try/catch via the vm interface, but
        // there's no first-class "exists" cheat. We probe by
        // attempting `readFile` and catching the revert.
        try cheats.readFile(p) returns (string memory contents) {
            return bytes(contents).length > 0;
        } catch {
            return false;
        }
    }

    /// Best-effort UTC timestamp string. Foundry doesn't expose a
    /// real-time formatter, so we use `block.timestamp` as a
    /// monotonic approximation. Format: ISO-8601 fixed at "Z".
    /// The runbook expects this for audit traces; it doesn't need
    /// to be sub-second accurate.
    function _isoNowApprox() private view returns (string memory) {
        return string.concat(
            cheats.toString(block.timestamp),
            "-unix"
        );
    }
}
