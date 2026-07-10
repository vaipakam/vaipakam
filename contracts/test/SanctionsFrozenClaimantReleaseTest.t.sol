// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  SanctionsFrozenClaimantReleaseTest
 * @notice #998 S10 (#1006) — focused unit tests for the FAIL-CLOSED release gate
 *         on sanctioned-locked proceeds. Uses `TestMutatorFacet` to scaffold a
 *         terminal loan + a frozen-claimant marker directly, so the gate can be
 *         exercised in isolation (it runs BEFORE the position-NFT owner check in
 *         `_claimAsLenderImpl` / `claimAsBorrower`, so no NFT/claim/vault
 *         scaffolding is needed to reach it).
 *
 *         The load-bearing "confirmed freeze survives an oracle outage while an
 *         ordinary never-locked claim on a different loan stays fail-open" and
 *         the "de-list → real release clears the marker" assertions are covered
 *         end-to-end against a real close-out in `DefaultedFacetTest`; here we
 *         pin the gate's exact revert semantics, including the crux
 *         transfer-during-outage laundering case (the gate keys on the RECORDED
 *         frozen address, never on `msg.sender`).
 */
contract SanctionsFrozenClaimantReleaseTest is SetupTest {
    uint256 internal constant LOAN_ID = 4242;

    address internal frozenParty = makeAddr("s10-frozen-party");
    address internal cleanTransferee = makeAddr("s10-clean-transferee");

    function setUp() public {
        setupHelper();
    }

    function _installOracle() internal returns (MockSanctionsList m) {
        m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
    }

    /// @dev Scaffold a terminal (Defaulted) loan so `_claimAsLenderImpl` /
    ///      `claimAsBorrower` pass the status gate + already-claimed guard and
    ///      reach the S10 release gate.
    function _scaffoldTerminalLoan() internal {
        LibVaipakam.Loan memory l;
        l.id = LOAN_ID;
        l.lender = lender;
        l.borrower = borrower;
        l.status = LibVaipakam.LoanStatus.Defaulted;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, l);
    }

    /// @dev Codex #1122-rework r3 (central claim-gate stamp): a claim whose
    ///      close-out stamped NO marker must STILL fail-closed when the current
    ///      claimant is a registry-confirmed flagged wallet and the oracle is down.
    ///      The claim gate stamps the current holder + re-checks in one step, so a
    ///      registered claimant is caught regardless of which path created the claim
    ///      (fallback collateral, retry top-up fold, offset borrower, …).
    function test_lenderClaimGate_stampsRegisteredHolder_noPriorMarker() public {
        uint256 lenderTok = 0x1AF;
        LibVaipakam.Loan memory l;
        l.id = LOAN_ID;
        l.lender = frozenParty;
        l.borrower = borrower;
        l.status = LibVaipakam.LoanStatus.Defaulted;
        l.lenderTokenId = lenderTok;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, l);
        // Real lender NFT so the gate's ownerOf-keyed stamp resolves the claimant.
        TestMutatorFacet(address(diamond)).mintNFTRaw(frozenParty, lenderTok);

        MockSanctionsList m = _installOracle();
        m.setFlagged(frozenParty, true);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(frozenParty); // registered
        // No S10 marker was ever recorded for this loan.
        assertEq(
            TestMutatorFacet(address(diamond)).getSanctionsFrozenClaimant(LOAN_ID, true),
            address(0),
            "no prior close-out marker"
        );

        m.setRevertOnRead(true); // outage

        // The gate stamps the registered claimant then fail-closes on the fresh marker.
        vm.prank(frozenParty);
        vm.expectRevert(IVaipakamErrors.SanctionsOracleUnavailable.selector);
        ClaimFacet(address(diamond)).claimAsLender(LOAN_ID);
    }

    // ─── Lender side ────────────────────────────────────────────────────────

    /// LOAD-BEARING: a confirmed-at-park freeze must NOT lift during an oracle
    /// outage — the fail-closed screen reverts instead of the ordinary fail-open
    /// pass-through.
    function test_lockedLenderRelease_revertsOnOracleOutage() public {
        MockSanctionsList m = _installOracle();
        _scaffoldTerminalLoan();
        m.setFlagged(frozenParty, true);
        TestMutatorFacet(address(diamond)).setSanctionsFrozenClaimant(
            LOAN_ID, true, frozenParty
        );

        m.setRevertOnRead(true); // outage

        // Even the frozen party themselves calling gets a fail-closed revert.
        vm.prank(frozenParty);
        vm.expectRevert(IVaipakamErrors.SanctionsOracleUnavailable.selector);
        ClaimFacet(address(diamond)).claimAsLender(LOAN_ID);
    }

    /// A confirmed freeze with the oracle UNSET (operator cleared it) stays
    /// closed — we will not release confirmed-locked funds without a live oracle.
    function test_lockedLenderRelease_revertsWhenOracleUnset() public {
        // Marker set while an oracle existed; operator then unsets it.
        MockSanctionsList m = _installOracle();
        _scaffoldTerminalLoan();
        m.setFlagged(frozenParty, true);
        TestMutatorFacet(address(diamond)).setSanctionsFrozenClaimant(
            LOAN_ID, true, frozenParty
        );
        ProfileFacet(address(diamond)).setSanctionsOracle(address(0));

        vm.prank(cleanTransferee);
        vm.expectRevert(IVaipakamErrors.SanctionsOracleUnavailable.selector);
        ClaimFacet(address(diamond)).claimAsLender(LOAN_ID);
    }

    /// CRUX laundering case — a flagged holder transfers the position to a clean
    /// wallet during an outage. The clean transferee's own screen passes, but the
    /// gate keys on the RECORDED frozen address, so it still fails closed. Proven
    /// here with the oracle UP and the recorded party STILL flagged: the revert is
    /// `SanctionedAddress(frozenParty)` even though `msg.sender` is clean.
    function test_lockedLenderRelease_failsClosedOnRecordedAddr_notCaller() public {
        MockSanctionsList m = _installOracle();
        _scaffoldTerminalLoan();
        m.setFlagged(frozenParty, true); // recorded party still listed
        // cleanTransferee is NOT flagged — the ordinary msg.sender screen passes.
        TestMutatorFacet(address(diamond)).setSanctionsFrozenClaimant(
            LOAN_ID, true, frozenParty
        );

        vm.prank(cleanTransferee);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, frozenParty)
        );
        ClaimFacet(address(diamond)).claimAsLender(LOAN_ID);
    }

    /// Same crux under an OUTAGE — the recorded party can't be proven clean, so
    /// the release stays closed (fail-closed), whoever holds the NFT now.
    function test_lockedLenderRelease_launderingDuringOutage_failsClosed() public {
        MockSanctionsList m = _installOracle();
        _scaffoldTerminalLoan();
        m.setFlagged(frozenParty, true);
        TestMutatorFacet(address(diamond)).setSanctionsFrozenClaimant(
            LOAN_ID, true, frozenParty
        );
        m.setRevertOnRead(true);

        vm.prank(cleanTransferee);
        vm.expectRevert(IVaipakamErrors.SanctionsOracleUnavailable.selector);
        ClaimFacet(address(diamond)).claimAsLender(LOAN_ID);
    }

    // ─── Borrower side ──────────────────────────────────────────────────────

    function test_lockedBorrowerRelease_revertsOnOracleOutage() public {
        MockSanctionsList m = _installOracle();
        _scaffoldTerminalLoan();
        m.setFlagged(frozenParty, true);
        TestMutatorFacet(address(diamond)).setSanctionsFrozenClaimant(
            LOAN_ID, false, frozenParty
        );
        m.setRevertOnRead(true);

        vm.prank(cleanTransferee);
        vm.expectRevert(IVaipakamErrors.SanctionsOracleUnavailable.selector);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN_ID);
    }

    /// The lender-side marker must not gate a BORROWER claim (per-side mapping):
    /// a borrower claim on a loan whose LENDER side is frozen carries no borrower
    /// marker, so the S10 gate is skipped (the claim then reverts DOWNSTREAM on
    /// the ordinary NFT-owner check, NOT on the sanctions gate).
    function test_lenderMarker_doesNotGateBorrowerClaim() public {
        MockSanctionsList m = _installOracle();
        _scaffoldTerminalLoan();
        m.setFlagged(frozenParty, true);
        TestMutatorFacet(address(diamond)).setSanctionsFrozenClaimant(
            LOAN_ID, true, frozenParty // LENDER side only
        );
        m.setRevertOnRead(true);

        // Borrower side has no marker → gate skipped even during the outage.
        // Reaches `requireBorrowerNftOwner` and reverts there (no minted NFT),
        // proving the borrower path stayed fail-open at the sanctions gate.
        vm.prank(cleanTransferee);
        vm.expectRevert(); // NOT SanctionsOracleUnavailable — a downstream revert
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN_ID);
    }

    /// An ordinary loan with NO marker never touches the fail-closed screen, so an
    /// oracle outage doesn't brick the claim at the sanctions gate — it falls
    /// through to the normal (downstream) claim checks.
    function test_noMarker_lenderClaimNotBlockedBySanctionsGateDuringOutage() public {
        MockSanctionsList m = _installOracle();
        _scaffoldTerminalLoan();
        m.setRevertOnRead(true); // outage, but no marker recorded

        // The S10 gate is skipped (marker == address(0)); the claim reverts on the
        // downstream NFT-owner resolution, NOT with SanctionsOracleUnavailable.
        vm.prank(lender);
        try ClaimFacet(address(diamond)).claimAsLender(LOAN_ID) {
            revert("claim unexpectedly succeeded");
        } catch (bytes memory reason) {
            bytes4 sel = bytes4(reason);
            assertTrue(
                sel != IVaipakamErrors.SanctionsOracleUnavailable.selector,
                "no-marker claim must not fail closed at the sanctions gate"
            );
        }
    }

    /// Marker read/clear round-trip via the test getter (documents the storage
    /// contract the release gate depends on).
    function test_markerMappingRoundTrips() public {
        _scaffoldTerminalLoan();
        assertEq(
            TestMutatorFacet(address(diamond)).getSanctionsFrozenClaimant(LOAN_ID, true),
            address(0),
            "unset marker reads zero"
        );
        TestMutatorFacet(address(diamond)).setSanctionsFrozenClaimant(
            LOAN_ID, true, frozenParty
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getSanctionsFrozenClaimant(LOAN_ID, true),
            frozenParty,
            "lender marker round-trips"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getSanctionsFrozenClaimant(LOAN_ID, false),
            address(0),
            "borrower side is independent of the lender marker"
        );
    }
}
