// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title MockChainlinkAggregator
/// @notice Scripts Chainlink price feed rounds for OracleFacet tests.
///         Lets tests set answer / updatedAt / roundId / decimals
///         independently so the stablecoin-aware staleness hybrid and
///         other price-path guards can be exercised without pulling in
///         real feed fixtures.
contract MockChainlinkAggregator is AggregatorV3Interface {
    int256 public answer_;
    uint256 public updatedAt_;
    uint80 public roundId_;
    uint8 public decimals_;

    constructor(int256 initialAnswer, uint256 initialUpdatedAt, uint8 feedDecimals) {
        answer_ = initialAnswer;
        updatedAt_ = initialUpdatedAt;
        decimals_ = feedDecimals;
        roundId_ = 1;
    }

    function setRound(int256 newAnswer, uint256 newUpdatedAt) external {
        answer_ = newAnswer;
        updatedAt_ = newUpdatedAt;
        roundId_ += 1;
    }

    function setAnswer(int256 newAnswer) external {
        answer_ = newAnswer;
        roundId_ += 1;
    }

    function setUpdatedAt(uint256 newUpdatedAt) external {
        updatedAt_ = newUpdatedAt;
    }

    function setAnsweredInRoundMismatch() external {
        // Artificially desync roundId so `roundId != answeredInRound`.
        roundId_ += 1;
    }

    function decimals() external view override returns (uint8) {
        return decimals_;
    }

    function description() external pure override returns (string memory) {
        return "MockChainlinkAggregator";
    }

    function version() external pure override returns (uint256) {
        return 1;
    }

    function getRoundData(uint80 _roundId)
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (_roundId, answer_, updatedAt_, updatedAt_, _roundId);
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId_, answer_, updatedAt_, updatedAt_, roundId_);
    }
}
