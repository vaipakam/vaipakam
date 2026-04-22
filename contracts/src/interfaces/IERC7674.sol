// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IERC7674 is IERC20 {
    /// @notice Allows `spender` to withdraw *within the same transaction*, from the caller,
    /// multiple times, up to `amount`.
    function temporaryApprove(
        address spender,
        uint256 amount
    ) external returns (bool);
}
