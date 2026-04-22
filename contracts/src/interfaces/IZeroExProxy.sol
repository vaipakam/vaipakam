// interfaces/IZeroExProxy.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;


/**
 * @title IZeroExProxy
 * @author Vaipakam Developer Team
 * @notice Mock contract for 0x Exchange Proxy to simulate swaps in tests.
 * @dev Used in Foundry tests to mock the swap behavior without real 0x calls.
 *      Simulates a swap by transferring input token and sending output token.
 *      Configurable rate via setRate (for different test scenarios).
 *      Assumes approval from caller for inputToken.
 *      Mints or transfers output if pre-minted to this mock.
 *      Custom errors for failures.
 */
interface IZeroExProxy {
    // using SafeERC20 for IERC20;

    // Custom errors
    error InsufficientOutputBalance();
    error InvalidRate();
    /// @notice Raised when the realised swap output is below the caller's
    ///         minOutputAmount — used by the facets' 6% slippage guard so the
    ///         conversion literally does not execute above the threshold.
    error SlippageExceeded();

    // Mock exchange rate: outputAmount = inputAmount * rateNumerator / rateDenominator
    // uint256 public rateNumerator = 1;
    // uint256 public rateDenominator = 1;

    /**
     * @notice Sets the mock exchange rate for swaps.
     * @dev Used in tests to simulate different rates (e.g., 1.1 for profit).
     * @param numerator Rate numerator.
     * @param denominator Rate denominator (non-zero).
     */
    function setRate(uint256 numerator, uint256 denominator) external;

    // {
    //     if (denominator == 0) revert InvalidRate();
    //     rateNumerator = numerator;
    //     rateDenominator = denominator;
    // }

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
    ) external returns (uint256 outputAmount);
    //  {
    //     // Transfer input from caller
    //     IERC20(inputToken).safeTransferFrom(
    //         msg.sender,
    //         address(this),
    //         inputAmount
    //     );

    //     // Calculate output
    //     outputAmount = (inputAmount * rateNumerator) / rateDenominator;

    //     // Check output balance
    //     if (IERC20(outputToken).balanceOf(address(this)) < outputAmount) {
    //         revert InsufficientOutputBalance();
    //     }

    //     // Transfer output to recipient
    //     IERC20(outputToken).safeTransfer(recipient, outputAmount);
    //     console.log("outputAmount: ", outputAmount);

    //     return outputAmount;
    // }
}
