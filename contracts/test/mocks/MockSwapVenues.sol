// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Mock aggregator router for ZeroEx / OneInch adapter tests.
 *
 * Accepts calldata of the shape
 *   abi.encode(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, address recipient)
 * plus a selector prefix (so the call layout matches a real aggregator).
 * On invocation it pulls `amountIn` of `tokenIn` from `msg.sender` (the
 * adapter) via transferFrom, then transfers `amountOut` of `tokenOut`
 * to `recipient` from its own balance. The mock must be pre-funded
 * with `tokenOut`.
 *
 * Two knobs for failure testing:
 *   - `setRevert(true)` makes the next call revert.
 *   - `setOutputMultiplier(bps)` scales `amountOut` (10000 = 1x).
 *     Set < 10000 to emulate an aggregator returning less than the
 *     caller's min-out (triggers the delta-check revert in the adapter).
 */
contract MockAggregatorRouter {
    using SafeERC20 for IERC20;

    bool public revertNext;
    uint256 public outputMultiplierBps = 10_000; // 1x default

    function setRevert(bool v) external {
        revertNext = v;
    }

    function setOutputMultiplier(uint256 bps) external {
        outputMultiplierBps = bps;
    }

    /// @notice Wildcard entrypoint — anything-goes calldata is decoded
    ///         as (tokenIn, tokenOut, amountIn, amountOut, recipient).
    fallback() external payable {
        if (revertNext) {
            revertNext = false;
            revert("MockAggregatorRouter: forced revert");
        }
        (
            address tokenIn,
            address tokenOut,
            uint256 amountIn,
            uint256 amountOut,
            address recipient
        ) = abi.decode(msg.data, (address, address, uint256, uint256, address));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 scaled = (amountOut * outputMultiplierBps) / 10_000;
        IERC20(tokenOut).safeTransfer(recipient, scaled);
    }

    receive() external payable {}
}

/**
 * @title Mock Uniswap V3 SwapRouter for UniV3Adapter tests.
 *
 * Mirrors the `exactInputSingle` signature the adapter calls and
 * returns a configurable output (scaled by `rateBps`, default 10000
 * for 1:1). Enforces `amountOutMinimum` so under-quote reverts match
 * real UniV3 behaviour.
 */
contract MockUniV3SwapRouter {
    using SafeERC20 for IERC20;

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

    uint256 public rateBps = 10_000; // 1x
    bool public revertNext;

    function setRate(uint256 bps) external {
        rateBps = bps;
    }

    function setRevert(bool v) external {
        revertNext = v;
    }

    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut) {
        if (revertNext) {
            revertNext = false;
            revert("MockUniV3SwapRouter: forced revert");
        }
        IERC20(params.tokenIn).safeTransferFrom(
            msg.sender,
            address(this),
            params.amountIn
        );
        amountOut = (params.amountIn * rateBps) / 10_000;
        require(
            amountOut >= params.amountOutMinimum,
            "Too little received"
        );
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }
}

/**
 * @title Mock Balancer V2 Vault for BalancerV2Adapter tests.
 *
 * Mirrors the `swap(SingleSwap, FundManagement, limit, deadline)`
 * signature. Pulls `amount` of `assetIn` from `funds.sender`, pays
 * `amount * rateBps / 10000` of `assetOut` to `funds.recipient`.
 * Enforces `amountCalculated >= limit` for GIVEN_IN.
 */
contract MockBalancerV2Vault {
    using SafeERC20 for IERC20;

    enum SwapKind { GIVEN_IN, GIVEN_OUT }

    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address assetIn;
        address assetOut;
        uint256 amount;
        bytes userData;
    }

    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address payable recipient;
        bool toInternalBalance;
    }

    uint256 public rateBps = 10_000;
    bool public revertNext;

    function setRate(uint256 bps) external {
        rateBps = bps;
    }

    function setRevert(bool v) external {
        revertNext = v;
    }

    function swap(
        SingleSwap memory singleSwap,
        FundManagement memory funds,
        uint256 limit,
        uint256 /* deadline */
    ) external payable returns (uint256 amountCalculated) {
        if (revertNext) {
            revertNext = false;
            revert("MockBalancerV2Vault: forced revert");
        }
        IERC20(singleSwap.assetIn).safeTransferFrom(
            funds.sender,
            address(this),
            singleSwap.amount
        );
        amountCalculated = (singleSwap.amount * rateBps) / 10_000;
        require(amountCalculated >= limit, "BAL#507");
        IERC20(singleSwap.assetOut).safeTransfer(
            funds.recipient,
            amountCalculated
        );
    }
}
