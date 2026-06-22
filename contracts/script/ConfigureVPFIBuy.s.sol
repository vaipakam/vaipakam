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
 *      Must be broadcast by a holder of `ADMIN_ROLE`. Only meaningful on the
 *      canonical VPFI chain.
 *
 *      Required env vars:
 *        - ADMIN_PRIVATE_KEY                  : admin-role key
 *        - BASE_SEPOLIA_DIAMOND_ADDRESS       : canonical Diamond proxy
 *        - VPFI_BUY_WEI_PER_VPFI              : discount price anchor — wei of
 *                                               ETH per 1 VPFI (1 VPFI = 0.001
 *                                               ETH → 1e15)
 *        - BASE_SEPOLIA_VPFI_DISCOUNT_ETH_PRICE_ASSET :
 *            asset priced internally as the ETH reference for discount math
 *            (usually WETH on Base).
 */
contract ConfigureVPFIBuy is Script {
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
        address diamond = Deployments.readDiamond();
        address ethPriceAsset = _ethPriceAsset();

        uint256 weiPerVpfi = vm.envUint("VPFI_BUY_WEI_PER_VPFI");

        console.log("=== Configure VPFI Discount Price (canonical Base) ===");
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
