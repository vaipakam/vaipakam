// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  SanctionsFailClosedTransferTest
 * @notice #1123 — the confirmed-flagged-wallet registry + FAIL-CLOSED
 *         position-movement gate. A wallet confirmed sanctioned while the oracle
 *         was reachable cannot move a position NFT during an oracle outage — the
 *         foundation that lets the S10 marker (#1006) stay a simple single
 *         first-write address (no laundering chains).
 *
 *         The gate runs BEFORE the ERC-721 ownership check in `transferFrom`, so
 *         a blocked party reverts `SanctionedAddress` regardless of token state;
 *         the allow paths mint a real token so the transfer actually completes.
 */
contract SanctionsFailClosedTransferTest is SetupTest {
    address internal wallet = makeAddr("s1123-wallet");
    address internal recipient = makeAddr("s1123-recipient");
    uint256 internal constant TOK = 0xF00D;

    function setUp() public {
        setupHelper();
    }

    function _oracle() internal returns (MockSanctionsList m) {
        m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
    }

    // ─── refreshSanctionsFlag (registry sync) ────────────────────────────────

    function test_refresh_registersFlagged() public {
        MockSanctionsList m = _oracle();
        m.setFlagged(wallet, true);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(wallet);
        assertTrue(ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(wallet));
    }

    function test_refresh_clearsOnDelist() public {
        MockSanctionsList m = _oracle();
        m.setFlagged(wallet, true);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(wallet);
        assertTrue(ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(wallet));
        // De-list at the oracle, then refresh → registry entry cleared.
        m.setFlagged(wallet, false);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(wallet);
        assertFalse(ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(wallet));
    }

    function test_refresh_revertsWhenOracleUnset() public {
        // No oracle configured → cannot authoritatively read → must not mutate.
        vm.expectRevert(IVaipakamErrors.SanctionsOracleUnavailable.selector);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(wallet);
    }

    function test_refresh_revertsOnOutage_doesNotClear() public {
        MockSanctionsList m = _oracle();
        m.setFlagged(wallet, true);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(wallet); // registered
        m.setRevertOnRead(true); // outage
        vm.expectRevert(IVaipakamErrors.SanctionsOracleUnavailable.selector);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(wallet);
        // The revert rolled back any mutation → still registered (no wrongful clear).
        m.setRevertOnRead(false);
        assertTrue(ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(wallet));
    }

    // ─── Movement gate — block paths (gate precedes the ownership check) ─────

    function test_transfer_flaggedRevertsNormalOp() public {
        MockSanctionsList m = _oracle();
        m.setFlagged(wallet, true);
        vm.prank(wallet);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, wallet)
        );
        VaipakamNFTFacet(address(diamond)).transferFrom(wallet, recipient, TOK);
    }

    /// LOAD-BEARING: a wallet REGISTERED while the oracle was up cannot move a
    /// position during an oracle outage (fail-closed on the registry).
    function test_transfer_registeredRevertsDuringOutage() public {
        MockSanctionsList m = _oracle();
        m.setFlagged(wallet, true);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(wallet); // register while up
        m.setRevertOnRead(true); // outage
        vm.prank(wallet);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, wallet)
        );
        VaipakamNFTFacet(address(diamond)).transferFrom(wallet, recipient, TOK);
    }

    // ─── Movement gate — allow paths (real token; transfer completes) ────────

    function test_transfer_unregisteredAllowedDuringOutage() public {
        MockSanctionsList m = _oracle(); // wallet is clean + never registered
        TestMutatorFacet(address(diamond)).mintNFTRaw(wallet, TOK);
        m.setRevertOnRead(true); // outage
        vm.prank(wallet);
        VaipakamNFTFacet(address(diamond)).transferFrom(wallet, recipient, TOK);
        assertEq(VaipakamNFTFacet(address(diamond)).ownerOf(TOK), recipient);
    }

    function test_transfer_oracleUnsetIgnoresRegistry() public {
        MockSanctionsList m = _oracle();
        m.setFlagged(wallet, true);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(wallet); // registered
        // Governance disables screening entirely → registry must be ignored.
        ProfileFacet(address(diamond)).setSanctionsOracle(address(0));
        TestMutatorFacet(address(diamond)).mintNFTRaw(wallet, TOK);
        vm.prank(wallet);
        VaipakamNFTFacet(address(diamond)).transferFrom(wallet, recipient, TOK);
        assertEq(VaipakamNFTFacet(address(diamond)).ownerOf(TOK), recipient);
    }

    /// Self-heal: an authoritative-clean move clears a stale registry entry.
    function test_transfer_cleanMoveSelfHealsRegistry() public {
        MockSanctionsList m = _oracle();
        m.setFlagged(wallet, true);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(wallet); // registered
        m.setFlagged(wallet, false); // de-listed at the oracle (oracle up)
        TestMutatorFacet(address(diamond)).mintNFTRaw(wallet, TOK);
        vm.prank(wallet);
        VaipakamNFTFacet(address(diamond)).transferFrom(wallet, recipient, TOK);
        assertEq(VaipakamNFTFacet(address(diamond)).ownerOf(TOK), recipient);
        assertFalse(
            ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(wallet),
            "clean move self-heal-cleared the stale registry entry"
        );
    }

    // ─── Host is self-only ───────────────────────────────────────────────────

    function test_enforceHost_selfOnly() public {
        vm.expectRevert(ProfileFacet.OnlyDiamondInternal.selector);
        ProfileFacet(address(diamond)).enforcePositionMoveNotSanctioned(wallet, recipient);
    }
}
