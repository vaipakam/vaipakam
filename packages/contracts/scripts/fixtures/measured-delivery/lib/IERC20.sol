// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

// Fixture for check-measured-delivery's tests: the ERC-20 shape (declares
// `transfer`, so its `transferFrom` is an ERC-20 move too).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}
