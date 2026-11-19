// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";

/// @title  LibTestGuard
/// @notice #3432 — the vault-move host runs only inside a guarded action
///         (the Diamond's reentrancy guard held, or a fill lock). A fixture
///         that calls the host directly AS the Diamond stands in for that
///         action: it marks the guard held for the one call and drops it
///         after. Only for fixtures that call the host itself; a test that
///         drives a real entry gets the guard from that entry.
library LibTestGuard {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    /// @dev `LibReentrancyGuard`'s ERC-7201 position.
    bytes32 internal constant SLOT = 0x04ba3822bc69a2ad3e1ccb8944f5c7cebff98e1206031ba7be7244e7e3f82700;

    function hold(address diamond) internal {
        VM.store(diamond, SLOT, bytes32(uint256(2)));
    }

    function release(address diamond) internal {
        VM.store(diamond, SLOT, bytes32(uint256(1)));
    }
}
