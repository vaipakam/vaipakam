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

    /// @notice One entry in the caller-supplied ordered try-list. The
    ///         frontend / HF watcher / keeper ranks available quotes by
    ///         expected output (best first) and submits the ordered
    ///         list; the library iterates in that order and commits on
    ///         the first success. The adapter *address* resolves
    ///         through governance storage (`s.swapAdapters[adapterIdx]`)
    ///         so a malicious caller cannot spoof the destination — only
    ///         the order and the per-call data are caller-controlled.
    /// @dev Duplicate `adapterIdx` entries are permitted so the caller
    ///      can submit two different routes against the same venue
    ///      (e.g. UniV3 at fee=500 as first try, UniV3 at fee=3000 as
    ///      second try when the best-priced pool is thinner).
    struct AdapterCall {
        uint256 adapterIdx;
        bytes data;
    }

    /// @notice Per-adapter attempt log entry from the swap-failover loop.
    /// @dev    Forensic surface — names which registered adapter was tried
    ///         at which rank and whether it reverted. Storage transition
    ///         is captured by the calling facet's state-change event.
    /// @custom:event-category informational/liquidation
    event SwapAdapterAttempted(
        uint256 indexed loanId,
        uint256 indexed adapterIdx,
        address adapter,
        bool success
    );

    /// @notice The first adapter in the failover order to succeed.
    /// @dev    Companion to {SwapAdapterAttempted}. Calling facet's
    ///         state-change event captures the resulting loan transition.
    /// @custom:event-category informational/liquidation
    event SwapAdapterSucceeded(
        uint256 indexed loanId,
        uint256 indexed adapterIdx,
        address adapter,
        uint256 outputAmount
    );

    /// @notice Every registered adapter reverted or under-delivered.
    /// @dev    Caller falls back to the full-collateral-transfer path,
    ///         which emits its own state-change event.
    /// @custom:event-category informational/liquidation
    event SwapAllAdaptersFailed(uint256 indexed loanId);

    error NoSwapAdaptersConfigured();
    error AdapterIndexOutOfRange(uint256 adapterIdx, uint256 registeredCount);
    /// @notice #633 — a governance-paused swap venue was supplied to an atomic
    ///         split route (no-arg to minimise inlined bytecode in RiskFacet).
    error SwapVenuePaused();
    error SplitSumMismatch(uint256 sum, uint256 inputAmount);
    error SplitMinOutputUnderfilled(uint256 totalOutput, uint256 minOutputAmount);
    error EmptySplitList();

    /// @notice One entry in a sum-to-input multi-route split swap. Each
    ///         split routes `splitAmount` of the total input to
    ///         `adapterIdx` with the encoded `data`. The sum of every
    ///         `splitAmount` across the array MUST equal the caller's
    ///         `inputAmount`. Designed for the higher-LTV regime
    ///         (depth-tiered LTV, §4.4 step 5) where a single adapter
    ///         can't absorb the full liquidation size at acceptable
    ///         slippage but two splitting the volume can — split + sum-
    ///         of-outputs beats failover-then-fallback. Address resolution
    ///         is governance-controlled (`s.swapAdapters[adapterIdx]`),
    ///         same as {AdapterCall}.
    struct SplitCall {
        uint256 adapterIdx;
        uint256 splitAmount;
        bytes data;
    }

    /// @notice Drive a caller-ordered failover across the registered
    ///         swap adapters. The `calls` list is the already-ranked
    ///         try-list: the frontend / HF watcher fetches quotes from
    ///         every available venue, sorts by expected output (best
    ///         first), and submits in that order. The library attempts
    ///         each in turn and commits on the first success.
    /// @param loanId          Loan id being liquidated (event indexing).
    /// @param inputToken      Token the caller holds and is selling.
    /// @param outputToken     Token requested in return.
    /// @param inputAmount     Exact input amount offered to each adapter.
    /// @param minOutputAmount Oracle-derived slippage floor, enforced
    ///                        on the adapter side. Caller-supplied
    ///                        ranking does NOT alter this floor.
    /// @param recipient       Destination for realized `outputToken`.
    /// @param calls           Ordered {adapterIdx, data} list. Empty
    ///                        list = no adapters to try → total failure
    ///                        (caller routes to fallback).
    /// @return success        True iff an adapter returned proceeds.
    /// @return outputAmount   Realized proceeds on success, 0 otherwise.
    /// @return adapterUsed    Storage index of the adapter that
    ///                        committed, or `type(uint256).max` on
    ///                        total failure.
    function swapWithFailover(
        uint256 loanId,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        AdapterCall[] calldata calls
    )
        internal
        returns (bool success, uint256 outputAmount, uint256 adapterUsed)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 registeredCount = s.swapAdapters.length;
        if (registeredCount == 0) revert NoSwapAdaptersConfigured();

        uint256 n = calls.length;
        if (n == 0) {
            emit SwapAllAdaptersFailed(loanId);
            return (false, 0, type(uint256).max);
        }

        IERC20 input = IERC20(inputToken);
        for (uint256 i = 0; i < n; ++i) {
            uint256 idx = calls[i].adapterIdx;
            // Reject out-of-range indices up front — lets a keeper
            // detect a misconfigured try-list (e.g. adapter was
            // de-registered since quote-time) without eating the
            // whole failover budget.
            if (idx >= registeredCount) {
                revert AdapterIndexOutOfRange(idx, registeredCount);
            }
            address adapter = s.swapAdapters[idx];
            // #633 — skip a governance-paused venue and fail over to the next
            // entry, so a compromised/illiquid adapter doesn't abort the chain.
            if (s.swapAdapterDisabled[adapter]) continue;

            // Exact-scope approval — zero first (handles USDT-style
            // non-zero-approve guards), then set to inputAmount for
            // this one attempt.
            input.forceApprove(adapter, 0);
            input.forceApprove(adapter, inputAmount);

            try
                ISwapAdapter(adapter).execute(
                    inputToken,
                    outputToken,
                    inputAmount,
                    minOutputAmount,
                    recipient,
                    calls[i].data
                )
            returns (uint256 out_) {
                input.forceApprove(adapter, 0);
                emit SwapAdapterAttempted(loanId, idx, adapter, true);
                emit SwapAdapterSucceeded(loanId, idx, adapter, out_);
                return (true, out_, idx);
            } catch {
                input.forceApprove(adapter, 0);
                emit SwapAdapterAttempted(loanId, idx, adapter, false);
                // fall through to next entry in the try-list
            }
        }

        emit SwapAllAdaptersFailed(loanId);
        return (false, 0, type(uint256).max);
    }

    /// @notice Drive a sum-to-input multi-route split swap across two-
    ///         or-more registered adapters and accumulate the outputs.
    ///         Used by the higher-LTV-aware liquidator (`RiskFacet.triggerLiquidationSplit`)
    ///         when off-chain quote analysis shows a single adapter can't
    ///         absorb the full size at acceptable slippage but a split can.
    /// @dev    Atomic: **any single adapter revert reverts the whole call.**
    ///         Unlike {swapWithFailover}, there is no soft-failure return
    ///         path — a partial swap can't be safely unwound because
    ///         successful sub-swaps have already moved proceeds to
    ///         `recipient`. The keeper should only use this entry when
    ///         off-chain quotes show every leg will succeed; if a leg
    ///         reverts on-chain (price moved between quote and submission),
    ///         the retry path is {swapWithFailover} (`triggerLiquidation`)
    ///         which handles soft-failure cleanly.
    ///
    ///         Per-leg `minOutputAmount = 0` (no per-leg slippage guard) —
    ///         the *total* output is checked against the caller's
    ///         `minOutputAmount` at the end, which is the only safe
    ///         per-leg-asymmetry-tolerant check. Keeper-side: only use
    ///         split routes for aggregator adapters (0x / 1inch) whose
    ///         calldata bakes slippage tolerance into the route itself;
    ///         raw V3 / Balancer adapters offer no slippage protection
    ///         when called with `minOutputAmount = 0` and shouldn't be
    ///         split-route legs without a future LibSwap hardening (a
    ///         balance-delta check per leg).
    ///
    ///         Approvals: exact-scope per-leg, zeroed before and after
    ///         each call.
    /// @param loanId          Loan id being liquidated (event indexing).
    /// @param inputToken      Token the caller holds and is splitting.
    /// @param outputToken     Token requested in return.
    /// @param inputAmount     Total exact input — `sum(splits[i].splitAmount)`
    ///                        must equal this or the call reverts.
    /// @param minOutputAmount Oracle-derived slippage floor on the *total*
    ///                        output. Per-leg bounds are 0 (see dev note).
    /// @param recipient       Destination for realized `outputToken` from
    ///                        every leg.
    /// @param splits          The split spec; empty list reverts
    ///                        {EmptySplitList}.
    /// @return totalOutput    Sum of every leg's realized output, ≥
    ///                        `minOutputAmount` on return.
    function swapWithSplit(
        uint256 loanId,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        SplitCall[] calldata splits
    ) internal returns (uint256 totalOutput) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 registeredCount = s.swapAdapters.length;
        if (registeredCount == 0) revert NoSwapAdaptersConfigured();
        uint256 n = splits.length;
        if (n == 0) revert EmptySplitList();

        // Up-front validation pass — sum + bounds — so a misconfigured
        // try-list reverts before any allocation has moved.
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            uint256 idx = splits[i].adapterIdx;
            if (idx >= registeredCount) {
                revert AdapterIndexOutOfRange(idx, registeredCount);
            }
            sum += splits[i].splitAmount;
        }
        if (sum != inputAmount) revert SplitSumMismatch(sum, inputAmount);

        IERC20 input = IERC20(inputToken);
        for (uint256 i; i < n; ++i) {
            uint256 amount = splits[i].splitAmount;
            if (amount == 0) continue; // zero-amount legs no-op cleanly
            uint256 idx = splits[i].adapterIdx;
            address adapter = s.swapAdapters[idx];
            // #633 — split liquidation is atomic + its entry point is
            // permissionless, and each leg carries minOutput=0 (only the
            // *total* is floored), so a governance-disabled venue could
            // otherwise be called here with an unprotected per-leg output.
            // Reject it on-chain; reverting unwinds the earlier legs.
            if (s.swapAdapterDisabled[adapter]) revert SwapVenuePaused();
            input.forceApprove(adapter, 0);
            input.forceApprove(adapter, amount);

            // No try / catch — a leg revert MUST bubble. Solidity unwinds
            // the earlier successful legs in the same transaction, leaving
            // `recipient` (and approvals) clean on the failure path.
            uint256 out_ = ISwapAdapter(adapter).execute(
                inputToken,
                outputToken,
                amount,
                0, // per-leg minOutputAmount — see contract-level dev note
                recipient,
                splits[i].data
            );
            input.forceApprove(adapter, 0);
            emit SwapAdapterAttempted(loanId, idx, adapter, true);
            emit SwapAdapterSucceeded(loanId, idx, adapter, out_);
            totalOutput += out_;
        }

        if (totalOutput < minOutputAmount) {
            revert SplitMinOutputUnderfilled(totalOutput, minOutputAmount);
        }
    }
}
