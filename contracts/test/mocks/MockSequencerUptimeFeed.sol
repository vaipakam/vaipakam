// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title MockSequencerUptimeFeed
/// @notice Test double for the Chainlink L2 Sequencer Uptime feed
///         consumed by `OracleFacet._requireSequencerHealthy`. Lets
///         tests script sequencer state transitions (up / down / just
///         recovered) without depending on the real feed.
/// @dev Chainlink L2 uptime feed encoding:
///        answer == 0 → sequencer UP
///        answer == 1 → sequencer DOWN
///      `startedAt` is the unix timestamp when the current status began;
///      The protocol's 1h grace period is measured against this value.
contract MockSequencerUptimeFeed is AggregatorV3Interface {
    int256 public answer_; // 0=up, 1=down
    uint256 public startedAt_;
    uint80 public roundId_ = 1;
    uint8 public constant override decimals = 0;

    /// @param initialAnswer 0 = up, 1 = down at construction.
    /// @param initialStartedAt Unix seconds when the current status began.
    constructor(int256 initialAnswer, uint256 initialStartedAt) {
        answer_ = initialAnswer;
        startedAt_ = initialStartedAt;
    }

    function setStatus(int256 newAnswer, uint256 newStartedAt) external {
        answer_ = newAnswer;
        startedAt_ = newStartedAt;
        roundId_ += 1;
    }

    function description() external pure override returns (string memory) {
        return "MockSequencerUptimeFeed";
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
        return (_roundId, answer_, startedAt_, startedAt_, _roundId);
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId_, answer_, startedAt_, block.timestamp, roundId_);
    }
}
