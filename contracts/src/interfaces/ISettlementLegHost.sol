// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ITreasuryFeeHost} from "./ITreasuryFeeHost.sol";

/// @title  ISettlementLegHost
/// @notice #3669 — the treasury entry of `SettlementLegFacet` that
///         `LibFacet.treasuryShareOrPark` self-calls, declared apart so the
///         library needs no import of the facet.
interface ISettlementLegHost {
    function treasuryShareOrPark(
        uint8 source,
        address owner,
        address asset,
        uint256 amount,
        ITreasuryFeeHost.FeeBasis calldata basis
    )
        external
        returns (uint256 accrued, bool parked);
}
