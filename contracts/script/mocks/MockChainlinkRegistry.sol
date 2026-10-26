// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title MockChainlinkFeed
 * @notice Simulates a Chainlink AggregatorV3Interface price feed.
 * @dev    Deployer-gated: these feeds get wired as a public testnet
 *         Diamond's LIVE price source (DeployTestnetMocks) — an open
 *         `setPrice` would let anyone reprice tLIQ/WETH and flip the
 *         HF / liquidation / VPFI-discount demos to arbitrary values.
 *         Scripts and tests deploy-and-configure from one address, so
 *         the gate is invisible to them.
 */
contract MockChainlinkFeed {
    address public immutable owner;

    int256 public price;
    uint8 public decimals;
    uint80 public roundId;

    constructor(int256 _price, uint8 _decimals) {
        owner = msg.sender;
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
        require(msg.sender == owner, "MockChainlinkFeed: not owner");
        price = _price;
        roundId++;
    }
}

/**
 * @title MockChainlinkPairFeed
 * @notice A {MockChainlinkFeed} that also answers `description()` with its
 *         pair name, as a real Chainlink feed does. `VaipakamFeedRegistry`
 *         checks that name on every entry (#2880), so the testnet rig's feeds
 *         are of this kind.
 */
contract MockChainlinkPairFeed is MockChainlinkFeed {
    string public description;

    constructor(int256 _price, uint8 _decimals, string memory _pair) MockChainlinkFeed(_price, _decimals) {
        description = _pair;
    }
}

/**
 * @title MockChainlinkRegistry
 * @notice Simulates Chainlink's FeedRegistryInterface, for unit tests and the
 *         stand-alone dev flow scripts that build a throwaway Diamond. Every
 *         deploy path that reaches a chain (the testnet rig, the Anvil
 *         bootstrap, the e2e fixture) uses the real `VaipakamFeedRegistry`
 *         instead (#2880).
 *         The DEPLOYER registers (base, quote) -> feed mappings; an
 *         open `setFeed` would let anyone repoint a public testnet
 *         Diamond's price source (see MockChainlinkFeed note).
 */
contract MockChainlinkRegistry {
    address public immutable owner;

    mapping(address => mapping(address => address)) public feeds;

    constructor() {
        owner = msg.sender;
    }

    function setFeed(address base, address quote, address feed) external {
        require(msg.sender == owner, "MockChainlinkRegistry: not owner");
        feeds[base][quote] = feed;
    }

    function getFeed(address base, address quote) external view returns (address) {
        address feed = feeds[base][quote];
        require(feed != address(0), "Feed not found");
        return feed;
    }
}
