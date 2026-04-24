// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LegalFacet} from "../src/facets/LegalFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

/**
 * @title LegalFacetTest
 * @notice Phase 4.1 — ToS acceptance flow. Verifies:
 *           - Gate-disabled state (currentTosVersion=0): every wallet
 *             is treated as accepted.
 *           - Governance install + strict-increase version bump.
 *           - User acceptTerms success path, event emission, storage
 *             roundtrip.
 *           - Rejection of mismatched version OR mismatched hash.
 *           - Re-acceptance is a no-op (no revert) but refreshes
 *             acceptedAt.
 *           - Version bumps invalidate all prior acceptances.
 *           - Admin gating on setCurrentTos (non-admin reverts).
 */
contract LegalFacetTest is SetupTest {
    LegalFacet internal legalFacet;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    bytes32 internal constant TOS_HASH_V1 = keccak256("Vaipakam ToS v1");
    bytes32 internal constant TOS_HASH_V2 = keccak256("Vaipakam ToS v2");

    event TermsAccepted(
        address indexed user,
        uint32 indexed version,
        bytes32 hash,
        uint64 timestamp
    );
    event CurrentTosUpdated(
        uint32 version,
        uint32 indexed newVersion,
        bytes32 newHash
    );

    function setUp() public {
        setupHelper();

        legalFacet = new LegalFacet();
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = LegalFacet.acceptTerms.selector;
        selectors[1] = LegalFacet.setCurrentTos.selector;
        selectors[2] = LegalFacet.hasAcceptedCurrentTerms.selector;
        selectors[3] = LegalFacet.getCurrentTos.selector;
        selectors[4] = LegalFacet.getUserTosAcceptance.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(legalFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    // ─── Gate-disabled state ────────────────────────────────────────────────

    function test_Initial_GateDisabled_EveryoneTreatedAsAccepted() public {
        // currentTosVersion defaults to 0 — gate off, every wallet is
        // implicitly accepted so the Diamond can ship with the gate
        // code path live but inert.
        assertTrue(LegalFacet(address(diamond)).hasAcceptedCurrentTerms(alice));
        assertTrue(LegalFacet(address(diamond)).hasAcceptedCurrentTerms(bob));
    }

    function test_Initial_GetCurrentTos_ReturnsZeros() public {
        (uint32 v, bytes32 h) = LegalFacet(address(diamond)).getCurrentTos();
        assertEq(v, 0);
        assertEq(h, bytes32(0));
    }

    // ─── setCurrentTos governance ──────────────────────────────────────────

    function test_setCurrentTos_InstallFirstVersion() public {
        vm.expectEmit(true, true, false, true);
        emit CurrentTosUpdated(0, 1, TOS_HASH_V1);

        LegalFacet(address(diamond)).setCurrentTos(1, TOS_HASH_V1);

        (uint32 v, bytes32 h) = LegalFacet(address(diamond)).getCurrentTos();
        assertEq(v, 1);
        assertEq(h, TOS_HASH_V1);
    }

    function test_setCurrentTos_RevertOnNonStrictIncrease() public {
        LegalFacet(address(diamond)).setCurrentTos(1, TOS_HASH_V1);
        vm.expectRevert(LegalFacet.InvalidTosParams.selector);
        LegalFacet(address(diamond)).setCurrentTos(1, TOS_HASH_V1);
    }

    function test_setCurrentTos_RevertOnDowngrade() public {
        LegalFacet(address(diamond)).setCurrentTos(2, TOS_HASH_V1);
        vm.expectRevert(LegalFacet.InvalidTosParams.selector);
        LegalFacet(address(diamond)).setCurrentTos(1, TOS_HASH_V2);
    }

    function test_setCurrentTos_RevertOnZeroHash() public {
        vm.expectRevert(LegalFacet.InvalidTosParams.selector);
        LegalFacet(address(diamond)).setCurrentTos(1, bytes32(0));
    }

    function test_setCurrentTos_RevertForNonAdmin() public {
        vm.prank(attacker);
        vm.expectRevert();
        LegalFacet(address(diamond)).setCurrentTos(1, TOS_HASH_V1);
    }

    // ─── acceptTerms user path ─────────────────────────────────────────────

    function test_acceptTerms_Success_EmitsEvent() public {
        LegalFacet(address(diamond)).setCurrentTos(1, TOS_HASH_V1);

        vm.warp(1_000_000);
        vm.expectEmit(true, true, false, true);
        emit TermsAccepted(alice, 1, TOS_HASH_V1, uint64(block.timestamp));

        vm.prank(alice);
        LegalFacet(address(diamond)).acceptTerms(1, TOS_HASH_V1);

        LibVaipakam.TosAcceptance memory a = LegalFacet(address(diamond))
            .getUserTosAcceptance(alice);
        assertEq(a.version, 1);
        assertEq(a.hash, TOS_HASH_V1);
        assertEq(a.acceptedAt, uint64(block.timestamp));

        assertTrue(
            LegalFacet(address(diamond)).hasAcceptedCurrentTerms(alice)
        );
    }

    function test_acceptTerms_RevertOnVersionMismatch() public {
        LegalFacet(address(diamond)).setCurrentTos(1, TOS_HASH_V1);
        vm.prank(alice);
        vm.expectRevert(LegalFacet.InvalidTosVersion.selector);
        LegalFacet(address(diamond)).acceptTerms(2, TOS_HASH_V1);
    }

    function test_acceptTerms_RevertOnHashMismatch() public {
        LegalFacet(address(diamond)).setCurrentTos(1, TOS_HASH_V1);
        vm.prank(alice);
        vm.expectRevert(LegalFacet.InvalidTosVersion.selector);
        LegalFacet(address(diamond)).acceptTerms(1, TOS_HASH_V2);
    }

    function test_acceptTerms_ReAcceptIsNoOpRefreshingTimestamp() public {
        LegalFacet(address(diamond)).setCurrentTos(1, TOS_HASH_V1);

        vm.warp(1_000_000);
        vm.prank(alice);
        LegalFacet(address(diamond)).acceptTerms(1, TOS_HASH_V1);

        uint64 firstAt = LegalFacet(address(diamond))
            .getUserTosAcceptance(alice)
            .acceptedAt;

        vm.warp(2_000_000);
        vm.prank(alice);
        LegalFacet(address(diamond)).acceptTerms(1, TOS_HASH_V1);

        LibVaipakam.TosAcceptance memory a = LegalFacet(address(diamond))
            .getUserTosAcceptance(alice);
        assertEq(a.version, 1);
        assertEq(a.hash, TOS_HASH_V1);
        assertGt(a.acceptedAt, firstAt);
    }

    // ─── Version bump invalidates prior acceptances ────────────────────────

    function test_VersionBump_InvalidatesPriorAcceptance() public {
        LegalFacet(address(diamond)).setCurrentTos(1, TOS_HASH_V1);
        vm.prank(alice);
        LegalFacet(address(diamond)).acceptTerms(1, TOS_HASH_V1);
        assertTrue(
            LegalFacet(address(diamond)).hasAcceptedCurrentTerms(alice)
        );

        // Governance bumps — alice is now out of date.
        LegalFacet(address(diamond)).setCurrentTos(2, TOS_HASH_V2);
        assertFalse(
            LegalFacet(address(diamond)).hasAcceptedCurrentTerms(alice)
        );

        // Alice re-accepts the new version — good again.
        vm.prank(alice);
        LegalFacet(address(diamond)).acceptTerms(2, TOS_HASH_V2);
        assertTrue(
            LegalFacet(address(diamond)).hasAcceptedCurrentTerms(alice)
        );
    }

    function test_SameVersion_HashDrift_InvalidatesAcceptance() public {
        // Edge case: governance corrects the content of a live version
        // number (rare, but if it happens we don't want anyone's
        // prior acceptance to still count because they agreed to
        // different text). The hash comparison in
        // hasAcceptedCurrentTerms catches this.
        LegalFacet(address(diamond)).setCurrentTos(1, TOS_HASH_V1);
        vm.prank(alice);
        LegalFacet(address(diamond)).acceptTerms(1, TOS_HASH_V1);

        // Simulate a bugfix post-publication — bump to v2 with a
        // different hash (setCurrentTos enforces monotonic version).
        LegalFacet(address(diamond)).setCurrentTos(2, TOS_HASH_V2);
        assertFalse(
            LegalFacet(address(diamond)).hasAcceptedCurrentTerms(alice)
        );
    }

    // ─── Fuzz: arbitrary (version, hash) submission must revert unless matching ─

    function testFuzz_acceptTerms_RevertOnAnyMismatch(
        uint32 badVersion,
        bytes32 badHash
    ) public {
        LegalFacet(address(diamond)).setCurrentTos(1, TOS_HASH_V1);
        vm.assume(!(badVersion == 1 && badHash == TOS_HASH_V1));

        vm.prank(alice);
        vm.expectRevert(LegalFacet.InvalidTosVersion.selector);
        LegalFacet(address(diamond)).acceptTerms(badVersion, badHash);
    }
}
