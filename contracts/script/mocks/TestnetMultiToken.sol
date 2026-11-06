// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/**
 * @title TestnetMultiToken
 * @notice Testnet-only ERC-1155 collection for the faucet and the app's
 *         ERC-1155 collateral flows: anyone may mint any amount of any id to
 *         themselves or another address, so a wallet can try a request that
 *         locks a quantity of one token. It carries a name and a symbol (the
 *         ERC-1155 standard has neither) so the app can name the collection
 *         the way it names an ERC-721 one.
 * @dev    NEVER deployed on a mainnet: {DeployTestnetMocks} refuses every
 *         chain outside its testnet list, and the deployment record writes
 *         this address only under `testnetMocks`.
 */
contract TestnetMultiToken is ERC1155 {
    /// @notice The collection's display name.
    string public name;
    /// @notice The collection's short symbol.
    string public symbol;

    constructor(string memory name_, string memory symbol_) ERC1155("") {
        name = name_;
        symbol = symbol_;
    }

    /// @notice Mints `amount` of token `id` to `to` (open to anyone; testnet only).
    /// @dev Runs the standard receiver check, so a contract recipient must
    ///      accept ERC-1155 tokens.
    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }
}
