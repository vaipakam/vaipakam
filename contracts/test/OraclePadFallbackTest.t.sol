// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {FeedRegistryInterface} from "@chainlink/contracts/src/v0.8/interfaces/FeedRegistryInterface.sol";
import {MockChainlinkAggregator} from "./mocks/MockChainlinkAggregator.sol";

/**
 * @title OraclePadFallbackTest
 * @notice T-048 — exercises the Predominantly Available Denominator
 *         (PAD) architecture in `OracleFacet._primaryPrice`. The PAD
 *         pivot routes every priced asset through the universally-
 *         covered Chainlink USD feed set when the active numeraire
 *         is non-USD, so the protocol never accidentally relies on a
 *         🟡 / 🔴-rated direct asset/<numeraire> feed.
 *
 *         Eight scenarios:
 *           1.  Retail short-circuit: PAD == numeraire == USD →
 *               single asset/PAD read, no FX multiply, math identical
 *               to pre-T-048.
 *           2.  Pre-T-048 fallback: predominantDenominator == 0 →
 *               legacy numeraire-direct path stays active.
 *           3.  Industrial-fork PAD pivot with direct PAD/<numeraire>
 *               feed: USD-quoted asset price x (USD/EUR) FX rate.
 *           4.  Industrial-fork PAD pivot with derived FX rate:
 *               PAD/<numeraire> = ETH/<numeraire> over ETH/PAD.
 *           5.  Per-asset numeraire-direct override: skips PAD pivot
 *               entirely and reads the override feed.
 *           6.  WETH special-case under PAD pivot: ETH/PAD x FX rate.
 *           7.  All paths fail: revert {PadNumeraireRateUnavailable}
 *               when neither direct nor derived rate is reachable.
 *           8.  Setter rejects zero-address PAD denominator + zero
 *               ETH/PAD anchor (parameter-out-of-range guards).
 *
 *         Math correctness notes for the FX-multiply branch:
 *           - `padPrice` is in `padDec` decimals (typically 8 for
 *             Chainlink USD-quoted feeds).
 *           - `fxRate` is in `fxDec` decimals (typically 8 too).
 *           - Composed: `numerPrice = padPrice * fxRate / 10^fxDec`.
 *           - Output decimals match `padDec` so consumers downstream
 *             see the same scale as the pre-T-048 path.
 */
contract OraclePadFallbackTest is SetupTest {
    address internal registry;
    address internal usdDenominator; // PAD denomination (Chainlink USD constant)
    address internal eurDenominator; // active numeraire on industrial fork
    address internal ethDenominator;
    address internal weth;

    // 8-decimal Chainlink USD-style feeds.
    MockChainlinkAggregator internal feedAssetUsd; // asset/USD = $1
    MockChainlinkAggregator internal feedEthUsd; // ETH/USD = $4000
    MockChainlinkAggregator internal feedEthEur; // ETH/EUR = EUR 3700
    MockChainlinkAggregator internal feedUsdEur; // USD/EUR = 0.92
    MockChainlinkAggregator internal feedAssetEurDirect; // asset/EUR override = EUR 0.92

    function setUp() public {
        setupHelper();
        // SetupTest installs vm.mockCall stubs on getAssetPrice; clear
        // them so we exercise `_primaryPrice` itself.
        vm.clearMockedCalls();

        OracleAdminFacet adminFacet = new OracleAdminFacet();
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        selectors[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        selectors[2] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        selectors[3] = OracleAdminFacet.setWethContract.selector;
        selectors[4] = OracleAdminFacet.setEthUsdFeed.selector;
        selectors[5] = OracleAdminFacet.setUniswapV3Factory.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        // ConfigFacet is already cut by setupHelper() — its T-048
        // setters (setPredominantDenominator + setAssetNumeraireDirectFeedOverride)
        // come along for free via the existing facet selector list in
        // HelperTest. We just need to grant ADMIN_ROLE if not already.

        vm.warp(1_000_000);

        registry = makeAddr("feedRegistry");
        usdDenominator = makeAddr("usdDenominator"); // PAD denom
        eurDenominator = makeAddr("eurDenominator"); // numeraire denom on industrial fork
        ethDenominator = makeAddr("ethDenominator");
        weth = makeAddr("wethContract");

        // Mock asset/USD = $1 (8 decimals). Stable-style.
        feedAssetUsd = new MockChainlinkAggregator(int256(1e8), block.timestamp, 8);
        // Mock ETH/USD = $4000.
        feedEthUsd = new MockChainlinkAggregator(int256(4000e8), block.timestamp, 8);
        // Mock ETH/EUR = EUR 3700 (so USD/EUR ≈ 0.925).
        feedEthEur = new MockChainlinkAggregator(int256(3700e8), block.timestamp, 8);
        // Mock USD/EUR = 0.925 directly.
        feedUsdEur = new MockChainlinkAggregator(int256(925e5), block.timestamp, 8);
        // Mock asset/EUR direct = EUR 0.925 (the override scenario).
        feedAssetEurDirect = new MockChainlinkAggregator(int256(925e5), block.timestamp, 8);

        OracleAdminFacet(address(diamond)).setChainlinkRegistry(registry);
        OracleAdminFacet(address(diamond)).setUsdChainlinkDenominator(usdDenominator);
        OracleAdminFacet(address(diamond)).setEthChainlinkDenominator(ethDenominator);
        OracleAdminFacet(address(diamond)).setEthUsdFeed(address(feedEthUsd));
        OracleAdminFacet(address(diamond)).setWethContract(weth);

        // Route registry.getFeed(asset, USD) → our asset/USD aggregator.
        vm.mockCall(
            registry,
            abi.encodeWithSelector(
                FeedRegistryInterface.getFeed.selector,
                mockERC20,
                usdDenominator
            ),
            abi.encode(address(feedAssetUsd))
        );
    }

    // ─── 1. Retail short-circuit (PAD == numeraire == USD) ────────────────

    function testRetailShortCircuit_PadEqualsNumeraire_UsdOnly() public {
        // Configure PAD = USD, ETH/PAD = ETH/USD. This is the retail
        // industrial-fork-not-active state: setPredominantDenominator
        // is called but PAD == numeraire (both USD) so the FX multiply
        // is short-circuited.
        ConfigFacet(address(diamond)).setPredominantDenominator(
            usdDenominator,
            bytes32("usd"),
            address(feedEthUsd),
            address(0) // padNumeraireRateFeed unset — not needed when PAD==numeraire
        );

        // Asset price reads $1.00 directly via Feed Registry; no FX.
        (uint256 price, uint8 dec) = OracleFacet(address(diamond)).getAssetPrice(
            mockERC20
        );
        assertEq(price, 1e8, "PAD==numeraire: should read $1 directly");
        assertEq(dec, 8);
    }

    // ─── 2. Pre-T-048 deploy (predominantDenominator == 0) ────────────────

    function testPreT048_LegacyPath_StaysActive() public view {
        // No setPredominantDenominator call. The legacy numeraire-direct
        // path stays active: _padPriceWithFallback falls back to
        // numeraireChainlinkDenominator. Behaviour identical to today.
        (uint256 price, uint8 dec) = OracleFacet(address(diamond)).getAssetPrice(
            mockERC20
        );
        assertEq(price, 1e8, "legacy path: USD-quoted via numeraire denom");
        assertEq(dec, 8);
    }

    // ─── 3. Industrial-fork: PAD pivot with direct PAD/numeraire feed ─────

    function testIndustrialFork_PadPivot_DirectFxFeed() public {
        // Configure PAD = USD, numeraire = EUR.
        // numeraireChainlinkDenominator stays USD by default (it was
        // set to usdDenominator above); to make PAD ≠ numeraire we
        // overwrite the storage-side numeraire to EUR via
        // direct-storage-write (TestMutatorFacet would normally do
        // this; we use vm.store via the storage layout).
        // Simpler approach: write storage directly using cheat-code.
        _setNumeraireChainlinkDenominator(eurDenominator);

        // Configure PAD with direct USD/EUR FX feed.
        ConfigFacet(address(diamond)).setPredominantDenominator(
            usdDenominator,
            bytes32("usd"),
            address(feedEthUsd),
            address(feedUsdEur) // direct USD/EUR rate
        );

        // Expected: asset/USD ($1) x USD/EUR (0.925) = EUR 0.925 = 925e5.
        (uint256 price, uint8 dec) = OracleFacet(address(diamond)).getAssetPrice(
            mockERC20
        );
        assertEq(price, 925e5, "PAD pivot direct: asset/USD x USD/EUR");
        assertEq(dec, 8);
    }

    // ─── 4. Industrial-fork: PAD pivot with DERIVED FX rate ───────────────

    function testIndustrialFork_PadPivot_DerivedFxRate() public {
        _setNumeraireChainlinkDenominator(eurDenominator);
        // Set ethNumeraireFeed = ETH/EUR so derivation works.
        OracleAdminFacet(address(diamond)).setEthUsdFeed(address(feedEthEur));
        // (setEthUsdFeed writes ethNumeraireFeed under the hood.)

        // Configure PAD WITHOUT padNumeraireRateFeed — forces
        // derivation: rate = ETH/EUR over ETH/USD = 3700 / 4000 = 0.925.
        ConfigFacet(address(diamond)).setPredominantDenominator(
            usdDenominator,
            bytes32("usd"),
            address(feedEthUsd), // ETH/PAD = ETH/USD
            address(0) // direct feed unset → derive
        );

        // Expected: asset/USD ($1) x derived(USD/EUR ≈ 0.925) ≈ EUR 0.925.
        (uint256 price, uint8 dec) = OracleFacet(address(diamond)).getAssetPrice(
            mockERC20
        );
        // Derivation: rate = (3700e8 * 1e8) / 4000e8 = 925e5.
        // Composed: 1e8 * 925e5 / 1e8 = 925e5.
        assertEq(price, 925e5, "PAD pivot derived: rate from ETH-pivot");
        assertEq(dec, 8);
    }

    // ─── 5. Per-asset override: skip PAD pivot ────────────────────────────

    function testPerAssetOverride_BypassesPadPivot() public {
        _setNumeraireChainlinkDenominator(eurDenominator);

        // PAD configured normally — but the override takes priority.
        ConfigFacet(address(diamond)).setPredominantDenominator(
            usdDenominator,
            bytes32("usd"),
            address(feedEthUsd),
            address(feedUsdEur)
        );

        // Set per-asset override: a hypothetical 🟢-rated asset/EUR
        // direct feed.
        ConfigFacet(address(diamond)).setAssetNumeraireDirectFeedOverride(
            mockERC20,
            address(feedAssetEurDirect)
        );

        // Expected: read the override directly = EUR 0.925 (925e5).
        // No FX multiply, no asset/USD lookup.
        (uint256 price, uint8 dec) = OracleFacet(address(diamond)).getAssetPrice(
            mockERC20
        );
        assertEq(price, 925e5, "override: direct asset/EUR feed");
        assertEq(dec, 8);

        // Clear the override and verify behavior reverts to PAD pivot.
        ConfigFacet(address(diamond)).setAssetNumeraireDirectFeedOverride(
            mockERC20,
            address(0)
        );
        (uint256 price2, ) = OracleFacet(address(diamond)).getAssetPrice(
            mockERC20
        );
        assertEq(price2, 925e5, "override cleared: PAD pivot gives same value");
    }

    // ─── 6. WETH under PAD pivot ──────────────────────────────────────────

    function testWeth_PadPivot_UsesEthPadFeedTimesFx() public {
        _setNumeraireChainlinkDenominator(eurDenominator);
        OracleAdminFacet(address(diamond)).setEthUsdFeed(address(feedEthEur)); // ethNumeraireFeed = ETH/EUR

        ConfigFacet(address(diamond)).setPredominantDenominator(
            usdDenominator,
            bytes32("usd"),
            address(feedEthUsd), // ethPadFeed = ETH/USD
            address(feedUsdEur) // direct USD/EUR rate (avoid derivation noise)
        );

        // Expected: ETH/PAD ($4000) x USD/EUR (0.925) = EUR 3700.
        (uint256 price, uint8 dec) = OracleFacet(address(diamond)).getAssetPrice(
            weth
        );
        // 4000e8 x 925e5 / 1e8 = 4000 x 0.925 x 1e8 = 3700e8.
        assertEq(price, 3700e8, "WETH PAD-pivot: ETH/USD x USD/EUR");
        assertEq(dec, 8);
    }

    // ─── 7. All paths fail: PadNumeraireRateUnavailable ───────────────────

    function testIndustrialFork_NoFxRate_Reverts() public {
        _setNumeraireChainlinkDenominator(eurDenominator);
        // Clear ethNumeraireFeed so neither direct nor derived rate works.
        OracleAdminFacet(address(diamond)).setEthUsdFeed(address(0));

        ConfigFacet(address(diamond)).setPredominantDenominator(
            usdDenominator,
            bytes32("usd"),
            address(feedEthUsd), // ETH/PAD set
            address(0) // direct rate unset → must derive
        );

        // Derivation needs ethNumeraireFeed but it's zero → revert.
        vm.expectRevert(IVaipakamErrors.PadNumeraireRateUnavailable.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockERC20);
    }

    // ─── 8. Setter parameter validation ───────────────────────────────────

    function testSetter_RejectsZeroDenominator() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("predominantDenominator"),
                uint256(0),
                uint256(1),
                type(uint256).max
            )
        );
        ConfigFacet(address(diamond)).setPredominantDenominator(
            address(0),
            bytes32("usd"),
            address(feedEthUsd),
            address(0)
        );
    }

    function testSetter_RejectsZeroEthPadFeed() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("ethPadFeed"),
                uint256(0),
                uint256(1),
                type(uint256).max
            )
        );
        ConfigFacet(address(diamond)).setPredominantDenominator(
            usdDenominator,
            bytes32("usd"),
            address(0),
            address(0)
        );
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    /// @dev Direct storage write of `numeraireChainlinkDenominator` —
    ///      avoids needing TestMutatorFacet wired into this suite.
    ///      Storage layout assumption: the field lives at the offset
    ///      computed from `LibVaipakam.storageSlot()`'s base. We use
    ///      `vm.store` against a sentinel; see test-mocks/SlotPath.
    ///
    ///      Implementation detail: rather than computing the slot
    ///      hash manually, route through the existing setter that
    ///      writes the same field. setUsdChainlinkDenominator writes
    ///      `numeraireChainlinkDenominator` — we exploit that.
    function _setNumeraireChainlinkDenominator(address denom) internal {
        OracleAdminFacet(address(diamond)).setUsdChainlinkDenominator(denom);
        // Re-route the registry mock so asset/EUR queries reach our
        // direct EUR aggregator (used by the override test path).
        vm.mockCall(
            registry,
            abi.encodeWithSelector(
                FeedRegistryInterface.getFeed.selector,
                mockERC20,
                denom
            ),
            abi.encode(address(feedAssetEurDirect))
        );
    }
}
