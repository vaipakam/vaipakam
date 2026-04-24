// test/ProfileFacetTest.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {HelperTest} from "./HelperTest.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title ProfileFacetTest
 * @notice Full coverage for ProfileFacet: country, KYC status, KYC tier, trade allowance,
 *         meetsKYCRequirement tiers, and access control.
 */
contract ProfileFacetTest is Test {
    VaipakamDiamond diamond;
    address owner;
    address user1;
    address user2;

    DiamondCutFacet cutFacet;
    ProfileFacet profileFacet;
    AdminFacet adminFacet;
    AccessControlFacet accessControlFacet;
    HelperTest helperTest;

    function setUp() public {
        owner = address(this);
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");

        cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(owner, address(cutFacet));
        profileFacet = new ProfileFacet();
        adminFacet = new AdminFacet();
        accessControlFacet = new AccessControlFacet();
        helperTest = new HelperTest();

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](3);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(profileFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getProfileFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAdminFacetSelectors()
        });
        cuts[2] = IDiamondCut.FacetCut({
            facetAddress: address(accessControlFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helperTest.getAccessControlFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
        AccessControlFacet(address(diamond)).initializeAccessControl();

        // README §16 Phase 1 launches with KYC checks in pass-through mode
        // (flag defaults to false). ProfileFacetTest asserts the *retained*
        // tier framework's semantics, so enable enforcement for the whole
        // suite here.
        AdminFacet(address(diamond)).setKYCEnforcement(true);
    }

    // ─── setUserCountry ───────────────────────────────────────────────────────

    function testSetUserCountrySuccess() public {
        vm.prank(user1);
        vm.expectEmit(true, false, false, true);
        emit ProfileFacet.UserCountrySet(user1, "US");
        ProfileFacet(address(diamond)).setUserCountry("US");
        assertEq(ProfileFacet(address(diamond)).getUserCountry(user1), "US");
    }

    function testSetUserCountryRevertsEmptyString() public {
        vm.prank(user1);
        vm.expectRevert(ProfileFacet.InvalidCountry.selector);
        ProfileFacet(address(diamond)).setUserCountry("");
    }

    function testSetUserCountryRevertsAlreadySet() public {
        vm.prank(user1);
        ProfileFacet(address(diamond)).setUserCountry("US");

        vm.prank(user1);
        vm.expectRevert(ProfileFacet.AlreadyRegistered.selector);
        ProfileFacet(address(diamond)).setUserCountry("FR");
    }

    function testSetUserCountryDifferentUsers() public {
        vm.prank(user1);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(user2);
        ProfileFacet(address(diamond)).setUserCountry("FR");

        assertEq(ProfileFacet(address(diamond)).getUserCountry(user1), "US");
        assertEq(ProfileFacet(address(diamond)).getUserCountry(user2), "FR");
    }

    // ─── getUserCountry ───────────────────────────────────────────────────────

    function testGetUserCountryReturnsEmptyIfNotSet() public view {
        assertEq(ProfileFacet(address(diamond)).getUserCountry(user1), "");
    }

    // ─── updateKYCStatus ──────────────────────────────────────────────────────

    function testUpdateKYCStatusSuccess() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit ProfileFacet.KYCTierUpdated(user1, LibVaipakam.KYCTier.Tier1);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier1);
        assertTrue(ProfileFacet(address(diamond)).isKYCVerified(user1));
    }

    function testUpdateKYCStatusFalse() public {
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier1);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier0);
        assertFalse(ProfileFacet(address(diamond)).isKYCVerified(user1));
    }

    function testUpdateKYCStatusRevertsDeprecated() public {
        vm.prank(user1);
        vm.expectRevert("Deprecated: use updateKYCTier");
        ProfileFacet(address(diamond)).updateKYCStatus(user1, true);
    }

    // ─── isKYCVerified ────────────────────────────────────────────────────────

    function testIsKYCVerifiedReturnsFalseByDefault() public view {
        assertFalse(ProfileFacet(address(diamond)).isKYCVerified(user1));
    }

    // ─── setTradeAllowance ────────────────────────────────────────────────────

    function testSetTradeAllowanceSuccess() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit ProfileFacet.TradeAllowanceSet("US", "FR", true);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "FR", true);
    }

    function testSetTradeAllowanceFalse() public {
        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "FR", true);
        vm.prank(owner);
        ProfileFacet(address(diamond)).setTradeAllowance("US", "FR", false);
    }

    function testSetTradeAllowanceRevertsNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, user1, LibAccessControl.ADMIN_ROLE));
        ProfileFacet(address(diamond)).setTradeAllowance("US", "FR", true);
    }

    // ─── updateKYCTier ────────────────────────────────────────────────────────

    function testUpdateKYCTierTier0() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit ProfileFacet.KYCTierUpdated(user1, LibVaipakam.KYCTier.Tier0);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier0);

        assertEq(uint8(ProfileFacet(address(diamond)).getKYCTier(user1)), uint8(LibVaipakam.KYCTier.Tier0));
        // Tier0 sets kycVerified = false
        assertFalse(ProfileFacet(address(diamond)).isKYCVerified(user1));
    }

    function testUpdateKYCTierTier1() public {
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier1);

        assertEq(uint8(ProfileFacet(address(diamond)).getKYCTier(user1)), uint8(LibVaipakam.KYCTier.Tier1));
        // Tier1 sets kycVerified = true
        assertTrue(ProfileFacet(address(diamond)).isKYCVerified(user1));
    }

    function testUpdateKYCTierTier2() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit ProfileFacet.KYCTierUpdated(user1, LibVaipakam.KYCTier.Tier2);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier2);

        assertEq(uint8(ProfileFacet(address(diamond)).getKYCTier(user1)), uint8(LibVaipakam.KYCTier.Tier2));
        assertTrue(ProfileFacet(address(diamond)).isKYCVerified(user1));
    }

    function testUpdateKYCTierRevertsNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, user1, LibAccessControl.KYC_ADMIN_ROLE));
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier2);
    }

    function testUpdateKYCTierDowngrade() public {
        // Set to Tier2 then downgrade to Tier0
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier2);
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier0);

        assertEq(uint8(ProfileFacet(address(diamond)).getKYCTier(user1)), uint8(LibVaipakam.KYCTier.Tier0));
        assertFalse(ProfileFacet(address(diamond)).isKYCVerified(user1));
    }

    // ─── getKYCTier ───────────────────────────────────────────────────────────

    function testGetKYCTierDefaultsTier0() public view {
        assertEq(uint8(ProfileFacet(address(diamond)).getKYCTier(user1)), uint8(LibVaipakam.KYCTier.Tier0));
    }

    // ─── meetsKYCRequirement ─────────────────────────────────────────────────

    // Below $1k → Tier0 (always passes regardless of tier)
    function testMeetsKYCRequirementBelowTier0Threshold() public view {
        // user1 has Tier0 (default), $500 USD → passes
        assertTrue(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, 500 * 1e18));
    }

    // $1k–$9,999 range → needs Tier1 minimum
    function testMeetsKYCRequirementTier1Range_Tier0Fails() public view {
        // user1 has Tier0, $3000 USD → fails
        assertFalse(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, 3000 * 1e18));
    }

    function testMeetsKYCRequirementTier1Range_Tier1Passes() public {
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier1);
        assertTrue(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, 3000 * 1e18));
    }

    function testMeetsKYCRequirementTier1Range_Tier2Passes() public {
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier2);
        assertTrue(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, 5000 * 1e18));
    }

    // $10k+ range → needs Tier2
    function testMeetsKYCRequirementTier2Range_Tier1Fails() public {
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier1);
        assertFalse(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, 15000 * 1e18));
    }

    function testMeetsKYCRequirementTier2Range_Tier2Passes() public {
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier2);
        assertTrue(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, 15000 * 1e18));
    }

    function testMeetsKYCRequirementAtExactThresholds() public {
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier1);

        // Exactly $1k → Tier1 range (needs Tier1); Tier1 user passes
        assertTrue(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, 1000 * 1e18));
        // Exactly $10k → Tier2 range (needs Tier2); Tier1 user fails
        assertFalse(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, 10000 * 1e18));
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    function testFuzzMeetsKYCRequirementTier2AlwaysPasses(uint256 value) public {
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier2);
        assertTrue(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, value));
    }

    function testFuzzMeetsKYCRequirementTier0OnlyBelowThreshold(uint256 value) public view {
        // user1 has Tier0 by default
        bool expected = value < LibVaipakam.KYC_TIER0_THRESHOLD_USD;
        assertEq(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, value), expected);
    }

    // ─── updateKYCThresholds ─────────────────────────────────────────────────

    function testUpdateKYCThresholdsSuccess() public {
        vm.expectEmit(false, false, false, true);
        emit ProfileFacet.KYCThresholdsUpdated(500 * 1e18, 5000 * 1e18);
        ProfileFacet(address(diamond)).updateKYCThresholds(500 * 1e18, 5000 * 1e18);

        (uint256 tier0, uint256 tier1) = ProfileFacet(address(diamond)).getKYCThresholds();
        assertEq(tier0, 500 * 1e18);
        assertEq(tier1, 5000 * 1e18);
    }

    function testUpdateKYCThresholdsRevertsInvalid() public {
        // tier0 >= tier1
        vm.expectRevert(ProfileFacet.InvalidThresholds.selector);
        ProfileFacet(address(diamond)).updateKYCThresholds(5000 * 1e18, 5000 * 1e18);
    }

    function testUpdateKYCThresholdsRevertsInvalidReversed() public {
        vm.expectRevert(ProfileFacet.InvalidThresholds.selector);
        ProfileFacet(address(diamond)).updateKYCThresholds(10000 * 1e18, 5000 * 1e18);
    }

    function testUpdateKYCThresholdsRevertsNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LibAccessControl.AccessControlUnauthorizedAccount.selector, user1, LibAccessControl.ADMIN_ROLE));
        ProfileFacet(address(diamond)).updateKYCThresholds(500 * 1e18, 5000 * 1e18);
    }

    function testMeetsKYCRequirementWithCustomThresholds() public {
        // Lower thresholds: Tier0 = $500, Tier1 = $2000
        ProfileFacet(address(diamond)).updateKYCThresholds(500 * 1e18, 2000 * 1e18);

        // user1 Tier0: passes below $500, fails at $500+
        assertTrue(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, 499 * 1e18));
        assertFalse(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, 500 * 1e18));

        // user1 Tier1: passes up to $2000
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier1);
        assertTrue(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, 1999 * 1e18));
        assertFalse(ProfileFacet(address(diamond)).meetsKYCRequirement(user1, 2000 * 1e18));
    }

    // ─── Pausable integration ────────────────────────────────────────────────

    function testSetUserCountryRevertsWhenPaused() public {
        AdminFacet(address(diamond)).pause();

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("EnforcedPause()"))));
        ProfileFacet(address(diamond)).setUserCountry("US");
    }

    function testSetTradeAllowanceRevertsWhenPaused() public {
        AdminFacet(address(diamond)).pause();

        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("EnforcedPause()"))));
        ProfileFacet(address(diamond)).setTradeAllowance("US", "FR", true);
    }

    function testUpdateKYCTierRevertsWhenPaused() public {
        AdminFacet(address(diamond)).pause();

        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("EnforcedPause()"))));
        ProfileFacet(address(diamond)).updateKYCTier(user1, LibVaipakam.KYCTier.Tier2);
    }

    function testUpdateKYCThresholdsRevertsWhenPaused() public {
        AdminFacet(address(diamond)).pause();

        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("EnforcedPause()"))));
        ProfileFacet(address(diamond)).updateKYCThresholds(500 * 1e18, 5000 * 1e18);
    }

    // ─── getKYCThresholds ────────────────────────────────────────────────────

    function testGetKYCThresholdsDefaultValues() public view {
        (uint256 tier0, uint256 tier1) = ProfileFacet(address(diamond)).getKYCThresholds();
        assertEq(tier0, LibVaipakam.KYC_TIER0_THRESHOLD_USD);
        assertEq(tier1, LibVaipakam.KYC_TIER1_THRESHOLD_USD);
    }

    // ─── Keeper Access ────────────────────────────────────────────────────────

    function testKeeperAccessDefaultOff() public view {
        assertFalse(ProfileFacet(address(diamond)).getKeeperAccess(user1));
    }

    function testSetKeeperAccessEnable() public {
        vm.prank(user1);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        assertTrue(ProfileFacet(address(diamond)).getKeeperAccess(user1));
    }

    function testSetKeeperAccessDisable() public {
        vm.prank(user1);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        vm.prank(user1);
        ProfileFacet(address(diamond)).setKeeperAccess(false);
        assertFalse(ProfileFacet(address(diamond)).getKeeperAccess(user1));
    }

    function testSetKeeperAccessEmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit ProfileFacet.KeeperAccessUpdated(user1, true);
        vm.prank(user1);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
    }

    // ─── Phase 6: Per-keeper per-action bitmask ─────────────────────────────

    function testApproveKeeperRevertsOnZeroActions() public {
        address k = makeAddr("keeperA");
        vm.prank(user1);
        vm.expectRevert(IVaipakamErrors.InvalidKeeperActions.selector);
        ProfileFacet(address(diamond)).approveKeeper(k, 0);
    }

    function testApproveKeeperRevertsOnOutOfRangeActions() public {
        // Bit 5 (0x20) is outside the defined KEEPER_ACTION_ALL = 0x1F.
        address k = makeAddr("keeperA");
        vm.prank(user1);
        vm.expectRevert(IVaipakamErrors.InvalidKeeperActions.selector);
        ProfileFacet(address(diamond)).approveKeeper(k, 0x20);
    }

    function testApproveKeeperRecordsBitmask() public {
        address k = makeAddr("keeperA");
        vm.prank(user1);
        ProfileFacet(address(diamond)).approveKeeper(
            k,
            LibVaipakam.KEEPER_ACTION_COMPLETE_LOAN_SALE |
                LibVaipakam.KEEPER_ACTION_REFINANCE
        );
        uint8 actions = ProfileFacet(address(diamond)).getKeeperActions(user1, k);
        assertEq(
            actions,
            LibVaipakam.KEEPER_ACTION_COMPLETE_LOAN_SALE |
                LibVaipakam.KEEPER_ACTION_REFINANCE,
            "bitmask must match what was supplied to approveKeeper"
        );
        assertTrue(ProfileFacet(address(diamond)).isApprovedKeeper(user1, k));
    }

    function testApproveKeeperRevertsWhenAlreadyApproved() public {
        address k = makeAddr("keeperA");
        vm.prank(user1);
        ProfileFacet(address(diamond)).approveKeeper(k, LibVaipakam.KEEPER_ACTION_ALL);
        vm.prank(user1);
        vm.expectRevert(IVaipakamErrors.KeeperAlreadyApproved.selector);
        ProfileFacet(address(diamond)).approveKeeper(k, LibVaipakam.KEEPER_ACTION_REFINANCE);
    }

    function testSetKeeperActionsUpdatesBitmask() public {
        address k = makeAddr("keeperA");
        vm.prank(user1);
        ProfileFacet(address(diamond)).approveKeeper(
            k,
            LibVaipakam.KEEPER_ACTION_COMPLETE_LOAN_SALE
        );
        vm.prank(user1);
        ProfileFacet(address(diamond)).setKeeperActions(
            k,
            LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE | LibVaipakam.KEEPER_ACTION_REFINANCE
        );
        assertEq(
            ProfileFacet(address(diamond)).getKeeperActions(user1, k),
            LibVaipakam.KEEPER_ACTION_INIT_PRECLOSE | LibVaipakam.KEEPER_ACTION_REFINANCE,
            "bitmask replaced, not OR-ed"
        );
    }

    function testSetKeeperActionsRevertsOnZero() public {
        address k = makeAddr("keeperA");
        vm.prank(user1);
        ProfileFacet(address(diamond)).approveKeeper(k, LibVaipakam.KEEPER_ACTION_ALL);
        vm.prank(user1);
        vm.expectRevert(IVaipakamErrors.InvalidKeeperActions.selector);
        ProfileFacet(address(diamond)).setKeeperActions(k, 0);
    }

    function testSetKeeperActionsRevertsOnUnapprovedKeeper() public {
        address k = makeAddr("keeperA");
        vm.prank(user1);
        vm.expectRevert(IVaipakamErrors.KeeperNotApproved.selector);
        ProfileFacet(address(diamond)).setKeeperActions(k, LibVaipakam.KEEPER_ACTION_ALL);
    }

    function testRevokeKeeperClearsBitmask() public {
        address k = makeAddr("keeperA");
        vm.prank(user1);
        ProfileFacet(address(diamond)).approveKeeper(k, LibVaipakam.KEEPER_ACTION_ALL);
        vm.prank(user1);
        ProfileFacet(address(diamond)).revokeKeeper(k);
        assertEq(
            ProfileFacet(address(diamond)).getKeeperActions(user1, k),
            0,
            "bitmask cleared on revoke"
        );
        assertFalse(ProfileFacet(address(diamond)).isApprovedKeeper(user1, k));
    }

    function testApproveKeeperMaxWhitelist() public {
        // Per LibVaipakam.MAX_APPROVED_KEEPERS = 5. Sixth add must revert.
        for (uint256 i; i < 5; i++) {
            address k = makeAddr(string.concat("keeper", vm.toString(i)));
            vm.prank(user1);
            ProfileFacet(address(diamond)).approveKeeper(k, LibVaipakam.KEEPER_ACTION_ALL);
        }
        address k6 = makeAddr("keeper6");
        vm.prank(user1);
        vm.expectRevert(IVaipakamErrors.KeeperWhitelistFull.selector);
        ProfileFacet(address(diamond)).approveKeeper(k6, LibVaipakam.KEEPER_ACTION_ALL);
    }
}
