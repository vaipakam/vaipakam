// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../../src/interfaces/ISwapAdapter.sol";

/**
 * @title MockSwapAdapter — controllable ISwapAdapter for LibSwap failover tests.
 *
 * Configure with (`setShouldRevert`, `setOutputMultiplierBps`,
 * `setLabel`). The adapter pulls the full `inputAmount` via
 * `transferFrom` from `msg.sender`, then either reverts or
 * transfers `inputAmount * bps / 10000` of `outputToken` — which
 * the adapter must already hold. This shape lets a test compose
 * multiple mocks into a failover chain with varying outcomes.
 */
contract MockSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    string public label;
    bool public shouldRevert;
    uint256 public outputMultiplierBps = 10_000;
    uint256 public callCount;

    constructor(string memory _label) {
        label = _label;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function setOutputMultiplierBps(uint256 v) external {
        outputMultiplierBps = v;
    }

    function adapterName() external view override returns (string memory) {
        return label;
    }

    function execute(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        bytes calldata /* adapterData */
    ) external override returns (uint256 outputAmount) {
        callCount += 1;
        if (shouldRevert) revert("MockSwapAdapter: forced revert");

        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), inputAmount);
        outputAmount = (inputAmount * outputMultiplierBps) / 10_000;
        require(outputAmount >= minOutputAmount, "MockSwapAdapter: min-out");
        IERC20(outputToken).safeTransfer(recipient, outputAmount);
    }
}
