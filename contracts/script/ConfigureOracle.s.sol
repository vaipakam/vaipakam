// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";

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
 *        - PRIVATE_KEY               : admin-role key (broadcaster)
 *        - <CHAIN>_DIAMOND_ADDRESS   : VaipakamDiamond for this chain
 *        - <CHAIN>_WETH_ADDRESS      : canonical WETH
 *        - <CHAIN>_UNISWAP_V3_FACTORY: v3 factory for liquidity depth check
 *        - <CHAIN>_ETH_USD_FEED      : Chainlink ETH/USD feed
 *        - <CHAIN>_USD_DENOMINATOR   : `Denominations.USD` sentinel (0x...348)
 *        - <CHAIN>_ETH_DENOMINATOR   : `Denominations.ETH` sentinel (0x...0EEE)
 *        - <CHAIN>_SEQUENCER_UPTIME_FEED : L2 sequencer uptime feed
 *                                          (set address(0) on L1s / leave unset)
 *        - <CHAIN>_ZEROX_PROXY       : 0x Exchange Proxy (liquidation route)
 *        - <CHAIN>_ZEROX_ALLOWANCE_TARGET : 0x token-puller (usually same as proxy)
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
        revert(string.concat("ConfigureOracle: unsupported chainId ", vm.toString(chainId)));
    }

    function _resolveAddress(string memory key) internal view returns (address) {
        string memory full = string.concat(_prefix(), key);
        // Try chain-prefixed first; fall back to bare key.
        return vm.envOr(full, vm.envOr(key, address(0)));
    }

    function _resolveAddressStrict(string memory key) internal view returns (address) {
        address a = _resolveAddress(key);
        if (a == address(0)) {
            revert(string.concat("ConfigureOracle: missing env var ", _prefix(), key));
        }
        return a;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        // Diamond is mandatory.
        address diamond = _resolveAddressStrict("DIAMOND_ADDRESS");
        address weth = _resolveAddressStrict("WETH_ADDRESS");
        address uniV3Factory = _resolveAddressStrict("UNISWAP_V3_FACTORY");
        address ethUsdFeed = _resolveAddressStrict("ETH_USD_FEED");
        // Chainlink Denominations library sentinels — chain-agnostic, but
        // we let each env decide to allow forks to stub them out.
        address usdDenom = _resolveAddressStrict("USD_DENOMINATOR");
        address ethDenom = _resolveAddressStrict("ETH_DENOMINATOR");
        // L1 has no sequencer feed; L2s do. Address(0) disables the check.
        address sequencerFeed = _resolveAddress("SEQUENCER_UPTIME_FEED");
        address zeroEx = _resolveAddressStrict("ZEROX_PROXY");
        address allowanceTarget = _resolveAddressStrict("ZEROX_ALLOWANCE_TARGET");
        // Feed Registry only exists on Ethereum mainnet; optional.
        address feedRegistry = _resolveAddress("CHAINLINK_REGISTRY");

        console.log("=== Configure Oracle ===");
        console.log("Chain id:              ", block.chainid);
        console.log("Diamond:               ", diamond);
        console.log("WETH:                  ", weth);
        console.log("UniV3 Factory:         ", uniV3Factory);
        console.log("ETH/USD feed:          ", ethUsdFeed);
        console.log("USD denom:             ", usdDenom);
        console.log("ETH denom:             ", ethDenom);
        console.log("Sequencer uptime feed: ", sequencerFeed);
        console.log("0x proxy:              ", zeroEx);
        console.log("0x allowanceTarget:    ", allowanceTarget);
        console.log("Feed Registry:         ", feedRegistry);

        vm.startBroadcast(deployerKey);

        OracleAdminFacet oa = OracleAdminFacet(diamond);
        AdminFacet af = AdminFacet(diamond);

        oa.setUsdChainlinkDenominator(usdDenom);
        oa.setEthChainlinkDenominator(ethDenom);
        oa.setWethContract(weth);
        oa.setEthUsdFeed(ethUsdFeed);
        oa.setUniswapV3Factory(uniV3Factory);
        oa.setSequencerUptimeFeed(sequencerFeed);
        if (feedRegistry != address(0)) {
            oa.setChainlinkRegistry(feedRegistry);
        }
        af.setZeroExProxy(zeroEx);
        af.setallowanceTarget(allowanceTarget);

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
