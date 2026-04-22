// test/mocks/ERC1155Mock.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/**
 * @dev ERC1155Mock with two mint helpers:
 *   - mint()       : standard OZ path (checks receiver hook, use only for contracts that support it)
 *   - forceMint()  : skips receiver check, for seeding arbitrary addresses (contracts or EOAs)
 */
contract ERC1155Mock is ERC1155 {
    constructor() ERC1155("") {}

    /// @dev Standard mint — calls onERC1155Received on contract recipients.
    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    /// @dev Force-mint: uses _update directly, bypassing the receiver hook.
    ///      Useful for seeding balances in contracts that don't implement IERC1155Receiver.
    function forceMint(address to, uint256 id, uint256 amount) external {
        // _update is the low-level state-change function; does not call checkOnERC1155Received.
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = id;
        amounts[0] = amount;
        _update(address(0), to, ids, amounts);
    }
}
