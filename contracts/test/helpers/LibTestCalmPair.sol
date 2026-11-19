// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {SaleFloorFacet} from "../../src/facets/SaleFloorFacet.sol";

/// @title  LibTestCalmPair
/// @notice A lender intent slot's fill is refused unless its pair is calm
///         against the hourly price checkpoints of the last two hours
///         (`OfferPriceGuardFacet.requireIntentPairCalm`). A suite that fills
///         an intent writes those checkpoints first, the way the keeper's
///         hourly pass does live.
library LibTestCalmPair {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Write checkpoints for `a` and `b` in two consecutive hours at
    ///         the current prices and step into the hour after, where both are
    ///         "the last two hours". Moves the clock forward by one to two
    ///         hours.
    function checkpoint(address diamond, address a, address b) internal {
        address[] memory assets = new address[](2);
        assets[0] = a;
        assets[1] = b;
        VM.warp(((VM.getBlockTimestamp() / 1 hours) + 1) * 1 hours);
        SaleFloorFacet(diamond).checkpointHourlyPrices(assets);
        VM.warp(VM.getBlockTimestamp() + 1 hours);
        SaleFloorFacet(diamond).checkpointHourlyPrices(assets);
        VM.warp(VM.getBlockTimestamp() + 1 hours);
    }
}
