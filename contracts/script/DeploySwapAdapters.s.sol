// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ZeroExAggregatorAdapter} from "../src/adapters/ZeroExAggregatorAdapter.sol";
import {OneInchAggregatorAdapter} from "../src/adapters/OneInchAggregatorAdapter.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title DeploySwapAdapters
 * @notice Per-chain deploy of the Phase 7a aggregator adapters
 *         (ZeroExAggregatorAdapter + OneInchAggregatorAdapter) and
 *         registration with the Diamond's swap-adapter chain via
 *         {AdminFacet.addSwapAdapter}.
 *
 * @dev    Background — the adapter constructor split shipped on
 *         2026-05-08 (commit 23006be) requires:
 *           - allowanceTarget = 0x AllowanceHolder, canonical
 *             0x0000000000001fF3684f28c67538d4D072C22734 on every
 *             post-Cancun chain (Ethereum / Base / Arbitrum / Optimism
 *             / Polygon zkEVM / BNB / Linea / Scroll / Blast / Avalanche
 *             / World / Unichain ... including their Sepolia testnets).
 *             Mantle uses 0x0000000000005E88410CcDFaDe4a5EfaE4b49562.
 *           - initialSettlers — the seed allowlist of legal Settler
 *             call destinations. NOT a stable pin: 0x rotates Settler
 *             addresses with each release and varies them by route
 *             type. Operator MUST supply the current set via env.
 *
 *         Pull current Settler addresses by either:
 *           (a) Querying the 0x deployer at
 *               0x00000000000004533Fe15556B1E086BB1A72cEae's
 *               `ownerOf(...)` for each Settler feature ID; or
 *           (b) Reading `transaction.to` from a fresh
 *               `https://api.0x.org/swap/allowance-holder/quote`
 *               response on the target chain.
 *         The README (contracts/README.md) lays out the rotation flow.
 *
 *         1inch v6 uses one address for both roles —
 *         0x111111125421cA6dc452d289314280a0f8842A65 is the canonical
 *         AggregationRouterV6 on every chain we deploy to. The
 *         OneInchAggregatorAdapter constructor takes one arg; it
 *         seeds the singleton allowlist itself.
 *
 * @dev    Required env vars:
 *           - DEPLOYER_PRIVATE_KEY              : deployer (must hold
 *                                        ADMIN_ROLE on the Diamond
 *                                        for the addSwapAdapter call;
 *                                        on testnets that's typically
 *                                        the same key that ran
 *                                        DeployDiamond.s.sol).
 *           - INITIAL_SETTLERS         : comma-separated 0x addresses,
 *                                        at least one. The
 *                                        ZeroExAggregatorAdapter
 *                                        constructor reverts with
 *                                        InvalidInitialSwapTargets if
 *                                        empty.
 *
 *         Optional overrides (defaults shown):
 *           - ALLOWANCE_HOLDER_OVERRIDE : default
 *               0x0000000000001fF3684f28c67538d4D072C22734
 *           - ONEINCH_ROUTER_OVERRIDE   : default
 *               0x111111125421cA6dc452d289314280a0f8842A65
 *           - DIAMOND_ADDRESS           : if unset, read from
 *               `contracts/deployments/<chain-slug>/addresses.json`.
 *
 * @dev    What this script does NOT do (intentional):
 *           - Doesn't deploy UniV3Adapter / BalancerV2Adapter. Those
 *             ship in their own deploy step (TBD; current Phase 7a
 *             coverage on the testnet trio is 0x + 1inch only — the
 *             keeper-bot's quote orchestrator gracefully degrades to
 *             the available subset).
 *           - Doesn't transfer adapter ownership. The deployer EOA
 *             stays as the adapter owner so it can run
 *             addSwapTarget / removeSwapTarget for the next Settler
 *             rotation. On mainnet this owner gets transferred to
 *             the chain's TimelockController per the Governance
 *             Runbook §6.2 — that's a deliberate post-deploy step.
 */
contract DeploySwapAdapters is Script {
    address private constant DEFAULT_ALLOWANCE_HOLDER =
        0x0000000000001fF3684f28c67538d4D072C22734;
    address private constant DEFAULT_ONEINCH_ROUTER =
        0x111111125421cA6dc452d289314280a0f8842A65;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        address allowanceHolder = vm.envOr(
            "ALLOWANCE_HOLDER_OVERRIDE",
            DEFAULT_ALLOWANCE_HOLDER
        );
        address oneInchRouter = vm.envOr(
            "ONEINCH_ROUTER_OVERRIDE",
            DEFAULT_ONEINCH_ROUTER
        );

        address[] memory initialSettlers = _readInitialSettlers();
        require(
            initialSettlers.length > 0,
            "DeploySwapAdapters: INITIAL_SETTLERS env var is required (comma-separated 0x addresses)"
        );

        // Diamond comes from the per-chain deployments JSON written
        // by DeployDiamond.s.sol — same source-of-truth pattern every
        // other Configure / Wire script in this repo uses.
        address diamond = vm.envOr(
            "DIAMOND_ADDRESS",
            Deployments.readDiamond()
        );
        require(
            diamond != address(0),
            "DeploySwapAdapters: Diamond address resolved to zero - run DeployDiamond.s.sol first or set DIAMOND_ADDRESS"
        );

        console.log("DeploySwapAdapters - chain", block.chainid);
        console.log("  Diamond:           ", diamond);
        console.log("  AllowanceHolder:   ", allowanceHolder);
        console.log("  1inch router:      ", oneInchRouter);
        console.log("  Initial settlers:  ", initialSettlers.length);
        for (uint256 i = 0; i < initialSettlers.length; i++) {
            console.log("    ", initialSettlers[i]);
        }

        vm.startBroadcast(deployerKey);

        ZeroExAggregatorAdapter zeroExAdapter =
            new ZeroExAggregatorAdapter(allowanceHolder, initialSettlers);
        console.log("  ZeroExAggregatorAdapter:  ", address(zeroExAdapter));

        OneInchAggregatorAdapter oneInchAdapter =
            new OneInchAggregatorAdapter(oneInchRouter);
        console.log("  OneInchAggregatorAdapter: ", address(oneInchAdapter));

        // Register both in the Diamond's swap-adapter chain. Order
        // matches the keeper-bot's documented priority (0=ZeroEx,
        // 1=OneInch); operators can later reorder via
        // AdminFacet.reorderSwapAdapters if a different chain ranks
        // 1inch better than 0x.
        AdminFacet(diamond).addSwapAdapter(address(zeroExAdapter));
        AdminFacet(diamond).addSwapAdapter(address(oneInchAdapter));

        vm.stopBroadcast();

        // Readback verification — fail loud if the registration
        // didn't actually take.
        address[] memory registered = AdminFacet(diamond).getSwapAdapters();
        bool foundZeroEx;
        bool foundOneInch;
        for (uint256 i = 0; i < registered.length; i++) {
            if (registered[i] == address(zeroExAdapter)) foundZeroEx = true;
            if (registered[i] == address(oneInchAdapter)) foundOneInch = true;
        }
        require(foundZeroEx, "DeploySwapAdapters: ZeroEx adapter not registered post-deploy");
        require(foundOneInch, "DeploySwapAdapters: OneInch adapter not registered post-deploy");

        console.log("");
        console.log("Done. Diamond.getSwapAdapters() length:", registered.length);
        console.log("");
        console.log("Next steps:");
        console.log("  - Record the adapter addresses in contracts/deployments/<slug>/addresses.json");
        console.log("    under `swapAdapters.zeroEx` + `swapAdapters.oneInch` keys (manual edit OK; ");
        console.log("    or extend lib/Deployments.sol with writer helpers for these in a follow-up).");
        console.log("  - When 0x ships a new Settler, run:");
        console.log("    cast send <zeroExAdapter> 'addSwapTarget(address)' <newSettler> --rpc-url $RPC --private-key $DEPLOYER_PRIVATE_KEY");
    }

    /// @dev Parses `INITIAL_SETTLERS` env var (comma-separated 0x
    ///      addresses) into an address[]. Returns empty if unset so
    ///      the caller can require non-empty with a clearer message
    ///      than `vm.envAddress` would surface.
    function _readInitialSettlers() internal view returns (address[] memory) {
        string memory raw = vm.envOr("INITIAL_SETTLERS", string(""));
        if (bytes(raw).length == 0) {
            return new address[](0);
        }
        // Split by comma. We use the foundry-std `split` helper.
        string[] memory parts = vm.split(raw, ",");
        address[] memory addrs = new address[](parts.length);
        for (uint256 i = 0; i < parts.length; i++) {
            // Trim ASCII whitespace from each token so a comma + space
            // separator works the same as a bare comma.
            string memory token = _trim(parts[i]);
            addrs[i] = vm.parseAddress(token);
        }
        return addrs;
    }

    /// @dev ASCII whitespace-trim (space, tab, newline, carriage
    ///      return). Solidity stdlib doesn't ship one; this is short
    ///      enough to inline.
    function _trim(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 start;
        uint256 end = b.length;
        while (start < end && (b[start] == 0x20 || b[start] == 0x09 || b[start] == 0x0A || b[start] == 0x0D)) {
            start++;
        }
        while (end > start && (b[end - 1] == 0x20 || b[end - 1] == 0x09 || b[end - 1] == 0x0A || b[end - 1] == 0x0D)) {
            end--;
        }
        bytes memory trimmed = new bytes(end - start);
        for (uint256 i = 0; i < trimmed.length; i++) {
            trimmed[i] = b[start + i];
        }
        return string(trimmed);
    }
}
