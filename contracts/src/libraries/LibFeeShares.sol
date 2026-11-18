// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibReferral} from "./LibReferral.sol";

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
 *         together. The settings themselves keep the matcher's rate plus the
 *         cut rate at or under the ceiling ({requireMatcherAndCutFit}, checked
 *         by each of the three setters), so the cut and the matcher's share
 *         are never reduced: a borrower's preview does not depend on who else
 *         is named on the loan, and a matcher is always paid its stated rate.
 *         When the sum would still exceed the ceiling, the inviter's share is
 *         reduced first, then the integrator's, until it fits, and the
 *         reserve always receives at least the part the ceiling leaves.
 */
library LibFeeShares {
    /// @notice A setting would put the matcher's rate plus the new user's
    ///         cut rate above the per-loan ceiling (all in basis points of
    ///         the initiation fee's part above the treasury floor).
    error MatcherAndCutAboveCeiling(uint256 matcherBps, uint256 cutBps, uint256 ceilingBps);

    /// @notice The per-loan ceiling in force, in basis points of the
    ///         above-floor part.
    function ceilingBps() internal view returns (uint256) {
        uint16 v = LibVaipakam.storageSlot().feeShareCfg.ceilingBps;
        return v == 0 ? LibVaipakam.FEE_SHARE_CEILING_BPS_DEFAULT : v;
    }

    /// @notice Revert unless the matcher's rate plus the cut rate in force
    ///         is at or under the ceiling in force. Each of the three setters
    ///         (`FeeLevelsFacet.setLifMatcherFeeBps`,
    ///         `ReferralFacet.setReferralRates`,
    ///         `FeeLevelsFacet.setFeeShareCeiling`) calls it after its write,
    ///         so no combination of settings can need the matcher's share or
    ///         the cut reduced at a loan.
    function requireMatcherAndCutFit() internal view {
        uint256 matcherBps = LibVaipakam.cfgLifMatcherFeeBps();
        (uint256 cutBps,) = LibReferral.rates();
        uint256 ceiling = ceilingBps();
        if (matcherBps + cutBps > ceiling) revert MatcherAndCutAboveCeiling(matcherBps, cutBps, ceiling);
    }

    /// @notice Bound the integrator's and inviter's shares of `above` under
    ///         the ceiling, reducing the inviter's first, then the
    ///         integrator's. The cut and the matcher's share pass through:
    ///         the settings keep their rates together under the ceiling
    ///         ({requireMatcherAndCutFit}), and since each amount is its rate
    ///         of `above` rounded down, their sum never exceeds the ceiling's
    ///         amount either. The room still saturates at zero rather than
    ///         reverting, because a fee step must never fail a loan.
    /// @param above      The initiation fee's part above the treasury floor.
    /// @param cut        The new user's referral cut (never reduced).
    /// @param matcher    The matcher's share (never reduced).
    /// @param integrator The integrator's share before the ceiling.
    /// @param inviter    The inviter's share before the ceiling.
    /// @return The integrator's and the inviter's shares after the ceiling.
    function bound(uint256 above, uint256 cut, uint256 matcher, uint256 integrator, uint256 inviter)
        internal
        view
        returns (uint256, uint256)
    {
        uint256 room = (above * ceilingBps()) / LibVaipakam.BASIS_POINTS;
        uint256 taken = cut + matcher;
        room = room > taken ? room - taken : 0;
        // Fill in reverse of the reduction order: the integrator first, then
        // the inviter, each taking what room is left.
        if (integrator > room) integrator = room;
        room -= integrator;
        if (inviter > room) inviter = room;
        return (integrator, inviter);
    }
}
