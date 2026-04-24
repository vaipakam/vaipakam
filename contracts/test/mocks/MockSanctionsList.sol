// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ISanctionsList} from "../../src/interfaces/ISanctionsList.sol";

/**
 * @title MockSanctionsList
 * @notice Scriptable Chainalysis-style sanctions oracle for Phase 4.3
 *         tests. Lets a test flag or clear addresses individually, or
 *         force the read to revert (simulates infrastructure outage)
 *         to verify the fail-open semantics in the wrapper.
 */
contract MockSanctionsList is ISanctionsList {
    mapping(address => bool) public flagged;
    bool public revertOnRead;

    function setFlagged(address who, bool isFlagged) external {
        flagged[who] = isFlagged;
    }

    function setRevertOnRead(bool v) external {
        revertOnRead = v;
    }

    function isSanctioned(address addr) external view returns (bool) {
        if (revertOnRead) revert("oracle-outage");
        return flagged[addr];
    }
}
