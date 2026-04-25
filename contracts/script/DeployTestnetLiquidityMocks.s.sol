// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "./mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title DeployTestnetLiquidityMocks
 * @notice One-shot setup that gives a testnet Vaipakam Diamond
 *         enough mock infrastructure to make TWO mock ERC-20s
 *         (`mUSDC`, `mWBTC`) come out as **liquid** under the
 *         protocol's `(price + depth)` classification rule. Supports
 *         Base Sepolia (84532) and Ethereum Sepolia (11155111).
 *         After this script runs, both tokens satisfy:
 *
 *           1. Chainlink-led price path (mock Feed Registry +
 *              per-asset feed → 8-decimal USD price).
 *           2. v3-style AMM `asset/WETH` pool depth above
 *              `MIN_LIQUIDITY_USD = $1,000,000` (mock UniswapV3
 *              factory + pool with `liquidity()` set to 1e24).
 *
 *         Real testnet WETH is reused as the quote asset (Base
 *         Sepolia: `0x4200…0006`; Sepolia: `0xfFf9…6B14`); we don't
 *         deploy a third mock ERC-20 for it. The protocol's
 *         `setWethContract(...)` is wired to that canonical address
 *         so liquidity-check call chains (`getPool(asset, WETH, fee)`)
 *         resolve correctly.
 *
 *         All addresses are written to
 *         `deployments/base-sepolia/addresses.json` under the keys
 *         `.mockChainlinkAggregator`, `.mockUniswapV3Factory`,
 *         `.mockERC20A`, `.mockERC20B` so downstream seeders /
 *         smoke tests can pick them up automatically.
 *
 * @dev   ⚠ This script ONLY runs on supported testnets (Base Sepolia
 *         84532 and Ethereum Sepolia 11155111). The mock
 *         infrastructure is testnet-only — production deploys must
 *         wire real Chainlink + real UniswapV3 (e.g. mainnet UniV3
 *         factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`,
 *         Base mainnet UniV3 factory
 *         `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`).
 *
 *         Required env vars:
 *           - PRIVATE_KEY        : deployer (pays for mock contract gas)
 *           - ADMIN_PRIVATE_KEY  : admin-role key (must hold
 *                                  `ORACLE_ADMIN_ROLE` on the
 *                                  Diamond so OracleAdminFacet
 *                                  setters pass)
 *           - BASE_SEPOLIA_WETH  : optional override on Base Sepolia.
 *                                  Defaults to `0x4200…0006` predeploy.
 *           - SEPOLIA_WETH       : optional override on Ethereum Sepolia.
 *                                  Defaults to canonical WETH9
 *                                  `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`.
 *
 *         Idempotent if re-run: every wiring step is a straight
 *         setter — re-running just re-points the Diamond at fresh
 *         mock addresses. The previous mocks remain on chain (just
 *         orphaned) and the new ones become authoritative.
 */
contract DeployTestnetLiquidityMocks is Script {
    /// @dev Canonical Chainlink Denominations sentinels — universal
    ///      across every chain that runs a Chainlink Feed Registry.
    ///      We register the mock registry under the same sentinels
    ///      so the protocol's `getFeed(asset, USD)` lookup hits our
    ///      mock feeds 1:1.
    address constant USD_DENOM = 0x0000000000000000000000000000000000000348;
    address constant ETH_DENOM = 0x000000000000000000000000000000000000000E;

    /// @dev Canonical Base predeploy WETH address. Same on Base
    ///      mainnet (8453) and Base Sepolia (84532) — published by
    ///      Optimism's Bedrock spec.
    address constant BASE_WETH_DEFAULT = 0x4200000000000000000000000000000000000006;

    /// @dev Canonical Sepolia WETH9 — the long-lived testnet WETH
    ///      reused by Aave, Uniswap, etc. Not a predeploy; we just
    ///      hardcode the well-known address so the protocol's
    ///      `setWethContract(...)` and `getPool(asset, WETH, fee)`
    ///      paths resolve to the same WETH everyone else uses.
    address constant SEPOLIA_WETH_DEFAULT = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;

    /// @dev sqrtPriceX96 for price = 1.0 token0/token1. Cherry-picked
    ///      at 2^96 so the mock pool's slot0 returns a non-zero
    ///      price; the actual price doesn't drive liquidity
    ///      classification — only `liquidity()` does — so any
    ///      non-zero value works.
    uint160 constant SQRT_PRICE_X96_ONE = 79228162514264337593543950336;

    /// @dev Pool depth in raw `liquidity()` units. The protocol
    ///      converts this to USD via
    ///      `liquidity * ETH/USD price / 1e8` and compares against
    ///      `MIN_LIQUIDITY_USD = 1_000_000 * 1e6`. With ETH at
    ///      $2000 (8-decimal Chainlink) and `liquidity = 1e24`, the
    ///      computed USD depth is well above $1B — clears the floor
    ///      with overwhelming margin so the test never flakes on
    ///      arithmetic precision.
    uint128 constant MOCK_POOL_LIQUIDITY = 1e24;

    /// @dev Mock ERC-20 supplies — generous enough to fund all
    ///      participants in the seeder scripts (lender, borrower,
    ///      treasury, etc.) without re-minting. Sub-mints inside
    ///      the seeders take from this initial pool.
    uint256 constant MUSDC_INITIAL_SUPPLY = 100_000_000e6;   // 100M mUSDC (6 dec)
    uint256 constant MWBTC_INITIAL_SUPPLY = 1_000e8;         // 1k mWBTC (8 dec)

    /// @dev Initial mock prices, 8-decimal Chainlink scale.
    int256 constant MUSDC_USD_PRICE = 1e8;       // $1.00
    int256 constant MWBTC_USD_PRICE = 60_000e8;  // $60,000
    int256 constant WETH_USD_PRICE  = 2_000e8;   // $2,000

    function run() external {
        uint256 cid = block.chainid;
        require(
            cid == 84532 || cid == 11155111,
            "DeployTestnetLiquidityMocks: chain not supported (need 84532 or 11155111)"
        );

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address weth;
        if (cid == 84532) {
            weth = vm.envOr("BASE_SEPOLIA_WETH", BASE_WETH_DEFAULT);
        } else {
            // Ethereum Sepolia — chainid 11155111
            weth = vm.envOr("SEPOLIA_WETH", SEPOLIA_WETH_DEFAULT);
        }
        address diamond = Deployments.readDiamond();

        console.log("=== Deploy Testnet Liquidity Mocks ===");
        console.log("Chain id:   ", cid);
        console.log("Diamond:    ", diamond);
        console.log("Deployer:   ", vm.addr(deployerKey));
        console.log("Admin:      ", vm.addr(adminKey));
        console.log("WETH:       ", weth);

        // ── Step 1: Deployer-side: deploy mocks ────────────────────────
        vm.startBroadcast(deployerKey);

        ERC20Mock mUSDC = new ERC20Mock("Mock USDC", "mUSDC", 6);
        ERC20Mock mWBTC = new ERC20Mock("Mock WBTC", "mWBTC", 8);
        // Mint initial supply to the deployer; seeders later transfer
        // sub-balances to lender / borrower / treasury accounts.
        mUSDC.mint(vm.addr(deployerKey), MUSDC_INITIAL_SUPPLY);
        mWBTC.mint(vm.addr(deployerKey), MWBTC_INITIAL_SUPPLY);

        MockChainlinkRegistry registry = new MockChainlinkRegistry();
        MockChainlinkFeed mUSDCFeed = new MockChainlinkFeed(MUSDC_USD_PRICE, 8);
        MockChainlinkFeed mWBTCFeed = new MockChainlinkFeed(MWBTC_USD_PRICE, 8);
        MockChainlinkFeed wethFeed  = new MockChainlinkFeed(WETH_USD_PRICE, 8);

        // Register every feed under the canonical (asset, USD)
        // sentinel pair. The Diamond's `_primaryPrice` consults the
        // registry for `getFeed(asset, USD)` first, falling back to
        // `asset/ETH × ETH/USD` only when no direct USD feed is
        // registered. Direct USD makes the path linear.
        registry.setFeed(address(mUSDC), USD_DENOM, address(mUSDCFeed));
        registry.setFeed(address(mWBTC), USD_DENOM, address(mWBTCFeed));
        registry.setFeed(weth, USD_DENOM, address(wethFeed));

        // Mock UniV3 factory + per-pair pools. `MIN_LIQUIDITY_USD`
        // is satisfied via `MOCK_POOL_LIQUIDITY` chosen above. Both
        // `mUSDC/WETH` and `mWBTC/WETH` clear the floor so both
        // tokens come out Liquid under
        // `OracleFacet.checkLiquidity`.
        MockUniswapV3Factory univ3 = new MockUniswapV3Factory();
        univ3.createPool(address(mUSDC), weth, 3000, SQRT_PRICE_X96_ONE, MOCK_POOL_LIQUIDITY);
        univ3.createPool(address(mWBTC), weth, 3000, SQRT_PRICE_X96_ONE, MOCK_POOL_LIQUIDITY);

        vm.stopBroadcast();

        console.log("");
        console.log("Deployed mocks:");
        console.log("  mUSDC ERC20:           ", address(mUSDC));
        console.log("  mWBTC ERC20:           ", address(mWBTC));
        console.log("  MockChainlinkRegistry: ", address(registry));
        console.log("  MockUniswapV3Factory:  ", address(univ3));
        console.log("  mUSDC/USD feed:        ", address(mUSDCFeed));
        console.log("  mWBTC/USD feed:        ", address(mWBTCFeed));
        console.log("  WETH/USD feed:         ", address(wethFeed));

        // ── Step 2: Admin-side: wire mocks into Diamond ────────────────
        vm.startBroadcast(adminKey);
        OracleAdminFacet oa = OracleAdminFacet(diamond);
        oa.setChainlinkRegistry(address(registry));
        oa.setUsdChainlinkDenominator(USD_DENOM);
        oa.setEthChainlinkDenominator(ETH_DENOM);
        oa.setWethContract(weth);
        oa.setEthUsdFeed(address(wethFeed));
        oa.setUniswapV3Factory(address(univ3));

        // Stable-feed shortcuts for the peg-aware staleness rule.
        // Phase 7b lets feeds tagged "USDC", "USDT", etc. sit at the
        // 25h ceiling provided the price stays within ±3% of $1.
        // Registering mUSDC under the symbol "mUSDC" is a no-op for
        // the peg check (the symbol isn't in the stable-list); we
        // intentionally don't register it there because the
        // mock-driven price model doesn't need that escape hatch.
        // The direct-feed path resolved via `getFeed(asset, USD)`
        // above is enough.

        // Risk params for both assets — mirror the values used in
        // SepoliaActiveLoan so the assets are immediately usable
        // for offers without a second `updateRiskParams` step.
        // (collateralFactor, ltvBps, liquidationThresholdBps,
        //  stalenessBps, riskScore — see RiskFacet.updateRiskParams)
        RiskFacet(diamond).updateRiskParams(address(mUSDC), 8000, 8500, 300, 1000);
        RiskFacet(diamond).updateRiskParams(address(mWBTC), 8000, 8500, 300, 1000);
        // WETH itself is the quote asset; no LTV-collateral role,
        // but registering risk params makes its rows render
        // consistently in the Risk dashboard view.
        RiskFacet(diamond).updateRiskParams(weth, 8000, 8500, 300, 1000);
        vm.stopBroadcast();

        // ── Step 3: persist artifacts ─────────────────────────────────
        Deployments.writeMockChainlinkAggregator(address(registry));
        Deployments.writeMockUniswapV3Factory(address(univ3));
        Deployments.writeMockERC20A(address(mUSDC));
        Deployments.writeMockERC20B(address(mWBTC));
        Deployments.writeAddress(".mockUSDCFeed", address(mUSDCFeed));
        Deployments.writeAddress(".mockWBTCFeed", address(mWBTCFeed));
        Deployments.writeAddress(".mockWETHFeed", address(wethFeed));

        console.log("");
        console.log("Wiring summary applied to Diamond:");
        console.log("  setChainlinkRegistry      -> mock registry");
        console.log("  setEthUsdFeed             -> mock WETH feed");
        console.log("  setUniswapV3Factory       -> mock factory");
        console.log("  setWethContract           -> ", weth);
        console.log("");
        console.log("Both mUSDC and mWBTC should now classify as Liquid.");
        console.log("Verify with:");
        console.log("  cast call <diamond> 'checkLiquidity(address)(uint8)' <mUSDC>");
        console.log("Returns 0 (Liquid) when the wiring is correct.");
    }
}
