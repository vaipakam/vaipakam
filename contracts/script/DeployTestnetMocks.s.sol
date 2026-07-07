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
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

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
 *           - `tILQ2` — a SECOND unwired 18-dec ERC-20: pairs with tILQ
 *             so a deal can carry an illiquid asset on BOTH sides
 *             (dual-consent, no HF, in-kind default). Its absence of
 *             feed/pool wiring below is deliberate and load-bearing.
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
 *         `.testnetMocks` object (`liquidToken`, `liquidToken2`,
 *         `illiquidToken`, `illiquidToken2`, `rentalNft`, `feedRegistry`,
 *         `liquidTokenUsdFeed`, `liquidToken2UsdFeed`, `ethUsdFeed`,
 *         `uniswapV3Factory`, `liquidTokenWethPool`,
 *         `liquidToken2WethPool`, `zeroExProxy`, `mockSwapAdapter`)
 *         — the exact shape the `TestnetMocks` interface
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
 *          - FAUCET_LIQUID_TOKEN_2 (the second liquid ERC-20, now the
 *            mUSDC $1 mock — gives faucet-only wallets a distinct
 *            both-liquid pair with a realistic price spread for the
 *            HF / liquidation / refinance demos. Leave UNSET on the
 *            relabel run so the fresh mUSDC deploys in place of tLQ2.)
 *          - FAUCET_MWETH (third liquid ERC-20, mWETH — WETH-flavoured
 *            mintable principal; NOT the canonical WETH)
 *          - FAUCET_ILLIQUID_TOKEN
 *          - FAUCET_RENTAL_NFT
 *          - FAUCET_RENTAL_NFT_2 (second ERC-4907 collection, vART)
 *          - FAUCET_SWAP_ADAPTER (the MockSwapAdapter from a prior run;
 *            without it a re-run registers a SECOND adapter slot.
 *            NOTE: after the deployer-gating change to the mocks,
 *            leave this UNSET once so a fresh owner-gated adapter
 *            replaces the open one; same for the oracle mocks, which
 *            redeploy fresh every run anyway)
 *
 *        Optional WETH override (else the canonical per-chain address):
 *          - one of BASE_SEPOLIA_WETH / SEPOLIA_WETH / ARB_SEPOLIA_WETH /
 *            OP_SEPOLIA_WETH / ANVIL_WETH.
 *          - BNB Testnet (97) has NO default: BNB_TESTNET_WETH is
 *            REQUIRED and must be a bridged/mock WETH — WBNB is not
 *            WETH and would be mispriced by the ETH/USD feed.
 *
 *        Optional mWETH price knobs:
 *          - MWETH_USD_PRICE (8-dec, default 3000e8 = $3,000) prices both
 *            the mWETH feed and the WETH quote feed, keeping the
 *            mWETH/WETH pool 1:1.
 *          - MWETH_USD_FEED (default unset) — when a non-zero address, it
 *            is registered AS-IS for both mWETH and WETH (and set as the
 *            ETH/USD feed) instead of a static mock, so mWETH tracks the
 *            live chain ETH/USD aggregator. Must be the real chain's
 *            Chainlink ETH/USD feed; unset = static mock at MWETH_USD_PRICE.
 *
 *        Idempotent: every wiring step is a straight setter, so a re-run
 *        just re-points the Diamond at the (possibly reused) mocks.
 */
/// @dev Minimal Chainlink AggregatorV3 view used to read the live
///      `MWETH_USD_FEED` override's current answer at deploy time.
interface IAggregatorV3Like {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

contract DeployTestnetMocks is Script {
    /// @dev Canonical Chainlink Denominations sentinels (chain-universal).
    address constant USD_DENOM = 0x0000000000000000000000000000000000000348;
    address constant ETH_DENOM = 0x000000000000000000000000000000000000000E;

    // ── Canonical wrapped-native per testnet (quote asset for the v3
    //    depth check). Mirrors DeployTestnetLiquidityMocks. ──
    address constant BASE_WETH_DEFAULT = 0x4200000000000000000000000000000000000006;
    address constant SEPOLIA_WETH_DEFAULT = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    // NOTE: no BNB Testnet default on purpose — WBNB is not WETH; see _wethFor.
    address constant ARB_SEPOLIA_WETH_DEFAULT = 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73;
    address constant OP_SEPOLIA_WETH_DEFAULT = 0x4200000000000000000000000000000000000006;

    /// @dev Pool depth well above the $1M floor (converted via ETH/USD)
    ///      so classification never flakes on precision.
    uint128 constant MOCK_POOL_LIQUIDITY = 1e24;

    /// @dev Initial prices, 8-dec Chainlink scale. Each liquid faucet
    ///      token now carries a DISTINCT, realistic USD price so loan math
    ///      isn't the degenerate "1 tLIQ == 1 mWETH" it used to be:
    ///        - tLIQ  → $2,000 (an arbitrary blue-chip stand-in)
    ///        - mUSDC → $1     (a USDC mimic)
    ///      mWETH's price is env-configurable (see `MWETH_USD_PRICE`,
    ///      default $3,000) and read at runtime, so it isn't a constant.
    ///
    ///      Because the prices now DIFFER, a plain 1:1 pool (the old
    ///      `SQRT_PRICE_X96_ONE`) would fail `OracleFacet`'s value-balance
    ///      guard and each token would classify Illiquid. Instead every
    ///      pool's init `sqrtPriceX96` is RE-DERIVED from its two legs'
    ///      feed prices via {_poolSqrtPriceX96} so the pool spot agrees
    ///      with the Chainlink feed ratio within `cfgTwapConsistencyBps`.
    int256 constant TLIQ_USD_PRICE = 2_000e8; // $2,000
    int256 constant MUSDC_USD_PRICE = 1e8; // $1 (USDC mimic)

    /// @dev Default mWETH/WETH price when `MWETH_USD_PRICE` is unset:
    ///      $3,000, 8-dec Chainlink scale — priced like real ETH so mWETH
    ///      loans behave like ETH loans.
    uint256 constant DEFAULT_MWETH_USD_PRICE = 3_000e8;

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

        // mWETH pricing knobs. `MWETH_USD_PRICE` (8-dec, default $3,000)
        // prices BOTH the mWETH feed and the WETH quote feed so the
        // mWETH/WETH pool stays 1:1. `MWETH_USD_FEED`, when set to a
        // non-zero address, is used AS-IS (the real chain's Chainlink
        // ETH/USD aggregator) for BOTH mWeth and weth instead of a static
        // mock feed — giving live ETH tracking. Default (unset) deploys a
        // static mock feed at `MWETH_USD_PRICE`.
        uint256 mWethUsdPrice = vm.envOr("MWETH_USD_PRICE", DEFAULT_MWETH_USD_PRICE);
        address mWethUsdFeedOverride = vm.envOr("MWETH_USD_FEED", address(0));

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

        // SECOND oracle-wired liquid token — a faucet-only wallet needs
        // a DISTINCT both-liquid ERC-20 pair for the health-factor /
        // HF-liquidation / refinance demos: tLIQ-vs-tLIQ is rejected as
        // self-collateralized, and tLIQ/tILQ is not bothLiquid. It is now
        // a MOCKED USDC ($1) so the pair carries a realistic price spread.
        // NOTE: real USDC is 6-dec; we deliberately keep 18 dec here so
        // the faucet/frontend read one uniform decimal for every mock and
        // the pool math stays decimal-term-free. The USDC mimic is
        // satisfied by the symbol + the $1 feed price, not by the decimals.
        address liquidToken2 = vm.envOr("FAUCET_LIQUID_TOKEN_2", address(0));
        if (liquidToken2 == address(0)) {
            liquidToken2 = address(new ERC20Mock("Mock USD Coin", "mUSDC", 18));
            console.log("Deployed mUSDC: ", liquidToken2);
        } else {
            console.log("Reusing mUSDC:  ", liquidToken2);
        }

        address illiquidToken = vm.envOr("FAUCET_ILLIQUID_TOKEN", address(0));
        if (illiquidToken == address(0)) {
            illiquidToken = address(new ERC20Mock("Vaipakam Test Illiquid", "tILQ", 18));
            console.log("Deployed tILQ:  ", illiquidToken);
        } else {
            console.log("Reusing tILQ:   ", illiquidToken);
        }

        // Second unpriced token: pairs with tILQ so a deal can carry an
        // illiquid asset on BOTH sides (dual-consent, no HF, in-kind
        // default). Gets NO feed or pool wiring below — that absence is
        // what classifies it illiquid.
        address illiquidToken2 = vm.envOr("FAUCET_ILLIQUID_TOKEN_2", address(0));
        if (illiquidToken2 == address(0)) {
            illiquidToken2 = address(new ERC20Mock("Vaipakam Test Illiquid 2", "tILQ2", 18));
            console.log("Deployed tILQ2: ", illiquidToken2);
        } else {
            console.log("Reusing tILQ2:  ", illiquidToken2);
        }

        // Third liquid token, WETH-flavoured: some flows read better in
        // the demo when the principal LOOKS like wrapped ETH; mWETH is
        // oracle-priced like real ETH via `MWETH_USD_PRICE` (default
        // $3,000), NOT the canonical WETH — that can't be faucet-minted.
        // Its feed and the WETH quote feed are pinned to the SAME price so
        // the mWETH/WETH pool stays 1:1.
        address mWeth = vm.envOr("FAUCET_MWETH", address(0));
        if (mWeth == address(0)) {
            mWeth = address(new ERC20Mock("Mock Wrapped ETH", "mWETH", 18));
            console.log("Deployed mWETH: ", mWeth);
        } else {
            console.log("Reusing mWETH:  ", mWeth);
        }

        address rentalNft = vm.envOr("FAUCET_RENTAL_NFT", address(0));
        if (rentalNft == address(0)) {
            rentalNft = address(new ERC4907Mock("Vaipakam Test Rental NFT", "vRENT"));
            console.log("Deployed vRENT: ", rentalNft);
        } else {
            console.log("Reusing vRENT:  ", rentalNft);
        }

        // Second rentable NFT collection so two-sided rental demos
        // (and multiple listings per wallet) don't share one contract.
        address rentalNft2 = vm.envOr("FAUCET_RENTAL_NFT_2", address(0));
        if (rentalNft2 == address(0)) {
            rentalNft2 = address(new ERC4907Mock("Vaipakam Test Art NFT", "vART"));
            console.log("Deployed vART:  ", rentalNft2);
        } else {
            console.log("Reusing vART:   ", rentalNft2);
        }

        // Oracle mocks for the LIQUID tokens only (Tier 1). Each liquid
        // token carries a DISTINCT USD price (tLIQ $2,000 / mUSDC $1 /
        // mWETH `mWethUsdPrice`); WETH is priced at `mWethUsdPrice` too so
        // the mWETH/WETH pool is 1:1. Every pool's `sqrtPriceX96` is
        // re-derived from its legs' feed prices (see {_poolSqrtPriceX96}),
        // so the pool spot agrees with the feed ratio and the
        // value-balance guard admits it.
        MockChainlinkRegistry registry = new MockChainlinkRegistry();
        MockChainlinkFeed liquidFeed = new MockChainlinkFeed(TLIQ_USD_PRICE, 8);
        MockChainlinkFeed liquid2Feed = new MockChainlinkFeed(MUSDC_USD_PRICE, 8);
        // mWETH + WETH share a feed price. When `MWETH_USD_FEED` is set we
        // register that live aggregator for BOTH; otherwise we deploy a
        // single static mock feed at `mWethUsdPrice` and share it across
        // mWETH and WETH so the two always report an identical price.
        address ethUsdFeedAddr;
        // The USD price (8-dec) used for the WETH quote leg AND the mWETH
        // leg when deriving pool spots. On the static path it's
        // `mWethUsdPrice`; on the override path it's the feed's LIVE answer
        // so every pool's spot matches what OracleFacet will read from the
        // same feed AT DEPLOY TIME.
        uint256 wethQuotePrice8;
        if (mWethUsdFeedOverride != address(0)) {
            ethUsdFeedAddr = mWethUsdFeedOverride;
            // Derive the WETH/mWETH leg from the live feed so tLIQ ($2,000)
            // and mUSDC ($1) — whose static pools quote against WETH —
            // pass the value-balance guard at deploy time. NOTE: assumes an
            // 8-dec ETH/USD aggregator (the Chainlink standard). CAVEAT: as
            // the live price later moves beyond `cfgTwapConsistencyBps`
            // (3%) the STATIC tLIQ/mUSDC pools drift out of band and can
            // flip Illiquid until a re-run reprices them; the mWETH/WETH
            // pool never drifts (both its legs read this same feed).
            // Validate the round metadata with the SAME freshness rules
            // OracleFacet enforces on an ETH/USD feed, so a stale live feed
            // fails the deploy FAST instead of silently wiring a feed that
            // makes WETH + every WETH-quoted faucet token classify Illiquid
            // the moment the oracle re-reads it (Codex #1095): a valid,
            // complete, non-future, non-stale round with a positive answer.
            (
                uint80 roundId,
                int256 live,
                ,
                uint256 updatedAt,
                uint80 answeredInRound
            ) = IAggregatorV3Like(mWethUsdFeedOverride).latestRoundData();
            require(live > 0, "DeployTestnetMocks: MWETH_USD_FEED returned non-positive price");
            require(updatedAt != 0, "DeployTestnetMocks: MWETH_USD_FEED round not complete (updatedAt=0)");
            require(updatedAt <= block.timestamp, "DeployTestnetMocks: MWETH_USD_FEED updatedAt is in the future");
            require(answeredInRound >= roundId, "DeployTestnetMocks: MWETH_USD_FEED stale round (answeredInRound < roundId)");
            // Max staleness — override with MWETH_USD_FEED_MAX_AGE (seconds);
            // default 1h matches a typical ETH/USD heartbeat + margin.
            uint256 maxAge = vm.envOr("MWETH_USD_FEED_MAX_AGE", uint256(3600));
            require(
                block.timestamp - updatedAt <= maxAge,
                "DeployTestnetMocks: MWETH_USD_FEED answer is stale (older than MWETH_USD_FEED_MAX_AGE)"
            );
            wethQuotePrice8 = SafeCast.toUint256(live);
            console.log("Using live MWETH_USD_FEED for mWETH + WETH:", ethUsdFeedAddr);
            console.log("  live ETH/USD (8-dec):", wethQuotePrice8);
            console.log("  round age (s):", block.timestamp - updatedAt);
        } else {
            ethUsdFeedAddr = address(new MockChainlinkFeed(SafeCast.toInt256(mWethUsdPrice), 8));
            wethQuotePrice8 = mWethUsdPrice;
        }
        registry.setFeed(liquidToken, USD_DENOM, address(liquidFeed));
        registry.setFeed(liquidToken2, USD_DENOM, address(liquid2Feed));
        registry.setFeed(mWeth, USD_DENOM, ethUsdFeedAddr);
        registry.setFeed(weth, USD_DENOM, ethUsdFeedAddr);

        MockUniswapV3Factory univ3 = new MockUniswapV3Factory();
        // tLIQ ($2,000) / mUSDC ($1) / mWETH (== WETH) all quoted against
        // WETH (`wethQuotePrice8`). Each pool's spot is re-derived from the
        // two legs' 8-dec feed prices so it matches the Chainlink ratio.
        uint256 tliqPrice8 = SafeCast.toUint256(TLIQ_USD_PRICE);
        uint256 musdcPrice8 = SafeCast.toUint256(MUSDC_USD_PRICE);
        address liquidPool = univ3.createPool(
            liquidToken, weth, 3000, _poolSqrtPriceX96(liquidToken, tliqPrice8, weth, wethQuotePrice8), MOCK_POOL_LIQUIDITY
        );
        address liquid2Pool = univ3.createPool(
            liquidToken2, weth, 3000, _poolSqrtPriceX96(liquidToken2, musdcPrice8, weth, wethQuotePrice8), MOCK_POOL_LIQUIDITY
        );
        address mWethPool = univ3.createPool(
            mWeth, weth, 3000, _poolSqrtPriceX96(mWeth, wethQuotePrice8, weth, wethQuotePrice8), MOCK_POOL_LIQUIDITY
        );

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
        //
        // Reused via FAUCET_SWAP_ADAPTER on re-runs: a fresh deploy per
        // run would always fail the `_adapterRegistered` idempotency
        // check below and APPEND another adapter slot, accumulating
        // stale venues in `getSwapAdapters()` and shifting the
        // `adapterIdx` the run notes advertise.
        address swapAdapter = vm.envOr("FAUCET_SWAP_ADAPTER", address(0));
        if (swapAdapter != address(0)) {
            // The reuse override must point at a HARDENED adapter: the
            // pre-gating MockSwapAdapter had public setters — exactly
            // the stale state this script remediates — and reusing it
            // (then pruning everything else below) would leave the
            // griefable venue as the ONLY liquidation route. The old
            // bytecode has no `owner()` getter, so the call reverting
            // doubles as the version check; a hardened adapter owned
            // by a different key is rejected too.
            try MockSwapAdapter(swapAdapter).owner() returns (address o) {
                require(
                    o == vm.addr(deployerKey),
                    "DeployTestnetMocks: FAUCET_SWAP_ADAPTER owned by another key - unset the env to deploy fresh"
                );
            } catch {
                revert(
                    "DeployTestnetMocks: FAUCET_SWAP_ADAPTER is a pre-hardening (ungated) adapter - unset the env to deploy fresh"
                );
            }
            // A hardened-but-older adapter passes owner() yet lacks the
            // oracle-aware `tokenUsdFeed`/`setTokenFeed` this script now wires.
            // Reusing it would pass the checks here, deploy every OTHER mock
            // below, and only then revert on the setTokenFeed calls (selector
            // not found) — a confusing half-applied rerun. Probe the getter and
            // fail early with an actionable message instead (Codex #1095).
            try MockSwapAdapter(swapAdapter).tokenUsdFeed(weth) returns (address) {
                // oracle-aware adapter — safe to reuse.
            } catch {
                revert(
                    "DeployTestnetMocks: FAUCET_SWAP_ADAPTER predates the oracle-aware setTokenFeed (Codex #1095) - unset the env to deploy a fresh adapter"
                );
            }
            console.log("Reusing MockSwapAdapter: ", swapAdapter);
        } else {
            swapAdapter = address(new MockSwapAdapter("vaipakam-testnet-mock"));
            console.log("Deployed MockSwapAdapter:", swapAdapter);
        }
        // Restrict `execute` to the Diamond: a funded adapter with an
        // open execute is a public pot — anyone could approve a junk
        // inputToken and drain the seeded output float (Codex #982 r9).
        // Idempotent; owner (deployer) is broadcasting here.
        MockSwapAdapter(swapAdapter).setRestrictedTo(diamond);
        // Register each liquid token's USD price so the adapter pays the FAIR
        // price ratio on cross-asset liquidation swaps (Codex #1095). Without
        // this, a flat 1:1 payout returns 1 mUSDC for 1 mWETH — far below the
        // oracle-derived `minOutputAmount` (~3,000) — and every HF/default
        // liquidation on an unequal-priced faucet pair would drop into the
        // full-collateral fallback instead of swapping. (Reuses the same 8-dec
        // prices wired into the feeds above.)
        MockSwapAdapter(swapAdapter).setTokenPrice(liquidToken, tliqPrice8);
        MockSwapAdapter(swapAdapter).setTokenPrice(liquidToken2, musdcPrice8);
        MockSwapAdapter(swapAdapter).setTokenPrice(mWeth, wethQuotePrice8);
        MockSwapAdapter(swapAdapter).setTokenPrice(weth, wethQuotePrice8);
        // mWETH + WETH TRACK the LIVE ETH/USD feed (Codex #1095, oracle-aware
        // choice): the oracle prices them off `ethUsdFeedAddr`, so the swap
        // payout must read the SAME feed at execute time — otherwise the
        // deploy-time snapshot above goes stale as ETH moves and mWETH
        // liquidations drift past the slippage band into the full-collateral
        // fallback. tLIQ / mUSDC keep their static snapshot (fake stable
        // prices); the snapshot stays the fallback if a feed read ever returns
        // a non-positive answer.
        MockSwapAdapter(swapAdapter).setTokenFeed(mWeth, ethUsdFeedAddr);
        MockSwapAdapter(swapAdapter).setTokenFeed(weth, ethUsdFeedAddr);
        // Top up the proceeds float every run (harmless testnet mint) —
        // every liquid principal so any side's loans can liquidate. The float
        // is generous enough that even the priciest ratio (mWETH→mUSDC pays
        // ~3,000× the input) has ample output on hand for demo-sized loans.
        ERC20Mock(liquidToken).mint(swapAdapter, 1_000_000e18);
        ERC20Mock(liquidToken2).mint(swapAdapter, 1_000_000e18);
        ERC20Mock(mWeth).mint(swapAdapter, 1_000_000e18);

        vm.stopBroadcast();

        console.log("");
        console.log("Deployed oracle/swap mocks:");
        console.log("  MockChainlinkRegistry: ", address(registry));
        console.log("  tLIQ/USD feed:         ", address(liquidFeed));
        console.log("  mUSDC/USD feed:        ", address(liquid2Feed));
        console.log("  mWETH+WETH/USD feed:   ", ethUsdFeedAddr);
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
        oa.setEthUsdFeed(ethUsdFeedAddr);
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

        // Risk params for EVERY liquid faucet asset (and the WETH quote
        // asset) so both orientations of any liquid pair are admissible
        // — a zero `loanInitMaxLtvBps` on the collateral side rejects
        // loan admission outright (Codex #982 round-6).
        RiskFacet(diamond).updateRiskParams(liquidToken, 8000, 300, 1000);
        RiskFacet(diamond).updateRiskParams(liquidToken2, 8000, 300, 1000);
        RiskFacet(diamond).updateRiskParams(mWeth, 8000, 300, 1000);
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
        // Prune stale copies of OUR OWN mock adapter — identified by
        // `adapterName() == "vaipakam-testnet-mock"` — so pre-hardening
        // (publicly mutable) instances stop being reachable at their
        // old adapterIdx (Codex #982 round-7). Anything else is
        // PRESERVED: real venues (e.g. BNB Testnet's registered uniV3
        // adapter) must survive a faucet-mock re-run (round-9). An
        // adapter whose name read reverts is treated as foreign and
        // kept. Removal by ADDRESS is order-independent, so iterating
        // a pre-removal snapshot is safe.
        {
            address[] memory existing = AdminFacet(diamond).getSwapAdapters();
            for (uint256 i; i < existing.length; ++i) {
                if (existing[i] == swapAdapter) continue;
                bool isOurMock;
                try MockSwapAdapter(existing[i]).adapterName() returns (string memory n) {
                    isOurMock =
                        keccak256(bytes(n)) == keccak256(bytes("vaipakam-testnet-mock"));
                } catch {
                    isOurMock = false;
                }
                if (isOurMock) {
                    AdminFacet(diamond).removeSwapAdapter(existing[i]);
                    console.log("Removed stale mock swap adapter:", existing[i]);
                } else {
                    console.log("Preserved non-mock swap adapter: ", existing[i]);
                }
            }
        }
        vm.stopBroadcast();

        // ── Step 3: persist the testnetMocks object ────────────────────
        string memory obj = "testnetMocks";
        vm.serializeString(
            obj,
            "note",
            "Testnet-only faucet + oracle mock assets. NEVER present on mainnet slugs. Deployed by script/DeployTestnetMocks.s.sol."
        );
        // `liquidToken2` keeps its key (address slot is stable across the
        // relabel) — it now holds the mUSDC ($1) mock, not the old tLQ2.
        vm.serializeAddress(obj, "liquidToken", liquidToken);
        vm.serializeAddress(obj, "liquidToken2", liquidToken2);
        vm.serializeAddress(obj, "mWeth", mWeth);
        vm.serializeAddress(obj, "illiquidToken", illiquidToken);
        vm.serializeAddress(obj, "illiquidToken2", illiquidToken2);
        vm.serializeAddress(obj, "rentalNft", rentalNft);
        vm.serializeAddress(obj, "rentalNft2", rentalNft2);
        vm.serializeAddress(obj, "feedRegistry", address(registry));
        vm.serializeAddress(obj, "liquidTokenUsdFeed", address(liquidFeed));
        // liquidToken2UsdFeed now prices mUSDC at $1 (was tLQ2 at $2,000).
        vm.serializeAddress(obj, "liquidToken2UsdFeed", address(liquid2Feed));
        // mWETH and WETH share one feed (static mock at MWETH_USD_PRICE, or
        // the live MWETH_USD_FEED override) so the pool stays 1:1.
        vm.serializeAddress(obj, "mWethUsdFeed", ethUsdFeedAddr);
        vm.serializeAddress(obj, "ethUsdFeed", ethUsdFeedAddr);
        vm.serializeAddress(obj, "uniswapV3Factory", address(univ3));
        vm.serializeAddress(obj, "liquidTokenWethPool", liquidPool);
        vm.serializeAddress(obj, "liquidToken2WethPool", liquid2Pool);
        vm.serializeAddress(obj, "mWethWethPool", mWethPool);
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

    /// @dev Re-derive a v3-clone pool's initialization `sqrtPriceX96` from
    ///      the two legs' 8-dec USD feed prices, so the pool's SPOT price
    ///      agrees with the Chainlink feed ratio. `OracleFacet`'s
    ///      value-balance guard (`_accumulatePoolImpacts`) skips any pool
    ///      whose spot disagrees with the feed beyond `cfgTwapConsistencyBps`
    ///      (default 3%) — a plain 1:1 pool would classify a differently-
    ///      priced token Illiquid.
    ///
    ///      All faucet tokens are 18-dec, so there is NO decimal term.
    ///      Uniswap orders token0 = min(addr); the value-balanced spot is
    ///      `token1_per_token0 = price(token0)/price(token1)`, hence
    ///      `sqrtPriceX96 = sqrt(price0 * 2**192 / price1)` where price0 /
    ///      price1 are the token0 / token1 8-dec feed prices. For equal
    ///      prices this returns ~2**96 (the old 1:1 `SQRT_PRICE_X96_ONE`),
    ///      so mWETH/WETH stays 1:1 automatically.
    ///
    ///      Overflow-safe: `price0 * 2**192 ≤ ~1e13 * 6.3e57 ≈ 6e70 <
    ///      2**256` (and `Math.mulDiv` carries the full 512-bit product
    ///      regardless); the sqrt of a ≤~2**234 value fits well inside
    ///      uint160.
    function _poolSqrtPriceX96(
        address tokenA,
        uint256 priceA8,
        address tokenB,
        uint256 priceB8
    ) internal pure returns (uint160) {
        (uint256 price0, uint256 price1) =
            tokenA < tokenB ? (priceA8, priceB8) : (priceB8, priceA8);
        uint256 ratioX192 = Math.mulDiv(price0, uint256(1) << 192, price1);
        return SafeCast.toUint160(Math.sqrt(ratioX192));
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
        // BNB Testnet: WBNB is NOT WETH — `setWethContract` is the
        // bridged-WETH oracle reference and the mock ETH/USD feed would
        // price WBNB as ETH. There is no canonical bridged WETH on 97,
        // so REQUIRE an explicit address (a bridged/mock WETH the
        // operator controls) instead of silently defaulting to WBNB.
        if (cid == 97) return vm.envAddress("BNB_TESTNET_WETH");
        if (cid == 421614) return vm.envOr("ARB_SEPOLIA_WETH", ARB_SEPOLIA_WETH_DEFAULT);
        if (cid == 11155420) return vm.envOr("OP_SEPOLIA_WETH", OP_SEPOLIA_WETH_DEFAULT);
        // Anvil (31337): no canonical WETH — env-supplied, else reuse a
        // mock WETH a prior run persisted to `.weth` (keeps re-runs
        // idempotent), else zero sentinel → run() deploys one inline.
        address w = vm.envOr("ANVIL_WETH", address(0));
        if (w == address(0)) w = Deployments.readWethOptional();
        return w;
    }
}
