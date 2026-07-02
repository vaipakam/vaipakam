// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {UniV3Adapter} from "../src/adapters/UniV3Adapter.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/// @dev Minimal metadata surface a Uniswap-V3 periphery SwapRouter exposes,
///      used to preflight the router before wrapping it in an adapter.
interface IUniV3SwapRouterMeta {
    function factory() external view returns (address);
}

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

        // Validate the router is a genuine Uniswap-V3-style SwapRouter of the
        // SAME DEX as the oracle's factory — not the SmartRouter / QuoterV2 /
        // migrator / an EOA / a different DEX. On a no-0x chain (BNB testnet) a
        // wrong router would still deploy+register an adapter that ConfigureOracle
        // counts as the liquidation route, then revert on every real
        // exactInputSingle. Two checks:
        //  (1) factory() must equal the configured <CHAIN>_UNISWAP_V3_FACTORY
        //      (same DEX as the oracle's pool-depth gate).
        //  (2) the deadline-carrying UniV3 exactInputSingle selector (0x414bf389)
        //      must be present in the router bytecode — the QuoterV2 (which also
        //      has factory()) exposes quoteExactInputSingle, NOT exactInputSingle,
        //      so this rejects the common "pasted the quoter" mistake.
        // #862: REQUIRE the configured factory — do NOT let a missing/misspelled
        // <CHAIN>_UNISWAP_V3_FACTORY silently skip the same-DEX check (it's the
        // same var ConfigureOracle uses, so it must be set for a coherent deploy).
        address expectedFactory = _resolveFactory();
        require(
            expectedFactory != address(0),
            "DeployUniV3Adapter: <CHAIN>_UNISWAP_V3_FACTORY (or UNISWAP_V3_FACTORY) is required so the router can be verified against the same DEX the oracle uses"
        );
        try IUniV3SwapRouterMeta(router).factory() returns (address routerFactory) {
            require(
                routerFactory == expectedFactory,
                string.concat(
                    "DeployUniV3Adapter: router.factory() ",
                    vm.toString(routerFactory),
                    " != configured UNISWAP_V3_FACTORY ",
                    vm.toString(expectedFactory),
                    " - wrong router or DEX?"
                )
            );
        } catch {
            revert("DeployUniV3Adapter: router has no factory() - not a Uniswap-V3 SwapRouter");
        }
        require(
            _bytecodeHasSelector(router, 0x414bf389),
            "DeployUniV3Adapter: router lacks exactInputSingle(...,deadline,...) selector 0x414bf389 - not a UniV3 SwapRouter (SmartRouter/Quoter/migrator?)"
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

        // Idempotency — a UniswapV3-named adapter already registered is a no-op
        // ONLY if it wraps the SAME router we resolved. If it points at a
        // different router (a prior run with a wrong/old env value, or reuse on a
        // chain with a different UniV3-style router), returning cleanly would
        // leave liquidation swaps aimed at the wrong venue while
        // ConfigureOracle's adapter-count check still passes — so FAIL LOUD
        // instead, prompting the operator to remove the stale adapter first.
        address[] memory existing = AdminFacet(diamond).getSwapAdapters();
        for (uint256 i = 0; i < existing.length; i++) {
            if (
                keccak256(bytes(ISwapAdapter(existing[i]).adapterName()))
                    == keccak256(bytes("UniswapV3"))
            ) {
                address existingRouter = address(UniV3Adapter(existing[i]).ROUTER());
                require(
                    existingRouter == router,
                    string.concat(
                        "DeployUniV3Adapter: a UniswapV3 adapter (",
                        vm.toString(existing[i]),
                        ") is already registered pointing at a DIFFERENT router (",
                        vm.toString(existingRouter),
                        " != ",
                        vm.toString(router),
                        ") - remove it via AdminFacet before re-registering"
                    )
                );
                console.log("  Already registered UniswapV3 adapter (same router):", existing[i]);
                console.log("  Index (keeper CHAIN_SWAP.adapters.univ3 must match):", i);
                _assertOrWarnSlot(i, existing.length);
                console.log("  Nothing to do.");
                return;
            }
        }

        vm.startBroadcast(deployerKey);
        UniV3Adapter adapter = new UniV3Adapter(router);
        AdminFacet(diamond).addSwapAdapter(address(adapter));
        vm.stopBroadcast();

        console.log("  UniV3Adapter:", address(adapter));

        // Readback — fail loud if the registration didn't take, and surface the
        // adapter's INDEX. The keeper's swap-quote registry (serverQuotes
        // CHAIN_SWAP.adapters.univ3) is a static index into this on-chain list;
        // it MUST equal the index logged here. On a no-aggregator chain (BNB
        // testnet) the UniV3 adapter is the sole/first entry → index 0. Warn
        // loudly if it landed elsewhere so the operator updates the keeper
        // (otherwise the keeper would submit UniV3 routing to the wrong adapter).
        address[] memory registered = AdminFacet(diamond).getSwapAdapters();
        uint256 idx = type(uint256).max;
        for (uint256 i = 0; i < registered.length; i++) {
            if (registered[i] == address(adapter)) idx = i;
        }
        require(idx != type(uint256).max, "DeployUniV3Adapter: adapter not registered post-deploy");

        console.log("");
        console.log("Done. Diamond.getSwapAdapters() length:", registered.length);
        console.log("  UniV3 adapter index (keeper CHAIN_SWAP.adapters.univ3 must match):", idx);
        _assertOrWarnSlot(idx, registered.length);
        console.log("Record the adapter under `swapAdapters.uniV3` in the chain's addresses.json.");
    }

    /// @dev Guard the UniV3 adapter's slot against the keeper's per-chain
    ///      `CHAIN_SWAP.adapters.univ3` index.
    ///
    ///      On a NO-0x-backend chain (BNB testnet 97) the UniV3 adapter is the
    ///      SOLE liquidation route and the keeper hard-codes `univ3=0`, so slot 0
    ///      is not a preference — it's a correctness invariant. #862: any non-zero
    ///      slot there means a stale adapter (an aggregator that shouldn't exist
    ///      on a no-0x chain, or a prior mis-registration) sits ahead of UniV3;
    ///      ConfigureOracle now only WARNS, so if this passed too the diamond
    ///      could be "marked configured" while the keeper silently misroutes.
    ///      HARD-FAIL instead and tell the operator to clean the stale adapter(s).
    ///
    ///      On a with-0x chain the aggregators legitimately own slots 0/1 and
    ///      UniV3 is expected at 2 — a non-zero index is fine, so only warn.
    function _assertOrWarnSlot(uint256 idx, uint256 total) internal view {
        if (_isNo0xBackendChain()) {
            require(
                idx == 0,
                string.concat(
                    "DeployUniV3Adapter: no-0x chain requires the UniV3 adapter at index 0 (keeper univ3=0), but it is at index ",
                    vm.toString(idx),
                    " of ",
                    vm.toString(total),
                    " - a stale adapter sits ahead of it (no aggregators should exist on a no-0x chain). Remove it via AdminFacet.removeSwapAdapter, then re-run."
                )
            );
            return;
        }
        if (idx != 0) {
            console.log("  Note: index != 0. On a with-0x chain the aggregators own slots 0/1 and");
            console.log("  UniV3 is expected at 2 - confirm serverQuotes CHAIN_SWAP.adapters.univ3 matches.");
        }
    }

    /// @dev Chains where 0x has NO backend, so the on-chain UniV3/PancakeSwap
    ///      adapter is the only liquidation route and MUST sit at index 0. Mirror
    ///      of ConfigureOracle._isNo0xBackendChain (BNB testnet 97; 0x covers BNB
    ///      mainnet 56, so that is NOT here).
    function _isNo0xBackendChain() internal view returns (bool) {
        return block.chainid == 97;
    }

    /// @dev Resolve the SwapRouter: chain-prefixed `<CHAIN>_UNISWAP_V3_ROUTER`
    ///      first, then a bare `UNISWAP_V3_ROUTER` fallback. Only the chains
    ///      that currently use an on-chain DEX route are mapped; extend as
    ///      needed (a bare env always works as the escape hatch).
    function _resolveRouter() internal view returns (address) {
        return _resolveChainAddr("UNISWAP_V3_ROUTER");
    }

    /// @dev The oracle's configured v3 factory for this chain — used to confirm
    ///      the router belongs to the same DEX. Returns 0 if unset (the caller
    ///      then skips the factory-match, keeping the exactInputSingle-selector
    ///      check as the floor).
    function _resolveFactory() internal view returns (address) {
        return _resolveChainAddr("UNISWAP_V3_FACTORY");
    }

    /// @dev Chain-prefixed `<CHAIN>_<key>` first, then bare `<key>` fallback.
    ///      The prefix MUST match the wrapper scripts' `CCIP_SLUG` (they gate the
    ///      swap-adapters phase on `${CCIP_SLUG}_UNISWAP_V3_ROUTER`, so the
    ///      variable that triggers this deploy must be the one it reads). Covers
    ///      every chain the deploy wrappers support.
    function _resolveChainAddr(string memory key) internal view returns (address) {
        string memory prefix = _ccipSlugPrefix();
        address prefixed = bytes(prefix).length == 0
            ? address(0)
            : vm.envOr(string.concat(prefix, key), address(0));
        if (prefixed != address(0)) return prefixed;
        return vm.envOr(key, address(0));
    }

    /// @dev chainId → `<CCIP_SLUG>_` prefix, matching deploy-{mainnet,testnet,
    ///      chain}.sh. Empty for an unmapped chain (bare-key fallback only).
    function _ccipSlugPrefix() internal view returns (string memory) {
        uint256 c = block.chainid;
        // mainnets
        if (c == 1) return "ETHEREUM_";
        if (c == 8453) return "BASE_";
        if (c == 42161) return "ARBITRUM_";
        if (c == 10) return "OPTIMISM_";
        if (c == 56) return "BNB_";
        if (c == 137) return "POLYGON_";
        // testnets
        if (c == 84532) return "BASE_SEPOLIA_";
        if (c == 11155111) return "SEPOLIA_";
        if (c == 421614) return "ARB_SEPOLIA_";
        if (c == 11155420) return "OP_SEPOLIA_";
        if (c == 97) return "BNB_TESTNET_";
        if (c == 80002) return "POLYGON_AMOY_";
        return "";
    }

    /// @dev True if `sel` (a 4-byte function selector) appears anywhere in the
    ///      contract's runtime bytecode — a heuristic for "the contract exposes
    ///      this function". Runs in the LOCAL script VM (pre-broadcast), so the
    ///      O(codeLen) scan is not gas-metered. Used to tell a real SwapRouter
    ///      (has exactInputSingle) from the QuoterV2 (has quoteExactInputSingle).
    function _bytecodeHasSelector(address a, bytes4 sel) internal view returns (bool) {
        bytes memory code = a.code;
        if (code.length < 4) return false;
        for (uint256 i = 0; i + 4 <= code.length; i++) {
            if (
                code[i] == sel[0] && code[i + 1] == sel[1]
                    && code[i + 2] == sel[2] && code[i + 3] == sel[3]
            ) {
                return true;
            }
        }
        return false;
    }
}
