// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibMetricsHooks} from "./LibMetricsHooks.sol";

/**
 * @title LibLifecycle
 * @notice Single allow-list of legal `LoanStatus` transitions. Every facet
 *         that mutates `loan.status` must route through `transition(...)`
 *         so there is exactly one place to audit when reasoning about the
 *         lifecycle. Any transition not in the table reverts with
 *         `IllegalTransition` — callers never silently downgrade/upgrade
 *         status.
 *
 *         Legal edges (README §§6-7):
 *           Active            -> Repaid           (full repay / preclose / offset / refinance)
 *           Active            -> Defaulted        (liquidation / time-default swap success)
 *           Active            -> FallbackPending  (swap failed / slippage ceiling breached)
 *           FallbackPending   -> Active           (borrower cure via addCollateral)
 *           FallbackPending   -> Repaid           (borrower cure via full repay)
 *           FallbackPending   -> Defaulted        (lender claim finalises fallback)
 *           Repaid            -> Settled          (both sides claimed)
 *           Defaulted         -> Settled          (both sides claimed)
 *
 *         `initialize(...)` is used by LoanFacet when a fresh loan is
 *         created — it accepts the default zero-value status and stamps
 *         it to `Active`. All subsequent writes must use `transition`.
 */
library LibLifecycle {
    error IllegalTransition(LibVaipakam.LoanStatus from, LibVaipakam.LoanStatus to);

    /// @notice Stamp a fresh loan as Active. The default enum value is
    ///         already `Active` (index 0), so this is semantically a
    ///         marker — callers document that a loan has entered the
    ///         lifecycle rather than simply being default-initialised.
    function initialize(LibVaipakam.Loan storage loan) internal {
        loan.status = LibVaipakam.LoanStatus.Active;
    }

    /// @notice Transition `loan.status` from `expectedFrom` to `to`,
    ///         reverting if either the current status does not match or
    ///         the edge is not in the allow-list.
    function transition(
        LibVaipakam.Loan storage loan,
        LibVaipakam.LoanStatus expectedFrom,
        LibVaipakam.LoanStatus to
    ) internal {
        LibVaipakam.LoanStatus current = loan.status;
        if (current != expectedFrom) revert IllegalTransition(current, to);
        if (!_isLegal(current, to)) revert IllegalTransition(current, to);
        loan.status = to;
        LibMetricsHooks.onLoanStatusChanged(loan, current, to);
    }

    /// @notice Variant that accepts the current status implicitly — the
    ///         library reads `loan.status` and validates the edge without
    ///         requiring the caller to know `from`. Useful where multiple
    ///         prior statuses all converge on the same target (e.g. both
    ///         Active and FallbackPending can transition to Defaulted).
    function transitionFromAny(
        LibVaipakam.Loan storage loan,
        LibVaipakam.LoanStatus to
    ) internal {
        LibVaipakam.LoanStatus current = loan.status;
        if (!_isLegal(current, to)) revert IllegalTransition(current, to);
        loan.status = to;
        LibMetricsHooks.onLoanStatusChanged(loan, current, to);
    }

    /// @dev Pure allow-list check. Keep this as an if-ladder — it compiles
    ///      to a straight sequence of comparisons and is trivially
    ///      auditable. Do not introduce data structures here.
    function _isLegal(
        LibVaipakam.LoanStatus from,
        LibVaipakam.LoanStatus to
    ) private pure returns (bool) {
        if (from == LibVaipakam.LoanStatus.Active) {
            return
                to == LibVaipakam.LoanStatus.Repaid ||
                to == LibVaipakam.LoanStatus.Defaulted ||
                to == LibVaipakam.LoanStatus.FallbackPending;
        }
        if (from == LibVaipakam.LoanStatus.FallbackPending) {
            return
                to == LibVaipakam.LoanStatus.Active ||
                to == LibVaipakam.LoanStatus.Repaid ||
                to == LibVaipakam.LoanStatus.Defaulted;
        }
        if (from == LibVaipakam.LoanStatus.Repaid) {
            return to == LibVaipakam.LoanStatus.Settled;
        }
        if (from == LibVaipakam.LoanStatus.Defaulted) {
            return to == LibVaipakam.LoanStatus.Settled;
        }
        return false; // Settled is terminal
    }
}
