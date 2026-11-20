// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  LibAdvancePayAuth
 * @author Vaipakam Developer Team
 * @notice #3760 — the single-use authorization for an advance's two vault
 *         movements (LenderCashOutDesign §6.3, §6.4), held in transient
 *         storage for the rest of the transaction, the `LibSellerPayAuth`
 *         precedent. The advance host writes it for one loan, one direction
 *         and an exact amount just before it moves the money; the vault
 *         outflow policy consumes it for the `AdvanceToHolder` and
 *         `AdvanceRepayment` classes. The payee is never named by the caller:
 *         the policy reads it from the loan and the advance record.
 * @dev    Keyed by (loan, direction). A consume lowers it by what it pays and
 *         refuses more than is left. The writer clears it after the move.
 */
library LibAdvancePayAuth {
    bytes32 private constant BASE = keccak256("vaipakam.advance.payauth");

    /// @notice The advance's principal, slot owner's vault → holder's vault.
    uint8 internal constant TO_HOLDER = 0;
    /// @notice A repayment of the advance → the slot owner's vault.
    uint8 internal constant REPAYMENT = 1;

    error AdvancePayoutNotAuthorized(uint256 loanId, uint8 direction, uint256 amount, uint256 authorized);

    function _key(uint256 loanId, uint8 direction) private pure returns (bytes32) {
        return keccak256(abi.encode(BASE, loanId, direction));
    }

    /// @notice Authorize moving up to `amount` for `loanId` in `direction` in
    ///         this transaction (replaces any earlier authorization).
    function authorize(uint256 loanId, uint8 direction, uint256 amount) internal {
        bytes32 key = _key(loanId, direction);
        assembly ("memory-safe") {
            tstore(key, amount)
        }
    }

    /// @notice Clear the authorization (after the move, used or not).
    function clear(uint256 loanId, uint8 direction) internal {
        authorize(loanId, direction, 0);
    }

    /// @notice Spend `amount` of the authorization; refuses more than is left.
    function consume(uint256 loanId, uint8 direction, uint256 amount) internal {
        bytes32 key = _key(loanId, direction);
        uint256 left;
        assembly ("memory-safe") {
            left := tload(key)
        }
        if (amount > left) revert AdvancePayoutNotAuthorized(loanId, direction, amount, left);
        unchecked {
            left -= amount;
        }
        assembly ("memory-safe") {
            tstore(key, left)
        }
    }
}
