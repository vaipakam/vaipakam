// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibSwap — Phase 7a liquidation-swap failover driver.
 *
 * Iterates `s.swapAdapters` in priority order. Each adapter runs in
 * its own `try / catch`: a revert for any reason (slippage, venue
 * outage, malformed `adapterData`, pause, liquidity exhaustion)
 * triggers a move to the next adapter. First success commits and
 * returns the realized proceeds; total failure returns
 * `(success=false, 0, type(uint256).max)` and the caller MUST route
 * the loan into the claim-time full-collateral fallback
 * (`FallbackPending`) — preserving the pre-Phase-7a semantics for
 * the "no DEX could fill" case.
 *
 * Security posture (mirrors the old inline `call(zeroExProxy)` path):
 *
 *  - Approvals are set to exactly `inputAmount` per-adapter, reset to
 *    0 before the attempt and after every outcome. No persistent /
 *    cross-adapter allowance leaks.
 *
 *  - `minOutputAmount` is oracle-derived by the liquidation facet
 *    and passed down unchanged. The adapter enforces it on the DEX
 *    side; the library does NOT re-check (adapters are trusted to
 *    revert on under-fill).
 *
 *  - `perAdapterData` is keeper-supplied at the liquidation trigger.
 *    It's forwarded as bytes to the adapter and is only meaningful
 *    under the adapter's own validation (fixed target + signature
 *    shape). A missing entry (array shorter than the adapter count)
 *    defaults to empty bytes, which on-chain adapters (UniV3 /
 *    Balancer) accept but aggregator adapters (0x / 1inch) reject.
 *
 *  - Emits `SwapAdapterAttempted` on every try and
 *    `SwapAdapterSucceeded` on commit so off-chain monitors can
 *    track failover rates per adapter. `SwapAllAdaptersFailed`
 *    signals the lender-claim fallback path.
 */
library LibSwap {
    using SafeERC20 for IERC20;

    event SwapAdapterAttempted(
        uint256 indexed loanId,
        uint256 indexed adapterIdx,
        address adapter,
        bool success
    );
    event SwapAdapterSucceeded(
        uint256 indexed loanId,
        uint256 indexed adapterIdx,
        address adapter,
        uint256 outputAmount
    );
    event SwapAllAdaptersFailed(uint256 indexed loanId);

    error NoSwapAdaptersConfigured();

    /// @notice Drive a priority-ordered failover across the registered
    ///         swap adapters.
    /// @param loanId         Loan id being liquidated (event indexing).
    /// @param inputToken     Token the caller holds and is selling.
    /// @param outputToken    Token requested in return.
    /// @param inputAmount    Exact input amount offered to each adapter.
    /// @param minOutputAmount Oracle-derived slippage floor.
    /// @param recipient      Destination for realized `outputToken`.
    /// @param perAdapterData Outer array indexed by adapter slot. Entries
    ///                       longer than the adapter array are ignored;
    ///                       missing entries default to empty bytes.
    /// @return success       True iff an adapter returned proceeds.
    /// @return outputAmount  Realized proceeds on success, 0 otherwise.
    /// @return adapterUsed   Index of the adapter that committed, or
    ///                       `type(uint256).max` on total failure.
    function swapWithFailover(
        uint256 loanId,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        bytes[] memory perAdapterData
    )
        internal
        returns (bool success, uint256 outputAmount, uint256 adapterUsed)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 n = s.swapAdapters.length;
        if (n == 0) revert NoSwapAdaptersConfigured();

        IERC20 input = IERC20(inputToken);
        for (uint256 i = 0; i < n; ++i) {
            address adapter = s.swapAdapters[i];
            bytes memory data = i < perAdapterData.length
                ? perAdapterData[i]
                : bytes("");

            // Exact-scope approval — zero first (handles USDT-style
            // non-zero-approve guards), then set to inputAmount for
            // this one attempt. forceApprove matches the pattern the
            // legacy path used via SafeERC20.
            input.forceApprove(adapter, 0);
            input.forceApprove(adapter, inputAmount);

            try
                ISwapAdapter(adapter).execute(
                    inputToken,
                    outputToken,
                    inputAmount,
                    minOutputAmount,
                    recipient,
                    data
                )
            returns (uint256 out_) {
                input.forceApprove(adapter, 0);
                emit SwapAdapterAttempted(loanId, i, adapter, true);
                emit SwapAdapterSucceeded(loanId, i, adapter, out_);
                return (true, out_, i);
            } catch {
                input.forceApprove(adapter, 0);
                emit SwapAdapterAttempted(loanId, i, adapter, false);
                // fall through to next adapter
            }
        }

        emit SwapAllAdaptersFailed(loanId);
        return (false, 0, type(uint256).max);
    }
}
