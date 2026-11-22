// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

interface IAdder {
    function add(uint256 amount) external;
}

library LibText {
    using LibText for uint256;

    function same(uint256 a) internal pure returns (string memory) {
        return a > 1 ? "a // not a comment" : "b /* nor this */";
    }
}
