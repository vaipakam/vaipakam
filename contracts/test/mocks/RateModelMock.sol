// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IRateModel} from "../../src/interfaces/IRateModel.sol";

/// @title RateModelMock
/// @notice Test {IRateModel}: quotes `referenceRateBps + premiumBps`. A large
///         `premiumBps` drives the quote past `MAX_INTEREST_BPS` to exercise
///         the caller's ceiling re-assertion (#400).
contract RateModelMock is IRateModel {
    uint256 public premiumBps;

    constructor(uint256 _premiumBps) {
        premiumBps = _premiumBps;
    }

    function quoteRateBps(
        IRateModel.RateModelInput calldata input
    ) external view returns (uint256) {
        return input.referenceRateBps + premiumBps;
    }
}
