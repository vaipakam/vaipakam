// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIOFTAdapter} from "../src/token/VPFIOFTAdapter.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";

/**
 * @title DeployVPFICanonical
 * @notice Deploys the canonical VPFI stack on the Base (mainnet) / Base
 *         Sepolia (testnet) chain. Runs ONCE across the whole mesh.
 * @dev Deployment sequence (single broadcast):
 *        1. VPFIToken impl + ERC1967Proxy (initial mint → owner/treasury).
 *        2. VPFIOFTAdapter impl + ERC1967Proxy wired to (1) and the local
 *           LayerZero endpoint.
 *        3. Register (1) with the Diamond via VPFITokenFacet.setVPFIToken.
 *        4. Flip the Diamond's `isCanonicalVPFIChain` flag so
 *           TreasuryFacet.mintVPFI is enabled here (and nowhere else in the
 *           mesh).
 *
 *      Out of scope (do in a follow-up tx with the token's owner wallet):
 *        - `VPFIToken.setMinter(diamond)` so the Diamond is authorized to
 *          call `mint(...)` via TreasuryFacet.mintVPFI.
 *        - OApp `setDelegate`, DVN/exec config, enforced options on the
 *          adapter — all owner-only.
 *
 *      Required env vars:
 *        - ADMIN_PRIVATE_KEY : admin-role key (broadcaster; must hold ADMIN_ROLE
 *                              on the Diamond so setVPFIToken /
 *                              setCanonicalVPFIChain pass)
 *        - DIAMOND_ADDRESS   : Base-chain VaipakamDiamond proxy
 *        - VPFI_OWNER        : timelock/multi-sig owning the token proxy
 *        - VPFI_TREASURY     : recipient of the 23M initial mint
 *        - VPFI_INITIAL_MINTER : first `minter` (typically the treasury
 *                                safe; later rotated to the Diamond)
 *        - LZ_ENDPOINT       : LayerZero EndpointV2 on Base
 */
contract DeployVPFICanonical is Script {
    /// @dev Resolves the Diamond address for the active chain from a
    ///      `<CHAIN>_DIAMOND_ADDRESS` env var. Add a branch per chain as the
    ///      mesh expands. Reverts on unrecognised chains.
    function _diamondAddress() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) return vm.envAddress("BASE_SEPOLIA_DIAMOND_ADDRESS");
        if (chainId == 8453) return vm.envAddress("BASE_DIAMOND_ADDRESS");
        revert(string.concat("DeployVPFICanonical: unsupported chainId ", vm.toString(chainId)));
    }

    /// @dev Resolves the LayerZero V2 EndpointV2 for the active chain from a
    ///      `LZ_ENDPOINT_<CHAIN>` env var. Endpoint addresses per chain live at
    ///      https://docs.layerzero.network/v2/deployments/deployed-contracts
    function _lzEndpoint() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 84532) return vm.envAddress("LZ_ENDPOINT_BASE_SEPOLIA");
        if (chainId == 8453) return vm.envAddress("LZ_ENDPOINT_BASE");
        revert(string.concat("DeployVPFICanonical: unsupported chainId ", vm.toString(chainId)));
    }

    function run() external {
        uint256 deployerKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address diamond = _diamondAddress();
        address vpfiOwner = vm.envAddress("VPFI_OWNER");
        address treasury = vm.envAddress("VPFI_TREASURY");
        address initialMinter = vm.envAddress("VPFI_INITIAL_MINTER");
        address lzEndpoint = _lzEndpoint();

        console.log("=== Vaipakam Canonical VPFI Deploy (Base) ===");
        console.log("Diamond:        ", diamond);
        console.log("VPFI owner:     ", vpfiOwner);
        console.log("Treasury:       ", treasury);
        console.log("Initial minter: ", initialMinter);
        console.log("LZ endpoint:    ", lzEndpoint);
        console.log("Deployer:       ", vm.addr(deployerKey));

        vm.startBroadcast(deployerKey);

        // ── 1. VPFIToken proxy ──────────────────────────────────────────
        VPFIToken tokenImpl = new VPFIToken();
        ERC1967Proxy tokenProxy = new ERC1967Proxy(
            address(tokenImpl),
            abi.encodeCall(
                VPFIToken.initialize,
                (vpfiOwner, treasury, initialMinter)
            )
        );
        address vpfi = address(tokenProxy);

        // ── 2. VPFIOFTAdapter proxy ─────────────────────────────────────
        VPFIOFTAdapter adapterImpl = new VPFIOFTAdapter(vpfi, lzEndpoint);
        ERC1967Proxy adapterProxy = new ERC1967Proxy(
            address(adapterImpl),
            abi.encodeCall(VPFIOFTAdapter.initialize, (vpfiOwner))
        );

        // ── 3. Bind to the Diamond + flip canonical flag ────────────────
        VPFITokenFacet(diamond).setVPFIToken(vpfi);
        VPFITokenFacet(diamond).setCanonicalVPFIChain(true);

        vm.stopBroadcast();

        console.log("VPFIToken impl:    ", address(tokenImpl));
        console.log("VPFIToken proxy:   ", vpfi);
        console.log("OFTAdapter impl:   ", address(adapterImpl));
        console.log("OFTAdapter proxy:  ", address(adapterProxy));
        console.log("Diamond.isCanonical: true");
        console.log("");
        console.log("NEXT STEPS (owner-only, outside this script):");
        console.log(" - vpfi.setMinter(diamond)");
        console.log(" - adapter.setPeer(<remote eid>, <mirror-address-bytes32>) per mirror chain");
    }
}
