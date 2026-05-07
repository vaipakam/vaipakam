// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/**
 * @title AggregatorAdapterBase — off-chain-quote DEX adapter.
 *
 * Pattern shared by {ZeroExAggregatorAdapter} and
 * {OneInchAggregatorAdapter}. The on-chain safety model splits the
 * approve recipient from the call destination because 0x v2 (Settler /
 * AllowanceHolder) explicitly REQUIRES it: per
 * https://0x.org/docs/developer-resources/core-concepts/contracts the
 * AllowanceHolder is canonical and pinnable per chain
 * (`0x0000…2734` on every Cancun fork) while the Settler that actually
 * executes the swap rotates per deploy. 0x docs are explicit:
 *
 *     "you should NEVER set an allowance on the Settler contract, as
 *      doing so may result in unintended consequences, including
 *      potential loss of tokens or exposure to security risks."
 *
 * 1inch v6 happens to use a single AggregationRouterV6 for both roles
 * today, but using the same split shape future-proofs us if 1inch ever
 * follows 0x's lead.
 *
 * Trust model:
 *
 *   1. **Allowance target is pinned** by constructor and immutable.
 *      Keeper-supplied bytes can NEVER redirect approvals. For 0x:
 *      AllowanceHolder. For 1inch: AggregationRouterV6.
 *
 *   2. **Swap target is allowlist-gated.** Constructor seeds the
 *      initial set; owner adds/removes via {addSwapTarget} /
 *      {removeSwapTarget} as the upstream venue rotates Settler
 *      addresses. Keeper passes the call target inside `adapterData`,
 *      adapter rejects anything not in the allowlist before calling.
 *
 *   3. **minOutputAmount is caller-supplied** (oracle-derived by the
 *      liquidation facet) and enforced via a balance delta check
 *      around the external call — not from whatever the aggregator's
 *      calldata encodes. A malicious / lazy keeper that picks a
 *      suboptimal route still cannot push proceeds below the floor.
 *
 *   4. **Approval is exact-scope** — set to `inputAmount` immediately
 *      before the router call, cleared to 0 immediately after (on
 *      both success and revert). No persistent allowance, no excess
 *      allowance beyond this single swap.
 *
 *   5. **Residual input returned** — if the router didn't consume the
 *      full `inputAmount` (partial fill or revert), any remaining
 *      `inputToken` balance sitting on this contract is transferred
 *      back to `msg.sender` before the function returns. The failover
 *      loop in `LibSwap` retries the next adapter with the restored
 *      balance.
 *
 * `adapterData` layout:
 *
 *     abi.encode(address swapTarget, bytes swapCalldata)
 *
 * `swapTarget` is the response field's `transaction.to` (0x v2) or
 * `tx.to` (1inch v6). `swapCalldata` is the corresponding `data` blob.
 *
 * Subclasses supply only the adapter name (`adapterName()`); all
 * execute-time logic lives here.
 */
abstract contract AggregatorAdapterBase is ISwapAdapter, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Pinned ERC20-allowance recipient. Set once at
    ///         construction; immutable. Approval is granted
    ///         immediately before each swap and revoked immediately
    ///         after. NEVER sourced from caller-supplied bytes.
    address public immutable allowanceTarget;

    /// @notice Allowlist of permitted swap-call destinations. The
    ///         keeper passes one of these as the first field of
    ///         `adapterData`; the call reverts if it's not in the
    ///         set. Owner-managed via {addSwapTarget} /
    ///         {removeSwapTarget} so the operator can rotate Settler
    ///         addresses (0x) without a redeploy.
    mapping(address => bool) public swapTargetAllowed;

    /// @notice Total number of currently-allowlisted swap targets.
    ///         Maintained alongside the mapping so {removeSwapTarget}
    ///         can refuse to drain the set to zero — a swap call with
    ///         zero allowlisted targets is unrecoverable without an
    ///         owner action.
    uint256 public swapTargetCount;

    event SwapTargetAllowed(address indexed target);
    event SwapTargetDisallowed(address indexed target);

    error AdapterDataRequired();
    error InvalidAllowanceTarget();
    error InvalidInitialSwapTargets();
    error InvalidSwapTarget();
    error SwapTargetAlreadyAllowed(address target);
    error SwapTargetNotAllowed(address target);
    error LastSwapTargetCannotBeRemoved();
    error RouterCallFailed(bytes returnData);
    error InsufficientOutput(uint256 received, uint256 minExpected);

    /// @param allowanceTarget_   Pinned approval recipient. For 0x:
    ///                           the AllowanceHolder address. For
    ///                           1inch: the AggregationRouterV6
    ///                           address.
    /// @param initialSwapTargets Seed allowlist of legal call
    ///                           destinations. MUST be non-empty —
    ///                           the adapter is unusable without at
    ///                           least one allowlisted target.
    constructor(
        address allowanceTarget_,
        address[] memory initialSwapTargets
    ) Ownable(msg.sender) {
        if (allowanceTarget_ == address(0)) revert InvalidAllowanceTarget();
        if (initialSwapTargets.length == 0) revert InvalidInitialSwapTargets();
        allowanceTarget = allowanceTarget_;
        for (uint256 i = 0; i < initialSwapTargets.length; ++i) {
            address t = initialSwapTargets[i];
            if (t == address(0)) revert InvalidInitialSwapTargets();
            if (swapTargetAllowed[t]) revert SwapTargetAlreadyAllowed(t);
            swapTargetAllowed[t] = true;
            emit SwapTargetAllowed(t);
        }
        swapTargetCount = initialSwapTargets.length;
    }

    /// @notice Adds a swap-call destination to the allowlist. Used to
    ///         track Settler rotations on 0x as new deployments ship.
    function addSwapTarget(address target) external onlyOwner {
        if (target == address(0)) revert InvalidSwapTarget();
        if (swapTargetAllowed[target]) revert SwapTargetAlreadyAllowed(target);
        swapTargetAllowed[target] = true;
        unchecked {
            swapTargetCount += 1;
        }
        emit SwapTargetAllowed(target);
    }

    /// @notice Removes a swap-call destination from the allowlist.
    /// @dev Refuses to remove the last entry — a zero-target adapter
    ///      cannot service swaps and would have to be re-seeded by the
    ///      owner anyway. Forces the operator to {addSwapTarget}
    ///      first if they're rotating to a fresh Settler.
    function removeSwapTarget(address target) external onlyOwner {
        if (!swapTargetAllowed[target]) revert SwapTargetNotAllowed(target);
        if (swapTargetCount == 1) revert LastSwapTargetCannotBeRemoved();
        delete swapTargetAllowed[target];
        unchecked {
            swapTargetCount -= 1;
        }
        emit SwapTargetDisallowed(target);
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
        (address swapTarget, bytes memory swapCalldata) =
            abi.decode(adapterData, (address, bytes));
        if (!swapTargetAllowed[swapTarget]) revert SwapTargetNotAllowed(swapTarget);
        if (swapCalldata.length == 0) revert AdapterDataRequired();

        IERC20 input = IERC20(inputToken);
        IERC20 output = IERC20(outputToken);

        // Pull input from caller (the facet), exact-scope approval to
        // the pinned ALLOWANCE TARGET (NOT the call target — see 0x
        // contract docs warning), invoke the swap target, enforce
        // min-out via balance delta, return residuals.
        input.safeTransferFrom(msg.sender, address(this), inputAmount);
        input.forceApprove(allowanceTarget, 0);
        input.forceApprove(allowanceTarget, inputAmount);

        uint256 outputBalanceBefore = output.balanceOf(address(this));
        (bool ok, bytes memory returnData) = swapTarget.call(swapCalldata);
        // Clear approval regardless of outcome so the AllowanceHolder
        // can't draw on us after the call (defence-in-depth).
        input.forceApprove(allowanceTarget, 0);

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
