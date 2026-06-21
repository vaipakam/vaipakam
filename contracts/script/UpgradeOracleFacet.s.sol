// script/UpgradeOracleFacet.s.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title UpgradeOracleFacet
 * @notice Redeploys OracleFacet and cuts EVERY OracleFacet selector onto the
 *         deployed Diamond. Use this after patching OracleFacet — e.g. the
 *         slot0/liquidity length-guard fix, the switch from CREATE2 pool
 *         derivation to `factory.getPool(...)` lookup, or adding a new view.
 *
 * @dev Admin-signed. After DeployDiamond's ownership handover the deployer
 *      EOA holds zero roles, so the cut itself must go out under ADMIN_PRIVATE_KEY
 *      (the ERC-173 owner). Deployer still pays for the facet-deploy step
 *      and can optionally top up admin gas in the same run.
 *
 *      Selectors are partitioned by live routing (#638): already-routed
 *      selectors are Replaced onto the fresh bytecode, brand-new ones (e.g.
 *      `countLiveSecondaryOracleFeeds`) are Added — so the same script is
 *      correct against both a same-version diamond (all routed → all Replace)
 *      and an older diamond missing the newest selectors (those → Add). The
 *      full selector list mirrors `DeployDiamond._getOracleSelectors()` and
 *      MUST be kept in lockstep with it.
 *
 * Env vars:
 *   - DEPLOYER_PRIVATE_KEY        (deployer — pays for the facet deploy)
 *   - ADMIN_PRIVATE_KEY  (admin — signs the diamond cut)
 *   - DIAMOND_ADDRESS    (Diamond to upgrade)
 *
 * Usage:
 *   forge script script/UpgradeOracleFacet.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --slow -vvv
 */
contract UpgradeOracleFacet is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
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

        // ── Admin: Add new + Replace existing OracleFacet selectors ──────
        (bytes4[] memory toAdd, bytes4[] memory toReplace) =
            _partitionByRouting(diamond, _oracleSelectors());
        uint256 n = (toAdd.length > 0 ? 1 : 0) + (toReplace.length > 0 ? 1 : 0);
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](n);
        uint256 idx;
        if (toReplace.length > 0) {
            cuts[idx++] = IDiamondCut.FacetCut({
                facetAddress: address(newOracleFacet),
                action: IDiamondCut.FacetCutAction.Replace,
                functionSelectors: toReplace
            });
        }
        if (toAdd.length > 0) {
            cuts[idx++] = IDiamondCut.FacetCut({
                facetAddress: address(newOracleFacet),
                action: IDiamondCut.FacetCutAction.Add,
                functionSelectors: toAdd
            });
        }

        vm.startBroadcast(adminKey);
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        vm.stopBroadcast();

        console.log("OracleFacet cut complete.");
        console.log("  selectors added:   ", toAdd.length);
        console.log("  selectors replaced:", toReplace.length);
    }

    /// @dev Split `selectors` into those NOT yet routed on `diamond` (need Add,
    ///      Replace would revert on a zero old facet) and those already routed
    ///      (need Replace). Mirrors the RedeployFacets helper.
    function _partitionByRouting(address diamond, bytes4[] memory selectors)
        internal
        view
        returns (bytes4[] memory toAdd, bytes4[] memory toReplace)
    {
        bool[] memory routed = new bool[](selectors.length);
        uint256 addN;
        uint256 replN;
        for (uint256 i; i < selectors.length; i++) {
            routed[i] =
                IDiamondLoupe(diamond).facetAddress(selectors[i]) != address(0);
            if (routed[i]) replN++;
            else addN++;
        }
        toAdd = new bytes4[](addN);
        toReplace = new bytes4[](replN);
        uint256 a;
        uint256 r;
        for (uint256 i; i < selectors.length; i++) {
            if (routed[i]) toReplace[r++] = selectors[i];
            else toAdd[a++] = selectors[i];
        }
    }

    function _oracleSelectors() internal pure returns (bytes4[] memory s) {
        // MUST mirror DeployDiamond.s.sol `_getOracleSelectors` in full — a
        // partial list would leave the unlisted selectors pointed at the old
        // facet, splitting the diamond across stale and new code.
        s = new bytes4[](18);
        s[0] = OracleFacet.checkLiquidity.selector;
        s[1] = OracleFacet.getAssetPrice.selector;
        s[2] = OracleFacet.calculateLTV.selector;
        s[3] = OracleFacet.checkLiquidityOnActiveNetwork.selector;
        s[4] = OracleFacet.getAssetRiskProfile.selector;
        s[5] = OracleFacet.getIlliquidAssets.selector;
        s[6] = OracleFacet.isAssetSupported.selector;
        s[7] = OracleFacet.getSequencerUptimeFeed.selector;
        s[8] = OracleFacet.sequencerHealthy.selector;
        s[9] = OracleFacet.captureDailyPriceSnapshot.selector;
        s[10] = OracleFacet.getHistoricalAssetPrice.selector;
        s[11] = OracleFacet.getLiquidityTier.selector;
        s[12] = OracleFacet.getEffectiveLiquidityTier.selector;
        s[13] = OracleFacet.tryGetAssetPrice.selector;
        s[14] = OracleFacet.refreshTierLtvCache.selector;
        s[15] = OracleFacet.getTierLtvCacheEntry.selector;
        s[16] = OracleFacet.getEffectiveTierMaxInitLtvBps.selector;
        // #638 — backstop oracle-coverage counter (new; Added on a pre-#638
        // diamond, Replaced on a same-version one).
        s[17] = OracleFacet.countLiveSecondaryOracleFeeds.selector;
    }
}
