// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {SetupComposable} from "./composable/SetupComposable.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {FeedRegistryInterface} from "@vaipakam-vendor/chainlink/FeedRegistryInterface.sol";
import {MockChainlinkAggregator} from "./mocks/MockChainlinkAggregator.sol";

/**
 * @title FeedOverrideTest
 * @notice Phase 3.1 hardening: per-feed `maxStaleness` override +
 *         `minValidAnswer` floor. Verifies that:
 *           - Only the owner can install or clear an override.
 *           - A tighter override rejects a price that would pass the
 *             global two-tier defaults.
 *           - A looser override accepts a price that the global
 *             volatile ceiling (2h) would reject.
 *           - A `minValidAnswer` floor rejects a below-floor reading
 *             regardless of staleness.
 *           - Clearing the override (maxStaleness=0) restores the
 *             global fallback behaviour.
 */
contract FeedOverrideTest is Test {

    // ── Stage 6 composition migration (2026-05-27) ──────────────────────
    // Inherit only forge-std `Test`; the Diamond + facet routing + state
    // are owned by a `SetupComposable` instance the test composes via
    // `setUp`. Common SetupTest fields are mirrored locally below so the
    // bulk of test-body code keeps compiling unchanged.
    SetupComposable internal helpers;
    VaipakamDiamond internal diamond;
    address internal owner;
    address internal lender;
    address internal borrower;
    address internal mockERC20;
    address internal mockCollateralERC20;
    address internal mockIlliquidERC20;
    address internal mockNft721;
    address internal mockZeroExProxy;
    uint256 internal constant BASIS_POINTS = 10_000;
    uint256 internal constant KYC_THRESHOLD_USD = 2000 * 1e18;
    uint256 internal constant RENTAL_BUFFER_BPS = 500;
    uint256 internal constant MIN_HEALTH_FACTOR = 150 * 1e16;
    MockChainlinkAggregator internal feed;
    address internal registry;
    address internal usdDenominator;
    address internal asset;
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        helpers = new SetupComposable();
        helpers.bootstrap(address(this));
        diamond = helpers.diamond();
        owner = helpers.owner();
        lender = helpers.lender();
        borrower = helpers.borrower();
        mockERC20 = helpers.mockERC20();
        mockCollateralERC20 = helpers.mockCollateralERC20();
        mockIlliquidERC20 = helpers.mockIlliquidERC20();
        mockNft721 = helpers.mockNft721();
        mockZeroExProxy = helpers.mockZeroExProxy();
        // SetupTest installs vm.mockCall for getAssetPrice(mockERC20) — clear
        // so we exercise the real OracleFacet + feed-override code path.
        vm.clearMockedCalls();

        // #229 — OracleAdminFacet is now cut by `SetupTest.setupHelper()`
        // (all 34 selectors, mirroring DeployDiamond). The prior local
        // subset cut here would double-cut and revert. Dropped.

        vm.warp(1_000_000);

        asset = mockERC20;
        registry = makeAddr("feedRegistry");
        usdDenominator = makeAddr("usdDenominator");

        // Fresh 8-decimal feed returning $1000 at the current block time.
        feed = new MockChainlinkAggregator(int256(1000e8), block.timestamp, 8);

        OracleAdminFacet(address(diamond)).setChainlinkRegistry(registry);
        OracleAdminFacet(address(diamond)).setUsdChainlinkDenominator(
            usdDenominator
        );

        // Route every registry.getFeed(asset, usd) to our scriptable aggregator.
        vm.mockCall(
            registry,
            abi.encodeWithSelector(
                FeedRegistryInterface.getFeed.selector,
                asset,
                usdDenominator
            ),
            abi.encode(address(feed))
        );
    }

    // ─── Admin gating ───────────────────────────────────────────────────────

    function test_setFeedOverride_OnlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        OracleAdminFacet(address(diamond)).setFeedOverride(
            address(feed),
            30 minutes,
            0
        );
    }

    function test_setFeedOverride_RevertsOnZeroFeed() public {
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        OracleAdminFacet(address(diamond)).setFeedOverride(
            address(0),
            30 minutes,
            0
        );
    }

    // ─── Storage roundtrip ──────────────────────────────────────────────────

    function test_setFeedOverride_StoresAndReads() public {
        OracleAdminFacet(address(diamond)).setFeedOverride(
            address(feed),
            30 minutes,
            1e8
        );
        (uint40 s, int256 m) = OracleAdminFacet(address(diamond))
            .getFeedOverride(address(feed));
        assertEq(s, 30 minutes);
        assertEq(m, 1e8);
    }

    function test_setFeedOverride_ClearOnMaxStalenessZero() public {
        // Install first.
        OracleAdminFacet(address(diamond)).setFeedOverride(
            address(feed),
            30 minutes,
            1e8
        );

        // Clear — both fields reset regardless of the passed minValidAnswer.
        OracleAdminFacet(address(diamond)).setFeedOverride(
            address(feed),
            0,
            99e8
        );
        (uint40 s, int256 m) = OracleAdminFacet(address(diamond))
            .getFeedOverride(address(feed));
        assertEq(s, 0);
        assertEq(m, 0);
    }

    // ─── Runtime effect on getAssetPrice ────────────────────────────────────

    /// @dev Tightening override rejects a price that the 2h global
    ///      volatile ceiling would accept.
    function test_TighterStaleness_RejectsOtherwiseFreshPrice() public {
        // Feed reports a price 90 minutes old. Under the 2h global
        // volatile ceiling, this would pass. Under a 30-minute override,
        // it must revert.
        feed.setRound(int256(1000e8), block.timestamp - 90 minutes);

        // Baseline: global rule accepts.
        (uint256 priceBefore, ) = OracleFacet(address(diamond))
            .getAssetPrice(asset);
        assertEq(priceBefore, 1000e8);

        OracleAdminFacet(address(diamond)).setFeedOverride(
            address(feed),
            30 minutes,
            0
        );

        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    /// @dev Loosening override accepts a price that the 2h global
    ///      volatile ceiling would reject. Useful for feeds with
    ///      legitimately slow heartbeats (fiat, commodity) where the
    ///      operator is confident a longer staleness is safe.
    function test_LooserStaleness_AcceptsOtherwiseStalePrice() public {
        // Feed reports a price 4 hours old — well past the 2h global
        // volatile ceiling. A non-peg-aligned price ($1000) would fail
        // the stable-peg relaxation too. A 6-hour override should accept.
        feed.setRound(int256(1000e8), block.timestamp - 4 hours);

        // Baseline: global rule rejects as stale (no peg tolerance for
        // an off-$1 asset price).
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);

        OracleAdminFacet(address(diamond)).setFeedOverride(
            address(feed),
            6 hours,
            0
        );

        (uint256 price, ) = OracleFacet(address(diamond))
            .getAssetPrice(asset);
        assertEq(price, 1000e8);
    }

    /// @dev Min-valid-answer floor rejects a below-floor reading even
    ///      when the feed is fresh. Defends against incident-era
    ///      near-zero returns that would otherwise look legitimate.
    function test_MinValidAnswer_RejectsBelowFloor() public {
        // Fresh feed but collapsed price ($0.01 when floor is $500).
        feed.setRound(int256(1e6), block.timestamp - 5 minutes);

        OracleAdminFacet(address(diamond)).setFeedOverride(
            address(feed),
            30 minutes,
            500e8 // $500 floor
        );

        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    /// @dev Min-valid-answer floor accepts when the answer is at or
    ///      above the floor.
    function test_MinValidAnswer_AcceptsAtFloor() public {
        feed.setRound(int256(500e8), block.timestamp - 5 minutes);

        OracleAdminFacet(address(diamond)).setFeedOverride(
            address(feed),
            30 minutes,
            500e8
        );

        (uint256 price, ) = OracleFacet(address(diamond))
            .getAssetPrice(asset);
        assertEq(price, 500e8);
    }

    /// @dev Clearing the override restores the global two-tier behaviour.
    function test_Cleared_FallsBackToGlobalBehaviour() public {
        feed.setRound(int256(1000e8), block.timestamp - 90 minutes);

        // Install tightened override → reverts.
        OracleAdminFacet(address(diamond)).setFeedOverride(
            address(feed),
            30 minutes,
            0
        );
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);

        // Clear — 90-minute-old price now passes the 2h global ceiling.
        OracleAdminFacet(address(diamond)).setFeedOverride(
            address(feed),
            0,
            0
        );
        (uint256 price, ) = OracleFacet(address(diamond))
            .getAssetPrice(asset);
        assertEq(price, 1000e8);
    }
}
