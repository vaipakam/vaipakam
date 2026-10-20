// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {VirtualPosition} from "./Fixture.sol";

// Test fixture: overriding the position function moves the namespace, so the
// guard must refuse to resolve the pointer in Fixture.sol statically.
contract OverridesPosition is VirtualPosition {
    function _vPosition() internal pure override returns (bytes32) {
        return keccak256("fixture.moved");
    }
}
