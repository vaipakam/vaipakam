// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibSwap} from "../libraries/LibSwap.sol";

/**
 * @title ISwapAttemptHost
 * @notice The Diamond-internal entry that runs ONE swap-adapter attempt in a
 *         call frame of its own (#2472). {LibSwap.attempt} reaches it through
 *         the Diamond's own fallback inside a `try`, so an attempt that breaks
 *         the delivery rule (a partial fill on an exact sale, proceeds that
 *         did not arrive) reverts THIS frame, which unwinds the adapter's sale
 *         with it, and the failover moves on to the next route. Hosted by
 *         {SwapAttemptFacet}; callable only by the Diamond itself.
 */
interface ISwapAttemptHost {
    /// @notice Run one attempt at `sale` through the adapter registered at
    ///         `adapterIdx`, holding it to the delivery rule.
    /// @param sale       The sale's fixed terms, including its spend rule.
    /// @param adapterIdx Storage index of the adapter to try.
    /// @param data       The caller's per-route payload for that adapter.
    /// @return outputAmount Proceeds the adapter reported; at least this much
    ///                      reached `sale.recipient`.
    /// @return inputSpent   Input the attempt spent, measured on the Diamond.
    function swapAttempt(
        LibSwap.Sale calldata sale,
        uint256 adapterIdx,
        bytes calldata data
    ) external returns (uint256 outputAmount, uint256 inputSpent);
}
