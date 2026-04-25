// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIMirror} from "../src/token/VPFIMirror.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title DeployVPFIMirror
 * @notice Deploys a VPFIMirror (pure OFT V2) on a non-canonical chain —
 *         Polygon, Arbitrum, Optimism, or Ethereum mainnet (and their
 *         Sepolia testnet counterparts).
 * @dev Runs ONCE per mirror chain, after that chain's VaipakamDiamond is
 *      already deployed. Does NOT flip `isCanonicalVPFIChain` — mirror
 *      Diamonds must leave the flag false so TreasuryFacet.mintVPFI reverts
 *      with NotCanonicalVPFIChain.
 *
 *      Required env vars:
 *        - ADMIN_PRIVATE_KEY           : admin-role key (broadcaster; must hold
 *                                        ADMIN_ROLE on the local Diamond so
 *                                        setVPFIToken passes)
 *        - <CHAIN>_DIAMOND_ADDRESS     : local-chain VaipakamDiamond proxy
 *                                        (resolved by block.chainid)
 *        - VPFI_OWNER                  : timelock/multi-sig owning the mirror proxy
 *        - LZ_ENDPOINT_<CHAIN>         : LayerZero EndpointV2 on this chain
 *                                        (resolved by block.chainid)
 */
contract DeployVPFIMirror is Script {
    /// @dev Resolves the LayerZero V2 EndpointV2 for the active chain from a
    ///      `LZ_ENDPOINT_<CHAIN>` env var. Endpoint addresses per chain live at
    ///      https://docs.layerzero.network/v2/deployments/deployed-contracts
    function _lzEndpoint() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 11155111) return vm.envAddress("LZ_ENDPOINT_SEPOLIA");
        if (chainId == 80002) return vm.envAddress("LZ_ENDPOINT_POLYGON_AMOY");
        if (chainId == 421614) return vm.envAddress("LZ_ENDPOINT_ARB_SEPOLIA");
        if (chainId == 11155420) return vm.envAddress("LZ_ENDPOINT_OP_SEPOLIA");
        if (chainId == 1) return vm.envAddress("LZ_ENDPOINT_ETHEREUM");
        if (chainId == 137) return vm.envAddress("LZ_ENDPOINT_POLYGON");
        if (chainId == 42161) return vm.envAddress("LZ_ENDPOINT_ARBITRUM");
        if (chainId == 10) return vm.envAddress("LZ_ENDPOINT_OPTIMISM");
        revert(string.concat("DeployVPFIMirror: unsupported chainId ", vm.toString(chainId)));
    }

    function run() external {
        uint256 deployerKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = Deployments.readDiamond();
        address owner = vm.envAddress("VPFI_OWNER");
        address lzEndpoint = _lzEndpoint();

        console.log("=== Vaipakam VPFI Mirror Deploy ===");
        console.log("Diamond:     ", diamond);
        console.log("Owner:       ", owner);
        console.log("LZ endpoint: ", lzEndpoint);
        console.log("Deployer:    ", vm.addr(deployerKey));

        vm.startBroadcast(deployerKey);

        VPFIMirror mirrorImpl = new VPFIMirror(lzEndpoint);
        ERC1967Proxy mirrorProxy = new ERC1967Proxy(
            address(mirrorImpl),
            abi.encodeCall(VPFIMirror.initialize, (owner))
        );
        address mirror = address(mirrorProxy);

        // Bind the mirror to the local Diamond. `isCanonicalVPFIChain` stays
        // false so the mint gate in TreasuryFacet.mintVPFI rejects any local
        // mint attempts on this chain.
        VPFITokenFacet(diamond).setVPFIToken(mirror);

        vm.stopBroadcast();

        // Mirror VPFI is the local-chain "vpfiToken" from the Diamond's
        // perspective; surface it under the same key so other scripts
        // (BridgeVPFI, etc.) read consistently across canonical and mirrors.
        Deployments.writeVPFIToken(mirror);

        console.log("VPFIMirror impl:   ", address(mirrorImpl));
        console.log("VPFIMirror proxy:  ", mirror);
        console.log("Diamond.isCanonical: false (mirror)");
        console.log("");
        console.log("NEXT STEPS (owner-only, outside this script):");
        console.log(" - mirror.setPeer(<canonical eid>, <adapter-address-bytes32>)");
        console.log(" - mirror.setPeer(<other mirror eid>, <their-address-bytes32>) for each other mirror");
    }
}
