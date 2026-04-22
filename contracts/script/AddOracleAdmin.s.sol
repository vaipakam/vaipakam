// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";

/**
 * @title AddOracleAdmin
 * @notice One-shot cut that adds OracleAdminFacet to an already-deployed Diamond.
 *         Needed because DeployDiamond.s.sol didn't register OracleAdminFacet
 *         selectors but SepoliaPositiveFlows depends on them.
 */
contract AddOracleAdmin is Script {
    /// @dev Resolves the Diamond address for the active chain from a
    ///      `<CHAIN>_DIAMOND_ADDRESS` env var. Add a branch per chain as the
    ///      mesh expands. Reverts on unrecognised chains.
    function _diamondAddress() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) return vm.envAddress("BASE_SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 11155111) return vm.envAddress("SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 8453) return vm.envAddress("BASE_DIAMOND_ADDRESS");
        revert(string.concat("AddOracleAdmin: unsupported chainId ", vm.toString(chainId)));
    }

    function run() external {
        address diamond = _diamondAddress();
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        OracleAdminFacet oracleAdmin = new OracleAdminFacet();
        console.log("OracleAdminFacet deployed at:", address(oracleAdmin));

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        selectors[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        selectors[2] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        selectors[3] = OracleAdminFacet.setWethContract.selector;
        selectors[4] = OracleAdminFacet.setEthUsdFeed.selector;
        selectors[5] = OracleAdminFacet.setUniswapV3Factory.selector;
        selectors[6] = OracleAdminFacet.setStableTokenFeed.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(oracleAdmin),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });

        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
        console.log("OracleAdminFacet cut into Diamond:", diamond);

        vm.stopBroadcast();
    }
}
