// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  LibSellerPayAuth
 * @author Vaipakam Developer Team
 * @notice A prior seller's payout authorization, held in transient storage
 *         for the rest of the transaction (#3205 part 2, Codex #3387 r1). The
 *         seller-claim settlement writes it, for one seller on one loan and an
 *         exact amount, from the seller claim it is paying, just before it
 *         pays; the vault outflow policy consumes it for the SellerClaim
 *         class. The policy never authorizes a seller against the loan's
 *         seller-claim list, because the terminal split deletes that list
 *         before it pays.
 * @dev    Keyed by (loan, seller). Single-use: a consume lowers it by what it
 *         pays and refuses more than is left. Transient storage clears itself
 *         when the transaction ends; the writer also clears it after the
 *         payout, so nothing is left for a later step of the same transaction.
 */
library LibSellerPayAuth {
    bytes32 private constant BASE = keccak256("vaipakam.sellerclaim.payauth");

    error SellerPayoutNotAuthorized(uint256 loanId, address seller, uint256 amount, uint256 authorized);

    function _key(uint256 loanId, address seller) private pure returns (bytes32) {
        return keccak256(abi.encode(BASE, loanId, seller));
    }

    /// @notice Authorize paying `seller` up to `amount` on `loanId` in this
    ///         transaction (replaces any earlier authorization).
    function authorize(uint256 loanId, address seller, uint256 amount) internal {
        bytes32 key = _key(loanId, seller);
        assembly ("memory-safe") {
            tstore(key, amount)
        }
    }

    /// @notice Clear the authorization (after the payout, used or not).
    function clear(uint256 loanId, address seller) internal {
        authorize(loanId, seller, 0);
    }

    /// @notice Spend `amount` of the authorization; refuses more than is left.
    function consume(uint256 loanId, address seller, uint256 amount) internal {
        bytes32 key = _key(loanId, seller);
        uint256 left;
        assembly ("memory-safe") {
            left := tload(key)
        }
        if (seller == address(0) || amount > left) revert SellerPayoutNotAuthorized(loanId, seller, amount, left);
        unchecked {
            left -= amount;
        }
        assembly ("memory-safe") {
            tstore(key, left)
        }
    }
}
