// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {LoanLedgerHandler} from "./LoanLedgerHandler.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

/**
 * @title  LoanSettlementBoundInvariant
 * @notice #3241: no loan pays out more than entered it. Supply conservation
 *         (`FundsConservation`) cannot see one user being paid out of another user's funds, or a
 *         loan's parties together drawing on protocol money; this suite books every balance
 *         change against the loan that caused it ({LoanLedgerHandler}) and checks, after every
 *         call:
 *
 *         S1 -- per action, no actor outside the loan's two parties has its holdings (wallet +
 *               vault) move, and nothing crosses the tracked perimeter.
 *         S2 -- per loan and asset, the Diamond (protocol custody and, in this rig, the treasury)
 *               has never paid out more than it took in: its booked delta is never negative.
 *         S3 -- per loan and asset, the booked deltas sum to zero: what one party gained, another
 *               party lost. (S1 makes this hold; it is asserted so a gap in S1 cannot hide.)
 *         S4 -- collateral: neither the lender nor the caller of a permissionless step has gained
 *               more collateral than the borrower posted for this loan (initial plus top-ups), and
 *               the borrower has not lost more than that.
 *         S5 -- principal asset: the lender's net gain is at most the interest the principal
 *               could have earned since origination plus the 5% late-fee cap (spec "Interest
 *               Formula", "Late Fees"); the borrower never nets more than the principal lent.
 *         S6 -- a Repaid loan has made its lender whole: the lender's net in the principal asset
 *               is not negative.
 *         S7 -- origination and on-time repayment are exact (counters kept by the handler): the
 *               borrower is charged the 0.2% Loan Initiation Fee, the acceptor gets its 1%
 *               matcher share, the Diamond keeps the rest, and an on-time full repayment pays
 *               exactly the interest the spec formula gives, rounded down once.
 *
 *         Paths covered are the shared handler's: offer posting, both accept directions, full and
 *         partial repayment, the direct preclose, collateral top-up, time-based default (the rig has no working swap
 *         venue, so default reaches the in-kind fallback) and both claims. Periodic interest,
 *         the preclose offset, refinance, the lender sale, rentals and HF liquidation are not yet
 *         driven; #3241 tracks them, and the vault outflow seam (#3205) is where this check is
 *         meant to bind every one of them.
 *
 * @dev    Run: `forge test --match-path test/invariants/LoanSettlementBound.invariant.t.sol`
 *         (the `cifast` profile does not compile `test/invariants`).
 */
contract LoanSettlementBoundInvariant is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant LATE_FEE_CAP_BPS = 500;
    uint256 internal constant USDC = 0;
    uint256 internal constant WETH = 1;

    InvariantBase internal base;
    LoanLedgerHandler internal ledger;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        ledger = new LoanLedgerHandler(base);
        targetContract(address(ledger));
    }

    /// @notice S1 + S7: the per-action checks the handler counts.
    function invariant_PerActionChecksHold() public view {
        string memory why = ledger.firstViolation();
        assertEq(ledger.isolationViolations(), 0, why);
        assertEq(ledger.perimeterViolations(), 0, why);
        assertEq(ledger.acceptViolations(), 0, why);
        assertEq(ledger.interestViolations(), 0, why);
    }

    /// @notice S2-S6 over every booked loan.
    function invariant_NoLoanPaysOutMoreThanEnteredIt() public view {
        uint256 n = ledger.bookedLoanCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = ledger.bookedLoanIds(i);
            _checkLoan(loanId);
        }
    }

    function _checkLoan(uint256 loanId) internal view {
        (uint256 principal0, uint256 rateBps, uint64 startTime, uint256 collateralIn, uint256 lastTs) =
            ledger.loanTerms(loanId);

        for (uint256 a = 0; a < 2; a++) {
            (int256 dL, int256 dB, int256 dD, int256 dC) = ledger.loanDeltas(loanId, a);
            // S2
            assertGe(dD, 0, "S2: the Diamond paid a loan more than it took in");
            // S3
            assertEq(dL + dB + dD + dC, 0, "S3: a loan's booked deltas do not net to zero");
        }

        // S4 -- collateral
        {
            (int256 dL, int256 dB,, int256 dC) = ledger.loanDeltas(loanId, WETH);
            int256 posted = int256(collateralIn);
            assertLe(dL, posted, "S4: lender gained more collateral than was posted");
            assertLe(dC, posted, "S4: caller gained more collateral than was posted");
            assertGe(dB, -posted, "S4: borrower lost more collateral than was posted");
        }

        // S5 / S6 -- principal asset
        {
            (int256 dL, int256 dB,,) = ledger.loanDeltas(loanId, USDC);
            uint256 elapsed = lastTs > startTime ? lastTs - startTime : 0;
            // Floors only lower what is owed, and partials only lower the principal, so the
            // unfloored figure on the original principal bounds every settlement's sum. The
            // +1 allows the late fee to be rounded up in the protocol's favour.
            uint256 cap = (principal0 * rateBps * elapsed) / (YEAR * BPS)
                + (principal0 * LATE_FEE_CAP_BPS) / BPS + 1;
            assertLe(dL, int256(cap), "S5: lender gained more than interest plus the late-fee cap");
            assertLe(dB, int256(principal0), "S5: borrower netted more than the principal lent");

            LibVaipakam.Loan memory L = LoanFacet(address(base.diamond())).getLoanDetails(loanId);
            if (L.status == LibVaipakam.LoanStatus.Repaid) {
                assertGe(dL, 0, "S6: a repaid loan left its lender short");
            }
        }
    }

    /// @notice Coverage readout: an invariant over a path the run never took proves nothing.
    function afterInvariant() external view {
        console.log("booked loans", ledger.bookedLoanCount());
        console.log("booked actions", ledger.bookedActions());
        console.log("accept checks", ledger.acceptChecks());
        console.log("exact-interest checks", ledger.interestChecks());
        console.log("preclosed loans", ledger.precloseLanded());
    }

    // ── Deterministic proofs that the checks are live ──────────────────

    /// @notice One loan through accept, an on-time repay and both claims: every per-action
    ///         check runs, and the books hold.
    function test_LedgerBooksOneLoanEndToEnd() public {
        ledger.createLenderOffer(0, 1_000 ether, 30, 1_000, 10 ether);
        ledger.acceptLenderOffer(0, 0);
        assertEq(ledger.bookedLoanCount(), 1, "loan not booked");
        assertEq(ledger.acceptChecks(), 1, "accept check did not run");

        ledger.warp(10 days);
        ledger.repay(0);
        assertEq(ledger.interestChecks(), 1, "exact-interest check did not run");

        ledger.claimAsLender(0);
        ledger.claimAsBorrower(0);

        invariant_PerActionChecksHold();
        invariant_NoLoanPaysOutMoreThanEnteredIt();
    }

    /// @notice #3241: a direct preclose before the due time pays exactly the interest accrued to
    ///         the second, and the books hold through both claims.
    function test_LedgerBooksAPreclosedLoan() public {
        ledger.createLenderOffer(0, 1_000 ether, 30, 1_000, 10 ether);
        ledger.acceptLenderOffer(0, 0);
        ledger.warp(5 days);
        ledger.precloseDirect(0);
        assertEq(ledger.precloseLanded(), 1, "preclose did not land");
        assertEq(ledger.interestChecks(), 1, "exact-interest check did not run on the preclose");

        ledger.claimAsLender(0);
        ledger.claimAsBorrower(0);

        invariant_PerActionChecksHold();
        invariant_NoLoanPaysOutMoreThanEnteredIt();
    }

    /// @notice A default reaches the in-kind fallback; the collateral bounds and the Diamond
    ///         bound hold through both claims.
    function test_LedgerBooksADefaultedLoan() public {
        ledger.createBorrowerOffer(1, 1_000 ether, 7, 1_000, 10 ether);
        ledger.acceptBorrowerOffer(1, 0);
        assertEq(ledger.bookedLoanCount(), 1, "loan not booked");

        ledger.triggerDefault(0);
        uint256 loanId = ledger.bookedLoanIds(0);
        LibVaipakam.LoanStatus st = LoanFacet(address(base.diamond())).getLoanDetails(loanId).status;
        assertTrue(st != LibVaipakam.LoanStatus.Active, "default did not land");
        (int256 dLw,,,) = ledger.loanDeltas(loanId, WETH);
        ledger.claimAsLender(0);
        ledger.claimAsBorrower(0);
        (int256 dLw2,,,) = ledger.loanDeltas(loanId, WETH);
        assertGt(dLw2, dLw, "lender received no collateral from the default");

        invariant_PerActionChecksHold();
        invariant_NoLoanPaysOutMoreThanEnteredIt();
    }
}
