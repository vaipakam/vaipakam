// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";

/// @title LoanClockProbeFacet — test-only read of the late fee
/// @notice Cut into a test Diamond by {GlobalPauseLoanClockTest} so the
///         late fee the settlement paths charge can be read on its own,
///         rather than inferred from a repayment quote that also carries
///         accrued interest. Never cut into a deployed Diamond.
contract LoanClockProbeFacet {
    /// @notice {LibVaipakam.calculateLateFee} for `loanId`, now.
    function probeLateFee(uint256 loanId) external view returns (uint256) {
        return LibVaipakam.calculateLateFee(loanId);
    }
}
