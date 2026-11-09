// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {PriceGuard} from "../src/oracle/PriceGuard.sol";
import {LibTestPriceGuard} from "./helpers/LibTestPriceGuard.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {FeedRegistryInterface} from "@vaipakam-vendor/chainlink/FeedRegistryInterface.sol";
import {MockChainlinkAggregator} from "./mocks/MockChainlinkAggregator.sol";

/**
 * @title FeedOverrideTest
 * @notice Phase 3.1 hardening: per-feed `maxStaleness` override +
 *         `minValidAnswer` floor, held by the price guard since #3272 part 2
 *         (its owner-only, delayed change is the guard suite's). Verifies that:
 *           - A tighter override rejects a price that would pass the
 *             global two-tier defaults.
 *           - An override never loosens: a longer budget leaves the
 *             global two-tier defaults in force (#2742), and a budget
 *             above the outer 25h default is refused.
 *           - A `minValidAnswer` floor rejects a below-floor reading
 *             regardless of staleness.
 *           - Clearing the override (maxStaleness=0) restores the
 *             global fallback behaviour.
 */
contract FeedOverrideTest is SetupTest {
    MockChainlinkAggregator internal feed;
    address internal registry;
    address internal usdDenominator;
    address internal asset;
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        setupHelper();
        // SetupTest installs vm.mockCall for getAssetPrice(mockERC20) — clear
        // so we exercise the real OracleFacet + feed-override code path.
        vm.clearMockedCalls();

        vm.warp(1_000_000);

        asset = mockERC20;
        registry = makeAddr("feedRegistry");
        // #3272 part 2 - the guard keys feeds by its fixed USD denominator.
        usdDenominator = LibTestPriceGuard.USD;

        // Fresh 8-decimal feed returning $1000 at the current block time.
        feed = new MockChainlinkAggregator(int256(1000e8), block.timestamp, 8);

        LibTestPriceGuard.setAddress(address(diamond), PriceGuard.Kind.FeedRegistry, registry);

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



    // ─── Storage roundtrip ──────────────────────────────────────────────────



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

        LibTestPriceGuard.setFeedOverride(address(diamond), address(feed),
            30 minutes,
            0);

        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    /// @dev #2742 — an override can never loosen a feed. A 6h budget on a
    ///      volatile feed leaves the 2h default in force, so a 4h-old,
    ///      off-peg price is still refused. (Before #2742 this test asserted
    ///      the opposite: the override replaced the defaults.)
    function test_LongerStaleness_DoesNotLoosenTheDefault() public {
        feed.setRound(int256(1000e8), block.timestamp - 4 hours);

        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);

        LibTestPriceGuard.setFeedOverride(address(diamond), address(feed),
            6 hours,
            0);

        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);
    }

    /// @dev #2742 — a budget above the outer default (25h) could never bind,
    ///      so the guard refuses it rather than store what reads as a
    ///      loosening. Exactly 25h is accepted.
    function test_FeedOverride_RefusesBudgetAboveOuterDefault() public {
        PriceGuard guard = PriceGuard(LibTestPriceGuard.guardOf(address(diamond)));
        bytes32 subject = bytes32(uint256(uint160(address(feed))));
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceGuard.InvalidChange.selector,
                PriceGuard.Kind.FeedMaxStaleness,
                subject,
                bytes32(uint256(25 hours + 1))
            )
        );
        guard.proposeChange(PriceGuard.Kind.FeedMaxStaleness, subject, bytes32(uint256(25 hours + 1)));

        LibTestPriceGuard.setFeedOverride(address(diamond), address(feed), 25 hours, 0);
        assertEq(guard.feedMaxStaleness(address(feed)), 25 hours, "25h stored");
    }

    /// @dev Min-valid-answer floor rejects a below-floor reading even
    ///      when the feed is fresh. Defends against incident-era
    ///      near-zero returns that would otherwise look legitimate.
    function test_MinValidAnswer_RejectsBelowFloor() public {
        // Fresh feed but collapsed price ($0.01 when floor is $500).
        feed.setRound(int256(1e6), block.timestamp - 5 minutes);

        LibTestPriceGuard.setFeedOverride(address(diamond), address(feed),
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

        LibTestPriceGuard.setFeedOverride(address(diamond), address(feed),
            30 minutes,
            500e8);

        (uint256 price, ) = OracleFacet(address(diamond))
            .getAssetPrice(asset);
        assertEq(price, 500e8);
    }

    /// @dev Clearing the override restores the global two-tier behaviour.
    function test_Cleared_FallsBackToGlobalBehaviour() public {
        feed.setRound(int256(1000e8), block.timestamp - 90 minutes);

        // Install tightened override → reverts.
        LibTestPriceGuard.setFeedOverride(address(diamond), address(feed),
            30 minutes,
            0);
        vm.expectRevert(OracleFacet.StalePriceData.selector);
        OracleFacet(address(diamond)).getAssetPrice(asset);

        // Clear — 90-minute-old price now passes the 2h global ceiling.
        LibTestPriceGuard.setFeedOverride(address(diamond), address(feed),
            0,
            0);
        (uint256 price, ) = OracleFacet(address(diamond))
            .getAssetPrice(asset);
        assertEq(price, 1000e8);
    }
}
