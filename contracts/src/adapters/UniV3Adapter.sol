// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/**
 * @notice Minimal subset of Uniswap V3's `SwapRouter` used by this
 *         adapter. Only `exactInputSingle` is needed — the failover
 *         chain hits single-hop routes per (input, output) pair; any
 *         multi-hop routing is delegated to the aggregator adapters.
 */
interface IUniswapV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
}

/**
 * @title UniV3Adapter — on-chain Uniswap V3 single-hop swap.
 *
 * Deployed per-chain with the canonical UniswapV3 SwapRouter address.
 * Accepts `adapterData = abi.encode(uint24 poolFee)` selecting the
 * fee tier (typically 500 / 3000 / 10000) for the (inputToken,
 * outputToken) pair. Reverts if `adapterData` is empty — a keeper
 * submission without a pool choice can't be safely routed.
 *
 * No off-chain quote is required; the min-output guard is enforced
 * atomically by `SwapRouter.exactInputSingle`. This adapter therefore
 * works for permissionless-caller retries (ClaimFacet) where the
 * lender may not have a fresh aggregator quote — it's the on-chain
 * floor before we give up and hit `FallbackPending`.
 */
contract UniV3Adapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    IUniswapV3SwapRouter public immutable router;

    error AdapterDataRequired();
    error InvalidPoolFee();

    constructor(address swapRouter) {
        require(swapRouter != address(0), "router=0");
        router = IUniswapV3SwapRouter(swapRouter);
    }

    /// @inheritdoc ISwapAdapter
    function adapterName() external pure override returns (string memory) {
        return "UniswapV3";
    }

    /// @inheritdoc ISwapAdapter
    function execute(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        bytes calldata adapterData
    ) external override returns (uint256 outputAmount) {
        if (adapterData.length == 0) revert AdapterDataRequired();
        uint24 poolFee = abi.decode(adapterData, (uint24));
        if (poolFee == 0) revert InvalidPoolFee();

        IERC20 input = IERC20(inputToken);
        input.safeTransferFrom(msg.sender, address(this), inputAmount);
        input.forceApprove(address(router), 0);
        input.forceApprove(address(router), inputAmount);

        outputAmount = router.exactInputSingle(
            IUniswapV3SwapRouter.ExactInputSingleParams({
                tokenIn: inputToken,
                tokenOut: outputToken,
                fee: poolFee,
                recipient: recipient,
                deadline: block.timestamp,
                amountIn: inputAmount,
                amountOutMinimum: minOutputAmount,
                sqrtPriceLimitX96: 0
            })
        );

        input.forceApprove(address(router), 0);
        // Router guarantees amountOut >= amountOutMinimum; no extra
        // check needed here. Any residual input (zero on success,
        // full amount if revert bubbled — but revert shortcuts) is
        // returned to the caller.
        uint256 residualInput = input.balanceOf(address(this));
        if (residualInput != 0) {
            input.safeTransfer(msg.sender, residualInput);
        }
        return outputAmount;
    }
}
