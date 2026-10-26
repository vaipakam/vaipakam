// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/// @title TierLtvCacheBoxTest
/// @notice #2736 — the peer-derived tier-LTV cache governs new loans only
///         while its entry is fresh AND inside the tier's CURRENT safety box.
///         A box governance moves after the refresh binds at once: the
///         out-of-box entry falls back to the governance tier cap, exactly
///         like a stale one, and is never clipped into range.
contract TierLtvCacheBoxTest is SetupTest {
    /// @dev The library default governance tier caps (`cfgTierNMaxInitLtvBps`
    ///      with nothing set): 50% / 60% / 65%.
    uint16 internal constant TIER3_GOV_CAP = 6_500;

    function setUp() public {
        setupHelper();
    }

    function _effective(uint8 tier) internal view returns (uint16) {
        return OracleFacet(address(diamond)).getEffectiveTierMaxInitLtvBps(tier);
    }

    function _seed(uint8 tier, uint16 ltvBps) internal {
        TestMutatorFacet(address(diamond)).setTierLtvCacheRaw(tier, ltvBps, uint64(block.timestamp));
    }

    function test_freshEntryInsideBox_isUsed() public {
        _seed(3, 8_000); // inside the default Tier-3 box [69%, 82%]
        assertEq(_effective(3), 8_000, "fresh in-box entry governs");
    }

    function test_boxTightenedBelowEntry_fallsBackToGovernanceCap() public {
        _seed(3, 8_000);
        // Governance lowers the Tier-3 ceiling to 75% after the refresh.
        ConfigFacet(address(diamond)).setTierLtvParams(
            3_700, 5_500, 0,
            5_500, 6_900, 0,
            6_900, 7_500, 500
        );
        assertEq(_effective(3), TIER3_GOV_CAP, "out-of-box entry is not trusted");
        // Not clipped to the new ceiling: the fallback is the governance cap.
        assertTrue(_effective(3) != 7_500, "never clipped into range");
    }

    function test_boxRaisedAboveEntry_fallsBackToGovernanceCap() public {
        _seed(3, 7_000);
        // Governance raises the Tier-3 floor to 72%: the cached 70% now sits
        // below the box, which a refresh today would also reject.
        ConfigFacet(address(diamond)).setTierLtvParams(
            3_700, 5_500, 0,
            5_500, 6_900, 0,
            7_200, 8_200, 500
        );
        assertEq(_effective(3), TIER3_GOV_CAP, "below-floor entry is not trusted");
    }

    function test_boxRestored_entryIsTrustedAgain() public {
        _seed(3, 8_000);
        ConfigFacet(address(diamond)).setTierLtvParams(
            3_700, 5_500, 0,
            5_500, 6_900, 0,
            6_900, 7_500, 500
        );
        assertEq(_effective(3), TIER3_GOV_CAP);
        ConfigFacet(address(diamond)).setTierLtvParams(
            3_700, 5_500, 0,
            5_500, 6_900, 0,
            6_900, 8_200, 500
        );
        assertEq(_effective(3), 8_000, "the read follows the box as it stands now");
    }

    function test_staleEntry_fallsBackToGovernanceCap() public {
        _seed(3, 8_000);
        vm.warp(block.timestamp + 14 days + 1);
        assertEq(_effective(3), TIER3_GOV_CAP, "hard-stale entry is not trusted");
    }

    function test_peerReadsPaused_fallsBackToGovernanceCap() public {
        _seed(3, 8_000);
        AdminFacet(address(diamond)).setPeerLtvReadsPaused(true);
        assertEq(_effective(3), TIER3_GOV_CAP, "paused peer reads skip the cache");
    }
}
