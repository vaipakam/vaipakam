// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibTreasuryBuyback — T-087 Sub 3.B
 *
 * Internal helpers for the buyback arm of the IntentDispatchFacet.
 * The Fusion `commit → fill → settle` lifecycle is broken into three
 * library entry points the surrounding facets call:
 *
 *   commitBuyback   — admin-only; reserves `amountIn` of `token` out
 *                     of `s.baseBuybackBudget` into
 *                     `s.baseBuybackReserved` and records the buyback
 *                     order ledger. Called from
 *                     `TreasuryFacet.commitBuybackIntent`.
 *   onFill          — called from `IntentDispatchFacet.postInteraction`
 *                     when the dispatch hits a BUYBACK kind. Releases
 *                     the reservation, credits the delivered VPFI to
 *                     `s.stakingPoolBuybackBudget`, marks the order
 *                     Filled, and clears the order-kind discriminator.
 *   expireBuyback   — permissionless; anyone can poke after a buyback
 *                     order's `expiresAt`. Rolls the reservation back
 *                     to `s.baseBuybackBudget`, marks the order
 *                     Expired, and clears the order-kind
 *                     discriminator. The matching Fusion order
 *                     becomes a noop on subsequent fills because
 *                     `s.orderHashKind[orderHash] == 0` causes the
 *                     dispatch facet to revert
 *                     `UnknownOrderKind`.
 *
 * Per the Sub 3.B card the actual 1inch Fusion intent submission +
 * TWAP order shape live in Sub 3.C — this library only knows about
 * the on-chain ledger.
 */
library LibTreasuryBuyback {
    // ─── Errors ──────────────────────────────────────────────────────

    /// @notice `commitBuyback` was called with a zero `amountIn`.
    error BuybackZeroAmount();
    /// @notice `commitBuyback` was called with a zero `token`.
    error BuybackZeroToken();
    /// @notice `commitBuyback` was called with `amountIn` that
    ///         doesn't fit in `uint96`. This caps a single buyback
    ///         at ~7.9e28 raw token units (more than any reasonable
    ///         protocol will accumulate); the cap exists so the
    ///         packed storage slot stays in a single word.
    error BuybackAmountOverflow(uint256 amountIn);
    /// @notice `commitBuyback` was called with `expiresAt` that
    ///         doesn't fit in `uint64`. Hard cap on the deadline.
    error BuybackExpiryOverflow(uint256 expiresAt);
    /// @notice `commitBuyback` was called with `expiresAt` in the
    ///         past. Operator typo; refuse before debiting the
    ///         budget.
    error BuybackExpiryInPast(uint64 expiresAt, uint256 nowSec);
    /// @notice `commitBuyback` was called twice with the same
    ///         orderHash. The first commit already stamped the
    ///         discriminator; a second commit would let the operator
    ///         double-reserve.
    error BuybackOrderHashInUse(bytes32 orderHash);
    /// @notice The Base-side consolidated budget cannot cover the
    ///         requested commit amount.
    error BuybackBudgetInsufficient(
        address token, uint256 requested, uint256 available
    );
    /// @notice `onFill` or `expireBuyback` referenced an unknown
    ///         orderHash (never committed, OR already terminal).
    error BuybackOrderNotPending(bytes32 orderHash, uint8 status);
    /// @notice `expireBuyback` was called before the order's
    ///         deadline; only the operator can fast-cancel before
    ///         expiry, and that path is intentionally absent in Sub
    ///         3.B (a stuck order's recovery is the operator's job
    ///         until the deadline; everyone else waits).
    error BuybackNotYetExpired(uint64 expiresAt, uint256 nowSec);

    // ─── Events ──────────────────────────────────────────────────────

    /// @custom:event-category state-change/buyback-intent
    event BuybackIntentCommitted(
        bytes32 indexed orderHash,
        address indexed token,
        uint96 amountIn,
        uint64 expiresAt
    );
    /// @custom:event-category state-change/buyback-intent
    event BuybackIntentFilled(
        bytes32 indexed orderHash,
        address indexed token,
        uint96 amountIn,
        uint256 deliveredVPFI
    );
    /// @custom:event-category state-change/buyback-intent
    event BuybackIntentExpired(
        bytes32 indexed orderHash,
        address indexed token,
        uint96 amountIn
    );

    // ─── Lifecycle ───────────────────────────────────────────────────

    /**
     * @dev Reserve `amountIn` of `token` for a future Fusion fill on
     *      `orderHash`. Debits `baseBuybackBudget`, credits
     *      `baseBuybackReserved`, records the buyback ledger entry,
     *      stamps `orderHashKind[orderHash] = ORDER_KIND_BUYBACK`,
     *      and emits `BuybackIntentCommitted`.
     *
     *      Auth is the FACET'S responsibility (admin-gated in
     *      `TreasuryFacet.commitBuybackIntent`); this helper just
     *      enforces shape + accounting invariants.
     */
    function commitBuyback(
        bytes32 orderHash,
        address token,
        uint256 amountIn,
        uint256 expiresAt
    ) internal {
        if (token == address(0)) revert BuybackZeroToken();
        if (amountIn == 0) revert BuybackZeroAmount();
        if (amountIn > type(uint96).max) revert BuybackAmountOverflow(amountIn);
        if (expiresAt > type(uint64).max) revert BuybackExpiryOverflow(expiresAt);
        if (expiresAt <= block.timestamp) {
            revert BuybackExpiryInPast(uint64(expiresAt), block.timestamp);
        }

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Reject re-use of the same orderHash — covers both BUYBACK
        // and SWAP_TO_REPAY kinds. Stamping a non-zero discriminator
        // is the existence proof.
        if (s.orderHashKind[orderHash] != bytes32(0)) {
            revert BuybackOrderHashInUse(orderHash);
        }

        uint256 budget = s.baseBuybackBudget[token];
        if (amountIn > budget) {
            revert BuybackBudgetInsufficient(token, amountIn, budget);
        }

        // CEI — accounting moves before the discriminator stamp.
        s.baseBuybackBudget[token] = budget - amountIn;
        s.baseBuybackReserved[token] += amountIn;

        s.buybackOrders[orderHash] = LibVaipakam.BuybackOrderInfo({
            token: token,
            amountIn: uint96(amountIn),
            expiresAt: uint64(expiresAt),
            status: LibVaipakam.BUYBACK_ORDER_STATUS_PENDING
        });
        s.orderHashKind[orderHash] = LibVaipakam.ORDER_KIND_BUYBACK;

        emit BuybackIntentCommitted(
            orderHash, token, uint96(amountIn), uint64(expiresAt)
        );
    }

    /**
     * @dev Settle a Fusion-filled buyback: release the source-token
     *      reservation and credit the delivered VPFI to the staking
     *      pool budget. Called from
     *      `IntentDispatchFacet.postInteraction` when the dispatch
     *      hits a BUYBACK-kind order.
     *
     *      `deliveredVPFI` is what the Fusion fill actually delivered
     *      into the Diamond (the dispatch facet measures it via a
     *      balance-delta against a `preInteraction`-snapshot, the
     *      same way `SwapToRepayIntentFacet` does — this library
     *      trusts the caller to pass a measured value).
     */
    function onFill(bytes32 orderHash, uint256 deliveredVPFI) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        LibVaipakam.BuybackOrderInfo memory info = s.buybackOrders[orderHash];
        if (info.status != LibVaipakam.BUYBACK_ORDER_STATUS_PENDING) {
            revert BuybackOrderNotPending(orderHash, info.status);
        }

        // Release the reservation; the source token has already been
        // pulled by the Fusion fill (the makingAmount).
        s.baseBuybackReserved[info.token] -= info.amountIn;

        // Credit the delivered VPFI to the staking-pool buyback
        // budget — widens the `VPFI_STAKING_POOL_CAP` claim gate so
        // stakers can pull this slice as their yield (Sub 3 add-on
        // #472 will later split between rewards-budget + keeper-
        // budget + staking-pool — for Sub 3.B all delivered VPFI
        // goes to the staking pool).
        s.stakingPoolBuybackBudget += deliveredVPFI;

        // Mark the order Filled + clear the kind discriminator so
        // the IntentDispatchFacet rejects any later replay.
        s.buybackOrders[orderHash].status =
            LibVaipakam.BUYBACK_ORDER_STATUS_FILLED;
        delete s.orderHashKind[orderHash];

        emit BuybackIntentFilled(
            orderHash, info.token, info.amountIn, deliveredVPFI
        );
    }

    /**
     * @dev Permissionless rollback after a buyback order's deadline.
     *      Releases the reservation back to `baseBuybackBudget`,
     *      marks the order Expired, and clears the kind
     *      discriminator. Useful for unwinding orders the Fusion
     *      solver never filled (offer not competitive, network
     *      congestion past expiry, etc.).
     */
    function expireBuyback(bytes32 orderHash) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        LibVaipakam.BuybackOrderInfo memory info = s.buybackOrders[orderHash];
        if (info.status != LibVaipakam.BUYBACK_ORDER_STATUS_PENDING) {
            revert BuybackOrderNotPending(orderHash, info.status);
        }
        if (block.timestamp < info.expiresAt) {
            revert BuybackNotYetExpired(info.expiresAt, block.timestamp);
        }

        // Roll the reservation back to the spendable budget.
        s.baseBuybackReserved[info.token] -= info.amountIn;
        s.baseBuybackBudget[info.token] += info.amountIn;

        s.buybackOrders[orderHash].status =
            LibVaipakam.BUYBACK_ORDER_STATUS_EXPIRED;
        delete s.orderHashKind[orderHash];

        emit BuybackIntentExpired(orderHash, info.token, info.amountIn);
    }
}
