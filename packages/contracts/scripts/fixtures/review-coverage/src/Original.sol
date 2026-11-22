// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

contract Original {
    uint256 internal total;

    event Added(uint256 amount);

    error TooMuch(uint256 amount);

    /// Adds `amount`.
    function add(uint256 amount) external {
        if (amount > 100) revert TooMuch(amount);
        total = total + amount;
        emit Added(amount);
    }
}
