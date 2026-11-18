// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title  LibFeeShares
 * @author Vaipakam Developer Team
 * @notice #3682 / #3722 — the one rule for the parts taken from the
 *         initiation fee's part above the treasury floor
 *         (`ReferralFeeShareDesign.md` 2.1, `IntegratorFeeShareDesign.md`
 *         section 6). In order: the new user's referral cut (never
 *         collected), the matcher's share, the integrator's share, the
 *         inviter's share; the rest is the reserve's.
 *
 *         One per-loan ceiling (default 60% of the above-floor part, a
 *         setting bounded 40% to 70%) bounds the cut and the three shares
 *         together. When the sum would exceed it, the inviter's share is
 *         reduced first, then the integrator's, then the matcher's, until it
 *         fits. The cut is never reduced (it is at most 30% of the part, below
 *         the lowest ceiling), so a borrower's preview does not depend on who
 *         else is named on the loan, and the reserve always receives at least
 *         the part the ceiling leaves.
 */
library LibFeeShares {
    /// @notice The per-loan ceiling in force, in basis points of the
    ///         above-floor part.
    function ceilingBps() internal view returns (uint256) {
        uint16 v = LibVaipakam.storageSlot().feeShareCfg.ceilingBps;
        return v == 0 ? LibVaipakam.FEE_SHARE_CEILING_BPS_DEFAULT : v;
    }

    /// @notice Bound the shares of `above` under the ceiling, reducing the
    ///         inviter's, then the integrator's, then the matcher's.
    /// @param above      The initiation fee's part above the treasury floor.
    /// @param cut        The new user's referral cut (never reduced).
    /// @param matcher    The matcher's share before the ceiling.
    /// @param integrator The integrator's share before the ceiling.
    /// @param inviter    The inviter's share before the ceiling.
    /// @return The three shares after the ceiling, in the same order.
    function bound(uint256 above, uint256 cut, uint256 matcher, uint256 integrator, uint256 inviter)
        internal
        view
        returns (uint256, uint256, uint256)
    {
        uint256 room = (above * ceilingBps()) / LibVaipakam.BASIS_POINTS;
        room = room > cut ? room - cut : 0;
        // Fill in reverse of the reduction order: the matcher first, then the
        // integrator, then the inviter, each taking what room is left.
        if (matcher > room) matcher = room;
        room -= matcher;
        if (integrator > room) integrator = room;
        room -= integrator;
        if (inviter > room) inviter = room;
        return (matcher, integrator, inviter);
    }
}
