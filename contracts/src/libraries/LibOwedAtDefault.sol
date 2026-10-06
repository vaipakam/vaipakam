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
 *         interest already settled, and the late fee — the basis every forced
 *         close settles its debt on, at the same block timestamp, so the figure
 *         equals the debt the close itself used. Computed only on an edge OUT
 *         OF `Active`: by a later `FallbackPending -> Defaulted` move the loan's
 *         stored state no longer describes the debt at default (interest keeps
 *         running, a partial internal match lowers principal), so the entry
 *         figure is kept, not restated.
 *
 *         NOT RECORDED: NFT rentals (their "principal" is a daily fee and the
 *         claim is the NFT), a loan fully closed by internal matching (its
 *         principal is already zero when it terminalizes), and any loan that
 *         defaulted before this record existed. A `FallbackPending` loan its
 *         borrower cures (back to `Active`) or repays loses the record: it did
 *         not, in the end, default.
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

    /// @notice `loanId`'s record was removed because the fallback it entered
    ///         was cured or repaid, so the loan did not in the end default.
    /// @custom:event-category informational/settlement
    event OwedAtDefaultCleared(uint256 indexed loanId);

    /// @notice Keep the record in step with a terminal status write from
    ///         `from` to `to`. Called by `EncumbranceMutateFacet.terminalize*`
    ///         BEFORE the status write, at the close's own timestamp.
    function onTerminal(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.LoanStatus from,
        LibVaipakam.LoanStatus to
    ) internal {
        if (to == LibVaipakam.LoanStatus.Repaid) {
            clear(s, loanId);
            return;
        }
        if (from != LibVaipakam.LoanStatus.Active) return;
        bool viaFallback = to == LibVaipakam.LoanStatus.FallbackPending;
        if (!viaFallback && to != LibVaipakam.LoanStatus.Defaulted) return;
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (loan.assetType != LibVaipakam.AssetType.ERC20) return;

        uint256 principal = loan.principal;
        uint256 start = LibVaipakam.interestAccrualStartOf(loan);
        uint256 elapsed = block.timestamp > start ? block.timestamp - start : 0;
        uint256 interest = LibEntitlement.creditSettledInterest(
            loan,
            (principal * loan.interestRateBps * elapsed) /
                (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS)
        );
        uint256 lateFee = LibVaipakam.calculateLateFee(
            loanId, loan.startTime + loan.durationDays * 1 days
        );
        s.owedAtDefault[loanId] = LibVaipakam.OwedAtDefault({
            principal: principal,
            interest: interest,
            lateFee: lateFee,
            recordedAt: uint64(block.timestamp),
            viaFallback: viaFallback
        });
        emit OwedAtDefaultRecorded(loanId, loan.principalAsset, principal, interest, lateFee, viaFallback);
    }

    /// @notice Remove `loanId`'s record, if it has one.
    function clear(LibVaipakam.Storage storage s, uint256 loanId) internal {
        if (s.owedAtDefault[loanId].recordedAt == 0) return;
        delete s.owedAtDefault[loanId];
        emit OwedAtDefaultCleared(loanId);
    }
}
