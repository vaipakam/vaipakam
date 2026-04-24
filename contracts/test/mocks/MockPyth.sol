// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IPyth, PythPrice} from "../../src/interfaces/IPyth.sol";

/**
 * @title MockPyth
 * @notice Scriptable Pyth endpoint for Phase 3.2 tests. Lets a test
 *         preload a specific price / expo / publishTime per feed id,
 *         control whether reads revert (stale / missing), and assert
 *         how many `updatePriceFeeds` calls have landed.
 */
contract MockPyth is IPyth {
    struct StoredPrice {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
        bool set;
    }

    mapping(bytes32 => StoredPrice) public stored;

    uint256 public feePerUpdate = 1 wei;
    uint256 public updateCallCount;
    bool public staleOnRead;

    function setPrice(
        bytes32 id,
        int64 price,
        uint64 conf,
        int32 expo,
        uint256 publishTime
    ) external {
        stored[id] = StoredPrice({
            price: price,
            conf: conf,
            expo: expo,
            publishTime: publishTime,
            set: true
        });
    }

    function clearPrice(bytes32 id) external {
        delete stored[id];
    }

    function setStaleOnRead(bool v) external {
        staleOnRead = v;
    }

    function setFee(uint256 v) external {
        feePerUpdate = v;
    }

    function getPriceNoOlderThan(
        bytes32 id,
        uint256 age
    ) external view returns (PythPrice memory) {
        if (staleOnRead) revert("stale");
        StoredPrice memory s = stored[id];
        if (!s.set) revert("not set");
        if (s.publishTime + age < block.timestamp) revert("stale");
        return PythPrice({
            price: s.price,
            conf: s.conf,
            expo: s.expo,
            publishTime: s.publishTime
        });
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        updateData; // silence unused-var warning
        updateCallCount += 1;
        // In a real Pyth impl the updateData would carry signed
        // (feedId, price, expo, publishTime) tuples and the contract
        // would decode + store them. For tests we just count the call
        // and let the test's setPrice precondition do the staging.
    }

    function getUpdateFee(
        bytes[] calldata updateData
    ) external view returns (uint256 feeAmount) {
        return feePerUpdate * updateData.length;
    }
}
