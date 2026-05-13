// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";

/**
 * @title SlippageCensus
 * @notice Runs the per-chain slippage census required by
 *         MarketRateWidgetAndDepthTieredLTV.md §4.4 step 6. For each
 *         asset in a configurable list, queries the deployed Diamond
 *         on the current chain for:
 *
 *           - `OracleFacet.checkLiquidity(asset)` — binary base gate
 *             (post-step-3 = slippage-at-`floorSizePad` simulation).
 *           - `OracleFacet.getLiquidityTier(asset)` — `0..3`
 *             (on-chain ceiling per the route-search + value-balance
 *             + TWAP guards).
 *           - `OracleFacet.getEffectiveLiquidityTier(asset)` —
 *             `min(onChain, keeperTier)` — what `LoanFacet`'s
 *             init-LTV gate actually consults when `depthTieredLtvEnabled`
 *             is on.
 *           - `IERC20Metadata(asset).symbol()` for human-friendly output
 *             (best-effort; falls back to "?" on a missing symbol).
 *
 *         The census is the input the risk committee uses to decide,
 *         chain by chain, whether to flip `depthTieredLtvEnabled` on
 *         (and what the realistic per-asset tier distribution looks
 *         like before/after a target keeper-relay promotion window).
 *
 * @dev    Run via `forge script` against the chain's RPC, with the
 *         deployed Diamond address + asset list passed via env vars.
 *         All output is `console.log` — Foundry's `--silent` mode is
 *         NOT compatible (script needs to print to stdout). Output
 *         lines are prefixed `CENSUS,...` so a wrapper can
 *         `grep ^CENSUS, > census.csv` for downstream consumption.
 *
 *         Required env vars:
 *           - `DIAMOND_ADDRESS`     The deployed Vaipakam diamond on
 *                                   the current chain.
 *           - `CENSUS_ASSETS`       Comma-separated asset addresses
 *                                   (no whitespace; 0x-prefixed).
 *                                   For a per-chain default list see
 *                                   `docs/SlippageCensusGuide.md`.
 *
 *         Optional env vars:
 *           - `CENSUS_LABEL`        A free-form label written to each
 *                                   row (e.g. "pre-depthTieredLtv-flip"
 *                                   or a date stamp).
 *
 *         Example:
 *           DIAMOND_ADDRESS=0xABC... \
 *           CENSUS_ASSETS=0xUSDC,0xUSDT,0xWBTC,0xLINK \
 *           CENSUS_LABEL=2026-05-14-base \
 *             forge script \
 *               script/SlippageCensus.s.sol:SlippageCensus \
 *               --rpc-url $RPC_BASE \
 *               -vvv
 */
contract SlippageCensus is Script {
    /// @dev `IERC20Metadata.symbol()` best-effort — low-level
    ///      staticcall so a non-conforming asset doesn't revert the
    ///      whole census run. Mirrors `OracleFacet._tryTokenDecimals`
    ///      defensiveness.
    function _trySymbol(address token) internal view returns (string memory) {
        if (token.code.length == 0) return "?";
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("symbol()")
        );
        if (!ok || data.length == 0) return "?";
        // Decode strictly — some legacy ERC20s pack symbol as a
        // fixed-32-byte word; we accept either by trying string first
        // and falling back. Failure path keeps the census moving.
        try this._decodeString(data) returns (string memory s) {
            return s;
        } catch {
            return "?";
        }
    }

    /// @dev External wrapper around `abi.decode(_, (string))` so the
    ///      `try/catch` above can trap the decode revert path.
    function _decodeString(bytes memory data) external pure returns (string memory) {
        return abi.decode(data, (string));
    }

    /// @dev Parse a comma-separated list of `0x`-prefixed addresses.
    ///      Tolerates leading / trailing whitespace per element by
    ///      relying on `vm.parseAddress`'s own strict parser — a
    ///      malformed entry reverts the whole run with a clear
    ///      message (better than silently dropping it).
    function _parseAssets(string memory csv)
        internal
        pure
        returns (address[] memory out)
    {
        bytes memory b = bytes(csv);
        // Count commas → length = commas + 1 (or 0 for an empty string).
        if (b.length == 0) return new address[](0);
        uint256 n = 1;
        for (uint256 i = 0; i < b.length; ++i) {
            if (b[i] == ",") ++n;
        }
        out = new address[](n);
        uint256 wi;
        uint256 start;
        for (uint256 i = 0; i <= b.length; ++i) {
            if (i == b.length || b[i] == ",") {
                bytes memory chunk = new bytes(i - start);
                for (uint256 k = 0; k < chunk.length; ++k) chunk[k] = b[start + k];
                out[wi++] = _parseAddrStrict(string(chunk));
                start = i + 1;
            }
        }
    }

    /// @dev Strict parse — reverts with a clear message on a bad entry
    ///      so operators see WHICH entry tripped, not a generic
    ///      `parseAddress` revert with no context.
    function _parseAddrStrict(string memory s) internal pure returns (address) {
        bytes memory b = bytes(s);
        require(b.length == 42, string.concat("CENSUS: bad asset entry '", s, "' (expected 0x + 40 hex)"));
        return vm.parseAddress(s);
    }

    /// @dev `OracleFacet.checkLiquidity` returns the enum
    ///      `LibVaipakam.LiquidityStatus`. Stringify for CSV output.
    function _liquidityLabel(LibVaipakam.LiquidityStatus s)
        internal
        pure
        returns (string memory)
    {
        if (s == LibVaipakam.LiquidityStatus.Liquid) return "Liquid";
        if (s == LibVaipakam.LiquidityStatus.Illiquid) return "Illiquid";
        return "?";
    }

    /// @dev Convert `uint256` to its decimal string — Foundry's
    ///      `Strings.toString` lives in OZ but we're in script land
    ///      so the small reimplementation here keeps the dependency
    ///      surface to forge-std only.
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

    function run() external view {
        address diamond = vm.envAddress("DIAMOND_ADDRESS");
        string memory csv = vm.envString("CENSUS_ASSETS");
        string memory label;
        try vm.envString("CENSUS_LABEL") returns (string memory l) {
            label = l;
        } catch {
            label = "";
        }

        address[] memory assets = _parseAssets(csv);
        require(assets.length > 0, "CENSUS: CENSUS_ASSETS env var must list >=1 asset");

        OracleFacet oracle = OracleFacet(diamond);

        // Column header — written once so a downstream
        // `grep ^CENSUS, > census.csv` produces a self-describing file.
        console.log(
            "CENSUS,label,chainId,asset,symbol,checkLiquidity,onChainTier,effectiveTier"
        );

        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];

            // Reads are independently try/catched so one bad asset
            // doesn't kill the rest of the census run. The operator
            // sees a `?` in the affected column and can investigate.
            string memory liqStr;
            try oracle.checkLiquidity(asset) returns (LibVaipakam.LiquidityStatus s) {
                liqStr = _liquidityLabel(s);
            } catch {
                liqStr = "?";
            }

            string memory onChainStr;
            try oracle.getLiquidityTier(asset) returns (uint8 t) {
                onChainStr = _uintStr(uint256(t));
            } catch {
                onChainStr = "?";
            }

            string memory effStr;
            try oracle.getEffectiveLiquidityTier(asset) returns (uint8 t) {
                effStr = _uintStr(uint256(t));
            } catch {
                effStr = "?";
            }

            string memory sym = _trySymbol(asset);

            console.log(
                string.concat(
                    "CENSUS,",
                    label, ",",
                    _uintStr(block.chainid), ",",
                    vm.toString(asset), ",",
                    sym, ",",
                    liqStr, ",",
                    onChainStr, ",",
                    effStr
                )
            );
        }
    }
}
