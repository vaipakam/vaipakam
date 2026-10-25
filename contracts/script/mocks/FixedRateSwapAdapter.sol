// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../../src/interfaces/ISwapAdapter.sol";

/**
 * @title FixedRateSwapAdapter
 * @notice Deterministic {ISwapAdapter} for the positive-flow rehearsals: it
 *         sells at one fixed rate per token pair, so a script can state in
 *         advance exactly what a swap returns and check every party's share
 *         of it. The rate is a fraction (`num / den`) in raw token units, so
 *         it handles pairs with different decimals (1e18 WETH at $2,000 to
 *         6-decimal USDC is `2000e6 / 1e18`).
 *
 *         It pays out of its own balance of the output token, which the
 *         script funds, and refuses to pay below the caller's
 *         `minOutputAmount`, as a real venue would. Only the owner sets
 *         rates, and only `caller` (the Diamond) may execute, so a funded
 *         adapter is not a public pot.
 */
contract FixedRateSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    struct Rate {
        uint256 num;
        uint256 den;
    }

    address public immutable owner;
    address public immutable caller;
    mapping(address => mapping(address => Rate)) public rates;

    constructor(address _owner, address _caller) {
        owner = _owner;
        caller = _caller;
    }

    /// @notice Sets the pair's rate: `inputAmount` of `inputToken` buys
    ///         `inputAmount * num / den` of `outputToken`.
    function setRate(address inputToken, address outputToken, uint256 num, uint256 den) external {
        require(msg.sender == owner, "FixedRateSwapAdapter: not owner");
        require(den != 0, "FixedRateSwapAdapter: zero denominator");
        rates[inputToken][outputToken] = Rate(num, den);
    }

    /// @notice What `execute` would pay for `inputAmount`.
    function quote(address inputToken, address outputToken, uint256 inputAmount) public view returns (uint256) {
        Rate memory r = rates[inputToken][outputToken];
        require(r.den != 0, "FixedRateSwapAdapter: no rate for pair");
        return (inputAmount * r.num) / r.den;
    }

    function adapterName() external pure override returns (string memory) {
        return "FixedRateSwapAdapter";
    }

    function execute(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        bytes calldata /* adapterData */
    ) external override returns (uint256 outputAmount) {
        require(msg.sender == caller, "FixedRateSwapAdapter: caller not allowed");
        outputAmount = quote(inputToken, outputToken, inputAmount);
        require(outputAmount >= minOutputAmount, "FixedRateSwapAdapter: below minimum output");
        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), inputAmount);
        IERC20(outputToken).safeTransfer(recipient, outputAmount);
    }
}
