// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {IERC173} from "@diamond-3/interfaces/IERC173.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title ConfigureOracle
 * @notice One-shot post-deploy script that wires the OracleAdminFacet +
 *         AdminFacet settings required for liquidity/LTV/HF checks and
 *         0x swap liquidation. Idempotent — each setter is a straight
 *         assignment, so re-running is safe.
 * @dev Must be broadcast by a holder of `ADMIN_ROLE` (typically the
 *      admin/timelock key). Feed Registry exists only on Ethereum
 *      mainnet; on L2s and testnets we set direct feed addresses via
 *      `setEthUsdFeed` / `setStableTokenFeed` and leave the registry
 *      unset.
 *
 *      Required env vars (resolve per chain via <CHAIN>_* prefix,
 *      falling back to the unprefixed key):
 *        - ADMIN_PRIVATE_KEY         : admin-role key (broadcaster; must
 *                                      match the long-lived admin EOA
 *                                      that received ownership + ADMIN_ROLE
 *                                      from `DeployDiamond.s.sol` step 6)
 *        - <CHAIN>_DIAMOND_ADDRESS   : VaipakamDiamond for this chain
 *        - <CHAIN>_WETH_ADDRESS      : canonical WETH
 *        - <CHAIN>_UNISWAP_V3_FACTORY: v3 factory for liquidity depth check
 *        - <CHAIN>_ETH_USD_FEED      : Chainlink ETH/USD feed
 *        - <CHAIN>_USD_DENOMINATOR   : `Denominations.USD` sentinel (0x...348)
 *        - <CHAIN>_ETH_DENOMINATOR   : `Denominations.ETH` sentinel (0x...0EEE)
 *        - <CHAIN>_SEQUENCER_UPTIME_FEED : l2 sequencer uptime feed
 *                                          (set address(0) on L1s / leave unset)
 *        - <CHAIN>_ZEROX_PROXY       : 0x Exchange Proxy (liquidation route).
 *                                     OPTIONAL — omit on chains with no 0x
 *                                     backend (e.g. BNB testnet 97). When
 *                                     omitted, a registered on-chain DEX
 *                                     ISwapAdapter (e.g. UniV3Adapter →
 *                                     PancakeSwap V3) must cover liquidations.
 *        - <CHAIN>_ZEROX_ALLOWANCE_TARGET : 0x token-puller (usually same as
 *                                     proxy). Set both ZEROX vars or neither.
 *        - VPFI_STABLE_FEED_SYMBOLS  : comma-separated ERC20 symbols, e.g. "USDC,USDT,DAI"
 *          per symbol:
 *        - <CHAIN>_<SYMBOL>_FEED      : Chainlink <SYMBOL>/USD feed address
 *
 *      Example (Base Sepolia):
 *        BASE_SEPOLIA_WETH_ADDRESS=0x4200...06 \
 *        BASE_SEPOLIA_ETH_USD_FEED=0x4aDC...cb1 \
 *        BASE_SEPOLIA_SEQUENCER_UPTIME_FEED=0xBCF8...433 \
 *        VPFI_STABLE_FEED_SYMBOLS=USDC \
 *        BASE_SEPOLIA_USDC_FEED=0xd303...Ce7 \
 *          forge script script/ConfigureOracle.s.sol --rpc-url base_sepolia --broadcast
 */
contract ConfigureOracle is Script {
    function _prefix() internal view returns (string memory) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) return "BASE_SEPOLIA_";
        if (chainId == 8453) return "BASE_";
        if (chainId == 11155111) return "SEPOLIA_";
        if (chainId == 1) return "MAINNET_";
        if (chainId == 421614) return "ARB_SEPOLIA_";
        if (chainId == 11155420) return "OP_SEPOLIA_";
        if (chainId == 80002) return "POLYGON_AMOY_";
        if (chainId == 97) return "BNB_TESTNET_";
        if (chainId == 56) return "BNB_";
        revert(string.concat("ConfigureOracle: unsupported chainId ", vm.toString(chainId)));
    }

    /// @dev Chains where 0x has NO Swap-API/Settler backend, so ConfigureOracle
    ///      may omit the ZEROX_* vars and route liquidations via an on-chain DEX
    ///      adapter instead. 0x covers every mainnet we target (incl. BNB
    ///      mainnet 56) + most testnets; BNB testnet (97) is the current
    ///      exception. Add other confirmed no-backend chain IDs here.
    function _isNo0xBackendChain() internal view returns (bool) {
        return block.chainid == 97;
    }

    function _resolveAddress(string memory key) internal view returns (address) {
        string memory full = string.concat(_prefix(), key);
        // Try chain-prefixed first; fall back to bare key.
        return vm.envOr(full, vm.envOr(key, address(0)));
    }

    /// @dev Chain-prefixed ONLY — no bare-key fallback. For keys where a bare
    ///      value belonging to a different chain must never be inherited (e.g.
    ///      the ZEROX_* liquidation-route addresses on a chain that has no 0x).
    function _resolveAddressPrefixedOnly(string memory key) internal view returns (address) {
        return vm.envOr(string.concat(_prefix(), key), address(0));
    }

    function _resolveAddressStrict(string memory key) internal view returns (address) {
        address a = _resolveAddress(key);
        if (a == address(0)) {
            revert(string.concat("ConfigureOracle: missing env var ", _prefix(), key));
        }
        return a;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("ADMIN_PRIVATE_KEY");

        // Diamond is mandatory. Reads from
        // deployments/<chain>/addresses.json (with legacy
        // <CHAIN>_DIAMOND_ADDRESS env fallback).
        address diamond = Deployments.readDiamond();
        address weth = _resolveAddressStrict("WETH_ADDRESS");
        address uniV3Factory = _resolveAddressStrict("UNISWAP_V3_FACTORY");
        address ethNumeraireFeed = _resolveAddressStrict("ETH_USD_FEED");
        // Chainlink Denominations library sentinels — chain-agnostic, but
        // we let each env decide to allow forks to stub them out.
        address usdDenom = _resolveAddressStrict("USD_DENOMINATOR");
        address ethDenom = _resolveAddressStrict("ETH_DENOMINATOR");
        // l1 has no sequencer feed; L2s do. Address(0) disables the check.
        address sequencerFeed = _resolveAddress("SEQUENCER_UPTIME_FEED");
        // 0x liquidation route. Optional: REQUIRED where 0x is deployed (all
        // mainnets incl. BNB mainnet, + most testnets), but some chains have no
        // 0x backend — BNB testnet (97) is the case: 0x's Swap API covers BNB
        // mainnet (56) but not the testnet, and no Settler/AllowanceHolder is
        // deployed there. Such chains route liquidations through an on-chain DEX
        // adapter instead (see the swap-adapter enforcement below).
        // Resolve the ZEROX keys CHAIN-PREFIXED ONLY (no bare fallback). On a
        // no-0x chain (e.g. BNB testnet) `BNB_TESTNET_ZEROX_PROXY` is
        // deliberately unset; a bare `ZEROX_PROXY` left in a shared multi-chain
        // .env for another chain must NOT be inherited here — that would flip
        // this chain into the "0x configured" branch and skip the swap-adapter
        // safety check, leaving BNB testnet with no usable liquidation route.
        address zeroEx = _resolveAddressPrefixedOnly("ZEROX_PROXY");
        address allowanceTarget = _resolveAddressPrefixedOnly("ZEROX_ALLOWANCE_TARGET");
        // Feed Registry only exists on Ethereum mainnet; optional.
        address feedRegistry = _resolveAddress("CHAINLINK_REGISTRY");

        console.log("=== Configure Oracle ===");
        console.log("Chain id:              ", block.chainid);
        console.log("Diamond:               ", diamond);
        console.log("WETH:                  ", weth);
        console.log("UniV3 Factory:         ", uniV3Factory);
        console.log("ETH/USD feed:          ", ethNumeraireFeed);
        console.log("USD denom:             ", usdDenom);
        console.log("ETH denom:             ", ethDenom);
        console.log("Sequencer uptime feed: ", sequencerFeed);
        console.log("0x proxy:              ", zeroEx);
        console.log("0x allowanceTarget:    ", allowanceTarget);
        console.log("Feed Registry:         ", feedRegistry);

        // Pre-flight role/owner check. OracleAdminFacet setters require
        // the Diamond's ERC-173 owner (LibDiamond.enforceIsContractOwner);
        // AdminFacet setters require ADMIN_ROLE. Both must hold or the
        // broadcasted txs revert on-chain with no useful surface.
        //
        // SCOPE: this script is the pre-handover bootstrap path. Per the
        // BaseSepoliaDeploy / DeploymentRunbook ordering, ConfigureOracle
        // runs in §2 (right after the Diamond is cut), well before §11.5
        // (`TransferAdminToTimelock`) hands ERC-173 ownership to the
        // governance timelock. After the timelock takes ownership, every
        // OracleAdminFacet setter must go through the timelock proposer
        // flow (encode the calldata, schedule with the documented delay,
        // execute). This script intentionally does NOT support that path
        // — it would require splitting the ADMIN_ROLE-only calls
        // (`AdminFacet.setZeroExProxy` / `setallowanceTarget`) from the
        // owner-gated calls (every OracleAdminFacet setter), and the
        // operational complexity of running half a script via direct
        // broadcast and half via timelock proposals isn't worth the
        // automation. For post-handover oracle changes, hand-encode the
        // calldata for each setter and submit through the timelock UI.
        address broadcaster = vm.addr(deployerKey);
        address diamondOwner = IERC173(diamond).owner();
        require(
            broadcaster == diamondOwner,
            string.concat(
                "ConfigureOracle: broadcaster ",
                vm.toString(broadcaster),
                " is not Diamond owner ",
                vm.toString(diamondOwner),
                ". This script is the pre-handover bootstrap path; ",
                "post-handover oracle changes must go through the ",
                "timelock proposer flow (see DeploymentRunbook)."
            )
        );
        bool hasAdmin = AccessControlFacet(diamond).hasRole(
            keccak256("ADMIN_ROLE"),
            broadcaster
        );
        require(
            hasAdmin,
            string.concat(
                "ConfigureOracle: broadcaster ",
                vm.toString(broadcaster),
                " missing ADMIN_ROLE on Diamond"
            )
        );
        console.log("Pre-flight: broadcaster holds Diamond owner + ADMIN_ROLE");

        // Validate THIS script's own inputs before any broadcast: the ZEROX_*
        // env pair must be set together or not at all, and omitting 0x is only
        // legal on a chain 0x has no backend for (else a production 0x-supported
        // chain — e.g. BNB mainnet 56 — could silently drop its 0x venue). 0x's
        // Swap API covers every mainnet we target (incl. BNB mainnet) + most
        // testnets; BNB testnet (97) is the sole no-backend chain here.
        if (zeroEx != address(0)) {
            require(
                allowanceTarget != address(0),
                "ConfigureOracle: ZEROX_PROXY set but ZEROX_ALLOWANCE_TARGET missing (set both or neither)"
            );
        } else {
            require(
                allowanceTarget == address(0),
                "ConfigureOracle: ZEROX_ALLOWANCE_TARGET set but ZEROX_PROXY missing (set both or neither)"
            );
            require(
                _isNo0xBackendChain(),
                "ConfigureOracle: <CHAIN>_ZEROX_PROXY (+ ZEROX_ALLOWANCE_TARGET) is REQUIRED - 0x is available on this chain. Only known no-0x-backend chains (BNB testnet 97) may omit it and route via an on-chain DEX adapter"
            );
        }

        // Liquidation-route sanity. #862 split this into two concerns:
        //   • EXISTENCE — a hard gate. An empty adapter list means every
        //     liquidation reverts in LibSwap.swapWithFailover, so a configure run
        //     BEFORE the swap-adapters phase (e.g. an out-of-order
        //     `--phase configure`) must not be allowed to mark the chain
        //     configured with no route at all.
        //   • ORDERING/index — advisory only. Which adapter sits at which slot is
        //     the swap-adapters phase's + the keeper's CHAIN_SWAP responsibility;
        //     HARD-requiring a specific slot here was the coupling that cascaded
        //     into a pile of index/marker edge cases, so it stays a warning.
        address[] memory adapters = AdminFacet(diamond).getSwapAdapters();
        require(
            adapters.length > 0,
            "ConfigureOracle: no swap adapter registered - LibSwap.swapWithFailover reverts on an empty list, so liquidations would fail. Run the swap-adapters phase / DeployUniV3Adapter before --phase configure."
        );
        if (zeroEx == address(0)) {
            // No-0x chain: the keeper routes univ3=0, so slot 0 SHOULD be the UniV3
            // adapter. Advisory (see above), so the adapterName() read must NOT
            // revert and re-couple the phases — a broken/stale slot-0 adapter that
            // can't answer adapterName() has to surface as a warning, not an abort.
            try ISwapAdapter(adapters[0]).adapterName() returns (string memory nm) {
                if (keccak256(bytes(nm)) != keccak256(bytes("UniswapV3"))) {
                    console.log("WARNING: no-0x chain but swap-adapter index 0 is not the UniV3 adapter - the keeper (univ3=0) would misroute. Reorder / re-register via DeployUniV3Adapter.");
                }
            } catch {
                console.log("WARNING: no-0x chain but swap-adapter index 0 did not answer adapterName() - it looks broken/stale. Remove it and re-register via DeployUniV3Adapter so UniV3 sits at index 0.");
            }
        }

        vm.startBroadcast(deployerKey);

        OracleAdminFacet oa = OracleAdminFacet(diamond);
        AdminFacet af = AdminFacet(diamond);

        oa.setUsdChainlinkDenominator(usdDenom);
        oa.setEthChainlinkDenominator(ethDenom);
        oa.setWethContract(weth);
        oa.setEthUsdFeed(ethNumeraireFeed);
        oa.setUniswapV3Factory(uniV3Factory);
        oa.setSequencerUptimeFeed(sequencerFeed);
        if (feedRegistry != address(0)) {
            oa.setChainlinkRegistry(feedRegistry);
        }
        // 0x route — set when configured (validated pre-broadcast above). When
        // absent, liquidations route via the registered on-chain swap adapter(s).
        if (zeroEx != address(0)) {
            af.setZeroExProxy(zeroEx);
            af.setallowanceTarget(allowanceTarget);
        } else {
            console.log("0x unset - liquidation via registered on-chain swap adapter(s) only (e.g. PancakeSwap V3 on BNB testnet).");
        }

        // Stable-token feeds — optional, registered one symbol at a time.
        string memory csv = vm.envOr("VPFI_STABLE_FEED_SYMBOLS", string(""));
        if (bytes(csv).length > 0) {
            string[] memory symbols = _splitCsv(csv);
            for (uint256 i = 0; i < symbols.length; i++) {
                string memory sym = symbols[i];
                address feed = _resolveAddress(string.concat(sym, "_FEED"));
                if (feed == address(0)) {
                    console.log("  skipped (no feed env):", sym);
                    continue;
                }
                oa.setStableTokenFeed(sym, feed);
                console.log("  stable feed set:", sym);
            }
        }

        vm.stopBroadcast();

        console.log("Oracle configuration applied.");
    }

    /// @dev Minimal comma-splitter for single-char delimiter. No trimming,
    ///      so callers should pass e.g. "USDC,USDT" without spaces.
    function _splitCsv(string memory s) internal pure returns (string[] memory out) {
        bytes memory b = bytes(s);
        if (b.length == 0) {
            out = new string[](0);
            return out;
        }
        uint256 count = 1;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == ",") count++;
        }
        out = new string[](count);
        uint256 start = 0;
        uint256 idx = 0;
        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == ",") {
                bytes memory chunk = new bytes(i - start);
                for (uint256 j = 0; j < chunk.length; j++) {
                    chunk[j] = b[start + j];
                }
                out[idx++] = string(chunk);
                start = i + 1;
            }
        }
    }
}
