// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {UniV3Adapter} from "../src/adapters/UniV3Adapter.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title DeployUniV3Adapter
 * @notice Per-chain deploy of the on-chain Uniswap-V3-style DEX swap adapter
 *         ({UniV3Adapter}) and registration with the Diamond's swap-adapter
 *         chain via {AdminFacet.addSwapAdapter}. This is the "own deploy step"
 *         that {DeploySwapAdapters} defers (it ships only the 0x + 1inch
 *         aggregator adapters).
 *
 * @dev    WHY this exists — the aggregator adapters (0x / 1inch) depend on those
 *         projects' off-chain Swap APIs + on-chain Settler/router deployments,
 *         which do NOT cover every chain. BNB *testnet* (97) is the motivating
 *         case: 0x's Swap API covers BNB *mainnet* (56) but not the testnet, and
 *         no 0x Settler/AllowanceHolder is deployed there. `UniV3Adapter` needs
 *         only an on-chain Uniswap-V3-style `SwapRouter.exactInputSingle`, and
 *         PancakeSwap V3 (a Uniswap V3 fork) exposes exactly that — so pointing
 *         this adapter at PancakeSwap V3's SwapRouter gives BNB testnet a fully
 *         on-chain HF-liquidation route with no aggregator dependency.
 *
 *         The router MUST expose the deadline-carrying Uniswap-V3
 *         `exactInputSingle((address,address,uint24,address,uint256,uint256,
 *         uint256,uint160))` (selector 0x414bf389) — PancakeSwap V3's SwapRouter
 *         does; its deadline-less SmartRouter variant does not. Confirm on-chain
 *         with `router.factory()` (must match the oracle's UNISWAP_V3_FACTORY)
 *         and `router.WETH9()` before pointing the adapter at it.
 *
 * @dev    Required env:
 *           - ADMIN_PRIVATE_KEY : the ADMIN_ROLE holder — `addSwapAdapter` is
 *                                 ADMIN_ROLE-gated. This is the same key
 *                                 ConfigureOracle / ConfigureVPFIToken use;
 *                                 after DeployDiamond renounces the deployer's
 *                                 roles the ADMIN key (not the deployer EOA) is
 *                                 the role holder + Diamond owner.
 *           - <CHAIN>_UNISWAP_V3_ROUTER (or bare UNISWAP_V3_ROUTER) : the
 *                                    Uniswap-V3-style SwapRouter this adapter
 *                                    wraps (e.g. PancakeSwap V3 SwapRouter on
 *                                    BNB testnet 0x1b81D678ffb9C0263b24A97847620C99d213eB14).
 *         The Diamond is read chain-aware from this chain's deployments JSON
 *         (no DIAMOND_ADDRESS env override — a stale bare value in a multi-chain
 *         .env would target the wrong chain's Diamond).
 *
 * @dev    Ownership — the deployer EOA stays the adapter owner (the UniV3
 *         adapter carries no owner-managed allowlist, unlike the aggregator
 *         adapters, so there is nothing to rotate). Idempotency — a re-run
 *         deploys a fresh adapter instance and appends it; the run refuses to
 *         add a second UniswapV3-named adapter so repeated runs are safe no-ops.
 */
contract DeployUniV3Adapter is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("ADMIN_PRIVATE_KEY");

        address router = _resolveRouter();
        require(
            router != address(0),
            "DeployUniV3Adapter: <CHAIN>_UNISWAP_V3_ROUTER (or UNISWAP_V3_ROUTER) is required"
        );
        require(
            router.code.length > 0,
            "DeployUniV3Adapter: UNISWAP_V3_ROUTER has no bytecode on this chain"
        );

        // Chain-aware: read THIS chain's addresses.json (like ConfigureOracle /
        // ConfigureVPFIToken). Deliberately NOT `vm.envOr("DIAMOND_ADDRESS", …)`
        // — a stale bare DIAMOND_ADDRESS left in a multi-chain .env would point
        // this at the wrong chain's Diamond.
        address diamond = Deployments.readDiamond();
        require(
            diamond != address(0),
            "DeployUniV3Adapter: Diamond not found in this chain's addresses.json - run DeployDiamond.s.sol first"
        );

        address broadcaster = vm.addr(deployerKey);
        require(
            AccessControlFacet(diamond).hasRole(keccak256("ADMIN_ROLE"), broadcaster),
            string.concat(
                "DeployUniV3Adapter: broadcaster ",
                vm.toString(broadcaster),
                " missing ADMIN_ROLE on Diamond ",
                vm.toString(diamond)
            )
        );

        console.log("DeployUniV3Adapter - chain", block.chainid);
        console.log("  Diamond:     ", diamond);
        console.log("  SwapRouter:  ", router);

        // Idempotency — skip if a UniswapV3-named adapter is already registered.
        address[] memory existing = AdminFacet(diamond).getSwapAdapters();
        for (uint256 i = 0; i < existing.length; i++) {
            if (
                keccak256(bytes(ISwapAdapter(existing[i]).adapterName()))
                    == keccak256(bytes("UniswapV3"))
            ) {
                console.log("  Already registered UniswapV3 adapter:", existing[i]);
                console.log("  Nothing to do.");
                return;
            }
        }

        vm.startBroadcast(deployerKey);
        UniV3Adapter adapter = new UniV3Adapter(router);
        AdminFacet(diamond).addSwapAdapter(address(adapter));
        vm.stopBroadcast();

        console.log("  UniV3Adapter:", address(adapter));

        // Readback — fail loud if the registration didn't take.
        address[] memory registered = AdminFacet(diamond).getSwapAdapters();
        bool found;
        for (uint256 i = 0; i < registered.length; i++) {
            if (registered[i] == address(adapter)) found = true;
        }
        require(found, "DeployUniV3Adapter: adapter not registered post-deploy");

        console.log("");
        console.log("Done. Diamond.getSwapAdapters() length:", registered.length);
        console.log("Record the adapter under `swapAdapters.uniV3` in the chain's addresses.json.");
    }

    /// @dev Resolve the SwapRouter: chain-prefixed `<CHAIN>_UNISWAP_V3_ROUTER`
    ///      first, then a bare `UNISWAP_V3_ROUTER` fallback. Only the chains
    ///      that currently use an on-chain DEX route are mapped; extend as
    ///      needed (a bare env always works as the escape hatch).
    function _resolveRouter() internal view returns (address) {
        string memory prefix;
        uint256 chainId = block.chainid;
        if (chainId == 97) prefix = "BNB_TESTNET_";
        else if (chainId == 56) prefix = "BNB_";
        else if (chainId == 84532) prefix = "BASE_SEPOLIA_";
        else if (chainId == 421614) prefix = "ARB_SEPOLIA_";

        address prefixed = bytes(prefix).length == 0
            ? address(0)
            : vm.envOr(string.concat(prefix, "UNISWAP_V3_ROUTER"), address(0));
        if (prefixed != address(0)) return prefixed;
        return vm.envOr("UNISWAP_V3_ROUTER", address(0));
    }
}
