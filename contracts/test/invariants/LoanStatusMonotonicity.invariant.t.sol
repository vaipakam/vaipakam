// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {Handler} from "./Handler.sol";

/**
 * @title LoanStatusMonotonicityInvariant
 * @notice A loan's lifecycle is a directed acyclic march — once it leaves
 *         the `Active` state it must never return. Valid transitions out
 *         of Active:
 *           Active → Repaid           (full repayment)
 *           Active → Defaulted        (grace expired, collateral taken)
 *           Active → FallbackPending  (HF-liquidation scheduled, swap pending)
 *           Active → Settled          (final state after claim-side work)
 *         Repaid / Defaulted / FallbackPending can move on to Settled, but
 *         none of them may ever transition back to Active.
 *
 *         A Zombie-Active — a loan observed in a terminal state, then seen
 *         Active again at the next fuzz step — would mean the protocol
 *         "re-opened" a resolved loan, which lets a lender double-claim or
 *         a borrower resurrect collateral they already forfeited. This
 *         invariant pins that door shut.
 *
 *         Implementation note: the invariant is non-view so we can cache
 *         each loan's first non-Active observation in a mapping and
 *         compare on subsequent runs.
 */
contract LoanStatusMonotonicityInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    // Cached "the loan was observed in state X and X is terminal for us".
    // Once set, the loan's current status must match or advance within the
    // terminal-status subset — never return to Active.
    mapping(uint256 => bool) internal observedNonActive;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);
        targetContract(address(handler));
    }

    function invariant_ActiveExitIsOneWay() public {
        uint256 n = handler.loanIdsLength();
        LoanFacet loans = LoanFacet(address(base.diamond()));

        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            LibVaipakam.LoanStatus status = loans.getLoanDetails(loanId).status;

            if (observedNonActive[loanId]) {
                assertTrue(
                    status != LibVaipakam.LoanStatus.Active,
                    "loan returned to Active after leaving"
                );
            } else if (status != LibVaipakam.LoanStatus.Active) {
                // First observation of a non-Active status — latch it.
                observedNonActive[loanId] = true;
            }
        }
    }
}
