// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ERC20Mock} from "./ERC20Mock.sol";

/**
 * @title FeeOnTransferERC20Mock — test-only ERC-20 that burns `feeBps` of
 *        every transfer, so the recipient receives less than the amount sent.
 *
 * Mints and burns are fee-free. Used to prove that a delivery the protocol
 * relies on is measured, not assumed (#2472, #2440, #667).
 */
contract FeeOnTransferERC20Mock is ERC20Mock {
    uint256 public feeBps;

    constructor(string memory name, string memory symbol, uint8 decimals_)
        ERC20Mock(name, symbol, decimals_)
    {}

    function setFeeBps(uint256 v) external {
        feeBps = v;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}
