// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IERC4907} from "../../src/interfaces/IERC4907.sol";

/**
 * @title ERC1155RentableMock
 * @notice ERC1155 mock that also implements IERC4907 (setUser/userOf/userExpires)
 *         to support NFT rental flows in the Vaipakam Diamond.
 */
contract ERC1155RentableMock is ERC1155, IERC4907 {
    struct UserInfo {
        address user;
        uint64 expires;
    }

    mapping(uint256 => UserInfo) internal _users;

    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    function forceMint(address to, uint256 id, uint256 amount) external {
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = id;
        amounts[0] = amount;
        _update(address(0), to, ids, amounts);
    }

    // ── IERC4907 implementation ────────────────────────────────────────

    function setUser(uint256 tokenId, address user, uint64 expires) external {
        UserInfo storage info = _users[tokenId];
        info.user = user;
        info.expires = expires;
        emit UpdateUser(tokenId, user, expires);
    }

    function userOf(uint256 tokenId) external view returns (address) {
        if (uint256(_users[tokenId].expires) >= block.timestamp) {
            return _users[tokenId].user;
        }
        return address(0);
    }

    function userExpires(uint256 tokenId) external view returns (uint64) {
        return _users[tokenId].expires;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual override(ERC1155, IERC4907) returns (bool) {
        return
            interfaceId == type(IERC4907).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
