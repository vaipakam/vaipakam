// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {MockSequencerUptimeFeed} from "./mocks/MockSequencerUptimeFeed.sol";

/// @title SequencerUptimeCheckTest
/// @notice Covers the l2 sequencer uptime circuit breaker
///         wired in OracleFacet. Verifies:
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

        // #229 — OracleAdminFacet is now cut by `SetupTest.setupHelper()`
        // (all 34 selectors, mirroring DeployDiamond), including the
        // setSequencerUptimeFeed setter this test exercises. The prior
        // local 8-selector subset cut would double-cut and revert.
        // Dropped.

        // Deploy mock feed with sequencer UP and startedAt well past the
        // grace window so default state is "healthy" for most tests.
        vm.warp(1_000_000);
        seqFeed = new MockSequencerUptimeFeed(
            0, // UP
            block.timestamp - 2 * LibVaipakam.SEQUENCER_GRACE_PERIOD
        );
    }

    // ─── l1 path: feed unset ──────────────────────────────────────────────

    function testFeedUnsetTreatsSequencerAsHealthy() public view {
        // SetupTest does not wire the sequencer feed — it starts at zero.
        assertEq(
            OracleFacet(address(diamond)).getSequencerUptimeFeed(),
            address(0)
        );
        assertTrue(OracleFacet(address(diamond)).sequencerHealthy());
    }

    // ─── Healthy path: feed set, UP, past grace ──────────────────────────

    function testHealthyWhenUpAndPastGrace() public {
        OracleAdminFacet(address(diamond)).setSequencerUptimeFeed(address(seqFeed));
        assertTrue(OracleFacet(address(diamond)).sequencerHealthy());
    }

    // ─── Down path ────────────────────────────────────────────────────────

    function testSequencerDownBlocksPriceAndCollapsesLiquidity() public {
        OracleAdminFacet(address(diamond)).setSequencerUptimeFeed(address(seqFeed));
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
        OracleAdminFacet(address(diamond)).setSequencerUptimeFeed(address(seqFeed));
        // Flip DOWN then back UP at `now - 30min` — inside the 1h window.
        seqFeed.setStatus(1, block.timestamp - 2 hours);
        seqFeed.setStatus(
            0,
            block.timestamp - (LibVaipakam.SEQUENCER_GRACE_PERIOD / 2)
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
        OracleAdminFacet(address(diamond)).setSequencerUptimeFeed(address(seqFeed));
        seqFeed.setStatus(1, block.timestamp - 3 hours);
        seqFeed.setStatus(
            0,
            block.timestamp - LibVaipakam.SEQUENCER_GRACE_PERIOD - 1
        );
        assertTrue(OracleFacet(address(diamond)).sequencerHealthy());
    }

    // ─── Owner-only guard on the setter ──────────────────────────────────

    function testSetSequencerUptimeFeedRevertsForNonOwner() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert();
        OracleAdminFacet(address(diamond)).setSequencerUptimeFeed(address(seqFeed));
    }

    // ─── Round-trip: owner writes → getter reads the same address ────────

    function testSetSequencerUptimeFeedRoundTrip() public {
        OracleAdminFacet(address(diamond)).setSequencerUptimeFeed(address(seqFeed));
        assertEq(
            OracleFacet(address(diamond)).getSequencerUptimeFeed(),
            address(seqFeed)
        );
        // Unset by writing zero.
        OracleAdminFacet(address(diamond)).setSequencerUptimeFeed(address(0));
        assertEq(
            OracleFacet(address(diamond)).getSequencerUptimeFeed(),
            address(0)
        );
    }
}
