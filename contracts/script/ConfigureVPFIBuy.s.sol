// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";

/**
 * @title ConfigureVPFIBuy
 * @notice One-shot post-deploy script that wires the fixed-rate VPFI buy
 *         parameters on the canonical Base-chain Diamond. Idempotent.
 * @dev Must be broadcast by a holder of `ADMIN_ROLE`. Only runs on the
 *      canonical chain — the sale rate and caps are authoritative there
 *      and the mesh reads them via bridged BUY_REQUEST messages.
 *
 *      Required env vars:
 *        - ADMIN_PRIVATE_KEY                  : admin-role key (matches the
 *                                               ADMIN_ADDRESS granted
 *                                               ADMIN_ROLE during deploy)
 *        - BASE_SEPOLIA_DIAMOND_ADDRESS       : canonical Diamond proxy
 *        - VPFI_BUY_WEI_PER_VPFI              : sale rate, wei of ETH per 1 VPFI
 *                                               (1 VPFI = 0.001 ETH → 1e15)
 *        - VPFI_BUY_GLOBAL_CAP                : lifetime VPFI cap across the mesh
 *                                               (e.g. 2300000e18)
 *        - VPFI_BUY_PER_WALLET_CAP            : per-buyer VPFI cap
 *                                               (e.g. 30000e18)
 *        - VPFI_BUY_ENABLED                   : "true" / "false"
 *        - BASE_SEPOLIA_VPFI_DISCOUNT_ETH_PRICE_ASSET :
 *            asset the Diamond prices internally as the ETH reference
 *            for discount math. Usually WETH on Base.
 */
contract ConfigureVPFIBuy is Script {
    function _diamondAddress() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) return vm.envAddress("BASE_SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 8453) return vm.envAddress("BASE_DIAMOND_ADDRESS");
        revert(string.concat("ConfigureVPFIBuy: must run on canonical chain, got ", vm.toString(chainId)));
    }

    function _ethPriceAsset() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) {
            return vm.envAddress("BASE_SEPOLIA_VPFI_DISCOUNT_ETH_PRICE_ASSET");
        }
        if (chainId == 8453) {
            return vm.envAddress("BASE_VPFI_DISCOUNT_ETH_PRICE_ASSET");
        }
        revert("ConfigureVPFIBuy: unsupported chain");
    }

    function run() external {
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = _diamondAddress();
        address ethPriceAsset = _ethPriceAsset();

        uint256 weiPerVpfi = vm.envUint("VPFI_BUY_WEI_PER_VPFI");
        uint256 globalCap = vm.envUint("VPFI_BUY_GLOBAL_CAP");
        uint256 perWalletCap = vm.envUint("VPFI_BUY_PER_WALLET_CAP");
        bool enabled = vm.envBool("VPFI_BUY_ENABLED");

        console.log("=== Configure VPFI Buy (canonical Base) ===");
        console.log("Diamond:          ", diamond);
        console.log("ETH price asset:  ", ethPriceAsset);
        console.log("Wei per VPFI:     ", weiPerVpfi);
        console.log("Global cap:       ", globalCap);
        console.log("Per-wallet cap:   ", perWalletCap);
        console.log("Enabled:          ", enabled);

        vm.startBroadcast(adminKey);
        VPFIDiscountFacet v = VPFIDiscountFacet(diamond);
        v.setVPFIDiscountETHPriceAsset(ethPriceAsset);
        v.setVPFIBuyRate(weiPerVpfi);
        v.setVPFIBuyCaps(globalCap, perWalletCap);
        v.setVPFIBuyEnabled(enabled);
        vm.stopBroadcast();

        console.log("VPFI buy config applied.");
    }
}
