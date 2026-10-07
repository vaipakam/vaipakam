// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "../SetupTest.t.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {IVaipakamErrors} from "../../src/interfaces/IVaipakamErrors.sol";
import {TestnetSanctionsOverlay} from "../../src/compliance/TestnetSanctionsOverlay.sol";
import {MockSanctionsList} from "../mocks/MockSanctionsList.sol";

/**
 * @title  TestnetSanctionsOverlayDiamondTest
 * @notice #2439 — a real Diamond configured with the overlay screens exactly as
 *         it would against a real oracle: either list's flag is seen, a Tier-1
 *         entry point refuses an overlay-flagged wallet, and an upstream outage
 *         reaches the fail-open screen as "not flagged" and the fail-closed
 *         registry sync as "unavailable" — the same split the real oracle gets.
 */
contract TestnetSanctionsOverlayDiamondTest is SetupTest {
    MockSanctionsList internal upstream;
    TestnetSanctionsOverlay internal overlay;
    address internal tester = makeAddr("overlay-flagged-tester");
    address internal clean = makeAddr("clean-wallet");

    function setUp() public {
        setupHelper();
        upstream = new MockSanctionsList();
        overlay = new TestnetSanctionsOverlay(owner, address(upstream));
        ProfileFacet(address(diamond)).setSanctionsOracle(address(overlay));
    }

    function _profile() internal view returns (ProfileFacet) {
        return ProfileFacet(address(diamond));
    }

    function test_AnOverlayFlag_IsSeenByTheDiamond_AndClears() public {
        assertFalse(_profile().isSanctionedAddress(tester));
        overlay.setFlagged(tester, true);
        assertTrue(_profile().isSanctionedAddress(tester));
        overlay.setFlagged(tester, false);
        assertFalse(_profile().isSanctionedAddress(tester));
    }

    function test_AnUpstreamFlag_IsSeenByTheDiamond() public {
        upstream.setFlagged(tester, true);
        assertTrue(_profile().isSanctionedAddress(tester));
    }

    /// @notice The live-test purpose of the overlay: a wallet the admin flags
    ///         is refused at a Tier-1 entry point.
    function test_AnOverlayFlaggedWallet_IsRefusedAtVaultCreation() public {
        overlay.setFlagged(tester, true);
        vm.prank(tester);
        vm.expectRevert(abi.encodeWithSelector(ProfileFacet.SanctionedAddress.selector, tester));
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(tester);
    }

    /// @notice ...and the same wallet, cleared, is not.
    function test_AClearedWallet_CreatesItsVault() public {
        overlay.setFlagged(tester, true);
        overlay.setFlagged(tester, false);
        vm.prank(tester);
        address vault = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(tester);
        assertTrue(vault != address(0));
    }

    /// @notice An upstream outage reaches the Diamond's fail-open screen as
    ///         "not flagged" for an address the overlay has not flagged.
    function test_UpstreamOutage_FailOpenScreenReadsNotFlagged() public {
        upstream.setRevertOnRead(true);
        assertFalse(_profile().isSanctionedAddress(clean));
    }

    /// @notice ...and the fail-closed registry sync as "unavailable", as it
    ///         would against a real oracle directly.
    function test_UpstreamOutage_FailClosedSyncReadsUnavailable() public {
        upstream.setRevertOnRead(true);
        vm.expectRevert(IVaipakamErrors.SanctionsOracleUnavailable.selector);
        _profile().refreshSanctionsFlag(clean);
    }

    /// @notice The registry sync records an overlay flag like any other, so the
    ///         outage-time position restriction can be rehearsed live.
    function test_RegistrySync_RecordsAnOverlayFlag() public {
        overlay.setFlagged(tester, true);
        _profile().refreshSanctionsFlag(tester);
        assertTrue(_profile().isSanctionsConfirmedFlagged(tester));
        overlay.setFlagged(tester, false);
        _profile().refreshSanctionsFlag(tester);
        assertFalse(_profile().isSanctionsConfirmedFlagged(tester));
    }
}
