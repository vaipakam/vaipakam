// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title MockChainlinkFeed
 * @notice Simulates a Chainlink AggregatorV3Interface price feed.
 */
contract MockChainlinkFeed {
    int256 public price;
    uint8 public decimals;
    uint80 public roundId;

    constructor(int256 _price, uint8 _decimals) {
        price = _price;
        decimals = _decimals;
        roundId = 1;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, price, block.timestamp, block.timestamp, roundId);
    }

    function setPrice(int256 _price) external {
        price = _price;
        roundId++;
    }
}

/**
 * @title MockChainlinkRegistry
 * @notice Simulates Chainlink's FeedRegistryInterface.
 *         Admin registers (base, quote) -> feed mappings.
 */
contract MockChainlinkRegistry {
    mapping(address => mapping(address => address)) public feeds;

    function setFeed(address base, address quote, address feed) external {
        feeds[base][quote] = feed;
    }

    function getFeed(address base, address quote) external view returns (address) {
        address feed = feeds[base][quote];
        require(feed != address(0), "Feed not found");
        return feed;
    }
}
