// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/// @notice Returning the caller's overpayment failed.
error RefundFailed();

/**
 * @title  LibFeeRefund
 * @notice Returns to the caller exactly what its own call overpaid for a
 *         cross-chain fee, and nothing else the contract happens to hold
 *         (#2443). `SanctionsDelistingTimelock.requestClearance` and
 *         `SanctionsClearanceAttestor.sendReply` both pay their messenger
 *         with `msg.value` and receive its overpayment refund; this is their
 *         one rule for passing that refund on.
 *
 * @dev    The refund is the balance GROWTH since the call began, not the
 *         whole balance: a contract can hold native value it never asked for
 *         (a forced send), and that must not go to whoever calls next.
 *         Take {baseline} first thing in the call, then {refund} after the
 *         messenger has paid back.
 */
library LibFeeRefund {
    /// @return What the contract held before this call's `msg.value`.
    function baseline() internal view returns (uint256) {
        return address(this).balance - msg.value;
    }

    /// @param baseline_ The value {baseline} returned at the start of the call.
    function refund(uint256 baseline_) internal {
        uint256 amount = address(this).balance - baseline_;
        if (amount == 0) return;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert RefundFailed();
    }
}
