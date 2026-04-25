// script/UpgradeOracleFacet.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title UpgradeOracleFacet
 * @notice Redeploys OracleFacet and Replace-cuts every OracleFacet selector
 *         onto the deployed Diamond. Use this after patching OracleFacet —
 *         e.g. the slot0/liquidity length-guard fix and the switch from
 *         CREATE2 pool derivation to `factory.getPool(...)` lookup.
 *
 * @dev Admin-signed. After DeployDiamond's ownership handover the deployer
 *      EOA holds zero roles, so the cut itself must go out under ADMIN_PRIVATE_KEY
 *      (the ERC-173 owner). Deployer still pays for the facet-deploy step
 *      and can optionally top up admin gas in the same run.
 *
 * Env vars:
 *   - PRIVATE_KEY        (deployer — pays for the facet deploy)
 *   - ADMIN_PRIVATE_KEY  (admin — signs the diamond cut)
 *   - DIAMOND_ADDRESS    (Diamond to upgrade)
 *
 * Usage:
 *   forge script script/UpgradeOracleFacet.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow -vvv
 */
contract UpgradeOracleFacet is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address admin = vm.addr(adminKey);
        address diamond = Deployments.readDiamond();

        console.log("Diamond:", diamond);
        console.log("Admin:  ", admin);

        // ── Deployer: fund admin gas (if low) + deploy new facet ────────
        vm.startBroadcast(deployerKey);
        if (admin.balance < 0.01 ether) {
            payable(admin).transfer(0.01 ether);
            console.log("Topped up admin with 0.01 ETH");
        }
        OracleFacet newOracleFacet = new OracleFacet();
        console.log("New OracleFacet:", address(newOracleFacet));
        vm.stopBroadcast();

        // ── Admin: Replace-cut every OracleFacet selector ───────────────
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(newOracleFacet),
            action: IDiamondCut.FacetCutAction.Replace,
            functionSelectors: _oracleSelectors()
        });

        vm.startBroadcast(adminKey);
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        vm.stopBroadcast();

        console.log("OracleFacet Replace-cut complete (9 selectors).");
    }

    function _oracleSelectors() internal pure returns (bytes4[] memory s) {
        // Mirrors DeployDiamond.s.sol `_oracleSelectors` (9 selectors).
        s = new bytes4[](9);
        s[0] = OracleFacet.checkLiquidity.selector;
        s[1] = OracleFacet.getAssetPrice.selector;
        s[2] = OracleFacet.calculateLTV.selector;
        s[3] = OracleFacet.checkLiquidityOnActiveNetwork.selector;
        s[4] = OracleFacet.getAssetRiskProfile.selector;
        s[5] = OracleFacet.getIlliquidAssets.selector;
        s[6] = OracleFacet.isAssetSupported.selector;
        s[7] = OracleFacet.getSequencerUptimeFeed.selector;
        s[8] = OracleFacet.sequencerHealthy.selector;
    }
}
