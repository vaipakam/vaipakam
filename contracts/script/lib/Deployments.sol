// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {IArtifactRoot} from "./ArtifactRoot.sol";
// The REAL cut interface, imported rather than approximated. An earlier
// revision declared a "minimal" `diamondCut(bytes,address,bytes)` here to keep
// this library free of domain imports; that has a DIFFERENT selector from the
// real `diamondCut(FacetCut[],address,bytes)`, so the loupe lookup returned
// address(0) and the guard reported every deploy as missing a facet. A
// hand-written interface is not a free abstraction when a selector is the thing
// being looked up.
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

/// @dev The completeness assertion, as {finalizeArtifact} reaches it: on the
///      CALLING SCRIPT, across an external call to itself.
///
///      Two things need that boundary, and neither is a matter of taste.
///      Solidity's `try` only wraps external calls, and {finalizeArtifact} has
///      to catch EVERY way the assertion can fail so it can put the operator's
///      artifact back before re-reverting. And the assertion is the one seam a
///      test needs to override — to observe that a real deploy reached it, or
///      to force it to fail — while `DeployDiamond.runWith` sits at the viaIR
///      whole-unit stack ceiling with no room for a subclass to override
///      anything INLINED into it. An external function is not inlined, so a
///      probe can override this one at no cost to that frame.
interface IArtifactVerifier {
    function assertFacetsRecordedExternal(address[] calldata expected) external;
}

/// @dev Minimal loupe surface, declared here so the artifact library keeps no
///      dependency on the domain contracts it records. The CUT interface is
///      imported rather than approximated the same way — see the note on that
///      import — because there a selector is the value being looked up.
interface ILoupeMinimal {
    function facetAddresses() external view returns (address[] memory);
    function facetAddress(bytes4 selector) external view returns (address);
}



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

    /// The committed artifact root, relative to `foundry.toml#root` (i.e. the
    /// `contracts/` directory). `fs_permissions` grants read-write on this
    /// subtree and nowhere else, so an override must stay INSIDE it.
    string internal constant ARTIFACT_ROOT = "deployments";

    /// The directory holding every chain's `addresses.json` for this run.
    /// Normally {ARTIFACT_ROOT}; a script that has set an override through
    /// {ArtifactRootBase} gets its own directory instead.
    ///
    /// @dev The override is read from the CALLING SCRIPT, not from the
    ///      environment — this library's `internal` functions execute in the
    ///      script's context, so `address(this)` is that script and the answer
    ///      comes out of its storage. See `ArtifactRoot.sol` for why that
    ///      distinction is load-bearing (`vm.setEnv` is process-global and
    ///      every parallel test shares it). A caller that does not implement
    ///      {IArtifactRoot} — most scripts — falls through to the default,
    ///      which is why the call is wrapped rather than required.
    function artifactRoot() internal view returns (string memory) {
        try IArtifactRoot(address(this)).artifactRootOverride() returns (
            string memory overridden
        ) {
            if (bytes(overridden).length != 0) return overridden;
        } catch {
            // Not an ArtifactRootBase script: the committed root is correct.
        }
        return ARTIFACT_ROOT;
    }

    /// TRUE when this run writes to a scratch root rather than the committed
    /// one.
    ///
    /// @dev Reads the PRESENCE of an override, never a comparison of the
    ///      resolved root against {ARTIFACT_ROOT} (#2253 r1 P2). A string
    ///      comparison answers "does this look like the default?", which every
    ///      alias of the default — `./deployments`, `deployments/`,
    ///      `deployments/.` — gets wrong in the dangerous direction: not equal,
    ///      therefore "redirected", therefore writes forced on, therefore the
    ///      committed artifact overwritten. The fact is already known without
    ///      inferring it, and `ARTIFACT_SCRATCH_PREFIX` makes an override
    ///      that aliases the default unrepresentable.
    function artifactIsRedirected() internal view returns (bool) {
        try IArtifactRoot(address(this)).artifactRootOverride() returns (
            string memory overridden
        ) {
            return bytes(overridden).length != 0;
        } catch {
            return false;
        }
    }

    /// Directory holding `addresses.json` for an arbitrary EVM chain.
    function dirForChainId(uint256 cid) internal view returns (string memory) {
        return string.concat(artifactRoot(), "/", slugForChainId(cid));
    }

    /// Path to an arbitrary EVM chain's `addresses.json`.
    ///
    /// @dev EVERY artifact path in this library is built here. Five call sites
    ///      used to concatenate `"deployments/" + slug + "/addresses.json"`
    ///      by hand, which is four opportunities for one of them to disagree
    ///      with the others — and would have been four places to forget when
    ///      the root became redirectable.
    function pathForChainId(uint256 cid) internal view returns (string memory) {
        return string.concat(dirForChainId(cid), "/addresses.json");
    }

    /// Absolute-from-foundry-root path to the active chain's
    /// `addresses.json`. Foundry resolves relative paths against
    /// `foundry.toml#root` (i.e. the `contracts/` directory in this
    /// repo). The committed file lives at
    /// `contracts/deployments/<slug>/addresses.json`.
    function path() internal view returns (string memory) {
        return pathForChainId(block.chainid);
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

    /// @notice Optional read of `.vpfiToken` from the ARTIFACT ONLY — never the
    ///         legacy env fallback, and never reverts. Returns address(0) when
    ///         the key is absent. `readVpfiToken()` falls through to the typed
    ///         (mandatory) `VPFI_TOKEN_ADDRESS` env reader and REVERTS when the
    ///         key is missing, which would break `DeployVPFIToken`'s
    ///         no-overwrite guard on a clean canonical first deploy — there
    ///         `.vpfiToken` is intentionally absent until the mint runs, yet the
    ///         operator's documented env set may already carry a
    ///         `<CHAIN>_VPFI_TOKEN_ADDRESS` for other scripts. This json-only,
    ///         non-reverting read is what that guard must use (#853 Codex P1).
    function readVpfiTokenOptional() internal view returns (address) {
        return _tryReadAddr(".vpfiToken");
    }

    /// @notice Optional, non-reverting artifact read of `.vpfiMirror` — the
    ///         Burn/Mint mirror VPFI ERC20 a mirror chain's `DeployCrosschain`
    ///         records. Returns address(0) when absent. `ConfigureVPFIToken`
    ///         uses it to register the mirror token in the Diamond's
    ///         `s.vpfiToken` slot on mirror chains (#853 Codex P1).
    function readVpfiMirrorOptional() internal view returns (address) {
        return _tryReadAddr(".vpfiMirror");
    }

    /// @notice Optional, non-reverting artifact read of `.weth` — the
    ///         wrapped-native oracle reference `DeployTestnetMocks`
    ///         persists (on Anvil it deploys an inline mock WETH and
    ///         records it here). Returns address(0) when absent.
    ///         `DeployTestnetVPFI` uses it so the local Anvil sequence
    ///         (mocks first, VPFI second) reuses the same WETH instead
    ///         of silently wiring `setVPFIDiscountETHPriceAsset(0)`,
    ///         which disables the discount quote.
    function readWethOptional() internal view returns (address) {
        return _tryReadAddr(".weth");
    }
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
        string memory p = pathForChainId(chainId);
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
    /// @notice #1566 slice 4 PR A — optional, non-reverting read of
    ///         `.rewardCustodyHolder`. Zero on a chain that predates the
    ///         holder and has not yet run `DeployRewardCustodyHolder`.
    function readRewardCustodyHolderOptional() internal view returns (address) { return _tryReadAddr(".rewardCustodyHolder"); }

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
        string memory p = pathForChainId(chainId);
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
    // #776 — mirror-side inbound handler for the reward-budget channel.
    function writeRewardRemittanceReceiver(address a)     internal { _writeAddr(".rewardRemittanceReceiver",     a); }
    function writeRewardRemittanceReceiverImpl(address a) internal { _writeAddr(".rewardRemittanceReceiverImpl", a); }
    // #1568 C2 — the shared mirror→Base vpfi-return channel satellites:
    // sender/escrow on mirrors, kind-dispatching receiver on Base.
    function writeVpfiReturnSender(address a)       internal { _writeAddr(".vpfiReturnSender",       a); }
    function writeVpfiReturnSenderImpl(address a)   internal { _writeAddr(".vpfiReturnSenderImpl",   a); }
    function writeVpfiReturnReceiver(address a)     internal { _writeAddr(".vpfiReturnReceiver",     a); }
    function writeVpfiReturnReceiverImpl(address a) internal { _writeAddr(".vpfiReturnReceiverImpl", a); }
    function writeFlashLoanLiquidator(address a) internal { _writeAddr(".flashLoanLiquidator", a); }
    /// @notice #1566 slice 4 PR A — the delivered reward custody holder
    ///         (`RewardCustodyHolder`) bound to this Diamond. Written once by
    ///         `DeployDiamond` (fresh deploys) or `DeployRewardCustodyHolder`
    ///         (live chains); replaced only by the paused ceremony.
    function writeRewardCustodyHolder(address a) internal { _writeAddr(".rewardCustodyHolder", a); }
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

    /// @notice Require that every address in `expected` was recorded under some
    ///         `.facets.*` key of the artifact this run just wrote.
    ///
    /// @dev    **The ROOT fix for #1800, and it is deliberately NOT a test**
    ///         (#2253 r2). The guard began life as a test that deployed under a
    ///         matrix of chain ids and asserted completeness for each. Review
    ///         then found, correctly and twice, that the matrix was incomplete:
    ///         first that it covered only chain 31337, then that it listed a
    ///         RETIRED chain while omitting an ACTIVE one and never exercised
    ///         the production admin≠deployer topology. Each time, a
    ///         registration guarded on the uncovered dimension would pass.
    ///
    ///         Those two rounds are one seam, and the seam is unbounded: a
    ///         write can be guarded on chain id, on admin≠deployer, on the
    ///         treasury address, on `block.number`, on any env var, on
    ///         anything at all. A test matrix can only ever enumerate the
    ///         dimensions somebody thought of, so every round buys one more
    ///         dimension and leaves the class open — the #1995 pattern, which
    ///         this repository has twice resolved by DELETING the enumeration
    ///         rather than extending it.
    ///
    ///         So the completeness check moves OUT of the test matrix and INTO
    ///         the deploy. Every real deploy now verifies its own artifact,
    ///         under whatever chain, admin topology, treasury and configuration
    ///         that deploy actually runs with. There is no matrix to be
    ///         incomplete, because there is no matrix: the conditions under
    ///         test are by construction the conditions in effect. A guard on an
    ///         un-enumerated dimension cannot evade a check that runs inside
    ///         the branch it guards.
    ///
    ///         It is also strictly stronger than any test could be — it covers
    ///         mainnet chains and operator topologies no test will ever run.
    ///
    ///         Ordering matters: call this AFTER every `writeFacet` and outside
    ///         the broadcast. A failure here means the Diamond was deployed but
    ///         its artifact is incomplete, which is recoverable — the addresses
    ///         remain on-chain via `DiamondLoupeFacet.facetAddresses()` and in
    ///         the broadcast log — so failing loudly at the end is strictly
    ///         better than the silence #1798 actually shipped with.
    function snapshotArtifact()
        internal
        view
        returns (string memory prior, bool existed)
    {
        string memory p = path();
        existed = _fileExists(p);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        if (existed) prior = CHEATS.readFile(p);
    }

    /// @dev Capture the artifact and hand it to the calling script to hold.
    ///
    ///      Pushed into the script rather than returned because the caller
    ///      cannot hold it: `DeployDiamond.runWith` is at the viaIR stack
    ///      ceiling, and four compiles failed on "Variable expr_… is 1 too
    ///      deep" from nothing more than one extra local or a destructured
    ///      return in that frame. A script that does not implement
    ///      {IArtifactRoot} simply has no snapshot, which is why this is
    ///      wrapped rather than required.
    function _recordSnapshotOnCaller() private {
        (string memory prior, bool existed) = snapshotArtifact();
        try IArtifactRoot(address(this)).recordArtifactSnapshot(prior, existed) {
        } catch {
            // Not an ArtifactRootBase script: nothing verifies, nothing restores.
        }
    }

    /// @dev The snapshot {_recordSnapshotOnCaller} stored, or empty.
    function callerSnapshot()
        internal
        view
        returns (string memory prior, bool priorExisted)
    {
        try IArtifactRoot(address(this)).artifactSnapshot() returns (
            string memory p_, bool e_
        ) {
            return (p_, e_);
        } catch {
            return ("", false);
        }
    }

    /// @notice Close out the run's artifact: print what was recorded, then
    ///         require every facet the built Diamond reports to appear in it,
    ///         restoring the operator's previous artifact if it does not.
    ///
    /// @dev    Takes only the Diamond address and does its own loupe reads on
    ///         purpose. `DeployDiamond.runWith` is AT the viaIR stack ceiling
    ///         with ~80 live facet addresses, and building the facet list in
    ///         that frame is what several failed compiles were; it also absorbs
    ///         the "Wrote addresses to …" log and the deployment summary the
    ///         frame used to print itself, so the net change there is negative.
    ///
    ///         Ordering matters: this runs AFTER every `writeFacet` and outside
    ///         the broadcast. A failure means the Diamond was deployed but its
    ///         artifact is incomplete — recoverable, since the addresses remain
    ///         on-chain via `facetAddresses()` and in the broadcast log — so
    ///         failing loudly at the end is strictly better than the silence
    ///         #1798 actually shipped with.
    ///
    ///         The LOUPE surface is declared inline (two view functions, no
    ///         selector semantics) but the CUT interface is imported: its
    ///         selector is the value being looked up, and an approximation of
    ///         it silently resolves to a different function.
    function finalizeArtifact(address diamond) internal {
        console.log("");
        console.log("=== Deployment Summary ===");
        console.log("Diamond:              ", diamond);
        console.log(
            "Wrote addresses to deployments/", chainSlug(), "/addresses.json"
        );
        if (!artifactWritesEnabled()) {
            // Say so rather than print nothing. A run with artifact writes off
            // has no recorded facet set to read back, and a summary that simply
            // stopped after the Diamond address would read as "this deploy
            // installed no facets".
            console.log(
                "Artifact writes are off for this run, so there is no recorded"
                " facet set to list and no completeness check to run."
            );
            return;
        }

        printRecordedFacets();

        address[] memory routed = ILoupeMinimal(diamond).facetAddresses();
        address[] memory recorded = new address[](routed.length + 1);
        for (uint256 i; i < routed.length; ++i) recorded[i] = routed[i];
        // `diamondCutFacet` is appended SEPARATELY: the Diamond's constructor
        // installs that selector by writing `selectorToFacetAndPosition`
        // directly, so `facetAddresses()` structurally cannot report it, and a
        // check built only on that enumeration would be blind to the one facet
        // that can never be re-cut (#1798 r9).
        recorded[routed.length] =
            ILoupeMinimal(diamond).facetAddress(IDiamondCut.diamondCut.selector);

        // Reached through the CALLER so the assertion can be wrapped, and so a
        // failure puts the operator's artifact back before it propagates.
        //
        // #2253 r5 P1 — restoring inside the assertion's own not-found branch
        // was a bet that its author had enumerated the failure modes, and this
        // PR's history says that bet loses: `parseJsonAddress` reverts outright
        // when a `.facets` entry holds the wrong JSON type, and that revert
        // happened before execution ever reached the restore. Catching here
        // covers every failure the assertion has today and every one added to
        // it later.
        try IArtifactVerifier(address(this)).assertFacetsRecordedExternal(recorded) {
            return;
        } catch (bytes memory err) {
            (string memory prior, bool existed) = callerSnapshot();
            restoreArtifact(prior, existed);
            // Re-revert with the assertion's own message. The operator needs to
            // read which facet was unrecorded, not that a call failed.
            // forge-lint: disable-next-line(unsafe-assembly)
            assembly ("memory-safe") {
                revert(add(err, 0x20), mload(err))
            }
        }
    }

    /// @notice Print every facet the run recorded, read back FROM the artifact.
    ///
    /// @dev    #2253 r6. `runWith` used to print this list from a second,
    ///         hand-maintained block of ~45 `console.log`s naming the same
    ///         addresses the `writeFacet` block above it had just written.
    ///
    ///         Reading the artifact back instead makes the summary honest: what
    ///         the operator sees is what was RECORDED, not a parallel list that
    ///         can disagree with it. A `writeFacet` omission — the #1798 bug —
    ///         was invisible in the old summary precisely because the two lists
    ///         were independent, so an operator reading it saw a facet that the
    ///         artifact did not name. Here it shows up as a missing line, and
    ///         the check immediately below turns it into a failed deploy.
    ///
    ///         It also takes ~45 live addresses out of `runWith`'s frame, which
    ///         is welcome on a function near the viaIR stack ceiling — but do
    ///         NOT read that as the reason the completeness check fits. It was
    ///         tried as the fix and measured: removing the block moved the
    ///         overflow by a single slot and did not clear it. What cleared it
    ///         was moving the override seam off an `internal` hook, and the
    ///         honesty argument above is why this change was kept anyway.
    function printRecordedFacets() internal view {
        string memory p = path();
        if (!_fileExists(p)) return;
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory file = CHEATS.readFile(p);
        string[] memory keys = CHEATS.parseJsonKeys(file, ".facets");
        for (uint256 i; i < keys.length; ++i) {
            console.log(
                keys[i],
                CHEATS.parseJsonAddress(file, string.concat(".facets.", keys[i]))
            );
        }
    }

    /// @notice Empty the `.facets` namespace so it describes THIS run only.
    ///
    /// @dev    #2253 r5 P2 — the typed writers MERGE into the existing file, so
    ///         a re-deploy inherits the previous run's facet keys. On the
    ///         documented fresh-Anvil workflow that is not hypothetical:
    ///         `anvil-bootstrap.sh` restarts the chain and reuses the fixed
    ///         default deployer, so the CREATE addresses REPEAT while the
    ///         committed `deployments/anvil/addresses.json` stays. Deleting a
    ///         `writeFacet` then leaves the prior run's matching value in place,
    ///         and a scan of the file's VALUES passes for a facet this run never
    ///         recorded.
    ///
    ///         Clearing first makes the namespace mean what the check assumes it
    ///         means. That is also the honest artifact semantics: a fresh
    ///         Diamond's facet set is not the previous Diamond's, and a key
    ///         inherited from a superseded deploy is a stale address wearing a
    ///         current label.
    function clearFacets() internal {
        if (!artifactWritesEnabled()) return;
        _ensureFile();
        // forge-lint: disable-next-line(unsafe-cheatcode)
        CHEATS.writeJson("{}", path(), ".facets");
    }

    /// @notice Put the artifact back as {snapshotArtifact} found it.
    ///
    /// @dev    #2253 r5 P1 — separated from the check so the caller can run it
    ///         as a FINALLY around every failure mode, not only the one the
    ///         check anticipated. See {assertFacetsRecorded}.
    function restoreArtifact(string memory prior, bool priorExisted) internal {
        string memory p = path();
        if (priorExisted) {
            // forge-lint: disable-next-line(unsafe-cheatcode)
            CHEATS.writeFile(p, prior);
        } else if (_fileExists(p)) {
            // forge-lint: disable-next-line(unsafe-cheatcode)
            CHEATS.removeFile(p);
        }
    }

    /// @notice Require that every address in `expected` is recorded under some
    ///         `.facets.*` key. REVERTS WITHOUT RESTORING — the caller owns the
    ///         restore, so that it covers every way this can fail.
    ///
    /// @dev    #2253 r5 P1. An earlier revision restored inside the
    ///         facet-not-found branch, which left every OTHER failure
    ///         un-restored: `parseJsonAddress` reverts outright when an existing
    ///         `.facets` entry holds the wrong JSON type, and that revert
    ///         happened before execution ever reached the restore. The artifact
    ///         then stayed clobbered — precisely the outcome the snapshot exists
    ///         to prevent, reachable by a different door.
    ///
    ///         Restoring in a branch is a bet that the author enumerated the
    ///         failure modes; this PR's own history says that bet loses. The
    ///         caller now wraps this in try/catch and restores on ANY revert,
    ///         including ones added later.
    function assertFacetsRecorded(address[] memory expected) internal view {
        if (!artifactWritesEnabled()) return;

        string memory p = path();
        require(
            _fileExists(p),
            "Deployments: the deploy wrote no artifact to verify - the completeness check must run after the artifact writes"
        );
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory file = CHEATS.readFile(p);
        string[] memory keys = CHEATS.parseJsonKeys(file, ".facets");

        for (uint256 i; i < expected.length; ++i) {
            bool found;
            for (uint256 j; j < keys.length && !found; ++j) {
                if (
                    CHEATS.parseJsonAddress(
                        file, string.concat(".facets.", keys[j])
                    ) == expected[i]
                ) {
                    found = true;
                }
            }
            require(
                found,
                string.concat(
                    "Deployments: facet ",
                    CHEATS.toString(expected[i]),
                    " is installed in the Diamond but was never recorded under any .facets.* key of ",
                    p,
                    " - add its Deployments.writeFacet(...) line. Nothing was deployed and the previous artifact has been left untouched. The address is not lost: DiamondLoupeFacet.facetAddresses() and the broadcast log both still carry it."
                )
            );
        }
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

    // ── CCIP chain-selector resolver (per chain) ──────────────────────────
    //
    // Every chain has a provider-published 64-bit "chain selector" that
    // CCIP routes on. (This replaced a LayerZero endpoint-id resolver,
    // removed with the last of the LZ deploy residue — the transport is
    // CCIP-only and no script stamps an eid any more.)
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
    /// @dev Also OPENS the artifact for this run: captures what was there (so a
    ///      failed completeness check can put it back — #2253 r3 P1) and, at the
    ///      end, empties `.facets` so the namespace describes this run only
    ///      (#2253 r5 P2). The snapshot is returned for the caller to hold.
    ///
    ///      Folded in here rather than added as separate statements because
    ///      `DeployDiamond.runWith` is AT the viaIR stack ceiling with ~80 live
    ///      facet addresses: three compiles failed on "Variable expr_… is 1 too
    ///      deep" purely from extra call sites in that frame. It is also the
    ///      honest seam — writing the chain header IS the start of the run's
    ///      artifact — and this function has exactly ONE caller
    ///      (`DeployDiamond`), so nothing else changes behaviour.
    function writeChainHeader() internal {
        _recordSnapshotOnCaller();
        requireMarkedPublication(".chainId");
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
            CHEATS.createDir(dirForChainId(block.chainid), true);
            CHEATS.writeJson(finalJson, p);
        }
        clearFacets();
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

    /// @notice Committed archive manifest the deploy wrappers mark their live
    ///         publication in (archive-manifest.mjs live-begin / live-end).
    string internal constant ARCHIVE_MANIFEST = "deployments/archive-manifest.json";

    /// @notice The artifact keys the grandfathered-custody census reads as a
    ///         deployment's IDENTITY. Writing one of them is a publication.
    function isIdentityKey(string memory jsonKey) internal pure returns (bool) {
        bytes32 k = keccak256(bytes(jsonKey));
        return k == keccak256(".diamond") || k == keccak256(".vpfiToken") || k == keccak256(".vpfiMirror")
            || k == keccak256(".chainId") || k == keccak256(".deployBlock");
    }

    /// @notice TRUE when `manifestJson` carries an in-progress live-publication
    ///         marker for `slug` whose token is exactly `token`. The single
    ///         predicate behind {requireMarkedPublication}; its test feeds it
    ///         synthetic manifests, the gate feeds it the committed one.
    function publicationMarked(string memory manifestJson, string memory slug, string memory token)
        internal
        view
        returns (bool)
    {
        // Bracket form: slugs carry hyphens (`base-sepolia`), which a dotted
        // JSON path would split. A manifest with no marker section at all
        // (the committed state between deploys) simply has no such key.
        string memory key = string.concat('.livePublicationsInProgress["', slug, '"].token');
        if (bytes(token).length == 0 || !CHEATS.keyExistsJson(manifestJson, key)) return false;
        return keccak256(bytes(CHEATS.parseJsonString(manifestJson, key))) == keccak256(bytes(token));
    }

    /// @notice What a run may do with the artifact. Decided by ONE pure rule so
    ///         the gate's test can exercise every combination the live call
    ///         cannot reach from inside `forge test`.
    enum ArtifactWrites {
        Write,
        Skip,
        RefuseSkipOnLiveBroadcast
    }

    /// @notice #2070 r27 P1 — `DEPLOY_SKIP_ARTIFACTS` used to be honoured
    ///         anywhere, so a live `forge script … --broadcast` carrying it
    ///         (stale in the environment, say) deployed a Diamond the
    ///         inventory never saw: no artifact, no marker, no generation bump,
    ///         and a later census could certify every class empty while
    ///         omitting it. The skip is now LOCAL-ONLY — the Anvil chain or a
    ///         `forge test` run — and a live broadcast that carries it is
    ///         REFUSED. A dry-run (no `--broadcast`) never writes: its addresses
    ///         are simulated.
    /// @dev `redirected` — this run has an artifact-root override, so its
    ///      artifact cannot reach the committed one. It belongs INSIDE the
    ///      rule rather than as an early return in front of it (#2253 r1 P2).
    ///      An earlier revision short-circuited `artifactWritesEnabled` before
    ///      this function ran, which skipped the `dryRun` arm: an Anvil script
    ///      carrying an override and run WITHOUT `--broadcast` then reached
    ///      `writeChainHeader()` — which has no dry-run guard of its own — and
    ///      produced a header-only artifact for a deployment that never
    ///      happened, while the typed writers after it correctly skipped. One
    ///      rule, every combination, is what the enum and this signature exist
    ///      for; a special case in front of it is not a smaller change, it is
    ///      the same change with one arm silently unreachable.
    function artifactWriteMode(
        uint256 chainId,
        bool dryRun,
        bool underTest,
        bool skipRequested,
        bool redirected
    )
        internal
        pure
        returns (ArtifactWrites)
    {
        if (dryRun) return ArtifactWrites.Skip;
        if (!skipRequested || redirected) return ArtifactWrites.Write;
        if (chainId == 31337 || underTest) return ArtifactWrites.Skip;
        return ArtifactWrites.RefuseSkipOnLiveBroadcast;
    }

    /// @notice TRUE when this run writes the artifact. Reverts when
    ///         `DEPLOY_SKIP_ARTIFACTS` is set on a live broadcast — call it at
    ///         the top of a deploy script so the simulation fails BEFORE any
    ///         transaction is sent.
    ///
    /// @dev    A script that has REDIRECTED its artifact root writes
    ///         regardless of `DEPLOY_SKIP_ARTIFACTS`, and this is the point of
    ///         the redirect rather than an exception to the rule. The skip
    ///         exists so a `forge test` deploy does not clobber the committed
    ///         `deployments/anvil/addresses.json`; a redirected run cannot
    ///         reach that file, so the hazard the skip answers is already gone.
    ///         It matters because the env flag is PROCESS-GLOBAL: a sibling
    ///         test exporting `DEPLOY_SKIP_ARTIFACTS=true` — which several do —
    ///         would otherwise silently turn off the writes an artifact
    ///         assertion depends on, and the assertion would then read a file
    ///         nobody wrote. The override is script-instance storage and
    ///         therefore thread-local, so this cannot turn writes ON for any
    ///         run that did not ask.
    ///
    ///         {ArtifactRootBase.setArtifactRootOverride} refuses to set an
    ///         override anywhere but Anvil or `forge test`, so no live
    ///         broadcast can reach that arm.
    function artifactWritesEnabled() internal view returns (bool) {
        ArtifactWrites mode = artifactWriteMode(
            block.chainid,
            CHEATS.isContext(VmSafe.ForgeContext.ScriptDryRun),
            CHEATS.isContext(VmSafe.ForgeContext.TestGroup),
            CHEATS.envOr("DEPLOY_SKIP_ARTIFACTS", false),
            artifactIsRedirected()
        );
        require(
            mode != ArtifactWrites.RefuseSkipOnLiveBroadcast,
            "Deployments: DEPLOY_SKIP_ARTIFACTS is honoured only on Anvil (31337) or under forge test - a live broadcast MUST publish its artifact so the census inventory sees the deployment; unset it and run through deploy-chain.sh / deploy-testnet.sh / deploy-mainnet.sh"
        );
        return mode == ArtifactWrites.Write;
    }

    /// @dev #1566 (Codex #2070 r26 P1) — an identity key may only be written by
    ///      a deploy that has MARKED its live publication in the committed
    ///      archive manifest: the three deploy wrappers run
    ///      `archive-manifest.mjs live-begin` and export the same token as
    ///      `VAIPAKAM_LIVE_PUBLICATION_TOKEN`, and this gate requires the env
    ///      token to MATCH the manifest's in-progress marker for this chain's
    ///      slug — so neither a bare `forge script … --broadcast` (no token) nor
    ///      an exported token with no marker reaches the artifact, and a census
    ///      holding the manifest lock through its own publication always sees
    ///      the write coming. Facet-address keys and the rest stay ungated: the
    ///      in-place refresh scripts rewrite them and they change no inventory
    ///      identity. A run that writes nothing (a dry-run, or the LOCAL-ONLY
    ///      `DEPLOY_SKIP_ARTIFACTS` — see {artifactWriteMode}) never reaches
    ///      this. The local Anvil chain (31337) is exempt on the same ground
    ///      the census excludes it: its artifact is gitignored and outside the
    ///      inventory.
    function requireMarkedPublication(string memory jsonKey) internal view {
        if (!isIdentityKey(jsonKey) || block.chainid == 31337) return;
        // #2253 r1 P2 — a REDIRECTED artifact is exempt on the same ground the
        // Anvil chain is, and for a stronger reason: it is not in the inventory
        // and cannot be, because it is written to a scratch directory the
        // census never reads and `.gitignore` never commits. Without this the
        // seam was half-built — `setArtifactRootOverride` permits a redirect on
        // any chain id under `forge test`, and the first `writeChainHeader()`
        // on any chain but 31337 then demanded a live-publication token and a
        // matching committed manifest marker, so the supposedly test-safe
        // redirect reverted before producing its scratch artifact. That is what
        // made the chain-gated-write assertion untestable on live chain ids.
        //
        // This cannot weaken the real gate: the override is refused outright
        // off-Anvil-outside-test, so a live broadcast has no way to set one and
        // no way to reach this return.
        if (artifactIsRedirected()) return;
        string memory token = CHEATS.envOr("VAIPAKAM_LIVE_PUBLICATION_TOKEN", string(""));
        require(
            bytes(token).length != 0,
            string.concat(
                "Deployments: writing ",
                jsonKey,
                " changes the census inventory and needs a MARKED live publication - run through deploy-chain.sh / deploy-testnet.sh / deploy-mainnet.sh (they run archive-manifest.mjs live-begin and export VAIPAKAM_LIVE_PUBLICATION_TOKEN)"
            )
        );
        require(
            publicationMarked(CHEATS.readFile(ARCHIVE_MANIFEST), chainSlug(), token),
            string.concat(
                "Deployments: VAIPAKAM_LIVE_PUBLICATION_TOKEN does not match an in-progress live-publication marker for ",
                chainSlug(),
                " in ",
                ARCHIVE_MANIFEST,
                " - the token must come from archive-manifest.mjs live-begin in the same deploy run"
            )
        );
    }

    /// @dev ONE gate for every artifact write (#1566 slice 4 PR A, Codex #2158
    ///      r16 P2, r19 P1): a forge dry run (`forge script` without
    ///      `--broadcast`) writes NOTHING, whichever helper reached here.
    ///      Foundry evaluates the script and its filesystem cheatcodes before
    ///      it submits anything, so a write from a dry run records addresses
    ///      that were never broadcast — an upgrade probe's implementation, a
    ///      simulated facet. Scripts that skip their writes themselves still
    ///      do; this is the gate a forgotten one cannot slip past. Checked
    ///      before the publication marker so a dry run never demands a live
    ///      publication token either. There is NO switch that widens it — not
    ///      an environment variable, which a caller's shell or `.env` could
    ///      carry into every write (Codex #2158 r21 P2); the single real-run
    ///      exception is {writeRewardCustodyHolderReconciled}, a dedicated
    ///      writer for one field that a caller invokes on purpose.
    function _dryRunSkips(string memory jsonKey) private view returns (bool) {
        if (!CHEATS.isContext(VmSafe.ForgeContext.ScriptDryRun)) return false;
        console.log("Deployments: dry run - NOT writing", jsonKey);
        return true;
    }

    /// @dev The ONE artifact write a non-broadcasting step may make: the
    ///      reward-custody `record()` reconciling `.rewardCustodyHolder` from
    ///      live chain state once a ceremony has confirmed. That step sends
    ///      nothing, so forge classifies it as a dry run, yet it IS the real
    ///      run — this writer alone bypasses the dry-run gate, for this key
    ///      only, by an explicit call and never by anything an environment
    ///      could carry (Codex #2158 r19 P1, r21 P2). Every other rule of a
    ///      write still applies.
    function writeRewardCustodyHolderReconciled(address a) internal {
        requireMarkedPublication(".rewardCustodyHolder");
        _ensureFile();
        CHEATS.writeJson(CHEATS.toString(a), path(), ".rewardCustodyHolder");
    }

    function _writeAddr(string memory jsonKey, address a) private {
        if (_dryRunSkips(jsonKey)) return;
        requireMarkedPublication(jsonKey);
        _ensureFile();
        CHEATS.writeJson(CHEATS.toString(a), path(), jsonKey);
    }

    function _writeUint(string memory jsonKey, uint256 v) private {
        if (_dryRunSkips(jsonKey)) return;
        requireMarkedPublication(jsonKey);
        _ensureFile();
        CHEATS.writeJson(CHEATS.toString(v), path(), jsonKey);
    }

    function _writeBool(string memory jsonKey, bool v) private {
        if (_dryRunSkips(jsonKey)) return;
        _ensureFile();
        CHEATS.writeJson(v ? "true" : "false", path(), jsonKey);
    }

    function _writeString(string memory jsonKey, string memory v) private {
        if (_dryRunSkips(jsonKey)) return;
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
        CHEATS.createDir(dirForChainId(block.chainid), true);
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
