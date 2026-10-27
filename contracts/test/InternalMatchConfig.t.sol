// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @title InternalMatchConfig.t.sol
 * @notice PR3 of the internal-match scaffold work
 *         (`docs/DesignsAndPlans/InternalLiquidationLedger.md`).
 *         Covers the config surface and its range bounds:
 *           - default kill-switch state (`false`),
 *           - default values for the priority window + bot incentive,
 *           - boundary acceptance (at the cap) for both tunables,
 *           - revert paths above each cap,
 *           - kill-switch effect on the `getMatchEligibleLoans` view.
 *         The matching execution body lands in PR4+; this suite is
 *         purely about the governance / view surface.
 *
 *         Inherits from `SetupTest` so the diamond comes pre-wired
 *         with `ConfigFacet`, `MetricsFacet`, and the per-tier
 *         liquidation pin from setUp (8500 across all tiers).
 */
contract InternalMatchConfigTest is SetupTest {
    function setUp() public {
        setupHelper();
    }

    function test_defaultStateIsDisabled() public view {
        (bool enabled, uint256 window, uint256 incentive) =
            ConfigFacet(address(diamond)).getInternalMatchConfigBundle();
        assertFalse(enabled, "kill-switch defaults to false");
        // Disabled state returns the EFFECTIVE values (overrides OR
        // library defaults) so the frontend can still surface what
        // would apply once the flag flips.
        assertEq(window, uint256(LibVaipakam.DEFAULT_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS));
        assertEq(incentive, uint256(LibVaipakam.DEFAULT_INTERNAL_MATCH_INCENTIVE_BPS_PER_LEG));
    }

    function test_setInternalMatchEnabled_flipsFlag() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);
        (bool enabled, , ) = ConfigFacet(address(diamond)).getInternalMatchConfigBundle();
        assertTrue(enabled, "flag should be true after setter");

        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(false);
        (enabled, , ) = ConfigFacet(address(diamond)).getInternalMatchConfigBundle();
        assertFalse(enabled, "flag flips back to false");
    }

    function test_setInternalMatchConfig_zeroResolvesToDefault() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchConfig(0, 0);
        (, uint256 window, uint256 incentive) =
            ConfigFacet(address(diamond)).getInternalMatchConfigBundle();
        // Both fields stored as 0, getter resolves to library defaults.
        assertEq(window, uint256(LibVaipakam.DEFAULT_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS));
        assertEq(incentive, uint256(LibVaipakam.DEFAULT_INTERNAL_MATCH_INCENTIVE_BPS_PER_LEG));
    }

    function test_setInternalMatchConfig_acceptsBoundary() public {
        // At-cap values must be accepted (≤ cap, not strict <).
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchConfig(
            LibVaipakam.MAX_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS,
            LibVaipakam.MAX_INTERNAL_MATCH_INCENTIVE_BPS_PER_LEG
        );
        (, uint256 window, uint256 incentive) =
            ConfigFacet(address(diamond)).getInternalMatchConfigBundle();
        assertEq(window, uint256(LibVaipakam.MAX_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS));
        assertEq(incentive, uint256(LibVaipakam.MAX_INTERNAL_MATCH_INCENTIVE_BPS_PER_LEG));
    }

    function test_setInternalMatchConfig_revertsWindowAboveCap() public {
        uint16 over = LibVaipakam.MAX_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS + 1;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InternalMatchWindowAboveCap.selector,
                uint256(over),
                uint256(LibVaipakam.MAX_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS)
            )
        );
        ConfigFacet(address(diamond)).setInternalMatchConfig(over, 100);
    }

    function test_setInternalMatchConfig_revertsIncentiveAboveCap() public {
        uint16 over = LibVaipakam.MAX_INTERNAL_MATCH_INCENTIVE_BPS_PER_LEG + 1;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InternalMatchIncentiveAboveCap.selector,
                uint256(over),
                uint256(LibVaipakam.MAX_INTERNAL_MATCH_INCENTIVE_BPS_PER_LEG)
            )
        );
        ConfigFacet(address(diamond)).setInternalMatchConfig(200, over);
    }

    function test_setInternalMatchConfig_revertsBothAboveCap() public {
        // The window check fires first; verify the error surfaces it.
        uint16 windowOver = LibVaipakam.MAX_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS + 50;
        uint16 incentiveOver = LibVaipakam.MAX_INTERNAL_MATCH_INCENTIVE_BPS_PER_LEG + 50;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InternalMatchWindowAboveCap.selector,
                uint256(windowOver),
                uint256(LibVaipakam.MAX_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS)
            )
        );
        ConfigFacet(address(diamond)).setInternalMatchConfig(windowOver, incentiveOver);
    }

    function test_setInternalMatchConfig_revertsWindowHuge() public {
        // Stress: type(uint16).max should hit the cap-check first.
        uint16 huge = type(uint16).max;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InternalMatchWindowAboveCap.selector,
                uint256(huge),
                uint256(LibVaipakam.MAX_EXTERNAL_LIQUIDATION_PRIORITY_WINDOW_BPS)
            )
        );
        ConfigFacet(address(diamond)).setInternalMatchConfig(huge, 100);
    }

    function test_setInternalMatchEnabled_notAdminReverts() public {
        // Caller without ADMIN_ROLE must be rejected.
        address notAdmin = address(0xBEEF);
        vm.prank(notAdmin);
        vm.expectRevert();
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);
    }

    function test_setInternalMatchConfig_notAdminReverts() public {
        address notAdmin = address(0xBEEF);
        vm.prank(notAdmin);
        vm.expectRevert();
        ConfigFacet(address(diamond)).setInternalMatchConfig(200, 100);
    }

    function test_getMatchEligibleLoans_emptyWhileDisabled() public view {
        // With kill-switch off (default), the view returns empty
        // even for permissive filter bounds.
        (uint256[] memory loanIds, uint256 nextIdx) =
            MetricsFacet(address(diamond)).getMatchEligibleLoans(0, 10_000, 0, 100);
        assertEq(loanIds.length, 0, "view returns empty while disabled");
        assertEq(nextIdx, 0, "nextIdx is 0 on disabled-path early exit");
    }

    function test_getMatchEligibleLoans_emptyOnDegenerateFilter() public {
        // Enable, then pass an inverted filter (min > max) — view
        // should return empty with `nextIdx == startIdx` (degenerate
        // input bypasses the iteration entirely).
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);
        (uint256[] memory loanIds, uint256 nextIdx) =
            MetricsFacet(address(diamond)).getMatchEligibleLoans(9_000, 5_000, 7, 50);
        assertEq(loanIds.length, 0);
        assertEq(nextIdx, 7, "nextIdx echoes startIdx on degenerate filter");
    }

    function test_getMatchEligibleLoans_emptyOnMaxScanZero() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);
        (uint256[] memory loanIds, uint256 nextIdx) =
            MetricsFacet(address(diamond)).getMatchEligibleLoans(0, 10_000, 3, 0);
        assertEq(loanIds.length, 0);
        assertEq(nextIdx, 3, "nextIdx echoes startIdx on maxScan == 0");
    }
    /// @dev Five active loans, every one reading 99% LTV.
    function _scaffoldFiveHighLtvLoans() internal {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);
        for (uint256 id = 1; id <= 5; ++id) {
            LibVaipakam.Loan memory l;
            l.id = id;
            l.lender = lender;
            l.borrower = borrower;
            l.status = LibVaipakam.LoanStatus.Active;
            TestMutatorFacet(address(diamond)).scaffoldActiveLoan(id, l);
        }
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateLTV.selector),
            abi.encode(uint256(9_900))
        );
    }

    /// @dev #2751 — one call reads at most `maxScan` rows, whatever the band
    ///      matches: a band no loan falls in costs `maxScan` LTV reads, not
    ///      a walk of the whole list.
    function test_getMatchEligibleLoans_readsAtMostMaxScanRows() public {
        _scaffoldFiveHighLtvLoans();
        vm.expectCall(
            address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector), 2
        );
        (uint256[] memory ids, uint256 nextIdx) =
            MetricsFacet(address(diamond)).getMatchEligibleLoans(0, 5_000, 0, 2);
        assertEq(ids.length, 0, "no row matched");
        assertEq(nextIdx, 2, "the empty page still advanced by maxScan rows");
    }

    /// @dev #2751 — empty pages advance the cursor to the end, and a call
    ///      from the end makes no progress, which is how a caller stops.
    function test_getMatchEligibleLoans_cursorReachesTheEnd() public {
        _scaffoldFiveHighLtvLoans();
        (uint256[] memory ids, uint256 nextIdx) =
            MetricsFacet(address(diamond)).getMatchEligibleLoans(0, 5_000, 2, 2);
        assertEq(ids.length, 0);
        assertEq(nextIdx, 4);
        (ids, nextIdx) = MetricsFacet(address(diamond)).getMatchEligibleLoans(0, 5_000, 4, 2);
        assertEq(nextIdx, 5, "the scan stops at the list's end");
        (ids, nextIdx) = MetricsFacet(address(diamond)).getMatchEligibleLoans(0, 5_000, 5, 2);
        assertEq(ids.length, 0);
        assertEq(nextIdx, 5, "a call from the end makes no progress: the caller stops");

        // An oversized maxScan reads to the end instead of overflowing, and
        // a matching band returns every row it read.
        (ids, nextIdx) = MetricsFacet(address(diamond)).getMatchEligibleLoans(
            0, 10_000, 1, type(uint256).max
        );
        assertEq(ids.length, 4);
        assertEq(ids[0], 2);
        assertEq(nextIdx, 5);
    }
}
