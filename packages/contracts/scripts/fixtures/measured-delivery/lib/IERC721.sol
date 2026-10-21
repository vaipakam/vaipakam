// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

// Fixture: the ERC-721 shape. Its `transferFrom` has ERC-20's selector, but it
// declares no `transfer`, so a reference to it is not an ERC-20 move.
interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}
