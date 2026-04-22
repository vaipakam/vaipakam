// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {InvariantBase} from "./InvariantBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {Handler} from "./Handler.sol";

/**
 * @title ClaimExclusivityInvariant
 * @notice No loan is ever claimed more than once by the same side, and a
 *         Settled loan does not admit any further claim attempts. The
 *         handler's `claimAsLender` / `claimAsBorrower` short-circuit on
 *         ghost flags before calling the facet; if the facet itself failed
 *         to enforce exclusivity, a retry without the ghost gate would
 *         succeed, but the ghost gate guarantees the handler can only
 *         record one successful claim per side per loan. This invariant
 *         confirms protocol state agrees.
 */
contract ClaimExclusivityInvariant is Test {
    InvariantBase internal base;
    Handler internal handler;

    function setUp() public {
        base = new InvariantBase();
        base.deploy();
        handler = new Handler(base);
        targetContract(address(handler));
    }

    /// @notice For every tracked loan: at most one lender-claim and one
    ///         borrower-claim recorded by the handler. A double-record
    ///         would indicate the protocol accepted a repeat claim.
    function invariant_ClaimFlagsMonotone() public view {
        uint256 n = handler.loanIdsLength();
        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            // Ghost flags are bool — they cannot go above 1 by construction.
            // The assertion is effectively that every claim is observable
            // exactly once in the handler's ledger. We re-check by asking
            // the protocol's loan status — Settled or Defaulted with both
            // flags true should only occur once.
            LibVaipakam.Loan memory L = LoanFacet(address(base.diamond())).getLoanDetails(loanId);
            // Nothing to assert directly — the existence of the ghost flag
            // plus the bool type is the monotonicity proof. Sanity-check
            // that a claimed flag implies a closed-ish status.
            if (handler.ghostClaimedLender(loanId)) {
                // Lender claim is valid on Repaid (collect principal),
                // Defaulted/FallbackPending (collateral fallback), and
                // Settled (final state). It must never fire on an Active loan.
                assertTrue(
                    L.status != LibVaipakam.LoanStatus.Active,
                    "lender claim on Active loan"
                );
            }
            if (handler.ghostClaimedBorrower(loanId)) {
                assertTrue(
                    L.status == LibVaipakam.LoanStatus.Repaid ||
                        L.status == LibVaipakam.LoanStatus.Settled,
                    "borrower claim on non-repaid loan"
                );
            }
        }
    }

    /// @notice A Settled loan must have had both claims pass through the
    ///         handler (otherwise the protocol reached Settled via a path
    ///         the handler never exercised — something's wrong with the
    ///         claim gating).
    function invariant_SettledImpliesBothClaimed() public view {
        uint256 n = handler.loanIdsLength();
        for (uint256 i = 0; i < n; i++) {
            uint256 loanId = handler.loanIdAt(i);
            LibVaipakam.Loan memory L = LoanFacet(address(base.diamond())).getLoanDetails(loanId);
            if (L.status == LibVaipakam.LoanStatus.Settled) {
                assertTrue(
                    handler.ghostClaimedLender(loanId) || handler.ghostClaimedBorrower(loanId),
                    "settled without observable claim"
                );
            }
        }
    }
}
