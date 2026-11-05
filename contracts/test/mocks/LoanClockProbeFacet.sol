// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibLoanClock} from "../../src/libraries/LibLoanClock.sol";
import {LibEntitlement} from "../../src/libraries/LibEntitlement.sol";

/// @title LoanClockProbeFacet — test-only reads of the loan clock
/// @notice Cut into a test Diamond by {GlobalPauseLoanClockTest} so the
///         late fee the settlement paths charge, and the interest term a
///         sale or an early close prices over, can be read on their own,
///         rather than inferred from a quote that also carries other legs.
///         Never cut into a deployed Diamond.
contract LoanClockProbeFacet {
    /// @notice {LibVaipakam.calculateLateFee} for `loanId`, now.
    function probeLateFee(uint256 loanId) external view returns (uint256) {
        return LibVaipakam.calculateLateFee(loanId);
    }

    /// @notice {LibLoanClock.interestTermEnd} for `loanId`, now.
    function probeInterestTermEnd(uint256 loanId) external view returns (uint256) {
        return LibLoanClock.interestTermEnd(LibVaipakam.storageSlot().loans[loanId], block.timestamp);
    }

    /// @notice {LibLoanClock.remainingInterestSeconds} for `loanId`, now.
    function probeRemainingInterestSeconds(uint256 loanId) external view returns (uint256) {
        return LibLoanClock.remainingInterestSeconds(
            LibVaipakam.storageSlot().loans[loanId], block.timestamp
        );
    }

    /// @notice #3169 — {LibLoanClock.minimumInterestSeconds} for `loanId`.
    function probeMinimumInterestSeconds(uint256 loanId) external view returns (uint256) {
        return LibLoanClock.minimumInterestSeconds(LibVaipakam.storageSlot().loans[loanId]);
    }

    /// @notice #3169 — {LibEntitlement.settlementInterest} for `loanId`, now.
    function probeSettlementInterest(uint256 loanId) external view returns (uint256) {
        return LibEntitlement.settlementInterest(LibVaipakam.storageSlot().loans[loanId], block.timestamp);
    }
}
