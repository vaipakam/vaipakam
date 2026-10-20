// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../../src/interfaces/ISwapAdapter.sol";

/**
 * @title PartialFillSwapAdapter — test-only venue that spends only part of
 *        the input it is offered (#2472).
 *
 * Models an aggregator route quoted for less than the amount the caller
 * offers: it pulls the full `inputAmount`, keeps `spendBps` of it as the
 * venue's consumption, pays `spent * outputPerInputBps / 10000` of
 * `outputToken` (which it must already hold) to `recipient`, and hands the
 * unspent input back to `msg.sender` — exactly what `ISwapAdapter` requires
 * of a partial fill. Enforces `minOutputAmount` like every real adapter.
 * Never registered on a live chain.
 */
contract PartialFillSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    uint256 public spendBps = 10_000;
    uint256 public outputPerInputBps = 10_000;

    function setSpendBps(uint256 v) external {
        spendBps = v;
    }

    function setOutputPerInputBps(uint256 v) external {
        outputPerInputBps = v;
    }

    function adapterName() external pure override returns (string memory) {
        return "partial-fill";
    }

    function execute(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        bytes calldata /* adapterData */
    ) external override returns (uint256 outputAmount) {
        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), inputAmount);
        uint256 spent = (inputAmount * spendBps) / 10_000;
        outputAmount = (spent * outputPerInputBps) / 10_000;
        require(outputAmount >= minOutputAmount, "PartialFillSwapAdapter: min-out");
        IERC20(outputToken).safeTransfer(recipient, outputAmount);
        if (inputAmount > spent) {
            IERC20(inputToken).safeTransfer(msg.sender, inputAmount - spent);
        }
    }
}
