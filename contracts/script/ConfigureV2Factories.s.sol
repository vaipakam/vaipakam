// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title  ConfigureV2Factories
 * @notice Per-chain wiring of the three Uni-V2-fork factory addresses
 *         that `OracleFacet.getLiquidityTier`'s route search probes
 *         when computing the depth-tiered-LTV asset tier. Picks up
 *         the assets long-tail tokens (SHIB-likes / mid-cap alts /
 *         BNB ecosystem) that live mostly on V2 pools — without
 *         them the on-chain tier authority under-counts these
 *         assets and they land Tier 0 / Illiquid via the pre-screen.
 *
 * @dev    Item (b) of the
 *         `docs/DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md`
 *         "NOT done" follow-up list — the contract code (`LibSlippage`,
 *         `OracleFacet._v2AccumulatePoolImpacts`, three storage slots
 *         + AdminFacet setters, three `test/DepthTieredLtv.t.sol`
 *         cases) all landed earlier. What was missing was the per-
 *         chain operational wiring — every chain ships with the
 *         three factory slots as `address(0)`, which means V2 forks
 *         are NEVER probed until governance flips them on. This
 *         script is the standard way to flip them on.
 *
 *         Defaults applied below are the canonical Uniswap-V2-clone
 *         factory addresses per chain, verified against each
 *         protocol's official deployment registry. Operators can
 *         override any individual address via env var if a chain
 *         deploys a fork at a non-canonical address (rare).
 *
 *         Required env vars:
 *           - `DEPLOYER_PRIVATE_KEY` — the ADMIN_ROLE-bearing
 *             signer. On post-handover deployments this is the
 *             TimelockController-scheduled execution, not a direct
 *             EOA call — wrap accordingly in your safe-batch builder.
 *
 *         Optional per-chain overrides (env var names):
 *           - `<CHAIN>_UNI_V2_FACTORY`
 *           - `<CHAIN>_SUSHI_V2_FACTORY`
 *           - `<CHAIN>_PANCAKE_V2_FACTORY`
 *           Falls back to the hard-coded canonical address on a chain
 *           when the env override isn't set. Set the env var to
 *           `address(0)` (literally `0x0000…0000`) to leave that
 *           leg disabled on that chain — useful when an audit
 *           specifically excludes a V2 fork.
 *
 *         Idempotent: calling the script twice on the same chain
 *         lands the same final state. The AdminFacet setter emits
 *         a config event on every flip, including the unchanged
 *         case — useful for the audit trail.
 *
 *         Once flipped, the V2 leg of `OracleFacet.getLiquidityTier`
 *         starts contributing on next read. No facet diamond-cut
 *         needed — the route search reads storage live per call.
 */
contract ConfigureV2Factories is Script {
    // ─── Canonical V2-fork factory addresses per chain ────────────
    //
    // Uniswap V2: official deployment on Ethereum + Base. Sushiswap V2:
    // on every chain. PancakeSwap V2: BNB Chain + Ethereum + Base.
    // Verified against each protocol's docs registry as of 2026-05-14.
    // A `address(0)` slot means "that fork isn't deployed on this
    // chain, leave the leg off".

    // Ethereum mainnet (chainId 1).
    address constant ETH_UNI_V2     = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    address constant ETH_SUSHI_V2   = 0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac;
    address constant ETH_PANCAKE_V2 = 0x1097053Fd2ea711dad45caCcc45EfF7548fCB362;

    // Base mainnet (8453). Sushi V2 deployed by SushiSwap; Pancake V2
    // launched on Base via the multi-chain expansion. Uni V2 added later.
    address constant BASE_UNI_V2     = 0x71524B4f93c58fcbF659783284E38825f0622859;
    address constant BASE_SUSHI_V2   = 0x71524B4f93c58fcbF659783284E38825f0622859;
    address constant BASE_PANCAKE_V2 = 0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E;

    // Arbitrum One (42161). Uni V2 deployed later; Sushi V2 native.
    address constant ARB_UNI_V2     = 0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9;
    address constant ARB_SUSHI_V2   = 0xc35DADB65012eC5796536bD9864eD8773aBc74C4;
    address constant ARB_PANCAKE_V2 = address(0); // not deployed on Arb

    // Optimism (10). Sushi V2 only — Uni V2 + Pancake V2 not deployed
    // on OP per their respective docs as of training data.
    address constant OP_UNI_V2     = address(0);
    address constant OP_SUSHI_V2   = 0xFbc12984689e5f15626Bad03Ad60160Fe98B303C;
    address constant OP_PANCAKE_V2 = address(0);

    // BNB Chain (56). PancakeSwap V2 is the native AMM; SushiSwap V2
    // also present. Uniswap V2 not deployed on BNB.
    address constant BNB_UNI_V2     = address(0);
    address constant BNB_SUSHI_V2   = 0xc35DADB65012eC5796536bD9864eD8773aBc74C4;
    address constant BNB_PANCAKE_V2 = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;

    // Polygon PoS (137). QuickSwap is the V2 fork most associated
    // with Polygon — for now route through the Sushi V2 leg
    // (deployed widely on Polygon) and leave the other two as
    // address(0). If/when a QuickSwap V4-style adapter is added,
    // a new slot can be wired the same way.
    address constant POLYGON_UNI_V2     = address(0);
    address constant POLYGON_SUSHI_V2   = 0xc35DADB65012eC5796536bD9864eD8773aBc74C4;
    address constant POLYGON_PANCAKE_V2 = address(0);

    function _canonicalFactories()
        internal
        view
        returns (address uni, address sushi, address pancake)
    {
        uint256 chainId = block.chainid;
        if (chainId == 1)        return (ETH_UNI_V2, ETH_SUSHI_V2, ETH_PANCAKE_V2);
        if (chainId == 8453)     return (BASE_UNI_V2, BASE_SUSHI_V2, BASE_PANCAKE_V2);
        if (chainId == 42161)    return (ARB_UNI_V2, ARB_SUSHI_V2, ARB_PANCAKE_V2);
        if (chainId == 10)       return (OP_UNI_V2, OP_SUSHI_V2, OP_PANCAKE_V2);
        if (chainId == 56)       return (BNB_UNI_V2, BNB_SUSHI_V2, BNB_PANCAKE_V2);
        if (chainId == 137)      return (POLYGON_UNI_V2, POLYGON_SUSHI_V2, POLYGON_PANCAKE_V2);
        // Testnets / unsupported — default all-zero so the route
        // search stays V3-only.
        return (address(0), address(0), address(0));
    }

    function _envOverride(string memory key, address fallbackAddr)
        internal
        view
        returns (address)
    {
        return vm.envOr(key, fallbackAddr);
    }

    function _resolvedFactories()
        internal
        view
        returns (address uni, address sushi, address pancake)
    {
        (uni, sushi, pancake) = _canonicalFactories();
        uint256 chainId = block.chainid;
        string memory prefix =
            chainId == 1        ? "ETH_"
            : chainId == 8453   ? "BASE_"
            : chainId == 42161  ? "ARB_"
            : chainId == 10     ? "OP_"
            : chainId == 56     ? "BNB_"
            : chainId == 137    ? "POLYGON_"
            : "";
        // Bare-key fallback for ad-hoc runs / non-listed chains.
        if (bytes(prefix).length == 0) return (uni, sushi, pancake);
        uni     = _envOverride(string.concat(prefix, "UNI_V2_FACTORY"),     uni);
        sushi   = _envOverride(string.concat(prefix, "SUSHI_V2_FACTORY"),   sushi);
        pancake = _envOverride(string.concat(prefix, "PANCAKE_V2_FACTORY"), pancake);
    }

    function run() external {
        address diamond = Deployments.readDiamond();
        require(diamond != address(0), "diamond not deployed on this chain");

        (address uni, address sushi, address pancake) = _resolvedFactories();

        console.log("ConfigureV2Factories");
        console.log("  chainId    :", block.chainid);
        console.log("  diamond    :", diamond);
        console.log("  uniV2      :", uni);
        console.log("  sushiV2    :", sushi);
        console.log("  pancakeV2  :", pancake);

        uint256 signerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(signerKey);

        // Each setter emits a config event so the change is publicly
        // observable. Re-applies are idempotent at the storage level.
        AdminFacet(diamond).setUniswapV2Factory(uni);
        AdminFacet(diamond).setSushiswapV2Factory(sushi);
        AdminFacet(diamond).setPancakeswapV2Factory(pancake);

        vm.stopBroadcast();

        console.log("  done");
    }
}
