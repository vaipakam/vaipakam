// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

// The same function, carried into another contract in another file, with
// other indentation.
contract Elsewhere {
    uint256 internal total;

  function add(uint256 amount) external {
      if (amount > 100) revert TooMuch(amount);
      total = total + amount;
      emit Added(amount);
  }

    event Added(uint256 amount);
    error TooMuch(uint256 amount);
}
