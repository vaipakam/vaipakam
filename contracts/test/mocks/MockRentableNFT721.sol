// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC4907} from "../../src/interfaces/IERC4907.sol";

/// @notice Shared mock for ERC-4907 rentable NFTs used across test files.
contract MockRentableNFT721 is ERC721, IERC4907 {
    constructor() ERC721("MockNFT", "MNFT") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    mapping(uint256 => address) private _users;
    mapping(uint256 => uint64) private _expires;

    function setUser(
        uint256 tokenId,
        address user,
        uint64 expires
    ) external override {
        _users[tokenId] = user;
        _expires[tokenId] = expires;
    }

    function userOf(uint256 tokenId) external view override returns (address) {
        return _users[tokenId];
    }

    function userExpires(
        uint256 tokenId
    ) external view override returns (uint64) {
        return _expires[tokenId];
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual override(ERC721, IERC4907) returns (bool) {
        return
            interfaceId == type(IERC4907).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
