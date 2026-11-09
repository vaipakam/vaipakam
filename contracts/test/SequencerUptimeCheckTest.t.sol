// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {PriceGuard} from "../src/oracle/PriceGuard.sol";
import {LibTestPriceGuard} from "./helpers/LibTestPriceGuard.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {MockSequencerUptimeFeed} from "./mocks/MockSequencerUptimeFeed.sol";

/// @title SequencerUptimeCheckTest
/// @notice Covers the l2 sequencer uptime circuit breaker
///         the price guard runs and OracleFacet reads (#3272 part 2). Verifies:
///           1. Feed unset  → check is a no-op (correct for l1 deployments)
///           2. Sequencer UP and past the 1h grace window → healthy
///           3. Sequencer DOWN (answer != 0) → getAssetPrice reverts
///              SequencerDown, checkLiquidity returns Illiquid
///           4. Sequencer just recovered (<1h ago) → getAssetPrice reverts
///              SequencerGracePeriod, checkLiquidity returns Illiquid
///           5. `sequencerHealthy()` view agrees with internal decisions
///         Loan-lifecycle integration (triggerLiquidation / triggerDefault
///         reverts) is covered in the liquidation / default test suites by
///         flipping the mock mid-flow.
contract SequencerUptimeCheckTest is SetupTest {
    MockSequencerUptimeFeed internal seqFeed;

    function setUp() public {
        setupHelper();
        // SetupTest installs `vm.mockCall` stubs for OracleFacet.getAssetPrice
        // and checkLiquidity on the shared liquid asset. Those mocks would
        // intercept our calls before the sequencer guard ran. Clear them so
        // the real OracleFacet path executes end-to-end.
        vm.clearMockedCalls();

        // Deploy mock feed with sequencer UP and startedAt well past the
        // grace window so default state is "healthy" for most tests.
        vm.warp(1_000_000);
        seqFeed = new MockSequencerUptimeFeed(
            0, // UP
            block.timestamp - 2 * PriceGuard(LibTestPriceGuard.guardOf(address(diamond))).SEQUENCER_GRACE_PERIOD()
        );
    }

    // ─── l1 path: feed unset ──────────────────────────────────────────────

    function testFeedUnsetTreatsSequencerAsHealthy() public view {
        // SetupTest does not wire the sequencer feed — it starts at zero.
        assertEq(PriceGuard(LibTestPriceGuard.guardOf(address(diamond))).sequencerFeed(), address(0));
        assertTrue(OracleFacet(address(diamond)).sequencerHealthy());
    }

    // ─── Healthy path: feed set, UP, past grace ──────────────────────────

    function testHealthyWhenUpAndPastGrace() public {
        LibTestPriceGuard.setAddress(address(diamond), PriceGuard.Kind.SequencerFeed, address(seqFeed));
        assertTrue(OracleFacet(address(diamond)).sequencerHealthy());
    }

    // ─── Down path ────────────────────────────────────────────────────────

    function testSequencerDownBlocksPriceAndCollapsesLiquidity() public {
        LibTestPriceGuard.setAddress(address(diamond), PriceGuard.Kind.SequencerFeed, address(seqFeed));
        seqFeed.setStatus(1, block.timestamp); // DOWN

        // sequencerHealthy view agrees
        assertFalse(OracleFacet(address(diamond)).sequencerHealthy());

        // getAssetPrice reverts with SequencerDown before any feed read
        vm.expectRevert(OracleFacet.SequencerDown.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockERC20);

        // checkLiquidity fail-closes to Illiquid (non-reverting path)
        assertEq(
            uint256(OracleFacet(address(diamond)).checkLiquidity(mockERC20)),
            uint256(LibVaipakam.LiquidityStatus.Illiquid)
        );
    }

    // ─── Just recovered: inside grace window ──────────────────────────────

    function testSequencerGracePeriodBlocksPriceAndCollapsesLiquidity() public {
        LibTestPriceGuard.setAddress(address(diamond), PriceGuard.Kind.SequencerFeed, address(seqFeed));
        // Flip DOWN then back UP at `now - 30min` — inside the 1h window.
        seqFeed.setStatus(1, block.timestamp - 2 hours);
        seqFeed.setStatus(
            0,
            block.timestamp - (PriceGuard(LibTestPriceGuard.guardOf(address(diamond))).SEQUENCER_GRACE_PERIOD() / 2)
        );

        assertFalse(OracleFacet(address(diamond)).sequencerHealthy());

        vm.expectRevert(OracleFacet.SequencerGracePeriod.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockERC20);

        assertEq(
            uint256(OracleFacet(address(diamond)).checkLiquidity(mockERC20)),
            uint256(LibVaipakam.LiquidityStatus.Illiquid)
        );
    }

    // ─── Grace boundary: exactly SEQUENCER_GRACE_PERIOD seconds since UP ─

    function testSequencerRecoveredPastGraceIsHealthy() public {
        LibTestPriceGuard.setAddress(address(diamond), PriceGuard.Kind.SequencerFeed, address(seqFeed));
        seqFeed.setStatus(1, block.timestamp - 3 hours);
        seqFeed.setStatus(
            0,
            block.timestamp - PriceGuard(LibTestPriceGuard.guardOf(address(diamond))).SEQUENCER_GRACE_PERIOD() - 1
        );
        assertTrue(OracleFacet(address(diamond)).sequencerHealthy());
    }

    // ─── Only the guard's owner may propose the feed ─────────────────────

    function testSequencerFeedChangeRevertsForNonOwner() public {
        address attacker = makeAddr("attacker");
        PriceGuard guard = PriceGuard(LibTestPriceGuard.guardOf(address(diamond)));
        vm.prank(attacker);
        vm.expectRevert();
        guard.proposeChange(PriceGuard.Kind.SequencerFeed, bytes32(0), bytes32(uint256(uint160(address(seqFeed)))));
    }

    // ─── Round-trip: the guard holds the feed the Diamond reads ──────────

    function testSequencerFeedRoundTrip() public {
        PriceGuard guard = PriceGuard(LibTestPriceGuard.guardOf(address(diamond)));
        LibTestPriceGuard.setAddress(address(diamond), PriceGuard.Kind.SequencerFeed, address(seqFeed));
        assertEq(guard.sequencerFeed(), address(seqFeed));
        // Unset by writing zero.
        LibTestPriceGuard.setAddress(address(diamond), PriceGuard.Kind.SequencerFeed, address(0));
        assertEq(guard.sequencerFeed(), address(0));
        assertTrue(OracleFacet(address(diamond)).sequencerHealthy());
    }
}
