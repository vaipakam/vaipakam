// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/**
 * @notice Minimal subset of the Balancer V2 Vault interface used by
 *         this adapter. Balancer's Vault is at the same canonical
 *         address on every EVM deployment
 *         (`0xBA12222222228d8Ba445958a75a0704d566BF2C8`).
 */
interface IBalancerV2Vault {
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

    function swap(
        SingleSwap memory singleSwap,
        FundManagement memory funds,
        uint256 limit,
        uint256 deadline
    ) external payable returns (uint256 amountCalculated);
}

/**
 * @title BalancerV2Adapter — on-chain Balancer V2 pool swap.
 *
 * Deployed per-chain with the canonical Vault address. Accepts
 * `adapterData = abi.encode(bytes32 poolId)` selecting the pool to
 * route through. Reverts if `adapterData` is empty.
 *
 * Complements {UniV3Adapter}: Balancer's stable pools typically
 * quote better on pegged pairs (stETH/ETH, USDC/USDT etc.) where
 * UniV3 concentrated liquidity isn't tuned, and the weighted pools
 * cover the same blue-chip ground. Together they form the on-chain
 * fallback floor before `FallbackPending`.
 */
contract BalancerV2Adapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    IBalancerV2Vault public immutable vault;

    error AdapterDataRequired();
    error InvalidPoolId();

    constructor(address balancerVault) {
        require(balancerVault != address(0), "vault=0");
        vault = IBalancerV2Vault(balancerVault);
    }

    /// @inheritdoc ISwapAdapter
    function adapterName() external pure override returns (string memory) {
        return "BalancerV2";
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
        bytes32 poolId = abi.decode(adapterData, (bytes32));
        if (poolId == bytes32(0)) revert InvalidPoolId();

        IERC20 input = IERC20(inputToken);
        input.safeTransferFrom(msg.sender, address(this), inputAmount);
        input.forceApprove(address(vault), 0);
        input.forceApprove(address(vault), inputAmount);

        // Vault.swap enforces `amountCalculated >= limit` for
        // GIVEN_IN (the limit is the minimum acceptable output),
        // reverting with `BAL#507` on slippage — same semantic as
        // UniV3's `amountOutMinimum`. Deadline is the current block
        // so the tx cannot sit in the mempool.
        outputAmount = vault.swap(
            IBalancerV2Vault.SingleSwap({
                poolId: poolId,
                kind: IBalancerV2Vault.SwapKind.GIVEN_IN,
                assetIn: inputToken,
                assetOut: outputToken,
                amount: inputAmount,
                userData: bytes("")
            }),
            IBalancerV2Vault.FundManagement({
                sender: address(this),
                fromInternalBalance: false,
                recipient: payable(recipient),
                toInternalBalance: false
            }),
            minOutputAmount,
            block.timestamp
        );

        input.forceApprove(address(vault), 0);
        uint256 residualInput = input.balanceOf(address(this));
        if (residualInput != 0) {
            input.safeTransfer(msg.sender, residualInput);
        }
        return outputAmount;
    }
}
