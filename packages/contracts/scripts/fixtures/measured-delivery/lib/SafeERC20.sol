// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "./IERC20.sol";

// Fixture: the library the check recognises by name. Its own body is under
// lib/, which the check does not scan.
library SafeERC20 {
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        token.transfer(to, value);
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        token.transferFrom(from, to, value);
    }

    function forceApprove(IERC20 token, address spender, uint256 value) internal pure {
        (token, spender, value);
    }
}
