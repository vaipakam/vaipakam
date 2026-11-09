// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {PriceGuard} from "../src/oracle/PriceGuard.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";
import {FeedRegistryInterface} from "@vaipakam-vendor/chainlink/FeedRegistryInterface.sol";
import {MockChainlinkAggregator} from "./mocks/MockChainlinkAggregator.sol";
import {LibTestPriceGuard} from "./helpers/LibTestPriceGuard.sol";

/// @title  PriceGuardPadPivotTest
/// @notice T-048, moved onto the price guard by #3272 part 2. The
///         Predominantly Available Denominator (PAD) pivot routes every
///         priced asset through the widely covered USD feed set when the
///         numeraire is not USD, so a sparse asset/<numeraire> feed is never
///         the only source.
///
///         The PAD is part of the guard's numeraire identity, fixed when the
///         guard is built, so each scenario builds its own guard:
///           1. Retail: PAD is the numeraire → one asset/PAD read, no FX.
///           2. Industrial, direct PAD/<numeraire> feed: the USD price times
///              the USD/EUR rate.
///           3. Industrial, derived rate: PAD/<numeraire> is ETH/<numeraire>
///              over ETH/PAD.
///           4. A per-asset direct asset/<numeraire> feed skips the pivot,
///              and removing it returns the asset to the pivot.
///           5. WETH under the pivot: ETH/PAD times the rate.
///           6. No rate reachable: the read refuses
///              {PadNumeraireRateUnavailable}.
///         The Diamond reads every price from its guard (OracleFacet
///         forwards), so these are the Diamond's prices too; the forwarding
///         itself is covered in OracleAdminFacetTest.
contract PriceGuardPadPivotTest is Test {
    address internal registry;
    address internal usdDenominator; // the PAD (the USD feed set)
    address internal eurDenominator; // the industrial numeraire
    address internal ethDenominator;
    address internal weth;
    address internal asset;

    MockChainlinkAggregator internal feedAssetUsd; //       asset/USD  = $1
    MockChainlinkAggregator internal feedEthUsd; //         ETH/USD    = $4000
    MockChainlinkAggregator internal feedEthEur; //         ETH/EUR    = EUR 3700
    MockChainlinkAggregator internal feedUsdEur; //         USD/EUR    = 0.925
    MockChainlinkAggregator internal feedAssetEurDirect; // asset/EUR  = EUR 0.925

    function setUp() public {
        vm.warp(1_000_000);
        registry = makeAddr("feedRegistry");
        usdDenominator = makeAddr("usdDenominator");
        eurDenominator = makeAddr("eurDenominator");
        ethDenominator = makeAddr("ethDenominator");
        weth = makeAddr("weth");
        asset = makeAddr("asset");

        feedAssetUsd = new MockChainlinkAggregator(int256(1e8), block.timestamp, 8);
        feedEthUsd = new MockChainlinkAggregator(int256(4000e8), block.timestamp, 8);
        feedEthEur = new MockChainlinkAggregator(int256(3700e8), block.timestamp, 8);
        feedUsdEur = new MockChainlinkAggregator(int256(925e5), block.timestamp, 8);
        feedAssetEurDirect = new MockChainlinkAggregator(int256(925e5), block.timestamp, 8);

        // The registry answers asset/USD with the $1 feed.
        vm.mockCall(
            registry,
            abi.encodeWithSelector(FeedRegistryInterface.getFeed.selector, asset, usdDenominator),
            abi.encode(address(feedAssetUsd))
        );
    }

    // ─── 1. Retail ───────────────────────────────────────────────────────

    function test_Retail_PadIsTheNumeraire_ReadsTheFeedDirectly() public {
        PriceGuard g = _guard(usdDenominator, "usd", address(0));
        assertTrue(g.padIsNumeraire());
        LibTestPriceGuard.setAddressOn(g, PriceGuard.Kind.EthNumeraireFeed, address(feedEthUsd));

        (uint256 price, uint8 dec) = g.getAssetPrice(asset);
        assertEq(price, 1e8, "PAD is the numeraire: $1 read directly");
        assertEq(dec, 8);
    }

    // ─── 2. Industrial, direct rate feed ─────────────────────────────────

    function test_Industrial_DirectRateFeed_MultipliesThePadPrice() public {
        PriceGuard g = _guard(eurDenominator, "eur", usdDenominator);
        assertFalse(g.padIsNumeraire());
        LibTestPriceGuard.setAddressOn(g, PriceGuard.Kind.PadNumeraireRateFeed, address(feedUsdEur));

        (uint256 price, uint8 dec) = g.getAssetPrice(asset);
        assertEq(price, 925e5, "asset/USD x USD/EUR");
        assertEq(dec, 8);
    }

    // ─── 3. Industrial, derived rate ─────────────────────────────────────

    function test_Industrial_DerivedRate_ComesFromTheEthPivot() public {
        PriceGuard g = _guard(eurDenominator, "eur", usdDenominator);
        LibTestPriceGuard.setAddressOn(g, PriceGuard.Kind.EthNumeraireFeed, address(feedEthEur));
        LibTestPriceGuard.setAddressOn(g, PriceGuard.Kind.EthPadFeed, address(feedEthUsd));

        (uint256 price, uint8 dec) = g.getAssetPrice(asset);
        assertEq(price, 925e5, "USD/EUR = (ETH/EUR) / (ETH/USD) = 0.925");
        assertEq(dec, 8);
    }

    // ─── 4. Per-asset direct feed ────────────────────────────────────────

    function test_Industrial_AssetDirectFeed_SkipsThePivotUntilRemoved() public {
        PriceGuard g = _guard(eurDenominator, "eur", usdDenominator);
        LibTestPriceGuard.setAddressOn(g, PriceGuard.Kind.PadNumeraireRateFeed, address(feedUsdEur));
        // The direct feed reads EUR 0.80, so a pivot read (0.925) would show.
        feedAssetEurDirect.setRound(int256(80e6), block.timestamp);
        LibTestPriceGuard.setOn(
            g,
            PriceGuard.Kind.AssetDirectFeed,
            bytes32(uint256(uint160(asset))),
            bytes32(uint256(uint160(address(feedAssetEurDirect))))
        );

        (uint256 price, uint8 dec) = g.getAssetPrice(asset);
        assertEq(price, 80e6, "the direct asset/EUR feed is read");
        assertEq(dec, 8);

        LibTestPriceGuard.setOn(g, PriceGuard.Kind.AssetDirectFeed, bytes32(uint256(uint160(asset))), bytes32(0));
        (uint256 pivot,) = g.getAssetPrice(asset);
        assertEq(pivot, 925e5, "removed: the asset is back on the pivot");
    }

    // ─── 5. WETH under the pivot ─────────────────────────────────────────

    function test_Industrial_Weth_IsEthPadTimesTheRate() public {
        PriceGuard g = _guard(eurDenominator, "eur", usdDenominator);
        LibTestPriceGuard.setAddressOn(g, PriceGuard.Kind.Weth, weth);
        LibTestPriceGuard.setAddressOn(g, PriceGuard.Kind.EthPadFeed, address(feedEthUsd));
        LibTestPriceGuard.setAddressOn(g, PriceGuard.Kind.PadNumeraireRateFeed, address(feedUsdEur));

        (uint256 price, uint8 dec) = g.getAssetPrice(weth);
        assertEq(price, 3700e8, "ETH/USD x USD/EUR");
        assertEq(dec, 8);
    }

    // ─── 6. No rate ──────────────────────────────────────────────────────

    function test_Industrial_NoRateReachable_Refuses() public {
        PriceGuard g = _guard(eurDenominator, "eur", usdDenominator);
        // An ETH/PAD feed alone does not make a rate: ETH/<numeraire> is unset.
        LibTestPriceGuard.setAddressOn(g, PriceGuard.Kind.EthPadFeed, address(feedEthUsd));

        vm.expectRevert(IPriceGuard.PadNumeraireRateUnavailable.selector);
        g.getAssetPrice(asset);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    /// @dev A guard owned by this suite, in the given identity, pointed at
    ///      the mocked registry.
    function _guard(address numeraire, bytes32 symbol, address pad) internal returns (PriceGuard g) {
        g = LibTestPriceGuard.deployGuard(
            address(this),
            PriceGuard.Identity({
                numeraireDenominator: numeraire,
                numeraireSymbol: symbol,
                padDenominator: pad,
                ethDenominator: ethDenominator
            })
        );
        LibTestPriceGuard.setAddressOn(g, PriceGuard.Kind.FeedRegistry, registry);
    }
}
