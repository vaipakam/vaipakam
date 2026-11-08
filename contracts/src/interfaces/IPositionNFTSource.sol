// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/// @title  IPositionNFTSource
/// @notice #3205 — where the Diamond's position NFTs live. Since the
///         PositionNFT core left the Diamond, a contract that holds position
///         NFTs (the backstop vault, an aggregator adapter) recognises them by
///         the core's address, read from the Diamond, never by the Diamond's
///         own address: the core mints (so it is the `onERC721Received`
///         caller) and it is the token contract a sweep would name.
interface IPositionNFTSource {
    /// @notice The PositionNFT core (0 before it is installed).
    function positionNFT() external view returns (address);
}
