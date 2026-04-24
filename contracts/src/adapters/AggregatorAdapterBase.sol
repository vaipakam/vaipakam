// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/**
 * @title AggregatorAdapterBase — off-chain-quote DEX adapter.
 *
 * Pattern shared by {ZeroExAggregatorAdapter} and
 * {OneInchAggregatorAdapter}. The canonical 0x Settler integration
 * and the 1inch AggregationRouter both expose opaque calldata that a
 * keeper fetches from the aggregator's quote API off-chain and
 * submits as `adapterData`. The on-chain safety model:
 *
 *   1. **Target is pinned** by constructor — keeper supplies the
 *      calldata bytes, NOT the destination. Caller cannot be tricked
 *      into calling the diamond, a token contract, or any non-router
 *      address.
 *
 *   2. **minOutputAmount is caller-supplied** (oracle-derived by the
 *      liquidation facet) and enforced on this side via a balance
 *      delta check around the external call — not from whatever the
 *      aggregator's calldata encodes. A malicious / lazy keeper that
 *      picks a suboptimal route still can't push proceeds below the
 *      floor.
 *
 *   3. **Approval is exact-scope** — set to `inputAmount` immediately
 *      before the router call, cleared to 0 immediately after (on
 *      both success and revert). No persistent allowance, no excess
 *      allowance beyond this single swap.
 *
 *   4. **Residual input returned** — if the router didn't consume the
 *      full `inputAmount` (partial fill or revert), any remaining
 *      `inputToken` balance sitting on this contract is transferred
 *      back to `msg.sender` before the function returns. The failover
 *      loop in `LibSwap` retries the next adapter with the restored
 *      balance.
 *
 * Subclasses supply only the adapter name (`adapterName()`); all
 * execute-time logic lives here.
 */
abstract contract AggregatorAdapterBase is ISwapAdapter {
    using SafeERC20 for IERC20;

    /// @notice The pinned router address this adapter forwards to.
    ///         Keeper-supplied calldata is delivered to THIS address
    ///         via `address(target).call(adapterData)`. Set once at
    ///         construction; immutable.
    address public immutable target;

    error AdapterDataRequired();
    error RouterCallFailed(bytes returnData);
    error InsufficientOutput(uint256 received, uint256 minExpected);

    constructor(address targetRouter) {
        require(targetRouter != address(0), "target=0");
        target = targetRouter;
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

        IERC20 input = IERC20(inputToken);
        IERC20 output = IERC20(outputToken);

        // Pull input from caller (the facet), exact-scope approval
        // to the pinned router, invoke, enforce min-out via balance
        // delta, return residuals.
        input.safeTransferFrom(msg.sender, address(this), inputAmount);
        input.forceApprove(target, 0);
        input.forceApprove(target, inputAmount);

        uint256 outputBalanceBefore = output.balanceOf(address(this));
        (bool ok, bytes memory returnData) = target.call(adapterData);
        // Clear approval regardless of outcome so the router can't
        // draw on us after the call (defence-in-depth against a
        // router that queues follow-up pulls).
        input.forceApprove(target, 0);

        if (!ok) {
            _returnResiduals(input, output, outputBalanceBefore);
            revert RouterCallFailed(returnData);
        }

        uint256 outputBalanceAfter = output.balanceOf(address(this));
        uint256 received = outputBalanceAfter - outputBalanceBefore;
        if (received < minOutputAmount) {
            _returnResiduals(input, output, outputBalanceBefore);
            revert InsufficientOutput(received, minOutputAmount);
        }

        // Forward proceeds to the intended recipient and return any
        // unspent input back to the caller. Post-call token amounts
        // are read from live balances — the router may have consumed
        // less than `inputAmount` (partial fill).
        output.safeTransfer(recipient, received);
        uint256 residualInput = input.balanceOf(address(this));
        if (residualInput != 0) {
            input.safeTransfer(msg.sender, residualInput);
        }
        return received;
    }

    /// @dev On revert / insufficient-output, shove whatever tokens
    ///      remain on the adapter back to the caller so the failover
    ///      loop has the balance to retry.
    function _returnResiduals(
        IERC20 input,
        IERC20 output,
        uint256 outputBalanceBefore
    ) private {
        uint256 residualInput = input.balanceOf(address(this));
        if (residualInput != 0) {
            input.safeTransfer(msg.sender, residualInput);
        }
        // Return any residual output picked up pre-revert (partial
        // fill that didn't clear the min-out threshold). The caller
        // can resweep on the next adapter's proceeds.
        uint256 postOutput = output.balanceOf(address(this));
        if (postOutput > outputBalanceBefore) {
            output.safeTransfer(msg.sender, postOutput - outputBalanceBefore);
        }
    }
}
