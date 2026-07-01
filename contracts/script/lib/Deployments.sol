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
 *           "vaultImpl": "0x…",
 *           "timelock": "0x…",
 *           "vpfiToken": "0x…",
 *           "vpfiOftAdapter": "0x…",
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
    Vm private constant CHEATS = Vm(VM_ADDR);

    // ── Public path API ────────────────────────────────────────────────────

    /// Absolute-from-foundry-root path to the active chain's
    /// `addresses.json`. Foundry resolves relative paths against
    /// `foundry.toml#root` (i.e. the `contracts/` directory in this
    /// repo). The committed file lives at
    /// `contracts/deployments/<slug>/addresses.json`.
    function path() internal view returns (string memory) {
        return string.concat("deployments/", chainSlug(), "/addresses.json");
    }

    /// Per-chain folder slug for the *active* chain. Used both for the
    /// file path and for resolving the matching legacy env-var prefix
    /// (`BASE_SEPOLIA_…`, etc.).
    function chainSlug() internal view returns (string memory) {
        return slugForChainId(block.chainid);
    }

    /// Per-chain folder slug for an arbitrary EVM chain id. Factored out
    /// of {chainSlug} so cross-chain wiring scripts can resolve a *remote*
    /// chain's artifact path. Add new chains here when the protocol
    /// expands.
    function slugForChainId(uint256 cid)
        internal
        pure
        returns (string memory)
    {
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
        if (cid == 31337)     return "anvil";
        revert(
            string.concat(
                "Deployments: unknown chainid ",
                CHEATS.toString(cid)
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
        if (cid == 31337)     return "ANVIL_";
        revert("Deployments: unknown chainid for env prefix");
    }

    // ── Typed reads ────────────────────────────────────────────────────────

    function readDiamond()         internal view returns (address) { return _readAddr(".diamond",         "DIAMOND_ADDRESS"); }
    function readVaultImpl()      internal view returns (address) { return _readAddr(".vaultImpl",      "VAULT_IMPL_ADDRESS"); }
    function readTimelock()        internal view returns (address) { return _readAddr(".timelock",        "TIMELOCK_ADDRESS"); }
    function readVpfiToken()       internal view returns (address) { return _readAddr(".vpfiToken",       "VPFI_TOKEN_ADDRESS"); }
    // T-068 CCIP: the cross-chain reward contract is `VaipakamRewardMessenger`,
    // recorded under `.rewardMessenger` by `DeployCrosschain.s.sol`. Older
    // artifacts (pre-PR #272 contract-side rename) recorded the same
    // address under the LayerZero-era key `.rewardOApp`; this reader
    // tries the new key first and falls back to the legacy key so
    // `Handover.s.sol`, `ConfigureRewardReporter.s.sol`, and any
    // operational tool that walks pre-rename addresses.json files keeps
    // resolving the same address. Without the fallback, every consumer
    // silently resolves to `address(0)` on legacy artifacts.
    function readRewardMessenger() internal view returns (address) {
        address a = _tryReadAddr(".rewardMessenger");
        if (a == address(0)) a = _tryReadAddr(".rewardOApp");
        if (a == address(0)) a = _readAddr(".rewardMessenger", "REWARD_MESSENGER_ADDRESS");
        return a;
    }
    /// @notice Same fallback chain as {readRewardMessenger} but returns
    ///         `address(0)` on full miss instead of reverting. Used by
    ///         callers that need to cross-check an env-var override
    ///         against the artifact without blocking the env-only path
    ///         (e.g. {ConfigureRewardReporter}'s defence-in-depth check).
    function tryReadRewardMessenger() internal view returns (address) {
        address a = _tryReadAddr(".rewardMessenger");
        if (a == address(0)) a = _tryReadAddr(".rewardOApp");
        return a;
    }

    /// @notice Cross-chain typed reader for the reward messenger address on
    ///         `chainId`. Same legacy fallback as {readRewardMessenger}:
    ///         tries `.rewardMessenger` first, falls back to the
    ///         LayerZero-era `.rewardOApp` key for legacy artifacts.
    ///         Reverts loudly if neither key resolves — cross-chain wiring
    ///         must never silently wire `address(0)`. Without this, `ConfigureCcip`
    ///         hard-fails on every legacy addresses.json that another chain
    ///         in the mesh hasn't yet been redeployed against PR #272+
    ///         contracts.
    function readRewardMessengerForChain(uint256 chainId) internal view returns (address) {
        string memory p = string.concat(
            "deployments/", slugForChainId(chainId), "/addresses.json"
        );
        require(
            _fileExists(p),
            string.concat(
                "Deployments: no artifact for chain ",
                CHEATS.toString(chainId),
                " (run the deploy on that chain first)"
            )
        );
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory file = CHEATS.readFile(p);
        address a;
        try CHEATS.parseJsonAddress(file, ".rewardMessenger") returns (address newKey) {
            a = newKey;
        } catch { /* missing new key — try legacy */ }
        if (a == address(0)) {
            try CHEATS.parseJsonAddress(file, ".rewardOApp") returns (address legacyKey) {
                a = legacyKey;
            } catch { /* neither key present */ }
        }
        require(
            a != address(0),
            string.concat(
                "Deployments: neither .rewardMessenger nor .rewardOApp set for chain ",
                CHEATS.toString(chainId)
            )
        );
        return a;
    }

    function readFlashLoanLiquidator() internal view returns (address) { return _tryReadAddr(".flashLoanLiquidator"); }

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

    /// Read an address key from *another* chain's deployment artifact.
    /// Cross-chain wiring scripts (`ConfigureCcip.s.sol`) need a remote
    /// chain's deployed contract addresses to wire lanes / channel peers;
    /// every chain's deploy writes its own
    /// `deployments/<slug>/addresses.json`, and after the
    /// deploy-all-chains-first pass the runbook prescribes, every remote
    /// artifact is already on disk.
    ///
    /// Reverts if the remote artifact is missing or the key is unset — a
    /// cross-chain wire must fail loud, never silently wire `address(0)`.
    function readAddressForChain(uint256 chainId, string memory jsonKey)
        internal
        view
        returns (address)
    {
        string memory p = string.concat(
            "deployments/", slugForChainId(chainId), "/addresses.json"
        );
        require(
            _fileExists(p),
            string.concat(
                "Deployments: no artifact for chain ",
                CHEATS.toString(chainId),
                " (run the deploy on that chain first)"
            )
        );
        // forge-lint: disable-next-line(unsafe-cheatcode)
        address a = CHEATS.parseJsonAddress(CHEATS.readFile(p), jsonKey);
        require(
            a != address(0),
            string.concat(
                "Deployments: ",
                jsonKey,
                " unset for chain ",
                CHEATS.toString(chainId)
            )
        );
        return a;
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
    function writeVaultImpl(address a)      internal { _writeAddr(".vaultImpl",      a); }
    function writeTimelock(address a)        internal { _writeAddr(".timelock",        a); }
    function writeVpfiToken(address a)       internal { _writeAddr(".vpfiToken",       a); }
    function writeVpfiTokenImpl(address a)   internal { _writeAddr(".vpfiTokenImpl",   a); }
    function writeVpfiMirror(address a)      internal { _writeAddr(".vpfiMirror",      a); }
    function writeVpfiMirrorImpl(address a)  internal { _writeAddr(".vpfiMirrorImpl",  a); }
    // ── T-068 CCIP cross-chain stack (Phase 6) ─────────────────────────────
    function writeCcipMessenger(address a)        internal { _writeAddr(".ccipMessenger",        a); }
    function writeVpfiTokenPool(address a)        internal { _writeAddr(".vpfiTokenPool",        a); }
    function writeVpfiPoolRateGovernor(address a) internal { _writeAddr(".vpfiPoolRateGovernor", a); }
    function writeRewardMessenger(address a)      internal { _writeAddr(".rewardMessenger",      a); }
    // T-087 Sub 3.A — Base-side inbound handler for the buyback channel.
    function writeBuybackRemittanceReceiver(address a)     internal { _writeAddr(".buybackRemittanceReceiver",     a); }
    function writeBuybackRemittanceReceiverImpl(address a) internal { _writeAddr(".buybackRemittanceReceiverImpl", a); }
    function writeFlashLoanLiquidator(address a) internal { _writeAddr(".flashLoanLiquidator", a); }
    function writeWeth(address a)            internal { _writeAddr(".weth",            a); }
    function writeTreasury(address a)        internal { _writeAddr(".treasury",        a); }
    function writeAdmin(address a)           internal { _writeAddr(".admin",           a); }
    function writeVpfiDiscountEthPriceAsset(address a) internal { _writeAddr(".vpfiDiscountEthPriceAsset", a); }

    function writeMockChainlinkAggregator(address a) internal { _writeAddr(".mockChainlinkAggregator", a); }
    function writeMockUniswapV3Factory(address a)    internal { _writeAddr(".mockUniswapV3Factory",    a); }
    function writeMockERC20A(address a)              internal { _writeAddr(".mockERC20A",              a); }
    function writeMockERC20B(address a)              internal { _writeAddr(".mockERC20B",              a); }

    /// Per-facet write helper — stores `<facetAddress>` under
    /// `.facets.<facetKey>`. `facetKey` is the lower-camel name
    /// (e.g. `"metricsFacet"`, `"diamondCutFacet"`). Frontend reads
    /// `.diamond` for the proxy address and may optionally surface
    /// per-facet addresses for explorer links.
    function writeFacet(string memory facetKey, address a) internal {
        _writeAddr(string.concat(".facets.", facetKey), a);
    }

    // ── Scalar/uint writes ─────────────────────────────────────────────────

    function writeUint(string memory jsonKey, uint256 value) internal {
        _writeUint(jsonKey, value);
    }

    function writeBool(string memory jsonKey, bool value) internal {
        _writeBool(jsonKey, value);
    }

    function writeString(string memory jsonKey, string memory value) internal {
        _writeString(jsonKey, value);
    }

    function writeChainSlug() internal { _writeString(".chainSlug", chainSlug()); }
    function writeLzEndpoint(address a) internal { _writeAddr(".lzEndpoint", a); }
    function writeLzEid(uint32 eid) internal { _writeUint(".lzEid", uint256(eid)); }

    /// @notice Stamp the contract's deployment block, picking the correct
    ///         "block number" per chain semantics.
    ///
    ///         **Arbitrum gotcha**: inside the EVM, `block.number` on
    ///         Arbitrum chains returns the L1 block number (an "approximate"
    ///         L1 block the sequencer acknowledged), NOT the L2 block where
    ///         the transaction actually landed. The L2 block number must be
    ///         read from `ArbSys(0x64).arbBlockNumber()`. This caused
    ///         arb-sepolia's deployBlock to be stamped at L1 block ~10.8M
    ///         (in sepolia's range) instead of L2 block ~266.9M during the
    ///         2026-05-10 F2 rehearsal. The indexer relies on deployBlock
    ///         for cold-start cursor seeding — a wrong value either makes
    ///         the indexer scan ~256M irrelevant blocks (gas-budget
    ///         exhaustion) or skip the deploy block entirely (zero offers
    ///         visible).
    ///
    ///         Use this helper from every script that needs the chain's
    ///         L2 deploy block. Direct `block.number` reads are NOT safe
    ///         on Arbitrum.
    function writeDeployBlock() internal { _writeUint(".deployBlock", currentL2Block()); }

    /// @notice Backwards-compatible explicit-block variant. Prefer the
    ///         no-arg form (`writeDeployBlock()`) which calls
    ///         `currentL2Block()` internally — direct `block.number` from
    ///         the caller is unsafe on Arbitrum.
    function writeDeployBlock(uint256 blockNum) internal { _writeUint(".deployBlock", blockNum); }

    /// @notice Returns the current L2 block number for the active chain.
    ///         On Arbitrum (One mainnet 42161, Sepolia 421614, Nova 42170)
    ///         queries ArbSys precompile at 0x64. On every other chain
    ///         (Ethereum L1, OP Stack, BNB, Polygon zkEVM, anvil) returns
    ///         `block.number` directly — the EVM opcode there already maps
    ///         to the chain's native block height.
    function currentL2Block() internal view returns (uint256) {
        uint256 cid = block.chainid;
        if (cid == 42161 || cid == 421614 || cid == 42170) {
            (bool ok, bytes memory data) = address(0x64).staticcall(
                abi.encodeWithSignature("arbBlockNumber()")
            );
            if (ok && data.length >= 32) {
                return abi.decode(data, (uint256));
            }
            // forge's simulation EVM does NOT emulate the Arbitrum ArbSys
            // precompile, so the in-EVM call above reverts during
            // `forge script`. Fall back to an operator-supplied L2 block:
            // read the RPC's `eth_blockNumber` (which returns the L2 height on
            // Arbitrum, unlike the in-EVM `block.number` which returns L1) and
            // pass it as ARB_L2_DEPLOY_BLOCK. Revert with guidance rather than
            // silently stamping the wrong L1 `block.number` — the exact bug
            // this ArbSys path exists to prevent.
            uint256 l2Override = CHEATS.envOr("ARB_L2_DEPLOY_BLOCK", uint256(0));
            require(
                l2Override != 0,
                "Deployments: ArbSys unavailable in forge sim; set ARB_L2_DEPLOY_BLOCK to the arb eth_blockNumber"
            );
            return l2Override;
        }
        return block.number;
    }

    function writeIsCanonicalVpfi(bool v) internal { _writeBool(".isCanonicalVPFI", v); }
    function writeIsCanonicalReward(bool v) internal { _writeBool(".isCanonicalReward", v); }
    // T-068: a chain's own identity is `block.chainid` — there is no
    // `rewardLocalEid` to record. `rewardBaseChainId` is the canonical
    // reward chain's EVM chain id (was the LayerZero `rewardBaseEid`).
    function writeRewardBaseChainId(uint32 chainId) internal { _writeUint(".rewardBaseChainId", uint256(chainId)); }
    function writeRewardGraceSeconds(uint64 secs) internal { _writeUint(".rewardGraceSeconds", uint256(secs)); }
    function writeInteractionLaunchTimestamp(uint256 ts) internal { _writeUint(".interactionLaunchTimestamp", ts); }

    /// Generic typed write — keys not in the curated list above.
    function writeAddress(string memory jsonKey, address a) internal {
        _writeAddr(jsonKey, a);
    }

    // ── LayerZero EID resolver (per chain) ────────────────────────────────
    //
    // Centralised so every script writes a consistent eid into
    // addresses.json without the operator having to remember the
    // table. Source: LayerZero V2 deployments index.

    function lzEidForChain() internal view returns (uint32) {
        uint256 cid = block.chainid;
        if (cid == 1)         return 30101; // Ethereum
        if (cid == 8453)      return 30184; // Base
        if (cid == 84532)     return 40245; // Base Sepolia
        if (cid == 11155111)  return 40161; // Sepolia
        if (cid == 421614)    return 40231; // Arb Sepolia
        if (cid == 11155420)  return 40232; // OP Sepolia
        if (cid == 80002)     return 40267; // Polygon Amoy
        if (cid == 1101)      return 30257; // Polygon zkEVM
        if (cid == 56)        return 30102; // BNB
        if (cid == 97)        return 40102; // BNB Testnet
        if (cid == 42161)     return 30110; // Arbitrum
        if (cid == 10)        return 30111; // Optimism
        if (cid == 137)       return 30109; // Polygon
        if (cid == 31337)     return 31337; // Anvil — sentinel only; no real LZ traffic on a local node.
        revert("Deployments: no LZ EID mapped for chainid");
    }

    // ── CCIP chain-selector resolver (per chain) ──────────────────────────
    //
    // The Chainlink CCIP analogue of {lzEidForChain}: every chain has a
    // provider-published 64-bit "chain selector" that CCIP routes on.
    // Centralised here so `ConfigureCcip.s.sol` and the rehearsal harness
    // resolve a chain → selector without the operator hand-keying the
    // table. Source: Chainlink CCIP "Supported Networks" directory.
    //
    // Anvil (31337) is intentionally absent — a local node has no CCIP
    // deployment; the anvil rehearsal uses `CCIPLocalSimulator`, which
    // mints its own selectors at runtime.

    function ccipSelectorForChainId(uint256 cid)
        internal
        pure
        returns (uint64)
    {
        if (cid == 1)         return 5009297550715157269;  // Ethereum
        if (cid == 8453)      return 15971525489660198786; // Base
        if (cid == 42161)     return 4949039107694359620;  // Arbitrum One
        if (cid == 10)        return 3734403246176062136;  // Optimism
        if (cid == 56)        return 11344663589394136015; // BNB Chain
        if (cid == 137)       return 4051577828743386545;  // Polygon PoS
        if (cid == 11155111)  return 16015286601757825753; // Sepolia
        if (cid == 84532)     return 10344971235874465080; // Base Sepolia
        if (cid == 421614)    return 3478487238524512106;  // Arbitrum Sepolia
        if (cid == 11155420)  return 5224473277236331295;  // OP Sepolia
        if (cid == 97)        return 13264668187771770619; // BNB Chain testnet
        if (cid == 80002)     return 16281711391670634445; // Polygon Amoy
        revert("Deployments: no CCIP selector mapped for chainid");
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
        CHEATS.serializeUint(head, "chainId", block.chainid);
        string memory finalJson = CHEATS.serializeString(
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
            CHEATS.createDir(
                string.concat("deployments/", chainSlug()),
                true
            );
            CHEATS.writeJson(finalJson, p);
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
            // forge-lint: disable-next-line(unsafe-cheatcode)
            string memory file = CHEATS.readFile(p);
            if (bytes(file).length > 0) {
                try CHEATS.parseJsonAddress(file, jsonKey) returns (address a) {
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
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory file = CHEATS.readFile(p);
        if (bytes(file).length == 0) return address(0);
        try CHEATS.parseJsonAddress(file, jsonKey) returns (address a) {
            return a;
        } catch {
            return address(0);
        }
    }

    function _writeAddr(string memory jsonKey, address a) private {
        _ensureFile();
        CHEATS.writeJson(CHEATS.toString(a), path(), jsonKey);
    }

    function _writeUint(string memory jsonKey, uint256 v) private {
        _ensureFile();
        CHEATS.writeJson(CHEATS.toString(v), path(), jsonKey);
    }

    function _writeBool(string memory jsonKey, bool v) private {
        _ensureFile();
        CHEATS.writeJson(v ? "true" : "false", path(), jsonKey);
    }

    function _writeString(string memory jsonKey, string memory v) private {
        _ensureFile();
        // Manually quote — `vm.writeJson(value, path, key)` accepts a
        // raw JSON fragment. For strings we must wrap in double quotes
        // so the result is valid JSON (otherwise Foundry interprets the
        // value as a number/identifier and produces malformed output).
        CHEATS.writeJson(string.concat("\"", v, "\""), path(), jsonKey);
    }

    /// Bootstrap the per-chain `addresses.json` if missing. Creates
    /// the parent directory recursively, then writes a minimal
    /// `{chainId, deployedAt}` skeleton so subsequent typed writes can
    /// merge their key in place.
    function _ensureFile() private {
        string memory p = path();
        if (_fileExists(p)) return;
        CHEATS.createDir(
            string.concat("deployments/", chainSlug()),
            true
        );
        string memory head = "deployments-bootstrap";
        CHEATS.serializeUint(head, "chainId", block.chainid);
        string memory init = CHEATS.serializeString(
            head,
            "deployedAt",
            _isoNowApprox()
        );
        CHEATS.writeJson(init, p);
    }

    function _legacyEnvAddress(string memory envKeyBase)
        private
        view
        returns (address)
    {
        string memory full = string.concat(envPrefix(), envKeyBase);
        return CHEATS.envAddress(full);
    }

    function _fileExists(string memory p) private view returns (bool) {
        // Foundry's `tryReadFile` returns empty bytes on missing
        // files when wrapped in try/catch via the vm interface, but
        // there's no first-class "exists" cheat. We probe by
        // attempting `readFile` and catching the revert.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        try CHEATS.readFile(p) returns (string memory contents) {
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
            CHEATS.toString(block.timestamp),
            "-unix"
        );
    }
}
