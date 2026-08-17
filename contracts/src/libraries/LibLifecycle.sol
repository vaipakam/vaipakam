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
 *         `InvalidTransition` — callers never silently downgrade/upgrade
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
    error InvalidTransition(LibVaipakam.LoanStatus from, LibVaipakam.LoanStatus to);

    /// @notice Emitted on EVERY `loan.status` edge, from the one primitive all
    ///         status writes are required to route through.
    /// @dev #1782 — the off-chain half of the chokepoint this library already
    ///      documents. `transition` / `transitionFromAny` have always fanned
    ///      out to {LibMetricsHooks.onLoanStatusChanged}, so every edge already
    ///      had exactly one observation point on-chain; an indexer had no
    ///      equivalent and could only watch whatever event the CALLING facet
    ///      chose to emit. Where a caller emitted nothing — or named a
    ///      different loan than the one it transitioned, as the sale-vehicle
    ///      temp loan does — the projection kept that loan `active` forever.
    ///      That is the May-2026 symptom reached through the event-coverage
    ///      guardrail's blind spot: a state change that emits nothing is not an
    ///      untagged or unhandled event, so it never enters the checker's
    ///      enumeration.
    ///
    ///      Emitting HERE rather than at each call site is what closes the
    ///      class instead of the instance. Routing through this primitive is
    ///      already mandatory and already enforced (an unlisted edge reverts),
    ///      so a transition that is invisible off-chain is no longer
    ///      constructible — there is no call site left that could forget. It
    ///      also makes a write-side static check on call sites unnecessary.
    ///      The id comes from `loan.id` rather than from a caller-supplied
    ///      argument. That is sound because `loan.id` is written exactly once,
    ///      at creation (`LoanFacet.sol:953` is its only writer anywhere in
    ///      `src/`), so it cannot drift from the storage key the caller indexed
    ///      by. It is also the safer of the two: a `loanId` parameter would let
    ///      a call site pass one loan's id while transitioning another, which is
    ///      the precise failure #1782 describes — an event naming a different
    ///      loan than the one that moved.
    /// @param loanId The loan whose status changed.
    /// @param from Status before the edge.
    /// @param to Status after the edge.
    /// @custom:event-category state-change/loan-mutation
    event LoanStatusChanged(
        uint256 indexed loanId,
        LibVaipakam.LoanStatus from,
        LibVaipakam.LoanStatus to
    );

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
        if (current != expectedFrom) revert InvalidTransition(current, to);
        if (!_isValid(current, to)) revert InvalidTransition(current, to);
        loan.status = to;
        LibMetricsHooks.onLoanStatusChanged(loan, current, to);
        emit LoanStatusChanged(loan.id, current, to);
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
        if (!_isValid(current, to)) revert InvalidTransition(current, to);
        loan.status = to;
        LibMetricsHooks.onLoanStatusChanged(loan, current, to);
        emit LoanStatusChanged(loan.id, current, to);
    }

    /// @dev Pure allow-list check. Keep this as an if-ladder — it compiles
    ///      to a straight sequence of comparisons and is trivially
    ///      auditable. Do not introduce data structures here.
    function _isValid(
        LibVaipakam.LoanStatus from,
        LibVaipakam.LoanStatus to
    ) private pure returns (bool) {
        if (from == LibVaipakam.LoanStatus.Active) {
            return
                to == LibVaipakam.LoanStatus.Repaid ||
                to == LibVaipakam.LoanStatus.Defaulted ||
                to == LibVaipakam.LoanStatus.FallbackPending ||
                // PR5 of internal-match work (2026-05-15) — match-
                // liquidation terminal edge. Reached from Active when
                // `triggerInternalMatchLiquidation` fully clears the
                // loan's principal. Partial matches stay Active and
                // don't transition.
                to == LibVaipakam.LoanStatus.InternalMatched ||
                // T-086 step 5 — Seaport prepay-collateral-sale terminal
                // edge. The sale settles atomically inside Seaport's
                // fill: lender owed amount + treasury fee + borrower
                // residual are all distributed in one tx, then the
                // executor's zone callback flips Active → Settled.
                // Unlike Repaid/Defaulted there's no separate claim
                // step — Seaport's atomic transfer IS the settlement.
                // Restricted to the privileged callback path on
                // `PrepayListingFacet.executorFinalizePrepaySale`
                // (msg.sender == storedCollateralListingExecutor).
                to == LibVaipakam.LoanStatus.Settled;
        }
        if (from == LibVaipakam.LoanStatus.FallbackPending) {
            return
                to == LibVaipakam.LoanStatus.Active ||
                to == LibVaipakam.LoanStatus.Repaid ||
                to == LibVaipakam.LoanStatus.Defaulted ||
                // EC-003 Phase 1 — FallbackPending loans become matchable.
                // When `triggerInternalMatchLiquidation` fully clears the
                // principal of a FallbackPending leg, the loan transitions
                // here. Partial matches keep the loan in FallbackPending
                // with a proportionally-reduced `fallbackSnapshot`.
                to == LibVaipakam.LoanStatus.InternalMatched;
        }
        if (from == LibVaipakam.LoanStatus.Repaid) {
            return to == LibVaipakam.LoanStatus.Settled;
        }
        if (from == LibVaipakam.LoanStatus.Defaulted) {
            return to == LibVaipakam.LoanStatus.Settled;
        }
        if (from == LibVaipakam.LoanStatus.InternalMatched) {
            // Match-liquidation feeds into the same Settled terminal
            // as Repaid/Defaulted via the existing claim flow.
            return to == LibVaipakam.LoanStatus.Settled;
        }
        return false; // Settled is terminal
    }
}
