// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/**
 * @title  SanctionsActiveLenderFreezeTest
 * @notice #998 S10 (#1006) Class B — guardrail for the ACTIVE-loan inline
 *         lender-share pay-or-freeze hosts (`EncumbranceMutateFacet
 *         .freezeOrPayActiveLender{Resident,FromPayer,FromVault}`, the servicing
 *         paths in `RepayPeriodicFacet` / `RepayFacet`).
 *
 *         Per SanctionsTerminalizationRegister.md §3.3 (Class B), each inline
 *         payout path must, for a registry-flagged current holder:
 *           (a) FIRST-OBSERVATION (oracle up, fresh flag) — REGISTER the holder
 *               in `sanctionsConfirmedFlagged` AND park the share into the STORED
 *               `loan.lender`'s vault + `heldForLender` + encumbrance + marker;
 *           (b) OUTAGE (holder previously registered, oracle down) — park (never
 *               pay), holder EOA unchanged, claimable lane credited.
 *         A clean / never-confirmed holder is paid inline exactly as before.
 *
 *         The three variants differ only in the funds source (Diamond-resident,
 *         payer-`approve`, party-vault) and share `_parkActiveLenderShare`, so
 *         the resident variant carries the full scenario matrix and the payer /
 *         vault variants pin the funds-flow-specific freeze + inline-pay.
 */
contract SanctionsActiveLenderFreezeTest is SetupTest {
    uint256 internal constant LOAN_ID = 7777;
    uint256 internal constant LENDER_TOK = 0xB0B;
    uint256 internal constant AMOUNT = 1_000 ether;

    address internal storedLender = makeAddr("s10b-stored-lender");
    address internal holder = makeAddr("s10b-current-holder");
    address internal payer = makeAddr("s10b-payer");
    address internal cleanTransferee = makeAddr("s10b-clean-transferee");

    function setUp() public {
        setupHelper();
    }

    function _installOracle() internal returns (MockSanctionsList m) {
        m = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(m));
    }

    /// @dev Scaffold an Active ERC-20 loan whose current lender-position holder
    ///      (the intended inline payee) is `holder`, and whose STORED lender (the
    ///      park destination) is a distinct `storedLender`.
    function _scaffoldActiveLoan() internal {
        LibVaipakam.Loan memory l;
        l.id = LOAN_ID;
        l.lender = storedLender;
        l.borrower = borrower;
        l.status = LibVaipakam.LoanStatus.Active;
        l.lenderTokenId = LENDER_TOK;
        l.principalAsset = mockERC20;
        TestMutatorFacet(address(diamond)).setLoan(LOAN_ID, l);
        TestMutatorFacet(address(diamond)).mintNFTRaw(holder, LENDER_TOK);
    }

    function _lenderVaultBal() internal view returns (uint256) {
        address v = TestMutatorFacet(address(diamond)).getUserVaipakamVaultRaw(storedLender);
        if (v == address(0)) return 0;
        return ERC20Mock(mockERC20).balanceOf(v);
    }

    /// @dev Assert every Class B park side effect for a frozen holder: the share
    ///      is in the STORED lender's vault, credited to `heldForLender`, reserved
    ///      via the encumbrance, marked fail-closed, the holder is registered, and
    ///      the holder's own EOA received NOTHING (value did not leave to them).
    function _assertParked() internal {
        assertEq(ERC20Mock(mockERC20).balanceOf(holder), 0, "holder EOA must be untouched");
        assertEq(_lenderVaultBal(), AMOUNT, "share parked into stored lender vault");
        assertEq(
            TestMutatorFacet(address(diamond)).getHeldForLenderRaw(LOAN_ID),
            AMOUNT,
            "heldForLender credited"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getHeldForLenderEncumberedRaw(LOAN_ID),
            AMOUNT,
            "reserved via the DEDICATED active-held ledger"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLenderProceedsEncumberedRaw(LOAN_ID),
            0,
            "the single-asset TERMINAL ledger is left untouched by an active park"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getEncumberedRaw(storedLender, mockERC20, 0),
            AMOUNT,
            "reservation ticks the stored lender's asset-keyed aggregate"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getSanctionsFrozenClaimant(LOAN_ID, true),
            holder,
            "fail-closed marker keyed to the frozen holder"
        );
        assertTrue(
            ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(holder),
            "holder registered in confirmed-flagged registry"
        );
    }

    // ─── Resident variant (Diamond-held proceeds; periodic auto-liquidate) ────

    function test_resident_cleanHolder_paidInline() public {
        _installOracle(); // oracle set but holder never flagged
        _scaffoldActiveLoan();
        ERC20Mock(mockERC20).mint(address(diamond), AMOUNT);

        TestMutatorFacet(address(diamond)).callFreezeOrPayActiveLenderResident(
            LOAN_ID, mockERC20, AMOUNT
        );

        assertEq(ERC20Mock(mockERC20).balanceOf(holder), AMOUNT, "clean holder paid inline");
        assertEq(_lenderVaultBal(), 0, "nothing parked");
        assertEq(TestMutatorFacet(address(diamond)).getHeldForLenderRaw(LOAN_ID), 0, "no held");
        assertEq(
            TestMutatorFacet(address(diamond)).getSanctionsFrozenClaimant(LOAN_ID, true),
            address(0),
            "no marker for a clean holder"
        );
    }

    function test_resident_firstObservationFlagged_frozenAndRegistered() public {
        MockSanctionsList m = _installOracle();
        _scaffoldActiveLoan();
        m.setFlagged(holder, true); // oracle UP, fresh flag, holder NOT pre-registered
        assertFalse(
            ProfileFacet(address(diamond)).isSanctionsConfirmedFlagged(holder),
            "precondition: not yet registered"
        );
        ERC20Mock(mockERC20).mint(address(diamond), AMOUNT);

        TestMutatorFacet(address(diamond)).callFreezeOrPayActiveLenderResident(
            LOAN_ID, mockERC20, AMOUNT
        );

        _assertParked();
    }

    function test_resident_registeredDuringOutage_frozen() public {
        MockSanctionsList m = _installOracle();
        _scaffoldActiveLoan();
        m.setFlagged(holder, true);
        ProfileFacet(address(diamond)).refreshSanctionsFlag(holder); // register while up
        m.setRevertOnRead(true); // now an outage — fail-open screen would pay
        ERC20Mock(mockERC20).mint(address(diamond), AMOUNT);

        TestMutatorFacet(address(diamond)).callFreezeOrPayActiveLenderResident(
            LOAN_ID, mockERC20, AMOUNT
        );

        _assertParked(); // registry keeps it fail-CLOSED through the outage
    }

    // ─── FromPayer variant (payer `approve`; ERC-20 partial repay) ────────────

    function test_fromPayer_cleanHolder_paidInline() public {
        _installOracle();
        _scaffoldActiveLoan();
        ERC20Mock(mockERC20).mint(payer, AMOUNT);
        vm.prank(payer);
        ERC20Mock(mockERC20).approve(address(diamond), AMOUNT);

        TestMutatorFacet(address(diamond)).callFreezeOrPayActiveLenderFromPayer(
            LOAN_ID, payer, mockERC20, AMOUNT
        );

        assertEq(ERC20Mock(mockERC20).balanceOf(holder), AMOUNT, "clean holder paid from payer");
        assertEq(_lenderVaultBal(), 0, "nothing parked");
    }

    function test_fromPayer_firstObservationFlagged_frozen() public {
        MockSanctionsList m = _installOracle();
        _scaffoldActiveLoan();
        m.setFlagged(holder, true);
        ERC20Mock(mockERC20).mint(payer, AMOUNT);
        vm.prank(payer);
        ERC20Mock(mockERC20).approve(address(diamond), AMOUNT);

        TestMutatorFacet(address(diamond)).callFreezeOrPayActiveLenderFromPayer(
            LOAN_ID, payer, mockERC20, AMOUNT
        );

        assertEq(ERC20Mock(mockERC20).balanceOf(payer), 0, "payer funded the park");
        _assertParked();
    }

    // ─── FromVault variant (party vault; NFT-rental prepay) ───────────────────

    function test_fromVault_cleanHolder_paidInline() public {
        _installOracle();
        _scaffoldActiveLoan();
        _fundActorVault(borrower, mockERC20, AMOUNT);

        TestMutatorFacet(address(diamond)).callFreezeOrPayActiveLenderFromVault(
            LOAN_ID, borrower, mockERC20, AMOUNT
        );

        assertEq(ERC20Mock(mockERC20).balanceOf(holder), AMOUNT, "clean holder paid from vault");
        assertEq(_lenderVaultBal(), 0, "nothing parked");
    }

    function test_fromVault_firstObservationFlagged_frozen() public {
        MockSanctionsList m = _installOracle();
        _scaffoldActiveLoan();
        m.setFlagged(holder, true);
        _fundActorVault(borrower, mockERC20, AMOUNT);

        TestMutatorFacet(address(diamond)).callFreezeOrPayActiveLenderFromVault(
            LOAN_ID, borrower, mockERC20, AMOUNT
        );

        _assertParked();
    }

    /// A frozen park must never mint a NEW vault for the flagged current holder —
    /// the value lands in the STORED lender's vault, which is where the eventual
    /// `claimAsLender` folds `heldForLender` from once the holder de-lists.
    function test_frozenPark_doesNotCreateHolderVault() public {
        MockSanctionsList m = _installOracle();
        _scaffoldActiveLoan();
        m.setFlagged(holder, true);
        ERC20Mock(mockERC20).mint(address(diamond), AMOUNT);

        TestMutatorFacet(address(diamond)).callFreezeOrPayActiveLenderResident(
            LOAN_ID, mockERC20, AMOUNT
        );

        assertEq(
            TestMutatorFacet(address(diamond)).getUserVaipakamVaultRaw(holder),
            address(0),
            "no vault minted for the flagged holder"
        );
    }

    // ─── Dedicated-ledger regressions (fresh-round P1/P2 fixes) ───────────────

    /// F1 (P1) — a Class B active park (payment asset) and a later in-kind
    /// terminal reservation (collateral asset) must COEXIST on one loan. The
    /// dedicated active-held ledger is separate from the single-asset terminal
    /// `lenderProceedsEncumbered` ledger, so the terminal reserve does NOT trip the
    /// single-asset assert (which would revert the in-kind default and brick the
    /// loan). Both reservations land in their own asset-keyed aggregate.
    function test_activePark_thenInKindTerminalReserve_doesNotBrick() public {
        MockSanctionsList m = _installOracle();
        _scaffoldActiveLoan();
        m.setFlagged(holder, true);
        ERC20Mock(mockERC20).mint(address(diamond), AMOUNT);

        // Class B park reserves the PAYMENT asset via the dedicated ledger.
        TestMutatorFacet(address(diamond)).callFreezeOrPayActiveLenderResident(
            LOAN_ID, mockERC20, AMOUNT
        );

        // A later in-kind default reserves the COLLATERAL asset through the
        // terminal ledger — this used to trip `encumberLenderProceeds`'s
        // single-asset assert when the active park had (wrongly) shared it.
        TestMutatorFacet(address(diamond)).callEncumberLenderProceeds(
            LOAN_ID, storedLender, mockCollateralERC20, 500 ether
        );

        assertEq(
            TestMutatorFacet(address(diamond)).getHeldForLenderEncumberedRaw(LOAN_ID),
            AMOUNT,
            "active-held reservation intact (payment asset)"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getLenderProceedsEncumberedRaw(LOAN_ID),
            500 ether,
            "terminal reservation recorded (collateral asset) with no assert revert"
        );
        // Both aggregates ticked independently.
        assertEq(
            TestMutatorFacet(address(diamond)).getEncumberedRaw(storedLender, mockERC20, 0),
            AMOUNT,
            "payment-asset aggregate"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getEncumberedRaw(storedLender, mockCollateralERC20, 0),
            500 ether,
            "collateral-asset aggregate"
        );
    }

    /// F3 (P2) — when the lender position migrates (consolidation / sale), the
    /// active-held reservation must follow the held to the new holder: the
    /// aggregate moves old → new while the per-loan record stays put, so a later
    /// `releaseActiveHeld(loanId, loan.lender)` (now the new holder) unwinds the
    /// right bucket. Covers EVERY asset, not just VPFI.
    function test_activeHeldReservation_migratesToNewHolder() public {
        MockSanctionsList m = _installOracle();
        _scaffoldActiveLoan();
        m.setFlagged(holder, true);
        ERC20Mock(mockERC20).mint(address(diamond), AMOUNT);
        TestMutatorFacet(address(diamond)).callFreezeOrPayActiveLenderResident(
            LOAN_ID, mockERC20, AMOUNT
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getEncumberedRaw(storedLender, mockERC20, 0),
            AMOUNT,
            "precondition: reserved on the stored lender"
        );

        // Simulate the reservation half of a consolidation/sale migration.
        TestMutatorFacet(address(diamond)).callMigrateActiveHeld(LOAN_ID, cleanTransferee);

        assertEq(
            TestMutatorFacet(address(diamond)).getEncumberedRaw(storedLender, mockERC20, 0),
            0,
            "old lender no longer over-locked"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getEncumberedRaw(cleanTransferee, mockERC20, 0),
            AMOUNT,
            "reservation followed the held to the new holder"
        );
        assertEq(
            TestMutatorFacet(address(diamond)).getHeldForLenderEncumberedRaw(LOAN_ID),
            AMOUNT,
            "per-loan record unchanged (loan-keyed)"
        );
    }
}
