// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIBuyReceiver} from "../src/token/VPFIBuyReceiver.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title DeployVPFIBuyReceiver
 * @notice Deploys the Base-only {VPFIBuyReceiver} OApp (UUPS proxy) and
 *         registers it with the canonical Diamond via
 *         {VPFIDiscountFacet.setBridgedBuyReceiver}.
 * @dev Runs ONCE on Base Sepolia / Base mainnet after the canonical
 *      VPFI stack is deployed. Must be followed by
 *      {WireVPFIBuyPeers.s.sol} to pair the receiver with each remote
 *      adapter, and an owner-only ETH top-up so the receiver can pay
 *      LayerZero fees for BUY_SUCCESS / BUY_FAILED responses + the
 *      return OFT send.
 *
 *      Required env vars:
 *        - ADMIN_PRIVATE_KEY              : admin-role key (broadcaster; must hold
 *                                           ADMIN_ROLE on the Diamond so
 *                                           setBridgedBuyReceiver passes)
 *        - BASE_SEPOLIA_DIAMOND_ADDRESS   : Base-Sepolia VaipakamDiamond proxy
 *        - BASE_SEPOLIA_VPFI_TOKEN        : Canonical VPFIToken proxy on Base
 *        - BASE_SEPOLIA_VPFI_OFT_ADAPTER  : Canonical VPFIOFTAdapter proxy on Base
 *        - VPFI_OWNER                     : OApp owner / LZ delegate
 *        - LZ_ENDPOINT_BASE_SEPOLIA       : LayerZero EndpointV2 on Base Sepolia
 *        - VPFI_BUY_RESPONSE_OPTIONS      : hex-encoded LZ options for BUY_SUCCESS/FAILED response
 *                                           (optional — may be left empty and set later via
 *                                           {VPFIBuyReceiver.setResponseOptions})
 *        - VPFI_BUY_OFT_SEND_OPTIONS      : hex-encoded LZ options for the return OFT send
 *                                           (optional — as above)
 */
contract DeployVPFIBuyReceiver is Script {
    function _lzEndpoint() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) return vm.envAddress("LZ_ENDPOINT_BASE_SEPOLIA");
        if (chainId == 8453) return vm.envAddress("LZ_ENDPOINT_BASE");
        revert("DeployVPFIBuyReceiver: unsupported chainId");
    }

    function run() external {
        uint256 deployerKey = vm.envUint("ADMIN_PRIVATE_KEY");
        // Read prior-deploy artifacts from
        // deployments/<chain>/addresses.json (with legacy
        // BASE_SEPOLIA_*/BASE_* env fallback for bootstrap chains).
        address diamond = Deployments.readDiamond();
        address vpfiToken = Deployments.readVPFIToken();
        address vpfiOftAdapter = Deployments.readVPFIOFTAdapter();
        address lzEndpoint = _lzEndpoint();
        address owner = vm.envAddress("VPFI_OWNER");
        bytes memory responseOptions = vm.envOr("VPFI_BUY_RESPONSE_OPTIONS", bytes(""));
        bytes memory oftSendOptions = vm.envOr("VPFI_BUY_OFT_SEND_OPTIONS", bytes(""));

        console.log("=== Deploy VPFIBuyReceiver (Base) ===");
        console.log("Diamond:         ", diamond);
        console.log("VPFIToken:       ", vpfiToken);
        console.log("VPFIOFTAdapter:  ", vpfiOftAdapter);
        console.log("LZ endpoint:     ", lzEndpoint);
        console.log("Owner:           ", owner);
        console.log("Deployer:        ", vm.addr(deployerKey));

        vm.startBroadcast(deployerKey);

        VPFIBuyReceiver impl = new VPFIBuyReceiver(lzEndpoint);
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIBuyReceiver.initialize,
                (
                    owner,
                    diamond,
                    vpfiToken,
                    vpfiOftAdapter,
                    responseOptions,
                    oftSendOptions
                )
            )
        );

        VPFIDiscountFacet(diamond).setBridgedBuyReceiver(address(proxy));

        vm.stopBroadcast();

        Deployments.writeVPFIBuyReceiver(address(proxy));

        console.log("VPFIBuyReceiver impl:  ", address(impl));
        console.log("VPFIBuyReceiver proxy: ", address(proxy));
        console.log("Diamond.bridgedBuyReceiver set.");
        console.log("");
        console.log("NEXT STEPS:");
        console.log(" - Fund the proxy with ETH for LZ fees (receiver.fundETH{value: X}())");
        console.log(" - Run WireVPFIBuyPeers.s.sol on each non-Base chain + this chain");
        console.log(" - If options were empty, call setResponseOptions / setOFTSendOptions");
    }
}
