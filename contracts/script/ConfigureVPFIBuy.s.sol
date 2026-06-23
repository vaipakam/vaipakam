// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title ConfigureVPFIBuy (VPFI fee-discount price config)
 * @notice One-shot post-deploy script that wires the VPFI **fee-discount**
 *         price config on the canonical Base-chain Diamond. Idempotent.
 * @dev #687-A: the issuer fixed-rate SALE was removed. The buy rate/caps/enabled
 *      surface is gone; what remains is the consumptive fee-discount utility,
 *      which needs a VPFI price anchor (wei per VPFI) + an ETH/USD reference
 *      asset to value the discount (see `LibVPFIDiscount._feeAssetWeiToVpfi`).
 *      Contract name kept (`ConfigureVPFIBuy`) so callers/spells importing it are
 *      unaffected; its job is now discount-config only.
 *
 *      Must be broadcast by a holder of `ADMIN_ROLE`. Runs on EVERY chain —
 *      unlike the removed sale (canonical-only), the fee discount applies on
 *      every chain a loan can be opened on, so both the price anchor and the
 *      per-chain ETH reference asset must be set everywhere or
 *      `LibVPFIDiscount._feeAssetWeiToVpfi` returns `(false, 0)` and the
 *      discount silently no-ops there.
 *
 *      Required env vars (chain-prefixed, mirroring ConfigureOracle):
 *        - ADMIN_PRIVATE_KEY                  : admin-role key
 *        - VPFI_BUY_WEI_PER_VPFI              : discount price anchor — wei of
 *                                               ETH per 1 VPFI (1 VPFI = 0.001
 *                                               ETH → 1e15). Global rate, same
 *                                               value on every chain.
 *        - <CHAIN>_VPFI_DISCOUNT_ETH_PRICE_ASSET :
 *            the chain's ETH reference asset for discount math (the canonical
 *            WETH on that network), e.g. BASE_VPFI_DISCOUNT_ETH_PRICE_ASSET,
 *            ARB_SEPOLIA_VPFI_DISCOUNT_ETH_PRICE_ASSET.
 */
contract ConfigureVPFIBuy is Script {
    /// @dev Chain-prefix for the per-chain ETH reference asset env var. Mirrors
    ///      ConfigureOracle._prefix() so the same .env shape works everywhere.
    function _prefix() internal view returns (string memory) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) return "BASE_SEPOLIA_";
        if (chainId == 8453) return "BASE_";
        if (chainId == 11155111) return "SEPOLIA_";
        if (chainId == 1) return "MAINNET_";
        if (chainId == 421614) return "ARB_SEPOLIA_";
        if (chainId == 11155420) return "OP_SEPOLIA_";
        if (chainId == 80002) return "POLYGON_AMOY_";
        if (chainId == 42161) return "ARBITRUM_";
        if (chainId == 10) return "OPTIMISM_";
        if (chainId == 56) return "BNB_";
        if (chainId == 137) return "POLYGON_";
        revert(
            string.concat(
                "ConfigureVPFIBuy: unsupported chainId ",
                vm.toString(chainId)
            )
        );
    }

    function _ethPriceAsset() internal view returns (address) {
        return vm.envAddress(
            string.concat(_prefix(), "VPFI_DISCOUNT_ETH_PRICE_ASSET")
        );
    }

    function run() external {
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        address ethPriceAsset = _ethPriceAsset();

        uint256 weiPerVpfi = vm.envUint("VPFI_BUY_WEI_PER_VPFI");

        console.log("=== Configure VPFI Discount Price ===");
        console.log("Chain id:         ", block.chainid);
        console.log("Diamond:          ", diamond);
        console.log("ETH price asset:  ", ethPriceAsset);
        console.log("Wei per VPFI:     ", weiPerVpfi);

        // Pre-flight role check. VPFIDiscountFacet setters enforce
        // `onlyRole(LibAccessControl.ADMIN_ROLE)`. Without ADMIN_ROLE
        // the broadcasted txs revert on-chain with no useful surface.
        address broadcaster = vm.addr(adminKey);
        bool hasAdmin = AccessControlFacet(diamond).hasRole(
            keccak256("ADMIN_ROLE"),
            broadcaster
        );
        require(
            hasAdmin,
            string.concat(
                "ConfigureVPFIBuy: broadcaster ",
                vm.toString(broadcaster),
                " missing ADMIN_ROLE on Diamond"
            )
        );
        console.log("Pre-flight: broadcaster holds ADMIN_ROLE");

        vm.startBroadcast(adminKey);
        VPFIDiscountFacet v = VPFIDiscountFacet(diamond);
        v.setVPFIDiscountETHPriceAsset(ethPriceAsset);
        v.setVPFIDiscountRate(weiPerVpfi);
        vm.stopBroadcast();

        // Mirror the canonical-chain discount price config into the per-chain
        // artifact so the frontend env builder + downstream scripts see one
        // source of truth.
        Deployments.writeVpfiDiscountEthPriceAsset(ethPriceAsset);
        Deployments.writeUint(".vpfiDiscountWeiPerVpfi", weiPerVpfi);

        console.log("VPFI discount price config applied.");
    }
}
