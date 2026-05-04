// test/GraceBucketsTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {HelperTest} from "./HelperTest.sol";

/// @title GraceBucketsTest
/// @notice T-044 — exercises the admin-configurable loan-default grace
///         schedule. Schedule shape is a fixed 6-slot positional table;
///         admin can edit values inside each slot but cannot add /
///         remove rows. Each slot's `(maxDurationDays, graceSeconds)`
///         must lie inside the per-slot bounds returned by
///         `LibVaipakam.graceSlotBounds`. Tests cover:
///         - Default-fallback semantics (empty storage uses compile-time
///           schedule) including the new ≥ 365 days = 30 days bucket.
///         - Setter happy path with the canonical schedule.
///         - Per-slot validation (wrong count / catch-all marker /
///           duration bounds / grace bounds / monotonicity).
///         - Role-gating + event emission.
///         - clearGraceBuckets reverts to defaults.
contract GraceBucketsTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address attacker;

    DiamondCutFacet cutFacet;
    AccessControlFacet accessControlFacet;
    ConfigFacet configFacet;
    HelperTest helperTest;

    function setUp() public {
        owner = address(this);
        attacker = makeAddr("attacker");

        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        accessControlFacet = new AccessControlFacet();
        configFacet = new ConfigFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(configFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getConfigFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();
    }

    /// @dev Canonical schedule used by `_canonicalSchedule()` below.
    ///      Mirrors the fallback defaults baked into
    ///      `LibVaipakam.gracePeriod()` and the per-slot bounds in
    ///      `LibVaipakam.graceSlotBounds`. Edit in lockstep if either
    ///      moves.
    function _canonicalSchedule()
        internal
        pure
        returns (LibVaipakam.GraceBucket[] memory b)
    {
        b = new LibVaipakam.GraceBucket[](6);
        b[0] = LibVaipakam.GraceBucket({maxDurationDays: 7,   graceSeconds: 1 hours});
        b[1] = LibVaipakam.GraceBucket({maxDurationDays: 30,  graceSeconds: 1 days});
        b[2] = LibVaipakam.GraceBucket({maxDurationDays: 90,  graceSeconds: 3 days});
        b[3] = LibVaipakam.GraceBucket({maxDurationDays: 180, graceSeconds: 1 weeks});
        b[4] = LibVaipakam.GraceBucket({maxDurationDays: 365, graceSeconds: 2 weeks});
        b[5] = LibVaipakam.GraceBucket({maxDurationDays: 0,   graceSeconds: 30 days});
    }

    // ─── Default schedule (compile-time fallback) ─────────────────────────

    function testDefaultScheduleAcrossAllBuckets() public view {
        ConfigFacet cf = ConfigFacet(address(diamond));
        assertEq(cf.getEffectiveGraceSeconds(0), 1 hours, "<1d default");
        assertEq(cf.getEffectiveGraceSeconds(6), 1 hours, "<7d default");
        assertEq(cf.getEffectiveGraceSeconds(7), 1 days, "7d default");
        assertEq(cf.getEffectiveGraceSeconds(29), 1 days, "29d default");
        assertEq(cf.getEffectiveGraceSeconds(30), 3 days, "30d default");
        assertEq(cf.getEffectiveGraceSeconds(89), 3 days, "89d default");
        assertEq(cf.getEffectiveGraceSeconds(90), 1 weeks, "90d default");
        assertEq(cf.getEffectiveGraceSeconds(179), 1 weeks, "179d default");
        assertEq(cf.getEffectiveGraceSeconds(180), 2 weeks, "180d default");
        assertEq(cf.getEffectiveGraceSeconds(364), 2 weeks, "364d default");
        // T-044 — new ≥ 365 days = 30 days bucket.
        assertEq(cf.getEffectiveGraceSeconds(365), 30 days, "365d default");
        assertEq(cf.getEffectiveGraceSeconds(730), 30 days, "2y default");
        assertEq(cf.getEffectiveGraceSeconds(3650), 30 days, "10y default");
    }

    function testGetGraceBucketsEmptyByDefault() public view {
        LibVaipakam.GraceBucket[] memory got = ConfigFacet(address(diamond))
            .getGraceBuckets();
        assertEq(got.length, 0, "empty before set");
    }

    // ─── getGraceSlotBounds — admin-console policy table ─────────────────

    function testSlotBoundsMatchPolicyTable() public view {
        ConfigFacet cf = ConfigFacet(address(diamond));
        (
            uint256[] memory minDays,
            uint256[] memory maxDays,
            uint256[] memory minGrace,
            uint256[] memory maxGrace
        ) = cf.getGraceSlotBounds();
        assertEq(minDays.length, 6, "6 slots");

        // Slot 0: < 7 days canonical
        assertEq(minDays[0], 1);     assertEq(maxDays[0], 14);
        assertEq(minGrace[0], 1 hours); assertEq(maxGrace[0], 5 days);

        // Slot 1: < 30 days canonical
        assertEq(minDays[1], 7);     assertEq(maxDays[1], 60);
        assertEq(minGrace[1], 1 hours); assertEq(maxGrace[1], 15 days);

        // Slot 2: < 90 days canonical
        assertEq(minDays[2], 30);    assertEq(maxDays[2], 180);
        assertEq(minGrace[2], 1 days); assertEq(maxGrace[2], 30 days);

        // Slot 3: < 180 days canonical
        assertEq(minDays[3], 90);    assertEq(maxDays[3], 270);
        assertEq(minGrace[3], 3 days); assertEq(maxGrace[3], 45 days);

        // Slot 4: < 365 days canonical
        assertEq(minDays[4], 180);   assertEq(maxDays[4], 540);
        assertEq(minGrace[4], 7 days); assertEq(maxGrace[4], 60 days);

        // Slot 5: catch-all
        assertEq(minDays[5], 0);     assertEq(maxDays[5], 0);
        assertEq(minGrace[5], 14 days); assertEq(maxGrace[5], 90 days);
    }

    // ─── Custom schedule (storage-driven path) ────────────────────────────

    function testCanonicalScheduleEqualsDefaults() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        cf.setGraceBuckets(_canonicalSchedule());

        // Same lookups as the default-fallback path.
        assertEq(cf.getEffectiveGraceSeconds(0), 1 hours);
        assertEq(cf.getEffectiveGraceSeconds(6), 1 hours);
        assertEq(cf.getEffectiveGraceSeconds(7), 1 days);
        assertEq(cf.getEffectiveGraceSeconds(29), 1 days);
        assertEq(cf.getEffectiveGraceSeconds(30), 3 days);
        assertEq(cf.getEffectiveGraceSeconds(89), 3 days);
        assertEq(cf.getEffectiveGraceSeconds(90), 1 weeks);
        assertEq(cf.getEffectiveGraceSeconds(179), 1 weeks);
        assertEq(cf.getEffectiveGraceSeconds(180), 2 weeks);
        assertEq(cf.getEffectiveGraceSeconds(364), 2 weeks);
        assertEq(cf.getEffectiveGraceSeconds(365), 30 days);
        assertEq(cf.getEffectiveGraceSeconds(3650), 30 days);
    }

    function testStretchedScheduleStillInsideSlotBounds() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        // A more conservative operator who tightens short-loan grace and
        // widens long-loan grace, all values still inside per-slot bounds.
        LibVaipakam.GraceBucket[] memory b = new LibVaipakam.GraceBucket[](6);
        b[0] = LibVaipakam.GraceBucket({maxDurationDays: 5,   graceSeconds: 4 hours}); // tighter
        b[1] = LibVaipakam.GraceBucket({maxDurationDays: 30,  graceSeconds: 2 days});
        b[2] = LibVaipakam.GraceBucket({maxDurationDays: 100, graceSeconds: 5 days});
        b[3] = LibVaipakam.GraceBucket({maxDurationDays: 200, graceSeconds: 14 days});
        b[4] = LibVaipakam.GraceBucket({maxDurationDays: 400, graceSeconds: 30 days});
        b[5] = LibVaipakam.GraceBucket({maxDurationDays: 0,   graceSeconds: 60 days}); // wider catch-all
        cf.setGraceBuckets(b);

        assertEq(cf.getEffectiveGraceSeconds(0), 4 hours, "<5");
        assertEq(cf.getEffectiveGraceSeconds(5), 2 days, "5..29");
        assertEq(cf.getEffectiveGraceSeconds(99), 5 days, "30..99");
        assertEq(cf.getEffectiveGraceSeconds(199), 14 days, "100..199");
        assertEq(cf.getEffectiveGraceSeconds(399), 30 days, "200..399");
        assertEq(cf.getEffectiveGraceSeconds(400), 60 days, "catch-all");

        LibVaipakam.GraceBucket[] memory got = cf.getGraceBuckets();
        assertEq(got.length, 6);
        assertEq(got[5].maxDurationDays, 0);
        assertEq(got[5].graceSeconds, 60 days);
    }

    // ─── clearGraceBuckets reverts to defaults ────────────────────────────

    function testClearGraceBucketsRevertsToDefaults() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        cf.setGraceBuckets(_canonicalSchedule());
        assertEq(cf.getGraceBuckets().length, 6);

        cf.clearGraceBuckets();
        assertEq(cf.getGraceBuckets().length, 0, "cleared");
        assertEq(cf.getEffectiveGraceSeconds(365), 30 days, "default after clear");
    }

    // ─── Setter validation: count / catch-all marker ──────────────────────

    function testRevertWhenWrongCount() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        // Empty.
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.GraceBucketsInvalid.selector,
                "wrong-count"
            )
        );
        cf.setGraceBuckets(new LibVaipakam.GraceBucket[](0));
        // Five (one short).
        LibVaipakam.GraceBucket[] memory five = new LibVaipakam.GraceBucket[](5);
        for (uint256 i = 0; i < 5; i++) {
            five[i] = LibVaipakam.GraceBucket({maxDurationDays: i + 1, graceSeconds: 1 hours});
        }
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.GraceBucketsInvalid.selector,
                "wrong-count"
            )
        );
        cf.setGraceBuckets(five);
        // Seven (one over).
        LibVaipakam.GraceBucket[] memory seven = new LibVaipakam.GraceBucket[](7);
        for (uint256 i = 0; i < 7; i++) {
            seven[i] = LibVaipakam.GraceBucket({maxDurationDays: i + 1, graceSeconds: 1 hours});
        }
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.GraceBucketsInvalid.selector,
                "wrong-count"
            )
        );
        cf.setGraceBuckets(seven);
    }

    function testRevertWhenCatchAllNotZero() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        LibVaipakam.GraceBucket[] memory bad = _canonicalSchedule();
        // Slot 5 must be 0; flip to a non-zero value.
        bad[5].maxDurationDays = 999;
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.GraceBucketsInvalid.selector,
                "catchall-not-zero"
            )
        );
        cf.setGraceBuckets(bad);
    }

    // ─── Setter validation: per-slot duration / grace bounds ──────────────

    function testRevertWhenSlotDurationBelowSlotMin() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        LibVaipakam.GraceBucket[] memory bad = _canonicalSchedule();
        // Slot 1 has minDays = 7; pushing it to 6 trips the check.
        bad[1].maxDurationDays = 6;
        // `bytes32(...)` cast required: ParameterOutOfRange takes a
        // bytes32 name, but `abi.encodeWithSelector` infers the string
        // literal as `string` (dynamic) without an explicit cast,
        // producing a different ABI shape from what the contract emits.
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("graceBucketMaxDurationDays"),
                uint256(6),
                uint256(7),   // slot 1 minDays
                uint256(60)   // slot 1 maxDays
            )
        );
        cf.setGraceBuckets(bad);
    }

    function testRevertWhenSlotDurationAboveSlotMax() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        LibVaipakam.GraceBucket[] memory bad = _canonicalSchedule();
        // Slot 4 has maxDays = 540; pushing it to 600 trips.
        bad[4].maxDurationDays = 600;
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("graceBucketMaxDurationDays"),
                uint256(600),
                uint256(180), // slot 4 minDays
                uint256(540)  // slot 4 maxDays
            )
        );
        cf.setGraceBuckets(bad);
    }

    function testRevertWhenGraceBelowSlotMin() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        LibVaipakam.GraceBucket[] memory bad = _canonicalSchedule();
        // Slot 2 minGrace = 1 day; flipping to 12h trips.
        bad[2].graceSeconds = 12 hours;
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("graceBucketSeconds"),
                uint256(12 hours),
                uint256(1 days),  // slot 2 minGrace
                uint256(30 days)  // slot 2 maxGrace
            )
        );
        cf.setGraceBuckets(bad);
    }

    function testRevertWhenGraceAboveSlotMax() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        LibVaipakam.GraceBucket[] memory bad = _canonicalSchedule();
        // Slot 0 maxGrace = 5 days; flipping to 6 days trips.
        bad[0].graceSeconds = 6 days;
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("graceBucketSeconds"),
                uint256(6 days),
                uint256(1 hours), // slot 0 minGrace
                uint256(5 days)   // slot 0 maxGrace
            )
        );
        cf.setGraceBuckets(bad);
    }

    function testRevertWhenCatchAllGraceAboveSlotMax() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        LibVaipakam.GraceBucket[] memory bad = _canonicalSchedule();
        // Catch-all maxGrace = 90 days; flipping to 91 days trips.
        bad[5].graceSeconds = 91 days;
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.ParameterOutOfRange.selector,
                bytes32("graceBucketSeconds"),
                uint256(91 days),
                uint256(14 days), // slot 5 minGrace
                uint256(90 days)  // slot 5 maxGrace
            )
        );
        cf.setGraceBuckets(bad);
    }

    function testRevertWhenSlotsNotMonotonic() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        // Both slot 1 and slot 0 set maxDurationDays = 7. Each individually
        // sits inside its slot's bound, but slot 1 fails the monotonic
        // ascending invariant.
        LibVaipakam.GraceBucket[] memory bad = _canonicalSchedule();
        bad[0].maxDurationDays = 7;
        bad[1].maxDurationDays = 7;
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.GraceBucketsInvalid.selector,
                "not-monotonic"
            )
        );
        cf.setGraceBuckets(bad);
    }

    // ─── ADMIN_ROLE gating ────────────────────────────────────────────────

    function testNonAdminCannotSetGraceBuckets() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        LibVaipakam.GraceBucket[] memory ok = _canonicalSchedule();
        vm.prank(attacker);
        vm.expectRevert();
        cf.setGraceBuckets(ok);
    }

    function testNonAdminCannotClearGraceBuckets() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        vm.prank(attacker);
        vm.expectRevert();
        cf.clearGraceBuckets();
    }

    // ─── Event emission ───────────────────────────────────────────────────

    function testGraceBucketsUpdatedEventOnSet() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        vm.expectEmit(true, true, true, true);
        emit ConfigFacet.GraceBucketsUpdated(6);
        cf.setGraceBuckets(_canonicalSchedule());
    }

    function testGraceBucketsUpdatedEventOnClear() public {
        ConfigFacet cf = ConfigFacet(address(diamond));
        cf.setGraceBuckets(_canonicalSchedule());
        vm.expectEmit(true, true, true, true);
        emit ConfigFacet.GraceBucketsUpdated(0);
        cf.clearGraceBuckets();
    }
}
