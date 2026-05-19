// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {VaipakamDiamond} from "../src/VaipakamDiamond.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {DiamondCutFacet} from "../src/facets/DiamondCutFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibPausable} from "../src/libraries/LibPausable.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {HelperTest} from "./HelperTest.sol";

/**
 * @title DiamondBornPausedTest
 * @notice Pins the post-rehearsal hardening from
 *         `docs/internal/ContractFollowupsFromRehearsal-2026-05-06.md`
 *         Item 2: the Diamond MUST be paused at construction time and
 *         stay paused until the deploy script's final
 *         {AdminFacet.unpause} call.
 *
 *         Why it matters: the deploy script lands two `diamondCut`
 *         transactions (split because the full 32-facet cut blows
 *         the gas cap). Between cut 1/2 and cut 2/2 the Diamond is
 *         in a half-cut state — half-2 selectors are unmapped.
 *         Today they revert via `FunctionDoesNotExist`, but a future
 *         fallback that swallows revert reasons would turn that
 *         window into a foot-gun. Born-paused defends in depth: any
 *         half-cut selector with `whenNotPaused` reverts
 *         {EnforcedPause} regardless of the fallback's behavior.
 *
 *         The matching contract surface is at
 *         {VaipakamDiamond.constructor} (last write before exit) and
 *         {DeployDiamond.s.sol} step 5e.
 */
contract DiamondBornPausedTest is Test {
    VaipakamDiamond internal diamond;
    HelperTest internal helper;

    function setUp() public {
        DiamondCutFacet cutFacet = new DiamondCutFacet();
        diamond = new VaipakamDiamond(address(this), address(cutFacet));
        helper = new HelperTest();
    }

    /// @notice Right out of the constructor — before any facet cut
    ///         lands beyond DiamondCutFacet — the Diamond reports
    ///         paused == true. That's the half-cut-window guard
    ///         this test pins.
    function test_diamondBornPaused_beforeAnyCut() public view {
        // Read directly via LibPausable's namespaced storage. We
        // can't go through `AdminFacet.paused()` here because the
        // AdminFacet hasn't been cut yet — that's the whole point.
        // A storage-slot read confirms the constructor wrote `true`.
        assertTrue(_pausedDirect(), "diamond must be born paused");
    }

    /// @notice After AdminFacet is cut + AccessControl is initialized,
    ///         the public `paused()` view also reports true. Confirms
    ///         the constructor's storage write is observed via the
    ///         normal post-cut accessor — same fact, two windows.
    function test_diamondBornPaused_afterAdminCut() public {
        _addAccessControlAndAdmin();
        AccessControlFacet(address(diamond)).initializeAccessControl();
        assertTrue(
            AdminFacet(address(diamond)).paused(),
            "paused() must return true post-cut"
        );
    }

    /// @notice The deploy-script's final step calls
    ///         {AdminFacet.unpause}; this test pins that the call
    ///         lands the bit back to false. Mirrors `DeployDiamond.s.sol`
    ///         step 5e exactly.
    function test_unpauseFlipsTheBit() public {
        _addAccessControlAndAdmin();
        AccessControlFacet(address(diamond)).initializeAccessControl();
        assertTrue(AdminFacet(address(diamond)).paused());

        AdminFacet(address(diamond)).unpause();

        assertFalse(
            AdminFacet(address(diamond)).paused(),
            "post-unpause paused() must be false"
        );
    }

    /// @notice While in the born-paused state, any facet selector
    ///         gated by `whenNotPaused` must revert
    ///         `LibPausable.EnforcedPause`. Uses {OfferCreateFacet.createOffer}
    ///         as the canary — its modifier ordering hits
    ///         `whenNotPaused` first, before any role / oracle /
    ///         input-validation work, so the revert is observable
    ///         even with a default-zero argument struct.
    function test_whenNotPausedReverts_inBornPausedState() public {
        _addAccessControlAndAdmin();
        AccessControlFacet(address(diamond)).initializeAccessControl();

        bytes4[] memory selectors = helper.getOfferCreateFacetSelectors();
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(new OfferCreateFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");

        LibVaipakam.CreateOfferParams memory params;
        vm.expectRevert(LibPausable.EnforcedPause.selector);
        OfferCreateFacet(address(diamond)).createOffer(params);
    }

    // ─── helpers ────────────────────────────────────────────────────────────

    function _addAccessControlAndAdmin() internal {
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](2);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(new AccessControlFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getAccessControlFacetSelectors()
        });
        cuts[1] = IDiamondCut.FacetCut({
            facetAddress: address(new AdminFacet()),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: helper.getAdminFacetSelectors()
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    /// @dev Read `LibPausable.PausableStorage.paused` directly via the
    ///      namespaced storage slot. Used to assert the
    ///      constructor's write before any facet that exposes
    ///      `paused()` has been added.
    function _pausedDirect() internal view returns (bool result) {
        // keccak256(abi.encode(uint256(keccak256("vaipakam.storage.Pausable")) - 1)) & ~bytes32(uint256(0xff))
        bytes32 slot =
            0x2160e84a745d8897ad2778886d40d3563c8bc30c059c5f2173e21e9d47057400;
        bytes32 raw = vm.load(address(diamond), slot);
        // First field of `PausableStorage` is `bool paused` — packed
        // in the low byte of slot 0.
        return uint256(raw) & 0xff != 0;
    }
}
