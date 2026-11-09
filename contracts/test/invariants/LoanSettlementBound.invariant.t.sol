// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {LoanLedgerHandler} from "./LoanLedgerHandler.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC4907} from "../../src/interfaces/IERC4907.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";

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
 *         S8 -- a periodic-interest settlement whose period is paid moves nothing; one that sells
 *               pays the lender side at most the shortfall and no collateral, and the market (the
 *               rig's one working venue) buys at most the preview's `maxSell` and pays only
 *               principal asset. Every bound above counts the market as a party.
 *
 *         Paths covered are the shared handler's: offer posting (about half the long, large
 *         offers carry a monthly cadence), both accept directions, full and partial repayment,
 *         the direct preclose, collateral top-up, the lender's direct sale, the periodic-interest
 *         settlement, time-based default and HF liquidation (both name the failing venue, so
 *         they reach the in-kind fallback), the preclose offset, the refinance and both claims.
 *         An offset
 *         accept is one action over two loans: the ledger gives the new loan exactly its
 *         origination (so its LIF is checked as on any accept) and books every other movement
 *         against the loan it closes, whose lender cap then runs to the end of the original
 *         term (the offset pays the rest of the term's interest the new offer does not earn).
 *         One offset accept is not driven: an acceptor that already holds the closing loan's
 *         lender side, whose single delta cannot be split between its two roles.
 *         A refinance accept is also one action over two loans, with the borrower on both: the
 *         replacement loan's borrower is credited the net principal the contract states it
 *         paid the original lender, so the replacement's LIF is checked as on any lender accept,
 *         and the rest of the borrower's delta is the original loan's payoff, which must be
 *         exact when it closes on time with no partial. The same two-role case is not driven
 *         (an acceptor already on the closing loan's lender side).
 *         Rentals are not yet driven; #3241 tracks them, and the vault outflow seam (#3205) is
 *         where this check is meant to bind every path.
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
        assertEq(ledger.periodicViolations(), 0, why);
        assertEq(ledger.offsetViolations(), 0, why);
        assertEq(ledger.refinanceViolations(), 0, why);
        assertEq(ledger.rentalViolations(), 0, why);
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
            (int256 dM,) = ledger.loanMarket(loanId, a);
            // S2
            assertGe(dD, 0, "S2: the Diamond paid a loan more than it took in");
            // S3 (the market counts as a party)
            assertEq(dL + dB + dD + dC + dM, 0, "S3: a loan's booked deltas do not net to zero");
        }

        // S4 -- collateral
        {
            (int256 dL, int256 dB,, int256 dC) = ledger.loanDeltas(loanId, WETH);
            int256 posted = int256(collateralIn);
            assertLe(dL, posted, "S4: lender gained more collateral than was posted");
            assertLe(dC, posted, "S4: caller gained more collateral than was posted");
            (int256 dM,) = ledger.loanMarket(loanId, WETH);
            assertLe(dM, posted, "S4: the market bought more collateral than was posted");
            assertGe(dB, -posted, "S4: borrower lost more collateral than was posted");
        }

        (bool isRental,,,,) = ledger.loanRental(loanId);
        if (isRental) {
            _checkRental(loanId);
            return;
        }

        // S5 / S6 -- principal asset
        {
            (int256 dL, int256 dB,,) = ledger.loanDeltas(loanId, USDC);
            uint256 elapsed = lastTs > startTime ? lastTs - startTime : 0;
            // A preclose offset pays the original lender the interest the rest of the term would
            // have earned beyond what the new offer pays (spec "Preclose", Option 3), so its cap
            // runs to the end of the term rather than to the close.
            (bool offsetClosed, uint256 dueTime) = ledger.loanOffset(loanId);
            if (offsetClosed && dueTime > lastTs) elapsed = dueTime - startTime;
            // Floors only lower what is owed, and partials only lower the principal, so the
            // unfloored figure on the original principal bounds every settlement's sum. The
            // +1 allows the late fee to be rounded up in the protocol's favour.
            uint256 cap = (principal0 * rateBps * elapsed) / (YEAR * BPS)
                + (principal0 * LATE_FEE_CAP_BPS) / BPS + 1;
            assertLe(dL, int256(cap), "S5: lender gained more than interest plus the late-fee cap");
            (, bool periodicSale) = ledger.loanMarket(loanId, USDC);
            if (periodicSale) {
                // A periodic sale turned some of the borrower's collateral into principal asset,
                // so the bound is read in value: principal asset plus collateral at the rig's
                // prices ($1 and $2,000).
                (, int256 dBw,,) = ledger.loanDeltas(loanId, WETH);
                assertLe(dB + dBw * 2000, int256(principal0), "S5: borrower netted more value than the principal lent");
            } else {
                assertLe(dB, int256(principal0), "S5: borrower netted more than the principal lent");
            }

            LibVaipakam.Loan memory L = LoanFacet(address(base.diamond())).getLoanDetails(loanId);
            if (L.status == LibVaipakam.LoanStatus.Repaid) {
                assertGe(dL, 0, "S6: a repaid loan left its lender short");
            }
        }
    }

    /// @dev S9 -- an NFT rental. Its money is the USDC prepayment: the lender side never receives
    ///      more than it (the whole term's rent plus the buffer, which is what the late fee is
    ///      drawn from), and the renter never pays more than it nor nets any USDC. The rented NFT
    ///      never leaves the lender: it is in the lender's vault or, once claimed back, its
    ///      wallet. And a rental that has closed has taken the renter's user rights with it,
    ///      unless the same renter has since rented the token again.
    function _checkRental(uint256 loanId) internal view {
        (, uint256 tokenId, uint256 prepay, address lender, address borrower) = ledger.loanRental(loanId);
        (int256 dL, int256 dB,,) = ledger.loanDeltas(loanId, USDC);
        assertLe(dL, int256(prepay), "S9: a rental paid its lender more than the prepayment");
        assertGe(dB, -int256(prepay), "S9: a renter paid more than its prepayment");
        assertLe(dB, 0, "S9: a renter netted principal asset");
        address diamond = address(base.diamond());
        address nft = base.mockNft();
        address holder = IERC721(nft).ownerOf(tokenId);
        assertTrue(
            holder == lender || holder == VaultFactoryFacet(diamond).getUserVaultAddress(lender),
            "S9: the rented NFT left its lender"
        );
        LibVaipakam.Loan memory L = LoanFacet(diamond).getLoanDetails(loanId);
        if (L.status != LibVaipakam.LoanStatus.Active && IERC4907(nft).userOf(tokenId) == borrower) {
            assertTrue(_rentedAgainBy(tokenId, borrower), "S9: a closed rental left the renter its user rights");
        }
    }

    /// @dev Whether an Active booked rental of `tokenId` is held by `borrower`.
    function _rentedAgainBy(uint256 tokenId, address borrower) internal view returns (bool) {
        uint256 n = ledger.bookedLoanCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = ledger.bookedLoanIds(i);
            (bool r, uint256 t,,, address b) = ledger.loanRental(id);
            if (!r || t != tokenId || b != borrower) continue;
            if (LoanFacet(address(base.diamond())).getLoanDetails(id).status == LibVaipakam.LoanStatus.Active) {
                return true;
            }
        }
        return false;
    }

    /// @notice Coverage readout: an invariant over a path the run never took proves nothing.
    function afterInvariant() external view {
        console.log("booked loans", ledger.bookedLoanCount());
        console.log("booked actions", ledger.bookedActions());
        console.log("accept checks", ledger.acceptChecks());
        console.log("exact-interest checks", ledger.interestChecks());
        console.log("preclosed loans", ledger.precloseLanded());
        console.log("liquidated loans", ledger.liquidationLanded());
        console.log("sold loans", ledger.saleLanded());
        console.log("periodic just-stamps", ledger.periodicStamped());
        console.log("periodic sales", ledger.periodicSold());
        console.log("offset closes", ledger.offsetLanded());
        console.log("refinances", ledger.refinanceLanded());
        console.log("rentals opened", ledger.rentalsOpened());
        console.log("rent deductions", ledger.rentDeductions());
        console.log("exact rental settlements", ledger.rentalChecks());
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

    /// @notice #3241: a Health-Factor liquidation reaches the in-kind fallback (the rig's one
    ///         venue fails); the collateral bounds and the Diamond bound hold through both claims.
    function test_LedgerBooksALiquidatedLoan() public {
        ledger.createBorrowerOffer(1, 1_000 ether, 30, 1_000, 10 ether);
        ledger.acceptBorrowerOffer(1, 0);
        ledger.warp(3 days);
        ledger.triggerLiquidation(0);
        assertEq(ledger.liquidationLanded(), 1, "liquidation did not land");
        uint256 loanId = ledger.bookedLoanIds(0);
        (int256 dLw,,,) = ledger.loanDeltas(loanId, WETH);
        ledger.claimAsLender(0);
        ledger.claimAsBorrower(0);
        (int256 dLw2,,,) = ledger.loanDeltas(loanId, WETH);
        assertGt(dLw2, dLw, "lender received no collateral from the liquidation");

        invariant_PerActionChecksHold();
        invariant_NoLoanPaysOutMoreThanEnteredIt();
    }

    /// @notice #3241: a sold loan. The buyer pays the seller and becomes the lender; the loan is
    ///         then repaid to the buyer, and the lender side as a whole stays within the bounds.
    function test_LedgerBooksAPeriodicSale() public {
        // Seed 3 -> lender 0, with the cadence bit set: a $5,000, 90-day monthly loan.
        ledger.createLenderOffer(3, 5_000 ether, 90, 1_000, 10 ether);
        ledger.acceptLenderOffer(0, 0);
        uint256 loanId = ledger.bookedLoanIds(0);
        assertEq(
            uint8(LoanFacet(address(base.diamond())).getLoanDetails(loanId).periodicInterestCadence),
            uint8(LibVaipakam.PeriodicInterestCadence.Monthly),
            "offer did not carry the monthly cadence"
        );

        ledger.settlePeriodic(0);
        assertEq(ledger.periodicSold(), 1, "periodic sale did not land");
        (int256 dMw, bool sold) = ledger.loanMarket(loanId, WETH);
        assertTrue(sold && dMw > 0, "market bought no collateral");

        ledger.repay(0);
        ledger.claimAsLender(0);
        ledger.claimAsBorrower(0);

        invariant_PerActionChecksHold();
        invariant_NoLoanPaysOutMoreThanEnteredIt();
    }

    function test_LedgerBooksAnOffsetClose() public {
        // Borrower 1 borrows from lender 1 for 60 days, then offsets: it posts a 20-day lender
        // offer from its own principal, and borrower 2 takes it.
        ledger.createBorrowerOffer(1, 1_000 ether, 60, 1_000, 10 ether);
        ledger.acceptBorrowerOffer(1, 0);
        uint256 oldLoanId = ledger.bookedLoanIds(0);
        ledger.warp(5 days);
        ledger.offsetLoan(0, 500, 20);
        ledger.acceptLenderOffer(2, 0);
        assertEq(ledger.offsetLanded(), 1, "offset did not close the original loan");
        assertEq(ledger.bookedLoanCount(), 2, "the offsetting loan was not booked");
        (bool closed,) = ledger.loanOffset(oldLoanId);
        assertTrue(closed, "original loan not marked offset-closed");

        ledger.claimAsLender(0);
        ledger.claimAsBorrower(0);

        invariant_PerActionChecksHold();
        invariant_NoLoanPaysOutMoreThanEnteredIt();
    }

    function test_LedgerBooksARefinance() public {
        // Borrower 1 borrows from lender 1 for 60 days, then asks to refinance at 8% for 30 days
        // on the same collateral, and lender 2 takes the request.
        ledger.createBorrowerOffer(1, 1_000 ether, 60, 1_000, 10 ether);
        ledger.acceptBorrowerOffer(1, 0);
        uint256 checksBefore = ledger.interestChecks();
        ledger.warp(5 days);
        ledger.refinanceRequest(0, 800, 30);
        ledger.acceptBorrowerOffer(2, 0);
        assertEq(ledger.refinanceLanded(), 1, "refinance did not close the original loan");
        assertEq(ledger.bookedLoanCount(), 2, "the replacement loan was not booked");
        assertEq(ledger.interestChecks(), checksBefore + 1, "the original's payoff was not checked exactly");

        ledger.claimAsLender(0);
        ledger.warp(10 days);
        ledger.repay(1);
        ledger.claimAsLender(1);
        ledger.claimAsBorrower(1);

        invariant_PerActionChecksHold();
        invariant_NoLoanPaysOutMoreThanEnteredIt();
    }

    function test_LedgerBooksARentalEndToEnd() public {
        // Lender 0 rents out an NFT at 10 USDC a day for 7 days; borrower 1 rents it, two days'
        // rent is deducted, and the rental closes early on day 4 (3.5 days used, so 4 owed).
        ledger.createRentalOffer(0, 0, 10 ether, 7);
        ledger.acceptRentalOffer(1, 0);
        assertEq(ledger.rentalsOpened(), 1, "rental did not open");
        ledger.warp(1 days + 1);
        ledger.autoDeductDaily(0);
        ledger.warp(1 days);
        ledger.autoDeductDaily(0);
        assertEq(ledger.rentDeductions(), 2, "the daily deductions did not run");
        ledger.warp(1.5 days);
        ledger.repay(0);
        ledger.claimAsLender(0);
        ledger.claimAsBorrower(0);
        assertEq(ledger.rentalChecks(), 2, "the rental's settlement was not checked exactly");

        invariant_PerActionChecksHold();
        invariant_NoLoanPaysOutMoreThanEnteredIt();
    }

    function test_LedgerBooksAPreclosedRental() public {
        // A direct preclose is the spec's Option 1: the renter owes the whole agreed term (5 days
        // at 4 USDC), however early it closes, and the ledger checks both sides against that.
        ledger.createRentalOffer(1, 2, 4 ether, 5);
        ledger.acceptRentalOffer(2, 0);
        ledger.warp(1 days + 1);
        ledger.autoDeductDaily(0);
        ledger.warp(6 hours);
        ledger.precloseDirect(0);
        assertEq(ledger.precloseLanded(), 1, "the rental preclose did not land");
        ledger.claimAsLender(0);
        ledger.claimAsBorrower(0);
        assertEq(ledger.rentalChecks(), 2, "the preclosed rental's settlement was not checked exactly");

        invariant_PerActionChecksHold();
        invariant_NoLoanPaysOutMoreThanEnteredIt();
    }

    function test_LedgerBooksADefaultedRental() public {
        ledger.createRentalOffer(2, 3, 5 ether, 3);
        ledger.acceptRentalOffer(0, 0);
        ledger.warp(30 days);
        ledger.triggerDefault(0);
        assertTrue(
            LoanFacet(address(base.diamond())).getLoanDetails(ledger.bookedLoanIds(0)).status
                != LibVaipakam.LoanStatus.Active,
            "the rental did not default"
        );
        ledger.claimAsLender(0);
        ledger.claimAsBorrower(0);

        invariant_PerActionChecksHold();
        invariant_NoLoanPaysOutMoreThanEnteredIt();
    }

    function test_LedgerBooksASoldLoan() public {
        ledger.createBorrowerOffer(1, 1_000 ether, 30, 1_000, 10 ether);
        ledger.acceptBorrowerOffer(1, 0);
        ledger.createLenderOffer(2, 1_000 ether, 30, 1_000, 10 ether);
        ledger.warp(3 days);
        ledger.sellLoan(0, 0);
        assertEq(ledger.saleLanded(), 1, "sale did not land");
        ledger.warp(3 days);
        ledger.repay(0);
        ledger.claimAsLender(0);
        ledger.claimAsBorrower(0);

        invariant_PerActionChecksHold();
        invariant_NoLoanPaysOutMoreThanEnteredIt();
    }
}
