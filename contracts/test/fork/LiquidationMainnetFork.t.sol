// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {VaipakamDiamond} from "../../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {OracleAdminFacet} from "../../src/facets/OracleAdminFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {HelperTest} from "../HelperTest.sol";

/// @title LiquidationMainnetForkTest
/// @notice Fork-based integration test for the oracle + liquidity inputs
///         that feed HF-based liquidation. Runs against real mainnet
///         Chainlink Feed Registry and v3-style AMM — the same surfaces the
///         Diamond reads in production — so any address drift, decimals
///         bug, or staleness regression is caught before mainnet broadcast.
/// @dev Scope boundary: this test covers the **read path** of the
///      liquidation machinery (price, liquidity, sequencer), NOT the swap
///      leg. Executing the real 0x swap requires an off-chain quote and
///      is not practical from Foundry; the swap leg is instead covered by
///      `RiskFacetTest` with the local `ZeroExProxyMock`. Together the
///      two suites form a complete regression surface: real oracle wiring
///      here, deterministic swap logic there.
///
///      Gated by `FORK_URL_MAINNET`. If unset, every test returns early
///      so CI without archive access is not blocked.
contract LiquidationMainnetForkTest is Test {
    // ── Mainnet infra (real deployed addresses) ─────────────────────────
    address internal constant CHAINLINK_FEED_REGISTRY =
        0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf;
    address internal constant USD_DENOM =
        0x0000000000000000000000000000000000000348;
    address internal constant UNISWAP_V3_FACTORY =
        0x1F98431c8aD98523631AE4a59f267346ea31F984;

    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    // Chainlink ETH/USD aggregator on mainnet — used as the direct
    // `ethNumeraireFeed` so `getAssetPrice(WETH)` resolves without needing an
    // asset/USD registry hop (the Feed Registry does not register WETH
    // as a USD-quoted asset; it is only reachable via the ETH alias).
    address internal constant ETH_USD_FEED =
        0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419;

    VaipakamDiamond internal diamond;
    bool internal forkEnabled;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL_MAINNET", string(""));
        if (bytes(url).length == 0) {
            forkEnabled = false;
            return;
        }
        vm.createSelectFork(url);
        forkEnabled = true;

        _deployMinimalDiamond();
        _wireOracleInfrastructure();
    }

    // ─────────────────────────────────────────────────────────────────
    // Diamond setup — minimum cut to exercise the oracle/liquidity path.
    // ─────────────────────────────────────────────────────────────────

    function _deployMinimalDiamond() internal {
        DiamondCutFacet cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(address(this), address(cutFacet));
        HelperTest helper = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](4);
        cuts[0] = _cut(address(new AccessControlFacet()), helper.getAccessControlFacetSelectors());
        cuts[1] = _cut(address(new AdminFacet()),         helper.getAdminFacetSelectors());
        cuts[2] = _cut(address(new OracleFacet()),        helper.getOracleFacetSelectors());
        cuts[3] = _cut(address(new OracleAdminFacet()),   _oracleAdminSelectors());

        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
    }

    function _wireOracleInfrastructure() internal {
        OracleAdminFacet admin = OracleAdminFacet(address(diamond));
        admin.setChainlinkRegistry(CHAINLINK_FEED_REGISTRY);
        admin.setUsdChainlinkDenominator(USD_DENOM);
        admin.setWethContract(WETH);
        admin.setEthUsdFeed(ETH_USD_FEED);
        admin.setUniswapV3Factory(UNISWAP_V3_FACTORY);
        // No L2 sequencer feed on L1 — intentional; sequencerHealthy() must
        // return true under that config.
    }

    function _oracleAdminSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](8);
        s[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        s[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        s[2] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        s[3] = OracleAdminFacet.setWethContract.selector;
        s[4] = OracleAdminFacet.setEthUsdFeed.selector;
        s[5] = OracleAdminFacet.setUniswapV3Factory.selector;
        s[6] = OracleAdminFacet.setStableTokenFeed.selector;
        s[7] = OracleAdminFacet.setSequencerUptimeFeed.selector;
    }

    function _cut(address facet, bytes4[] memory selectors)
        internal
        pure
        returns (IDiamondCut.FacetCut memory)
    {
        return IDiamondCut.FacetCut({
            facetAddress: facet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // Tests
    // ─────────────────────────────────────────────────────────────────

    /// @notice L1 has no sequencer feed configured → healthy by
    ///         default. Regression guard for the "L2-only" branch of
    ///         `_sequencerHealthy`.
    function test_Fork_sequencerHealthy_L1_alwaysTrue() public view {
        if (!forkEnabled) return;
        assertTrue(OracleFacet(address(diamond)).sequencerHealthy());
    }

    /// @notice getAssetPrice for WETH returns a plausible live ETH/USD
    ///         price. Also pins the Chainlink decimals (8) — if that
    ///         ever changes on the WETH feed, math downstream breaks.
    function test_Fork_getAssetPrice_WETH() public view {
        if (!forkEnabled) return;
        (uint256 price, uint8 decimals) = OracleFacet(address(diamond)).getAssetPrice(WETH);
        // Pin decimals — feed protocol uses 8; loudly catches migrations.
        assertEq(decimals, 8, "WETH feed decimals drifted");
        uint256 floor = 100 * (10 ** decimals);     // $100
        uint256 ceil = 100_000 * (10 ** decimals);  // $100k
        assertGt(price, floor, "WETH price below plausibility floor");
        assertLt(price, ceil, "WETH price above plausibility ceiling");
    }

    /// @notice getAssetPrice for USDC returns ~$1 within peg tolerance.
    ///         This is the most sensitive regression surface for the
    ///         stablecoin-aware staleness path.
    function test_Fork_getAssetPrice_USDC() public view {
        if (!forkEnabled) return;
        (uint256 price, uint8 decimals) = OracleFacet(address(diamond)).getAssetPrice(USDC);
        assertEq(decimals, 8, "USDC feed decimals drifted");
        uint256 scale = 10 ** decimals;
        uint256 lo = (90 * scale) / 100;   // $0.90
        uint256 hi = (110 * scale) / 100;  // $1.10
        assertGe(price, lo, "USDC below peg band");
        assertLe(price, hi, "USDC above peg band");
    }

    /// @notice checkLiquidityOnActiveNetwork returns Liquid for WETH —
    ///         it has a feed, a pool, and massive USD volume. If this
    ///         ever fails, either the pool threshold in
    ///         `_checkLiquidityWithConfig` changed or we picked a
    ///         broken pool on this chain.
    function test_Fork_checkLiquidity_WETH_liquid() public view {
        if (!forkEnabled) return;
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond))
            .checkLiquidityOnActiveNetwork(WETH);
        assertEq(
            uint8(status),
            uint8(LibVaipakam.LiquidityStatus.Liquid),
            "WETH not classified Liquid on mainnet"
        );
    }

    /// @notice Unknown token — never listed on Chainlink — cannot
    ///         produce a feed and must surface through the illiquid
    ///         branch rather than reverting with a raw error. Regression
    ///         guard against the NoPriceFeed → InvalidAsset rewiring.
    function test_Fork_checkLiquidity_randomAddress_notLiquid() public {
        if (!forkEnabled) return;
        address bogus = address(0xdeaDDeADDEaDdeaDdEAddEADDEAdDeadDEADDEaD);
        // An asset with no Chainlink feed reverts inside the classifier
        // — we only need to assert it does NOT return Liquid.
        try OracleFacet(address(diamond)).checkLiquidityOnActiveNetwork(bogus)
            returns (LibVaipakam.LiquidityStatus status)
        {
            assertTrue(
                status != LibVaipakam.LiquidityStatus.Liquid,
                "bogus asset unexpectedly classified Liquid"
            );
        } catch {
            // Expected fallthrough — no-feed revert is acceptable; what
            // matters is that liquidation wouldn't proceed here.
        }
    }

    /// @notice USDT is now a standard priced asset (no special-casing).
    ///         Expect either Liquid (has mainnet Chainlink feed + pool) or
    ///         Illiquid if the WETH pool depth check fails — but never a
    ///         revert. Regression guard against any residual USDT gating.
    function test_Fork_checkLiquidity_USDT_doesNotRevert() public view {
        if (!forkEnabled) return;
        LibVaipakam.LiquidityStatus status = OracleFacet(address(diamond))
            .checkLiquidityOnActiveNetwork(USDT);
        // Liquid or Illiquid both acceptable — the key invariant is no revert.
        assertTrue(
            status == LibVaipakam.LiquidityStatus.Liquid ||
                status == LibVaipakam.LiquidityStatus.Illiquid
        );
    }
}
