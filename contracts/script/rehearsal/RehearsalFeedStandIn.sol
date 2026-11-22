// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title RehearsalFeedStandIn
 * @notice What the deploy rehearsal places at a real feed's address on a fork
 *         when a clock step would leave the feed stale and its own storage
 *         cannot be re-stamped provably (#3891, ruling on open item 4,
 *         condition 2). It answers exactly the latest round the real feed
 *         answered (round, answer, decimals) with only the time moved, and the
 *         report lists the feed as replaced.
 * @dev    Never deployed by a constructor: the driver writes this runtime code
 *         over the feed (`anvil_setCode`) and sets the three slots directly
 *         (`anvil_setStorageAt`), so the layout below is fixed and the driver
 *         relies on it:
 *           slot 0  answer     (int256)
 *           slot 1  updatedAt  (uint256)
 *           slot 2  roundId    (uint80, low bits) | decimals (uint8, bits 80-87)
 *         `startedAt` reads as `updatedAt` and `answeredInRound` as `roundId`.
 *         Any earlier round reads as the latest one.
 */
contract RehearsalFeedStandIn {
    int256 internal answer;
    uint256 internal updatedAt;
    uint80 internal roundId;
    uint8 internal feedDecimals;

    function decimals() external view returns (uint8) {
        return feedDecimals;
    }

    function description() external pure returns (string memory) {
        return "RehearsalFeedStandIn";
    }

    function version() external pure returns (uint256) {
        return 0;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    function getRoundData(uint80) external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
