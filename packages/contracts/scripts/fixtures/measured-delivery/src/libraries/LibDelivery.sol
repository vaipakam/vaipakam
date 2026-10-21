// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "../../lib/IERC20.sol";
import {SafeERC20} from "../../lib/SafeERC20.sol";

// Fixture: the library every measured move goes through. Its own moves are
// the rule, not exceptions to it.
library LibDelivery {
    using SafeERC20 for IERC20;

    function pushOut(address token, address to, uint256 amount) internal {
        IERC20(token).safeTransfer(to, amount);
    }
}
