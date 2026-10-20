// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {ISwapAttemptHost} from "../interfaces/ISwapAttemptHost.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {LibDiamond} from "@diamond-3/libraries/LibDiamond.sol";

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
 *  - #2472 — every committed attempt is MEASURED on the Diamond's side:
 *    the input balance must have fallen by what the sale spent, and the
 *    recipient's output balance must have risen by at least what the
 *    adapter reported (`SwapOutputShortDelivered` otherwise). The spend
 *    rule is the CALLER's, declared by which entry it uses:
 *      - {swapWithFailover} and {swapWithSplit} are EXACT: an attempt
 *        must spend the whole input (`SwapInputSpendMismatch`
 *        otherwise). Every forced sale uses them — liquidation, default,
 *        periodic settlement, the fallback retry and treasury conversion
 *        sell an amount the loan or ledger has already written down as
 *        sold, so an unspent remainder would sit on the Diamond's shared
 *        balance in nobody's claim.
 *      - {swapWithFailoverUpTo} accepts a spend up to the input and
 *        returns what was spent. Only a voluntary close-out whose
 *        remainder has a stated owner uses it (swap-to-repay: the debt is
 *        paid in full and the unspent collateral returns to the borrower's
 *        vault under the loan's lien).
 *    A failover attempt runs in a call frame of its own
 *    ({ISwapAttemptHost}, hosted by `SwapAttemptFacet`), so an attempt
 *    that breaks the rule reverts only that frame: the adapter's sale is
 *    unwound with it and the failover tries the next route, exactly as
 *    for a venue that reverted. Owner decision 2026-10-20 (lender
 *    first): a partial forced sale is refused, but it must not stop the
 *    liquidation — a borrower topping up a dust amount of collateral
 *    before each attempt would otherwise make every quoted route sell
 *    short and revert the whole transaction, stalling the lender. When
 *    no route sells the whole amount, the caller's fallback applies,
 *    which pays the lender first. The split entry stays atomic: a leg
 *    that breaks the rule reverts the whole split.
 *    The measurement is sound only because every adapter hands back
 *    exactly the unspent part of the input it pulled in THAT call and
 *    never sweeps any other balance it holds ({ISwapAdapter}); otherwise
 *    a token donated to an adapter would read as unspent input and make
 *    every exact sale through it fail.
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
    /// @notice #1005 (S9) — {swapWithFailover} was handed a try-list with no
    ///         attemptable route (empty, or every entry a governance-disabled
    ///         venue), so no enabled DEX was tried. Reverts instead of returning
    ///         a soft failure that a forced-close caller would treat as
    ///         "every route failed" and route into the full-collateral fallback.
    error NoEnabledSwapRoute(uint256 loanId);
    /// @notice #633 — a governance-paused swap venue was supplied to an atomic
    ///         split route (no-arg to minimise inlined bytecode in RiskFacet).
    error SwapVenuePaused();
    error SplitSumMismatch(uint256 sum, uint256 inputAmount);
    /// @notice #2472 — an adapter attempt spent `spent` of the
    ///         `inputAmount` it was offered, where the entry requires the
    ///         full input ({swapWithFailover}, {swapWithSplit}) or at most
    ///         the input ({swapWithFailoverUpTo}). Reverts the attempt's own
    ///         frame, so a failover moves on to the next route; in a split it
    ///         reverts the whole split.
    error SwapInputSpendMismatch(
        uint256 loanId,
        uint256 adapterIdx,
        uint256 spent,
        uint256 inputAmount
    );
    /// @notice #2472 — the recipient's output balance rose by `received`,
    ///         less than the `reported` amount the adapter returned (a
    ///         fee-on-transfer output token, or an adapter reporting more than
    ///         it delivered). Proceeds are never booked above what arrived.
    ///         Same scope as {SwapInputSpendMismatch}: the attempt fails.
    error SwapOutputShortDelivered(
        uint256 loanId,
        uint256 adapterIdx,
        uint256 received,
        uint256 reported
    );
    error SplitMinOutputUnderfilled(uint256 totalOutput, uint256 minOutputAmount);
    error EmptySplitList();
    /// @notice #2472 — the Diamond routes no host for
    ///         {ISwapAttemptHost.swapAttempt}: a refresh cut a facet that
    ///         sells through the failover without `SwapAttemptFacet`. Every
    ///         attempt would then fail as if each route had, so it is refused
    ///         by name instead of being read as "no route could fill" (which
    ///         would send a liquidation into the in-kind fallback).
    error SwapAttemptHostMissing();

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

    /// @notice The fixed terms of one sale, shared by every attempt at it.
    ///         Built once per sale so a per-attempt frame carries one
    ///         pointer instead of seven words (the failover loop is inlined
    ///         into stack-tight facets).
    /// @param exactInput True when an attempt must spend the whole
    ///                   `inputAmount` (every forced sale); false when it may
    ///                   spend less and the caller places the remainder
    ///                   ({swapWithFailoverUpTo}).
    struct Sale {
        uint256 loanId;
        address inputToken;
        address outputToken;
        uint256 inputAmount;
        uint256 minOutputAmount;
        address recipient;
        bool exactInput;
    }

    /// @notice Drive a caller-ordered failover across the registered
    ///         swap adapters. The `calls` list is the already-ranked
    ///         try-list: the frontend / HF watcher fetches quotes from
    ///         every available venue, sorts by expected output (best
    ///         first), and submits in that order. The library attempts
    ///         each in turn and commits on the first success.
    /// @dev    EXACT input (#2472): an attempt that spends less than the
    ///         whole `inputAmount`, or delivers less than it reports, is a
    ///         failed attempt — unwound in its own frame, and the next route
    ///         is tried. Every forced sale uses this entry; see the library
    ///         header.
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
        (success, outputAmount, adapterUsed, ) = _failover(
            Sale(loanId, inputToken, outputToken, inputAmount, minOutputAmount, recipient, true),
            calls
        );
    }

    /// @notice {swapWithFailover} for a sale that may spend LESS than
    ///         `inputAmount` (#2472). Returns what the committed attempt
    ///         actually spent, so the caller can place the remainder
    ///         (`inputAmount - inputSpent`), which is back on the Diamond.
    /// @dev    Only for a voluntary close-out whose remainder has a stated
    ///         owner: swap-to-repay, where the debt is paid in full and the
    ///         unspent collateral returns to the borrower's vault under the
    ///         loan's lien. A forced sale must use {swapWithFailover}.
    /// @return success      True iff an adapter returned proceeds.
    /// @return outputAmount Realized proceeds on success, 0 otherwise.
    /// @return adapterUsed  Storage index of the committing adapter, or
    ///                      `type(uint256).max` on total failure.
    /// @return inputSpent   Input the committing attempt spent (measured on
    ///                      the Diamond), `<= inputAmount`; 0 on failure.
    function swapWithFailoverUpTo(
        uint256 loanId,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        AdapterCall[] calldata calls
    )
        internal
        returns (bool success, uint256 outputAmount, uint256 adapterUsed, uint256 inputSpent)
    {
        return _failover(
            Sale(loanId, inputToken, outputToken, inputAmount, minOutputAmount, recipient, false),
            calls
        );
    }

    /// @dev The failover loop both entries share. `sale.exactInput` carries
    ///      the entry's spend rule into {attempt}.
    function _failover(Sale memory sale, AdapterCall[] calldata calls)
        private
        returns (bool, uint256, uint256, uint256)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 registeredCount = s.swapAdapters.length;
        if (registeredCount == 0) revert NoSwapAdaptersConfigured();

        uint256 n = calls.length;
        // #1005 (S9, Codex #1087 r1 P1): count adapters we actually ATTEMPT
        // (in-range + not governance-disabled). If the try-list is empty OR
        // every entry is a disabled venue we'd skip, NO enabled route is tried
        // — reverting here (rather than the old `(false, 0)` return) stops a
        // permissionless forced-close caller from pushing an eligible loan into
        // the full-collateral fallback with zero DEX attempts on a healthy
        // venue. A length-only guard at the caller could not see the
        // all-disabled case; centralizing it here fixes every failover caller.
        uint256 attempted;

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
            ++attempted;

            (bool ok, uint256 out_, uint256 spent) = attempt(sale, idx, adapter, calls[i].data);
            if (ok) return (true, out_, idx, spent);
            // fall through to next entry in the try-list
        }

        // Reached only after iterating the whole try-list without a success.
        if (attempted == 0) revert NoEnabledSwapRoute(sale.loanId);
        emit SwapAllAdaptersFailed(sale.loanId);
        return (false, 0, type(uint256).max, 0);
    }

    /// @notice One failover attempt at `sale` (#2472). Shared by
    ///         {swapWithFailover}, {swapWithFailoverUpTo} and
    ///         FallbackCustodyFacet's soft-fail retry loop, so every failover
    ///         in the protocol commits on the same rule.
    /// @dev    The attempt runs in its own call frame — a self-call through
    ///         the Diamond's fallback to {ISwapAttemptHost.swapAttempt} — so
    ///         ANY failure inside it (the venue reverting, a partial fill on
    ///         an exact sale, proceeds that did not arrive) reverts that frame
    ///         alone: the adapter's sale and its approval are unwound, and the
    ///         caller moves on to the next route. Only a missing host escapes
    ///         as a revert ({SwapAttemptHostMissing}), because it is a deploy
    ///         defect rather than a route outcome.
    /// @param sale       The sale's fixed terms.
    /// @param adapterIdx Storage index of `adapter` (events + errors).
    /// @param adapter    The resolved, enabled adapter at `adapterIdx`, for the
    ///                   events (the host resolves it again from storage).
    /// @param data       The caller's per-route payload for it.
    /// @return ok           True iff the attempt committed.
    /// @return outputAmount Proceeds the adapter reported, delivery-checked.
    /// @return inputSpent   Input the attempt spent, measured on the Diamond.
    function attempt(
        Sale memory sale,
        uint256 adapterIdx,
        address adapter,
        bytes memory data
    ) internal returns (bool ok, uint256 outputAmount, uint256 inputSpent) {
        try ISwapAttemptHost(address(this)).swapAttempt(sale, adapterIdx, data) returns (
            uint256 out_,
            uint256 spent
        ) {
            emit SwapAdapterAttempted(sale.loanId, adapterIdx, adapter, true);
            emit SwapAdapterSucceeded(sale.loanId, adapterIdx, adapter, out_);
            return (true, out_, spent);
        } catch {
            if (
                LibDiamond.diamondStorage()
                    .selectorToFacetAndPosition[ISwapAttemptHost.swapAttempt.selector]
                    .facetAddress == address(0)
            ) revert SwapAttemptHostMissing();
            emit SwapAdapterAttempted(sale.loanId, adapterIdx, adapter, false);
            return (false, 0, 0);
        }
    }

    /// @notice The body of one attempt, for {ISwapAttemptHost.swapAttempt}:
    ///         resolves the adapter at `adapterIdx`, runs it, and holds it to
    ///         the delivery rule, REVERTING on any breach so the host's frame
    ///         unwinds the sale (#2472).
    function runAttempt(Sale memory sale, uint256 adapterIdx, bytes memory data)
        internal
        returns (uint256 outputAmount, uint256 inputSpent)
    {
        address adapter = LibVaipakam.storageSlot().swapAdapters[adapterIdx];
        return _run(sale, adapterIdx, adapter, data);
    }

    /// @dev Run `adapter` on `sale` and apply the delivery rule. Approval is
    ///      exact-scope: zeroed first (USDT-style non-zero approve guards),
    ///      set to `sale.inputAmount`, and zeroed after. No try / catch — the
    ///      caller's frame decides what a revert means: the attempt host's
    ///      frame (a failed route) or the split's (the whole split fails).
    ///      Measures the Diamond's input balance and the recipient's output
    ///      balance against snapshots taken before the call:
    ///      - output: the recipient must have received at least the reported
    ///        amount, else `SwapOutputShortDelivered`;
    ///      - input: an exact sale must have spent exactly `inputAmount`, an
    ///        up-to sale at most `inputAmount`, else `SwapInputSpendMismatch`.
    ///      Both deltas saturate at zero, so a balance that moved the "wrong"
    ///      way reads as nothing spent / nothing received and fails the check
    ///      rather than underflowing.
    function _run(Sale memory sale, uint256 adapterIdx, address adapter, bytes memory data)
        private
        returns (uint256 outputAmount, uint256 inputSpent)
    {
        IERC20 input = IERC20(sale.inputToken);
        IERC20 output = IERC20(sale.outputToken);
        uint256 inBefore = input.balanceOf(address(this));
        uint256 outBefore = output.balanceOf(sale.recipient);
        input.forceApprove(adapter, 0);
        input.forceApprove(adapter, sale.inputAmount);
        outputAmount = ISwapAdapter(adapter).execute(
            sale.inputToken,
            sale.outputToken,
            sale.inputAmount,
            sale.minOutputAmount,
            sale.recipient,
            data
        );
        input.forceApprove(adapter, 0);

        uint256 outAfter = output.balanceOf(sale.recipient);
        uint256 received = outAfter > outBefore ? outAfter - outBefore : 0;
        if (received < outputAmount) {
            revert SwapOutputShortDelivered(sale.loanId, adapterIdx, received, outputAmount);
        }
        uint256 inAfter = input.balanceOf(address(this));
        inputSpent = inBefore > inAfter ? inBefore - inAfter : 0;
        if (sale.exactInput ? inputSpent != sale.inputAmount : inputSpent > sale.inputAmount) {
            revert SwapInputSpendMismatch(sale.loanId, adapterIdx, inputSpent, sale.inputAmount);
        }
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
    ///         each call. Each leg must spend exactly its `splitAmount` and
    ///         deliver what it reported (#2472, {SwapInputSpendMismatch} /
    ///         {SwapOutputShortDelivered}).
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

        // #2472 — every leg is held to the exact-input delivery rule on its
        // own `splitAmount` (the same rule a failover attempt runs under): a
        // leg that spent less would leave the remainder on the Diamond after
        // the loan has been written down as fully sold. Unlike a failover
        // attempt, a leg runs in THIS frame, so a breach reverts and unwinds
        // every leg — split settlement is all-or-nothing. The leg body is its
        // own frame ({_splitLeg}): this function is inlined into a
        // stack-tight facet, so the leg terms travel as one memory pointer
        // whose `inputAmount` each leg sets to its own `splitAmount`, and
        // whose per-leg floor stays 0 (only the total is floored, below).
        Sale memory leg = Sale(loanId, inputToken, outputToken, 0, 0, recipient, true);
        for (uint256 i; i < n; ++i) {
            totalOutput += _splitLeg(s, leg, splits[i]);
        }

        if (totalOutput < minOutputAmount) {
            revert SplitMinOutputUnderfilled(totalOutput, minOutputAmount);
        }
    }

    /// @dev One leg of {swapWithSplit}. A leg revert MUST bubble, and
    ///      Solidity unwinds the earlier successful legs in the same
    ///      transaction, leaving `recipient` (and approvals) clean on the
    ///      failure path. Per-leg `minOutputAmount` is 0 (see the
    ///      {swapWithSplit} dev note); the leg is held to the exact-input
    ///      delivery rule on its own `splitAmount` (#2472).
    /// @return out_ The leg's reported (and delivery-checked) output; 0 for
    ///              a zero-amount leg, which no-ops cleanly.
    function _splitLeg(
        LibVaipakam.Storage storage s,
        Sale memory leg,
        SplitCall calldata call_
    ) private returns (uint256 out_) {
        uint256 amount = call_.splitAmount;
        if (amount == 0) return 0;
        uint256 idx = call_.adapterIdx;
        address adapter = s.swapAdapters[idx];
        // #633 — split liquidation is atomic + its entry point is
        // permissionless, and each leg carries minOutput=0 (only the
        // *total* is floored), so a governance-disabled venue could
        // otherwise be called here with an unprotected per-leg output.
        // Reject it on-chain; reverting unwinds the earlier legs.
        if (s.swapAdapterDisabled[adapter]) revert SwapVenuePaused();
        leg.inputAmount = amount;
        (out_, ) = _run(leg, idx, adapter, call_.data);
        emit SwapAdapterAttempted(leg.loanId, idx, adapter, true);
        emit SwapAdapterSucceeded(leg.loanId, idx, adapter, out_);
    }
}
