// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {MockSanctionsList} from "./MockSanctionsList.sol";

/**
 * @title  MockTimestampedSanctionsOracle
 * @notice A scriptable stand-in for RedStone's Sanctions Oracle: the
 *         Chainalysis-shaped `isSanctioned` read (inherited from
 *         `MockSanctionsList`, with its outage switches) plus RedStone's
 *         `getLastUpdateBlockTimestamp()` freshness read, which a test can
 *         also make revert.
 */
contract MockTimestampedSanctionsOracle is MockSanctionsList {
    uint256 public lastUpdate;
    bool public revertOnTimestamp;

    function setLastUpdate(uint256 ts) external {
        lastUpdate = ts;
    }

    function setRevertOnTimestamp(bool v) external {
        revertOnTimestamp = v;
    }

    function getLastUpdateBlockTimestamp() external view returns (uint256) {
        if (revertOnTimestamp) revert("timestamp-outage");
        return lastUpdate;
    }
}

/**
 * @title  MockSilentFallbackOracle
 * @notice An oracle whose unknown selectors land in a fallback that returns
 *         nothing — the shape a freshness read must tolerate without a
 *         decode revert.
 */
contract MockSilentFallbackOracle is MockSanctionsList {
    fallback() external {}
}
