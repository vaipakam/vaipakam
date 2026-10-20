// src/facets/SwapAttemptFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibSwap} from "../libraries/LibSwap.sol";
import {ISwapAttemptHost} from "../interfaces/ISwapAttemptHost.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title SwapAttemptFacet
 * @author Vaipakam Developer Team
 * @notice Runs one swap-adapter attempt in a call frame of its own, so a
 *         failover can refuse an attempt that sold only part of what it was
 *         offered, or delivered less than it reported, and still try the
 *         next route (#2472).
 * @dev Part of the Diamond Standard (EIP-2535).
 *
 *      WHY A FRAME OF ITS OWN: the delivery rule ({LibSwap}) can only be
 *      checked after the adapter has sold. Checked in the caller's frame, a
 *      breach can only revert the whole transaction — so one stale quote at
 *      the head of a liquidation's try-list would stop every route after it,
 *      and a borrower topping up a dust amount of collateral before each
 *      attempt could make every quote stale and stall the liquidation. In
 *      this frame a breach reverts the attempt alone, the adapter's sale and
 *      approval unwind with it, and {LibSwap.attempt} moves on, exactly as
 *      for a venue that reverted. The lender is paid as fully as the market
 *      allows, and the in-kind fallback (which pays the lender first) is
 *      reached only when no route sells the whole amount (owner decision
 *      2026-10-20).
 *
 *      WHO CALLS IT: only {LibSwap.attempt}, inlined into every facet that
 *      sells through the failover — RiskFacet, DefaultedFacet,
 *      RepayPeriodicFacet, TreasuryFacet, SwapToRepayFacet,
 *      SwapToRepayPartialFacet and FallbackCustodyFacet. Each of them
 *      self-calls this selector, so a Diamond that routes them must route it
 *      too; {LibSwap.SwapAttemptHostMissing} refuses a Diamond that does not,
 *      rather than reading every attempt as a failed route.
 *
 *      TRUST MODEL: the `address(this)` gate is the whole of it. The attempt
 *      sells the Diamond's own balance of `sale.inputToken` through a
 *      registered adapter, so it must never be reachable from outside the
 *      Diamond. The adapter is resolved here from storage by index, not
 *      taken from the caller; whether a venue is enabled stays the calling
 *      loop's check, as it was before the attempt moved into this frame.
 *      There is no reentrancy guard of its own: every caller already holds
 *      the Diamond guard, and an adapter re-entering this selector fails the
 *      gate.
 */
contract SwapAttemptFacet is ISwapAttemptHost, IVaipakamErrors {
    /// @inheritdoc ISwapAttemptHost
    function swapAttempt(
        LibSwap.Sale calldata sale,
        uint256 adapterIdx,
        bytes calldata data
    ) external returns (uint256 outputAmount, uint256 inputSpent) {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
        return LibSwap.runAttempt(sale, adapterIdx, data);
    }
}
