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

    /// Codex #1126 r4 P2: a directly-flagged wallet whose recovery-SOURCE read
    /// reverts must still be caught by the authoritative DIRECT read — the source
    /// outage must not mask a direct flag. `refreshSanctionsFlag` registers it.
    function test_refresh_sourceOutageDoesNotMaskDirectFlag() public {
        MockSanctionsList m = _oracle();
        address src = makeAddr("s1123-banned-source");
        TestMutatorFacet(address(diamond)).setVaultBannedSourceRaw(wallet, src);
        m.setRevertFor(src, true); // source read unreachable...
        m.setFlagged(wallet, true); // ...but the wallet itself is authoritatively flagged
        ProfileFacet(address(diamond)).refreshSanctionsFlag(wallet);
        assertTrue(
            ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(wallet),
            "direct flag registered despite the source-read outage"
        );
    }

    /// Complementary: source read reverts AND the direct read is clean → the
    /// recovery-ban flag is unknowable, so the status is Unavailable (refresh
    /// reverts, registry untouched) — a clean direct read must NOT clear it.
    function test_refresh_sourceOutageWithCleanDirect_isUnavailable() public {
        MockSanctionsList m = _oracle();
        address src = makeAddr("s1123-banned-source-2");
        TestMutatorFacet(address(diamond)).setVaultBannedSourceRaw(wallet, src);
        m.setRevertFor(src, true); // source unreachable
        // wallet direct read is clean (default) — cannot confirm OR clear.
        vm.expectRevert(IVaipakamErrors.SanctionsOracleUnavailable.selector);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(wallet);
        assertFalse(ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(wallet));
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

    // ─── #1144 isRecipientBarred — outage-only registry semantics (Codex r1 P2) ──

    function _register(MockSanctionsList m) internal {
        m.setFlagged(wallet, true);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(wallet); // registry marked
    }

    function test_isRecipientBarred_oracleUpFlagged_bars() public {
        MockSanctionsList m = _oracle();
        m.setFlagged(wallet, true); // authoritative Flagged, no registry entry needed
        assertTrue(ProfileFacet(address(diamond)).isRecipientBarred(wallet));
    }

    function test_isRecipientBarred_outageWithMarker_bars() public {
        MockSanctionsList m = _oracle();
        _register(m);
        m.setRevertOnRead(true); // genuine outage — oracle set but unreachable
        assertTrue(
            ProfileFacet(address(diamond)).isRecipientBarred(wallet),
            "a committed marker MUST bar during an outage"
        );
    }

    function test_isRecipientBarred_outageNoMarker_doesNotBar() public {
        MockSanctionsList m = _oracle(); // wallet clean, never registered
        m.setRevertOnRead(true);
        assertFalse(
            ProfileFacet(address(diamond)).isRecipientBarred(wallet),
            "an unregistered wallet MUST settle through an outage"
        );
    }

    function test_isRecipientBarred_oracleUpClean_ignoresStaleMarker() public {
        MockSanctionsList m = _oracle();
        _register(m);
        m.setFlagged(wallet, false); // oracle now reads CLEAN, marker not yet refreshed
        assertFalse(
            ProfileFacet(address(diamond)).isRecipientBarred(wallet),
            "an oracle-up clean read MUST ignore a stale marker"
        );
    }

    function test_isRecipientBarred_disabledRegime_ignoresRegistry() public {
        MockSanctionsList m = _oracle();
        _register(m);
        ProfileFacet(address(diamond)).setSanctionsOracle(address(0)); // regime disabled
        assertFalse(
            ProfileFacet(address(diamond)).isRecipientBarred(wallet),
            "a disabled regime MUST ignore the committed registry entirely"
        );
    }
}
