// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibEntitlement} from "./LibEntitlement.sol";

/**
 * @title  LibOwedAtDefault
 * @notice #2374 — records what an ERC-20 loan owed at the moment it defaulted,
 *         so a lender-position holder can be shown the recovery against a
 *         figure the protocol itself substantiates, rather than against the
 *         loan's CURRENT principal (which partial repayment moves, and which a
 *         holder who bought the position never lent).
 * @dev    WHERE. Every status write to `Defaulted` or `FallbackPending` goes
 *         through `EncumbranceMutateFacet.terminalize*`, which calls
 *         {onTerminal}, so the figure is computed once, in one place, instead
 *         of at each of the forced-close call sites (several of which have no
 *         bytecode headroom left).
 *
 *         WHAT. Principal outstanding, per-second accrued interest net of the
 *         interest already settled, and the late fee — the basis a swap-based
 *         forced close (time default, HF liquidation) settles its debt on, at
 *         the same block timestamp, so for those the figure equals the debt the
 *         close itself used. A FALLBACK allocates collateral on its own basis
 *         (principal plus interest plus a lender bonus and a treasury share, no
 *         late fee); for a fallback this records the debt, not that
 *         allocation. Computed only on an edge OUT OF `Active`: by a later
 *         `FallbackPending -> Defaulted` move the loan's stored state no longer
 *         describes the debt at default (interest keeps running, a partial
 *         internal match lowers principal), so the entry figure is kept, not
 *         restated.
 *
 *         WHEN IT IS REPORTED. The record is the loan's MOST RECENT default and
 *         is never cleared. `ClaimFacet.getOwedAtDefault` reports it only while
 *         the loan stands defaulted (`Defaulted` or `FallbackPending`), so a
 *         fallback that is cured (back to `Active`), repaid, fully closed by an
 *         internal match, or a loan that has since settled, reads as "no
 *         record" by construction — no exit path has to remember to clear it,
 *         and a new default from `Active` overwrites it. The history stays in
 *         the {OwedAtDefaultRecorded} event.
 *
 *         NOT RECORDED: NFT rentals (their "principal" is a daily fee and the
 *         claim is the NFT), a loan fully closed by internal matching straight
 *         from `Active` (its principal is already zero when it terminalizes;
 *         {LibOwedAtInternalMatch} records that close instead, step by step),
 *         and any loan that defaulted before this record existed.
 */
library LibOwedAtDefault {
    /// @notice What `loanId` owed in `asset` at the moment it defaulted.
    /// @dev    Gross debt: the protocol's share of `interest` and `lateFee` is
    ///         taken before the lender is paid. `viaFallback` marks a default
    ///         that entered the full-collateral fallback.
    /// @custom:event-category informational/settlement
    event OwedAtDefaultRecorded(
        uint256 indexed loanId,
        address indexed asset,
        uint256 principal,
        uint256 interest,
        uint256 lateFee,
        bool viaFallback
    );

    /// @notice Record what `loanId` owed if the terminal status write from
    ///         `from` to `to` is a default. Called by
    ///         `EncumbranceMutateFacet.terminalize*` BEFORE the status write, at
    ///         the close's own timestamp.
    function onTerminal(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.LoanStatus from,
        LibVaipakam.LoanStatus to
    ) internal {
        if (from != LibVaipakam.LoanStatus.Active) return;
        bool viaFallback = to == LibVaipakam.LoanStatus.FallbackPending;
        if (!viaFallback && to != LibVaipakam.LoanStatus.Defaulted) return;
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.assetType != LibVaipakam.AssetType.ERC20) return;

        uint256 principal = loan.principal;
        (uint256 interest, uint256 lateFee) = debtOn(loan, principal);
        s.owedAtDefault[loanId] = LibVaipakam.OwedAtDefault({
            principal: principal,
            interest: interest,
            lateFee: lateFee,
            recordedAt: uint64(block.timestamp),
            viaFallback: viaFallback
        });
        emit OwedAtDefaultRecorded(loanId, loan.principalAsset, principal, interest, lateFee, viaFallback);
    }

    /// @notice The interest and late fee `loan` owes now on `principal`, on
    ///         the basis {onTerminal} records: per-second accrued interest
    ///         since the accrual start, net of interest already settled, and
    ///         the late fee past the loan's end.
    /// @dev    Takes `principal` as a parameter so #2427's internal-match
    ///         record can price a step's debt before and after its principal
    ///         decrement on the one formula.
    function debtOn(LibVaipakam.Loan storage loan, uint256 principal)
        internal
        view
        returns (uint256 interest, uint256 lateFee)
    {
        uint256 start = LibVaipakam.interestAccrualStartOf(loan);
        uint256 elapsed = block.timestamp > start ? block.timestamp - start : 0;
        interest = LibEntitlement.creditSettledInterest(
            loan,
            (principal * loan.interestRateBps * elapsed) /
                (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS)
        );
        lateFee = (principal * LibVaipakam.lateFeeBps(loan.startTime + loan.durationDays * 1 days)) /
            LibVaipakam.BASIS_POINTS;
    }
}
