// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ERC20Mock} from "./ERC20Mock.sol";

/**
 * @title  WeirdERC20Mock — the non-standard ERC-20 behaviours of the #1220
 *         sweep, each switched on separately, on top of {ERC20Mock}.
 * @notice - FREEZE (USDT/USDC-style blacklist): a transfer from or to a frozen
 *           address reverts, and so does an `approve` by one.
 *         - PAUSE: every transfer reverts while the token is paused.
 *         - FALSE RETURN: `transfer` / `transferFrom` return `false` and move
 *           nothing, instead of reverting.
 *         - REBASE: {rebase} moves a holder's balance up or down with no
 *           transfer, the way a rebasing token changes balances in place.
 *         Mints are never blocked, so a fixture can always fund a party.
 *
 * @dev    It only APPENDS state to {ERC20Mock}, so a test can `vm.etch` its
 *         code over a live `ERC20Mock` and keep every balance and allowance,
 *         the way `FeeOnTransferERC20Mock` is used (#2440).
 */
contract WeirdERC20Mock is ERC20Mock {
    /// @notice Addresses the issuer has frozen.
    mapping(address => bool) public frozen;
    /// @notice While set, every transfer reverts.
    bool public paused;
    /// @notice While set, `transfer` / `transferFrom` return false and move nothing.
    bool public returnsFalse;

    error AddressFrozen(address who);
    error TokenPaused();

    constructor(string memory name, string memory symbol, uint8 decimals_)
        ERC20Mock(name, symbol, decimals_)
    {}

    function setFrozen(address who, bool v) external {
        frozen[who] = v;
    }

    function setPaused(bool v) external {
        paused = v;
    }

    function setReturnsFalse(bool v) external {
        returnsFalse = v;
    }

    /// @notice A rebase of one holder: its balance becomes `newBalance` with
    ///         no transfer event a recipient could observe.
    function rebase(address holder, uint256 newBalance) external {
        uint256 b = balanceOf(holder);
        if (newBalance > b) _mint(holder, newBalance - b);
        else if (newBalance < b) _burn(holder, b - newBalance);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (returnsFalse) return false;
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (returnsFalse) return false;
        return super.transferFrom(from, to, value);
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        if (frozen[msg.sender]) revert AddressFrozen(msg.sender);
        return super.approve(spender, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        // Mints and burns (a fixture's funding, a rebase) are never blocked.
        if (from != address(0) && to != address(0)) {
            if (paused) revert TokenPaused();
            if (frozen[from]) revert AddressFrozen(from);
            if (frozen[to]) revert AddressFrozen(to);
        }
        super._update(from, to, value);
    }
}
