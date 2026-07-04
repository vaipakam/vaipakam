// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {ERC4907Mock} from "../test/mocks/ERC4907Mock.sol";
import {ZeroExProxyMock} from "../test/mocks/ZeroExProxyMock.sol";
import {MockSwapAdapter} from "../test/mocks/MockSwapAdapter.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {MockChainlinkRegistry, MockChainlinkFeed} from "./mocks/MockChainlinkRegistry.sol";
import {MockUniswapV3Factory} from "./mocks/MockUniswapV3.sol";
import {Deployments} from "./lib/Deployments.sol";

/**
 * @title DeployTestnetMocks
 * @notice Deploys the **faucet-facing** testnet mock assets the alpha02
 *         website's `/faucet` route mints, and wires the LIQUID one into
 *         the Diamond's oracle so it actually classifies liquid. One
 *         reproducible script behind everything the naive-user testnet
 *         experience needs:
 *
 *           - `tLIQ` — an 18-dec ERC-20 wired to a mock Chainlink feed +
 *             a mock Uniswap-V3 `tLIQ/WETH` pool above the $1M depth
 *             floor, so it comes out **Liquid** (Tier 1). This unblocks
 *             health-factor display, HF-based & time-based liquidation,
 *             and refinance completion for loans that use it.
 *           - `tILQ` — an 18-dec ERC-20 with NO oracle wiring, so it
 *             stays **illiquid** (in-kind default path). The deliberate
 *             counterpart to tLIQ for exercising the illiquid flows.
 *           - `vRENT` — an ERC-4907 rentable NFT for the rental flows.
 *           - `MockSwapAdapter` — a registered `ISwapAdapter`
 *             (`AdminFacet.addSwapAdapter`) that the Phase-7a
 *             HF-liquidation failover path (`LibSwap.swapWithFailover`)
 *             routes through (Tier 2). It pays proceeds from its own
 *             balance, so the script seeds it with a tLIQ float; fund it
 *             with other principals as needed. `ZeroExProxyMock` +
 *             `setZeroExProxy`/`setallowanceTarget` are also wired but
 *             are the LEGACY path, unused by `swapWithFailover`.
 *
 *         The three faucet tokens all expose an unrestricted
 *         `mint(to, amount)` / `mint(to, tokenId)` — that's why the
 *         website faucet double-gates on the chain's `testnet` flag AND
 *         on the `testnetMocks` block this script writes. NEVER run on a
 *         mainnet slug.
 *
 *         Distinct from `DeployTestnetLiquidityMocks.s.sol`: that script
 *         deploys throwaway `mUSDC`/`mWBTC` for the seeder/smoke scripts.
 *         THIS script deploys the *persistent, user-mintable* trio the
 *         public faucet points at, and wires the faucet's own liquid
 *         token as the oracle-liquid asset so "mint tLIQ → it's liquid"
 *         holds end-to-end.
 *
 *         All addresses are written to
 *         `deployments/<chain-slug>/addresses.json` under a single
 *         `.testnetMocks` object (`liquidToken`, `illiquidToken`,
 *         `rentalNft`, `feedRegistry`, `liquidTokenUsdFeed`,
 *         `ethUsdFeed`, `uniswapV3Factory`, `liquidTokenWethPool`,
 *         `zeroExProxy`, `mockSwapAdapter`) — the exact shape the `TestnetMocks` interface
 *         in `packages/contracts/src/deployments.ts` consumes. Run the
 *         frontend deployments sync afterwards
 *         (`exportFrontendDeployments.sh`) to fold it into the bundle.
 *
 * @dev   Supported testnets: Base Sepolia (84532), Ethereum Sepolia
 *        (11155111), BNB Testnet (97), Arbitrum Sepolia (421614), OP
 *        Sepolia (11155420), Anvil (31337).
 *
 *        Required env vars:
 *          - DEPLOYER_PRIVATE_KEY : deployer (pays for mock contract gas)
 *          - ADMIN_PRIVATE_KEY    : must be the Diamond OWNER, which on
 *                                   the testnet deploys also holds
 *                                   ADMIN_ROLE + RISK_ADMIN_ROLE (the
 *                                   OracleAdminFacet setters gate on
 *                                   contract-owner; the AdminFacet /
 *                                   RiskFacet / ConfigFacet ones on
 *                                   roles). This script intentionally
 *                                   does NOT support timelock-owned
 *                                   Diamonds — post-handover chains
 *                                   route the oracle setters through
 *                                   governance instead.
 *
 *        Optional REUSE overrides — pass an already-deployed address to
 *        skip re-deploying that mock (idempotent re-runs; e.g. the
 *        faucet trio already live on Base Sepolia):
 *          - FAUCET_LIQUID_TOKEN
 *          - FAUCET_ILLIQUID_TOKEN
 *          - FAUCET_RENTAL_NFT
 *
 *        Optional WETH override (else the canonical per-chain address):
 *          - one of BASE_SEPOLIA_WETH / SEPOLIA_WETH / BNB_TESTNET_WBNB /
 *            ARB_SEPOLIA_WETH / OP_SEPOLIA_WETH / ANVIL_WETH.
 *
 *        Idempotent: every wiring step is a straight setter, so a re-run
 *        just re-points the Diamond at the (possibly reused) mocks.
 */
contract DeployTestnetMocks is Script {
    /// @dev Canonical Chainlink Denominations sentinels (chain-universal).
    address constant USD_DENOM = 0x0000000000000000000000000000000000000348;
    address constant ETH_DENOM = 0x000000000000000000000000000000000000000E;

    // ── Canonical wrapped-native per testnet (quote asset for the v3
    //    depth check). Mirrors DeployTestnetLiquidityMocks. ──
    address constant BASE_WETH_DEFAULT = 0x4200000000000000000000000000000000000006;
    address constant SEPOLIA_WETH_DEFAULT = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant BNB_TESTNET_WBNB_DEFAULT = 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd;
    address constant ARB_SEPOLIA_WETH_DEFAULT = 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73;
    address constant OP_SEPOLIA_WETH_DEFAULT = 0x4200000000000000000000000000000000000006;

    /// @dev sqrtPriceX96 for price 1.0 (both legs 18-dec ⇒ a 1:1 raw
    ///      reserve ratio at the current tick). NON-NEGOTIABLE with the
    ///      prices below: `OracleFacet._accumulatePoolImpacts` Guard 1
    ///      rejects a pool whose spot price disagrees with the Chainlink
    ///      feed ratio beyond `cfgTwapConsistencyBps`. A 1:1 pool
    ///      therefore REQUIRES the tLIQ feed and the WETH feed to report
    ///      the same USD price — otherwise the value-balance guard skips
    ///      the pool and tLIQ never classifies Liquid. Keep TLIQ_USD_PRICE
    ///      == WETH_USD_PRICE (or re-derive sqrtPriceX96 from their ratio
    ///      if you make them differ).
    uint160 constant SQRT_PRICE_X96_ONE = 79228162514264337593543950336;

    /// @dev Pool depth well above the $1M floor (converted via ETH/USD)
    ///      so classification never flakes on precision.
    uint128 constant MOCK_POOL_LIQUIDITY = 1e24;

    /// @dev Initial prices, 8-dec Chainlink scale. tLIQ is priced EQUAL
    ///      to WETH on purpose so the 1:1 mock pool spot agrees with the
    ///      feed ratio (see SQRT_PRICE_X96_ONE) — the arbitrary dollar
    ///      value ($2,000) doesn't matter for a faucet token, only that
    ///      the two feeds match.
    int256 constant TLIQ_USD_PRICE = 2_000e8; // == WETH; keeps the 1:1 pool consistent.
    int256 constant WETH_USD_PRICE = 2_000e8; // $2,000.

    function run() external {
        uint256 cid = block.chainid;
        require(
            cid == 84532 || cid == 11155111 || cid == 97 || cid == 421614 || cid == 11155420 || cid == 31337,
            "DeployTestnetMocks: chain not supported (need 84532, 11155111, 97, 421614, 11155420, or 31337)"
        );

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address weth = _wethFor(cid);
        address diamond = Deployments.readDiamond();

        console.log("=== Deploy Testnet Faucet + Oracle Mocks ===");
        console.log("Chain id: ", cid);
        console.log("Diamond:  ", diamond);
        console.log("Deployer: ", vm.addr(deployerKey));
        console.log("Admin:    ", vm.addr(adminKey));
        console.log("WETH:     ", weth);

        // ── Step 1: Deployer-side — deploy mocks ───────────────────────
        vm.startBroadcast(deployerKey);

        // Anvil-only: when ANVIL_WETH is unset there is no canonical
        // WETH, and `createPool(liquidToken, address(0), …)` would
        // revert ZERO_TOKEN after gas was already spent. Deploy a mock
        // WETH inline so the rest of the wiring matches the testnet
        // flow (mirrors DeployTestnetLiquidityMocks).
        if (cid == 31337 && weth == address(0)) {
            weth = address(new ERC20Mock("Wrapped ETH", "WETH", 18));
            console.log("Deployed mock WETH for anvil:", weth);
        }

        // Faucet trio: reuse via env if already deployed, else fresh.
        address liquidToken = vm.envOr("FAUCET_LIQUID_TOKEN", address(0));
        if (liquidToken == address(0)) {
            liquidToken = address(new ERC20Mock("Vaipakam Test Liquid", "tLIQ", 18));
            console.log("Deployed tLIQ:  ", liquidToken);
        } else {
            console.log("Reusing tLIQ:   ", liquidToken);
        }

        address illiquidToken = vm.envOr("FAUCET_ILLIQUID_TOKEN", address(0));
        if (illiquidToken == address(0)) {
            illiquidToken = address(new ERC20Mock("Vaipakam Test Illiquid", "tILQ", 18));
            console.log("Deployed tILQ:  ", illiquidToken);
        } else {
            console.log("Reusing tILQ:   ", illiquidToken);
        }

        address rentalNft = vm.envOr("FAUCET_RENTAL_NFT", address(0));
        if (rentalNft == address(0)) {
            rentalNft = address(new ERC4907Mock("Vaipakam Test Rental NFT", "vRENT"));
            console.log("Deployed vRENT: ", rentalNft);
        } else {
            console.log("Reusing vRENT:  ", rentalNft);
        }

        // Oracle mocks for the LIQUID token only (Tier 1).
        MockChainlinkRegistry registry = new MockChainlinkRegistry();
        MockChainlinkFeed liquidFeed = new MockChainlinkFeed(TLIQ_USD_PRICE, 8);
        MockChainlinkFeed wethFeed = new MockChainlinkFeed(WETH_USD_PRICE, 8);
        registry.setFeed(liquidToken, USD_DENOM, address(liquidFeed));
        registry.setFeed(weth, USD_DENOM, address(wethFeed));

        MockUniswapV3Factory univ3 = new MockUniswapV3Factory();
        address liquidPool =
            univ3.createPool(liquidToken, weth, 3000, SQRT_PRICE_X96_ONE, MOCK_POOL_LIQUIDITY);

        // Tier 2 — mock swap venue for HF-based liquidation.
        // ZeroExProxyMock is the LEGACY 0x-proxy shape; retained for
        // completeness but NOT used by the Phase-7a failover path.
        ZeroExProxyMock zeroEx = new ZeroExProxyMock();

        // The ACTUAL Phase-7a liquidation route: a registered
        // ISwapAdapter. MockSwapAdapter pays proceeds from its own
        // balance, so seed it with a generous tLIQ float for
        // tLIQ-principal liquidations (fund with other principals as
        // needed — see the run notes). 1:1 output multiplier == fair
        // value given tLIQ is priced equal to WETH.
        MockSwapAdapter swapAdapter = new MockSwapAdapter("vaipakam-testnet-mock");
        ERC20Mock(liquidToken).mint(address(swapAdapter), 1_000_000e18);

        vm.stopBroadcast();

        console.log("");
        console.log("Deployed oracle/swap mocks:");
        console.log("  MockChainlinkRegistry: ", address(registry));
        console.log("  tLIQ/USD feed:         ", address(liquidFeed));
        console.log("  WETH/USD feed:         ", address(wethFeed));
        console.log("  MockUniswapV3Factory:  ", address(univ3));
        console.log("  tLIQ/WETH pool:        ", liquidPool);
        console.log("  ZeroExProxyMock:       ", address(zeroEx));
        console.log("  MockSwapAdapter:       ", address(swapAdapter));

        // ── Step 2: Admin-side — wire mocks into the Diamond ───────────
        vm.startBroadcast(adminKey);
        OracleAdminFacet oa = OracleAdminFacet(diamond);
        oa.setChainlinkRegistry(address(registry));
        oa.setUsdChainlinkDenominator(USD_DENOM);
        oa.setEthChainlinkDenominator(ETH_DENOM);
        oa.setWethContract(weth);
        oa.setEthUsdFeed(address(wethFeed));
        oa.setUniswapV3Factory(address(univ3));

        // Pin the PAA quote list to [weth]. When `paaAssets` is already
        // populated on a chain, OracleFacet routes the liquidity search
        // over that list instead of the WETH fallback — a WETH-only
        // mock factory would then be invisible to `checkLiquidity(tLIQ)`
        // even with correct prices. The Anvil flow performs the same
        // reset for the same reason (Codex #982 review).
        {
            address[] memory paa = new address[](1);
            paa[0] = weth;
            ConfigFacet(diamond).setPaaAssets(paa);
        }

        // Risk params so tLIQ (and the WETH quote asset) render + are
        // immediately usable for offers — mirrors DeployTestnetLiquidityMocks.
        RiskFacet(diamond).updateRiskParams(liquidToken, 8000, 300, 1000);
        RiskFacet(diamond).updateRiskParams(weth, 8000, 300, 1000);

        // Tier 2 — legacy proxy pointers (kept for completeness; the
        // Phase-7a path ignores them).
        AdminFacet(diamond).setZeroExProxy(address(zeroEx));
        AdminFacet(diamond).setallowanceTarget(address(zeroEx));
        // Register the mock adapter so `swapWithFailover` has a venue.
        // Idempotent guard: skip if already registered (re-run safe).
        if (!_adapterRegistered(diamond, address(swapAdapter))) {
            AdminFacet(diamond).addSwapAdapter(address(swapAdapter));
        }
        vm.stopBroadcast();

        // ── Step 3: persist the testnetMocks object ────────────────────
        string memory obj = "testnetMocks";
        vm.serializeString(
            obj,
            "note",
            "Testnet-only faucet + oracle mock assets. NEVER present on mainnet slugs. Deployed by script/DeployTestnetMocks.s.sol."
        );
        vm.serializeAddress(obj, "liquidToken", liquidToken);
        vm.serializeAddress(obj, "illiquidToken", illiquidToken);
        vm.serializeAddress(obj, "rentalNft", rentalNft);
        vm.serializeAddress(obj, "feedRegistry", address(registry));
        vm.serializeAddress(obj, "liquidTokenUsdFeed", address(liquidFeed));
        vm.serializeAddress(obj, "ethUsdFeed", address(wethFeed));
        vm.serializeAddress(obj, "uniswapV3Factory", address(univ3));
        vm.serializeAddress(obj, "liquidTokenWethPool", liquidPool);
        vm.serializeAddress(obj, "zeroExProxy", address(zeroEx));
        string memory out = vm.serializeAddress(obj, "mockSwapAdapter", address(swapAdapter));
        // WETH first, and BEFORE the raw keyed write below: the
        // Deployments helper `_ensureFile`s the artifact, so on a chain
        // whose addresses.json doesn't exist yet (Diamond resolved via
        // the env fallback) the `.testnetMocks` write lands in a real
        // file instead of failing after everything already deployed.
        // (WETH itself is consumed by both the contract wiring above
        // and the frontend loader — one stamp, single source of truth.)
        Deployments.writeWeth(weth);
        vm.writeJson(out, Deployments.path(), ".testnetMocks");

        console.log("");
        console.log("Wiring applied. Faucet trio + tLIQ oracle wiring live.");
        console.log("Verify liquidity (expect 0 = Liquid):");
        console.log("  cast call <diamond> 'checkLiquidity(address)(uint8)' <tLIQ>");
        console.log("Next: bash contracts/script/exportFrontendDeployments.sh");
        console.log("HF-liquidation (Phase-7a) uses the registered MockSwapAdapter,");
        console.log("NOT the ZeroExProxyMock. The adapter pays proceeds from its own");
        console.log("balance: it was seeded with 1,000,000 tLIQ for tLIQ-principal");
        console.log("loans. For a WETH- (or other) principal loan, transfer that");
        console.log("token to the MockSwapAdapter first. Trigger with:");
        console.log("  triggerLiquidation(loanId, [{adapterIdx, data:0x}])");
        console.log("where adapterIdx is the adapter's slot in getSwapAdapters().");
    }

    /// @dev True if `adapter` is already in the Diamond's registered
    ///      swap-adapter list — makes re-runs idempotent.
    function _adapterRegistered(address diamond, address adapter)
        private
        view
        returns (bool)
    {
        address[] memory existing = AdminFacet(diamond).getSwapAdapters();
        for (uint256 i; i < existing.length; ++i) {
            if (existing[i] == adapter) return true;
        }
        return false;
    }

    function _wethFor(uint256 cid) private view returns (address) {
        if (cid == 84532) return vm.envOr("BASE_SEPOLIA_WETH", BASE_WETH_DEFAULT);
        if (cid == 11155111) return vm.envOr("SEPOLIA_WETH", SEPOLIA_WETH_DEFAULT);
        if (cid == 97) return vm.envOr("BNB_TESTNET_WBNB", BNB_TESTNET_WBNB_DEFAULT);
        if (cid == 421614) return vm.envOr("ARB_SEPOLIA_WETH", ARB_SEPOLIA_WETH_DEFAULT);
        if (cid == 11155420) return vm.envOr("OP_SEPOLIA_WETH", OP_SEPOLIA_WETH_DEFAULT);
        // Anvil (31337): no canonical WETH — env-supplied or zero sentinel.
        return vm.envOr("ANVIL_WETH", address(0));
    }
}
