// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title  LibAdvance
 * @author Vaipakam Developer Team
 * @notice #3760 — the lock an advance puts on a lender position
 *         (LenderCashOutDesign §6.5), read wherever the position could
 *         otherwise leave its holder or have its money re-lent: the sale-exit
 *         verdict (the direct sale, the listing and the takeover), the
 *         position token's transfer check, the Auto-lend roll and re-commit,
 *         and the in-place renewal and extension.
 * @dev    The record is kept by loan, not by token. A position is locked
 *         while its advance is open (anything owed) and while money set aside
 *         for the advance still waits in a vault for the slot owner: until
 *         that has moved, the position's money is not all the holder's.
 */
library LibAdvance {
    /// @notice The loan's lender position carries an open advance (or money
    ///         set aside for one that has not yet reached the slot owner), so
    ///         it cannot be transferred, sold, listed, taken over or have its
    ///         money re-lent until the advance is repaid and paid out.
    error AdvanceLocksPosition(uint256 loanId);

    /// @notice True while `loanId`'s lender position is locked by an advance.
    function locked(LibVaipakam.Storage storage s, uint256 loanId) internal view returns (bool) {
        return s.advances[loanId].open || hasSetAside(s, loanId);
    }

    /// @notice True while money booked to `loanId`'s advance still waits in
    ///         the lender side's vault for the slot owner.
    function hasSetAside(LibVaipakam.Storage storage s, uint256 loanId) internal view returns (bool) {
        LibVaipakam.Advance storage a = s.advances[loanId];
        return a.setAside != 0 || a.inKindSetAside != 0 || a.heldElsewhere != 0;
    }

    /// @notice Reverts {AdvanceLocksPosition} while an advance is open on
    ///         `loanId`. For the steps that settle any money already set aside
    ///         first (the Auto-lend roll and re-commit pay it to the slot owner
    ///         before they touch the holder's part), only an open advance
    ///         refuses them.
    function requireNoOpenAdvance(LibVaipakam.Storage storage s, uint256 loanId) internal view {
        if (s.advances[loanId].open) revert AdvanceLocksPosition(loanId);
    }

    /// @notice Reverts {AdvanceLocksPosition} while `loanId` is locked.
    function requireUnlocked(LibVaipakam.Storage storage s, uint256 loanId) internal view {
        if (locked(s, loanId)) revert AdvanceLocksPosition(loanId);
    }
}
