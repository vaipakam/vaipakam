// test/TierLiquidationGradientTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @notice #999 (S1) — the per-tier liquidation-threshold gradient must run
 *         DEEPER ⇒ HIGHER (tier 1 thinnest = lowest/tightest threshold, tier 3
 *         deepest = highest), and the setter must enforce `T1 ≤ T2 ≤ T3`. Also
 *         guards the tier-0 "untierable" fallback remap: post-#999 tier 0 must
 *         alias the conservative Tier-1 value (80%), NOT Tier 3 (now 90%).
 *
 *         The S11 (#1007) tier-ASSIGNMENT change (an asset clearing the $5k
 *         floor but not the $50k tier-1 probe ⇒ tier 0) is covered in
 *         DepthTieredLtv.t.sol where the mock-pool depth harness lives.
 */
contract TierLiquidationGradientTest is SetupTest {
    function setUp() public {
        setupHelper();
    }

    // ─── S1: default gradient is ascending (deeper = higher) ─────────────────

    function testDefaultGradientAscending() public {
        // SetupTest pins all tiers to 8500 via the raw mutator; clear the
        // override (0 = unset) so the LIBRARY defaults surface.
        TestMutatorFacet(address(diamond)).setTierLiquidationLtvBpsAllRaw(0, 0, 0);
        (uint256 t1, uint256 t2, uint256 t3) =
            ConfigFacet(address(diamond)).getTierLiquidationLtvBps();
        assertEq(t1, 8000, "tier1 thinnest = 80%");
        assertEq(t2, 8500, "tier2 = 85%");
        assertEq(t3, 9000, "tier3 deepest = 90%");
        assertTrue(t1 <= t2 && t2 <= t3, "deeper => higher threshold");
    }

    // ─── S1 (Codex #1052 P1): tier-0 fallback aliases the conservative low ───

    function testTierZeroFallbackIsConservative() public {
        TestMutatorFacet m = TestMutatorFacet(address(diamond));
        m.setTierLiquidationLtvBpsAllRaw(0, 0, 0); // clear the SetupTest 8500 pin
        // Untierable tier 0 must get the LOWEST threshold, not Tier 3's 90%.
        assertEq(m.tierLiquidationLtvBpsFor(0), 8000, "tier0 = conservative 80%");
        assertEq(m.tierLiquidationLtvBpsFor(1), 8000, "tier1 = 80%");
        assertEq(m.tierLiquidationLtvBpsFor(2), 8500, "tier2 = 85%");
        assertEq(m.tierLiquidationLtvBpsFor(3), 9000, "tier3 = 90%");
        // tier0 tracks tier1 (the conservative end), never tier3.
        assertEq(
            m.tierLiquidationLtvBpsFor(0),
            m.tierLiquidationLtvBpsFor(1),
            "tier0 aliases tier1"
        );
    }

    // ─── S1: setter invariant flipped to T1 <= T2 <= T3 ──────────────────────

    function testSetterAcceptsAscending() public {
        vm.prank(owner);
        ConfigFacet(address(diamond)).setTierLiquidationLtvBps(8000, 8500, 9000);
        (uint256 t1, uint256 t2, uint256 t3) =
            ConfigFacet(address(diamond)).getTierLiquidationLtvBps();
        assertEq(t1, 8000);
        assertEq(t2, 8500);
        assertEq(t3, 9000);
    }

    function testSetterRejectsDescending() public {
        // The pre-#999 gradient (thinnest tier 1 = 90%) is now rejected.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.NonMonotoneTierLiquidationLtvBps.selector,
                uint256(9000),
                uint256(8500),
                uint256(8000)
            )
        );
        ConfigFacet(address(diamond)).setTierLiquidationLtvBps(9000, 8500, 8000);
    }

    function testSetterAllowsEqual() public {
        // Flat gradient (every tier equal) satisfies T1 <= T2 <= T3.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setTierLiquidationLtvBps(8500, 8500, 8500);
        (uint256 t1, uint256 t2, uint256 t3) =
            ConfigFacet(address(diamond)).getTierLiquidationLtvBps();
        assertEq(t1, 8500);
        assertEq(t2, 8500);
        assertEq(t3, 8500);
    }

    function testSetterTierZeroFallbackTracksNewTier1() public {
        // After a governance retune, tier 0 must still track the (new) tier-1
        // conservative value, not tier 3.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setTierLiquidationLtvBps(7000, 8000, 9500);
        TestMutatorFacet m = TestMutatorFacet(address(diamond));
        assertEq(m.tierLiquidationLtvBpsFor(0), 7000, "tier0 tracks retuned tier1");
        assertEq(m.tierLiquidationLtvBpsFor(3), 9500, "tier3 retuned");
    }
}
