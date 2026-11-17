// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {ITreasuryFeeHost} from "../interfaces/ITreasuryFeeHost.sol";

/**
 * @title  LibFeeFloor
 * @author Vaipakam Developer Team
 * @notice #3649 stage 3 — the treasury floor of the two fees that feed the
 *         reserve (`docs/DesignsAndPlans/ShortfallReserveDesign.md` section
 *         8): the treasury keeps the part of a fee up to its floor, and the
 *         part above it is the reserve's.
 *         - Initiation fee: the floor is a share of the loan's principal
 *           (default 0.1%), taken once, at acceptance.
 *         - Treasury share of an ERC-20 loan's interest: the floor is a share
 *           of the interest it was taken from (default 1%).
 *         - An extension's added initiation fee takes no floor: the reserve's
 *           whole, so a term reached in one step or in many sends the same
 *           totals to each side.
 *         - Every other fee is the treasury's whole.
 *         A fee discount therefore comes out of the reserve's part first and
 *         never out of the floor.
 * @dev    The split itself runs once, in `TreasuryFeeFacet`; the one other
 *         reader is the acceptance charge, which sizes the matcher's share
 *         on the part above the floor ({aboveFloor}). Floors round UP, so the
 *         treasury is never short of its floor by rounding.
 */
library LibFeeFloor {
    /// @notice The two floors in force, defaults resolved, in basis points.
    function floorsBps() internal view returns (uint256 initiationBps, uint256 interestBps) {
        LibVaipakam.FeeFloorConfig storage c = LibVaipakam.storageSlot().feeFloorCfg;
        initiationBps = c.initiationBps == 0 ? LibVaipakam.FEE_FLOOR_INITIATION_BPS_DEFAULT : c.initiationBps;
        interestBps = c.interestBps == 0 ? LibVaipakam.FEE_FLOOR_INTEREST_BPS_DEFAULT : c.interestBps;
    }

    /// @notice The treasury's floor on a fee of `kind` with floor base
    ///         `base`: the principal for an initiation fee, the interest for
    ///         an interest share. `type(uint256).max` for a fee the treasury
    ///         keeps whole, 0 for an extension's added fee.
    function floorOf(ITreasuryFeeHost.FeeKind kind, uint256 base) internal view returns (uint256) {
        if (kind == ITreasuryFeeHost.FeeKind.Other) return type(uint256).max;
        if (kind == ITreasuryFeeHost.FeeKind.Extension) return 0;
        (uint256 initiationBps, uint256 interestBps) = floorsBps();
        uint256 bps = kind == ITreasuryFeeHost.FeeKind.Initiation ? initiationBps : interestBps;
        return (base * bps + LibVaipakam.BASIS_POINTS - 1) / LibVaipakam.BASIS_POINTS;
    }

    /// @notice Split `amount` of a fee of `kind` (floor base `base`) into the
    ///         treasury's part, up to the floor, and the reserve's part above.
    function split(ITreasuryFeeHost.FeeKind kind, uint256 base, uint256 amount)
        internal
        view
        returns (uint256 treasuryPart, uint256 reservePart)
    {
        uint256 floor = floorOf(kind, base);
        treasuryPart = amount < floor ? amount : floor;
        reservePart = amount - treasuryPart;
    }

    /// @notice The part of an initiation fee `fee` on `principal` above the
    ///         treasury floor: the base the matcher's share is sized on.
    function aboveFloor(uint256 fee, uint256 principal) internal view returns (uint256) {
        uint256 floor = floorOf(ITreasuryFeeHost.FeeKind.Initiation, principal);
        return fee > floor ? fee - floor : 0;
    }
}
