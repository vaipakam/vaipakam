// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

contract Commented {
    uint256 internal total; // the running total

    event Added(uint256 amount);

    error TooMuch(uint256 amount);

    /**
     * @notice Adds `amount`, refusing more than a hundred.
     */
    function add(uint256 amount) external {
        // refuse a large amount
        if (amount > 100) revert TooMuch(amount); /* typed error */
        total = total + amount;
        emit Added(amount);
    }
}
