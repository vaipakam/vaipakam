// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPositionNFT} from "./LibPositionNFT.sol";

/**
 * @title LibStandingInstructions — the one-plan rule for a loan's due date (#3681).
 * @notice A loan's due date has at most one plan set by its borrower-position
 *         holder: the "repay at the due date" standing instruction, OR the
 *         automatic-extension / automatic-refinance limits. Whichever is set
 *         second is refused until the first is cleared. Each side asks this
 *         library about the other, so the rule is written once.
 * @dev    A setting counts only while the wallet that set it still holds the
 *         borrower position, matching the staleness fence the extension and
 *         refinance limits already apply on read.
 */
library LibStandingInstructions {
    /// @notice True when the holder's "repay at the due date" instruction
    ///         stands on `loan`.
    function repayAtDueLive(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan)
        internal
        view
        returns (bool)
    {
        LibVaipakam.StandingInstructions storage si = s.standingInstructions[loan.id];
        return si.repayAtDue && si.owner == LibPositionNFT.ownerOf(loan.borrowerTokenId);
    }

    /// @notice True when the holder's automatic-extension or
    ///         automatic-refinance limits stand on `loan`.
    function autoDueDatePlanLive(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan)
        internal
        view
        returns (bool)
    {
        address holder = LibPositionNFT.ownerOf(loan.borrowerTokenId);
        LibVaipakam.AutoExtendCaps storage ext = s.autoExtendBorrowerCaps[loan.id];
        if (ext.enabled && ext.setter == holder) return true;
        LibVaipakam.AutoRefinanceCaps storage ref = s.autoRefinanceCaps[loan.id];
        return ref.enabled && ref.setter == holder;
    }
}
