// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {FeedRegistryInterface} from "@chainlink/contracts/src/v0.8/interfaces/FeedRegistryInterface.sol";
import {MockChainlinkAggregator} from "./mocks/MockChainlinkAggregator.sol";

/// @title StalenessHybridTest
/// @notice Covers the stablecoin-aware staleness hybrid in
///         OracleFacet.getAssetPrice:
///           - age <= ORACLE_VOLATILE_STALENESS              → accept
///           - age <= ORACLE_STABLE_STALENESS AND feed
///             reports ~ $1 (within ORACLE_PEG_TOLERANCE_BPS)
///             AND decimals == 8                             → accept
///           - age >  ORACLE_STABLE_STALENESS                → revert
///           - age in stable window but off-peg              → revert
///           - age in stable window but decimals != 8        → revert
contract StalenessHybridTest is SetupTest {
    MockChainlinkAggregator internal feed;
    address internal registry;
    address internal usdDenominator;
    address internal asset;

    function setUp() public {
        setupHelper();
        // SetupTest installs a vm.mockCall for getAssetPrice(mockERC20);
        // clear everything so we exercise the real OracleFacet path.
        vm.clearMockedCalls();

        OracleAdminFacet adminFacet = new OracleAdminFacet();
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        selectors[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        selectors[2] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        selectors[3] = OracleAdminFacet.setWethContract.selector;
        selectors[4] = OracleAdminFacet.setEthUsdFeed.selector;
        selectors[5] = OracleAdminFacet.setUniswapV3Factory.selector;
        selectors[6] = OracleAdminFacet.setStableTokenFeed.selector;
        selectors[7] = OracleAdminFacet.setSequencerUptimeFeed.selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        vm.warp(1_000_000);

        asset = mockERC20;
        registry = makeAddr("feedRegistry");
        usdDenominator = makeAddr("usdDenominator");

        // 8-decimal stablecoin-style feed, fresh.
        feed = new MockChainlinkAggregator(int256(1e8), block.timestamp, 8);

        OracleAdminFacet(address(diamond)).setChainlinkRegistry(registry);
        OracleAdminFacet(address(diamond)).setUsdChainlinkDenominator(usdDenominator);

        // Route every registry.getFeed(asset, usd) to our scriptable aggregator.
        vm.mockCall(
            registry,
            abi.encodeWithSelector(FeedRegistryInterface.getFeed.selector, asset, usdDenominator),
            abi.encode(address(feed))
        );
    }

    // ─── Fresh price: always accept ──────────────────────────────────────

    function testFreshPriceAccepted() public view {
        (uint256 price, uint8 dec) = OracleFacet(address(diamond)).getAssetPrice(asset);
        assertEq(price, 1e8);
        assertEq(dec, 8);
    }

    function testJustUnderVolatileWindowAccepted() public {
        // 1 second inside the volatile window.
        feed.setRound(int256(1e8), block.timestamp - (LibVaipakam.ORACLE_VOLATILE_STALENESS - 1));
        (uint256 price, ) = OracleFacet(address(diamond)).getAssetPrice(asset);
        assertEq(price, 1e8);
    }

    // ─── Stable window + on-peg: accept up to 25h ────────────────────────

    function testStalePegPriceAcceptedUpToStableWindow() public {
        // 10h stale at exactly $1 — well within the stable window.
        feed.setRound(int256(1e8), block.timestamp - 10 hours);
        (uint256 price, ) = OracleFacet(address(diamond)).getAssetPrice(asset);
        assertEq(price, 1e8);
    }

    function testStalePegPriceJustBelowStableWindow() public {
        // 1s inside the stable window.
        feed.setRound(int256(1e8), block.timestamp - (LibVaipakam.ORACLE_STABLE_STALENESS - 1));
        (uint256 price, ) = OracleFacet(address(diamond)).getAssetPrice(asset);
        assertEq(price, 1e8);
    }

    function testStablePriceWithinPegToleranceAccepted() public {
        // 6h stale, price at $1.025 (2.5% above peg — inside the 3% tolerance).
        feed.setRound(int256(1e8 + (1e8 * 250) / 10_000), block.timestamp - 6 hours);
        (uint256 price, ) = OracleFacet(address(diamond)).getAssetPrice(asset);
        assertEq(price, 1e8 + (1e8 * 250) / 10_000);
    }

    // ─── Stable window but off-peg: reject ───────────────────────────────

    function testStaleOffPegRejected() public {
        // 6h stale, price at $0.94 (6% below peg — outside 3% tolerance).
        feed.setRound(int256((1e8 * 9_400) / 10_000), block.timestamp - 6 hours);
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    function testStaleSlightlyOffPegRejected() public {
        // 3h stale, 3.01% above peg — just over the tolerance.
        int256 offPegAnswer = int256(1e8 + (1e8 * 301) / 10_000);
        feed.setRound(offPegAnswer, block.timestamp - 3 hours);
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    // ─── Past stable window: reject regardless of price ──────────────────

    function testBeyondStableWindowRejectedEvenAtPeg() public {
        // 1s past the stable ceiling with a perfect $1 reading — still stale.
        feed.setRound(int256(1e8), block.timestamp - (LibVaipakam.ORACLE_STABLE_STALENESS + 1));
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    // ─── Non-8-decimal feed: no peg check, strict 2h window ──────────────

    function testNon8DecimalFeedNoPegGrace() public {
        // Deploy a fresh feed with 18 decimals (asset/ETH-style denomination).
        MockChainlinkAggregator nonUsdFeed = new MockChainlinkAggregator(
            int256(1e18), // nominally "1 ETH per unit", not $1
            block.timestamp - 3 hours,
            18
        );
        vm.mockCall(
            registry,
            abi.encodeWithSelector(FeedRegistryInterface.getFeed.selector, asset, usdDenominator),
            abi.encode(address(nonUsdFeed))
        );
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    function testNon8DecimalFeedFreshAccepted() public {
        // Same non-USD feed but fresh — must still be accepted on the
        // volatile fast-path (no peg check fires).
        MockChainlinkAggregator nonUsdFeed = new MockChainlinkAggregator(
            int256(1e18),
            block.timestamp,
            18
        );
        vm.mockCall(
            registry,
            abi.encodeWithSelector(FeedRegistryInterface.getFeed.selector, asset, usdDenominator),
            abi.encode(address(nonUsdFeed))
        );
        (uint256 price, uint8 dec) = OracleFacet(address(diamond)).getAssetPrice(asset);
        assertEq(price, 1e18);
        assertEq(dec, 18);
    }

    // ─── Future-dated updatedAt: treat as stale (defensive check) ────────

    function testFutureUpdatedAtRejected() public {
        feed.setRound(int256(1e8), block.timestamp + 1);
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    // ─── Zero / negative answer rejected regardless of age ───────────────

    function testZeroAnswerRejected() public {
        feed.setRound(0, block.timestamp);
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    function testNegativeAnswerRejected() public {
        feed.setRound(-1, block.timestamp);
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }
}
