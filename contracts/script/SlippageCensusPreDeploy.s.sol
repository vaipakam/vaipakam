// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/**
 * @title SlippageCensusPreDeploy
 * @notice Phase 6 of AutonomousLtvAndOracleFallback.md — the mainnet-
 *         fork variant of the audit-prep census tool. Pre-deploy
 *         counterpart to `SlippageCensus.s.sol` (which targets an
 *         already-deployed Diamond).
 *
 *         What this tool answers: "what would the per-tier autonomous
 *         tier-LTV cache settle to if we deployed our contracts to
 *         this chain RIGHT NOW, given the chain's current peer-
 *         protocol state (Aave / Compound / Morpho configs at this
 *         block)?". Runs against a forked mainnet RPC so the peer
 *         contracts are the real ones; the only deployments are
 *         OUR minimal Diamond + OracleFacet + OracleAdminFacet — no
 *         persistent on-chain state, no real funds.
 *
 *         Output: one CSV-friendly line per tier with the cache
 *         outcome (accepted with value, or rejected with reason). The
 *         risk committee feeds this into the pre-flip audit package
 *         alongside the per-asset depth census from
 *         `SlippageCensus.s.sol`.
 *
 * @dev    Required env vars:
 *           - `CHAINS_JSON_PATH` (optional) — path to the per-chain
 *             config JSON. Default `script/SlippageCensus.chains.json`.
 *           - `CENSUS_LABEL` (optional) — free-form tag for the CSV
 *             rows.
 *
 *         Invocation:
 *           CENSUS_LABEL=2026-05-14-eth-pre-deploy \
 *             forge script \
 *               script/SlippageCensusPreDeploy.s.sol:SlippageCensusPreDeploy \
 *               --rpc-url $RPC_ETH \
 *               -vvv
 *
 *         The script reads the current `block.chainid` to look up the
 *         appropriate peer + reference-asset entries in the JSON.
 *
 *         No `--broadcast` flag — the script is intended for
 *         simulation against a fork ONLY; broadcasting these
 *         transactions to a real chain would leak a half-configured
 *         Diamond with no governance owner-recovery path.
 */
contract SlippageCensusPreDeploy is Script {
    // ─── Helpers ─────────────────────────────────────────────────────────

    function _uintStr(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 t = v;
        uint256 digits;
        while (t != 0) { ++digits; t /= 10; }
        bytes memory s = new bytes(digits);
        while (v != 0) {
            digits -= 1;
            s[digits] = bytes1(uint8(48 + v % 10));
            v /= 10;
        }
        return string(s);
    }

    /// @dev Parse a tier-specific reference asset list from the JSON.
    ///      Returns an empty array if the chain has no entry for the
    ///      tier (the refresh function then emits
    ///      `no-reference-assets` for that tier; benign).
    function _parseTierRefs(
        string memory json,
        uint256 chainId,
        uint8 tier
    ) internal view returns (address[] memory) {
        string memory key = string.concat(
            ".chain_",
            _uintStr(chainId),
            "_tier",
            _uintStr(uint256(tier)),
            "_refs"
        );
        // `try` not available on pure free function; mimic via
        // try/catch on an external wrapper would mean rewiring this
        // as a contract method. Foundry's `vm.parseJsonAddressArray`
        // *does* revert on a missing key, but inside a `try` on a
        // contract method instance. Simpler: pre-check the key exists
        // via `vm.keyExists` and fall back to `new address[](0)`.
        return _safeParseAddressArray(json, key);
    }

    function _safeParseAddressArray(string memory json, string memory key)
        internal
        view
        returns (address[] memory)
    {
        // Best-effort parse: a missing key reverts the read. The
        // surrounding `try`/`catch` lives in `run()` (Script's
        // `internal pure` here can't catch). Returning an empty array
        // on missing keys means the tier's refresh emits
        // `no-reference-assets` — fine for the census report.
        // (Foundry 0.2+ has `vm.keyExists` but the cleanest pure
        // solution is to push the catch up the stack.)
        bytes memory raw = vm.parseJson(json, key);
        if (raw.length == 0) return new address[](0);
        return abi.decode(raw, (address[]));
    }

    function _parsePeerAddr(
        string memory json,
        uint256 chainId,
        string memory which
    ) internal view returns (address) {
        string memory key = string.concat(
            ".chain_",
            _uintStr(chainId),
            "_peers.",
            which
        );
        // Mirror the `_safeParseAddressArray` pattern: `vm.parseJson`
        // returns empty bytes on a missing key (not a revert), so a
        // simple length-zero check is enough. `try this._ext...()`
        // was the original pattern but Foundry's script runtime
        // rejects `address(this)` usage in scripts (script contracts
        // are ephemeral).
        bytes memory raw = vm.parseJson(json, key);
        if (raw.length == 0) return address(0);
        return abi.decode(raw, (address));
    }

    // ─── Minimal Diamond bootstrap ───────────────────────────────────────

    /// @dev OracleFacet selector set needed by the census:
    ///        refreshTierLtvCache + getTierLtvCacheEntry +
    ///        getEffectiveTierMaxInitLtvBps.
    function _oracleSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](3);
        s[0] = OracleFacet.refreshTierLtvCache.selector;
        s[1] = OracleFacet.getTierLtvCacheEntry.selector;
        s[2] = OracleFacet.getEffectiveTierMaxInitLtvBps.selector;
    }

    /// @dev OracleAdminFacet selector set: only the two setters we
    ///      need to configure the cache pipeline before refresh.
    function _oracleAdminSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = OracleAdminFacet.setPeerProtocolAddresses.selector;
        s[1] = OracleAdminFacet.setTierReferenceAssets.selector;
    }

    function run() external {
        // Resolve config + label env vars.
        string memory path;
        try vm.envString("CHAINS_JSON_PATH") returns (string memory p) {
            path = p;
        } catch {
            path = "script/SlippageCensus.chains.json";
        }
        string memory label;
        try vm.envString("CENSUS_LABEL") returns (string memory l) {
            label = l;
        } catch {
            label = "";
        }

        // forge-lint: disable-next-line unsafe-cheatcode
        string memory json = vm.readFile(path);
        uint256 chainId = block.chainid;

        // Peer addresses for this chain.
        address aave = _parsePeerAddr(json, chainId, "aave_v3_pool_data_provider");
        address comet = _parsePeerAddr(json, chainId, "compound_v3_comet_usdc");
        address morpho = _parsePeerAddr(json, chainId, "morpho_blue");

        // Reference asset lists per tier.
        address[] memory tier1 = _parseTierRefs(json, chainId, 1);
        address[] memory tier2 = _parseTierRefs(json, chainId, 2);
        address[] memory tier3 = _parseTierRefs(json, chainId, 3);

        // ── Deploy a minimal Diamond into the fork ──────────────────
        // No broadcast — we're operating on a fork; no real deployment.
        // `vm.prank` (NOT `vm.startBroadcast`) is the safer impersonation
        // primitive here — it guarantees pure simulation even if an
        // operator accidentally adds `--broadcast` to the forge script
        // invocation. The diamond is owner-gated for setter calls, so
        // we impersonate `deployer` for the configuration block; the
        // permissionless `refreshTierLtvCache` call later doesn't need
        // a prank.
        address deployer = msg.sender;
        DiamondCutFacet cutFacet = new DiamondCutFacet();
        VaipakamDiamond diamond = new VaipakamDiamond(deployer, address(cutFacet));
        OracleFacet oracleFacet = new OracleFacet();
        OracleAdminFacet oracleAdminFacet = new OracleAdminFacet();

        // Cut OracleFacet + OracleAdminFacet selectors.
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(oracleFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _oracleSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(oracleAdminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: _oracleAdminSelectors()
        });
        vm.startPrank(deployer);
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // ── Configure: peer addresses + reference assets ────────────
        OracleAdminFacet(address(diamond)).setPeerProtocolAddresses(
            aave, comet, morpho
        );
        if (tier1.length > 0) OracleAdminFacet(address(diamond)).setTierReferenceAssets(1, tier1);
        if (tier2.length > 0) OracleAdminFacet(address(diamond)).setTierReferenceAssets(2, tier2);
        if (tier3.length > 0) OracleAdminFacet(address(diamond)).setTierReferenceAssets(3, tier3);
        vm.stopPrank();

        // ── Header row for the CSV. ─────────────────────────────────
        console.log(
            "CENSUS_PRE,label,chainId,tier,refAssetCount,cachedLtvBps,effectiveLtvBps,librarydefaultBps"
        );

        // ── Refresh the cache from the LIVE forked peer state ───────
        OracleFacet(address(diamond)).refreshTierLtvCache();

        // ── Emit one CSV line per tier ─────────────────────────────
        for (uint8 t = 1; t <= 3; ++t) {
            (uint16 cachedLtvBps, ) = OracleFacet(address(diamond)).getTierLtvCacheEntry(t);
            uint16 effectiveLtvBps = OracleFacet(address(diamond)).getEffectiveTierMaxInitLtvBps(t);
            uint16 libraryDefault = LibVaipakam.tierLtvLibraryDefaultBps(t);
            uint256 refCount = t == 1 ? tier1.length : (t == 2 ? tier2.length : tier3.length);
            console.log(
                string.concat(
                    "CENSUS_PRE,",
                    label, ",",
                    _uintStr(chainId), ",",
                    _uintStr(uint256(t)), ",",
                    _uintStr(refCount), ",",
                    _uintStr(uint256(cachedLtvBps)), ",",
                    _uintStr(uint256(effectiveLtvBps)), ",",
                    _uintStr(uint256(libraryDefault))
                )
            );
        }

        // Peer-address echo for the audit-package per-chain
        // verification step. Emitted as a separate CSV row keyed by
        // `CENSUS_PRE_PEERS` so a `grep ^CENSUS_PRE_PEERS` pipes into
        // a sidecar CSV.
        console.log(
            string.concat(
                "CENSUS_PRE_PEERS,",
                label, ",",
                _uintStr(chainId), ",aave_v3_pdp=",
                vm.toString(aave), ",comet=",
                vm.toString(comet), ",morpho=",
                vm.toString(morpho)
            )
        );
    }
}
