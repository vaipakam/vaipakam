// test/mocks/ZeroExProxyMock.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {console} from "forge-std/console.sol";

/**
 * @title ZeroExProxyMock
 * @author Vaipakam Developer Team
 * @notice Mock contract for 0x Exchange Proxy to simulate swaps in tests.
 * @dev Used in Foundry tests to mock the swap behavior without real 0x calls.
 *      Simulates a swap by transferring input token and sending output token.
 *      Configurable rate via setRate (for different test scenarios).
 *      Assumes approval from caller for inputToken.
 *      Mints or transfers output if pre-minted to this mock.
 *      Custom errors for failures.
 */
contract ZeroExProxyMock {
    using SafeERC20 for IERC20;

    // Custom errors
    error InsufficientOutputBalance();
    error InvalidRate();
    error SlippageExceeded();

    // Mock exchange rate: outputAmount = inputAmount * rateNumerator / rateDenominator
    uint256 public rateNumerator = 1;
    uint256 public rateDenominator = 1;

    /**
     * @notice Sets the mock exchange rate for swaps.
     * @dev Used in tests to simulate different rates (e.g., 1.1 for profit).
     * @param numerator Rate numerator.
     * @param denominator Rate denominator (non-zero).
     */
    function setRate(uint256 numerator, uint256 denominator) external {
        if (denominator == 0) revert InvalidRate();
        rateNumerator = numerator;
        rateDenominator = denominator;
    }

    /**
     * @notice Simulates a 0x swap call.
     * @dev Matches the expected calldata in swapData (e.g., abi.encodeWithSelector(this.swap.selector, ...)).
     *      Transfers inputToken from msg.sender, calculates outputAmount, transfers outputToken to recipient.
     *      Assumes outputToken has balance in this contract (pre-mint in tests).
     *      Returns the output amount (as per 0x swap response, if needed).
     * @param inputToken The input token address.
     * @param outputToken The output token address.
     * @param inputAmount The input amount.
     * @param recipient The recipient for output.
     * @return outputAmount The simulated output amount.
     */
    function swap(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient
    ) external returns (uint256 outputAmount) {
        // Calculate output first so we can enforce minOutputAmount BEFORE
        // pulling any input — the conversion must literally not happen above
        // the slippage threshold (README §3, §7).
        outputAmount = (inputAmount * rateNumerator) / rateDenominator;

        if (outputAmount < minOutputAmount) {
            revert SlippageExceeded();
        }

        // Check output balance
        if (IERC20(outputToken).balanceOf(address(this)) < outputAmount) {
            revert InsufficientOutputBalance();
        }

        // Transfer input from caller, then output to recipient
        IERC20(inputToken).safeTransferFrom(
            msg.sender,
            address(this),
            inputAmount
        );
        IERC20(outputToken).safeTransfer(recipient, outputAmount);
        console.log("outputAmount: ", outputAmount);

        return outputAmount;
    }
}
