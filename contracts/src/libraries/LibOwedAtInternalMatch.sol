// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibOwedAtDefault} from "./LibOwedAtDefault.sol";

/**
 * @title  LibOwedAtInternalMatch
 * @notice #2427 — records what internal matching cleared from an ERC-20 loan it
 *         closed, so the lender-position holder can be shown the payout
 *         against a figure the protocol itself substantiates.
 * @dev    WHY NOT {LibOwedAtDefault}. That record is taken inside
 *         `EncumbranceMutateFacet.terminalize*`, where loan state is untouched
 *         up to the status write. A match decrements `loan.principal` BEFORE
 *         it terminalizes, so by then the principal is zero and the debt is
 *         gone. The figure exists only at the match steps themselves.
 *
 *         WHAT. A match can clear a loan in several steps while it stays
 *         `Active` (each step moves the smaller of the loan's principal and
 *         the counterparty's collateral). Each step adds the debt it
 *         discharged: on the {LibOwedAtDefault.debtOn} basis, at the step's
 *         timestamp, the debt before the principal decrement minus the debt
 *         after it. That is the moved principal, the accrued interest on it
 *         that is now never charged, and the late fee on it. Repayments
 *         between steps are not steps and add nothing. Each step also adds the
 *         lender's proceeds — the moved principal less the matcher incentive.
 *
 *         WHEN IT IS REPORTED. The sum is stamped (`recordedAt`) only when a
 *         step closes the loan from `Active`, and only when it is the whole
 *         of what matching cleared. It is flagged `incomplete` and never
 *         stamped when (a) any step ran while the loan was `FallbackPending`
 *         — that step settles on the fallback's own basis, which the loan's
 *         {LibOwedAtDefault} entry figure describes; or (b) the lender
 *         already held proceeds (`heldForLender`) when the first recorded step
 *         ran — a step taken before this record existed, or a preclose or
 *         offset that paid the lender in part, so neither the cleared debt
 *         nor the lender's total payout would be the whole of it. `ClaimFacet.getOwedAtInternalMatch` reports a stamped
 *         record only while the loan stands `InternalMatched`. Nothing is
 *         cleared: a loan that steps and is then repaid or defaults never
 *         reaches `InternalMatched` from `Active`, and `InternalMatched` is
 *         terminal, so a stale sum is never read.
 *
 *         NOT RECORDED: NFT rentals (they never internal-match), and a loan
 *         closed in a single step before this record existed.
 */
library LibOwedAtInternalMatch {
    /// @notice What internal matching cleared from `loanId`, in `asset`, when
    ///         a step closed it from `Active`.
    /// @dev    `principal + interest + lateFee` is gross debt; the lender was
    ///         paid `lenderProceeds` (principal less the matcher incentive).
    /// @custom:event-category informational/settlement
    event OwedAtInternalMatchRecorded(
        uint256 indexed loanId,
        address indexed asset,
        uint256 principal,
        uint256 interest,
        uint256 lateFee,
        uint256 lenderProceeds
    );

    /// @notice Add one match step's discharged debt and lender proceeds to
    ///         `loan`'s record. Called by `RiskMatchLiquidationFacet` AFTER the
    ///         step's principal decrement and BEFORE any status write, so
    ///         `loan.status` is the status the step ran in, and BEFORE the
    ///         step's proceeds are added to `heldForLender`.
    /// @param principalBefore The loan's principal before this step.
    /// @param lenderProceeds  What this step paid the lender side.
    function onStep(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 principalBefore,
        uint256 lenderProceeds
    ) internal {
        if (loan.assetType != LibVaipakam.AssetType.ERC20) return;
        LibVaipakam.OwedAtInternalMatch storage r = s.owedAtInternalMatch[loan.id];
        // A step under the fallback settles on the fallback's own basis; and
        // lender proceeds already held when the FIRST recorded step runs mean
        // the lender was paid in part before this record saw the loan (a step
        // taken before it existed, or a preclose / offset), so the sum here
        // could not be the whole of it. `heldForLender` is read before this
        // step's own proceeds are added to it.
        if (
            loan.status != LibVaipakam.LoanStatus.Active ||
            (r.principal == 0 && s.heldForLender[loan.id] != 0)
        ) {
            r.incomplete = true;
            return;
        }
        if (r.incomplete) return;
        (uint256 interestBefore, uint256 lateFeeBefore) = LibOwedAtDefault.debtOn(loan, principalBefore);
        (uint256 interestAfter, uint256 lateFeeAfter) = LibOwedAtDefault.debtOn(loan, loan.principal);
        r.principal += principalBefore - loan.principal;
        r.interest += interestBefore - interestAfter;
        r.lateFee += lateFeeBefore - lateFeeAfter;
        r.lenderProceeds += lenderProceeds;
    }

    /// @notice Stamp `loan`'s record when a step has closed it from `Active`.
    ///         An `incomplete` record is left unstamped.
    function onClose(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan) internal {
        if (loan.assetType != LibVaipakam.AssetType.ERC20) return;
        LibVaipakam.OwedAtInternalMatch storage r = s.owedAtInternalMatch[loan.id];
        if (r.incomplete) return;
        r.recordedAt = uint64(block.timestamp);
        emit OwedAtInternalMatchRecorded(
            loan.id, loan.principalAsset, r.principal, r.interest, r.lateFee, r.lenderProceeds
        );
    }
}
